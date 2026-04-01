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

  const { company, role } = JSON.parse(event.body || '{}');
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

  const ROLE_TITLES = {
    'Benefits Mgr/Dir.':    ['benefits manager', 'benefits director', 'benefits administrator'],
    'CEO':                  ['chief executive officer', 'ceo', 'president and ceo'],
    'COO':                  ['chief operating officer', 'coo'],
    'Gatekeeper':           ['office manager', 'administrative assistant', 'executive assistant', 'receptionist'],
    'HR Manager':           ['hr manager', 'human resources manager', 'people manager'],
    'Office Manager':       ['office manager', 'administrative manager', 'office administrator'],
    'Operations Mgr.':      ['operations manager', 'operations director', 'director of operations'],
    'Risk Manager':         ['risk manager', 'risk director', 'director of risk'],
    'Safety Director':      ['safety director', 'director of safety', 'ehs director'],
    'Safety Manager':       ['safety manager', 'ehs manager', 'health and safety manager'],
    'Sr. HR Director':      ['hr director', 'human resources director', 'vp of human resources', 'chief people officer'],
    'Transport Supervisor':  ['transportation supervisor', 'fleet manager', 'transport manager', 'logistics supervisor'],
  };

  const apolloKey = process.env.APOLLO_API_KEY;
  const roleTitles = (role && ROLE_TITLES[role]) || null;
  const apolloHeaders = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    'x-api-key': apolloKey,
  };

  const apolloGeneralPromise = apolloKey
    ? post('api.apollo.io', '/api/v1/mixed_people/api_search', apolloHeaders,
        { organization_name: company, page: 1, per_page: 5 }
      ).catch(err => { console.log('Apollo general error:', err.message); return null; })
    : Promise.resolve(null);

  const apolloRolePromise = (apolloKey && roleTitles)
    ? post('api.apollo.io', '/api/v1/mixed_people/api_search', apolloHeaders,
        { organization_name: company, person_titles: roleTitles, page: 1, per_page: 3 }
      ).catch(err => { console.log('Apollo role error:', err.message); return null; })
    : Promise.resolve(null);

  const [claudeData, tavilyData, apolloGeneral, apolloRole] = await Promise.all([
    claudePromise, tavilyPromise, apolloGeneralPromise, apolloRolePromise
  ]);

  function mapPerson(p) {
    return { id: p.id, name: `${p.first_name} ${p.last_name_obfuscated || ''}`.trim(), firstName: p.first_name, title: p.title || '', email: null };
  }

  // Filter out contacts whose Apollo org doesn't match the searched company.
  // Apollo fuzzy search often returns people from unrelated companies when
  // it can't find a confident match (e.g. "Bill Gates" for "Akron Schools").
  function orgMatches(person, searchedCompany) {
    const orgName = person.organization?.name || person.employer_name || '';
    if (!orgName) return false;
    const normalize = s => s.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\b(inc|llc|corp|ltd|co|the|and|of|school|schools|district|city|county)\b/g, '')
      .replace(/\s+/g, ' ').trim();
    const a = normalize(orgName);
    const b = normalize(searchedCompany);
    if (!a || !b) return false;
    if (a.includes(b) || b.includes(a)) return true;
    const aWords = new Set(a.split(' ').filter(w => w.length > 2));
    return b.split(' ').filter(w => w.length > 2).some(w => aWords.has(w));
  }

  const roleMatchedIds = new Set((apolloRole?.people || []).map(p => p.id));
  const contacts      = roleTitles
    ? (apolloRole?.people  || []).filter(p => p.first_name && orgMatches(p, company)).map(mapPerson)
    : (apolloGeneral?.people || []).filter(p => p.first_name && orgMatches(p, company)).map(mapPerson);
  const otherContacts = roleTitles
    ? (apolloGeneral?.people || []).filter(p => p.first_name && !roleMatchedIds.has(p.id) && orgMatches(p, company)).map(mapPerson)
    : [];

  const claudeSummary = claudeData?.content?.[0]?.text?.trim() || 'No background information available.';

  const sources = tavilyData?.results
    ?.filter(r => r.title && r.url)
    ?.map(r => ({ title: r.title, url: r.url })) || [];

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ summary: claudeSummary, sources, contacts, otherContacts }),
  };
};
