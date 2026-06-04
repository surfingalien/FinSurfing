'use strict'
/**
 * routes/exchange.js
 * Multi-exchange market data + trading via CCXT (110+ exchanges).
 *
 * Public endpoints (no API key needed):
 *   GET /api/exchange/exchanges
 *   GET /api/exchange/ohlcv?exchange=binance&symbol=BTC/USDT&timeframe=1h&limit=200
 *   GET /api/exchange/ticker?exchange=binance&symbol=BTC/USDT
 *   GET /api/exchange/orderbook?exchange=binance&symbol=BTC/USDT&limit=20
 *   GET /api/exchange/markets?exchange=binance&type=spot
 *
 * Authenticated (x-exchange-key + x-exchange-secret headers):
 *   GET  /api/exchange/balances?exchange=binance
 *   GET  /api/exchange/orders?exchange=binance&symbol=BTC/USDT
 *   POST /api/exchange/order  { exchange, symbol, side, type, amount, price? }
 *   DELETE /api/exchange/order/:id?exchange=binance&symbol=BTC/USDT
 */

const express   = require('express')
const router    = express.Router()
const rateLimit = require('express-rate-limit')
const ccxt      = require('ccxt')

const exchangeLimit = rateLimit({ windowMs: 60 * 1000, max: 60,
  message: { error: 'Exchange API rate limit — wait a minute' } })

const tradeLimit = rateLimit({ windowMs: 60 * 1000, max: 10,
  message: { error: 'Trade rate limit — wait a minute' } })

// Popular exchanges curated for retail traders
const POPULAR = [
  'binance', 'coinbase', 'kraken', 'okx', 'bybit',
  'kucoin',  'gate',     'bitfinex', 'mexc', 'htx',
]

// ── Exchange instance cache ───────────────────────────────────────────────────
// loadMarkets() is expensive (1 REST call); cache per exchange+key combo.
const _instances   = new Map()
const _marketCache = new Map()   // exchangeId → { markets, ts }
const MARKET_TTL   = 10 * 60_000 // 10 min

function getExchange(exchangeId, apiKey = null, secret = null) {
  const id = exchangeId.toLowerCase()
  if (!ccxt.exchanges.includes(id)) throw new Error(`Unknown exchange: ${id}`)

  const cacheKey = `${id}:${apiKey || 'pub'}`
  if (_instances.has(cacheKey)) return _instances.get(cacheKey)

  const ExClass = ccxt[id]
  const cfg = { enableRateLimit: true, timeout: 15000 }
  if (apiKey) cfg.apiKey = apiKey
  if (secret) cfg.secret = secret

  const ex = new ExClass(cfg)
  _instances.set(cacheKey, ex)
  return ex
}

async function ensureMarkets(ex) {
  const hit = _marketCache.get(ex.id)
  if (hit && Date.now() - hit.ts < MARKET_TTL) return hit.markets
  const markets = await ex.loadMarkets()
  _marketCache.set(ex.id, { markets, ts: Date.now() })
  return markets
}

function authKeys(req) {
  return {
    apiKey: (req.headers['x-exchange-key']    || '').trim() || null,
    secret: (req.headers['x-exchange-secret'] || '').trim() || null,
  }
}

// ── GET /api/exchange/exchanges ───────────────────────────────────────────────
router.get('/exchanges', (req, res) => {
  const list = POPULAR
    .filter(id => ccxt.exchanges.includes(id))
    .map(id => ({ id, name: new ccxt[id]().name }))
  res.json({ count: list.length, exchanges: list })
})

// ── GET /api/exchange/ohlcv ───────────────────────────────────────────────────
router.get('/ohlcv', exchangeLimit, async (req, res) => {
  const { exchange = 'binance', symbol, timeframe = '1d', limit = '200' } = req.query
  if (!symbol) return res.status(400).json({ error: 'symbol required (e.g. BTC/USDT)' })
  try {
    const ex = getExchange(exchange)
    await ensureMarkets(ex)
    const raw = await ex.fetchOHLCV(symbol, timeframe, undefined, Math.min(parseInt(limit) || 200, 1000))
    res.json({
      symbol, exchange, timeframe,
      ohlcv: raw.map(([ts, o, h, l, c, v]) => ({ ts, o, h, l, c, v })),
    })
  } catch (e) {
    console.warn(`[exchange] ohlcv ${exchange}:${symbol}`, e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── GET /api/exchange/ticker ──────────────────────────────────────────────────
router.get('/ticker', exchangeLimit, async (req, res) => {
  const { exchange = 'binance', symbol } = req.query
  if (!symbol) return res.status(400).json({ error: 'symbol required' })
  try {
    const ex = getExchange(exchange)
    const t  = await ex.fetchTicker(symbol)
    res.json({
      symbol, exchange,
      price:     t.last,
      bid:       t.bid,
      ask:       t.ask,
      high:      t.high,
      low:       t.low,
      volume:    t.baseVolume,
      quoteVol:  t.quoteVolume,
      change:    t.change,
      changePct: t.percentage,
      ts:        t.timestamp,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── GET /api/exchange/tickers?exchange=binance&symbols=BTC/USDT,ETH/USDT ──────
router.get('/tickers', exchangeLimit, async (req, res) => {
  const { exchange = 'binance', symbols } = req.query
  const syms = symbols ? symbols.split(',').map(s => s.trim()).filter(Boolean).slice(0, 20) : undefined
  try {
    const ex = getExchange(exchange)
    const raw = syms ? await ex.fetchTickers(syms) : await ex.fetchTickers()
    const out = Object.values(raw).slice(0, 50).map(t => ({
      symbol: t.symbol, price: t.last, change: t.change, changePct: t.percentage,
      volume: t.baseVolume, high: t.high, low: t.low,
    }))
    res.json({ exchange, count: out.length, tickers: out })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── GET /api/exchange/orderbook ───────────────────────────────────────────────
router.get('/orderbook', exchangeLimit, async (req, res) => {
  const { exchange = 'binance', symbol, limit = '20' } = req.query
  if (!symbol) return res.status(400).json({ error: 'symbol required' })
  try {
    const ex = getExchange(exchange)
    const ob = await ex.fetchOrderBook(symbol, Math.min(parseInt(limit) || 20, 50))
    const spread = ob.asks[0]?.[0] && ob.bids[0]?.[0]
      ? +(ob.asks[0][0] - ob.bids[0][0]).toPrecision(6)
      : null
    res.json({
      symbol, exchange,
      bids:      ob.bids.slice(0, 10),
      asks:      ob.asks.slice(0, 10),
      spread,
      ts:        ob.timestamp,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── GET /api/exchange/markets ─────────────────────────────────────────────────
router.get('/markets', exchangeLimit, async (req, res) => {
  const { exchange = 'binance', type = 'spot', quote = '' } = req.query
  try {
    const ex = getExchange(exchange)
    const markets = await ensureMarkets(ex)
    const out = Object.values(markets)
      .filter(m => (type === 'all' || m.type === type) && (!quote || m.quote === quote.toUpperCase()))
      .slice(0, 200)
      .map(m => ({ symbol: m.symbol, base: m.base, quote: m.quote, type: m.type, active: m.active }))
    res.json({ exchange, type, count: out.length, markets: out })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── GET /api/exchange/balances  (authenticated) ───────────────────────────────
router.get('/balances', exchangeLimit, async (req, res) => {
  const { exchange = 'binance' } = req.query
  const { apiKey, secret } = authKeys(req)
  if (!apiKey || !secret)
    return res.status(401).json({ error: 'x-exchange-key and x-exchange-secret headers required' })
  try {
    const ex = getExchange(exchange, apiKey, secret)
    const bal = await ex.fetchBalance()
    const nonZero = {}
    for (const [asset, total] of Object.entries(bal.total || {})) {
      if (total > 0) nonZero[asset] = { total, free: bal.free?.[asset] ?? 0, used: bal.used?.[asset] ?? 0 }
    }
    res.json({ exchange, balances: nonZero })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── GET /api/exchange/orders  (authenticated) ─────────────────────────────────
router.get('/orders', exchangeLimit, async (req, res) => {
  const { exchange = 'binance', symbol } = req.query
  const { apiKey, secret } = authKeys(req)
  if (!apiKey || !secret)
    return res.status(401).json({ error: 'x-exchange-key and x-exchange-secret headers required' })
  try {
    const ex = getExchange(exchange, apiKey, secret)
    const orders = await ex.fetchOpenOrders(symbol || undefined)
    res.json({ exchange, count: orders.length, orders: orders.map(o => ({
      id: o.id, symbol: o.symbol, side: o.side, type: o.type,
      amount: o.amount, price: o.price, filled: o.filled, status: o.status, ts: o.timestamp,
    })) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── POST /api/exchange/order  (authenticated) ─────────────────────────────────
router.post('/order', tradeLimit, async (req, res) => {
  const { exchange = 'binance', symbol, side, type = 'market', amount, price } = req.body
  const { apiKey, secret } = authKeys(req)
  if (!apiKey || !secret)
    return res.status(401).json({ error: 'x-exchange-key and x-exchange-secret headers required' })
  if (!symbol || !side || !amount)
    return res.status(400).json({ error: 'symbol, side, and amount are required' })
  if (!['buy', 'sell'].includes(side.toLowerCase()))
    return res.status(400).json({ error: 'side must be buy or sell' })
  try {
    const ex = getExchange(exchange, apiKey, secret)
    await ensureMarkets(ex)
    const order = await ex.createOrder(symbol, type, side.toLowerCase(), parseFloat(amount), price ? parseFloat(price) : undefined)
    res.json({ exchange, order: { id: order.id, symbol: order.symbol, side: order.side, type: order.type,
      amount: order.amount, price: order.price, status: order.status, ts: order.timestamp } })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── DELETE /api/exchange/order/:id  (authenticated) ──────────────────────────
router.delete('/order/:id', tradeLimit, async (req, res) => {
  const { exchange = 'binance', symbol } = req.query
  const { apiKey, secret } = authKeys(req)
  if (!apiKey || !secret)
    return res.status(401).json({ error: 'x-exchange-key and x-exchange-secret headers required' })
  if (!symbol) return res.status(400).json({ error: 'symbol query param required' })
  try {
    const ex = getExchange(exchange, apiKey, secret)
    const result = await ex.cancelOrder(req.params.id, symbol)
    res.json({ exchange, cancelled: true, orderId: result.id || req.params.id })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
