'use strict'
/**
 * lib/indicator-vote-backtest.js — has the Analyze page's BUY ever paid on
 * this stock, and does its timing beat random days?
 *
 * Replays lib/indicator-vote.js over the history exactly as the page shows it:
 * a BUY on bar i enters at the OPEN of bar i+1, with the card's own levels
 * (stop 2 ATR below bar i's close, target 3 ATR above), and exits at whichever
 * is touched first — a bar that touches both exits at the stop, a bar that
 * opens past a level exits at that open (the paper broker's rules) — or at the
 * close after `maxHold` sessions. One trade at a time; net of the asset's
 * round trip. Long only: a SELL is read as "do not hold", not as a short.
 *
 * Against random timing: the same number of trades, entered on random days
 * (seeded, `draws` times) with the same level rule. p = share of draws whose
 * mean return is at least the rule's (+1 corrected). `beats-random` p ≤ 0.05
 * with a positive mean, `no-better` p > 0.5, else `unclear`; fewer than
 * MIN_TRADES trades is `insufficient`.
 *
 * Tests: tests/indicator-vote.test.js
 */

const iv = require('./indicator-vote')

const MIN_TRADES = 20

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 } }

/** One trade from a signal at bar i with the card's levels. Null when no next bar. */
function tradeFrom(S, i, { maxHold, cost }) {
  const b = S.bars
  if (i + 1 >= b.length || S.atr[i] == null) return null
  const stop = S.close[i] - iv.STOP_ATR * S.atr[i]
  const target = S.close[i] + iv.TARGET_ATR * S.atr[i]
  const entry = b[i + 1].o
  if (!(entry > 0)) return null
  const last = Math.min(b.length - 1, i + maxHold)
  let exit = null, kind = 'time', j = i + 1
  for (; j <= last; j++) {
    const x = b[j]
    if (x.o <= stop) { exit = x.o; kind = 'stop'; break }
    if (x.o >= target) { exit = x.o; kind = 'target'; break }
    if (x.l <= stop) { exit = stop; kind = 'stop'; break }      // both touched → the stop
    if (x.h >= target) { exit = target; kind = 'target'; break }
  }
  if (exit == null) {
    if (i + maxHold > b.length - 1) return null              // window not finished: not an outcome yet
    j = last; exit = b[last].c
  }
  return { at: i, exitAt: j, kind, ret: exit / entry - 1 - cost }
}

const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1)
function wilson(k, n, z = 1.96) {
  if (!n) return [null, null]
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
  return [+((c - m) / d).toFixed(3), +((c + m) / d).toFixed(3)]
}

function backtestVote(bars, { costBps = 10, maxHold = 20, draws = 1000, seed = 7 } = {}) {
  const S = iv.computeSeries(bars)
  const n = S.bars.length
  if (n < iv.MIN_BARS + maxHold + 20) return null
  const cost = costBps / 10_000
  const trades = []
  for (let i = iv.MIN_BARS; i < n - 1; i++) {
    if (iv.voteAt(S, i).verdict !== 'BUY') continue
    const t = tradeFrom(S, i, { maxHold, cost })
    if (!t) continue
    trades.push(t)
    i = t.exitAt          // one position at a time: the next signal is read after the exit
  }
  const k = trades.length
  const rets = trades.map(t => t.ret)
  const count = kind => trades.filter(t => t.kind === kind).length
  const m = mean(rets)
  const sd = k > 1 ? Math.sqrt(rets.reduce((a, r) => a + (r - m) ** 2, 0) / (k - 1)) : null
  const out = {
    bars: n, years: +(n / 252).toFixed(1), maxHold, costBps,
    levels: { stopAtr: iv.STOP_ATR, targetAtr: iv.TARGET_ATR },
    trades: k, targetFirst: count('target'), stopFirst: count('stop'), timeExit: count('time'),
    targetRate: k ? +(count('target') / k).toFixed(3) : null, targetRateCi: wilson(count('target'), k),
    meanNetPct: k ? +(m * 100).toFixed(2) : null, t: sd ? +(m / (sd / Math.sqrt(k))).toFixed(2) : null,
    // Hit rate the 2-ATR stop / 3-ATR target needs to break even, before costs.
    breakEvenRate: +(iv.STOP_ATR / (iv.STOP_ATR + iv.TARGET_ATR)).toFixed(3),
    recent: trades.slice(-10).map(t => ({ date: S.bars[t.at].t ? new Date(S.bars[t.at].t).toISOString().slice(0, 10) : null, kind: t.kind, retPct: +(t.ret * 100).toFixed(2) })),
  }
  // Random days, same count, same level rule.
  const eligible = []
  for (let i = iv.MIN_BARS; i < n - 1 - maxHold; i++) if (S.atr[i] != null) eligible.push(i)
  if (k && eligible.length) {
    const r = rng(seed)
    let atLeast = 0, sumMean = 0, sumTarget = 0
    for (let d = 0; d < draws; d++) {
      let s = 0, tg = 0, cnt = 0
      for (let q = 0; q < k; q++) {
        const t = tradeFrom(S, eligible[Math.floor(r() * eligible.length)], { maxHold, cost })
        if (!t) continue
        s += t.ret; cnt++; if (t.kind === 'target') tg++
      }
      const dm = cnt ? s / cnt : 0
      if (dm >= m) atLeast++
      sumMean += dm; sumTarget += cnt ? tg / cnt : 0
    }
    out.random = { draws, meanNetPct: +((sumMean / draws) * 100).toFixed(2), targetRate: +(sumTarget / draws).toFixed(3) }
    out.p = +((atLeast + 1) / (draws + 1)).toFixed(3)
  }
  out.verdict = k < MIN_TRADES ? 'insufficient'
    : out.p <= 0.05 && m > 0 ? 'beats-random'
      : out.p > 0.5 ? 'no-better' : 'unclear'
  if (out.verdict === 'insufficient') out.reason = `${k} BUY signal${k === 1 ? '' : 's'} completed in ${out.years} years — ${MIN_TRADES} needed`
  out.current = iv.voteAt(S, n - 1)
  return out
}

module.exports = { MIN_TRADES, backtestVote, tradeFrom }
