'use strict'
/**
 * lib/random-timing.js — would random timing with the same exposure have done
 * as well? (idea from vectorbt's random-signal comparisons; written from scratch)
 *
 * "Beats buy & hold" and the deflated Sharpe ask whether a strategy beat
 * holding, and whether that survives the number of strategies tried. Neither
 * asks whether the TIMING mattered. A rule that is long 60% of the time in a
 * rising market can beat a weaker benchmark through exposure alone. This test
 * keeps everything about the strategy except when it traded: the same number
 * of positions, each held for the same number of sessions, the same cost per
 * round trip, the same dividends and cash interest — placed at random,
 * non-overlapping dates. N_DRAWS times. The p-value is the share of random
 * placements that did at least as well (with the +1 correction).
 *
 *   beats-random  p ≤ 0.05 — the timing itself added return
 *   unclear       0.05 < p ≤ 0.5 — better than a typical random placement, not clearly
 *   no-better     p > 0.5 — random timing with the same exposure did as well or better;
 *                 lib/strategy-evidence.js refuses admission on this
 *   insufficient  fewer than MIN_BLOCKS positions — too few to place at random
 *
 * Returns are close to close (dividends added on ex-dates, cash interest on the
 * bars spent out), the SAME rule for the strategy and every random draw, so the
 * comparison is like with like even though it is not the simulator's exact
 * next-open fill. Seeded: the same input always gives the same answer.
 *
 * Tests: tests/random-timing.test.js
 */

const N_DRAWS = 1000
const MIN_BLOCKS = 5

function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (s * 16807) % 2147483647; return s / 2147483647 } }

function hashSeed(str) { let h = 2166136261; for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) } return h >>> 0 }

/** Exposure blocks [start, end) in bar indices of close-to-close returns, from a simulator trade list. */
function blocksFromTrades(trades, timestamps) {
  const days = timestamps.map(t => new Date(t * 1000).toISOString().slice(0, 10))
  const idx = d => { const i = days.indexOf(String(d).slice(0, 10)); return i }
  const out = []
  let open = null, left = 0
  for (const t of trades || []) {
    if (t.type === 'buy') { open = idx(t.date); left = t.shares }
    else if (t.type === 'sell' && open != null && open >= 0) {
      left -= t.shares
      if (left <= 0) {
        const end = t.open ? days.length - 1 : idx(t.date)
        if (end > open) out.push([open + 1, end + 1])   // returns of bars open+1 … end
        open = null
      }
    }
  }
  return out
}

/**
 * The test. `blocks` = exposure intervals [start, end) over bars 1…n−1 (bar i's return is
 * closes[i−1] → closes[i]). Pure and seeded.
 */
function randomTiming({ closes, blocks, dividends = null, cashRates = null, timestamps = null, costBps = 10, draws = N_DRAWS, seed = 1 }) {
  const n = closes.length
  const k = blocks.length
  const base = { draws, positions: k, minPositions: MIN_BLOCKS }
  if (k < MIN_BLOCKS) return { ...base, verdict: 'insufficient', p: null }
  // Log return of each bar held, and of each bar in cash; prefix sums of their difference.
  const held = new Float64Array(n), cash = new Float64Array(n)
  for (let i = 1; i < n; i++) {
    const a = closes[i - 1], b = closes[i]
    held[i] = a > 0 && b > 0 ? Math.log((b + (dividends?.[i] || 0)) / a) : 0
    const days = timestamps ? Math.max(1, Math.round((timestamps[i] - timestamps[i - 1]) / 86_400)) : 1
    const rf = cashRates?.[i - 1] || 0
    cash[i] = rf > 0 ? Math.log(1 + (rf / 100) * (days / 365)) : 0
  }
  const pre = new Float64Array(n + 1), cashTotal = cash.reduce((a, v) => a + v, 0)
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + held[i] - cash[i]
  const cost = Math.log(1 - costBps / 10_000)
  const lens = blocks.map(([s, e]) => e - s)
  const total = lens.reduce((a, v) => a + v, 0)
  const free = (n - 1) - total
  if (free < 0) return { ...base, verdict: 'insufficient', p: null }
  const score = bl => cashTotal + bl.reduce((a, [s, e]) => a + pre[e] - pre[s], 0) + k * cost
  const actual = score(blocks)

  const g = rng(seed)
  let atLeast = 0
  const sample = []
  const order = lens.slice()
  for (let d = 0; d < draws; d++) {
    // Random order of the same block lengths, random gaps summing to `free` (a uniform composition).
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(g() * (i + 1)); [order[i], order[j]] = [order[j], order[i]] }
    const cuts = Array.from({ length: k }, () => Math.floor(g() * (free + 1))).sort((a, b) => a - b)
    let pos = 1, prev = 0, sum = cashTotal + k * cost
    for (let b = 0; b < k; b++) {
      pos += cuts[b] - prev; prev = cuts[b]
      sum += pre[pos + order[b]] - pre[pos]
      pos += order[b]
    }
    if (sum >= actual - 1e-12) atLeast++
    sample.push(sum)
  }
  sample.sort((a, b) => a - b)
  const p = (1 + atLeast) / (draws + 1)
  const pct = v => +((Math.exp(v) - 1) * 100).toFixed(2)
  return {
    ...base,
    exposure: +(total / (n - 1)).toFixed(3),
    strategyReturnPct: pct(actual),
    randomMedianPct: pct(sample[Math.floor(draws / 2)]),
    random95Pct: pct(sample[Math.min(draws - 1, Math.floor(draws * 0.95))]),
    p: +p.toFixed(4),
    verdict: p <= 0.05 ? 'beats-random' : p <= 0.5 ? 'unclear' : 'no-better',
  }
}

/** From a simulator run: blocks from its trades, seeded by what was run. */
function timingFor({ trades, timestamps, closes, dividends, cashRates, costBps, seedKey = '' }) {
  return randomTiming({ closes, blocks: blocksFromTrades(trades, timestamps), dividends, cashRates, timestamps, costBps, seed: hashSeed(`${seedKey}|${closes.length}|${closes[0]}|${closes[closes.length - 1]}`) })
}

module.exports = { N_DRAWS, MIN_BLOCKS, blocksFromTrades, randomTiming, timingFor, hashSeed }
