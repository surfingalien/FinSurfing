'use strict'
/**
 * lib/risk-critique.js
 *
 * Risk critique — LLM interpretation over MEASURED portfolio risk.
 *
 * buildRiskReport() compacts the /api/analytics/portfolio payload (Sharpe,
 * Sortino, vol, drawdown, VaR/CVaR, beta, per-holding metrics, sector
 * concentration, high correlations — all computed in code from real 1y
 * price history) into a deterministic text block. The LLM is then asked to
 * critique THAT report: suggest risk reductions and return enhancers, each
 * grounded in a cited number from the report. It never computes or invents
 * a metric — every figure it can reference was measured server-side.
 *
 * Pure parts (report builder, prompt, response parsing) live here and are
 * unit-tested: tests/risk-critique.test.js. routes/analytics.js does the I/O.
 */

const { tryParseAiJson } = require('./ai-json')

const HIGH_CORR = 0.7

/**
 * Compact deterministic text report from the analytics payload.
 * Returns null when there aren't enough computed metrics to critique.
 */
function buildRiskReport(payload) {
  const p = payload?.riskMetrics?.portfolio
  if (!p || !payload.symbols?.length) return null

  const b     = payload.riskMetrics.benchmark
  const fmt   = (v, suffix = '') => v != null ? `${v}${suffix}` : 'N/A'
  const lines = [
    `PORTFOLIO RISK REPORT (${payload.symbols.length} holdings vs ${payload.benchmark || 'SPY'}, 1y daily, ${p.weighting || 'equal'}-weighted — all figures computed from real price history):`,
    `Portfolio: Sharpe ${fmt(p.sharpe)} | Sortino ${fmt(p.sortino)} | Vol ${fmt(p.volatility, '%')} | MaxDD ${fmt(p.maxDrawdown, '%')} | AnnRet ${fmt(p.annualReturn, '%')} | 1d VaR95 ${fmt(p.var95, '%')} | CVaR95 ${fmt(p.cvar95, '%')} | Beta ${fmt(payload.portfolioBeta)}`,
  ]
  if (b) lines.push(`Benchmark: Sharpe ${fmt(b.sharpe)} | Vol ${fmt(b.volatility, '%')} | MaxDD ${fmt(b.maxDrawdown, '%')} | AnnRet ${fmt(b.annualReturn, '%')}`)

  const hr = payload.riskMetrics.holdings || {}
  const rows = Object.entries(hr).slice(0, 20).map(([s, h]) =>
    `  ${s}: Sharpe ${fmt(h.sharpe)}, MaxDD ${fmt(h.maxDrawdown, '%')}, AnnRet ${fmt(h.annualReturn, '%')}, beta ${fmt(payload.betas?.[s])}`)
  if (rows.length) lines.push('Per holding:', ...rows)

  if (payload.sectors?.length) {
    lines.push('Sector weights: ' + payload.sectors.map(s => `${s.name} ${s.weight}%`).join(', '))
  }

  const highCorr = (payload.correlations || [])
    .filter(c => c.r != null && Math.abs(c.r) >= HIGH_CORR)
    .sort((x, y) => Math.abs(y.r) - Math.abs(x.r))
    .slice(0, 8)
  if (highCorr.length) {
    lines.push('Highly correlated pairs (|r|≥0.7): ' + highCorr.map(c => `${c.a}/${c.b} r=${c.r}`).join(', '))
  }

  return lines.join('\n')
}

function buildCritiquePrompt(report) {
  return `You are a portfolio risk officer reviewing a retail investor's measured risk report.

${report}

Critique this risk profile. STRICT RULES:
- Reference ONLY figures present in the report above — never estimate, extrapolate, or invent a number
- Every suggestion must cite the specific figure that motivates it in its "evidence" field
- Suggestions are advisory adjustments (trim/add/hedge/diversify) — no leverage, no derivatives strategies beyond simple hedges, nothing executed automatically
- If the report shows no meaningful weakness for a category, say so rather than forcing a suggestion

Respond ONLY with a JSON object — no markdown, no explanation:
{
  "assessment": "2-3 sentence overall read of the portfolio's risk posture vs the benchmark",
  "riskReductions": [
    { "action": "specific change to reduce risk", "evidence": "the report figure(s) motivating it" }
  ],
  "returnEnhancers": [
    { "action": "specific change to improve return WITHOUT raising portfolio risk", "evidence": "the report figure(s) motivating it" }
  ],
  "watchItems": ["short warning to monitor, ≤15 words each"]
}
Provide up to 3 riskReductions, up to 2 returnEnhancers, up to 3 watchItems.`
}

const coerceItem = x => (x && typeof x.action === 'string')
  ? { action: x.action.slice(0, 300), evidence: String(x.evidence || '').slice(0, 300) }
  : null

/**
 * Parse/validate the LLM critique. Returns null when the response is
 * unusable (caller treats as an upstream error).
 */
function parseCritique(raw) {
  const d = tryParseAiJson(raw)
  if (!d || typeof d !== 'object') return null

  const critique = {
    assessment:     typeof d.assessment === 'string' ? d.assessment.slice(0, 600) : '',
    riskReductions: (Array.isArray(d.riskReductions) ? d.riskReductions : []).map(coerceItem).filter(Boolean).slice(0, 3),
    returnEnhancers:(Array.isArray(d.returnEnhancers) ? d.returnEnhancers : []).map(coerceItem).filter(Boolean).slice(0, 2),
    watchItems:     (Array.isArray(d.watchItems) ? d.watchItems : []).filter(x => typeof x === 'string').map(x => x.slice(0, 120)).slice(0, 3),
  }
  if (!critique.assessment && !critique.riskReductions.length) return null
  return critique
}

module.exports = { buildRiskReport, buildCritiquePrompt, parseCritique, HIGH_CORR }
