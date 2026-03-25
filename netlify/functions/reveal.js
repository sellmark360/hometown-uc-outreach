const https = require('https');

function post(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Invalid JSON response')); }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const { apolloId } = JSON.parse(event.body || '{}');
  if (!apolloId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'apolloId required' }) };
  }

  if (!process.env.APOLLO_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'APOLLO_API_KEY not set' }) };
  }

  try {
    const data = await post(
      'api.apollo.io',
      '/api/v1/people/match',
      {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'x-api-key': process.env.APOLLO_API_KEY,
      },
      {
        id: apolloId,
        reveal_personal_emails: false,
        reveal_phone_number: true,
      }
    );

    const person = data?.person;
    if (!person) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Person not found' }) };
    }

    const phone = person.phone_numbers?.find(p => p.sanitized_number)?.sanitized_number
      || person.phone_numbers?.[0]?.raw_number
      || null;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        name: person.name || `${person.first_name || ''} ${person.last_name || ''}`.trim(),
        email: (person.email && person.email.includes('@') && !person.email.includes('*')) ? person.email : null,
        phone,
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
