'use strict'
/**
 * lib/brain-learnings.js
 *
 * Self-improvement loop for the AI Brain.
 *
 * Flow (runs nightly via scheduled-jobs.js):
 *   1. resolveOutcomes()  — resolve predictions made 7/30d ago against the
 *                           HISTORICAL daily bar closest to exactly +7/+30 days
 *                           (not "whenever the job happened to run"), record
 *                           whether price ever entered the entry zone (a fill
 *                           that never happened is not a win), and record the
 *                           benchmark return (SPY for equities, BTC for crypto)
 *                           over the same window so wins are benchmark-relative
 *   2. runMetaAnalysis()  — stats (win rates, alpha, calibration by confidence)
 *                           are computed deterministically in code; Claude only
 *                           interprets them and writes structured learnings
 *   3. getLearningsBlock() — returns a prompt-injection string with the latest
 *                            learnings for use in the AI Brain system prompt
 *
 * Storage:
 *   data/ai-brain-predictions.jsonl  — append-only prediction log (existing)
 *   data/brain-learnings.json        — latest meta-analysis output (overwritten)
 */

const fs      = require('fs')
const path    = require('path')
const Anthropic = require('@anthropic-ai/sdk')

const PRED_LOG       = path.join(__dirname, '../data/ai-brain-predictions.jsonl')
const LEARNINGS_FILE = path.join(__dirname, '../data/brain-learnings.json')
const DATA_DIR       = path.join(__dirname, '../data')

const DAY = 86400 * 1000

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
}

function readPredictions() {
  if (!fs.existsSync(PRED_LOG)) return []
  return fs.readFileSync(PRED_LOG, 'utf8')
    .split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
}

function writePredictions(records) {
  ensureDataDir()
  fs.writeFileSync(PRED_LOG, records.map(r => JSON.stringify(r)).join('\n') + '\n')
}

// Fetch daily OHLC bars via the internal market API. Returns [{t(ms),o,h,l,c}]
// sorted ascending, or [] on failure.
async function fetchDailyBars(symbol, range = '6mo') {
  try {
    const port = process.env.PORT || 3001
    const r = await fetch(
      `http://127.0.0.1:${port}/api/chart?symbol=${encodeURIComponent(symbol)}&interval=1d&range=${range}`,
      { headers: { 'x-internal': '1' }, signal: AbortSignal.timeout(15_000) }
    )
    const d    = await r.json()
    const res0 = d?.chart?.result?.[0]
    const ts   = res0?.timestamp
    const q    = res0?.indicators?.quote?.[0]
    if (!ts?.length || !q?.close) return []
    return ts.map((t, i) => ({
      t: t * 1000,
      o: q.open?.[i],  h: q.high?.[i],
      l: q.low?.[i],   c: q.close?.[i],
    })).filter(b => b.c != null && !isNaN(b.c))
  } catch { return [] }
}

// Close of the bar nearest to targetMs, within toleranceDays (handles weekends
// and holidays for equities). Returns null when no bar is close enough.
function nearestClose(bars, targetMs, toleranceDays = 4) {
  if (!bars?.length) return null
  let best = null, bestDist = Infinity
  for (const b of bars) {
    const dist = Math.abs(b.t - targetMs)
    if (dist < bestDist) { bestDist = dist; best = b }
  }
  if (!best || bestDist > toleranceDays * DAY) return null
  return best.c
}

// Did price ever trade inside [zoneLow, zoneHigh] between fromMs and toMs?
// Returns null when the zone is undefined (legacy records), true/false otherwise.
function zoneTouched(bars, fromMs, toMs, zoneLow, zoneHigh) {
  if (zoneLow == null || zoneHigh == null) return null
  if (!bars?.length) return null
  let sawBars = false
  for (const b of bars) {
    if (b.t < fromMs || b.t > toMs) continue
    sawBars = true
    const lo = b.l ?? b.c
    const hi = b.h ?? b.c
    if (lo <= zoneHigh && hi >= zoneLow) return true
  }
  return sawBars ? false : null
}

// Benchmark to measure alpha against: BTC for crypto, SPY for everything else.
function benchmarkFor(symbol) {
  return /-USD$/.test(symbol || '') ? 'BTC-USD' : 'SPY'
}

// ── 1. Resolve outcomes ───────────────────────────────────────────────────────
// Called nightly. For predictions that are ≥7d or ≥30d old and unresolved,
// resolve against the historical bar at exactly +7/+30 days from generation.

async function resolveOutcomes() {
  const records = readPredictions()
  if (!records.length) return { resolved7d: 0, resolved30d: 0 }

  const now = Date.now()
  let resolved7d = 0, resolved30d = 0

  const toResolve = records.filter(r => {
    const age = now - new Date(r.generatedAt).getTime()
    return (age >= 7 * DAY && r.price7d == null) ||
           (age >= 30 * DAY && r.price30d == null)
  })
  if (!toResolve.length) return { resolved7d: 0, resolved30d: 0 }

  // Fetch bars once per unique symbol (+ the two possible benchmarks)
  const symbols = [...new Set(toResolve.map(r => r.symbol))]
  const benches = [...new Set(toResolve.map(r => benchmarkFor(r.symbol)))]
  const barsMap = {}
  await Promise.all([...symbols, ...benches].map(async sym => {
    barsMap[sym] = await fetchDailyBars(sym)
  }))

  const updated = records.map(r => {
    const genMs = new Date(r.generatedAt).getTime()
    const age   = now - genMs
    const bars  = barsMap[r.symbol]
    if (!bars?.length) return r

    const benchBars = barsMap[benchmarkFor(r.symbol)] || []
    const copy = { ...r }

    // Baseline price on the prediction date — the honest "you could have bought
    // here" anchor (falls back to entry-zone mid for legacy records)
    if (copy.basePrice == null) {
      copy.basePrice = nearestClose(bars, genMs) ?? copy.priceAtPrediction ?? copy.entryZoneMid ?? null
    }
    const benchBase = nearestClose(benchBars, genMs)

    const resolveHorizon = (days, priceKey, benchKey) => {
      if (age < days * DAY || copy[priceKey] != null) return false
      const px = nearestClose(bars, genMs + days * DAY)
      if (px == null) return false
      copy[priceKey] = px
      const benchPx = nearestClose(benchBars, genMs + days * DAY)
      if (benchBase && benchPx != null) {
        copy[benchKey] = +(((benchPx - benchBase) / benchBase) * 100).toFixed(2)
      }
      return true
    }

    if (resolveHorizon(7,  'price7d',  'benchRet7d'))  resolved7d++
    if (resolveHorizon(30, 'price30d', 'benchRet30d')) resolved30d++

    // Fill check: did price actually enter the entry zone in the first 7 days?
    if (copy.entered === undefined) {
      copy.entered = zoneTouched(
        bars, genMs, genMs + 7 * DAY,
        r.entryZoneMid != null ? r.entryZoneMid * 0.98 : null,
        r.entryZoneMid != null ? r.entryZoneMid * 1.02 : null,
      )
    }

    copy.resolvedV2 = true
    return copy
  })

  writePredictions(updated)
  console.log(`[brain-learnings] resolved outcomes: ${resolved7d} @ 7d, ${resolved30d} @ 30d (exact-date, benchmark-relative)`)
  return { resolved7d, resolved30d }
}

// ── Deterministic stats — computed in code, never by the LLM ─────────────────

function returnsFor(r, priceKey) {
  const base = r.basePrice ?? r.priceAtPrediction ?? r.entryZoneMid
  const px   = r[priceKey]
  if (!base || px == null) return null
  return +(((px - base) / base) * 100).toFixed(2)
}

function computeStats(records) {
  const resolved = records.filter(r => r.price7d != null || r.price30d != null)

  const horizon = (priceKey, benchKey) => {
    const rows = resolved
      .map(r => ({
        ret:   returnsFor(r, priceKey),
        bench: r[benchKey] ?? null,
        conf:  r.confidence ?? 'Unknown',
        entered: r.entered,
        hitTarget: r.targetZoneMid != null && r[priceKey] != null ? r[priceKey] >= r.targetZoneMid : null,
      }))
      .filter(x => x.ret != null)
    if (!rows.length) return null

    // "Tradeable" predictions: price actually entered the entry zone (legacy
    // records with unknown fill are kept but flagged separately)
    const tradeable = rows.filter(x => x.entered !== false)
    const withBench = tradeable.filter(x => x.bench != null)
    const withTarget = tradeable.filter(x => x.hitTarget != null)

    const pct = (arr, pred) => arr.length ? +(arr.filter(pred).length / arr.length).toFixed(3) : null
    const avg = (arr, f) => arr.length ? +(arr.reduce((s, x) => s + f(x), 0) / arr.length).toFixed(2) : null

    return {
      n:             rows.length,
      nTradeable:    tradeable.length,
      neverEntered:  rows.filter(x => x.entered === false).length,
      winRate:       pct(tradeable, x => x.ret > 0),
      avgReturn:     avg(tradeable, x => x.ret),
      alphaWinRate:  pct(withBench, x => x.ret > x.bench),
      avgAlpha:      avg(withBench, x => x.ret - x.bench),
      targetHitRate: pct(withTarget, x => x.hitTarget),
    }
  }

  // Calibration: does stated confidence predict outcomes? (30d preferred)
  const calibration = {}
  for (const bucket of ['High', 'Medium', 'Low']) {
    const rows = resolved
      .filter(r => r.confidence === bucket && r.entered !== false)
      .map(r => ({
        ret:   returnsFor(r, r.price30d != null ? 'price30d' : 'price7d'),
        bench: r.price30d != null ? r.benchRet30d : r.benchRet7d,
      }))
      .filter(x => x.ret != null)
    if (!rows.length) continue
    const withBench = rows.filter(x => x.bench != null)
    calibration[bucket] = {
      n:            rows.length,
      winRate:      +(rows.filter(x => x.ret > 0).length / rows.length).toFixed(3),
      alphaWinRate: withBench.length ? +(withBench.filter(x => x.ret > x.bench).length / withBench.length).toFixed(3) : null,
    }
  }

  // Ensemble: does cross-model agreement predict better outcomes? (30d preferred)
  const ensemble = {}
  for (const flag of [true, false]) {
    const rows = resolved
      .filter(r => r.ensembleConfirmed === flag && r.entered !== false)
      .map(r => ({
        ret:   returnsFor(r, r.price30d != null ? 'price30d' : 'price7d'),
        bench: r.price30d != null ? r.benchRet30d : r.benchRet7d,
      }))
      .filter(x => x.ret != null)
    if (!rows.length) continue
    const withBench = rows.filter(x => x.bench != null)
    ensemble[flag ? 'confirmed' : 'unconfirmed'] = {
      n:            rows.length,
      winRate:      +(rows.filter(x => x.ret > 0).length / rows.length).toFixed(3),
      alphaWinRate: withBench.length ? +(withBench.filter(x => x.ret > x.bench).length / withBench.length).toFixed(3) : null,
    }
  }

  return {
    totalResolved: resolved.length,
    h7:  horizon('price7d',  'benchRet7d'),
    h30: horizon('price30d', 'benchRet30d'),
    calibration,
    ensemble: Object.keys(ensemble).length ? ensemble : null,
  }
}

// ── 2. Meta-analysis — Claude interprets pre-computed stats ──────────────────

async function runMetaAnalysis() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null

  const records  = readPredictions()
  const resolved = records.filter(r => r.price7d != null || r.price30d != null)
  if (resolved.length < 5) {
    console.log('[brain-learnings] not enough resolved predictions yet:', resolved.length)
    return null
  }

  const stats = computeStats(records)

  const dataset = resolved.slice(-100).map(r => ({
    symbol:           r.symbol,
    generatedAt:      r.generatedAt?.slice(0, 10),
    verdict:          r.verdict,
    confidence:       r.confidence ?? null,
    compositeScore:   r.compositeScore,
    fundamentalScore: r.fundamentalScore,
    technicalScore:   r.technicalScore,
    sentimentScore:   r.sentimentScore,
    macroScore:       r.macroScore,
    riskScore:        r.riskScore,
    hadConflict:      r.agentConflict?.exists ?? false,
    ensembleConfirmed: r.ensembleConfirmed ?? null,
    entered:          r.entered ?? null,
    ret7d:            returnsFor(r, 'price7d'),
    ret30d:           returnsFor(r, 'price30d'),
    benchRet7d:       r.benchRet7d ?? null,
    benchRet30d:      r.benchRet30d ?? null,
    thesisAssumptions: r.thesisAssumptions?.slice(0, 2),
  }))

  const prompt = `You are the AI Brain's self-improvement engine. You have ${dataset.length} past predictions with actual outcomes.

PRE-COMPUTED STATISTICS (calculated deterministically — trust these, do NOT recompute):
${JSON.stringify(stats, null, 2)}

Notes on the stats:
- winRate counts return > 0; alphaWinRate counts return > benchmark (SPY for equities, BTC for crypto) over the same window — alphaWinRate is the number that matters
- neverEntered = predictions whose entry zone was never touched (excluded from win rates; a fill that never happened is not a win)
- calibration shows whether stated High/Medium/Low confidence actually predicted better outcomes
- ensemble (when present) splits outcomes by cross-model agreement: confirmed = Claude and the second model both picked the symbol with matching verdict

PREDICTION OUTCOMES (last ${dataset.length} resolved):
${JSON.stringify(dataset, null, 2)}

Analyze this history. Identify:
1. Which score combinations (fundamental/technical/sentiment/macro/risk) most reliably led to BENCHMARK-BEATING gains
2. Which verdicts and confidence levels had the highest/lowest alpha — is confidence calibrated?
3. Whether agent conflict (hadConflict=true) was a useful warning signal
4. Score thresholds that separated alpha-winners from losers
5. Any patterns in timing (market regimes, sectors, asset types)
6. What the Brain should weight MORE or LESS going forward

Respond ONLY with a JSON object:
{
  "keyLearnings": [
    "concise actionable finding 1 (max 100 chars)",
    "concise actionable finding 2",
    ...up to 8
  ],
  "scoreWeightAdjustments": {
    "fundamentalScore": "increase|decrease|maintain — reason",
    "technicalScore":   "increase|decrease|maintain — reason",
    "sentimentScore":   "increase|decrease|maintain — reason",
    "macroScore":       "increase|decrease|maintain — reason",
    "riskScore":        "increase|decrease|maintain — reason"
  },
  "conflictSignalUseful": true|false,
  "confidenceCalibrated": true|false,
  "bestCompositeThreshold": <score 0-100 above which alpha was highest>,
  "promptInjection": "2-3 sentence summary of what the Brain learned, written as a directive for the next scan"
}`

  try {
    const client = new Anthropic({ apiKey })
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = msg.content?.[0]?.text || ''
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('No JSON in meta-analysis response')

    const learnings = JSON.parse(match[0])
    learnings.updatedAt     = new Date().toISOString()
    learnings.totalResolved = resolved.length
    // Authoritative numbers come from code, not the LLM
    learnings.stats      = stats
    learnings.winRate7d  = stats.h7?.alphaWinRate  ?? stats.h7?.winRate  ?? null
    learnings.winRate30d = stats.h30?.alphaWinRate ?? stats.h30?.winRate ?? null

    ensureDataDir()
    fs.writeFileSync(LEARNINGS_FILE, JSON.stringify(learnings, null, 2))
    console.log(`[brain-learnings] meta-analysis complete: ${learnings.keyLearnings?.length} learnings, alpha win rate 30d=${learnings.winRate30d != null ? (learnings.winRate30d * 100).toFixed(0) + '%' : 'n/a'}`)
    return learnings
  } catch (e) {
    console.error('[brain-learnings] meta-analysis failed:', e.message)
    return null
  }
}

// ── 3. Get learnings block for prompt injection ───────────────────────────────
// Called by ai-brain.js at scan time. Returns a string to prepend to the system prompt.

function getLearningsBlock() {
  try {
    if (!fs.existsSync(LEARNINGS_FILE)) return ''
    const data = JSON.parse(fs.readFileSync(LEARNINGS_FILE, 'utf8'))
    if (!data?.keyLearnings?.length) return ''

    const age = Date.now() - new Date(data.updatedAt).getTime()
    const ageDays = Math.floor(age / 86400000)
    if (ageDays > 7) return '' // stale — don't inject outdated learnings

    const s = data.stats
    const fmtPct = v => v != null ? `${(v * 100).toFixed(0)}%` : 'n/a'

    const lines = [
      `\n## SELF-LEARNED INTELLIGENCE (from ${data.totalResolved} resolved predictions, updated ${ageDays}d ago)`,
      s?.h7 || s?.h30
        ? `Benchmark-beating (alpha) win rates: 7d=${fmtPct(s?.h7?.alphaWinRate)} | 30d=${fmtPct(s?.h30?.alphaWinRate)} · Raw win rates: 7d=${fmtPct(s?.h7?.winRate)} | 30d=${fmtPct(s?.h30?.winRate)}`
        : `Win rates: 7d=${fmtPct(data.winRate7d)} | 30d=${fmtPct(data.winRate30d)}`,
      `Best composite score threshold: ${data.bestCompositeThreshold ?? 'TBD'}/100`,
      `Agent conflict signal useful: ${data.conflictSignalUseful ? 'YES — flag conflicts prominently' : 'NO — do not over-weight'}`,
    ]

    if (s?.calibration && Object.keys(s.calibration).length) {
      lines.push('CONFIDENCE CALIBRATION (stated confidence → actual alpha win rate):')
      for (const [bucket, c] of Object.entries(s.calibration)) {
        lines.push(`  ${bucket}: ${fmtPct(c.alphaWinRate ?? c.winRate)} over ${c.n} predictions`)
      }
      if (data.confidenceCalibrated === false) {
        lines.push('  ⚠️ Confidence has NOT been predictive — be conservative when claiming High confidence.')
      }
    }

    if (s?.ensemble) {
      lines.push('CROSS-MODEL ENSEMBLE (alpha win rate when both models agreed vs primary-only picks):')
      for (const [k, c] of Object.entries(s.ensemble)) {
        lines.push(`  ${k}: ${fmtPct(c.alphaWinRate ?? c.winRate)} over ${c.n} predictions`)
      }
    }

    lines.push(
      '',
      'KEY LEARNINGS FROM PAST PREDICTIONS:',
      ...(data.keyLearnings || []).map((l, i) => `  ${i + 1}. ${l}`),
      '',
      data.promptInjection || '',
      '',
      'SCORE WEIGHT GUIDANCE:',
      ...Object.entries(data.scoreWeightAdjustments || {}).map(([k, v]) => `  ${k}: ${v}`),
    )

    return lines.join('\n')
  } catch { return '' }
}

module.exports = {
  resolveOutcomes,
  runMetaAnalysis,
  getLearningsBlock,
  // exported for unit tests
  computeStats,
  nearestClose,
  zoneTouched,
  benchmarkFor,
}
