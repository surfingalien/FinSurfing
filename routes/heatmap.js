'use strict'
/**
 * routes/heatmap.js
 *
 * GET /api/heatmap/:market
 *   market = crypto | sectors | indices | forex
 *
 * Returns:
 *   { market, cells: [{name, fullName, value (changePct), price, marketCap?, volume?}],
 *     generatedAt, cached }
 *
 * Data sources — all keyless:
 *   crypto:  CoinGecko /coins/markets → CoinCap /assets fallback
 *   sectors: FinSurfing internal /api/quote for 11 sector ETFs
 *   indices: FinSurfing internal /api/quote for major indices
 *   forex:   ExchangeRate-API (keyless) → Frankfurter fallback
 *
 * Cache: 5 min per market
 */

const express = require('express')
const router  = express.Router()

const CACHE_TTL_MS = 5 * 60_000
const _cache = new Map()   // market → { ts, data }

function cached(market) {
  const hit = _cache.get(market)
  return hit && Date.now() - hit.ts < CACHE_TTL_MS ? hit.data : null
}
function setCache(market, data) { _cache.set(market, { ts: Date.now(), data }) }

// ── Crypto heatmap — CoinGecko → CoinCap fallback ──────────────────────────
async function fetchCryptoCells() {
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=16&page=1&price_change_percentage=24h',
      { signal: AbortSignal.timeout(8_000) }
    )
    if (r.ok) {
      const data = await r.json()
      return data.map(c => ({
        name:      c.symbol?.toUpperCase(),
        fullName:  c.name,
        value:     +(c.price_change_percentage_24h ?? 0).toFixed(2),
        price:     c.current_price ?? null,
        marketCap: c.market_cap    ?? null,
        volume:    c.total_volume  ?? null,
      })).filter(c => c.name)
    }
  } catch {}
  // CoinCap fallback
  const r2 = await fetch('https://api.coincap.io/v2/assets?limit=16', { signal: AbortSignal.timeout(8_000) })
  if (!r2.ok) throw new Error('CoinCap HTTP ' + r2.status)
  const { data } = await r2.json()
  return (data || []).map(c => ({
    name:      (c.symbol || '').toUpperCase(),
    fullName:  c.name,
    value:     +(parseFloat(c.changePercent24Hr || 0)).toFixed(2),
    price:     parseFloat(c.priceUsd) || null,
    marketCap: parseFloat(c.marketCapUsd) || null,
    volume:    parseFloat(c.volumeUsd24Hr) || null,
  }))
}

// ── Sector ETF heatmap — uses internal quote endpoint ──────────────────────
const SECTOR_ETFS = [
  { sym: 'XLK',  name: 'Technology'        },
  { sym: 'XLV',  name: 'Healthcare'        },
  { sym: 'XLF',  name: 'Financials'        },
  { sym: 'XLY',  name: 'Consumer Disc.'    },
  { sym: 'XLP',  name: 'Consumer Staples'  },
  { sym: 'XLE',  name: 'Energy'            },
  { sym: 'XLI',  name: 'Industrials'       },
  { sym: 'XLB',  name: 'Materials'         },
  { sym: 'XLRE', name: 'Real Estate'       },
  { sym: 'XLU',  name: 'Utilities'         },
  { sym: 'XLC',  name: 'Communication'     },
]

const INDICES = [
  { sym: 'SPY',  name: 'S&P 500'    },
  { sym: 'QQQ',  name: 'Nasdaq'     },
  { sym: 'DIA',  name: 'Dow Jones'  },
  { sym: 'IWM',  name: 'Russell 2000' },
  { sym: 'EFA',  name: 'Intl Dev.'  },
  { sym: 'EEM',  name: 'Emerging'   },
  { sym: 'GLD',  name: 'Gold'       },
  { sym: 'TLT',  name: '20Y Bonds'  },
  { sym: 'USO',  name: 'Oil'        },
  { sym: 'VIX',  name: 'VIX'        },
]

async function fetchInternalQuotes(symbols, port) {
  const r = await fetch(
    `http://127.0.0.1:${port}/api/quote?symbols=${symbols.map(encodeURIComponent).join(',')}`,
    { signal: AbortSignal.timeout(10_000) }
  )
  if (!r.ok) throw new Error('Internal quote HTTP ' + r.status)
  const data = await r.json()
  return data.quoteResponse?.result ?? []
}

async function fetchSectorCells(port) {
  const syms   = SECTOR_ETFS.map(e => e.sym)
  const quotes = await fetchInternalQuotes(syms, port)
  const qmap   = Object.fromEntries(quotes.map(q => [q.symbol, q]))
  return SECTOR_ETFS.map(e => {
    const q = qmap[e.sym] || {}
    return {
      name:     e.sym,
      fullName: e.name,
      value:    +(q.regularMarketChangePercent ?? 0).toFixed(2),
      price:    q.regularMarketPrice ?? null,
    }
  })
}

async function fetchIndicesCells(port) {
  const syms   = INDICES.map(e => e.sym)
  const quotes = await fetchInternalQuotes(syms, port)
  const qmap   = Object.fromEntries(quotes.map(q => [q.symbol, q]))
  return INDICES.map(e => {
    const q = qmap[e.sym] || {}
    return {
      name:     e.sym,
      fullName: e.name,
      value:    +(q.regularMarketChangePercent ?? 0).toFixed(2),
      price:    q.regularMarketPrice ?? null,
    }
  })
}

// ── Forex heatmap — Frankfurter (keyless) ────────────────────────────────────
const FOREX_PAIRS = ['EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'MXN', 'INR', 'BRL']

async function fetchForexCells() {
  // Frankfurter: get today's rates and yesterday's for % change
  const today = new Date().toISOString().slice(0, 10)
  const yday  = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  const [rToday, rYday] = await Promise.all([
    fetch(`https://api.frankfurter.app/${today}?base=USD&symbols=${FOREX_PAIRS.join(',')}`, { signal: AbortSignal.timeout(8_000) }),
    fetch(`https://api.frankfurter.app/${yday}?base=USD&symbols=${FOREX_PAIRS.join(',')}`,  { signal: AbortSignal.timeout(8_000) }),
  ])
  if (!rToday.ok) throw new Error('Frankfurter HTTP ' + rToday.status)
  const [dToday, dYday] = await Promise.all([rToday.json(), rYday.ok ? rYday.json() : Promise.resolve({})])
  const ratesT = dToday.rates || {}
  const ratesY = dYday.rates  || {}
  return FOREX_PAIRS.map(cur => {
    const rT = ratesT[cur]
    const rY = ratesY[cur]
    const changePct = rT != null && rY != null && rY !== 0 ? +((rT - rY) / rY * 100).toFixed(3) : null
    return { name: `USD/${cur}`, fullName: cur, value: changePct ?? 0, price: rT ?? null }
  }).filter(c => c.price != null)
}

// ── GET /api/heatmap/:market ─────────────────────────────────────────────────
router.get('/:market', async (req, res) => {
  const market = (req.params.market || '').toLowerCase()
  const valid  = ['crypto', 'sectors', 'indices', 'forex']
  if (!valid.includes(market)) return res.status(400).json({ error: `market must be one of: ${valid.join(', ')}` })

  const hit = cached(market)
  if (hit) return res.json({ ...hit, cached: true })

  const port = process.env.PORT || 3001

  try {
    let cells
    if      (market === 'crypto')  cells = await fetchCryptoCells()
    else if (market === 'sectors') cells = await fetchSectorCells(port)
    else if (market === 'indices') cells = await fetchIndicesCells(port)
    else                           cells = await fetchForexCells()

    const payload = { market, cells, generatedAt: new Date().toISOString(), cached: false }
    setCache(market, payload)
    return res.json(payload)
  } catch (err) {
    console.warn('[heatmap]', market, err.message)
    return res.status(503).json({ error: err.message, market, cells: [] })
  }
})

module.exports = router
