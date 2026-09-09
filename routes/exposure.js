'use strict'
/**
 * routes/exposure.js — "which listed stocks have exposure to X, and should I
 * buy any of them?"
 *
 * X can be a listed company (NVDA, TSM, PLTR) or a private one (SpaceX,
 * OpenAI). The private case is the one you cannot answer any other way: you
 * cannot buy SpaceX, so the only actionable question is which LISTED companies
 * have revenue riding on it.
 *
 * Endpoints
 *   GET  /api/exposure/anchors        available anchors + what is already mapped
 *   GET  /api/exposure/:anchor        build/refresh the exposure map (heartbeated)
 *   GET  /api/exposure/:anchor/graph  last stored map, no network, instant
 *   POST /api/exposure/:anchor/research  map -> AI Brain scan on that universe
 *
 * PIPELINE. Candidates come from EDGAR (never from a model), the model only
 * classifies retrieved filing text, and every quote it returns is checked
 * character-for-character against the source before the edge is kept
 * (lib/exposure-map.js:verifyFinding). Ranking is arithmetic over measured
 * facts. This is the same LLM-proposes / engine-judges split as strategy-lab.
 *
 * The result is a UNIVERSE, not advice. /research hands the surviving tickers
 * to the existing AI Brain scan, which is where buy/sell reasoning already
 * lives — this route deliberately owns none of it.
 */

const express  = require('express')
const router   = express.Router()
const rateLimit = require('express-rate-limit')
const { requireAuth } = require('../middleware/auth')
const { skipLoopback } = require('../lib/ai-job-routes')
const { getRouter } = require('../lib/ai-router')
const { CircuitOpenError } = require('../lib/circuit-breaker')
const { startJsonHeartbeat } = require('../lib/http-heartbeat')
const { tryParseAiJson } = require('../lib/ai-json')
const { INTERNAL_SECRET } = require('../lib/internal-secret')

const edgarSearch = require('../lib/edgar-search')
const exposureMap = require('../lib/exposure-map')
const entityGraph = require('../lib/entity-graph')
const { getLatestFiling, extractTermWindows, ALL_FORMS } = require('../lib/filings')

const aiRouter = getRouter('exposure')

// Each run fans out to EDGAR plus one LLM call per candidate, so it is far more
// expensive than a quote lookup. skipLoopback so scheduled refreshes over
// 127.0.0.1 don't consume a user's budget.
const exposureLimit = rateLimit({
  windowMs: 60 * 1000, max: 4,
  skip: skipLoopback,
  message: { error: 'Too many exposure requests — wait a minute' },
})

const MAX_CANDIDATES = 12   // LLM calls per run; the cost ceiling
const cleanAnchor = a => String(a || '').toUpperCase().trim().replace(/[^A-Z0-9.\-]/g, '').slice(0, 24)

/**
 * Classify one candidate against the anchor.
 *
 * Returns null for every failure mode — no filing, no mention, unparseable
 * response, unverifiable quote. A candidate that cannot be evidenced simply
 * does not become an edge; there is no "probable" tier, because a probable
 * supply-chain link is the thing this feature exists to not produce.
 */
async function classifyCandidate(candidate, anchorInfo) {
  let filing
  try {
    // sections:false is load-bearing. The default extraction narrows to Item 1A
    // and MD&A, which skips Item 1 Business and the customer-concentration
    // notes — the only places a named supplier or customer actually appears.
    // Windowing over section-narrowed text would find nothing and quietly
    // report every candidate as unevidenced.
    filing = await getLatestFiling(candidate.symbol, { forms: ALL_FORMS, maxChars: 250_000, sections: false })
  } catch { return null }
  if (!filing?.excerpt) return null

  // Windows around the alias that actually matched, falling back to the others.
  let windows = []
  for (const alias of [candidate.matchedAlias, ...anchorInfo.aliases].filter(Boolean)) {
    windows = extractTermWindows(filing.excerpt, alias, { radius: 600, maxWindows: 4 })
    if (windows.length) break
  }
  // The filing does not mention the anchor in the text we can see. The search
  // hit may have been in an exhibit we did not fetch — either way there is no
  // quotable evidence here, so it is not an edge.
  if (!windows.length) return null

  const sourceText = windows.map(w => w.text).join('\n\n')

  let raw
  try {
    const r = await aiRouter.call({
      prompt: exposureMap.buildClassifyPrompt({
        anchorLabel: anchorInfo.label,
        candidateSymbol: candidate.symbol,
        candidateCompany: candidate.company,
        windows,
      }),
      maxTokens: 700,
      symbols: [candidate.symbol],
    })
    raw = r.text
  } catch { return null }

  const parsed = tryParseAiJson(raw)
  if (!parsed || parsed.relation === 'none') return null

  const check = exposureMap.verifyFinding(parsed, sourceText, { anchorAliases: anchorInfo.aliases })
  if (!check.ok) {
    console.log(`[exposure] ${candidate.symbol}: finding rejected — ${check.reason}`)
    return null
  }

  return {
    symbol:  candidate.symbol,
    cik:     candidate.cik,
    company: candidate.company,
    form:    filing.form,
    filedAt: filing.filingDate,
    url:     filing.url,
    discovery: candidate.discovery,
    ...check.finding,
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

/** Anchors you can map, plus what has already been built. */
router.get('/anchors', (req, res) => {
  res.json({
    private: Object.entries(edgarSearch.PRIVATE_ANCHORS).map(([key, v]) => ({ key, label: v.label, listed: false })),
    note: 'Any US-listed ticker also works as an anchor (e.g. NVDA, TSM, PLTR).',
    tracked: entityGraph.trackedAnchors(),
    relations: exposureMap.RELATIONS,
  })
})

/** Last stored map. No network, no LLM — instant, and safe to poll. */
router.get('/:anchor/graph', (req, res) => {
  const anchor = cleanAnchor(req.params.anchor)
  if (!anchor) return res.status(400).json({ error: 'Invalid anchor' })
  const edges = entityGraph.latestEdges(anchor)
  res.json({
    anchor, edges,
    universe: exposureMap.toUniverse(edges),
    cached: true,
    count: edges.length,
  })
})

/**
 * Build (or refresh) the exposure map.
 *
 * Heartbeated: a full run is several EDGAR round-trips plus up to
 * MAX_CANDIDATES model calls, which is long enough that a mobile connection
 * would otherwise be dropped and surface as a bare "Load failed".
 * Once heartbeating starts the status pins to 200, so CLIENTS MUST CHECK
 * `data.error` as well as `res.ok`.
 */
router.get('/:anchor', requireAuth, exposureLimit, async (req, res) => {
  startJsonHeartbeat(res)

  const anchor = cleanAnchor(req.params.anchor)
  if (!anchor) return res.status(400).json({ error: 'Invalid anchor' })

  const includePeers = req.query.peers !== 'false'
  const wantSuppliers = req.query.suppliers !== 'false'

  try {
    const anchorInfo = await edgarSearch.resolveAnchor(anchor)
    if (!anchorInfo) return res.status(404).json({ error: `Could not resolve anchor: ${anchor}` })

    const findings = []
    const notes = []

    // ── Path 1: peers. Deterministic, local, no model, no network. Runs first
    // so a run still returns something useful when EDGAR search is unavailable.
    if (includePeers && anchorInfo.listed) {
      const { basis, peers } = edgarSearch.findPeers(anchorInfo.key, { limit: 15 })
      if (peers.length) {
        findings.push(...peers.map(p => ({ ...p, materialityPct: null })))
        notes.push(`${peers.length} peers by ${basis} classification`)
      }
    }

    // ── Path 2: suppliers/customers/partners via EDGAR full-text search.
    let candidates = []
    if (wantSuppliers) {
      try {
        candidates = await edgarSearch.findMentions(anchorInfo, { forms: ['10-K', '20-F'], limitPerAlias: 40 })
        // Densest mentions first — a filing naming the anchor repeatedly is a
        // better bet than one passing reference, and the LLM budget is finite.
        candidates.sort((a, b) => b.mentions - a.mentions)
        candidates = candidates.slice(0, MAX_CANDIDATES)
        notes.push(`${candidates.length} filing-search candidates classified`)
      } catch (err) {
        notes.push(`filing search unavailable (${err.message}) — peers only`)
        console.warn('[exposure] full-text search failed:', err.message)
      }
    }

    const classified = await Promise.all(candidates.map(c => classifyCandidate(c, anchorInfo).catch(() => null)))
    findings.push(...classified.filter(Boolean))

    const edges = exposureMap.buildEdges(anchor, findings)

    // Diff BEFORE writing, or the snapshot we just wrote becomes its own baseline.
    const previous = entityGraph.latestEdges(anchor)
    const diff = entityGraph.diffEdges(previous, edges)
    entityGraph.writeSnapshot(anchor, edges)

    return res.json({
      anchor,
      label: anchorInfo.label,
      listed: anchorInfo.listed,
      aliasesSearched: anchorInfo.aliases,
      edges,
      universe: exposureMap.toUniverse(edges),
      diff: previous.length ? diff : null,   // no diff on a first run
      notes,
      generatedAt: new Date().toISOString(),
    })
  } catch (err) {
    if (err instanceof CircuitOpenError) return res.status(503).json({ error: err.message, circuitOpen: true })
    console.error('[exposure]', err.message)
    return res.status(500).json({ error: 'Exposure map failed: ' + err.message })
  }
})

/**
 * Research the mapped universe.
 *
 * The hand-off that makes this feature answer "which ones to buy": the edges
 * become a custom symbol universe and go straight into the existing AI Brain
 * scan, which already scores fundamentals/technicals/sentiment/macro/risk and
 * is already calibrated against resolved outcomes. No new research logic.
 */
router.post('/:anchor/research', requireAuth, exposureLimit, async (req, res) => {
  startJsonHeartbeat(res)

  const anchor = cleanAnchor(req.params.anchor)
  if (!anchor) return res.status(400).json({ error: 'Invalid anchor' })

  const edges = entityGraph.latestEdges(anchor)
  if (!edges.length)
    return res.status(404).json({ error: `No exposure map for ${anchor} yet — run GET /api/exposure/${anchor} first` })

  const universe = exposureMap.toUniverse(edges, { limit: Math.min(Number(req.body?.limit) || 15, 25) })
  if (!universe.length)
    return res.status(422).json({ error: `Exposure map for ${anchor} has no actionable tickers` })

  try {
    const port = process.env.PORT || 3001
    const r = await fetch(`http://127.0.0.1:${port}/api/ai-brain/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal': '1', 'x-internal-secret': INTERNAL_SECRET },
      // symbols takes precedence over scanMode in the scan handler, so the
      // exposure universe replaces the built-in lists wholesale.
      body: JSON.stringify({ symbols: universe }),
      signal: AbortSignal.timeout(600_000),
    })
    const scan = await r.json()
    if (scan?.error) return res.json({ error: scan.error })

    return res.json({
      anchor,
      universe,
      exposureBlock: exposureMap.exposureBlock(anchor, edges),
      scan,
      generatedAt: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[exposure/research]', err.message)
    return res.json({ error: 'Research scan failed: ' + err.message })
  }
})

module.exports = router
module.exports.classifyCandidate = classifyCandidate
