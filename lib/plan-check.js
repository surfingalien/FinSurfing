'use strict'

/**
 * lib/plan-check.js — one check for every trade plan an agent writes.
 *
 * The AI Brain and Advisory never ship a level the model chose without code
 * checking it (price-coherence, the expected-value gate), and every pick is
 * recorded so it can be scored. The AI Agent, the Agent Hub pipeline and the
 * per-symbol Analyze page wrote entry / target / stop plans that nothing
 * checked — a BUY whose target sat below its entry would ship — and none were
 * recorded, so whether they were any good could never be measured.
 *
 * checkPlan() is pure: direction (long: stop < entry < target; short: the
 * mirror), an entry that is not far from the current price, reward/risk, and
 * the after-cost expected value at the measured win rate (expected-value.js,
 * the same gate Advisory uses). It never repairs a level — code cannot know
 * which side of a contradiction was meant — it says what is wrong.
 *
 * Tests: tests/plan-check.test.js
 */

const { evaluateTrade, normalizeAssetType } = require('./expected-value')

// An entry this far from the live price is not a pullback plan, it is a
// remembered or invented price.
const MAX_ENTRY_OFF_PCT = 25
// Worth saying, not worth rejecting: a limit entry below the market is normal.
const WARN_ENTRY_OFF_PCT = 3

const num = v => {
  const n = typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}
const pct = (a, b) => +((Math.abs(a - b) / b) * 100).toFixed(2)

/**
 * @param {object} o
 * @param {'long'|'short'|null} o.side   null = no trade (neutral / hold)
 * @param {number} o.entry
 * @param {number} o.target
 * @param {number} o.stop
 * @param {number} [o.price]      current price, for the entry sanity check
 * @param {string} [o.assetType]  stock | etf | crypto | fund
 * @param {{p:number, source:string}} [o.winProb]  measured win probability
 */
function checkPlan({ side, entry, target, stop, price = null, assetType = null, winProb = null }) {
  if (side !== 'long' && side !== 'short')
    return { verdict: 'no-trade', ok: true, reasons: ['No directional view, so there is no trade to check.'] }

  const e = num(entry), t = num(target), s = num(stop), px = num(price)
  const missing = [!e && 'entry', !t && 'target', !s && 'stop'].filter(Boolean)
  if (missing.length)
    return { verdict: 'incoherent', ok: false, side, reasons: [`The plan has no ${missing.join(', ')} price.`] }

  const reasons = []
  if (side === 'long') {
    if (!(t > e)) reasons.push(`Target $${t} is not above the entry $${e} on a long.`)
    if (!(s < e)) reasons.push(`Stop $${s} is not below the entry $${e} on a long.`)
  } else {
    if (!(t < e)) reasons.push(`Target $${t} is not below the entry $${e} on a short.`)
    if (!(s > e)) reasons.push(`Stop $${s} is not above the entry $${e} on a short.`)
  }
  const entryOffPct = px ? pct(e, px) : null
  if (entryOffPct != null && entryOffPct > MAX_ENTRY_OFF_PCT)
    reasons.push(`Entry $${e} is ${entryOffPct}% from the current price $${px}.`)
  if (reasons.length) return { verdict: 'incoherent', ok: false, side, entry: e, target: t, stop: s, entryOffPct, reasons }

  const targetReturn = pct(t, e)
  const stopLoss     = pct(s, e)
  const rr           = +(targetReturn / stopLoss).toFixed(2)
  const warnings     = []
  if (entryOffPct != null && entryOffPct > WARN_ENTRY_OFF_PCT)
    warnings.push(`Entry is ${entryOffPct}% from the current price $${px} — it needs the price to get there first.`)

  const p  = winProb && Number.isFinite(winProb.p) ? winProb : { p: 0.5, source: 'default (calibration pending)' }
  const ev = evaluateTrade({ winProb: p.p, targetReturn, stopLoss, assetType })
  return {
    verdict:  ev ? ev.verdict : 'reject',
    ok:       !!ev?.actionable,
    side, entry: e, target: t, stop: s,
    assetType: normalizeAssetType(assetType),
    targetReturn, stopLoss, rr, entryOffPct,
    winProb: p.p, winProbSource: p.source,
    netEdge: ev?.netEdge ?? null,
    breakEvenWinProb: ev?.breakEvenWinProb ?? null,
    reasons: [ev?.reason ?? 'The payoff cannot be scored.', ...warnings],
  }
}

/** One plain-English line for a chat or a card. */
function describeCheck(c) {
  if (!c) return ''
  if (c.verdict === 'no-trade') return 'No trade plan to check (no directional view).'
  if (c.verdict === 'incoherent') return `Plan rejected by code: ${c.reasons.join(' ')}`
  const head = { act: 'Plan checks out', thin: 'Plan is thin', reject: 'Plan does not pay' }[c.verdict] || 'Plan checked'
  return `${head}: ${c.side} from $${c.entry}, target $${c.target} (+${c.targetReturn}%), stop $${c.stop} (−${c.stopLoss}%), reward/risk ${c.rr}:1. ${c.reasons.join(' ')}`
}

// The labels the agent's prompt asks for. Bold markers and bullets are
// stripped first; each label's FIRST dollar figure is taken.
const money = s => {
  const m = String(s || '').match(/\$\s?([\d,]+(?:\.\d+)?)/)
  return m ? num(m[1]) : null
}
/**
 * Pull the Trade Hypothesis out of the AI Agent's answer. Pure.
 * @returns {{bias:string, side:string|null, entry:number|null, entryLow, entryHigh, target, target2, stop}|null}
 */
function parseTradeHypothesis(text) {
  const lines = String(text || '').split('\n').map(l => l.replace(/\*\*/g, '').replace(/^[\s>*•-]+/, '').trim())
  const field = re => lines.find(l => re.test(l)) || null
  const biasLine = field(/^bias\s*:/i)
  if (!biasLine) return null
  const bias = (biasLine.match(/bullish|bearish|neutral/i)?.[0] || '').toLowerCase()
  if (!bias) return null
  const entryLine = field(/^entry(\s+zone)?\s*:/i)
  const zone = entryLine ? [...entryLine.matchAll(/\$\s?([\d,]+(?:\.\d+)?)/g)].map(m => num(m[1])).filter(Boolean) : []
  const entryLow = zone[0] ?? null
  const entryHigh = zone[1] ?? zone[0] ?? null
  const t1Line = field(/^target\s*1?\s*:/i)
  const t2 = t1Line && /target\s*2\s*:/i.test(t1Line) ? money(t1Line.split(/target\s*2\s*:/i)[1]) : money(field(/^target\s*2\s*:/i))
  return {
    bias,
    side: bias === 'bullish' ? 'long' : bias === 'bearish' ? 'short' : null,
    entryLow, entryHigh,
    entry: entryLow && entryHigh ? +((entryLow + entryHigh) / 2).toFixed(4) : null,
    target: money(t1Line),
    target2: t2,
    stop: money(field(/^stop[\s-]*(loss)?\s*:/i)),
  }
}

// ── Measured win probability (same order as Advisory) ───────────────────────
// Bracket model when one was adopted walk-forward, else the AI Brain's
// calibrated rate for the asset class, else the 50% default. Read at most
// every 10 minutes: the prediction log is a file.
let _wp = { at: 0, stats: null, bracket: null }
function winProbFor(assetType) {
  try {
    if (Date.now() - _wp.at > 10 * 60_000) {
      const { computeStats, readPredictions } = require('./brain-learnings')
      let stats = null
      try { stats = computeStats(readPredictions()) } catch { /* calibration optional */ }
      _wp = { at: Date.now(), stats, bracket: require('./bracket-prob').loadStore() }
    }
    const asset = normalizeAssetType(assetType)
    return require('./bracket-prob').winProbFor(_wp.bracket, { assetType: asset })
      || require('./kelly').winProbFromStats(_wp.stats, { assetType: asset })
  } catch {
    return { p: 0.5, source: 'default (calibration pending)' }
  }
}

// ── Recording ────────────────────────────────────────────────────────────────
// One decision per surface + symbol + direction per day: the Analyze page can
// re-run the same symbol many times, and twenty copies of one call would
// count as twenty calls when the record is scored.
const _recent = new Map()
const DEDUPE_MS = 24 * 3600_000
function recordPlan({ surface, symbol, check, price, confidence = null, meta = {} }, store = require('./learning-store')) {
  if (!check || !['long', 'short'].includes(check.side) || check.verdict === 'incoherent') return null
  if (!(Number(price) > 0)) return null
  const action = check.side === 'long' ? 'buy' : 'sell'
  const key = `${surface}:${String(symbol).toUpperCase()}:${action}`
  const last = _recent.get(key)
  if (last && Date.now() - last < DEDUPE_MS) return null
  _recent.set(key, Date.now())
  return store.recordDecision({
    surface, symbol, action, price: Number(price), confidence,
    meta: { ...meta, entry: check.entry, target: check.target, stop: check.stop, rr: check.rr, verdict: check.verdict, netEdge: check.netEdge },
  })
}

/** 0-100 confidence → the learning store's buckets. */
function confidenceBucket(c) {
  const n = Number(c)
  if (!Number.isFinite(n)) return null
  return n >= 70 ? 'High' : n >= 50 ? 'Medium' : 'Low'
}

module.exports = {
  checkPlan, describeCheck, parseTradeHypothesis, winProbFor, recordPlan, confidenceBucket,
  MAX_ENTRY_OFF_PCT, _resetForTests: () => _recent.clear(),
}
