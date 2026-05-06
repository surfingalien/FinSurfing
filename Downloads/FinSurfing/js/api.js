/* ═══════════════════════════════════════════════
   FinSurf — Data API Layer
   Routes through /api/proxy (Vercel serverless)
   so Yahoo Finance is called server-side — no CORS
═══════════════════════════════════════════════ */

const YF  = 'https://query1.finance.yahoo.com';
const YF2 = 'https://query2.finance.yahoo.com';

// In-browser cache — 5 min TTL
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

/* ── Proxy fetch ──────────────────────────────── */
async function fetchYF(url) {
  const cacheKey = url;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const proxyUrl = `/api/proxy?url=${encodeURIComponent(url)}`;

  const res = await fetch(proxyUrl, {
    signal: AbortSignal.timeout(12000)
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Proxy error ${res.status}: ${err.error || 'unknown'}`);
  }

  const text = await res.text();
  if (!text || text.length < 10) throw new Error('Empty response from proxy');

  const data = JSON.parse(text);
  cache.set(cacheKey, { data, ts: Date.now() });
  return data;
}

/* ── Chart (OHLCV) ───────────────────────────── */
async function fetchChart(symbol, interval = '1d', range = '1y') {
  const url = `${YF}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
  const data = await fetchYF(url);
  return parseChartData(data, symbol);
}

function parseChartData(raw, symbol) {
  const result = raw?.chart?.result?.[0];
  if (!result) throw new Error('No chart data for ' + symbol);

  const timestamps = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const opens   = q.open   || [];
  const highs   = q.high   || [];
  const lows    = q.low    || [];
  const closes  = q.close  || [];
  const volumes = q.volume || [];
  const meta    = result.meta || {};

  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (!closes[i] || !opens[i]) continue;
    candles.push({
      time:   Math.floor(timestamps[i]),
      open:   +opens[i].toFixed(4),
      high:   +highs[i].toFixed(4),
      low:    +lows[i].toFixed(4),
      close:  +closes[i].toFixed(4),
      volume: volumes[i] || 0
    });
  }

  return {
    symbol:              meta.symbol || symbol,
    currency:            meta.currency || 'USD',
    exchange:            meta.exchangeName || '',
    regularMarketPrice:  meta.regularMarketPrice,
    previousClose:       meta.previousClose || meta.chartPreviousClose,
    candles,
    raw: meta
  };
}

/* ── Fundamentals summary ────────────────────── */
async function fetchSummary(symbol) {
  const modules = 'summaryDetail,financialData,defaultKeyStatistics,assetProfile';
  const url = `${YF}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`;
  try {
    const data = await fetchYF(url);
    return parseSummary(data, symbol);
  } catch (e) {
    console.warn('fetchSummary failed:', e.message);
    return null;
  }
}

function parseSummary(raw, symbol) {
  const r = raw?.quoteSummary?.result?.[0];
  if (!r) return null;

  const sd = r.summaryDetail        || {};
  const fd = r.financialData        || {};
  const ks = r.defaultKeyStatistics || {};
  const ap = r.assetProfile         || {};

  const g = obj => key => {
    const v = obj[key];
    if (!v) return null;
    return v.raw !== undefined ? v.raw : v;
  };

  const gsd = g(sd), gfd = g(fd), gks = g(ks);

  return {
    pe:                gsd('trailingPE'),
    forwardPE:         gsd('forwardPE'),
    eps:               gks('trailingEps'),
    marketCap:         gsd('marketCap'),
    dividendYield:     gsd('dividendYield'),
    beta:              gsd('beta'),
    high52:            gsd('fiftyTwoWeekHigh'),
    low52:             gsd('fiftyTwoWeekLow'),
    avgVolume:         gsd('averageVolume'),
    priceToBook:       gks('priceToBook'),
    returnOnEquity:    gfd('returnOnEquity'),
    debtToEquity:      gfd('debtToEquity'),
    currentRatio:      gfd('currentRatio'),
    revenueGrowth:     gfd('revenueGrowth'),
    earningsGrowth:    gfd('earningsGrowth'),
    profitMargin:      gfd('profitMargins'),
    grossMargin:       gfd('grossMargins'),
    operatingMargin:   gfd('operatingMargins'),
    totalRevenue:      gfd('totalRevenue'),
    freeCashFlow:      gfd('freeCashflow'),
    targetMeanPrice:   gfd('targetMeanPrice'),
    recommendationMean:gfd('recommendationMean'),
    recommendationKey: fd.recommendationKey,
    sector:            ap.sector,
    industry:          ap.industry,
    longName:          ap.longName,
    summary:           ap.longBusinessSummary,
    website:           ap.website,
    employees:         ap.fullTimeEmployees,
    country:           ap.country,
    city:              ap.city
  };
}

/* ── Batch quote ─────────────────────────────── */
async function fetchMultiQuote(symbols) {
  // Yahoo Finance accepts up to ~100 symbols comma-separated
  const sym = symbols.map(s => encodeURIComponent(s)).join('%2C');
  const url = `${YF}/v8/finance/quote?symbols=${sym}`;
  try {
    const data = await fetchYF(url);
    const quotes = data?.quoteResponse?.result || [];
    return quotes.map(q => ({
      symbol:    q.symbol,
      name:      q.shortName || q.longName || q.symbol,
      price:     q.regularMarketPrice,
      change:    q.regularMarketChange,
      changePct: q.regularMarketChangePercent,
      volume:    q.regularMarketVolume,
      high52:    q.fiftyTwoWeekHigh,
      low52:     q.fiftyTwoWeekLow,
      marketCap: q.marketCap,
      pe:        q.trailingPE,
      exchange:  q.fullExchangeName || q.exchange
    }));
  } catch (e) {
    console.warn('fetchMultiQuote failed:', e.message);
    return [];
  }
}

/* ── Search / autocomplete ───────────────────── */
async function searchTicker(query) {
  const url = `${YF}/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0&enableFuzzyQuery=false&enableCb=false`;
  try {
    const data = await fetchYF(url);
    const quotes = data?.quotes || [];
    return quotes
      .filter(q => q.quoteType === 'EQUITY' || q.quoteType === 'ETF' || q.quoteType === 'INDEX')
      .slice(0, 8)
      .map(q => ({
        symbol:   q.symbol,
        name:     q.shortname || q.longname || q.symbol,
        exchange: q.exchange || '',
        type:     q.quoteType
      }));
  } catch {
    return [];
  }
}

/* ─────────────────────────────────────────────
   STATIC REFERENCE DATA
───────────────────────────────────────────── */
const SCREENER_STOCKS = [
  { symbol:'AAPL',  name:'Apple Inc.',             sector:'Technology',             price:0, changePct:0, mktCap:3.5e12, pe:32,  epsGrowth:0.12,  signal:'—' },
  { symbol:'MSFT',  name:'Microsoft Corp.',         sector:'Technology',             price:0, changePct:0, mktCap:3.2e12, pe:35,  epsGrowth:0.15,  signal:'—' },
  { symbol:'NVDA',  name:'NVIDIA Corp.',            sector:'Technology',             price:0, changePct:0, mktCap:2.8e12, pe:45,  epsGrowth:0.65,  signal:'—' },
  { symbol:'GOOGL', name:'Alphabet Inc.',           sector:'Communication Services', price:0, changePct:0, mktCap:2.1e12, pe:22,  epsGrowth:0.28,  signal:'—' },
  { symbol:'AMZN',  name:'Amazon.com Inc.',         sector:'Consumer Cyclical',      price:0, changePct:0, mktCap:2.2e12, pe:42,  epsGrowth:0.55,  signal:'—' },
  { symbol:'META',  name:'Meta Platforms',          sector:'Communication Services', price:0, changePct:0, mktCap:1.5e12, pe:27,  epsGrowth:0.35,  signal:'—' },
  { symbol:'BRK-B', name:'Berkshire Hathaway',      sector:'Financials',             price:0, changePct:0, mktCap:1.0e12, pe:21,  epsGrowth:0.08,  signal:'—' },
  { symbol:'TSLA',  name:'Tesla Inc.',              sector:'Consumer Cyclical',      price:0, changePct:0, mktCap:1.1e12, pe:85,  epsGrowth:-0.35, signal:'—' },
  { symbol:'JPM',   name:'JPMorgan Chase',          sector:'Financials',             price:0, changePct:0, mktCap:0.7e12, pe:14,  epsGrowth:0.12,  signal:'—' },
  { symbol:'V',     name:'Visa Inc.',               sector:'Financials',             price:0, changePct:0, mktCap:0.6e12, pe:28,  epsGrowth:0.14,  signal:'—' },
  { symbol:'UNH',   name:'UnitedHealth Group',      sector:'Health Care',            price:0, changePct:0, mktCap:0.55e12,pe:18,  epsGrowth:0.10,  signal:'—' },
  { symbol:'XOM',   name:'Exxon Mobil Corp.',       sector:'Energy',                 price:0, changePct:0, mktCap:0.5e12, pe:14,  epsGrowth:-0.08, signal:'—' },
  { symbol:'LLY',   name:'Eli Lilly & Co.',         sector:'Health Care',            price:0, changePct:0, mktCap:0.9e12, pe:65,  epsGrowth:0.80,  signal:'—' },
  { symbol:'MA',    name:'Mastercard Inc.',         sector:'Financials',             price:0, changePct:0, mktCap:0.48e12,pe:37,  epsGrowth:0.16,  signal:'—' },
  { symbol:'AVGO',  name:'Broadcom Inc.',           sector:'Technology',             price:0, changePct:0, mktCap:0.85e12,pe:32,  epsGrowth:0.22,  signal:'—' },
  { symbol:'JNJ',   name:'Johnson & Johnson',       sector:'Health Care',            price:0, changePct:0, mktCap:0.37e12,pe:16,  epsGrowth:0.05,  signal:'—' },
  { symbol:'PG',    name:'Procter & Gamble',        sector:'Consumer Defensive',     price:0, changePct:0, mktCap:0.38e12,pe:26,  epsGrowth:0.07,  signal:'—' },
  { symbol:'HD',    name:'Home Depot Inc.',         sector:'Consumer Cyclical',      price:0, changePct:0, mktCap:0.38e12,pe:24,  epsGrowth:0.04,  signal:'—' },
  { symbol:'MRK',   name:'Merck & Co.',             sector:'Health Care',            price:0, changePct:0, mktCap:0.32e12,pe:15,  epsGrowth:0.18,  signal:'—' },
  { symbol:'ABBV',  name:'AbbVie Inc.',             sector:'Health Care',            price:0, changePct:0, mktCap:0.33e12,pe:17,  epsGrowth:0.09,  signal:'—' },
  { symbol:'CVX',   name:'Chevron Corp.',           sector:'Energy',                 price:0, changePct:0, mktCap:0.28e12,pe:14,  epsGrowth:-0.06, signal:'—' },
  { symbol:'COST',  name:'Costco Wholesale',        sector:'Consumer Defensive',     price:0, changePct:0, mktCap:0.42e12,pe:52,  epsGrowth:0.13,  signal:'—' },
  { symbol:'AMD',   name:'Advanced Micro Devices',  sector:'Technology',             price:0, changePct:0, mktCap:0.28e12,pe:38,  epsGrowth:0.85,  signal:'—' },
  { symbol:'WMT',   name:'Walmart Inc.',            sector:'Consumer Defensive',     price:0, changePct:0, mktCap:0.58e12,pe:31,  epsGrowth:0.14,  signal:'—' },
  { symbol:'BAC',   name:'Bank of America',         sector:'Financials',             price:0, changePct:0, mktCap:0.32e12,pe:15,  epsGrowth:0.06,  signal:'—' },
  { symbol:'ORCL',  name:'Oracle Corp.',            sector:'Technology',             price:0, changePct:0, mktCap:0.42e12,pe:22,  epsGrowth:0.14,  signal:'—' },
  { symbol:'NFLX',  name:'Netflix Inc.',            sector:'Communication Services', price:0, changePct:0, mktCap:0.45e12,pe:52,  epsGrowth:0.72,  signal:'—' },
  { symbol:'CRM',   name:'Salesforce Inc.',         sector:'Technology',             price:0, changePct:0, mktCap:0.28e12,pe:38,  epsGrowth:0.20,  signal:'—' },
  { symbol:'ADBE',  name:'Adobe Inc.',              sector:'Technology',             price:0, changePct:0, mktCap:0.20e12,pe:28,  epsGrowth:0.12,  signal:'—' },
  { symbol:'TMO',   name:'Thermo Fisher Scientific',sector:'Health Care',            price:0, changePct:0, mktCap:0.23e12,pe:28,  epsGrowth:0.06,  signal:'—' },
  { symbol:'KO',    name:'Coca-Cola Co.',           sector:'Consumer Defensive',     price:0, changePct:0, mktCap:0.27e12,pe:24,  epsGrowth:0.05,  signal:'—' },
  { symbol:'PEP',   name:'PepsiCo Inc.',            sector:'Consumer Defensive',     price:0, changePct:0, mktCap:0.21e12,pe:23,  epsGrowth:0.04,  signal:'—' },
  { symbol:'ACN',   name:'Accenture plc',           sector:'Technology',             price:0, changePct:0, mktCap:0.22e12,pe:30,  epsGrowth:0.08,  signal:'—' },
  { symbol:'MCD',   name:"McDonald's Corp.",        sector:'Consumer Cyclical',      price:0, changePct:0, mktCap:0.21e12,pe:25,  epsGrowth:0.09,  signal:'—' },
  { symbol:'GS',    name:'Goldman Sachs',           sector:'Financials',             price:0, changePct:0, mktCap:0.18e12,pe:14,  epsGrowth:0.28,  signal:'—' },
  { symbol:'NOW',   name:'ServiceNow Inc.',         sector:'Technology',             price:0, changePct:0, mktCap:0.22e12,pe:60,  epsGrowth:0.32,  signal:'—' },
  { symbol:'ISRG',  name:'Intuitive Surgical',      sector:'Health Care',            price:0, changePct:0, mktCap:0.19e12,pe:68,  epsGrowth:0.22,  signal:'—' },
  { symbol:'SPGI',  name:'S&P Global Inc.',         sector:'Financials',             price:0, changePct:0, mktCap:0.16e12,pe:42,  epsGrowth:0.13,  signal:'—' },
  { symbol:'CAT',   name:'Caterpillar Inc.',        sector:'Industrials',            price:0, changePct:0, mktCap:0.19e12,pe:18,  epsGrowth:0.08,  signal:'—' },
  { symbol:'RTX',   name:'RTX Corp.',               sector:'Industrials',            price:0, changePct:0, mktCap:0.17e12,pe:22,  epsGrowth:0.15,  signal:'—' },
  { symbol:'GE',    name:'GE Aerospace',            sector:'Industrials',            price:0, changePct:0, mktCap:0.22e12,pe:34,  epsGrowth:0.42,  signal:'—' },
  { symbol:'NEE',   name:'NextEra Energy',          sector:'Utilities',              price:0, changePct:0, mktCap:0.15e12,pe:22,  epsGrowth:0.08,  signal:'—' },
  { symbol:'SO',    name:'Southern Company',        sector:'Utilities',              price:0, changePct:0, mktCap:0.10e12,pe:20,  epsGrowth:0.05,  signal:'—' },
  { symbol:'AMT',   name:'American Tower',          sector:'Real Estate',            price:0, changePct:0, mktCap:0.10e12,pe:35,  epsGrowth:0.06,  signal:'—' },
  { symbol:'PLTR',  name:'Palantir Technologies',   sector:'Technology',             price:0, changePct:0, mktCap:0.22e12,pe:185, epsGrowth:1.20,  signal:'—' },
  { symbol:'ARM',   name:'Arm Holdings',            sector:'Technology',             price:0, changePct:0, mktCap:0.15e12,pe:120, epsGrowth:0.65,  signal:'—' },
  { symbol:'UBER',  name:'Uber Technologies',       sector:'Technology',             price:0, changePct:0, mktCap:0.18e12,pe:22,  epsGrowth:0.90,  signal:'—' },
  { symbol:'SHOP',  name:'Shopify Inc.',            sector:'Technology',             price:0, changePct:0, mktCap:0.12e12,pe:55,  epsGrowth:0.48,  signal:'—' },
  { symbol:'SQ',    name:'Block Inc.',              sector:'Financials',             price:0, changePct:0, mktCap:0.05e12,pe:28,  epsGrowth:0.42,  signal:'—' },
];

const TICKER_SYMBOLS = ['SPY','QQQ','DIA','AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','BRK-B','UNH','LLY','XOM','JPM','V','NFLX','AMD'];

const TOP_STOCKS = [
  { symbol:'AAPL',  name:'Apple Inc.'  },
  { symbol:'MSFT',  name:'Microsoft'   },
  { symbol:'NVDA',  name:'NVIDIA'      },
  { symbol:'GOOGL', name:'Alphabet'    },
  { symbol:'AMZN',  name:'Amazon'      },
  { symbol:'META',  name:'Meta'        },
  { symbol:'TSLA',  name:'Tesla'       },
  { symbol:'NFLX',  name:'Netflix'     },
  { symbol:'AMD',   name:'AMD'         },
  { symbol:'LLY',   name:'Eli Lilly'   }
];

const SECTOR_ETFS  = ['XLK','XLF','XLV','XLE','XLY','XLP','XLI','XLU','XLRE','XLB','XLC'];
const INDEX_ETFS   = ['SPY','QQQ','DIA','IWM','^VIX','GLD'];

const SYMBOL_DB = {
  'AAPL':'Apple Inc.', 'MSFT':'Microsoft Corp.', 'NVDA':'NVIDIA Corp.', 'GOOGL':'Alphabet Inc.',
  'AMZN':'Amazon.com', 'META':'Meta Platforms', 'TSLA':'Tesla Inc.', 'NFLX':'Netflix',
  'AMD':'AMD', 'AVGO':'Broadcom', 'ORCL':'Oracle', 'CRM':'Salesforce',
  'ADBE':'Adobe', 'NOW':'ServiceNow', 'PLTR':'Palantir', 'ARM':'Arm Holdings',
  'UBER':'Uber', 'SHOP':'Shopify', 'JPM':'JPMorgan Chase', 'BAC':'Bank of America',
  'GS':'Goldman Sachs', 'V':'Visa', 'MA':'Mastercard', 'BRK-B':'Berkshire Hathaway',
  'UNH':'UnitedHealth', 'LLY':'Eli Lilly', 'JNJ':'J&J', 'MRK':'Merck', 'ABBV':'AbbVie',
  'XOM':'Exxon Mobil', 'CVX':'Chevron', 'PG':'Procter & Gamble', 'KO':'Coca-Cola',
  'PEP':'PepsiCo', 'WMT':'Walmart', 'COST':'Costco', 'MCD':"McDonald's",
  'HD':'Home Depot', 'CAT':'Caterpillar', 'GE':'GE Aerospace', 'RTX':'RTX Corp.',
  'NEE':'NextEra Energy', 'SO':'Southern Co.', 'AMT':'American Tower',
  'SPY':'S&P 500 ETF', 'QQQ':'Nasdaq 100 ETF', 'DIA':'Dow Jones ETF', 'IWM':'Russell 2000 ETF',
  '^VIX':'CBOE Volatility', 'GLD':'Gold ETF',
  'XLK':'Tech Sector', 'XLF':'Financials', 'XLV':'Health Care', 'XLE':'Energy',
  'XLY':'Cons. Disc.', 'XLP':'Cons. Staples', 'XLI':'Industrials', 'XLU':'Utilities',
  'XLRE':'Real Estate', 'XLB':'Materials', 'XLC':'Comm. Svc.'
};
