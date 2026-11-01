'use strict'
/**
 * Slate diversification — how a whole list of picks behaves together.
 *
 * Ten picks that all move with the same driver are one bet taken ten times.
 * From the daily returns the scan already fetched:
 *   - a Hierarchical Risk Parity split (lib/hrp.js), so correlated picks share
 *     one risk budget instead of each taking a full one;
 *   - the pairs that move together (correlation ≥ RHO_FLAG on common dates),
 *     named on each card ("moves with NVDA 0.86");
 *   - the effective number of independent bets: (Σw)² / ΣΣ wᵢwⱼρᵢⱼ for an
 *     equal-weight slate — 10 picks with average correlation 0.8 is about 1.2.
 * Context only; nothing here drops or resizes a pick. Pure.
 * Tests: tests/slate-diversify.test.js
 */

const hrp = require('./hrp')

const RHO_FLAG = 0.8

function correlation(returns) {
  const cov = hrp.covariance(returns)
  const sd = cov.map((row, i) => Math.sqrt(row[i]))
  return cov.map((row, i) => row.map((c, j) => (sd[i] > 0 && sd[j] > 0 ? c / (sd[i] * sd[j]) : 0)))
}

/**
 * @param {Object<string, Array<{t,c}>>} barsBySymbol  daily bars per pick
 * @param {object} [o]
 * @param {number} [o.lookbackDays=183]  calendar days of history used (the HRP window)
 */
function diversify(barsBySymbol, { lookbackDays = 183, rhoFlag = RHO_FLAG } = {}) {
  const trimmed = {}
  for (const [s, b] of Object.entries(barsBySymbol || {})) {
    if (!Array.isArray(b) || !b.length) continue
    const lastT = b[b.length - 1].t
    const w = b.filter(x => x.t >= lastT - lookbackDays * 864e5)
    if (w.length > hrp.MIN_OBS) trimmed[s] = w
  }
  const aligned = hrp.alignReturns(trimmed)
  if (aligned.symbols.length < 2 || aligned.returns.length < hrp.MIN_OBS) return null
  const rho = correlation(aligned.returns)
  const n = aligned.symbols.length
  const pairs = {}
  let sum = 0
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      sum += rho[i][j]
      if (i !== j && rho[i][j] >= rhoFlag) {
        (pairs[aligned.symbols[i]] ||= []).push({ symbol: aligned.symbols[j], rho: +rho[i][j].toFixed(2) })
      }
    }
  }
  for (const s of Object.keys(pairs)) pairs[s].sort((a, b) => b.rho - a.rho)
  const result = hrp.hrpWeights(aligned)
  const offDiag = n > 1 ? (sum - n) / (n * (n - 1)) : 0
  return {
    symbols: aligned.symbols, observations: aligned.returns.length,
    weights: result?.weights ?? null, order: result?.order ?? null,
    movesWith: pairs,
    avgCorrelation: +offDiag.toFixed(2),
    effectiveBets: +((n * n) / sum).toFixed(1),
    excluded: Object.keys(barsBySymbol || {}).filter(s => !aligned.symbols.includes(s)),
  }
}

module.exports = { diversify, correlation, RHO_FLAG }
