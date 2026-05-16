/* ═══════════════════════════════════════════════
   FinSurf — Vercel Edge Function Data Proxy
   Runs on Cloudflare edge (different IPs from Lambda)
   Quotes: Stooq + YF chart for ^indices
   Charts: Yahoo Finance v8 (no crumb, works on CF)
   Fundamentals: YF quoteSummary with crumb
═══════════════════════════════════════════════ */

export const config = { runtime: 'edge' };

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com/',
  'Origin': 'https://finance.yahoo.com',
};

/* ── CORS response helpers ─────────────────────── */
function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
    },
  });
}
function passthrough(text, status) {
  return new Response(text, {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, s-maxage=60' },
  });
}

/* ── Stooq symbol mapping ─────────────────────── */
const STOOQ_MAP = {
  'SPY':'SPY.US','QQQ':'QQQ.US','DIA':'DIA.US','IWM':'IWM.US','GLD':'GLD.US','SLV':'SLV.US',
  'XLK':'XLK.US','XLF':'XLF.US','XLV':'XLV.US','XLE':'XLE.US','XLY':'XLY.US',
  'XLP':'XLP.US','XLI':'XLI.US','XLU':'XLU.US','XLRE':'XLRE.US','XLB':'XLB.US','XLC':'XLC.US',
};
function toStooq(sym) {
  if (STOOQ_MAP[sym]) return STOOQ_MAP[sym];
  if (sym.startsWith('^')) return null; // Stooq doesn't serve YF-style ^ indices well
  return sym.toUpperCase() + '.US';
}

function parseCSV(text) {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const h = lines[0].split(',').map(x => x.trim());
  return lines.slice(1).map(l => {
    const c = l.split(','), row = {};
    h.forEach((k, i) => { row[k] = (c[i] || '').trim(); });
    return row;
  });
}

/* ── Get YF crumb (works from Cloudflare IPs) ──── */
let _crumb = null, _cookie = '', _crumbTs = 0;
async function getYFAuth() {
  if (_crumb && Date.now() - _crumbTs < 40 * 60 * 1000) return { crumb: _crumb, cookie: _cookie };
  try {
    const fc = await fetch('https://fc.yahoo.com', { headers: YF_HEADERS, signal: AbortSignal.timeout(5000) });
    const rawCookies = (fc.headers.get('set-cookie') || '').split(',').map(c => c.split(';')[0].trim()).join('; ');
    if (rawCookies) _cookie = rawCookies;
  } catch (_) { /* best-effort */ }

  const cr = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { ...YF_HEADERS, 'Cookie': _cookie },
    signal: AbortSignal.timeout(5000),
  });
  if (!cr.ok) throw new Error('Crumb ' + cr.status);
  _crumb  = (await cr.text()).trim();
  _crumbTs = Date.now();
  return { crumb: _crumb, cookie: _cookie };
}

/* ── Fetch quote from YF chart endpoint ────────── */
async function yfChartQuote(sym) {
  const r = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`,
    { headers: YF_HEADERS, signal: AbortSignal.timeout(8000) }
  );
  if (!r.ok) throw new Error('YF chart ' + r.status);
  const d = await r.json();
  const result = d?.chart?.result?.[0];
  if (!result) throw new Error('No data');
  const meta   = result.meta || {};
  const closes = result.indicators?.quote?.[0]?.close || [];
  const prevC  = meta.chartPreviousClose || meta.previousClose || 0;
  const price  = meta.regularMarketPrice || closes[closes.length - 1] || 0;
  const chg    = price - prevC;
  const chgPct = prevC ? (chg / prevC) * 100 : 0;
  return {
    symbol: sym, shortName: meta.shortName || sym, longName: meta.longName || sym,
    regularMarketPrice: price,
    regularMarketChange: +chg.toFixed(4),
    regularMarketChangePercent: +chgPct.toFixed(4),
    regularMarketVolume: meta.regularMarketVolume || 0,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || null,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow || null,
    marketCap: null, trailingPE: null,
    fullExchangeName: meta.exchangeName || meta.fullExchangeName || '',
  };
}

/* ── Main handler ────────────────────────────── */
export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
  }

  const url      = new URL(req.url);
  const type     = url.searchParams.get('type');
  const symbol   = url.searchParams.get('symbol');
  const symbols  = url.searchParams.get('symbols');
  const interval = url.searchParams.get('interval') || '1d';
  const range    = url.searchParams.get('range')    || '1y';
  const modules  = url.searchParams.get('modules')  || 'summaryDetail,financialData,defaultKeyStatistics,assetProfile';
  const q        = url.searchParams.get('q')        || '';

  try {

    /* ─── Chart — Yahoo Finance v8 (CF network, no crumb) ── */
    if (type === 'chart') {
      if (!symbol) return json({ error: 'Missing symbol' }, 400);

      // Try v8 chart (works without crumb on Cloudflare IPs)
      try {
        const r = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`,
          { headers: YF_HEADERS, signal: AbortSignal.timeout(10000) }
        );
        if (r.ok) return passthrough(await r.text());
      } catch (_) {}

      // Fallback: spark endpoint (close-only → reconstruct OHLCV)
      try {
        const sr = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(symbol)}&range=${range}&interval=${interval}`,
          { headers: YF_HEADERS, signal: AbortSignal.timeout(10000) }
        );
        if (sr.ok) {
          const spark = await sr.json();
          const sd = spark[symbol];
          if (sd?.timestamp?.length) {
            let prev = sd.chartPreviousClose || sd.close?.[0];
            const closes = sd.close || [];
            const opens = [], highs = [], lows = [], vols = [];
            for (const c of closes) {
              const cv = c || prev;
              const spread = Math.abs(cv - prev) * 0.3 + prev * 0.003;
              opens.push(+prev.toFixed(4));
              highs.push(+(Math.max(prev, cv) + spread).toFixed(4));
              lows.push(+(Math.min(prev, cv) - spread).toFixed(4));
              vols.push(0);
              prev = cv;
            }
            const lastC = closes[closes.length - 1] || 0;
            return json({ chart: { result: [{ timestamp: sd.timestamp,
              indicators: { quote: [{ open: opens, high: highs, low: lows, close: closes.map(v => +((v||0).toFixed(4))), volume: vols }] },
              meta: { symbol, currency: 'USD', exchangeName: '', regularMarketPrice: lastC, previousClose: sd.chartPreviousClose || (closes[closes.length-2] || lastC) }
            }] } });
          }
        }
      } catch (_) {}

      return json({ error: 'Chart data unavailable.' }, 503);
    }

    /* ─── Batch quotes ───────────────────────── */
    if (type === 'quote') {
      const syms = (symbols || symbol || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!syms.length) return json({ error: 'Missing symbols' }, 400);

      const results = await Promise.all(syms.map(async sym => {
        try {
          const stooqSym = toStooq(sym);
          if (stooqSym) {
            // Try Stooq first (no YF dependency)
            const r = await fetch(
              `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSym)}&f=sd2t2ohlcvn&h&e=csv`,
              { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://stooq.com/' }, signal: AbortSignal.timeout(6000) }
            );
            if (r.ok) {
              const rows = parseCSV(await r.text());
              if (rows.length && rows[0]['Close'] && rows[0]['Close'] !== 'N/D') {
                const row = rows[0];
                const price  = parseFloat(row['Close']) || 0;
                const open   = parseFloat(row['Open'])  || price;
                const chg    = price - open;
                const chgPct = open ? (chg / open) * 100 : 0;
                return {
                  symbol: sym, shortName: row['Name'] || sym, longName: row['Name'] || sym,
                  regularMarketPrice: price,
                  regularMarketChange: +chg.toFixed(4),
                  regularMarketChangePercent: +chgPct.toFixed(4),
                  regularMarketVolume: parseInt(row['Volume'], 10) || 0,
                  fiftyTwoWeekHigh: null, fiftyTwoWeekLow: null, marketCap: null, trailingPE: null,
                  fullExchangeName: 'Stooq',
                };
              }
            }
          }
          // Fallback: use YF chart endpoint to get current price
          return await yfChartQuote(sym);
        } catch (e) { console.warn('quote err', sym, e.message); return null; }
      }));

      return json({ quoteResponse: { result: results.filter(Boolean) } });
    }

    /* ─── Fundamentals — YF quoteSummary with crumb ── */
    if (type === 'summary') {
      if (!symbol) return json({ error: 'Missing symbol' }, 400);
      try {
        const auth = await getYFAuth();
        const r = await fetch(
          `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${encodeURIComponent(modules)}&crumb=${encodeURIComponent(auth.crumb)}`,
          { headers: { ...YF_HEADERS, 'Cookie': auth.cookie }, signal: AbortSignal.timeout(10000) }
        );
        if (r.ok) return passthrough(await r.text());
        console.warn('quoteSummary', r.status);
      } catch (e) { console.warn('summary err', e.message); }
      return json({ quoteSummary: { result: [{}] } });
    }

    /* ─── Search ──────────────────────────────── */
    if (type === 'search') {
      const query = q.toUpperCase().trim();
      if (!query) return json({ error: 'Missing q' }, 400);
      const known = [
        'AAPL','MSFT','NVDA','GOOGL','AMZN','META','TSLA','BRK-B','JPM','V',
        'UNH','LLY','XOM','AVGO','NFLX','AMD','COST','WMT','MA','PG',
        'JNJ','HD','MRK','ABBV','CVX','KO','PEP','BAC','GS','ORCL',
        'CRM','ADBE','NOW','PLTR','ARM','UBER','SHOP','SPY','QQQ','DIA',
        'IWM','GLD','XLK','XLF','XLV','XLE','XLY','XLP','XLI','XLU','XLRE',
        'ACN','MCD','ISRG','SPGI','CAT','RTX','GE','NEE','SO','AMT',
        'BRK-B','ORCL','COST','WMT','MCD','GS','SPGI','ISRG',
      ];
      const matches = [...new Set(known)].filter(s => s.includes(query)).slice(0, 8);
      return json({ quotes: matches.map(s => ({ symbol: s, shortname: s, quoteType: 'EQUITY', exchange: 'US' })) });
    }

    return json({ error: 'type must be: chart | quote | summary | search' }, 400);

  } catch (err) {
    console.error('[proxy]', type, symbol, err.message);
    return json({ error: err.message }, 500);
  }
}
