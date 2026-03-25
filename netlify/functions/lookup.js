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

  const { company } = JSON.parse(event.body || '{}');
  if (!company) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'company required' }) };
  }

  // Run Claude and Tavily in parallel
  const claudePromise = post(
    'api.anthropic.com',
    '/v1/messages',
    {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `You are a B2B sales research assistant. Summarize what you know about the company "${company}" in 4–5 concise bullet points that would help a sales rep selling occupational health services (drug testing, DOT physicals, workers comp care, return-to-work programs).

Cover: industry, company size or growth signals, workforce type, known safety or compliance history, and why they likely need occupational health services.

Format each bullet starting with a bold label, e.g. **Industry:** ...

Rules:
- Write only the facts. No disclaimers, no caveats, no suggestions to verify elsewhere.
- Do not include phrases like "based on available information", "I recommend confirming", "as of my knowledge cutoff", or anything similar.
- If you have limited info on this specific company, state what you do know and apply relevant industry context — do not hedge.`
      }]
    }
  );

  const tavilyPromise = process.env.TAVILY_API_KEY
    ? post(
        'api.tavily.com',
        '/search',
        { 'Content-Type': 'application/json' },
        {
          api_key: process.env.TAVILY_API_KEY,
          query: `${company} news hiring expansion safety operations 2024 2025`,
          search_depth: 'basic',
          max_results: 4,
        }
      ).catch(() => null)
    : Promise.resolve(null);

  const apolloPromise = process.env.APOLLO_API_KEY
    ? post(
        'api.apollo.io',
        '/v1/mixed_people/search',
        {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'X-Api-Key': process.env.APOLLO_API_KEY,
        },
        {
          q_organization_name: company,
          page: 1,
          per_page: 5,
        }
      ).catch(() => null)
    : Promise.resolve(null);

  const [claudeData, tavilyData, apolloData] = await Promise.all([claudePromise, tavilyPromise, apolloPromise]);
  console.log('Apollo raw response:', JSON.stringify(apolloData, null, 2));

  const claudeSummary = claudeData?.content?.[0]?.text?.trim() || 'No background information available.';

  const sources = tavilyData?.results
    ?.filter(r => r.title && r.url)
    ?.map(r => ({ title: r.title, url: r.url })) || [];

  const contacts = (apolloData?.people || [])
    .filter(p => p.name)
    .map(p => ({
      name: p.name,
      title: p.title || '',
      email: (p.email && p.email.includes('@') && !p.email.includes('*')) ? p.email : null,
    }));

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ summary: claudeSummary, sources, contacts }),
  };
};
