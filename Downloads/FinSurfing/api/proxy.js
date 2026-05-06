/* ═══════════════════════════════════════════════
   FinSurf — Vercel Serverless Yahoo Finance Proxy
   Handles crumb/cookie auth required for server-side YF requests
═══════════════════════════════════════════════ */

// Module-level session cache — persists across warm function invocations
let session = { crumb: null, cookie: null, expires: 0 };

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function parseCookies(headers) {
  const raw = headers.get('set-cookie') || '';
  // Join multiple Set-Cookie headers if present
  return raw.split(/,(?=[^ ].*?=)/).map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
}

async function refreshSession() {
  let cookies = '';

  // Step 1: Hit fc.yahoo.com to obtain initial session/consent cookies
  try {
    const r = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': UA, 'Accept': '*/*' },
      redirect: 'follow',
    });
    const c = parseCookies(r.headers);
    if (c) cookies = c;
  } catch (_) { /* non-critical */ }

  // Step 2: Get crumb from Yahoo Finance
  const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://finance.yahoo.com/',
      ...(cookies ? { 'Cookie': cookies } : {}),
    },
    redirect: 'follow',
  });

  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.includes('<')) throw new Error('Failed to get YF crumb');

  // Merge cookies from crumb response
  const crumbCookies = parseCookies(crumbRes.headers);
  if (crumbCookies) cookies = [cookies, crumbCookies].filter(Boolean).join('; ');

  session = { crumb, cookie: cookies, expires: Date.now() + 25 * 60 * 1000 }; // 25 min TTL
  return session;
}

async function getSession() {
  if (session.crumb && Date.now() < session.expires) return session;
  return refreshSession();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing ?url= parameter' });

  const decoded = decodeURIComponent(url);
  if (!decoded.includes('yahoo.com')) {
    return res.status(403).json({ error: 'Only Yahoo Finance URLs are allowed' });
  }

  try {
    const { crumb, cookie } = await getSession();

    // Append crumb to the URL
    const sep = decoded.includes('?') ? '&' : '?';
    const targetUrl = `${decoded}${sep}crumb=${encodeURIComponent(crumb)}`;

    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://finance.yahoo.com/',
        'Origin': 'https://finance.yahoo.com',
        ...(cookie ? { 'Cookie': cookie } : {}),
      },
      redirect: 'follow',
    });

    // If 401, session expired — force refresh and retry once
    if (response.status === 401 || response.status === 403) {
      session.expires = 0; // invalidate
      const { crumb: c2, cookie: ck2 } = await refreshSession();
      const sep2 = decoded.includes('?') ? '&' : '?';
      const retryUrl = `${decoded}${sep2}crumb=${encodeURIComponent(c2)}`;
      const retry = await fetch(retryUrl, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://finance.yahoo.com/',
          'Origin': 'https://finance.yahoo.com',
          ...(ck2 ? { 'Cookie': ck2 } : {}),
        },
        redirect: 'follow',
      });
      const text2 = await retry.text();
      res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
      res.setHeader('Content-Type', 'application/json');
      return res.status(retry.ok ? 200 : retry.status).send(text2);
    }

    const text = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Yahoo Finance returned ${response.status}`,
        body: text.slice(0, 200)
      });
    }

    res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(text);

  } catch (err) {
    console.error('Proxy error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
