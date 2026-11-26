'use strict'
/**
 * lib/persona-rules.js — the Advisory page's five rule-based personas (Growth
 * Hawk, Value Seeker, Momentum Trader, Defensive Shield, ESG Conscious): their
 * hand-set weights and the fit score, in ONE place so the page and the
 * five-year test (lib/persona-rule-study.js) score a stock identically.
 *
 * Moved verbatim from Recommendations/AdvisoryView.jsx. Missing inputs are
 * neutral (0 points), as the page always said: revenue/earnings growth 0,
 * P/E 30 (scores 0), beta 1 (scores 0).
 *
 * Pure, no requires — shared with the browser (tools/vite-shared-cjs.mjs).
 * Tests: tests/persona-rule-study.test.js
 */

const PERSONA_WEIGHTS_V1 = {
  growth:    { revenueGrowth: 0.35, earningsGrowth: 0.25, momentum: 0.25, valuation: 0.05, stability: 0.10 },
  value:     { revenueGrowth: 0.10, earningsGrowth: 0.10, momentum: 0.05, valuation: 0.50, stability: 0.25 },
  momentum:  { revenueGrowth: 0.10, earningsGrowth: 0.10, momentum: 0.55, valuation: 0.10, stability: 0.15 },
  defensive: { revenueGrowth: 0.05, earningsGrowth: 0.10, momentum: 0.05, valuation: 0.20, stability: 0.60 },
  esg:       { revenueGrowth: 0.20, earningsGrowth: 0.15, momentum: 0.15, valuation: 0.20, stability: 0.30 },
}
// v2: Defensive Shield gains the balance-sheet pillar its description names
// ("strong balance sheet"), taken from stability; ESG Conscious (described as
// "financial quality and stability") likewise. Chosen from the descriptions
// BEFORE the five-year test was rerun, not fitted to it.
const PERSONA_WEIGHTS = {
  growth:    { revenueGrowth: 0.35, earningsGrowth: 0.25, momentum: 0.25, valuation: 0.05, stability: 0.10, quality: 0 },
  value:     { revenueGrowth: 0.10, earningsGrowth: 0.10, momentum: 0.05, valuation: 0.50, stability: 0.25, quality: 0 },
  momentum:  { revenueGrowth: 0.10, earningsGrowth: 0.10, momentum: 0.55, valuation: 0.10, stability: 0.15, quality: 0 },
  defensive: { revenueGrowth: 0.05, earningsGrowth: 0.10, momentum: 0.05, valuation: 0.20, stability: 0.35, quality: 0.25 },
  esg:       { revenueGrowth: 0.20, earningsGrowth: 0.15, momentum: 0.15, valuation: 0.20, stability: 0.15, quality: 0.15 },
}

// How each persona is judged: Defensive Shield exists to lose less, not to
// beat a rising market, so it is judged on return beyond what its lower beta
// explains, and must also be less volatile than the list.
const OBJECTIVE = { growth: 'excess', value: 'excess', momentum: 'excess', defensive: 'risk-adjusted', esg: 'excess' }


/** Wilder RSI of the last close. */
function rsiLast(closes, n = 14) {
  if (closes.length <= n) return null
  let g = 0, l = 0
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d }
  g /= n; l /= n
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    g = (g * (n - 1) + Math.max(0, d)) / n; l = (l * (n - 1) + Math.max(0, -d)) / n
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l)
}
function smaLast(closes, n) {
  if (closes.length < n) return null
  let s = 0
  for (let i = closes.length - n; i < closes.length; i++) s += closes[i]
  return s / n
}

/**
 * v2 fit score. Two problems with v1, both measured by the five-year test:
 *   - it SATURATED: growth points had no bound (30% revenue growth alone added
 *     ~21 points for Growth Hawk), so fast growers all sat at 100 and in 26–40
 *     of 47 months the top-fifth cut fell inside a tie;
 *   - its steps (P/E < 15 / < 25 / < 40, beta < 0.7 / < 1 / < 1.5, RSI bands)
 *     made many more ties.
 * v2: every pillar gives points in [−20, +20], continuous, then × weight × 2
 * (as v1), so the total stays inside 0–100 without hitting the walls:
 *   growth        revenue / EPS growth % ÷ 2
 *   valuation     (30 − P/E) × 4/3   (P/E 15 → +20, 30 → 0, 45 → −20); a loss-maker −20
 *   stability     (1 − beta) × 40    (beta 0.5 → +20, 1 → 0, 1.5 → −20)
 *   quality       mean of (ROE − 10) × 2 and (1 − debt/equity) × 20 — the
 *                 balance sheet Defensive Shield's description promised and v1 never read
 *   momentum      (RSI − 45) × 0.8, plus up to ±10 × weight for distance above
 *                 the 50-day average (±5%)
 * A missing input still gives 0 points (neutral). `raw: true` returns the
 * unrounded score (for ranking).
 */
function clamp(x, lo = -20, hi = 20) { return Math.max(lo, Math.min(hi, x)) }
function qualityPoints(f) {
  const parts = []
  if (Number.isFinite(f.roePct)) parts.push(clamp((f.roePct - 10) * 2))
  if (Number.isFinite(f.debtToEquity) && f.debtToEquity >= 0) parts.push(clamp((1 - f.debtToEquity) * 20))
  return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0
}
function scoreFor(weights, f, closes = [], { raw = false } = {}) {
  const w = { quality: 0, ...(typeof weights === 'string' ? PERSONA_WEIGHTS[weights] : weights) }
  let score = 50
  const add = (pts, weight) => { score += pts * weight * 2 }
  if (f && !f.etf) {
    if (Number.isFinite(f.revenueGrowthPct)) add(clamp(f.revenueGrowthPct / 2), w.revenueGrowth)
    if (Number.isFinite(f.earningsGrowthPct)) add(clamp(f.earningsGrowthPct / 2), w.earningsGrowth)
    if (f.lossMaking) add(-20, w.valuation)
    else if (f.pe > 0) add(clamp((30 - f.pe) * 4 / 3), w.valuation)
    if (Number.isFinite(f.beta)) add(clamp((1 - f.beta) * 40), w.stability)
    add(qualityPoints(f), w.quality)
    if (f.dividendYield && w.stability > 0.3) score += 5
  }
  if (f && f.etf) {
    if (Number.isFinite(f.beta)) add(clamp((1 - f.beta) * 40), w.stability)
    const dy = f.dividendYield ?? 0
    if (dy > 0) add(clamp(dy * 100 * 5), w.valuation)          // 4% yield → +20
    if (f.low52 != null && f.high52 != null && closes.length > 0 && f.high52 > f.low52) {
      add(clamp(((closes[closes.length - 1] - f.low52) / (f.high52 - f.low52)) * 40 - 20), w.momentum)
    }
  }
  if (closes.length > 20) {
    const r = rsiLast(closes)
    if (r != null) add(clamp((r - 45) * 0.8), w.momentum)
    const s50 = smaLast(closes, 50)
    if (s50) score += clamp((closes[closes.length - 1] / s50 - 1) * 200, -10, 10) * w.momentum
  }
  const out = Math.min(100, Math.max(0, score))
  return raw ? out : Math.round(out)
}

/**
 * v1 (kept for the before/after comparison in lib/persona-rule-study.js).
 * Fit score 0–100. `f` for a stock: { revenueGrowthPct, earningsGrowthPct, pe,
 * beta, dividendYield (fraction) }; for an ETF ({etf: true}): { beta,
 * dividendYield, low52, high52 }. `closes` oldest first.
 */
function scoreForV1(weights, f, closes = []) {
  const w = typeof weights === 'string' ? PERSONA_WEIGHTS_V1[weights] : weights
  let score = 50
  if (f && !f.etf) {
    score += (f.revenueGrowthPct || 0) * w.revenueGrowth * 2
    score += (f.earningsGrowthPct || 0) * w.earningsGrowth * 2
    const pe = f.pe || 30
    const valScore = pe < 15 ? 20 : pe < 25 ? 10 : pe < 40 ? 0 : -10
    score += valScore * w.valuation * 2
    const beta = f.beta || 1
    const stabScore = beta < 0.7 ? 20 : beta < 1.0 ? 10 : beta < 1.5 ? 0 : -10
    score += stabScore * w.stability * 2
    if (f.dividendYield && w.stability > 0.3) score += 5
  }
  if (f && f.etf) {
    const beta = f.beta ?? 1
    const dy = f.dividendYield ?? 0
    const stabScore = beta < 0.6 ? 20 : beta < 0.85 ? 12 : beta < 1.1 ? 4 : beta < 1.4 ? -4 : -12
    score += stabScore * w.stability * 2
    if (dy > 0.03) score += 18 * w.valuation
    else if (dy > 0.01) score += 8 * w.valuation
    if (f.low52 != null && f.high52 != null && closes.length > 0) {
      const range52 = f.high52 - f.low52
      if (range52 > 0) score += (((closes[closes.length - 1] - f.low52) / range52) * 24 - 8) * w.momentum
    }
  }
  if (closes.length > 20) {
    const r = rsiLast(closes)
    if (r != null) score += (r > 60 ? 15 : r > 45 ? 8 : r < 30 ? -10 : 0) * w.momentum * 2
    const s50 = smaLast(closes, 50)
    if (s50 && closes[closes.length - 1] > s50) score += 10 * w.momentum
  }
  return Math.min(100, Math.max(0, Math.round(score)))
}

module.exports = { PERSONA_WEIGHTS, PERSONA_WEIGHTS_V1, OBJECTIVE, scoreFor, scoreForV1, rsiLast, smaLast }
