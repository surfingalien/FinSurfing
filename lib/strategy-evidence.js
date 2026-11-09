'use strict'
/**
 * lib/strategy-evidence.js — is there enough evidence in a strategy's TRADES,
 * does it hold up across market regimes, and one report card of every check.
 *
 * A strategy could be "validated" on 2 closed trades per window
 * (strategy-lab.verdictFor). Two lucky trades beat buy & hold and post a
 * positive Sharpe as easily as two thousand skilled ones; the deflated Sharpe,
 * PBO and CPCV soften that but do not remove it. So, before a strategy is
 * admitted to the library:
 *
 *   TRADE EVIDENCE — positions are rebuilt from the trade list (a bracket's
 *   T1 half and the rest are ONE position, share-weighted), and the mean
 *   return per position must be positive with t ≥ TRADE_T_MIN over at least
 *   MIN_TRADES positions. Not a flat "100 trades" (a daily strategy trades a
 *   few times a year): a count floor plus a test that the per-trade edge is
 *   distinguishable from zero.
 *
 *   REGIMES — each position is labelled by the market state at its ENTRY bar
 *   (lib/price-regime.js on the symbol's own bars: up/down/range trend ×
 *   calm/stressed volatility, each label reading bars ≤ that day only). A
 *   strategy that loses SIGNIFICANTLY (mean < 0, t ≤ REGIME_T_FAIL, ≥
 *   MIN_STATE_TRADES trades) in a state that covers ≥ COMMON_STATE of the
 *   history is not admitted — it works only until the market changes.
 *
 *   HYPOTHESIS — every strategy carries a claim stated BEFORE it is tested:
 *   the market it should work in, from an allow-list (HYPOTHESES) that maps
 *   to the same regime labels. The model states it with its proposal; a
 *   catalog strategy without one takes its type's default (trend rules →
 *   up-trends, reversion rules → ranges). The positions entered in the
 *   claimed states are pooled: `supported` (≥ MIN_STATE_TRADES, mean > 0,
 *   t ≥ TRADE_T_MIN), `contradicted` (≥ MIN_STATE_TRADES, mean < 0,
 *   t ≤ REGIME_T_FAIL — it loses significantly exactly where it says it
 *   works, so whatever it made came from somewhere it did not predict:
 *   not admitted), else `unclear` / `insufficient`.
 *
 *   REPORT CARD — every gate the library applies, one row each, with its
 *   number and pass / review / fail / n/a. Shown, stored with the strategy;
 *   it decides nothing that the gates above and in strategy-lab do not.
 *
 * Hand-set composite scores and fixed bars (profit factor ≥ 1.5, Sharpe ≥ 1)
 * are deliberately NOT used to decide: they are shown on the card as numbers.
 * Pure. Tests: tests/strategy-evidence.test.js
 */

const { regimeSeries } = require('./price-regime')

const MIN_TRADES = 20
const TRADE_T_MIN = 1
const MIN_STATE_TRADES = 8
const REGIME_T_FAIL = -1
const COMMON_STATE = 0.15

// The market a strategy claims to work in → the price-regime labels that test it.
const HYPOTHESES = {
  uptrend:   { text: 'up-trending markets',      states: ['up-calm', 'up-stressed'] },
  downtrend: { text: 'down-trending markets',    states: ['down-calm', 'down-stressed'] },
  range:     { text: 'range-bound markets',      states: ['range-calm', 'range-stressed'] },
  calm:      { text: 'calm (low-volatility) markets',     states: ['up-calm', 'range-calm', 'down-calm'] },
  stressed:  { text: 'stressed (high-volatility) markets', states: ['up-stressed', 'range-stressed', 'down-stressed'] },
}
const HYPOTHESIS_KEYS = Object.keys(HYPOTHESES)

/**
 * A clean hypothesis {worksIn, statement, source} from model output, or the
 * fallback (a catalog type's default) when it is missing or not on the list.
 */
function parseHypothesis(raw, fallback = null) {
  const worksIn = typeof raw?.worksIn === 'string' ? raw.worksIn.trim().toLowerCase() : null
  if (worksIn && HYPOTHESES[worksIn]) {
    return { worksIn, statement: String(raw.statement || '').replace(/\s+/g, ' ').trim().slice(0, 240), source: 'model' }
  }
  return fallback && HYPOTHESES[fallback] ? { worksIn: fallback, statement: `works in ${HYPOTHESES[fallback].text} (the type's default)`, source: 'default' } : null
}

const dayOf = ts => new Date(ts * 1000).toISOString().slice(0, 10)

function tStats(xs) {
  const n = xs.length
  if (!n) return { n: 0, mean: null, sd: null, t: null }
  const mean = xs.reduce((a, v) => a + v, 0) / n
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : null
  const t = sd > 0 ? mean / (sd / Math.sqrt(n)) : null
  return { n, mean, sd, t }
}

/** Positions from a simulateWithSignals trade list: [{entryDate, pnl}] (pnl %, share-weighted over lots; open liquidation excluded). */
function positionsOf(trades = []) {
  const out = []
  let open = null, left = 0, lots = []
  for (const t of trades) {
    if (t.type === 'buy') { open = t; left = t.shares; lots = [] } else if (t.type === 'sell' && open && !t.open) {
      lots.push(t); left -= t.shares
      if (left <= 0) {
        const sh = lots.reduce((a, l) => a + l.shares, 0)
        out.push({ entryDate: open.date, pnl: lots.reduce((a, l) => a + l.pnl * l.shares, 0) / sh })
        open = null
      }
    }
  }
  return out
}

/** Per-position edge: n, mean %, sd, t, 95% lower bound of the mean, profit factor. */
function tradeEvidence(trades) {
  const pos = positionsOf(trades)
  const s = tStats(pos.map(p => p.pnl))
  const gains = pos.filter(p => p.pnl > 0).reduce((a, p) => a + p.pnl, 0)
  const losses = -pos.filter(p => p.pnl < 0).reduce((a, p) => a + p.pnl, 0)
  return {
    trades: s.n,
    meanPct: s.mean == null ? null : +s.mean.toFixed(3),
    t: s.t == null ? null : +s.t.toFixed(2),
    lo95Pct: s.sd > 0 ? +(s.mean - 1.96 * s.sd / Math.sqrt(s.n)).toFixed(3) : null,
    winRate: s.n ? +(pos.filter(p => p.pnl > 0).length / s.n).toFixed(3) : null,
    profitFactor: losses > 0 ? +(gains / losses).toFixed(2) : null,
    enough: s.n >= MIN_TRADES && s.t != null && s.t >= TRADE_T_MIN,
  }
}

// Regime labels are O(n · 252); one series is evaluated many times per batch, so memoise on the closes array.
const _regimeMemo = new WeakMap()
function regimesFor(timestamps, closes) {
  let r = _regimeMemo.get(closes)
  if (!r) {
    r = regimeSeries(closes.map((c, i) => ({ t: timestamps[i] * 1000, c })))
    _regimeMemo.set(closes, r)
  }
  return r
}

/** Positions grouped by the regime at their entry bar, with how much of the history each state covers. */
function regimeBreakdown(trades, timestamps, closes) {
  const labels = regimesFor(timestamps, closes)
  const idx = new Map(timestamps.map((t, i) => [dayOf(t), i]))
  const labelled = labels.filter(Boolean)
  const coverage = {}
  for (const l of labelled) coverage[l.label] = (coverage[l.label] || 0) + 1
  const groups = {}
  let unlabelled = 0
  for (const p of positionsOf(trades)) {
    const i = idx.get(p.entryDate)
    // The fill is the bar after the signal; label the market the decision was made in (the signal bar).
    const lab = i != null ? labels[Math.max(0, i - 1)]?.label : null
    if (!lab) { unlabelled++; continue }
    ;(groups[lab] = groups[lab] || []).push(p.pnl)
  }
  const states = Object.entries(groups).map(([label, xs]) => {
    const s = tStats(xs)
    const gains = xs.filter(v => v > 0).reduce((a, v) => a + v, 0), losses = -xs.filter(v => v < 0).reduce((a, v) => a + v, 0)
    const cov = labelled.length ? (coverage[label] || 0) / labelled.length : 0
    return {
      label, trades: s.n, meanPct: +s.mean.toFixed(3), t: s.t == null ? null : +s.t.toFixed(2),
      sum: +xs.reduce((a, v) => a + v, 0).toFixed(6), sumSq: +xs.reduce((a, v) => a + v * v, 0).toFixed(6),   // exact pooling (hypothesisTest)
      winRate: +(xs.filter(v => v > 0).length / s.n).toFixed(3), profitFactor: losses > 0 ? +(gains / losses).toFixed(2) : null,
      coverage: +cov.toFixed(3),
      fails: s.n >= MIN_STATE_TRADES && s.mean < 0 && s.t != null && s.t <= REGIME_T_FAIL && cov >= COMMON_STATE,
    }
  }).sort((a, b) => b.trades - a.trades)
  return { states, unlabelled, failing: states.filter(s => s.fails).map(s => s.label) }
}

/**
 * Test a stated hypothesis against the regime breakdown: pool the positions
 * entered in the claimed states and compare with the rest. Pure.
 */
function hypothesisTest(hypothesis, regimes) {
  const h = hypothesis && HYPOTHESES[hypothesis.worksIn]
  if (!h || !regimes?.states) return null
  const pool = states => {
    let n = 0, sum = 0, sumSq = 0
    for (const s of states) { n += s.trades; sum += s.sum ?? s.meanPct * s.trades; sumSq += s.sumSq ?? 0 }
    if (!n) return { trades: 0, meanPct: null, t: null }
    const mean = sum / n
    const v = n > 1 ? (sumSq - n * mean * mean) / (n - 1) : 0
    const t = v > 0 ? mean / Math.sqrt(v / n) : null
    return { trades: n, meanPct: +mean.toFixed(3), t: t == null ? null : +t.toFixed(2) }
  }
  const inside = pool(regimes.states.filter(s => h.states.includes(s.label)))
  const outside = pool(regimes.states.filter(s => !h.states.includes(s.label)))
  let verdict = 'insufficient'
  if (inside.trades >= MIN_STATE_TRADES) {
    if (inside.meanPct > 0 && inside.t != null && inside.t >= TRADE_T_MIN) verdict = 'supported'
    else if (inside.meanPct < 0 && inside.t != null && inside.t <= REGIME_T_FAIL) verdict = 'contradicted'
    else verdict = 'unclear'
  }
  return { worksIn: hypothesis.worksIn, source: hypothesis.source || null, inside, outside, verdict }
}

/** The hypothesis as stored on a library entry: the claim plus how its own trades judged it. */
function storedHypothesis(item) {
  const h = item?.hypothesis
  if (!h?.worksIn) return null
  const t = item.hypothesisTest
  return { worksIn: h.worksIn, statement: h.statement || '', source: h.source || null, verdict: t?.verdict ?? null, inside: t?.inside ?? null }
}

/** Why a strategy should not be admitted on its trades, regimes or stated hypothesis, or null. Absent measurements never block (legacy/mocked inputs). */
function evidenceProblem(item) {
  const e = item?.evidence
  if (e && !e.enough) return e.trades < MIN_TRADES ? `too few trades to judge (${e.trades} < ${MIN_TRADES})` : `no measurable edge per trade (t ${e.t ?? '—'} < ${TRADE_T_MIN})`
  const r = item?.regimes
  if (r && r.failing.length) return `loses significantly in a common market state (${r.failing.join(', ')})`
  const ht = item?.hypothesisTest
  if (ht?.verdict === 'contradicted') return `its stated hypothesis is contradicted: it loses significantly in ${HYPOTHESES[ht.worksIn].text}, where it claims to work`
  return null
}

const row = (key, label, status, value, detail) => ({ key, label, status, value, detail })

/** Every gate as one row. status: pass | review | fail | na. */
function reportCard(item) {
  const m = item?.metrics || {}, e = item?.evidence, r = item?.regimes, cv = item?.cpcv
  const rows = []
  rows.push(row('oos', 'Out of sample (older 70% and newest 30%)',
    item?.verdict === 'validated' || (item?.early && item?.recent && item.early.alpha > 0 && item.recent.alpha > 0 && item.early.sharpeRatio > 0 && item.recent.sharpeRatio > 0) ? 'pass' : item?.early ? 'fail' : 'na',
    item?.early && item?.recent ? `alpha ${item.early.alpha}% / ${item.recent.alpha}%` : null, 'must beat buy & hold with a positive Sharpe in both windows'))
  rows.push(row('walkforward', 'Walk-forward', item?.params?.blocks ? 'pass' : 'review',
    item?.params?.blocks ? `${item.params.blocks} refits, each on data before its block` : 'judged forward after admission',
    'the nightly job re-tests every admitted strategy on bars after it was found and retires the ones that decay'))
  rows.push(row('stability', 'Parameter stability', item?.robustness ? (item.robustness.plateau ? 'pass' : 'fail') : 'na',
    item?.robustness ? `${item.robustness.passed}/${item.robustness.tested} neighbours beat buy & hold` : null, 'each parameter moved ±20%; at least half the neighbours must still work'))
  rows.push(row('costs', 'After costs and slippage', m.alpha > 0 ? 'pass' : m.alpha != null ? 'fail' : 'na',
    m.costBps != null ? `${m.costBps}bps round trip${m.slippage ? ` + ${m.slippage} slippage` : ''}; alpha ${m.alpha}%` : null, 'every figure is net of costs'))
  rows.push(row('trades', 'Enough trades, edge per trade', e ? (e.enough ? 'pass' : 'fail') : 'na',
    e ? `${e.trades} trades, mean ${e.meanPct}% (t ${e.t ?? '—'}), profit factor ${e.profitFactor ?? '—'}` : null, `at least ${MIN_TRADES} trades and t ≥ ${TRADE_T_MIN} on the mean return per trade`))
  rows.push(row('regimes', 'Market regimes', r ? (r.failing.length ? 'fail' : r.states.filter(s => s.trades >= MIN_STATE_TRADES).length >= 2 ? 'pass' : 'review') : 'na',
    r ? r.states.map(s => `${s.label} ${s.trades} @ ${s.meanPct}%`).join(' · ') : null, 'no common state (≥15% of days) where it loses significantly; review when only one state has enough trades to say'))
  const ht = item?.hypothesisTest
  rows.push(row('hypothesis', 'Stated hypothesis', ht ? ({ supported: 'pass', contradicted: 'fail' }[ht.verdict] || 'review') : 'na',
    ht ? `works in ${HYPOTHESES[ht.worksIn].text}${ht.source === 'default' ? ' (type default)' : ''}: ${ht.verdict} — ${ht.inside.trades} trades there @ ${ht.inside.meanPct ?? '—'}% (t ${ht.inside.t ?? '—'}), elsewhere ${ht.outside.trades} @ ${ht.outside.meanPct ?? '—'}%` : null,
    `stated before the test; the trades entered in the claimed market states must make money (t ≥ ${TRADE_T_MIN}); losing significantly there fails`))
  rows.push(row('deflated', 'Deflated Sharpe (luck of best-of-N)', item?.deflated ? (item.deflated.pass ? 'pass' : 'fail') : 'na',
    item?.deflated ? `DSR ${item.deflated.dsr} over ${item.deflated.nTrials} trials` : null, 'Sharpe above what the best of that many skill-less tries would show'))
  rows.push(row('pbo', 'Probability of overfitting (PBO)', item?.pbo ? (item.pbo.overfit ? 'fail' : 'pass') : 'na',
    item?.pbo ? `PBO ${item.pbo.pbo}` : null, 'the batch\'s best in-sample choice did not usually lose out of sample'))
  rows.push(row('cpcv', 'CPCV out-of-sample paths', cv ? (cv.generalises ? 'pass' : 'fail') : 'na',
    cv ? `median path Sharpe ${cv.medianSharpe} (p10 ${cv.p10Sharpe}, p90 ${cv.p90Sharpe})` : null, 'choosing the best of the batch holds up on the median held-out path'))
  const fails = rows.filter(x => x.status === 'fail').length, reviews = rows.filter(x => x.status === 'review').length
  return { rows, overall: fails ? 'fail' : reviews ? 'review' : 'pass', fails, reviews }
}

/** The card without the long detail strings — what is stored on a library entry. */
const compactCard = card => card && ({ overall: card.overall, rows: card.rows.map(({ key, label, status, value }) => ({ key, label, status, value })) })

module.exports = {
  MIN_TRADES, TRADE_T_MIN, MIN_STATE_TRADES, REGIME_T_FAIL, COMMON_STATE, HYPOTHESES, HYPOTHESIS_KEYS,
  positionsOf, tradeEvidence, regimeBreakdown, parseHypothesis, hypothesisTest, storedHypothesis, evidenceProblem, reportCard, compactCard,
}
