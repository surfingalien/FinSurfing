'use strict'

/**
 * lib/shadow-baseline.js — did the AI's picks beat a random pick from the SAME list?
 *
 * The track record measures picks against SPY (BTC for crypto). That answers
 * "did this beat the market", but a scan built from today's most-active and
 * biggest-gaining names can beat SPY just because of what went INTO the list —
 * momentum names in a momentum tape. The question that isolates the model's
 * own contribution is narrower: given the list it was handed, did it pick
 * better than chance?
 *
 * So every scan also logs a few SHADOW picks: symbols drawn at random from the
 * same priced universe that the model did NOT pick, as many as it did pick
 * (capped). They resolve on the same +7/+30d rule and the same benchmark as
 * real picks. `compareToShadows` then tests the AI's win and alpha rates
 * against the shadows' with the same two-proportion test the learning-health
 * audit uses — so "the AI beats a random pick from its own list" is either
 * measured or explicitly not yet.
 *
 * Shadows live in their OWN file, never in the prediction log: they must not
 * reach calibration, Kelly sizing, the edge report, the ML baseline or the
 * learnings — a random pick scored as an AI pick would corrupt all of them.
 * The draw is deterministic (seeded by the scan time), so it is reproducible.
 *
 * Tests: tests/shadow-baseline.test.js
 */

const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')
const atomic = require('./atomic-write')
// Lazy: durable-files requires this module for SHADOW_LOG during the boot-time
// restore, which runs before anything else loads — keep that path light.
const compare = (...args) => require('./learning-health').compare(...args)

const SHADOW_LOG = process.env.AI_BRAIN_SHADOW_LOG || path.join(require('./data-dir').DATA_DIR, 'ai-brain-shadow.jsonl')
const MAX_SHADOWS = 8
const DAY = 86_400_000
const SEGMENT_MIN_30D = 20   // same switch-over as brain-learnings segmentHorizon
const RETAIN_DAYS = 120

/** Deterministic PRNG from a string seed (sha256 → xorshift32). */
function seeded(seed) {
  let x = crypto.createHash('sha256').update(String(seed)).digest().readUInt32LE(0) || 1
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296 }
}

/**
 * Pick `k` symbols from `universe` that are not in `picked`, without
 * replacement, deterministically for a given seed. Pure.
 */
function drawShadows(universe, picked, k, seed) {
  const taken = new Set((picked || []).map(s => String(s).toUpperCase()))
  const pool = [...new Set((universe || []).map(s => String(s).toUpperCase()))].filter(s => !taken.has(s)).sort()
  const rand = seeded(seed)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, Math.max(0, Math.min(k, MAX_SHADOWS, pool.length)))
}

const assetTypeOf = sym => (/-USD$/.test(sym) ? 'crypto' : 'stock')

/**
 * Log this scan's shadows. `prices` maps symbol → the same real price the scan
 * used. Best-effort: a failure here never fails a scan.
 */
function logShadows({ universe, picked, actionableCount, prices, generatedAt, promptVersion = null }, file = SHADOW_LOG) {
  try {
    const shadows = drawShadows(universe, picked, actionableCount, generatedAt)
    const rows = shadows
      .filter(s => Number(prices?.[s]) > 0)
      .map(symbol => ({ symbol, generatedAt, assetType: assetTypeOf(symbol), priceAtPrediction: Number(prices[symbol]), promptVersion, shadow: true }))
    if (rows.length) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
    }
    return rows.length
  } catch (e) {
    console.warn('[shadow-baseline] log failed:', e.message)
    return 0
  }
}

const readShadows = (file = SHADOW_LOG) => atomic.readJsonl(file)

/**
 * Resolve shadow outcomes at +7/+30d against the historical bar, with the same
 * benchmark as real picks. `fetchBars(symbol)` → daily bars [{t, c}].
 * Records older than RETAIN_DAYS that are fully resolved are dropped.
 */
async function resolveShadows({ fetchBars, nearestClose, benchmarkFor, now = Date.now() }, file = SHADOW_LOG) {
  const rows = readShadows(file)
  if (!rows.length) return { resolved: 0 }
  const due = rows.filter(r => {
    const age = now - new Date(r.generatedAt).getTime()
    return (age >= 7 * DAY && r.price7d == null) || (age >= 30 * DAY && r.price30d == null)
  })
  let resolved = 0
  if (due.length) {
    const syms = [...new Set(due.flatMap(r => [r.symbol, benchmarkFor(r.symbol)]))]
    const bars = {}
    await Promise.all(syms.map(async s => { bars[s] = await fetchBars(s).catch(() => []) }))
    for (const r of rows) {
      const genMs = new Date(r.generatedAt).getTime()
      const age = now - genMs
      const b = bars[r.symbol], bb = bars[benchmarkFor(r.symbol)] || []
      if (!b?.length) continue
      if (r.basePrice == null) r.basePrice = nearestClose(b, genMs) ?? r.priceAtPrediction
      const benchBase = nearestClose(bb, genMs)
      for (const [days, key, bkey] of [[7, 'price7d', 'benchRet7d'], [30, 'price30d', 'benchRet30d']]) {
        if (age < days * DAY || r[key] != null) continue
        const px = nearestClose(b, genMs + days * DAY)
        if (px == null) continue
        r[key] = px
        const bpx = nearestClose(bb, genMs + days * DAY)
        if (benchBase && bpx != null) r[bkey] = +(((bpx - benchBase) / benchBase) * 100).toFixed(2)
        resolved++
      }
    }
  }
  const keep = rows.filter(r => now - new Date(r.generatedAt).getTime() < RETAIN_DAYS * DAY || r.price30d == null)
  atomic.rewriteJsonl(file, keep)
  return { resolved, kept: keep.length }
}

/** Win/alpha counts at one horizon for a set of records. Pure. */
function outcomeCounts(records, horizon) {
  const pk = `price${horizon}d`, bk = `benchRet${horizon}d`
  let n = 0, wins = 0, nBench = 0, alphaWins = 0, sum = 0
  for (const r of records || []) {
    const base = r.basePrice ?? r.priceAtPrediction
    if (!(base > 0) || r[pk] == null) continue
    const ret = ((r[pk] - base) / base) * 100
    n++; sum += ret
    if (ret > 0) wins++
    if (r[bk] != null) { nBench++; if (ret > r[bk]) alphaWins++ }
  }
  return { n, wins, nBench, alphaWins, meanReturn: n ? +(sum / n).toFixed(2) : null }
}

/**
 * The AI's resolved actionable picks vs the shadows, at the 30d horizon once
 * both sides have SEGMENT_MIN_30D outcomes, else 7d. Only scans that logged
 * shadows are compared, so both sides span the same dates. Pure.
 */
/**
 * Is the AI's lead over random picks shrinking? One point per scan that has
 * resolved AI picks AND resolved shadows at 7 days, scans at least 7 days
 * apart (so points do not share outcomes), each the lead — the AI's alpha win
 * share minus the shadows' — divided by its own sampling noise. A Page–Hinkley
 * test watches for a persistent fall. Thresholds (DRIFT) were set by
 * simulation: on pure noise it alarms in ≤ ~6% of two-year weekly histories.
 * Pure.
 */
const DRIFT = { horizon: 7, delta: 0.5, lambda: 6, minPoints: 12 }
function driftVsRandom(predictions, shadows, { now = Date.now() } = {}) {
  const { pageHinkley } = require('./calibration-stats')
  const h = DRIFT.horizon, pk = `price${h}d`, bk = `benchRet${h}d`
  const winOf = r => {
    const base = r.basePrice ?? r.priceAtPrediction
    if (!(base > 0) || r[pk] == null) return null
    const ret = ((r[pk] - base) / base) * 100
    return r[bk] != null ? ret > r[bk] : ret > 0
  }
  const byScan = new Map()
  const add = (r, side) => {
    const w = winOf(r); if (w == null || !r.generatedAt) return
    const g = byScan.get(r.generatedAt) || { at: Date.parse(r.generatedAt), ai: [], sh: [] }
    g[side].push(w); byScan.set(r.generatedAt, g)
  }
  for (const r of predictions || []) add(r, 'ai')
  for (const r of shadows || []) add(r, 'sh')
  const scans = [...byScan.values()].filter(g => g.ai.length && g.sh.length && Number.isFinite(g.at)).sort((a, b) => a.at - b.at)
  const points = []
  let nextFree = -Infinity
  for (const g of scans) {
    if (g.at < nextFree) continue
    nextFree = g.at + h * 86_400_000
    const ka = g.ai.filter(Boolean).length, na = g.ai.length, ks = g.sh.filter(Boolean).length, ns = g.sh.length
    const p = (ka + ks) / (na + ns)
    const sd = Math.sqrt(Math.max(p * (1 - p), 0.05) * (1 / na + 1 / ns))
    points.push({ at: new Date(g.at).toISOString(), lead: +(ka / na - ks / ns).toFixed(3), z: (ka / na - ks / ns) / sd })
  }
  const out = { horizon: h, points: points.length, minPoints: DRIFT.minPoints, ready: points.length >= DRIFT.minPoints,
    rule: `one scan per ${h} days; alarm when the AI's lead over random picks falls persistently (Page–Hinkley, δ ${DRIFT.delta}, λ ${DRIFT.lambda} in noise units)` }
  if (!points.length) return out
  const mean = xs => +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3)
  out.meanLead = mean(points.map(p => p.lead))
  out.recentLead = mean(points.slice(-8).map(p => p.lead))
  out.series = points.slice(-52).map(p => ({ at: p.at, lead: p.lead }))
  if (out.ready) {
    const ph = pageHinkley(points.map(p => -p.z), { delta: DRIFT.delta, lambda: DRIFT.lambda })
    Object.assign(out, { alarm: ph.alarm, ph: ph.ph, threshold: ph.threshold, alarmAt: ph.alarm ? points[ph.alarmAt - 1].at : null })
  } else out.alarm = false
  return out
}

function compareToShadows(predictions, shadows, { minN = 10 } = {}) {
  const { independentPicks } = require('./calibration-stats')
  const scans = new Set((shadows || []).map(s => s.generatedAt))
  const aiAll = (predictions || []).filter(p => scans.has(p.generatedAt))
  const has30Raw = outcomeCounts(aiAll, 30).n >= SEGMENT_MIN_30D && outcomeCounts(shadows, 30).n >= SEGMENT_MIN_30D
  // Each side counts a stock once per outcome window — repeat picks share an outcome.
  const thin = (rows, h) => independentPicks((rows || []).filter(r => r[`price${h}d`] != null), h)
  const ai30 = thin(aiAll, 30), sh30 = thin(shadows, 30)
  const has30 = has30Raw && outcomeCounts(ai30, 30).n >= SEGMENT_MIN_30D && outcomeCounts(sh30, 30).n >= SEGMENT_MIN_30D
  const ai = has30 ? ai30 : thin(aiAll, 7)
  const sh = has30 ? sh30 : thin(shadows, 7)
  const horizon = has30 ? 30 : 7
  const a = outcomeCounts(ai, horizon), s = outcomeCounts(sh, horizon)
  const useAlpha = a.nBench >= minN && s.nBench >= minN
  const test = useAlpha
    ? compare({ k: a.alphaWins, n: a.nBench }, { k: s.alphaWins, n: s.nBench }, { minN })
    : compare({ k: a.wins, n: a.n }, { k: s.wins, n: s.n }, { minN })
  const verdict = test.status === 'higher' ? 'beats-random'
    : test.status === 'lower' ? 'below-random'
    : test.status === 'no-difference' ? 'no-difference'
    : 'insufficient'
  const rate = (k, n) => (n ? +(k / n).toFixed(3) : null)
  return {
    horizon, metric: useAlpha ? 'alphaWinRate' : 'winRate', verdict,
    rawN:    { ai: aiAll.length, shadow: (shadows || []).length },
    ai:      { n: a.n, winRate: rate(a.wins, a.n), alphaWinRate: rate(a.alphaWins, a.nBench), meanReturn: a.meanReturn },
    shadow:  { n: s.n, winRate: rate(s.wins, s.n), alphaWinRate: rate(s.alphaWins, s.nBench), meanReturn: s.meanReturn },
    diff: test.diff ?? null, p: test.p ?? null,
    reason: test.status === 'insufficient' ? test.reason : null,
    drift: driftVsRandom(predictions, shadows),
    meaning: 'shadows are random picks from the same priced list the model was handed — beating them is the model\'s own contribution, beating SPY may only be the list',
  }
}

module.exports = { DRIFT, driftVsRandom, SHADOW_LOG, MAX_SHADOWS, drawShadows, logShadows, readShadows, resolveShadows, outcomeCounts, compareToShadows }
