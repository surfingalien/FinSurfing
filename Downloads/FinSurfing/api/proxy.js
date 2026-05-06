/* ═══════════════════════════════════════════════
   FinSurf — Vercel Serverless Data API
   Uses yahoo-finance2 which handles YF auth internally
═══════════════════════════════════════════════ */

const yahooFinance = require('yahoo-finance2').default;

// Suppress noisy validation warnings in logs
yahooFinance.setGlobalConfig({ validation: { logErrors: false } });

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type, symbol, symbols, interval, range, modules } = req.query;

  // Short cache headers
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');

  try {
    /* ─── Chart / OHLCV ─────────────────────── */
    if (type === 'chart') {
      if (!symbol) return res.status(400).json({ error: 'Missing symbol' });

      const period1 = rangeToDate(range || '1y');
      const intervalStr = interval || '1d';

      const result = await yahooFinance.chart(symbol, {
        interval: intervalStr,
        period1,
        period2: 'now',
      });

      return res.status(200).json({ chart: { result: [formatChartResult(result, symbol)] } });
    }

    /* ─── Batch quotes ──────────────────────── */
    if (type === 'quote') {
      const syms = (symbols || symbol || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!syms.length) return res.status(400).json({ error: 'Missing symbols' });

      const results = await yahooFinance.quote(syms);
      const arr = Array.isArray(results) ? results : [results];

      return res.status(200).json({
        quoteResponse: {
          result: arr.map(q => ({
            symbol:                      q.symbol,
            shortName:                   q.shortName || q.longName || q.symbol,
            longName:                    q.longName,
            regularMarketPrice:          q.regularMarketPrice,
            regularMarketChange:         q.regularMarketChange,
            regularMarketChangePercent:  q.regularMarketChangePercent,
            regularMarketVolume:         q.regularMarketVolume,
            fiftyTwoWeekHigh:            q.fiftyTwoWeekHigh,
            fiftyTwoWeekLow:             q.fiftyTwoWeekLow,
            marketCap:                   q.marketCap,
            trailingPE:                  q.trailingPE,
            fullExchangeName:            q.fullExchangeName || q.exchange,
          }))
        }
      });
    }

    /* ─── Fundamentals (quoteSummary) ────────── */
    if (type === 'summary') {
      if (!symbol) return res.status(400).json({ error: 'Missing symbol' });

      const moduleList = (modules || 'summaryDetail,financialData,defaultKeyStatistics,assetProfile').split(',');

      const result = await yahooFinance.quoteSummary(symbol, {
        modules: moduleList,
      });

      return res.status(200).json({ quoteSummary: { result: [result] } });
    }

    /* ─── Search / autocomplete ─────────────── */
    if (type === 'search') {
      const q = req.query.q || req.query.query || '';
      if (!q) return res.status(400).json({ error: 'Missing q' });

      const result = await yahooFinance.search(q, { quotesCount: 8, newsCount: 0 });
      return res.status(200).json({ quotes: result.quotes });
    }

    return res.status(400).json({ error: 'Missing or invalid type param. Use: chart | quote | summary | search' });

  } catch (err) {
    console.error(`[proxy] type=${type} symbol=${symbol}`, err.message);
    return res.status(500).json({ error: err.message });
  }
};

/* ── Helpers ─────────────────────────────────── */
function rangeToDate(range) {
  const now = new Date();
  const map = {
    '5d': 5, '1mo': 30, '3mo': 90, '6mo': 180,
    '1y': 365, '2y': 730, '5y': 1825
  };
  const days = map[range] || 365;
  return new Date(now - days * 86400000).toISOString().slice(0, 10);
}

function formatChartResult(r, sym) {
  // yahoo-finance2 returns a nicely structured object; map it to the shape
  // our frontend parseChartData() expects
  const quotes  = r.quotes || [];
  const meta    = r.meta   || {};
  const ts      = quotes.map(q => Math.floor(new Date(q.date).getTime() / 1000));
  const opens   = quotes.map(q => q.open);
  const highs   = quotes.map(q => q.high);
  const lows    = quotes.map(q => q.low);
  const closes  = quotes.map(q => q.close || q.adjclose);
  const volumes = quotes.map(q => q.volume || 0);

  return {
    timestamp: ts,
    indicators: {
      quote: [{ open: opens, high: highs, low: lows, close: closes, volume: volumes }]
    },
    meta: {
      symbol:             meta.symbol || sym,
      currency:           meta.currency || 'USD',
      exchangeName:       meta.exchangeName || meta.fullExchangeName || '',
      regularMarketPrice: meta.regularMarketPrice || closes[closes.length - 1],
      previousClose:      meta.chartPreviousClose || meta.previousClose,
    }
  };
}
