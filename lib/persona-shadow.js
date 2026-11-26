'use strict'
/**
 * lib/persona-shadow.js — do a persona's AI picks beat random picks from the
 * SAME screened list?
 *
 * The persona screen (lib/persona-screen.js) already does part of the work: a
 * Buffett list is cheap, profitable, unlevered stocks. If the AI's choice from
 * that list does no better than a random draw from it, the persona's value is
 * the SCREEN, not the model — and the screen costs nothing to run. So every
 * screened run also logs SHADOW picks: for each asset class, as many names as
 * the AI picked, drawn deterministically (seeded by the run id) from the
 * candidates it did not pick, all priced at the same measured close.
 *
 * Kept in their OWN file, never in the learning store: a random pick recorded
 * as a persona decision would reach the persona calibration and leaderboard.
 *
 * Outcome: the return over HORIZON_DAYS (30) calendar days from that close.
 * Unit of evidence: one RUN (mean of its picks minus mean of its shadows), and
 * a persona's runs count only when their windows do not overlap — the same
 * persona run daily shares one month of market, which is one outcome, not
 * thirty. Verdict on ≥ MIN_RUNS: `beats-random` t ≥ 2, `below-random` t ≤ −2,
 * else `no-difference`.
 *
 * Tests: tests/persona-shadow.test.js
 */

const path   = require('path')
const crypto = require('crypto')
const atomic = require('./atomic-write')

const LOG = process.env.PERSONA_SHADOW_LOG || path.join(require('./data-dir').DATA_DIR, 'persona-shadow.jsonl')
const DAY = 86_400_000
const HORIZON_DAYS = 30
const MIN_RUNS = 8
const RETAIN_DAYS = 400

function seeded(seed) {
  let x = crypto.createHash('sha256').update(String(seed)).digest().readUInt32LE(0) || 1
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296 }
}

/** k names from `pool` minus `picked`, deterministic in `seed`. Pure. */
function draw(pool, picked, k, seed) {
  const taken = new Set(picked)
  const rest = [...new Set(pool)].filter(s => !taken.has(s)).sort()
  const rnd = seeded(seed)
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]] }
  return rest.slice(0, Math.max(0, k))
}

/**
 * Rows for one run. picks: [{symbol, type}]; screen: persona-screen output
 * (lists carry price). Pure.
 */
function rowsForRun({ runId, persona, at, picks, screen }) {
  const lists = { Stock: screen?.stocks || [], ETF: screen?.etfs || [], Crypto: screen?.crypto || [], Fund: screen?.funds || [] }
  const price = {}
  for (const list of Object.values(lists)) for (const c of list) price[c.symbol] = c.price
  const rows = []
  for (const [cls, list] of Object.entries(lists)) {
    const mine = (picks || []).filter(p => p.type === cls && price[String(p.symbol).toUpperCase()] > 0).map(p => String(p.symbol).toUpperCase())
    if (!mine.length) continue
    const shadows = draw(list.map(c => c.symbol), mine, mine.length, `${runId}:${cls}`)
    if (!shadows.length) continue        // the AI took the whole list: nothing to compare with
    for (const s of mine) rows.push({ runId, persona, at, role: 'pick', symbol: s, assetClass: cls, price: price[s] })
    for (const s of shadows) rows.push({ runId, persona, at, role: 'shadow', symbol: s, assetClass: cls, price: price[s] })
  }
  return rows
}

function logRun(run, file = LOG) {
  try {
    const rows = rowsForRun(run)
    if (rows.length) {
      const fs = require('fs')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
    }
    return rows.length
  } catch (e) {
    console.warn('[persona-shadow] log failed:', e.message)
    return 0
  }
}

const readRows = (file = LOG) => atomic.readJsonl(file)

/** Fill `priceH`/`ret` on rows whose window has ended. fetchBars(sym) → [{t, c}]. */
async function resolve({ fetchBars, nearestClose, now = Date.now() }, file = LOG) {
  const rows = readRows(file)
  const due = rows.filter(r => r.ret == null && now - Date.parse(r.at) >= HORIZON_DAYS * DAY)
  let resolved = 0
  if (due.length) {
    const bars = {}
    for (const s of [...new Set(due.map(r => r.symbol))]) bars[s] = await fetchBars(s).catch(() => [])
    for (const r of due) {
      const px = nearestClose(bars[r.symbol] || [], Date.parse(r.at) + HORIZON_DAYS * DAY)
      if (px == null || !(r.price > 0)) continue
      r.priceH = px
      r.ret = +(((px / r.price) - 1) * 100).toFixed(3)
      resolved++
    }
  }
  const keep = rows.filter(r => now - Date.parse(r.at) < RETAIN_DAYS * DAY)
  if (resolved || keep.length !== rows.length) atomic.rewriteJsonl(file, keep)
  return { resolved, pending: rows.filter(r => r.ret == null).length }
}

const mean = a => a.reduce((x, y) => x + y, 0) / a.length

/** Per persona: AI picks vs shadows over non-overlapping runs. Pure. */
function compare(rows, { minRuns = MIN_RUNS } = {}) {
  const runs = new Map()
  for (const r of rows || []) {
    if (!runs.has(r.runId)) runs.set(r.runId, { runId: r.runId, persona: r.persona, at: r.at, pick: [], shadow: [], open: 0 })
    const run = runs.get(r.runId)
    if (r.ret == null) run.open++
    else run[r.role === 'shadow' ? 'shadow' : 'pick'].push(r.ret)
  }
  const byPersona = {}
  for (const run of runs.values()) (byPersona[run.persona] ||= []).push(run)
  const out = {}
  for (const [persona, list] of Object.entries(byPersona)) {
    const done = list.filter(x => x.pick.length && x.shadow.length && !x.open).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    const kept = []
    for (const run of done) if (!kept.length || Date.parse(run.at) >= Date.parse(kept[kept.length - 1].at) + HORIZON_DAYS * DAY) kept.push(run)
    const diffs = kept.map(x => mean(x.pick) - mean(x.shadow))
    const n = diffs.length
    const res = { runs: list.length, resolvedRuns: done.length, independentRuns: n, pending: list.length - done.length }
    if (n) {
      res.meanPick = +mean(kept.map(x => mean(x.pick))).toFixed(2)
      res.meanShadow = +mean(kept.map(x => mean(x.shadow))).toFixed(2)
      res.meanDiff = +mean(diffs).toFixed(2)
      res.beatShare = +(diffs.filter(d => d > 0).length / n).toFixed(2)
    }
    if (n < minRuns) { res.verdict = 'insufficient'; res.reason = `${n} independent run${n === 1 ? '' : 's'} resolved — ${minRuns} needed` }
    else {
      const m = mean(diffs)
      const sd = Math.sqrt(diffs.reduce((a, d) => a + (d - m) ** 2, 0) / (n - 1))
      res.t = sd > 0 ? +(m / (sd / Math.sqrt(n))).toFixed(2) : null
      res.verdict = res.t == null ? 'no-difference' : res.t >= 2 ? 'beats-random' : res.t <= -2 ? 'below-random' : 'no-difference'
    }
    out[persona] = res
  }
  return { horizonDays: HORIZON_DAYS, minRuns, byPersona: out }
}

module.exports = { LOG, HORIZON_DAYS, MIN_RUNS, draw, rowsForRun, logRun, readRows, resolve, compare }
