'use strict'

/**
 * lib/pead.js — post-earnings-announcement drift, tested as an event study.
 *
 * The oldest anomaly in the literature (Ball & Brown 1968, Bernard & Thomas
 * 1989): after a large earnings surprise, prices keep drifting in the
 * surprise's direction for weeks, because the market under-reacts on the day.
 * Whether it survives on THIS universe, net of costs, today, is a question for
 * the bars — so this module asks it with no model involved:
 *
 *   event     each reported quarter: EPS surprise % = (actual − estimate) / |estimate|
 *             beat ≥ +5%, miss ≤ −5%, otherwise in line — thresholds fixed in
 *             advance, never tuned, so there is nothing here to overfit
 *   entry     the OPEN of the first session strictly AFTER the report date. The
 *             time of day is unknown, so for a pre-market report the day-0 move
 *             is skipped — conservative, never lookahead
 *   exit      the close `HOLD_DAYS` (20) sessions later
 *   measure   return net of the stock round-trip cost minus SPY over the same
 *             sessions (abnormal return)
 *
 * Statistics. Events in one earnings season are not independent — the whole
 * market moves in late January — so the t-stat is taken across calendar
 * MONTHS (the mean abnormal return of each month's events), not across
 * events, which would overstate it by roughly √(events per month).
 * Walk-forward: the older 70% of beat events and the newest 30% are scored
 * separately; `validated` needs both positive and a month-clustered t ≥ 2
 * on all of them. Misses are the control: if beats and misses drift alike,
 * the "edge" is the earnings season, not the surprise.
 *
 * Call tone. A deterministic word count over the transcript (no model, so it
 * can be computed for every past call): (positive − negative) / (positive +
 * negative) from short lists of plain business words written for this file.
 * Every management team sounds upbeat, so the signal is the CHANGE from the
 * company's previous call. Whether improving tone adds to a beat is tested
 * (`tone`), and reported as no evidence until both sides have enough events.
 *
 * Transcript text is only counted, never shown to a model, so no fencing is
 * needed. Pure except `runStudy`. Tests: tests/pead.test.js
 */

const { wilson } = require('./calibration-stats')

const HOLD_DAYS  = 20
const BEAT_PCT   = 5
const MISS_PCT   = -5
const MIN_EVENTS = 30
const MIN_TONE   = 15
const TRAIN_FRAC = 0.7

const dayKey = t => new Date(t).toISOString().slice(0, 10)
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length
const sd = xs => { const m = mean(xs); return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1)) }

/** EPS surprise in percent; null when the estimate is too close to zero to divide by. */
function surprisePct(actual, estimate) {
  const a = Number(actual), e = Number(estimate)
  if (actual == null || estimate == null || !Number.isFinite(a) || !Number.isFinite(e) || Math.abs(e) < 0.01) return null
  return Math.max(-200, Math.min(200, ((a - e) / Math.abs(e)) * 100))
}

const groupOf = s => (s == null ? null : s >= BEAT_PCT ? 'beat' : s <= MISS_PCT ? 'miss' : 'inline')

// ── Tone ─────────────────────────────────────────────────────────────────────
// Short, plain lists written for this module. A trailing * matches the stem.
const POSITIVE = ['strong', 'stronger', 'strength', 'record', 'growth', 'grew', 'exceed*', 'beat', 'improv*', 'accelerat*',
  'momentum', 'robust', 'confident', 'confidence', 'outperform*', 'expand*', 'expansion', 'raised', 'raising', 'upside',
  'healthy', 'solid', 'gain', 'gains', 'opportunit*', 'tailwind*', 'success*', 'favorabl*', 'encourag*', 'pleased', 'excellent']
const NEGATIVE = ['decline*', 'declining', 'weak', 'weaker', 'weakness', 'challeng*', 'headwind*', 'pressure*', 'slowdown',
  'slowed', 'slowing', 'softness', 'softer', 'loss', 'losses', 'missed', 'shortfall', 'difficult', 'uncertain*', 'cautious',
  'deteriorat*', 'impairment*', 'restructuring', 'disappoint*', 'volatil*', 'delay*', 'downturn', 'lowered']

const matcher = list => {
  const exact = new Set(list.filter(w => !w.endsWith('*')))
  const stems = list.filter(w => w.endsWith('*')).map(w => w.slice(0, -1))
  return w => exact.has(w) || stems.some(s => w.startsWith(s))
}
const isPos = matcher(POSITIVE), isNeg = matcher(NEGATIVE)

/** {score −1…1, pos, neg} or null when too few tone words to mean anything. Pure. */
function toneScore(text) {
  const words = String(text || '').toLowerCase().match(/[a-z]+/g) || []
  let pos = 0, neg = 0
  for (const w of words) { if (isPos(w)) pos++; else if (isNeg(w)) neg++ }
  if (pos + neg < 10) return null
  return { score: +((pos - neg) / (pos + neg)).toFixed(4), pos, neg }
}

// ── Events ───────────────────────────────────────────────────────────────────

/** Entry at the open after `date`, exit `hold` sessions later; abnormal vs bench. Pure. */
function eventReturn(bars, date, { hold = HOLD_DAYS, benchByDay = null, costBps = 10 } = {}) {
  const i = bars.findIndex(b => dayKey(b.t) > date)
  if (i < 0 || i + hold - 1 >= bars.length) return null
  const entry = bars[i].o ?? bars[i].c, exit = bars[i + hold - 1].c
  if (!(entry > 0 && exit > 0)) return null
  const entryDate = dayKey(bars[i].t), exitDate = dayKey(bars[i + hold - 1].t)
  const ret = (exit / entry - 1) * 100 - costBps / 100
  const be = benchByDay?.get(entryDate), bx = benchByDay?.get(exitDate)
  const bench = be && bx ? ((bx.c / (be.o ?? be.c)) - 1) * 100 : null
  return { entryDate, exitDate, ret: +ret.toFixed(3), bench: bench == null ? null : +bench.toFixed(3), abn: bench == null ? null : +(ret - bench).toFixed(3) }
}

/**
 * One symbol's events. `surprises`: rows with date + actual + estimate (any of
 * the FMP spellings); `transcripts`: [{date, content}] — matched to the event
 * within 5 days, tone change vs the previous matched call.
 */
function buildEvents({ symbol, surprises = [], bars = [], benchBars = [], transcripts = [], hold = HOLD_DAYS, costBps = 10 }) {
  const benchByDay = new Map(benchBars.map(b => [dayKey(b.t), b]))
  const calls = transcripts
    .map(t => ({ date: String(t.date || '').slice(0, 10), tone: toneScore(t.content) }))
    .filter(t => t.date && t.tone)
    .sort((a, b) => a.date.localeCompare(b.date))
  const toneNear = date => calls.find(c => Math.abs(Date.parse(c.date) - Date.parse(date)) <= 5 * 86400000) || null

  const events = surprises.map(r => {
    const date = String(r.date || '').slice(0, 10)
    const s = surprisePct(r.actualEarningResult ?? r.epsActual ?? r.actual, r.estimatedEarning ?? r.epsEstimated ?? r.estimatedEps ?? r.estimate)
    if (!date || s == null) return null
    const call = toneNear(date)
    const prev = call ? calls[calls.indexOf(call) - 1] : null
    return {
      symbol, date, surprisePct: +s.toFixed(2), group: groupOf(s),
      tone: call?.tone.score ?? null,
      toneChange: call && prev ? +(call.tone.score - prev.tone.score).toFixed(4) : null,
      ...(eventReturn(bars, date, { hold, benchByDay, costBps }) || {}),
    }
  }).filter(Boolean)
  return events.sort((a, b) => a.date.localeCompare(b.date))
}

// ── Estimate-free surprise (SUE) ─────────────────────────────────────────────
// Bernard & Thomas (1989) measured surprise with no analyst at all: this
// quarter's EPS minus the same quarter a year earlier (a seasonal random walk),
// scaled by how much that change has varied before. It needs only reported
// EPS, which SEC filings supply keyless (lib/sec-facts.js) — so the study runs
// when the FMP quota is spent. The event date is the 10-Q/10-K FILING date:
// later than the earnings press release, so some drift is missed — the
// conservative side, never lookahead.

const SUE_BEAT = 1, SUE_MISS = -1, SUE_HISTORY = 8, SUE_MIN_HISTORY = 4

/** [{end, filed, sue, change}] for every quarter with enough history. Pure. */
function sueSeries(eps) {
  const qs = (eps || []).filter(q => Number.isFinite(q.val) && q.end && q.filed).sort((a, b) => a.end.localeCompare(b.end))
  const yearBack = i => {
    for (let j = i - 1; j >= 0; j--) {
      const d = (Date.parse(qs[i].end) - Date.parse(qs[j].end)) / 86400000
      if (d >= 350 && d <= 380) return qs[j]
      if (d > 380) return null
    }
    return null
  }
  const changes = qs.map((q, i) => { const p = yearBack(i); return p ? q.val - p.val : null })
  const out = []
  for (let i = 0; i < qs.length; i++) {
    if (changes[i] == null) continue
    const prior = changes.slice(0, i).filter(c => c != null).slice(-SUE_HISTORY)
    if (prior.length < SUE_MIN_HISTORY) continue
    const scale = sd(prior)
    if (!(scale > 0)) continue
    out.push({ end: qs[i].end, filed: qs[i].filed, change: +changes[i].toFixed(4), sue: +(changes[i] / scale).toFixed(2) })
  }
  return out
}

const sueGroup = v => (v >= SUE_BEAT ? 'beat' : v <= SUE_MISS ? 'miss' : 'inline')

/** One symbol's SUE events, entered after the filing date. */
function sueEvents({ symbol, eps = [], bars = [], benchBars = [], hold = HOLD_DAYS, costBps = 10 }) {
  const benchByDay = new Map(benchBars.map(b => [dayKey(b.t), b]))
  return sueSeries(eps).map(q => ({
    symbol, date: q.filed, periodEnd: q.end, sue: q.sue, group: sueGroup(q.sue), source: 'sue',
    ...(eventReturn(bars, q.filed, { hold, benchByDay, costBps }) || {}),
  }))
}

// ── Statistics ───────────────────────────────────────────────────────────────

/** Mean abnormal return with a t-stat across calendar months of entry. Pure. */
function summarize(events) {
  const ev = events.filter(e => Number.isFinite(e.abn))
  if (!ev.length) return { n: 0 }
  const abn = ev.map(e => e.abn)
  const byMonth = new Map()
  for (const e of ev) {
    const m = e.entryDate.slice(0, 7)
    if (!byMonth.has(m)) byMonth.set(m, [])
    byMonth.get(m).push(e.abn)
  }
  const monthMeans = [...byMonth.values()].map(mean)
  const t = monthMeans.length >= 3 && sd(monthMeans) > 0 ? mean(monthMeans) / (sd(monthMeans) / Math.sqrt(monthMeans.length)) : null
  const wins = abn.filter(a => a > 0).length
  const w = wilson(wins, abn.length)
  const sorted = [...abn].sort((a, b) => a - b)
  return {
    n: ev.length, months: monthMeans.length,
    meanAbn: +mean(abn).toFixed(2), medianAbn: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
    beatBench: +(wins / abn.length).toFixed(3), beatBenchLo: +w.lo.toFixed(3), beatBenchHi: +w.hi.toFixed(3),
    t: t == null ? null : +t.toFixed(2),
  }
}

/** Welch t between two groups' abnormal returns. */
function welchT(a, b) {
  const x = a.map(e => e.abn).filter(Number.isFinite), y = b.map(e => e.abn).filter(Number.isFinite)
  if (x.length < 2 || y.length < 2) return null
  const se = Math.sqrt(sd(x) ** 2 / x.length + sd(y) ** 2 / y.length)
  return se > 0 ? +((mean(x) - mean(y)) / se).toFixed(2) : null
}

/**
 * The study over every event: groups, the long-beats walk-forward verdict,
 * the miss control, and whether improving call tone adds to a beat. Pure.
 */
function study(events, { trainFrac = TRAIN_FRAC, minEvents = MIN_EVENTS, params = null } = {}) {
  const scored = events.filter(e => Number.isFinite(e.abn)).sort((a, b) => a.entryDate.localeCompare(b.entryDate))
  const beats = scored.filter(e => e.group === 'beat'), misses = scored.filter(e => e.group === 'miss')
  const cut = Math.floor(beats.length * trainFrac)
  const train = summarize(beats.slice(0, cut)), holdout = summarize(beats.slice(cut))
  const all = summarize(beats)

  let verdict, reason
  if (beats.length < minEvents || holdout.n < 10) {
    verdict = 'insufficient'; reason = `${beats.length} beat events with a measured outcome (need ${minEvents}, with 10 in the newest 30%)`
  } else if (train.meanAbn > 0 && holdout.meanAbn > 0 && all.t != null && all.t >= 2) {
    verdict = 'validated'; reason = `beats drifted ahead of SPY on both the older and the newest events (month-clustered t=${all.t})`
  } else if (train.meanAbn > 0 || holdout.meanAbn > 0) {
    verdict = 'mixed'; reason = `positive on only ${train.meanAbn > 0 ? 'the older' : 'the newest'} events, or not beyond chance (t=${all.t})`
  } else {
    verdict = 'rejected'; reason = 'beats did not drift ahead of SPY after costs'
  }

  const up = beats.filter(e => e.toneChange != null && e.toneChange > 0)
  const down = beats.filter(e => e.toneChange != null && e.toneChange <= 0)
  const toneT = welchT(up, down)
  const tone = {
    improved: summarize(up), worsened: summarize(down), t: toneT,
    verdict: up.length < MIN_TONE || down.length < MIN_TONE ? 'insufficient'
      : toneT != null && toneT >= 2 ? 'adds' : 'no-evidence',
  }

  return {
    params: params || { holdDays: HOLD_DAYS, beatPct: BEAT_PCT, missPct: MISS_PCT, entry: 'open after the report date', benchmark: 'SPY' },
    events: scored.length,
    groups: { beat: all, miss: summarize(misses), inline: summarize(scored.filter(e => e.group === 'inline')), all: summarize(scored) },
    strategy: { name: 'long-beats', train, holdout, verdict, reason },
    spreadVsMiss: all.n && misses.length ? +(all.meanAbn - summarize(misses).meanAbn).toFixed(2) : null,
    tone,
  }
}

/** Sessions since an event, and whether it is still inside the drift window. Pure. */
function windowState(event, bars, { hold = HOLD_DAYS } = {}) {
  if (!event?.date || !bars?.length) return null
  const i = bars.findIndex(b => dayKey(b.t) > event.date)
  if (i < 0) return { sessionsSince: 0, inWindow: true, remaining: hold }   // reported, no session since yet
  const since = bars.length - i
  return { sessionsSince: since, inWindow: since < hold, remaining: Math.max(0, hold - since) }
}

// ── Storage + job ────────────────────────────────────────────────────────────
const path = require('path')
const STUDY_FILE = path.join(require('./data-dir').DATA_DIR, 'pead-study.json')

function readStudy(file = STUDY_FILE) {
  try { return JSON.parse(require('fs').readFileSync(file, 'utf8')) } catch { return null }
}

function saveStudy(s, file = STUDY_FILE) {
  require('fs').mkdirSync(path.dirname(file), { recursive: true })
  require('./atomic-write').writeJsonAtomic(file, s)
}

/**
 * Fetch five years of bars + reported quarters (+ recent call transcripts when
 * `toneQuarters` > 0) per name, run the study, persist. Fetchers are injected.
 */
async function runStudy({ universe, fetchBars, fetchSurprises = null, fetchEps = null, fetchTranscripts = null, toneQuarters = 4, concurrency = 3, save = true, costBps = 10, minUniverse = 20 }) {
  const benchBars = await fetchBars('SPY')
  if (!benchBars?.length) throw new Error('no SPY bars — cannot measure abnormal returns')
  const events = [], sue = [], latestBySymbol = {}, missing = [], errors = []
  let analystNames = 0
  const queue = [...universe]
  const soft = (p, onErr) => p.catch(e => { onErr?.(e); return [] })
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const symbol = queue.shift()
      try {
        // Analyst surprises (FMP) and reported EPS (SEC) are independent sources:
        // either one failing — an exhausted FMP quota — leaves the other track running.
        const [bars, surprises, eps, transcripts] = await Promise.all([
          fetchBars(symbol),
          fetchSurprises ? soft(Promise.resolve().then(() => fetchSurprises(symbol)), e => errors.push(e?.message)) : [],
          fetchEps ? soft(Promise.resolve().then(() => fetchEps(symbol)), e => errors.push(e?.message)) : [],
          toneQuarters > 0 && fetchTranscripts ? soft(Promise.resolve().then(() => fetchTranscripts(symbol, toneQuarters))) : [],
        ])
        if (!bars?.length || (!surprises?.length && !eps?.length)) { missing.push(symbol); continue }
        const ev = surprises?.length ? buildEvents({ symbol, surprises, bars, benchBars, transcripts, costBps }) : []
        const se = eps?.length ? sueEvents({ symbol, eps, bars, benchBars, costBps }) : []
        if (ev.length) analystNames++
        events.push(...ev); sue.push(...se)
        const last = ev.at(-1), lastSue = se.at(-1)
        latestBySymbol[symbol] = {
          ...(last ? { date: last.date, surprisePct: last.surprisePct, group: last.group, tone: last.tone, toneChange: last.toneChange } : {}),
          ...(lastSue ? { sue: { date: lastSue.date, periodEnd: lastSue.periodEnd, value: lastSue.sue, group: lastSue.group } } : {}),
        }
      } catch (e) { missing.push(symbol); errors.push(e?.message) }
    }
  }))
  const out = {
    ranAt: new Date().toISOString(), universe: universe.length - missing.length, requested: universe.length, missing,
    analystNames,
    ...study(events), latestBySymbol,
    sue: study(sue, { params: { holdDays: HOLD_DAYS, beatSue: SUE_BEAT, missSue: SUE_MISS, entry: 'open after the 10-Q/10-K filing date', benchmark: 'SPY', source: 'SEC reported EPS, no analyst estimates' } }),
    caveats: [
      'Analyst estimates are the consensus as the data provider records it today, which can differ from what was expected at the time.',
      "The list is today's large caps (survivorship).",
      'Entry is the open after the report date because the time of day is not known; for a pre-market report the first day\'s move is skipped.',
      'The estimate-free track enters after the 10-Q/10-K filing, usually days after the earnings release, so it misses the start of any drift.',
    ],
  }
  // An exhausted FMP quota or a provider outage fails every name at once; that
  // run must not overwrite the stored study with an empty one.
  if (out.universe < Math.min(minUniverse, universe.length)) {
    const why = errors.find(Boolean)
    throw new Error(`only ${out.universe} of ${universe.length} names had earnings history${why ? ` (e.g. ${why})` : ''} — the stored study is kept`)
  }
  if (save) saveStudy(out)
  return out
}

module.exports = {
  HOLD_DAYS, BEAT_PCT, MISS_PCT, MIN_EVENTS, STUDY_FILE, SUE_BEAT, SUE_MISS,
  surprisePct, groupOf, toneScore, eventReturn, buildEvents, sueSeries, sueEvents, summarize, welchT, study, windowState,
  readStudy, saveStudy, runStudy,
}
