'use strict'
/**
 * lib/paper-broker.js
 *
 * BOUNDED write access — the AI Brain's action surface.
 *
 * Everything in FinSurfing up to now has been advisory: the Brain produces
 * picks and a human decides. This gives it the ability to ACT — but only on a
 * simulated portfolio, and only inside limits enforced here in code.
 *
 * The safety model, in order of precedence (each one alone can stop a trade):
 *   1. KILL SWITCH — PAPER_TRADING_ENABLED must be exactly 'true'. Absent or
 *      anything else = the broker is inert and every order is rejected. The
 *      operator holds this; no prompt, model, or API caller can flip it.
 *   2. HARD LIMITS — max position size, max open positions, max trades per day,
 *      min order size. Checked against the CURRENT portfolio on every order.
 *   3. STRUCTURAL BANS — no shorting (sell is capped at shares held), no
 *      leverage (buys are capped at available cash), no derivatives. These are
 *      not configurable; they're properties of the arithmetic below.
 *
 * The model never computes a fill, a position size, or a P&L figure: it can
 * only ask for a symbol and a direction. Everything else is arithmetic here.
 *
 * State: data/paper-portfolio.json (positions + cash) and an append-only
 * data/paper-trades.jsonl (audit trail — every accepted AND rejected order,
 * so a refused trade is as visible as an executed one).
 *
 * Pure decision/limit logic is separated from I/O and unit-tested.
 * Tests: tests/paper-broker.test.js
 */

const fs   = require('fs')
const path = require('path')

const DATA_DIR       = path.join(__dirname, '../data')
const PORTFOLIO_FILE = path.join(DATA_DIR, 'paper-portfolio.json')
const TRADES_LOG     = path.join(DATA_DIR, 'paper-trades.jsonl')

const STARTING_CASH = 100_000

// Hard limits. Env can only make these STRICTER, never looser — a
// misconfigured env var can't widen the blast radius.
const CEILINGS = {
  maxPositionPct:   20,   // % of portfolio equity in any one symbol
  maxOpenPositions: 15,
  maxTradesPerDay:  10,
  minOrderValue:    100,  // ignore dust orders
}

function envNum(name, ceiling) {
  const raw = Number(process.env[name])
  if (!Number.isFinite(raw) || raw <= 0) return ceiling
  return Math.min(raw, ceiling)   // env may tighten, never loosen
}

function limits() {
  return {
    maxPositionPct:   envNum('PAPER_MAX_POSITION_PCT',   CEILINGS.maxPositionPct),
    maxOpenPositions: envNum('PAPER_MAX_OPEN_POSITIONS', CEILINGS.maxOpenPositions),
    maxTradesPerDay:  envNum('PAPER_MAX_TRADES_PER_DAY', CEILINGS.maxTradesPerDay),
    minOrderValue:    CEILINGS.minOrderValue,
  }
}

/** THE KILL SWITCH. Default-off: absent env ⇒ disabled. */
function isEnabled() {
  return process.env.PAPER_TRADING_ENABLED === 'true'
}

// ── Portfolio math (pure) ─────────────────────────────────────────────────────

function emptyPortfolio(cash = STARTING_CASH) {
  return { cash, positions: {}, startedAt: new Date().toISOString(), startingCash: cash }
}

/** Mark-to-market equity given a price map. Positions without a price are held at cost. */
function equity(portfolio, priceMap = {}) {
  let total = portfolio?.cash ?? 0
  for (const [sym, pos] of Object.entries(portfolio?.positions || {})) {
    const px = priceMap[sym] ?? pos.avgCost
    total += pos.shares * px
  }
  return +total.toFixed(2)
}

/** Per-position detail with unrealized P&L. */
function positionsView(portfolio, priceMap = {}) {
  return Object.entries(portfolio?.positions || {}).map(([symbol, pos]) => {
    const price    = priceMap[symbol] ?? null
    const mark     = price ?? pos.avgCost
    const value    = +(pos.shares * mark).toFixed(2)
    const cost     = +(pos.shares * pos.avgCost).toFixed(2)
    return {
      symbol,
      shares:      +pos.shares.toFixed(6),
      avgCost:     +pos.avgCost.toFixed(4),
      price,
      marketValue: value,
      costBasis:   cost,
      unrealized:  +(value - cost).toFixed(2),
      unrealizedPct: cost > 0 ? +(((value - cost) / cost) * 100).toFixed(2) : null,
      openedAt:    pos.openedAt ?? null,
      priced:      price != null,
    }
  }).sort((a, b) => b.marketValue - a.marketValue)
}

/** Trades executed today (UTC date), for the daily cap. */
function tradesToday(trades, now = new Date()) {
  const day = now.toISOString().slice(0, 10)
  return (trades || []).filter(t => t.status === 'filled' && String(t.at || '').slice(0, 10) === day).length
}

/**
 * Decide whether an order may execute, and for how many shares.
 * PURE — no I/O, no randomness. This is the whole safety boundary, so it
 * returns an explicit reason for every rejection (logged to the audit trail).
 *
 * @returns {{ ok: boolean, reason?: string, shares?: number, value?: number }}
 */
function evaluateOrder({ portfolio, trades = [], symbol, side, price, priceMap = {}, now = new Date(), lim = null }) {
  const L = lim || limits()
  const sym = String(symbol || '').toUpperCase()

  if (!sym)                        return { ok: false, reason: 'missing symbol' }
  if (side !== 'buy' && side !== 'sell') return { ok: false, reason: `invalid side: ${side}` }
  if (!(price > 0))                return { ok: false, reason: 'no valid price' }

  const eq  = equity(portfolio, { ...priceMap, [sym]: price })
  const pos = portfolio?.positions?.[sym] || null

  if (tradesToday(trades, now) >= L.maxTradesPerDay)
    return { ok: false, reason: `daily trade limit reached (${L.maxTradesPerDay})` }

  if (side === 'sell') {
    // NO SHORTING: you can only sell what you hold.
    if (!pos || pos.shares <= 0) return { ok: false, reason: 'no position to sell' }
    return { ok: true, shares: pos.shares, value: +(pos.shares * price).toFixed(2) }
  }

  // ── buy ────────────────────────────────────────────────────────────────────
  const openCount = Object.keys(portfolio?.positions || {}).length
  if (!pos && openCount >= L.maxOpenPositions)
    return { ok: false, reason: `max open positions reached (${L.maxOpenPositions})` }

  const currentValue = pos ? pos.shares * price : 0
  const capValue     = eq * (L.maxPositionPct / 100)
  const room         = capValue - currentValue
  if (room <= 0)
    return { ok: false, reason: `position already at max ${L.maxPositionPct}% of equity` }

  // NO LEVERAGE: never spend more cash than is actually held.
  const spend = Math.min(room, portfolio?.cash ?? 0)
  if (spend < L.minOrderValue)
    return { ok: false, reason: spend <= 0 ? 'insufficient cash' : `order below minimum $${L.minOrderValue}` }

  const shares = Math.floor((spend / price) * 1e6) / 1e6   // fractional, 6dp
  if (!(shares > 0)) return { ok: false, reason: 'computed zero shares' }

  return { ok: true, shares, value: +(shares * price).toFixed(2) }
}

/**
 * Apply an APPROVED order to a portfolio. Pure — returns a new portfolio plus
 * the trade record. Assumes evaluateOrder() already passed.
 */
function applyOrder(portfolio, { symbol, side, price, shares, at = null, reason = null, source = null }) {
  const sym  = symbol.toUpperCase()
  const ts   = at || new Date().toISOString()
  const next = { ...portfolio, positions: { ...portfolio.positions } }
  const pos  = next.positions[sym]
  let realized = null

  if (side === 'buy') {
    const cost = shares * price
    next.cash = +(next.cash - cost).toFixed(6)
    next.positions[sym] = pos
      ? {
          shares:   pos.shares + shares,
          avgCost:  (pos.avgCost * pos.shares + price * shares) / (pos.shares + shares),
          openedAt: pos.openedAt,
        }
      : { shares, avgCost: price, openedAt: ts }
  } else {
    const proceeds = shares * price
    realized = +((price - pos.avgCost) * shares).toFixed(2)
    next.cash = +(next.cash + proceeds).toFixed(6)
    const left = pos.shares - shares
    if (left <= 1e-9) delete next.positions[sym]
    else next.positions[sym] = { ...pos, shares: left }
  }

  const trade = {
    at: ts, symbol: sym, side, price: +price.toFixed(4), shares: +shares.toFixed(6),
    value: +(shares * price).toFixed(2), status: 'filled',
    realized, reason: reason || null, source: source || null,
    cashAfter: +next.cash.toFixed(2),
  }
  return { portfolio: next, trade }
}

/** Realized + unrealized performance summary. */
function performance(portfolio, trades, priceMap = {}) {
  const eq       = equity(portfolio, priceMap)
  const start    = portfolio?.startingCash ?? STARTING_CASH
  const filled   = (trades || []).filter(t => t.status === 'filled')
  const closed   = filled.filter(t => t.side === 'sell' && typeof t.realized === 'number')
  const wins     = closed.filter(t => t.realized > 0)
  const realized = closed.reduce((s, t) => s + t.realized, 0)
  return {
    equity:        eq,
    cash:          +(portfolio?.cash ?? 0).toFixed(2),
    startingCash:  start,
    totalReturnPct: start > 0 ? +(((eq - start) / start) * 100).toFixed(2) : null,
    realizedPnl:   +realized.toFixed(2),
    openPositions: Object.keys(portfolio?.positions || {}).length,
    totalTrades:   filled.length,
    closedTrades:  closed.length,
    winRate:       closed.length ? +(wins.length / closed.length).toFixed(3) : null,
    rejectedOrders: (trades || []).filter(t => t.status === 'rejected').length,
  }
}

// ── File I/O ──────────────────────────────────────────────────────────────────

function ensureDir(file) {
  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function loadPortfolio(file = PORTFOLIO_FILE) {
  try {
    if (!fs.existsSync(file)) return emptyPortfolio()
    const p = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!p || typeof p.cash !== 'number') return emptyPortfolio()
    return { ...emptyPortfolio(), ...p, positions: p.positions || {} }
  } catch { return emptyPortfolio() }
}

function savePortfolio(portfolio, file = PORTFOLIO_FILE) {
  try {
    ensureDir(file)
    fs.writeFileSync(file, JSON.stringify(portfolio, null, 2))
    return true
  } catch (e) { console.warn('[paper-broker] savePortfolio failed:', e.message); return false }
}

function loadTrades(file = TRADES_LOG) {
  try {
    if (!fs.existsSync(file)) return []
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

function appendTrade(trade, file = TRADES_LOG) {
  try {
    ensureDir(file)
    fs.appendFileSync(file, JSON.stringify(trade) + '\n')
    return true
  } catch (e) { console.warn('[paper-broker] appendTrade failed:', e.message); return false }
}

/**
 * Execute one order end-to-end against persisted state.
 * REJECTIONS ARE RECORDED TOO — a system with write access must leave an audit
 * trail of what it tried to do, not only what it was allowed to do.
 */
function execute({ symbol, side, price, priceMap = {}, reason = null, source = null, now = new Date() }) {
  if (!isEnabled()) {
    return { ok: false, reason: 'paper trading disabled (PAPER_TRADING_ENABLED is not "true")', killSwitch: true }
  }
  const portfolio = loadPortfolio()
  const trades    = loadTrades()
  const verdict   = evaluateOrder({ portfolio, trades, symbol, side, price, priceMap, now })

  if (!verdict.ok) {
    appendTrade({
      at: now.toISOString(), symbol: String(symbol || '').toUpperCase(), side,
      price: price != null ? +Number(price).toFixed(4) : null,
      status: 'rejected', rejectReason: verdict.reason, reason, source,
    })
    return { ok: false, reason: verdict.reason }
  }

  const { portfolio: next, trade } = applyOrder(portfolio, {
    symbol, side, price, shares: verdict.shares, at: now.toISOString(), reason, source,
  })
  savePortfolio(next)
  appendTrade(trade)
  return { ok: true, trade, portfolio: next }
}

/** Current state for the API/UI. */
function snapshot(priceMap = {}) {
  const portfolio = loadPortfolio()
  const trades    = loadTrades()
  return {
    enabled:     isEnabled(),
    limits:      limits(),
    performance: performance(portfolio, trades, priceMap),
    positions:   positionsView(portfolio, priceMap),
    startedAt:   portfolio.startedAt ?? null,
  }
}

/** Reset to a flat book. Explicit operator action only. */
function reset(cash = STARTING_CASH) {
  const p = emptyPortfolio(cash)
  savePortfolio(p)
  appendTrade({ at: new Date().toISOString(), status: 'reset', cash, symbol: null, side: null })
  return p
}

module.exports = {
  PORTFOLIO_FILE, TRADES_LOG, STARTING_CASH, CEILINGS,
  // pure
  emptyPortfolio, equity, positionsView, tradesToday, evaluateOrder, applyOrder, performance,
  // config / io
  isEnabled, limits, loadPortfolio, savePortfolio, loadTrades, appendTrade,
  execute, snapshot, reset,
}
