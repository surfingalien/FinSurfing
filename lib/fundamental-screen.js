'use strict'
/**
 * lib/fundamental-screen.js
 *
 * Deterministic yield + profitability scoring for the screener.
 *
 * Discovery in this repo was 20 hardcoded tickers per surface — routes/
 * dividend.js screened a fixed DEFAULT_UNIVERSE, and every AI Brain
 * SCAN_UNIVERSE is a literal ~20-symbol list — while lib/symbol-db.js holds
 * 300k+ symbols nobody was searching. This module supplies the missing
 * judgement the same way the rest of the repo does: the data is measured, the
 * math is deterministic and testable, and the LLM is only ever asked to
 * EXPLAIN a ranking it did not produce.
 *
 * ── Why this is not "sort by dividend yield" ────────────────────────────────
 * Sorting by yield ranks the market's worst businesses first. Yield is
 * dividend ÷ price, so it rises when the price falls, and the highest yields
 * on any screen are overwhelmingly companies the market expects to CUT. The
 * dividend is a forecast, not a fact — the only ones worth having are the ones
 * the business can actually fund.
 *
 * So `scoreYield` rewards yield up to a point and then DISCOUNTS it, and
 * multiplies the whole thing by a sustainability factor built from payout
 * ratio, free-cash-flow coverage and leverage. A 12% yield paying out 140% of
 * earnings scores below a covered 3% yield, which is the correct answer and
 * the opposite of what a sort gives you.
 *
 * ── Units ───────────────────────────────────────────────────────────────────
 * EVERY percentage here is percent-valued: 3.2 means 3.2%, never 0.032. FMP
 * returns these as decimals, so the route converts at the boundary and
 * `looksLikeFraction()` catches a caller that forgot. This is deliberate
 * pedantry — lib/price-coherence.js exists because a model fed a percentage
 * into a price field and nothing noticed.
 *
 * ── Missing data ────────────────────────────────────────────────────────────
 * An absent input is NOT a zero. Scoring a company we know nothing about as
 * 0 ranks it below a measurably bad one, which is a claim the data does not
 * support. Each pillar scores only the components present, reports `coverage`,
 * and anything under MIN_COVERAGE is returned as `insufficient-data` and
 * excluded from the ranking rather than ranked low.
 *
 * Pure: no I/O, no network, no clock. Tests: tests/fundamental-screen.test.js
 */

// ── Yield shape ─────────────────────────────────────────────────────────────
/** Yield (%) at which the reward curve has essentially saturated. */
const YIELD_SATURATION = 6
/** Above this yield (%), the market is usually pricing in a cut. */
const HIGH_YIELD_WARN  = 8
/** Yield (%) at which the decay has removed all the excess reward. */
const YIELD_ABSURD     = 20

// ── Sustainability thresholds (all percent-valued) ──────────────────────────
const PAYOUT_IDEAL_MAX  = 60    // comfortably covered by earnings
const PAYOUT_STRAINED   = 90    // most of earnings going out the door
const FCF_PAYOUT_LIMIT  = 100   // paying out more cash than it generates
const LEVERAGE_WARN     = 200   // debt/equity %, above which coverage is fragile

/** Reference "good" levels for the profitability pillar (percent-valued). */
const PROFIT_REFERENCE = {
  roe:             { good: 20, weight: 0.25 },
  roic:            { good: 15, weight: 0.25 },
  netMargin:       { good: 15, weight: 0.20 },
  operatingMargin: { good: 20, weight: 0.15 },
  fcfMargin:       { good: 15, weight: 0.15 },
}

/** A pillar needs this share of its inputs before its score means anything. */
const MIN_COVERAGE = 0.5

const DEFAULT_WEIGHTS = { yield: 0.5, profitability: 0.5 }

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/**
 * A guard against the units mistake this module is pedantic about. A non-zero
 * magnitude under 1 where a percentage is expected is almost always a fraction
 * that was never multiplied out (0.032 for 3.2%).
 */
function looksLikeFraction(v) {
  const x = num(v)
  return x != null && x !== 0 && Math.abs(x) < 1
}

/**
 * Reward for the yield itself, before sustainability. Rises steeply to
 * YIELD_SATURATION, then decays — because past HIGH_YIELD_WARN the number is
 * usually telling you about the price, not the dividend.
 *
 * @param {number} dividendYield  percent-valued
 * @returns {number} 0-100
 */
function yieldReward(dividendYield) {
  const y = num(dividendYield)
  if (y == null || y <= 0) return 0

  if (y <= YIELD_SATURATION) return clamp((y / YIELD_SATURATION) * 100, 0, 100)
  if (y <= HIGH_YIELD_WARN) return 100

  // Linear decay from full reward at HIGH_YIELD_WARN to zero at YIELD_ABSURD.
  const span = YIELD_ABSURD - HIGH_YIELD_WARN
  return clamp(100 * (1 - (y - HIGH_YIELD_WARN) / span), 0, 100)
}

/**
 * How well the business can actually fund the dividend: 0 (cannot) to 1 (easily).
 * Returns null when nothing about coverage is known — the caller must not read
 * that as "fine".
 */
function sustainability({ payoutRatio, fcfPayoutRatio, debtToEquity } = {}) {
  const factors = []

  const payout = num(payoutRatio)
  if (payout != null) {
    // A negative payout ratio means negative earnings — the dividend is being
    // funded from somewhere other than profit. That is the worst case, not a
    // small number, so it must never read as a low-and-therefore-safe payout.
    if (payout < 0) factors.push(0)
    else if (payout <= PAYOUT_IDEAL_MAX) factors.push(1)
    else if (payout >= PAYOUT_STRAINED * 2) factors.push(0)
    else factors.push(clamp(1 - (payout - PAYOUT_IDEAL_MAX) / (PAYOUT_STRAINED * 2 - PAYOUT_IDEAL_MAX), 0, 1))
  }

  const fcfPayout = num(fcfPayoutRatio)
  if (fcfPayout != null) {
    if (fcfPayout < 0) factors.push(0)                      // negative free cash flow
    else if (fcfPayout <= FCF_PAYOUT_LIMIT * 0.7) factors.push(1)
    else if (fcfPayout >= FCF_PAYOUT_LIMIT * 1.5) factors.push(0)
    else factors.push(clamp(1 - (fcfPayout - FCF_PAYOUT_LIMIT * 0.7) / (FCF_PAYOUT_LIMIT * 0.8), 0, 1))
  }

  const de = num(debtToEquity)
  if (de != null) {
    // Leverage is a modifier, not a veto — it never drives the factor below
    // 0.6 on its own, because a levered utility is not a levered startup.
    factors.push(de <= LEVERAGE_WARN ? 1 : clamp(1 - (de - LEVERAGE_WARN) / (LEVERAGE_WARN * 2.5), 0.6, 1))
  }

  if (!factors.length) return null
  return factors.reduce((a, b) => a + b, 0) / factors.length
}

/**
 * Yield pillar: reward × sustainability.
 * @returns {{score: number|null, coverage: number, reward: number, sustainability: number|null}}
 */
function scoreYield(row = {}) {
  const y = num(row.dividendYield)
  const sust = sustainability(row)

  const inputs = ['dividendYield', 'payoutRatio', 'fcfPayoutRatio', 'debtToEquity']
  const coverage = inputs.filter(k => num(row[k]) != null).length / inputs.length

  // No dividend is a fact, not missing data: the yield pillar is legitimately
  // zero, and a growth stock simply wins on the other pillar.
  if (y == null) return { score: null, coverage, reward: 0, sustainability: sust }
  if (y <= 0) return { score: 0, coverage, reward: 0, sustainability: sust }

  const reward = yieldReward(y)
  // With no coverage data at all, the reward stands undiscounted but the low
  // coverage number tells the caller how much to trust it.
  const score = sust == null ? reward : reward * sust
  return { score: Math.round(score), coverage, reward: Math.round(reward), sustainability: sust }
}

/**
 * Profitability pillar: weighted distance to a reference "good" level for each
 * metric present. Weights are renormalised over the metrics actually supplied,
 * so a missing one dilutes confidence (via coverage) rather than the score.
 */
function scoreProfitability(row = {}) {
  let total = 0
  let weightSum = 0
  let present = 0

  for (const [metric, { good, weight }] of Object.entries(PROFIT_REFERENCE)) {
    const v = num(row[metric])
    if (v == null) continue
    present++
    weightSum += weight
    // Negative margins/returns score zero, not a negative contribution — a
    // loss-making business is simply at the bottom, and letting one metric go
    // negative would let it cancel out genuine strength elsewhere.
    total += clamp((v / good) * 100, 0, 100) * weight
  }

  const coverage = present / Object.keys(PROFIT_REFERENCE).length
  if (!weightSum) return { score: null, coverage: 0 }
  return { score: Math.round(total / weightSum), coverage }
}

/**
 * Flags worth showing a user regardless of score — each is a specific,
 * checkable claim about the row, not a vibe.
 */
function riskFlags(row = {}) {
  const flags = []
  const y   = num(row.dividendYield)
  const po  = num(row.payoutRatio)
  const fcf = num(row.fcfPayoutRatio)
  const de  = num(row.debtToEquity)

  if (y != null && y > HIGH_YIELD_WARN && ((po != null && po > PAYOUT_STRAINED) || (fcf != null && fcf > FCF_PAYOUT_LIMIT)))
    flags.push({ code: 'value-trap-risk', detail: `${y.toFixed(1)}% yield is not covered — the market is likely pricing a cut` })
  if (po != null && po < 0)
    flags.push({ code: 'negative-earnings', detail: 'dividend is being paid without positive earnings behind it' })
  else if (po != null && po > PAYOUT_STRAINED)
    flags.push({ code: 'strained-payout', detail: `paying out ${po.toFixed(0)}% of earnings` })
  if (fcf != null && fcf > FCF_PAYOUT_LIMIT)
    flags.push({ code: 'unfunded-dividend', detail: `dividend is ${fcf.toFixed(0)}% of free cash flow` })
  if (de != null && de > LEVERAGE_WARN)
    flags.push({ code: 'leveraged', detail: `debt/equity ${de.toFixed(0)}%` })

  return flags
}

/**
 * Score one candidate.
 *
 * @param {object} row  percent-valued: dividendYield, payoutRatio,
 *                      fcfPayoutRatio, debtToEquity, roe, roic, netMargin,
 *                      operatingMargin, fcfMargin
 * @param {object} [opts]
 * @param {{yield:number, profitability:number}} [opts.weights]
 * @returns {object} score card, with `verdict: 'insufficient-data'` when the
 *                   inputs cannot support a ranking
 */
function scoreRow(row = {}, { weights = DEFAULT_WEIGHTS } = {}) {
  const y = scoreYield(row)
  const p = scoreProfitability(row)

  const card = {
    symbol:        row.symbol ?? null,
    yieldScore:    y.score,
    profitScore:   p.score,
    yieldCoverage: +y.coverage.toFixed(2),
    profitCoverage: +p.coverage.toFixed(2),
    sustainability: y.sustainability == null ? null : +y.sustainability.toFixed(2),
    flags:         riskFlags(row),
  }

  // A pillar with too little behind it is not allowed to carry the composite.
  const usable = []
  if (y.score != null && y.coverage >= MIN_COVERAGE) usable.push([y.score, weights.yield])
  if (p.score != null && p.coverage >= MIN_COVERAGE) usable.push([p.score, weights.profitability])

  if (!usable.length) {
    return { ...card, composite: null, verdict: 'insufficient-data' }
  }

  const wSum = usable.reduce((a, [, w]) => a + w, 0)
  const composite = Math.round(usable.reduce((a, [s, w]) => a + s * w, 0) / wSum)

  return {
    ...card,
    composite,
    // A single-pillar score is a real answer (a growth stock with no dividend),
    // but the caller should know it rests on one leg.
    pillars: usable.length,
    verdict: card.flags.some(f => f.code === 'value-trap-risk' || f.code === 'negative-earnings')
      ? 'flagged'
      : 'ok',
  }
}

/**
 * Score and rank a candidate list, dropping rows the data cannot support.
 *
 * @returns {{ranked: object[], excluded: object[], weights: object}}
 */
function rankCandidates(rows, { weights = DEFAULT_WEIGHTS, limit = 25 } = {}) {
  if (!Array.isArray(rows)) return { ranked: [], excluded: [], weights }

  const ranked = []
  const excluded = []

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const card = scoreRow(row, { weights })
    if (card.verdict === 'insufficient-data') {
      excluded.push({ symbol: row.symbol ?? null, reason: 'insufficient-data' })
      continue
    }
    ranked.push({ ...row, ...card })
  }

  ranked.sort((a, b) =>
    b.composite - a.composite ||
    // A clean row beats a flagged one at equal score — the flag is information
    // the composite has already partly absorbed, and the tie should not go to
    // the riskier name.
    a.flags.length - b.flags.length ||
    String(a.symbol).localeCompare(String(b.symbol)))

  return { ranked: ranked.slice(0, Math.max(1, limit)), excluded, weights }
}

module.exports = {
  YIELD_SATURATION, HIGH_YIELD_WARN, YIELD_ABSURD,
  PAYOUT_IDEAL_MAX, PAYOUT_STRAINED, FCF_PAYOUT_LIMIT, LEVERAGE_WARN,
  PROFIT_REFERENCE, MIN_COVERAGE, DEFAULT_WEIGHTS,
  looksLikeFraction, yieldReward, sustainability,
  scoreYield, scoreProfitability, riskFlags, scoreRow, rankCandidates,
}
