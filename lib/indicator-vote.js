'use strict'
/**
 * lib/indicator-vote.js — the Analyze page's single indicator verdict.
 *
 * The page used to show two verdicts from two rule sets: an "AI Signal" (no AI
 * involved) that said BUY with "4 of 4 indicators agreeing", and a "Technical
 * Signal" that said Hold, on the same chart. The 4 of 4 was three readings of
 * the SAME uptrend (Supertrend, Ichimoku cloud, Kijun line) plus a "healthy
 * RSI", and indicators with no opinion were left out of the count.
 *
 * Now one vote, four independent questions, each one vote:
 *   trend      Supertrend, Ichimoku cloud, Kijun line, price vs the 20/50-day
 *              averages, 20-day vs 50-day average — ONE vote: up when at least
 *              two thirds of the components that have a view say up (ADX is
 *              shown as the trend's strength, not counted)
 *   momentum   MACD above its signal line and above zero (or both below)
 *   RSI        below 30 oversold (for) / above 70 overbought (against)
 *   Bollinger  close below the lower band (for) / above the upper (against)
 * An indicator with no view is shown as "no opinion", never dropped from the
 * count. BUY when votes for − votes against ≥ 2, SELL when against − for ≥ 2,
 * else HOLD. Fixed in advance; never tuned on outcomes.
 *
 * A BUY carries the levels the page has always shown — stop 2 ATR below the
 * close, target 3 ATR above — so the backtest (lib/indicator-vote-backtest.js)
 * tests exactly what the page shows.
 *
 * Every series value at bar i reads bars ≤ i (pinned by a test), so the same
 * code drives the browser card and the walk-forward backtest.
 * Pure, no requires — shared with the browser via tools/vite-shared-cjs.mjs.
 * Tests: tests/indicator-vote.test.js
 */

const STOP_ATR = 2
const TARGET_ATR = 3
const MIN_BARS = 80          // 52-day Ichimoku span shifted 26 sessions forward

const num = x => (x == null || !Number.isFinite(+x) ? null : +x)
function normalize(bars) {
  return (bars || []).map(b => ({
    t: b.t ?? b.time ?? null,
    o: num(b.o ?? b.open), h: num(b.h ?? b.high), l: num(b.l ?? b.low), c: num(b.c ?? b.close),
  })).filter(b => b.c != null && b.c > 0).map(b => ({ ...b, h: b.h ?? b.c, l: b.l ?? b.c, o: b.o ?? b.c }))
}

function sma(xs, n) {
  const out = new Array(xs.length).fill(null)
  let s = 0
  for (let i = 0; i < xs.length; i++) {
    s += xs[i]
    if (i >= n) s -= xs[i - n]
    if (i >= n - 1) out[i] = s / n
  }
  return out
}
function ema(xs, n, from = 0) {
  const out = new Array(xs.length).fill(null)
  const k = 2 / (n + 1)
  let prev = null, seed = 0, cnt = 0
  for (let i = from; i < xs.length; i++) {
    if (xs[i] == null) continue
    if (prev == null) { seed += xs[i]; cnt++; if (cnt === n) { prev = seed / n; out[i] = prev } continue }
    prev = xs[i] * k + prev * (1 - k); out[i] = prev
  }
  return out
}
function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null)
  let g = 0, l = 0
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    const up = Math.max(d, 0), dn = Math.max(-d, 0)
    if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l) } continue }
    g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l)
  }
  return out
}
function atr(b, n = 14) {
  const out = new Array(b.length).fill(null)
  let a = null, s = 0
  for (let i = 1; i < b.length; i++) {
    const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c))
    if (i <= n) { s += tr; if (i === n) { a = s / n; out[i] = a } continue }
    a = (a * (n - 1) + tr) / n; out[i] = a
  }
  return out
}
function supertrend(b, at, mult = 3) {
  const dir = new Array(b.length).fill(null)
  let upper = null, lower = null, d = 1
  for (let i = 0; i < b.length; i++) {
    if (at[i] == null) continue
    const mid = (b[i].h + b[i].l) / 2
    const bu = mid + mult * at[i], bl = mid - mult * at[i]
    const prevC = i > 0 ? b[i - 1].c : b[i].c
    upper = upper == null || bu < upper || prevC > upper ? bu : upper
    lower = lower == null || bl > lower || prevC < lower ? bl : lower
    if (d === 1 && b[i].c < lower) d = -1
    else if (d === -1 && b[i].c > upper) d = 1
    dir[i] = d
  }
  return dir
}
function midRange(b, i, n) {
  if (i < n - 1) return null
  let hi = -Infinity, lo = Infinity
  for (let k = i - n + 1; k <= i; k++) { hi = Math.max(hi, b[k].h); lo = Math.min(lo, b[k].l) }
  return (hi + lo) / 2
}
function adx(b, n = 14) {
  const out = new Array(b.length).fill(null)
  let trS = 0, pS = 0, mS = 0, dxs = [], a = null
  for (let i = 1; i < b.length; i++) {
    const upMove = b[i].h - b[i - 1].h, dnMove = b[i - 1].l - b[i].l
    const p = upMove > dnMove && upMove > 0 ? upMove : 0
    const m = dnMove > upMove && dnMove > 0 ? dnMove : 0
    const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c))
    if (i <= n) { trS += tr; pS += p; mS += m; if (i < n) continue }
    else { trS = trS - trS / n + tr; pS = pS - pS / n + p; mS = mS - mS / n + m }
    const pdi = trS ? 100 * pS / trS : 0, mdi = trS ? 100 * mS / trS : 0
    const dx = pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0
    if (a == null) { dxs.push(dx); if (dxs.length === n) { a = dxs.reduce((x, y) => x + y, 0) / n; out[i] = a } }
    else { a = (a * (n - 1) + dx) / n; out[i] = a }
  }
  return out
}

/** Every indicator series once, over the whole history. Each value at i reads bars ≤ i. */
function computeSeries(rawBars) {
  const b = normalize(rawBars)
  const c = b.map(x => x.c)
  const at = atr(b)
  const e12 = ema(c, 12), e26 = ema(c, 26)
  const macd = c.map((_, i) => (e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null))
  const firstMacd = macd.findIndex(x => x != null)
  const sig = firstMacd < 0 ? macd.map(() => null) : ema(macd, 9, firstMacd)
  const s20 = sma(c, 20), s50 = sma(c, 50)
  const sd20 = c.map((_, i) => {
    if (i < 19) return null
    const m = s20[i]; let v = 0
    for (let k = i - 19; k <= i; k++) v += (c[k] - m) ** 2
    return Math.sqrt(v / 20)
  })
  const tenkan = b.map((_, i) => midRange(b, i, 9)), kijun = b.map((_, i) => midRange(b, i, 26))
  // The cloud drawn at bar i was computed 26 sessions earlier — known at i.
  const spanA = b.map((_, i) => (i >= 26 && tenkan[i - 26] != null && kijun[i - 26] != null ? (tenkan[i - 26] + kijun[i - 26]) / 2 : null))
  const spanB = b.map((_, i) => (i >= 26 ? midRange(b, i - 26, 52) : null))
  return { bars: b, close: c, atr: at, st: supertrend(b, at), rsi: rsi(c), macd, sig, s20, s50, sd20, kijun, spanA, spanB, adx: adx(b) }
}

const v = x => (x > 0 ? 1 : x < 0 ? -1 : 0)
const round = (x, d = 2) => (x == null ? null : +x.toFixed(d))

/** The vote at bar i. Pure. */
function voteAt(S, i) {
  const px = S.close[i]
  const comps = []
  const add = (name, val, detail) => comps.push({ name, vote: val, detail })
  if (S.st[i] != null) add('Supertrend', S.st[i], S.st[i] > 0 ? 'bullish' : 'bearish')
  if (S.spanA[i] != null && S.spanB[i] != null) {
    const top = Math.max(S.spanA[i], S.spanB[i]), bot = Math.min(S.spanA[i], S.spanB[i])
    add('Ichimoku cloud', px > top ? 1 : px < bot ? -1 : 0, px > top ? 'price above the cloud' : px < bot ? 'price below the cloud' : 'price inside the cloud')
  }
  if (S.kijun[i] != null) add('Kijun line', v(px - S.kijun[i]), px > S.kijun[i] ? 'price above' : 'price below')
  if (S.s20[i] != null && S.s50[i] != null) {
    add('Price vs 20/50-day averages', px > S.s20[i] && px > S.s50[i] ? 1 : px < S.s20[i] && px < S.s50[i] ? -1 : 0, px > S.s20[i] && px > S.s50[i] ? 'above both' : px < S.s20[i] && px < S.s50[i] ? 'below both' : 'between them')
    add('20-day vs 50-day average', v(S.s20[i] - S.s50[i]), S.s20[i] > S.s50[i] ? '20-day above' : '20-day below')
  }
  const withView = comps.filter(x => x.vote !== 0)
  const ups = withView.filter(x => x.vote > 0).length, downs = withView.length - ups
  const trendVote = withView.length && ups >= (2 / 3) * withView.length ? 1 : withView.length && downs >= (2 / 3) * withView.length ? -1 : 0
  const adxV = S.adx[i]

  const votes = [{
    name: 'Trend', vote: trendVote,
    detail: `${ups} of ${comps.length} trend readings up, ${downs} down${adxV != null ? ` · ADX ${Math.round(adxV)} (${adxV >= 25 ? 'strong' : adxV < 20 ? 'weak' : 'moderate'} trend)` : ''}`,
    components: comps,
  }]
  const m = S.macd[i], sg = S.sig[i]
  votes.push({ name: 'Momentum (MACD)', vote: m != null && sg != null ? (m > sg && m > 0 ? 1 : m < sg && m < 0 ? -1 : 0) : 0,
    detail: m == null || sg == null ? 'not enough history' : m > sg && m > 0 ? 'above its signal line and zero' : m < sg && m < 0 ? 'below its signal line and zero' : 'mixed — no opinion' })
  const r = S.rsi[i]
  votes.push({ name: 'RSI', vote: r == null ? 0 : r < 30 ? 1 : r > 70 ? -1 : 0, detail: r == null ? 'not enough history' : `${Math.round(r)} — ${r < 30 ? 'oversold' : r > 70 ? 'overbought' : 'between 30 and 70, no opinion'}` })
  const lo = S.s20[i] != null ? S.s20[i] - 2 * S.sd20[i] : null, hi = S.s20[i] != null ? S.s20[i] + 2 * S.sd20[i] : null
  votes.push({ name: 'Bollinger bands', vote: lo == null ? 0 : px < lo ? 1 : px > hi ? -1 : 0, detail: lo == null ? 'not enough history' : px < lo ? 'close below the lower band' : px > hi ? 'close above the upper band' : 'inside the bands, no opinion' })

  const forN = votes.filter(x => x.vote > 0).length, against = votes.filter(x => x.vote < 0).length
  const verdict = forN - against >= 2 ? 'BUY' : against - forN >= 2 ? 'SELL' : 'HOLD'
  const a = S.atr[i]
  const out = { verdict, for: forN, against, noOpinion: votes.length - forN - against, total: votes.length, votes, price: round(px), atr: round(a, 4), adx: round(adxV, 1) }
  if (a != null && verdict === 'BUY') Object.assign(out, { stop: round(px - STOP_ATR * a), target: round(px + TARGET_ATR * a), riskReward: TARGET_ATR / STOP_ATR })
  if (a != null && verdict === 'SELL') Object.assign(out, { stop: round(px + STOP_ATR * a), target: round(px - TARGET_ATR * a), riskReward: TARGET_ATR / STOP_ATR })
  return out
}

/** The vote on the latest bar; null below MIN_BARS. */
function indicatorVote(bars) {
  const S = computeSeries(bars)
  if (S.bars.length < MIN_BARS) return null
  return voteAt(S, S.bars.length - 1)
}

module.exports = { STOP_ATR, TARGET_ATR, MIN_BARS, computeSeries, voteAt, indicatorVote, normalize }
