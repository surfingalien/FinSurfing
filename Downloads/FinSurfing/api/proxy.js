/* ═══════════════════════════════════════════════
   FinSurf — Vercel Serverless Yahoo Finance Proxy
   Runs server-side: no CORS issues, no rate limits
═══════════════════════════════════════════════ */

export default async function handler(req, res) {
  // CORS headers — allow our frontend to call this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing ?url= parameter' });
  }

  const decoded = decodeURIComponent(url);

  // Security: only proxy Yahoo Finance
  if (!decoded.includes('yahoo.com')) {
    return res.status(403).json({ error: 'Only Yahoo Finance URLs are allowed' });
  }

  try {
    const response = await fetch(decoded, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://finance.yahoo.com/',
        'Origin': 'https://finance.yahoo.com',
      },
      redirect: 'follow',
    });

    const text = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Yahoo Finance returned ${response.status}`,
        body: text.slice(0, 200)
      });
    }

    // Cache responses briefly server-side
    res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(text);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
