'use strict'
/**
 * lib/expected-value.js — cost-aware expected value, and the ability to abstain.
 *
 * The Advisory prompt asks the model for a FIXED number of picks (20–22). That
 * guarantees a full slate every run whether or not the market is offering that
 * many ideas worth acting on — the system has no way to say "nothing here".
 *
 * This module supplies the missing judgement, deterministically and in code:
 * every pick is scored on its own reward/risk against an EMPIRICAL win
 * probability and a realistic round-trip trading cost, and picks whose net
 * expected edge doesn't clear a floor are rejected. Same division of labour as
 * the rest of the repo — the LLM proposes, measured math judges. The model is
 * never told how many picks will survive, so it can't game the gate.
 *
 * Costs are per asset class because they differ by an order of magnitude:
 * a liquid US equity or ETF round-trips for a few basis points of spread,
 * a mid-cap altcoin for well over half a percent once taker fees and spread
 * are paid on both sides. A 6% target is a real trade in an ETF and noise in
 * a small crypto — only a cost-aware EV can tell those apart.
 *
 * THE KEY IDENTITY. A win nets (W − c) and a loss costs (L + c), so
 *
 *     p(W − c) − q(L + c)  ≡  pW − qL − c
 *
 * i.e. charging the cost to the payoffs and subtracting it from the gross edge
 * are the same number. That means the EV reported here and the Kelly size
 * derived from the same adjusted payoffs can never disagree — one cost model,
 * applied once, consistent across the gate and the sizing.
 *
 * Pure functions, no I/O, no deps beyond lib/kelly. Tests: tests/expected-value.test.js
 */

const { edge: kellyEdge } = require('./kelly')

/**
 * Round-trip friction in basis points (entry + exit), by asset class.
 *
 * Deliberately conservative — a gate that understates costs lets through
 * exactly the marginal picks it exists to reject. Retail US equities and ETFs
 * are commission-free at the major brokers, so this is spread plus expected
 * slippage. Crypto pays real taker fees (~10bps/side on a major venue) on top
 * of a materially wider spread, and the AI Brain's crypto universes include
 * mid-caps well outside BTC/ETH liquidity.
 */
const ROUND_TRIP_BPS = {
  stock:  10,   // ~5bps spread+slippage per side on liquid US equities
  etf:     8,   // tighter than single names on the major index/sector ETFs
  fund:   10,   // NAV execution, no spread — covers short-term redemption drag
  crypto: 60,   // ~10bps/side taker + spread; alts are worse than BTC/ETH
}
const DEFAULT_BPS = 20   // unknown asset class → assume worse than equities

/** Minimum net expected edge per unit risked for a pick to be actionable (50bps). */
const MIN_NET_EDGE = 0.005

/** Map any of the labels used across the app to a ROUND_TRIP_BPS key. */
function normalizeAssetType(type) {
  const t = String(type || '').trim().toLowerCase()
  if (t === 'crypto' || t === 'cryptocurrency' || t === 'digital asset') return 'crypto'
  if (t === 'etf') return 'etf'
  if (t === 'fund' || t === 'mutual fund' || t === 'mutualfund') return 'fund'
  // 'equity' is the legacy AI-Brain label for a plain stock (see computeStats)
  if (t === 'stock' || t === 'equity') return 'stock'
  return null
}

/** Round-trip cost as a fraction of position value (e.g. 0.006 = 60bps). */
function roundTripCost(assetType) {
  const key = normalizeAssetType(assetType)
  return (key ? ROUND_TRIP_BPS[key] : DEFAULT_BPS) / 10_000
}

/**
 * Win probability at which a trade exactly breaks even after costs:
 * p(W − c) = (1 − p)(L + c)  ⇒  p* = (L + c) / ((W − c) + (L + c)).
 *
 * The single most useful number here for research: it converts an opinion
 * ("this looks good") into a testable claim ("this needs a 38% hit rate"),
 * which can then be checked against the measured win rate for that asset class.
 * Returns null when the target can't clear costs at all (netWin ≤ 0), because
 * then no win probability — not even 100% — makes the trade profitable.
 */
function breakEvenWinProb(winFrac, lossFrac, cost = 0) {
  const netWin  = winFrac - cost
  const netLoss = lossFrac + cost
  if (!(netWin > 0) || !(netLoss > 0)) return null
  return netLoss / (netWin + netLoss)
}

/**
 * Score one candidate trade net of costs.
 *
 * @param {object}  o
 * @param {number}  o.winProb       empirical win probability (0–1)
 * @param {number}  o.targetReturn  upside in PERCENT (e.g. 20 for +20%)
 * @param {number}  o.stopLoss      downside in PERCENT (e.g. 10 for −10%)
 * @param {string} [o.assetType]    Stock | ETF | Crypto | Fund (case-insensitive)
 * @param {number} [o.minNetEdge]   actionability floor, default MIN_NET_EDGE
 * @returns {object|null} null when the inputs aren't a scoreable trade
 */
function evaluateTrade({ winProb, targetReturn, stopLoss, assetType = null, minNetEdge = MIN_NET_EDGE }) {
  const W = Number(targetReturn) / 100
  const L = Number(stopLoss) / 100
  if (!(W > 0) || !(L > 0) || !(winProb >= 0 && winProb <= 1)) return null

  const cost    = roundTripCost(assetType)
  const netWin  = W - cost
  const netLoss = L + cost

  // Gross edge ignores friction — reported alongside net so the cost drag is
  // visible rather than silently folded in.
  const grossEdge = kellyEdge(winProb, W, L)
  const netEdge   = grossEdge - cost
  const breakEven = breakEvenWinProb(W, L, cost)

  let verdict, reason
  if (!(netWin > 0)) {
    verdict = 'reject'
    reason  = `target +${(W * 100).toFixed(1)}% does not clear ${(cost * 100).toFixed(2)}% round-trip cost`
  } else if (netEdge <= 0) {
    verdict = 'reject'
    reason  = `negative expected value after costs (needs a ${(breakEven * 100).toFixed(0)}% win rate, calibrated at ${(winProb * 100).toFixed(0)}%)`
  } else if (netEdge < minNetEdge) {
    verdict = 'thin'
    reason  = `edge ${(netEdge * 100).toFixed(2)}% below the ${(minNetEdge * 100).toFixed(2)}% floor`
  } else {
    verdict = 'act'
    reason  = `+${(netEdge * 100).toFixed(2)}% expected per unit risked after ${(cost * 100).toFixed(2)}% costs`
  }

  return {
    assetType:        normalizeAssetType(assetType),
    costPct:          +(cost * 100).toFixed(3),
    winProb:          +winProb.toFixed(3),
    grossEdge:        +grossEdge.toFixed(4),
    netEdge:          +netEdge.toFixed(4),
    // Payoffs charged for friction — hand these to Kelly so size and EV agree.
    netWinFrac:       +netWin.toFixed(6),
    netLossFrac:      +netLoss.toFixed(6),
    breakEvenWinProb: breakEven != null ? +breakEven.toFixed(3) : null,
    // Positive = measured hit rate clears what this pick's payoff structure
    // demands. The honest version of "high conviction".
    winProbMargin:    breakEven != null ? +(winProb - breakEven).toFixed(3) : null,
    minNetEdge,
    actionable:       verdict === 'act',
    verdict,
    reason,
  }
}

module.exports = {
  ROUND_TRIP_BPS, DEFAULT_BPS, MIN_NET_EDGE,
  normalizeAssetType, roundTripCost, breakEvenWinProb, evaluateTrade,
}
