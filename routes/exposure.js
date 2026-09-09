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
 *   POST /api/exposure/job            enqueue a build; returns a jobId immediately
 *   GET  /api/exposure/job/:id        poll it   ·  GET /job/latest restores the last run
 *   GET  /api/exposure/:anchor        build/refresh inline (heartbeated)
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
 *
 * A build is up to MAX_CANDIDATES model calls plus a fan of EDGAR round-trips,
 * so it is also the shape lib/ai-job-queue.js exists for: POST /job enqueues,
 * the run happens server-side, and the result outlives the tab. The inline GET
 * stays for scheduled refreshes and for callers that want the answer in hand.
 */

const express  = require('express')
const router   = express.Router()
const rateLimit = require('express-rate-limit')
const { requireAuth } = require('../middleware/auth')
const { mountJobRoutes, skipLoopback } = require('../lib/ai-job-routes')
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
const MAX_FUND_CANDIDATES = 8   // filing fetches per run; no LLM calls at all
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

/**
 * Evidence a fund's holding in the anchor — with no model call at all.
 *
 * A schedule of investments already STATES the relationship: fund F holds N
 * shares of company C, X% of net assets. There is nothing for a model to
 * classify, so asking one would add a hallucination surface to a fact that is
 * already machine-readable, and pay for the privilege. The quote is sliced
 * straight out of the filing instead, which makes it verbatim by construction.
 *
 * verifyFinding still runs over the result. It cannot fail here, and that is
 * the point: this feature has exactly ONE definition of what counts as
 * evidence, and no path routes around it.
 */
async function describeHolding(candidate, anchorInfo) {
  let filing
  try {
    // Fund reports are long and the schedule of investments sits well past the
    // narrative, so the char budget is far larger than the classify path's.
    filing = await getLatestFiling(candidate.symbol, {
      forms: edgarSearch.FUND_FORMS, maxChars: 400_000, sections: false,
    })
  } catch { return null }
  if (!filing?.excerpt) return null

  // The search hit named an accession; this is the fund's LATEST report, which
  // may be a newer one. That is the right bias — a position the fund has since
  // exited is not exposure you can buy today — but it does mean a stale hit
  // legitimately evidences nothing and drops out here.
  const ev = exposureMap.extractHoldingEvidence(filing.excerpt, anchorInfo.aliases)
  if (!ev) return null

  const check = exposureMap.verifyFinding(
    { relation: 'holder', quote: ev.quote, materialityPct: ev.materialityPct,
      note: `Disclosed holding in ${anchorInfo.label}` },
    filing.excerpt,
    { anchorAliases: anchorInfo.aliases },
  )
  if (!check.ok) {
    console.log(`[exposure] ${candidate.symbol}: holding rejected — ${check.reason}`)
    return null
  }

  return {
    symbol:  candidate.symbol,
    cik:     candidate.cik,
    company: candidate.company,
    form:    filing.form,
    filedAt: filing.filingDate,
    url:     filing.url,
    discovery: 'fund_holding',
    ...check.finding,
  }
}

/**
 * Build one anchor's exposure map. The whole feature, as a plain function.
 *
 * Extracted from the GET handler so the background queue can drive the same
 * work over its own POST convention without a second implementation of it —
 * the two entry points differ only in how the request arrives.
 *
 * Throws with `.status` set so both callers can map failures identically.
 */
async function buildExposureMap(anchor, { includePeers = true, wantSuppliers = true, wantFunds = true } = {}) {
  const anchorInfo = await edgarSearch.resolveAnchor(anchor)
  if (!anchorInfo) {
    const e = new Error(`Could not resolve anchor: ${anchor}`)
    e.status = 404
    throw e
  }

  const findings = []
  const notes = []
  let searchFailed = false

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
      searchFailed = true
      notes.push(`filing search unavailable (${err.message})`)
      console.warn('[exposure] full-text search failed:', err.message)
    }
  }

  const classified = await Promise.all(candidates.map(c => classifyCandidate(c, anchorInfo).catch(() => null)))
  findings.push(...classified.filter(Boolean))

  // ── Path 3: listed funds and BDCs holding the anchor. Private anchors only
  // (edgar-search.fundHolders enforces it) — for SpaceX or OpenAI a fund's
  // stake is the only equity exposure that can actually be bought.
  if (wantFunds && !anchorInfo.listed) {
    try {
      const holders = (await edgarSearch.fundHolders(anchorInfo, { limitPerAlias: 30 }))
        .sort((a, b) => b.mentions - a.mentions)
        .slice(0, MAX_FUND_CANDIDATES)
      if (holders.length) {
        const described = await Promise.all(holders.map(h => describeHolding(h, anchorInfo).catch(() => null)))
        const kept = described.filter(Boolean)
        findings.push(...kept)
        notes.push(`${kept.length}/${holders.length} fund holdings evidenced from the schedule of investments`)
      }
    } catch (err) {
      searchFailed = true
      notes.push(`fund-holding search unavailable (${err.message})`)
      console.warn('[exposure] fund-holding search failed:', err.message)
    }
  }

  // Say the awkward thing out loud. A private anchor has no peer fallback —
  // peers come from an industry classification only a LISTED company has — so
  // when full-text search is down there is genuinely nothing to show, and an
  // empty map must not read as "no exposure exists".
  if (!findings.length && searchFailed && !anchorInfo.listed) {
    notes.push(
      `EDGAR full-text search is unreachable, and a private anchor has no peer fallback ` +
      `(peers come from an industry classification only listed companies have). ` +
      `This is not evidence that nothing is exposed to ${anchorInfo.label} — try again later.`)
  }

  const edges = exposureMap.buildEdges(anchor, findings)

  // Diff BEFORE writing, or the snapshot we just wrote becomes its own baseline.
  const previous = entityGraph.latestEdges(anchor)
  const diff = entityGraph.diffEdges(previous, edges)
  entityGraph.writeSnapshot(anchor, edges)

  return {
    anchor,
    label: anchorInfo.label,
    listed: anchorInfo.listed,
    aliasesSearched: anchorInfo.aliases,
    edges,
    universe: exposureMap.toUniverse(edges),
    diff: previous.length ? diff : null,   // no diff on a first run
    notes,
    searchAvailable: !searchFailed,
    generatedAt: new Date().toISOString(),
  }
}

/** Map a build failure onto a response, identically for every entry point. */
function sendBuildError(res, err) {
  if (err instanceof CircuitOpenError) return res.status(503).json({ error: err.message, circuitOpen: true })
  if (err.status === 404) return res.status(404).json({ error: err.message })
  console.error('[exposure]', err.message)
  return res.status(500).json({ error: 'Exposure map failed: ' + err.message })
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

/**
 * Background build.
 *
 * Mounted BEFORE '/:anchor', because '/jobs' is a perfectly good match for it
 * and express takes the first route that matches — declared the other way
 * round, listing your runs would try to map a company called JOBS.
 *
 * The queue drives every kind with a POST and a JSON body over loopback, which
 * GET /:anchor cannot serve, so POST /build is that calling convention and
 * nothing else: same function, same options, same response.
 */
mountJobRoutes(router, {
  kind: 'exposure',
  requireAuth,
  noun: 'exposure map',
  buildParams: (req) => {
    const anchor = cleanAnchor(req.body?.anchor)
    if (!anchor) return { error: 'An anchor ticker or private-company key is required' }
    return {
      anchor,
      peers:     req.body?.peers     !== false,
      suppliers: req.body?.suppliers !== false,
      funds:     req.body?.funds     !== false,
    }
  },
  label: p => `Exposure map: ${p.anchor}`,
})

router.post('/build', requireAuth, exposureLimit, async (req, res) => {
  const anchor = cleanAnchor(req.body?.anchor)
  if (!anchor) return res.status(400).json({ error: 'Invalid anchor' })
  try {
    return res.json(await buildExposureMap(anchor, {
      includePeers:  req.body?.peers     !== false,
      wantSuppliers: req.body?.suppliers !== false,
      wantFunds:     req.body?.funds     !== false,
    }))
  } catch (err) {
    return sendBuildError(res, err)
  }
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
 * Build (or refresh) the exposure map inline.
 *
 * Heartbeated: a full run is several EDGAR round-trips plus up to
 * MAX_CANDIDATES model calls, which is long enough that a mobile connection
 * would otherwise be dropped and surface as a bare "Load failed".
 * Once heartbeating starts the status pins to 200, so CLIENTS MUST CHECK
 * `data.error` as well as `res.ok`.
 *
 * The browser uses POST /job instead — see mountJobRoutes above. This stays for
 * the scheduled refresh and for any caller that wants the answer in hand.
 */
router.get('/:anchor', requireAuth, exposureLimit, async (req, res) => {
  startJsonHeartbeat(res)

  const anchor = cleanAnchor(req.params.anchor)
  if (!anchor) return res.status(400).json({ error: 'Invalid anchor' })

  try {
    return res.json(await buildExposureMap(anchor, {
      includePeers:  req.query.peers !== 'false',
      wantSuppliers: req.query.suppliers !== 'false',
      wantFunds:     req.query.funds !== 'false',
    }))
  } catch (err) {
    return sendBuildError(res, err)
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
module.exports.describeHolding  = describeHolding
module.exports.buildExposureMap = buildExposureMap
