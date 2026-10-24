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
 *   4. NO POSITION WITHOUT AN EXIT — every buy carries a BRACKET from the
 *      pick's trade plan (stop, T1, T2, time limit) and is sized so the stop
 *      costs ≤ riskPerTradePct of equity and an average day (ATR) moves it
 *      ≤ dailyVolPct. `bracketExits()` enforces the bracket mechanically:
 *      stop → sell all; T2 → sell all; T1 → sell half and move the stop to
 *      breakeven; time limit → sell all. A six-month study of live LLM trading
 *      fleets found 49% of positions that ran +3% in their favour still closed
 *      at a loss, and sizing flat across volatility; this is the fix for both,
 *      and exits are tagged by kind so `performance()` measures it.
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
const atomic = require('./atomic-write')
const path = require('path')

const DATA_DIR       = require('./data-dir').DATA_DIR
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
  riskPerTradePct:  1,    // % of equity a stop-out may cost
  dailyVolPct:      0.25, // % of equity an average day (ATR) may move one position
  maxHoldDays:      30,   // time exit — the same horizon picks are scored on
}

// Protections — pause NEW buys after damage (freqtrade's "protections" idea).
// Exits are never blocked. Env may only tighten: a count or a drawdown limit
// may go down, a lookback or a pause may go up.
const PROTECTIONS = {
  stoplossLimit:         3,    // stop-outs in the lookback that pause ALL buys
  stoplossLookbackDays:  7,
  stoplossPauseDays:     2,
  maxDrawdownPct:        8,    // realized-equity drawdown over the lookback that pauses all buys
  drawdownLookbackDays:  30,
  drawdownPauseDays:     3,
  cooldownDays:          2,    // no re-entry into a symbol this soon after leaving it
  lowProfitMinTrades:    2,    // a symbol that lost money over this many closed trades …
  lowProfitLookbackDays: 30,
  lowProfitPauseDays:    7,    // … is blocked this long
}
const STRICTER_IS_LOWER = new Set(['stoplossLimit', 'maxDrawdownPct', 'lowProfitMinTrades'])

function protectionLimits() {
  const out = {}
  for (const [k, base] of Object.entries(PROTECTIONS)) {
    const raw = Number(process.env[`PAPER_${k.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`])
    out[k] = !Number.isFinite(raw) || raw <= 0 ? base : STRICTER_IS_LOWER.has(k) ? Math.min(raw, base) : Math.max(raw, base)
  }
  return out
}

/**
 * Which pauses are active now, from the trade log. Pure.
 * @returns {{ global: {kind, reason, until}|null, symbols: Object<string,{kind, reason, until}> }}
 */
function protections(trades = [], portfolio = null, now = new Date(), P = protectionLimits()) {
  const t0 = now.getTime(), DAY = 86_400_000
  const within = (t, d) => t0 - Date.parse(t.at) <= d * DAY
  const until = (t, d) => new Date(Date.parse(t.at) + d * DAY).toISOString()
  const sells = (trades || []).filter(t => t.status === 'filled' && t.side === 'sell' && t.at && Date.parse(t.at) <= t0)
  const live = lock => lock && Date.parse(lock.until) > t0 ? lock : null
  let global = null

  const stops = sells.filter(t => t.exitKind === 'stop' && within(t, P.stoplossLookbackDays))
  if (stops.length >= P.stoplossLimit) {
    global = live({ kind: 'stoploss-guard', reason: `${stops.length} stop-outs in ${P.stoplossLookbackDays} days`, until: until(stops.at(-1), P.stoplossPauseDays) })
  }

  if (!global) {
    // Drawdown of the REALIZED equity curve over the lookback — open positions
    // are marked by the hourly manager, not here, so this sees closed damage only.
    const start = portfolio?.startingCash ?? STARTING_CASH
    const before = sells.filter(t => !within(t, P.drawdownLookbackDays) && typeof t.realized === 'number').reduce((a, t) => a + t.realized, 0)
    const recent = sells.filter(t => within(t, P.drawdownLookbackDays) && typeof t.realized === 'number')
    let eq = start + before, peak = eq, worst = 0, at = null
    for (const t of recent) {
      eq += t.realized
      peak = Math.max(peak, eq)
      const dd = peak > 0 ? (peak - eq) / peak * 100 : 0
      if (dd > worst) { worst = dd; at = t }
    }
    if (worst > P.maxDrawdownPct) {
      global = live({ kind: 'max-drawdown', reason: `realized drawdown ${worst.toFixed(1)}% in ${P.drawdownLookbackDays} days (limit ${P.maxDrawdownPct}%)`, until: until(recent.at(-1), P.drawdownPauseDays) })
    }
  }

  const symbols = {}
  const bySym = new Map()
  for (const t of sells) { if (!bySym.has(t.symbol)) bySym.set(t.symbol, []); bySym.get(t.symbol).push(t) }
  for (const [sym, list] of bySym) {
    const last = list.at(-1)
    const recent = list.filter(t => within(t, P.lowProfitLookbackDays) && typeof t.realized === 'number')
    const net = recent.reduce((a, t) => a + t.realized, 0)
    const lowProfit = recent.length >= P.lowProfitMinTrades && net < 0
      ? live({ kind: 'low-profit', reason: `lost $${Math.abs(net).toFixed(2)} over its last ${recent.length} closed trades`, until: until(last, P.lowProfitPauseDays) })
      : null
    const cooldown = live({ kind: 'cooldown', reason: `exited ${new Date(last.at).toISOString().slice(0, 10)} — cooling down ${P.cooldownDays} days`, until: until(last, P.cooldownDays) })
    const lock = [lowProfit, cooldown].filter(Boolean).sort((a, b) => b.until.localeCompare(a.until))[0]
    if (lock) symbols[sym] = lock
  }
  return { global, symbols }
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
    riskPerTradePct:  envNum('PAPER_RISK_PER_TRADE_PCT', CEILINGS.riskPerTradePct),
    dailyVolPct:      envNum('PAPER_DAILY_VOL_PCT',      CEILINGS.dailyVolPct),
    maxHoldDays:      envNum('PAPER_MAX_HOLD_DAYS',      CEILINGS.maxHoldDays),
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
function evaluateOrder({ portfolio, trades = [], symbol, side, price, priceMap = {}, now = new Date(), lim = null, fraction = 1, bracket = null, atrPct = null, exit = false }) {
  // A partial `lim` (tests, callers) takes the defaults for what it leaves out.
  const L = { ...limits(), ...(lim || {}) }
  const sym = String(symbol || '').toUpperCase()

  if (!sym)                        return { ok: false, reason: 'missing symbol' }
  if (side !== 'buy' && side !== 'sell') return { ok: false, reason: `invalid side: ${side}` }
  if (!(price > 0))                return { ok: false, reason: 'no valid price' }

  const eq  = equity(portfolio, { ...priceMap, [sym]: price })
  const pos = portfolio?.positions?.[sym] || null

  // A bracket exit is risk REDUCTION — the daily cap exists to stop the model
  // churning into positions, and must never be what keeps a stop from firing.
  if (!exit && tradesToday(trades, now) >= L.maxTradesPerDay)
    return { ok: false, reason: `daily trade limit reached (${L.maxTradesPerDay})` }

  if (side === 'sell') {
    // NO SHORTING: you can only sell what you hold.
    if (!pos || pos.shares <= 0) return { ok: false, reason: 'no position to sell' }
    const f = Number(fraction) > 0 && Number(fraction) < 1 ? Number(fraction) : 1
    const shares = f === 1 ? pos.shares : Math.floor(pos.shares * f * 1e6) / 1e6
    if (!(shares > 0)) return { ok: false, reason: 'computed zero shares' }
    return { ok: true, shares, value: +(shares * price).toFixed(2) }
  }

  // PROTECTIONS: recent damage pauses new buys (never exits — those returned above).
  const prot = protections(trades, portfolio, now, { ...protectionLimits(), ...(lim?.protections || {}) })
  if (prot.global) return { ok: false, reason: `buys paused (${prot.global.kind}): ${prot.global.reason}, until ${prot.global.until.slice(0, 16)}Z`, protection: prot.global }
  if (prot.symbols[sym]) return { ok: false, reason: `${sym} paused (${prot.symbols[sym].kind}): ${prot.symbols[sym].reason}, until ${prot.symbols[sym].until.slice(0, 16)}Z`, protection: prot.symbols[sym] }

  // NO POSITION WITHOUT AN EXIT.
  const b = validBracket(bracket, price)
  if (!b.ok) return { ok: false, reason: b.reason }

  // ── buy ────────────────────────────────────────────────────────────────────
  const openCount = Object.keys(portfolio?.positions || {}).length
  if (!pos && openCount >= L.maxOpenPositions)
    return { ok: false, reason: `max open positions reached (${L.maxOpenPositions})` }

  const currentValue = pos ? pos.shares * price : 0
  // Size ceilings: the % cap, the stop-out cap and the volatility cap — the
  // tightest one binds, so a wide stop or a jumpy name means a smaller order.
  const stopDist = (price - b.bracket.stop) / price
  const caps = [
    ['max position', eq * (L.maxPositionPct / 100)],
    ['stop-out risk', eq * (L.riskPerTradePct / 100) / stopDist],
    ...(Number(atrPct) > 0 ? [['volatility', eq * (L.dailyVolPct / 100) / (Number(atrPct) / 100)]] : []),
  ]
  const [limitedBy, capValue] = caps.reduce((a, c) => (c[1] < a[1] ? c : a))
  const room         = capValue - currentValue
  if (room <= 0)
    return { ok: false, reason: `position already at its ${limitedBy} cap ($${capValue.toFixed(0)})` }

  // NO LEVERAGE: never spend more cash than is actually held.
  const spend = Math.min(room, portfolio?.cash ?? 0)
  if (spend < L.minOrderValue)
    return { ok: false, reason: spend <= 0 ? 'insufficient cash' : `order below minimum $${L.minOrderValue}` }

  const shares = Math.floor((spend / price) * 1e6) / 1e6   // fractional, 6dp
  if (!(shares > 0)) return { ok: false, reason: 'computed zero shares' }

  return { ok: true, shares, value: +(shares * price).toFixed(2), limitedBy, bracket: b.bracket }
}

/**
 * A bracket must put the stop below the price and the targets above it, in
 * order. Returns the normalised bracket or why it was refused. Pure.
 */
function validBracket(bracket, price) {
  if (!bracket) return { ok: false, reason: 'no trade plan — a position is never opened without a stop' }
  const stop = Number(bracket.stop), t1 = Number(bracket.t1), t2 = Number(bracket.t2)
  if (!(stop > 0 && stop < price)) return { ok: false, reason: `stop ${bracket.stop} is not below the price ${price}` }
  if (!(t2 > price)) return { ok: false, reason: `target ${bracket.t2} is not above the price ${price}` }
  const firstT = t1 > price && t1 < t2 ? t1 : null
  return { ok: true, bracket: { stop, t1: firstT, t2, t1Done: firstT == null } }
}

/**
 * Which held positions must exit now, given current prices. Pure. Checked in
 * order — stop first (if a bar is ambiguous, assume the loss, the same stance
 * as the triple-barrier label), then the final target, then T1, then time.
 * Positions opened before brackets existed are reported, never touched.
 * @returns {{ exits: Array<{symbol, kind, fraction, price}>, unmanaged: string[] }}
 */
function bracketExits(portfolio, priceMap = {}, { now = new Date(), lim = null } = {}) {
  const L = { ...limits(), ...(lim || {}) }
  const exits = [], unmanaged = []
  for (const [symbol, pos] of Object.entries(portfolio?.positions || {})) {
    const px = Number(priceMap[symbol])
    if (!pos.bracket) { unmanaged.push(symbol); continue }
    if (!(px > 0)) continue
    const b = pos.bracket
    // The time limit runs from when the bracket was set — an adopted bracket
    // on an old position must not fire a time exit the moment it exists.
    const since = b.since || pos.openedAt
    const ageDays = since ? (now - new Date(since)) / 86_400_000 : 0
    if (px <= b.stop)                     exits.push({ symbol, kind: b.t1Done && b.stop >= pos.avgCost ? 'breakeven-stop' : 'stop', fraction: 1, price: px })
    else if (px >= b.t2)                  exits.push({ symbol, kind: 'target', fraction: 1, price: px })
    else if (!b.t1Done && b.t1 && px >= b.t1) exits.push({ symbol, kind: 't1', fraction: 0.5, price: px })
    else if (ageDays >= L.maxHoldDays)    exits.push({ symbol, kind: 'time', fraction: 1, price: px })
  }
  return { exits, unmanaged }
}

/** Open positions with no bracket — opened before brackets existed. Pure. */
function unmanagedPositions(portfolio) {
  return Object.entries(portfolio?.positions || {}).filter(([, p]) => !p.bracket).map(([s]) => s)
}

/**
 * Give an unmanaged position a bracket. Pure — returns { portfolio, ok, reason }.
 * Never replaces an existing bracket; the bracket must be valid against the
 * CURRENT price (a stop above today's price would exit on the next check).
 */
function adoptBracket(portfolio, symbol, bracket, price, now = new Date()) {
  const sym = String(symbol || '').toUpperCase()
  const pos = portfolio?.positions?.[sym]
  if (!pos) return { portfolio, ok: false, reason: 'no such position' }
  if (pos.bracket) return { portfolio, ok: false, reason: 'already has a bracket' }
  const b = validBracket(bracket, price)
  if (!b.ok) return { portfolio, ok: false, reason: b.reason }
  const next = { ...portfolio, positions: { ...portfolio.positions, [sym]: { ...pos, bracket: { ...b.bracket, since: now.toISOString(), adopted: true } } } }
  return { portfolio: next, ok: true, bracket: next.positions[sym].bracket }
}

/**
 * Persisted: adopt brackets for every unmanaged position that has one proposed.
 * `proposals` = { SYMBOL: { bracket, price } }. Audit-logged like every order.
 */
function adoptUnmanaged(proposals = {}, now = new Date()) {
  let portfolio = loadPortfolio()
  const adopted = [], skipped = []
  for (const sym of unmanagedPositions(portfolio)) {
    const p = proposals[sym]
    if (!p) { skipped.push({ symbol: sym, reason: 'no price history to set levels from' }); continue }
    const r = adoptBracket(portfolio, sym, p.bracket, p.price, now)
    if (!r.ok) { skipped.push({ symbol: sym, reason: r.reason }); continue }
    portfolio = r.portfolio
    adopted.push({ symbol: sym, bracket: r.bracket })
    appendTrade({ at: now.toISOString(), symbol: sym, side: null, status: 'bracket-adopted', bracket: r.bracket, price: p.price })
  }
  if (adopted.length) savePortfolio(portfolio)
  return { adopted, skipped }
}

/**
 * Apply an APPROVED order to a portfolio. Pure — returns a new portfolio plus
 * the trade record. Assumes evaluateOrder() already passed.
 */
function applyOrder(portfolio, { symbol, side, price, shares, at = null, reason = null, source = null, bracket = null, exitKind = null }) {
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
          // Adding to a position keeps its original exits.
          ...(pos.bracket || bracket ? { bracket: pos.bracket || bracket } : {}),
        }
      : { shares, avgCost: price, openedAt: ts, ...(bracket ? { bracket } : {}) }
  } else {
    const proceeds = shares * price
    realized = +((price - pos.avgCost) * shares).toFixed(2)
    next.cash = +(next.cash + proceeds).toFixed(6)
    const left = pos.shares - shares
    if (left <= 1e-9) delete next.positions[sym]
    else if (exitKind === 't1' && pos.bracket) {
      // T1 booked: the rest rides with the stop at breakeven, so a winner that
      // reaches T1 can no longer close as a loss.
      next.positions[sym] = { ...pos, shares: left, bracket: { ...pos.bracket, t1Done: true, stop: Math.max(pos.bracket.stop, pos.avgCost) } }
    } else next.positions[sym] = { ...pos, shares: left }
  }

  const trade = {
    at: ts, symbol: sym, side, price: +price.toFixed(4), shares: +shares.toFixed(6),
    value: +(shares * price).toFixed(2), status: 'filled',
    realized, reason: reason || null, source: source || null,
    ...(exitKind ? { exitKind } : {}),
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
    // How positions actually ended — the mechanical bracket, measured.
    exitsByKind: closed.reduce((m, t) => {
      const k = t.exitKind || 'manual'
      const e = m[k] || (m[k] = { n: 0, realized: 0 })
      e.n++; e.realized = +(e.realized + t.realized).toFixed(2)
      return m
    }, {}),
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
    // An unreadable book loads as a fresh $100k one; without the copy-aside in
    // writeJsonAtomic, the first save after that would erase the real book.
    atomic.writeJsonAtomic(file, portfolio)
    return true
  } catch (e) { console.warn('[paper-broker] savePortfolio failed:', e.message); return false }
}

function loadTrades(file = TRADES_LOG) {
  try {
    return atomic.readJsonl(file)
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
function execute({ symbol, side, price, priceMap = {}, reason = null, source = null, now = new Date(), fraction = 1, bracket = null, atrPct = null, exitKind = null }) {
  if (!isEnabled()) {
    return { ok: false, reason: 'paper trading disabled (PAPER_TRADING_ENABLED is not "true")', killSwitch: true }
  }
  const portfolio = loadPortfolio()
  const trades    = loadTrades()
  const verdict   = evaluateOrder({ portfolio, trades, symbol, side, price, priceMap, now, fraction, bracket, atrPct, exit: !!exitKind })

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
    bracket: verdict.bracket ?? null, exitKind,
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
    protections: protections(trades, portfolio),
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
  PORTFOLIO_FILE, TRADES_LOG, STARTING_CASH, CEILINGS, PROTECTIONS,
  // pure
  emptyPortfolio, equity, positionsView, tradesToday, evaluateOrder, applyOrder, performance, validBracket, bracketExits,
  unmanagedPositions, adoptBracket, adoptUnmanaged, protections, protectionLimits,
  // config / io
  isEnabled, limits, loadPortfolio, savePortfolio, loadTrades, appendTrade,
  execute, snapshot, reset,
}
