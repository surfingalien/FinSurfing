'use strict'
/**
 * lib/brain-learnings.js
 *
 * Self-improvement loop for the AI Brain.
 *
 * Flow (runs nightly via scheduled-jobs.js):
 *   1. resolveOutcomes()  — fetch actual prices for predictions made 7/30d ago;
 *                           write price7d / price30d back to the JSONL log
 *   2. runMetaAnalysis()  — Claude reads resolved predictions, identifies what
 *                           worked / failed, and writes structured learnings
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

async function fetchCurrentPrice(symbol) {
  try {
    const port = process.env.PORT || 3001
    const r = await fetch(
      `http://127.0.0.1:${port}/api/quote?symbols=${encodeURIComponent(symbol)}`,
      { headers: { 'x-internal': '1' }, signal: AbortSignal.timeout(8000) }
    )
    const d = await r.json()
    return d?.quoteResponse?.result?.[0]?.regularMarketPrice ?? null
  } catch { return null }
}

// ── 1. Resolve outcomes ───────────────────────────────────────────────────────
// Called nightly. Fetches current prices for predictions that are 7d or 30d old
// and haven't had their outcome filled yet.

async function resolveOutcomes() {
  const records = readPredictions()
  if (!records.length) return { resolved7d: 0, resolved30d: 0 }

  const now = Date.now()
  const DAY = 86400 * 1000
  let resolved7d = 0, resolved30d = 0

  // Batch unique symbols to resolve
  const toResolve = records.filter(r => {
    const age = now - new Date(r.generatedAt).getTime()
    return (age >= 7 * DAY && r.price7d == null) ||
           (age >= 30 * DAY && r.price30d == null)
  })

  if (!toResolve.length) return { resolved7d: 0, resolved30d: 0 }

  // Fetch prices for unique symbols
  const symbols = [...new Set(toResolve.map(r => r.symbol))]
  const priceMap = {}
  await Promise.all(symbols.map(async sym => {
    priceMap[sym] = await fetchCurrentPrice(sym)
  }))

  // Update records
  const updated = records.map(r => {
    const age = now - new Date(r.generatedAt).getTime()
    const price = priceMap[r.symbol]
    if (!price) return r
    const copy = { ...r }
    if (age >= 7 * DAY && r.price7d == null) { copy.price7d = price; resolved7d++ }
    if (age >= 30 * DAY && r.price30d == null) { copy.price30d = price; resolved30d++ }
    return copy
  })

  writePredictions(updated)
  console.log(`[brain-learnings] resolved outcomes: ${resolved7d} @ 7d, ${resolved30d} @ 30d`)
  return { resolved7d, resolved30d }
}

// ── 2. Meta-analysis — Claude learns from past predictions ────────────────────

async function runMetaAnalysis() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null

  const records = readPredictions()
  // Only use resolved predictions for learning
  const resolved = records.filter(r => r.price7d != null || r.price30d != null)
  if (resolved.length < 5) {
    console.log('[brain-learnings] not enough resolved predictions yet:', resolved.length)
    return null
  }

  // Build analysis dataset
  const dataset = resolved.slice(-100).map(r => {
    const entry = r.entryZoneMid
    const target = r.targetZoneMid
    const price7d = r.price7d
    const price30d = r.price30d

    const ret7d  = entry && price7d  ? +((price7d  - entry) / entry * 100).toFixed(2) : null
    const ret30d = entry && price30d ? +((price30d - entry) / entry * 100).toFixed(2) : null
    const hitTarget7d  = target && price7d  ? price7d  >= target : null
    const hitTarget30d = target && price30d ? price30d >= target : null

    return {
      symbol:           r.symbol,
      generatedAt:      r.generatedAt?.slice(0, 10),
      verdict:          r.verdict,
      compositeScore:   r.compositeScore,
      fundamentalScore: r.fundamentalScore,
      technicalScore:   r.technicalScore,
      sentimentScore:   r.sentimentScore,
      macroScore:       r.macroScore,
      riskScore:        r.riskScore,
      hadConflict:      r.agentConflict?.exists ?? false,
      ret7d, ret30d, hitTarget7d, hitTarget30d,
      thesisAssumptions: r.thesisAssumptions?.slice(0, 2),
    }
  })

  const winRate7d  = dataset.filter(r => r.ret7d  != null && r.ret7d  > 0).length / dataset.filter(r => r.ret7d  != null).length
  const winRate30d = dataset.filter(r => r.ret30d != null && r.ret30d > 0).length / dataset.filter(r => r.ret30d != null).length

  const prompt = `You are the AI Brain's self-improvement engine. You have access to ${dataset.length} past predictions with actual outcomes.

Win rates: 7-day ${(winRate7d * 100).toFixed(0)}% | 30-day ${(winRate30d * 100).toFixed(0)}%

PREDICTION OUTCOMES (last ${dataset.length} resolved):
${JSON.stringify(dataset, null, 2)}

Analyze this prediction history deeply. Identify:
1. Which score combinations (fundamental/technical/sentiment/macro/risk) most reliably led to actual price gains
2. Which verdicts (STRONG BUY, BUY, HOLD, etc.) had the highest/lowest accuracy
3. Whether agent conflict (hadConflict=true) was a useful warning signal
4. Score thresholds that separated winners from losers
5. Any patterns in timing (market regimes, sectors, etc.)
6. What the Brain should weight MORE or LESS going forward

Respond ONLY with a JSON object:
{
  "updatedAt": "ISO date",
  "totalResolved": <n>,
  "winRate7d": <0-1>,
  "winRate30d": <0-1>,
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
  "bestCompositeThreshold": <score 0-100 above which accuracy was highest>,
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
    learnings.updatedAt = new Date().toISOString()
    learnings.totalResolved = resolved.length

    ensureDataDir()
    fs.writeFileSync(LEARNINGS_FILE, JSON.stringify(learnings, null, 2))
    console.log(`[brain-learnings] meta-analysis complete: ${learnings.keyLearnings?.length} learnings, win rate 7d=${(learnings.winRate7d*100).toFixed(0)}%`)
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

    const lines = [
      `\n## SELF-LEARNED INTELLIGENCE (from ${data.totalResolved} resolved predictions, updated ${ageDays}d ago)`,
      `Win rates: 7d=${(data.winRate7d * 100).toFixed(0)}% | 30d=${(data.winRate30d * 100).toFixed(0)}%`,
      `Best composite score threshold: ${data.bestCompositeThreshold ?? 'TBD'}/100`,
      `Agent conflict signal useful: ${data.conflictSignalUseful ? 'YES — flag conflicts prominently' : 'NO — do not over-weight'}`,
      '',
      'KEY LEARNINGS FROM PAST PREDICTIONS:',
      ...(data.keyLearnings || []).map((l, i) => `  ${i + 1}. ${l}`),
      '',
      data.promptInjection || '',
      '',
      'SCORE WEIGHT GUIDANCE:',
      ...Object.entries(data.scoreWeightAdjustments || {}).map(([k, v]) => `  ${k}: ${v}`),
    ]

    return lines.join('\n')
  } catch { return '' }
}

module.exports = { resolveOutcomes, runMetaAnalysis, getLearningsBlock }
