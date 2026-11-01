'use strict'
/**
 * lib/quant/vrp.js — the variance risk premium: is implied volatility above the volatility that then happens?
 *
 * Long gamma pays theta; the edge (or the loss) is the gap between the implied vol you paid and the realised vol you
 * got. Historically index implied vol has sat ABOVE subsequent realised vol most of the time — that premium is the
 * insurance option sellers are paid for crash risk, and it is negative exactly when markets break.
 *
 *   vrpHistory    S&P 500 implied vol (VIX, from FRED's keyless CSV — series VIXCLS) against the realised vol of the
 *                 NEXT `horizon` sessions of SPY. Realised vol is √(252/h · Σ r²) (zero-mean, the variance-swap
 *                 convention). Only past data is used to label day t's implied; the realised side is the future by
 *                 construction, so the last `horizon` days have no label yet.
 *   vrpSnapshot   today's implied vol (VIX for SPY, or the user's) against forecasts of realised vol over the horizon:
 *                 GARCH (average of its variance path), HAR, EWMA, Yang–Zhang and the trailing realised.
 * Tests: tests/quant-vrp.test.js
 */
const L = require('./linalg')
const V = require('./volatility')

const FRED_CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv'
const day = t => new Date(t).toISOString().slice(0, 10)

/** FRED CSV → [{ date, value }], dropping FRED's '.' placeholders for missing days. */
function parseFredCsv(text) {
  const out = []
  for (const line of String(text).split(/\r?\n/).slice(1)) {
    const [date, v] = line.split(','); const x = Number(v)
    if (/^\d{4}-\d{2}-\d{2}$/.test(date || '') && v !== '.' && Number.isFinite(x)) out.push({ date, value: x })
  }
  return out
}

let _vixCache = null
/** VIX daily closes from FRED (keyless). Cached 12h. */
async function fetchVix({ start = '2015-01-01', fetchImpl = fetch } = {}) {
  if (_vixCache && Date.now() - _vixCache.t < 12 * 3600_000 && _vixCache.start <= start) return _vixCache.rows.filter(r => r.date >= start)
  const r = await fetchImpl(`${FRED_CSV}?id=VIXCLS&cosd=${start}`, { signal: AbortSignal.timeout(20_000) })
  if (!r.ok) throw new Error(`FRED answered HTTP ${r.status} for VIXCLS`)
  const rows = parseFredCsv(await r.text())
  if (rows.length < 100) throw new Error('FRED returned too little VIX history')
  _vixCache = { t: Date.now(), start, rows }
  return rows
}

/** Implied (VIX/100 on day t) vs realised vol of the next `horizon` sessions, for every labelled day. */
function vrpHistory(bars, vix, { horizon = 21 } = {}) {
  const vmap = new Map(vix.map(v => [v.date, v.value / 100]))
  const b = bars.filter(x => x.c > 0), dates = b.map(x => day(x.t)), r = b.map((x, i) => (i ? Math.log(x.c / b[i - 1].c) : 0))
  const rows = []
  for (let i = 0; i + horizon < b.length; i++) {
    const iv = vmap.get(dates[i]); if (iv == null) continue
    let s = 0; for (let k = i + 1; k <= i + horizon; k++) s += r[k] * r[k]
    const rv = Math.sqrt(252 / horizon * s)
    rows.push({ date: dates[i], implied: iv, realized: rv, vrp: iv - rv, vrpVar: iv * iv - rv * rv })
  }
  if (rows.length < 60) throw new Error(`only ${rows.length} days have both an implied vol and ${horizon} later sessions; need 60`)
  const v = rows.map(x => x.vrp), sorted = [...v].sort((a, c) => a - c), worst = rows.reduce((a, c) => (c.vrp < a.vrp ? c : a))
  const buckets = [['VIX < 15', 0, 0.15], ['15–20', 0.15, 0.2], ['20–30', 0.2, 0.3], ['VIX ≥ 30', 0.3, 9]].map(([label, lo, hi]) => {
    const g = rows.filter(x => x.implied >= lo && x.implied < hi)
    return { regime: label, days: g.length, meanVrp: g.length ? L.mean(g.map(x => x.vrp)) : null, shareImpliedAbove: g.length ? g.filter(x => x.vrp > 0).length / g.length : null }
  })
  return {
    horizon, days: rows.length, from: rows[0].date, to: rows[rows.length - 1].date,
    meanVrp: L.mean(v), medianVrp: sorted[Math.floor(sorted.length / 2)], shareImpliedAbove: v.filter(x => x > 0).length / v.length,
    meanImplied: L.mean(rows.map(x => x.implied)), meanRealized: L.mean(rows.map(x => x.realized)),
    worst: { date: worst.date, vrp: worst.vrp, implied: worst.implied, realized: worst.realized },
    byRegime: buckets, series: rows.filter((_, i) => i % Math.max(1, Math.floor(rows.length / 400)) === 0),
    note: 'Implied above realised most days is the premium option sellers collect; the worst days show what it insures against. Overlapping 21-day windows: the share is descriptive, not an independent count.',
  }
}

/** Today's implied vol against forecasts of realised vol over the horizon. impliedVol as a decimal (0.18). */
function vrpSnapshot(bars, { impliedVol, horizon = 21 } = {}) {
  if (!(impliedVol > 0 && impliedVol < 5)) throw new Error('impliedVol must be a decimal between 0 and 5 (e.g. 0.18)')
  const c = bars.map(x => x.c).filter(x => x > 0), r = L.logReturnsOf(c)
  if (r.length < 120) throw new Error('need at least 120 days of history')
  const forecasts = {}
  try { const g = V.garch11(r, { horizon }); forecasts.garch = Math.sqrt(L.mean(g.forecast.map(f => f * f))) } catch (e) { forecasts.garchError = e.message }
  try { forecasts.har = V.harRv(r).nextDayVol } catch { /* too short */ }
  const ew = V.ewmaVol(r); forecasts.ewma = ew[ew.length - 1]
  forecasts.yangZhang = V.yangZhang(bars.slice(-horizon - 1))
  forecasts.trailing = Math.sqrt(252 / horizon * r.slice(-horizon).reduce((a, x) => a + x * x, 0))
  const vals = ['garch', 'har', 'ewma', 'yangZhang', 'trailing'].map(k => forecasts[k]).filter(x => Number.isFinite(x)).sort((a, b) => a - b)
  const consensus = vals[Math.floor(vals.length / 2)], vrp = impliedVol - consensus
  return {
    impliedVol, horizon, forecasts, consensusRealized: consensus, vrp, vrpVariance: impliedVol ** 2 - consensus ** 2,
    verdict: vrp > 0.03 ? 'Implied is well above forecast realised: options look rich (long gamma is likely to bleed; short vol carries crash risk).'
      : vrp < -0.02 ? 'Implied is BELOW forecast realised: options look cheap — long gamma has a positive expected edge if the forecast is right.'
      : 'Implied is close to forecast realised: no clear volatility edge.',
    note: 'The edge is forecasting realised volatility. Each forecast here is one model; their spread is the uncertainty.',
  }
}

module.exports = { parseFredCsv, fetchVix, vrpHistory, vrpSnapshot }
