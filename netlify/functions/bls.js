const https = require('https');

// BLS SOII (Survey of Occupational Injuries and Illnesses) series IDs
// Total Recordable Incident Rate (TRIR) per 100 FTE — private sector
// Series ID format: ISU + 00 (private) + NAICS 2-digit + zeros + 03 (TRIR)
// Verify or find additional IDs at: data.bls.gov/PDQWeb/IS
const INDUSTRY_SERIES = {
  'Agriculture':               { trir: 'ISU00110000000000000003', label: 'Agriculture, Forestry & Fishing' },
  'Construction':              { trir: 'ISU00230000000000000003', label: 'Construction' },
  'Manufacturing':             { trir: 'ISU00310000000000000003', label: 'Manufacturing' },
  'Energy & Utilities':        { trir: 'ISU00220000000000000003', label: 'Utilities' },
  'Transportation & Logistics':{ trir: 'ISU00480000000000000003', label: 'Transportation & Warehousing' },
  'Healthcare':                { trir: 'ISU00620000000000000003', label: 'Health Care & Social Assistance' },
  'Education':                 { trir: 'ISU00610000000000000003', label: 'Educational Services' },
  'Service & Retail':          { trir: 'ISU00440000000000000003', label: 'Retail Trade' },
  'Professional Services':     { trir: 'ISU00540000000000000003', label: 'Professional & Business Services' },
  'High-Risk Industries':      { trir: 'ISU00230000000000000003', label: 'Construction (High-Risk proxy)' },
  'Emergency Services':        { trir: 'ISU00620000000000000003', label: 'Health Care & Emergency Services' },
  'Technology':                { trir: 'ISU00510000000000000003', label: 'Information Technology' },
  'Government & Public Sector':{ trir: 'ISU00920000000000000003', label: 'Government' },
};

// All-private-industry baseline for comparison
const BASELINE_SERIES = 'ISU00000000000000000003';

function blsFetch(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'api.bls.gov',
      path: '/publicAPI/v2/timeseries/data/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('BLS parse error: ' + data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const apiKey = process.env.BLS_API_KEY;
  if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: 'BLS_API_KEY not set' }) };

  const { industry } = JSON.parse(event.body || '{}');
  const match = INDUSTRY_SERIES[industry];

  const seriesIds = match
    ? [match.trir, BASELINE_SERIES]
    : [BASELINE_SERIES];

  const currentYear = new Date().getFullYear();

  try {
    const result = await blsFetch({
      seriesid: seriesIds,
      startyear: String(currentYear - 3),
      endyear: String(currentYear - 1),
      registrationkey: apiKey
    });

    if (result.status !== 'REQUEST_SUCCEEDED') {
      return { statusCode: 200, body: JSON.stringify({ benchmarks: null }) };
    }

    // Extract most recent annual value for each series
    const byId = {};
    for (const s of (result.Results?.series || [])) {
      const annual = s.data?.find(d => d.period === 'M13') || s.data?.[0];
      if (annual) byId[s.seriesID] = { value: parseFloat(annual.value), year: annual.year };
    }

    const industryTrir = match ? byId[match.trir] : null;
    const baseline = byId[BASELINE_SERIES];

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        benchmarks: {
          industry: match ? match.label : 'All Private Industry',
          trir: industryTrir || null,
          baseline: baseline || null,
        }
      })
    };

  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ benchmarks: null, error: err.message }) };
  }
};
