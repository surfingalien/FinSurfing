'use strict'
/**
 * AI Advisory Engine — the measured half (server side).
 *
 * The engine itself (src/services/aiEngine.js) runs in the browser: five
 * hand-weighted factor scores (technical 35%, fundamentals 20%, news 15%,
 * analysts 15%, multi-timeframe 15%) mapped to a signal by fixed thresholds.
 * Before this module nothing about it was measured:
 *   - its "confidence %" was base 50 adjusted by how many factors agreed,
 *     clamped to 22–94 — a number that looked like a probability and was not;
 *   - its "signal backtest" tested a DIFFERENT rule (RSI < 45 and MACD above
 *     signal) in-sample, on overlapping windows, with no costs, and called ≥60%
 *     of ≥5 trades "High accuracy";
 *   - its signals were never recorded, so nobody could ever learn whether a
 *     STRONG BUY from it meant anything.
 *
 * This module supplies the parts that can be measured, in code:
 *   1. `priceRuleAt` — the engine's OWN rule restricted to what has
 *      point-in-time history: the technical score and the daily-timeframe
 *      score, with fundamentals / news / analysts held neutral at 5. The same
 *      indicator formulas as the browser (ported from src/services/api.js),
 *      each reading only bars ≤ i.
 *   2. `walkForward` — that rule tested walk-forward: non-overlapping windows,
 *      entry at the NEXT session's open, exit `horizon` sessions later, net of
 *      the asset class's round-trip cost, against the base rate of the same
 *      windows (how often ANY entry would have been right). A hit rate means
 *      nothing without the base rate: in a rising market most buys "win".
 *   3. `decisionFromSignal` — what a browser signal claims, for the shared
 *      learning store (surface 'advisory-engine'), so every signal is scored
 *      against real prices later and calibration is measured, not asserted.
 *
 * Pure. Tests: tests/advisory-engine.test.js
 */

const { wilson } = require('./calibration-stats')

// ── Indicators — the browser's formulas (src/services/api.js), causal ───────
const r4 = v => +v.toFixed(4)

function sma(closes, period) {
  const out = new Array(closes.length).fill(null)
  let sum = 0
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i]
    if (i >= period) sum -= closes[i - period]
    if (i >= period - 1) out[i] = r4(sum / period)
  }
  return out
}

function ema(values, period) {
  const k = 2 / (period + 1), out = new Array(values.length).fill(null)
  if (!values.length) return out
  let e = values[0]; out[0] = e
  for (let i = 1; i < values.length; i++) { e = values[i] * k + e * (1 - k); out[i] = r4(e) }
  return out
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null)
  if (closes.length <= period) return out
  let g = 0, l = 0
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d }
  let ag = g / period, al = l / period
  out[period] = al === 0 ? 100 : +(100 - 100 / (1 + ag / al)).toFixed(2)
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    ag = (ag * (period - 1) + Math.max(0, d)) / period
    al = (al * (period - 1) + Math.max(0, -d)) / period
    out[i] = al === 0 ? 100 : +(100 - 100 / (1 + ag / al)).toFixed(2)
  }
  return out
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  const f = ema(closes, fast), s = ema(closes, slow)
  const line = closes.map((_, i) => r4(f[i] - s[i]))
  const sig = ema(line, signal)
  return line.map((m, i) => ({ macd: m, signal: sig[i], hist: r4(m - sig[i]) }))
}

function bollinger(closes, period = 20, k = 2) {
  const mid = sma(closes, period)
  return closes.map((_, i) => {
    if (mid[i] == null) return { upper: null, lower: null }
    let v = 0
    for (let j = i - period + 1; j <= i; j++) v += (closes[j] - mid[i]) ** 2
    const sd = Math.sqrt(v / period)
    return { upper: r4(mid[i] + k * sd), lower: r4(mid[i] - k * sd) }
  })
}

/** Every series the rule needs, computed once (each value reads bars ≤ its index). */
function series(closes) {
  return { rsi: rsi(closes), macd: macd(closes), bb: bollinger(closes), s20: sma(closes, 20), s50: sma(closes, 50) }
}

const clamp10 = v => Math.min(10, Math.max(0, v))

/** The browser's technical score at bar i (aiEngine.js: generateAIAdvisory, "1. Technical"). */
function techScoreAt(closes, S, i) {
  const price = closes[i], r = S.rsi[i], m = S.macd[i], b = S.bb[i], s20 = S.s20[i], s50 = S.s50[i]
  let t = 5
  if (r != null) {
    if (r < 30) t += 2.5
    else if (r < 45) t += 1.0
    else if (r > 70) t -= 2.5
    else if (r > 58) t -= 0.5
  }
  if (m?.macd != null && m.signal != null) {
    t += m.macd > m.signal ? 1.0 : -1.0
    if (m.hist != null) t += m.hist > 0 ? 0.5 : -0.5
  }
  if (b?.lower != null && b.upper != null && b.upper > b.lower) {
    const pos = (price - b.lower) / (b.upper - b.lower)
    if (pos < 0.2) t += 1.0
    else if (pos > 0.85) t -= 1.0
  }
  if (s20 != null && s50 != null) {
    if (price > s20 && s20 > s50) t += 1.0
    else if (price < s20 && s20 < s50) t -= 1.0
  }
  return clamp10(t)
}

/** The browser's daily-timeframe score at bar i (aiEngine.js: scoreMultiTimeframe, daily leg only). */
function dailyTimeframeAt(closes, S, i) {
  const price = closes[i], r = S.rsi[i], m = S.macd[i], s20 = S.s20[i], s50 = S.s50[i]
  let s = 0
  if (r != null) s += r < 50 ? 1 : r > 65 ? -1 : 0
  if (m?.macd != null && m.signal != null) s += m.macd > m.signal ? 1 : -1
  if (s20 != null && price > s20) s += 0.5
  if (s50 != null && price > s50) s += 0.5
  if (s20 != null && s50 != null && s20 > s50) s += 0.5
  return clamp10(5 + s * 1.5)
}

// The browser's thresholds (aiEngine.js: classifySignal)
const WEIGHTS = { tech: 0.35, fund: 0.20, sentiment: 0.15, analyst: 0.15, mtf: 0.15 }
function signalOf(ensemble) {
  if (ensemble >= 7.5) return 'STRONG_BUY'
  if (ensemble >= 6.0) return 'BUY'
  if (ensemble >= 4.5) return 'WATCHLIST'
  if (ensemble >= 3.5) return 'HOLD'
  return 'SELL'
}

/** The engine's rule on price alone at bar i: the non-price factors held neutral at 5. */
function priceRuleAt(closes, S, i) {
  const tech = techScoreAt(closes, S, i), mtf = dailyTimeframeAt(closes, S, i)
  const ensemble = tech * WEIGHTS.tech + mtf * WEIGHTS.mtf + 5 * (WEIGHTS.fund + WEIGHTS.sentiment + WEIGHTS.analyst)
  return { tech, mtf, ensemble: +ensemble.toFixed(3), signal: signalOf(ensemble) }
}

const WARMUP = 60          // RSI/MACD/SMA50 settle
const MIN_TRADES = 10

function verdictFor(k, n, base) {
  if (n < MIN_TRADES) return { verdict: 'insufficient', text: `${n} signal${n === 1 ? '' : 's'} — fewer than ${MIN_TRADES}, too few to judge` }
  const w = wilson(k, n)
  if (w.lo > base) return { verdict: 'beats-base-rate', text: 'right more often than an entry on any day in the same period' }
  if (w.hi < base) return { verdict: 'worse-than-base-rate', text: 'right LESS often than an entry on any day in the same period' }
  return { verdict: 'no-measured-difference', text: 'not distinguishable from an entry on any day in the same period' }
}

/**
 * Walk-forward test of the price-only rule.
 * @param {Array<{t,o?,c}>} bars  daily bars, oldest first
 * @param {object} [o]
 * @param {number} [o.horizon=20]   sessions held
 * @param {number} [o.costBps=10]   round trip
 * @returns {object|null} null when the history is too short to test at all
 */
function walkForward(bars, { horizon = 20, costBps = 10 } = {}) {
  const b = (bars || []).filter(x => x && x.c > 0)
  if (b.length < WARMUP + horizon + 2) return null
  const closes = b.map(x => x.c), S = series(closes), cost = costBps / 1e4
  const windows = []
  // Non-overlapping: one decision every `horizon` sessions, so no outcome is counted twice.
  for (let i = WARMUP; i + horizon < b.length; i += horizon) {
    const entryBar = b[i + 1], exitBar = b[i + horizon]
    const entry = entryBar.o > 0 ? entryBar.o : entryBar.c           // next session's open — never the signal bar's close
    const ret = exitBar.c / entry - 1 - cost
    windows.push({ i, ...priceRuleAt(closes, S, i), ret })
  }
  const n = windows.length
  const upAll = windows.filter(w => w.ret > 0).length
  const baseUp = n ? upAll / n : null
  const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null)
  const side = (pick, correct, base) => {
    const sel = windows.filter(pick), k = sel.filter(correct).length
    const w = sel.length ? wilson(k, sel.length) : { lo: null, hi: null }
    return {
      signals: sel.length, hits: k,
      hitRate: sel.length ? +(k / sel.length).toFixed(3) : null, hitRateLo: w.lo, hitRateHi: w.hi,
      avgReturnPct: sel.length ? +(mean(sel.map(x => x.ret)) * 100).toFixed(2) : null,
      baseRate: base == null ? null : +base.toFixed(3),
      ...verdictFor(k, sel.length, base),
    }
  }
  return {
    rule: 'price-only version of the engine: technical score (35%) + daily timeframe (15%), fundamentals / news / analysts held neutral',
    windows: n, horizon, costBps,
    from: b[WARMUP].t ? new Date(b[WARMUP].t).toISOString().slice(0, 10) : null,
    to:   b[b.length - 1].t ? new Date(b[b.length - 1].t).toISOString().slice(0, 10) : null,
    avgReturnAllPct: n ? +(mean(windows.map(w => w.ret)) * 100).toFixed(2) : null,
    buy:  side(w => w.signal === 'BUY' || w.signal === 'STRONG_BUY', w => w.ret > 0, baseUp),
    sell: side(w => w.signal === 'SELL', w => w.ret < 0, baseUp == null ? null : 1 - baseUp),
    caveat: 'Entry at the next session\'s open, exit at the close ' + horizon + ' sessions later, net of a ' + costBps + 'bp round trip, one decision per window (no overlap). The fundamentals, news and analyst factors have no point-in-time history here, so the full five-factor signal cannot be backtested — it is scored going forward instead.',
  }
}

// ── Recording a browser signal ──────────────────────────────────────────────
const SIGNAL_ACTION = { STRONG_BUY: 'buy', BUY: 'buy', SELL: 'sell', STOP_TRIGGER: 'reduce', PROFIT_BOOK: 'reduce' }
const SIGNALS = ['STRONG_BUY', 'BUY', 'WATCHLIST', 'HOLD', 'SELL', 'STOP_TRIGGER', 'PROFIT_BOOK']

/**
 * What a browser signal claims, as a learning-store decision — or null when it
 * makes no directional claim (WATCHLIST / HOLD) or is malformed. The PRICE is
 * the server's, never the browser's.
 */
function decisionFromSignal({ symbol, signal, ensembleScore = null, factors = null }, { price, userId = null, priceAsOf = null } = {}) {
  const sym = String(symbol || '').toUpperCase().replace(/[^A-Z0-9.^=-]/g, '').slice(0, 15)
  const action = SIGNAL_ACTION[signal]
  if (!sym || !action || !(Number(price) > 0)) return null
  const num = v => (Number.isFinite(Number(v)) ? +Number(v).toFixed(2) : null)
  const f = factors && typeof factors === 'object' ? factors : {}
  return {
    surface: 'advisory-engine', symbol: sym, action, price: Number(price),
    meta: {
      signal, ensembleScore: num(ensembleScore), userId, priceAsOf,
      factors: { tech: num(f.tech), fund: num(f.fund), sentiment: num(f.sentiment), analyst: num(f.analyst), mtf: num(f.mtf) },
    },
  }
}

/** Measured calibration of the engine's signals from the learning store, overall and per signal type. */
function engineCalibration(decisions, calibrate, { minSample = 8 } = {}) {
  const rows = (decisions || []).filter(d => d?.surface === 'advisory-engine')
  const resolved = rows.filter(d => d?.outcome?.retPct != null)
  const bySignal = {}
  for (const s of SIGNALS) {
    const sel = rows.filter(d => d?.meta?.signal === s)
    if (sel.length) bySignal[s] = { recorded: sel.length, ...calibrate(sel, { minSample }) }
  }
  return {
    recorded: rows.length, resolved: resolved.length, minSample,
    overall: calibrate(rows, { minSample }),
    bySignal,
  }
}

// ── The Advisory page's rule-based personas ─────────────────────────────────
// src/components/Recommendations/AdvisoryView.jsx scores a symbol for five
// personas with hand-set weights and turns each score into Buy / Overweight /
// Hold / Underweight / Sell. Nothing measured those calls. Each directional
// call is recorded here (surface 'persona-rules', the persona in meta.ruleSet so
// it never pools with the AI Advisory personas in byPersona) and scored like
// every other decision; the page shows each persona's measured record.
const PERSONA_IDS = ['growth', 'value', 'momentum', 'defensive', 'esg']
const PERSONA_ACTION = { Buy: 'buy', Overweight: 'buy', Sell: 'sell', Underweight: 'reduce' }

function decisionFromPersona({ symbol, persona, action, score = null, missing = null }, { price, userId = null, priceAsOf = null } = {}) {
  const sym = String(symbol || '').toUpperCase().replace(/[^A-Z0-9.^=-]/g, '').slice(0, 15)
  const act = PERSONA_ACTION[action]
  if (!sym || !PERSONA_IDS.includes(persona) || !act || !(Number(price) > 0)) return null
  const sc = Number(score)
  return {
    surface: 'persona-rules', symbol: sym, action: act, price: Number(price),
    meta: {
      ruleSet: persona, call: action, score: Number.isFinite(sc) ? Math.round(sc) : null, userId, priceAsOf,
      missing: Array.isArray(missing) ? missing.filter(m => typeof m === 'string').slice(0, 8) : null,
    },
  }
}

/** Each persona's measured record: its long calls (Buy/Overweight) and its short-side calls (Sell/Underweight). */
function personaCalibration(decisions, calibrate, { minSample = 8 } = {}) {
  const rows = (decisions || []).filter(d => d?.surface === 'persona-rules')
  const out = {}
  for (const id of PERSONA_IDS) {
    const mine = rows.filter(d => d?.meta?.ruleSet === id)
    const longs = mine.filter(d => d.action === 'buy'), shorts = mine.filter(d => d.action !== 'buy')
    out[id] = {
      recorded: mine.length,
      long:  { recorded: longs.length,  ...calibrate(longs,  { minSample }) },
      short: { recorded: shorts.length, ...calibrate(shorts, { minSample }) },
    }
  }
  return { recorded: rows.length, minSample, byPersona: out }
}

module.exports = {
  sma, ema, rsi, macd, bollinger, series, techScoreAt, dailyTimeframeAt, priceRuleAt, signalOf,
  walkForward, decisionFromSignal, engineCalibration, SIGNALS, SIGNAL_ACTION, WEIGHTS, MIN_TRADES,
  decisionFromPersona, personaCalibration, PERSONA_IDS, PERSONA_ACTION,
}
