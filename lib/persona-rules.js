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

const PERSONA_WEIGHTS = {
  growth:    { revenueGrowth: 0.35, earningsGrowth: 0.25, momentum: 0.25, valuation: 0.05, stability: 0.10 },
  value:     { revenueGrowth: 0.10, earningsGrowth: 0.10, momentum: 0.05, valuation: 0.50, stability: 0.25 },
  momentum:  { revenueGrowth: 0.10, earningsGrowth: 0.10, momentum: 0.55, valuation: 0.10, stability: 0.15 },
  defensive: { revenueGrowth: 0.05, earningsGrowth: 0.10, momentum: 0.05, valuation: 0.20, stability: 0.60 },
  esg:       { revenueGrowth: 0.20, earningsGrowth: 0.15, momentum: 0.15, valuation: 0.20, stability: 0.30 },
}

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
 * Fit score 0–100. `f` for a stock: { revenueGrowthPct, earningsGrowthPct, pe,
 * beta, dividendYield (fraction) }; for an ETF ({etf: true}): { beta,
 * dividendYield, low52, high52 }. `closes` oldest first.
 */
function scoreFor(weights, f, closes = []) {
  const w = typeof weights === 'string' ? PERSONA_WEIGHTS[weights] : weights
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

module.exports = { PERSONA_WEIGHTS, scoreFor, rsiLast, smaLast }
