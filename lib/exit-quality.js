'use strict'

/**
 * lib/exit-quality.js — how well were the levels placed, not just which one hit.
 *
 * The triple-barrier label says whether price reached the target or the stop
 * first. It cannot say whether the stop sat inside ordinary noise (a winner
 * that dipped to within a hair of it first), or whether the target was set
 * past where the move ran out (a loser that got 90% of the way, then reversed).
 * Those are the questions a reader adjusting the levels actually has.
 *
 * Per filled pick, from the fill to the exit:
 *   mfe         best point reached, % from entry (maximum favourable excursion)
 *   mae         worst point reached, % from entry (maximum adverse excursion, ≤0 usually)
 *   realized    % at the exit
 *   giveBack    mfe − realized: what was on the table and not taken
 *   efficiency  realized / mfe, when mfe > 0
 *
 * Rules, each chosen so the numbers cannot flatter the system:
 *   - Only FILLED picks. The window starts on the first bar that traded inside
 *     the entry zone (within the fill window); an unfilled pick is no trade.
 *   - On the fill bar and on the exit bar the intraday order is unknowable from
 *     daily data, so the fill bar contributes only its CLOSE, and the exit bar
 *     only the exit level. Counting the fill bar's high would credit a high
 *     that may have printed before the fill.
 *   - Stop and target inside one bar resolve as the STOP (same rule as
 *     brain-learnings.tripleBarrier). A bar that OPENS past a level exits at
 *     the open — a gap through a stop fills worse than the stop.
 *   - No bars after the fill → a time exit at the fill close; no bars in the
 *     window at all → null (a data gap is not a measured trade).
 *
 * Like the barrier label this is an OUTCOME, so it is never an edge-report
 * dimension (segmenting returns by it is circular). Pure.
 * Tests: tests/exit-quality.test.js
 */

const { wilson } = require('./calibration-stats')

const DAY = 86_400_000
const EXIT_VERSION = 1
const FILL_WINDOW_DAYS = 7

const r2 = x => (Number.isFinite(x) ? +x.toFixed(2) : null)

/**
 * @param {Array<{t,o,h,l,c}>} bars  daily bars, any order
 * @param {object} o
 * @param {number} o.from      generation time (ms)
 * @param {number} o.to        end of the holding window (ms)
 * @param {number} o.entry     entry price (the anchor the levels were built from)
 * @param {number} o.target    target PRICE
 * @param {number} o.stop      stop PRICE
 * @param {number} [o.zoneLow] entry zone; omit both for a fill at generation
 * @param {number} [o.zoneHigh]
 * @param {boolean} [o.long=true]
 * @returns {null | {filled:false} | {filled:true, ...}}
 */
function measureExit(bars, { from, to, entry, target, stop, zoneLow = null, zoneHigh = null, long = true, fillWindowDays = FILL_WINDOW_DAYS } = {}) {
  if (!(entry > 0) || !(target > 0) || !(stop > 0)) return null
  if (long ? !(target > stop) : !(target < stop)) return null
  const win = (bars || []).filter(b => b && b.c != null && b.t >= from && b.t <= to).sort((a, b) => a.t - b.t)
  if (!win.length) return null

  const hi = b => b.h ?? b.c
  const lo = b => b.l ?? b.c
  const pct = px => (long ? (px - entry) / entry : (entry - px) / entry) * 100

  // ── fill ────────────────────────────────────────────────────────────────
  let fillIdx = 0
  if (zoneLow != null && zoneHigh != null) {
    const until = from + fillWindowDays * DAY
    fillIdx = win.findIndex(b => b.t <= until && lo(b) <= zoneHigh && hi(b) >= zoneLow)
    if (fillIdx === -1) return { filled: false }
  }
  const fillBar = win[fillIdx]

  // ── walk to the exit ────────────────────────────────────────────────────
  let mfe = pct(fillBar.c), mae = pct(fillBar.c)
  let mfeAt = fillBar.t
  let curT = fillBar.t
  const favour = px => { const p = pct(px); if (p > mfe) { mfe = p; mfeAt = curT } }
  const adverse = px => { const p = pct(px); if (p < mae) mae = p }
  let exit = null

  for (let i = fillIdx + 1; i < win.length; i++) {
    const b = win[i]
    curT = b.t
    const open = b.o ?? b.c
    const hitStop   = long ? lo(b) <= stop   : hi(b) >= stop
    const hitTarget = long ? hi(b) >= target : lo(b) <= target
    if (hitStop) {
      const gapped = long ? open <= stop : open >= stop
      const px = gapped ? open : stop
      adverse(px)
      exit = { reason: 'stop', at: b.t, px }
      break
    }
    if (hitTarget) {
      const gapped = long ? open >= target : open <= target
      const px = gapped ? open : target
      favour(px)
      exit = { reason: 'target', at: b.t, px }
      break
    }
    favour(long ? hi(b) : lo(b))
    adverse(long ? lo(b) : hi(b))
  }
  if (!exit) {
    const last = win[win.length - 1]
    exit = { reason: 'time', at: last.t, px: last.c }
  }

  const realized = pct(exit.px)
  return {
    filled:     true,
    fillAt:     fillBar.t,
    exitAt:     exit.at,
    exitReason: exit.reason,
    mfe:        r2(mfe),
    mae:        r2(mae),
    realized:   r2(realized),
    giveBack:   r2(mfe - realized),
    efficiency: mfe > 0 ? r2(realized / mfe) : null,
    daysToMfe:  Math.round((mfeAt - fillBar.t) / DAY),
    daysHeld:   Math.round((exit.at - fillBar.t) / DAY),
    targetPct:  r2(pct(target)),
    stopPct:    r2(-pct(stop)),     // distance to the stop, positive
  }
}

const median = xs => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return r2(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2)
}

function rateWithCi(k, n) {
  if (!(n > 0)) return null
  const { lo, hi } = wilson(k, n)
  return { rate: +(k / n).toFixed(3), k, n, lo, hi }
}

/**
 * Aggregate over prediction records carrying `exit` (from measureExit) at the
 * current EXIT_VERSION. Below `minN` filled exits it reports only the count —
 * a median of eight trades is an anecdote, and it would be injected into the
 * scan prompt as if it were a finding.
 */
function summarizeExitQuality(records, { minN = 30, segmentMin = 10 } = {}) {
  const current = (records || []).filter(r => r.exitV === EXIT_VERSION && r.exit)
  const rows = current.filter(r => r.exit.filled)
  const unfilled = current.filter(r => r.exit.filled === false).length
  const n = rows.length
  if (n < minN) {
    return { n, unfilled, ready: false, reason: `${n} filled pick(s) with a completed exit — need ${minN} before exit quality means anything` }
  }
  const x = rows.map(r => r.exit)

  // Winners that came within 20% of the stop first: the stop sat in the noise.
  const winners = x.filter(e => e.realized > 0)
  const nearStop = winners.filter(e => e.stopPct > 0 && -e.mae >= 0.8 * e.stopPct).length
  // Exits short of the target after getting 80% of the way: the target sat past the move.
  const missed = x.filter(e => e.exitReason !== 'target')
  const nearMiss = missed.filter(e => e.targetPct > 0 && e.mfe >= 0.8 * e.targetPct).length
  // Stop-outs that had been halfway to target — what booking a partial at T1
  // (lib/trade-levels.js books T1 halfway) would have saved.
  const stopped = x.filter(e => e.exitReason === 'stop')
  const halfway = stopped.filter(e => e.targetPct > 0 && e.mfe >= 0.5 * e.targetPct).length

  const segment = keyOf => {
    const groups = {}
    for (const r of rows) {
      const k = keyOf(r)
      if (!k) continue
      ;(groups[k] ||= []).push(r.exit)
    }
    const out = {}
    for (const [k, es] of Object.entries(groups)) {
      if (es.length < segmentMin) continue
      out[k] = { n: es.length, medianEfficiency: median(es.map(e => e.efficiency)), medianGiveBack: median(es.map(e => e.giveBack)) }
    }
    return Object.keys(out).length ? out : null
  }

  return {
    n, unfilled, ready: true,
    medianMfe:        median(x.map(e => e.mfe)),
    medianMae:        median(x.map(e => e.mae)),
    medianRealized:   median(x.map(e => e.realized)),
    medianGiveBack:   median(x.map(e => e.giveBack)),
    medianEfficiency: median(x.map(e => e.efficiency)),
    medianDaysToMfe:  median(x.map(e => e.daysToMfe)),
    exits: {
      target: x.filter(e => e.exitReason === 'target').length,
      stop:   stopped.length,
      time:   x.filter(e => e.exitReason === 'time').length,
    },
    winnersNearStop:     rateWithCi(nearStop, winners.length),
    targetNearMiss:      rateWithCi(nearMiss, missed.length),
    stoppedAfterHalfway: rateWithCi(halfway, stopped.length),
    byAssetType:  segment(r => (r.assetType === 'equity' ? 'stock' : r.assetType) || null),
    byConfidence: segment(r => r.confidence || null),
  }
}

/** One prompt line, or '' until the summary is ready. Measured figures only. */
function exitQualityLine(eq) {
  if (!eq?.ready) return ''
  const pc = v => (v == null ? 'n/a' : `${(v * 100).toFixed(0)}%`)
  const ci = d => (d ? `${pc(d.rate)} [${pc(d.lo)}–${pc(d.hi)}], n=${d.n}` : 'n/a')
  return [
    `EXIT QUALITY (${eq.n} filled picks, fill → exit; measured, not estimated):`,
    `  median best point ${eq.medianMfe}% · worst point ${eq.medianMae}% · realized ${eq.medianRealized}% · given back ${eq.medianGiveBack}% · efficiency ${eq.medianEfficiency ?? 'n/a'}`,
    `  winners that first came within 20% of their stop: ${ci(eq.winnersNearStop)} — high means stops sit inside normal noise`,
    `  non-target exits that reached 80% of the target: ${ci(eq.targetNearMiss)} — high means targets sit past where moves run out`,
    `  stop-outs that had been halfway to target: ${ci(eq.stoppedAfterHalfway)} — what booking a partial at T1 would have saved`,
  ].join('\n')
}

module.exports = { measureExit, summarizeExitQuality, exitQualityLine, EXIT_VERSION, FILL_WINDOW_DAYS }
