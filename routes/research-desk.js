'use strict'

/**
 * routes/research-desk.js — the Research Desk.
 *
 *   GET  /api/research-desk/:symbol/evidence  measured evidence dossier (no LLM)
 *   POST /api/research-desk/:symbol/thesis    evidence → thesis → deterministic
 *                                             judgement → journalled (heartbeated:
 *                                             clients must check data.error)
 *   GET  /api/research-desk/theses            the user's theses + live status
 *   GET  /api/research-desk/track-record      the system's measured record,
 *                                             with intervals, in one place
 *
 * All require auth. The pure logic is lib/research-desk.js; this file only
 * gathers inputs, calls the model once, and persists.
 */

const express = require('express')
const fs      = require('fs')
const path    = require('path')
const crypto  = require('crypto')
const rateLimit = require('express-rate-limit')

const { requireAuth }          = require('../middleware/auth')
const { getRouter }            = require('../lib/ai-router')
const { THESIS_SCHEMA, BULL_SCHEMA, BEAR_SCHEMA, DECISION_SCHEMA } = require('../lib/ai-schemas')
const { tryParseAiJson }       = require('../lib/ai-json')
const { CircuitOpenError }     = require('../lib/circuit-breaker')
const { fetchDailyBars }       = require('../lib/internal-api')
const { compactTaLine }        = require('../lib/technical-indicators')
const { isLastBarForming }     = require('../lib/bar-session')
const { startJsonHeartbeat }   = require('../lib/http-heartbeat')
const { INTERNAL_SECRET }      = require('../lib/internal-secret')
const { isCryptoSymbol }       = require('../lib/crypto-classify')
const { readPredictions, computeStats, getLearningHealth } = require('../lib/brain-learnings')
const { computeEdgeReport }    = require('../lib/edge-report')
const kelly                    = require('../lib/kelly')
const library                  = require('../lib/strategy-library')
const entityGraph              = require('../lib/entity-graph')
const learningStore            = require('../lib/learning-store')
const durableFiles             = require('../lib/durable-files')
const desk                     = require('../lib/research-desk')
const priceRegime              = require('../lib/price-regime')
const { evaluateStatus, recordFacts } = require('../lib/system-status')

const router   = express.Router()
const aiRouter = getRouter('research-desk')

// Server-operator controlled, never user input. Tests MUST set it before
// requiring this route, or they journal fake theses into the real store.
const THESES_FILE = process.env.RESEARCH_THESES_LOG || path.join(require('../lib/data-dir').DATA_DIR, 'research-theses.jsonl')
const SYM = /^[A-Z0-9.\-=^]{1,15}$/
const KEY_HEADERS = ['x-aisa-key', 'x-finnhub-key', 'x-fmp-key', 'x-td-key', 'x-av-key']

// One LLM call per thesis; generous for research, tight enough to stop a loop.
// Keyed by IP like every other limiter here (a custom key generator trips
// express-rate-limit's IPv6 validation).
const thesisLimit = rateLimit({
  windowMs: 15 * 60 * 1000, max: 12,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Thesis limit reached — try again in a few minutes' },
})
// Evidence spends market-data and FMP quota (fundamentals are cached 4h).
const evidenceLimit = rateLimit({
  windowMs: 15 * 60 * 1000, max: 60,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many research requests — try again in a few minutes' },
})

function fwdKeys(req) {
  const h = {}
  for (const k of KEY_HEADERS) if (req.headers[k]) h[k] = req.headers[k]
  return h
}

function cleanSymbol(raw) {
  const s = String(raw || '').toUpperCase().trim()
  return SYM.test(s) ? s : null
}

function assetTypeOf(sym) {
  if (isCryptoSymbol(sym)) return 'crypto'
  try {
    const rec = require('../lib/symbol-db').classify(sym)
    if (rec?.assetClass === 'etf')  return 'etf'
    if (rec?.assetClass === 'fund') return 'fund'
  } catch { /* index optional */ }
  return 'stock'
}

async function fetchFundamentals(sym, headers) {
  try {
    const port = process.env.PORT || 3001
    const r = await fetch(`http://127.0.0.1:${port}/api/fundamentals/${encodeURIComponent(sym)}`, {
      headers: { ...headers, 'x-internal': '1', 'x-internal-secret': INTERNAL_SECRET },
      signal: AbortSignal.timeout(20_000),
    })
    const j = await r.json().catch(() => ({}))
    return r.ok ? j : { error: j?.error || `HTTP ${r.status}` }
  } catch (e) { return { error: e.message } }
}

async function macroSnapshot() {
  try { return await require('./macro').getIndicators() } catch (e) { return { error: e.message } }
}

/** Relationships involving sym, pre-phrased, strongest first. */
function exposureFor(sym) {
  try {
    const all = entityGraph.latestEdges(null)
    const phrased = [
      ...all.filter(e => String(e.anchor).toUpperCase() === sym && e.relation !== 'competitor')
        .map(e => ({ score: e.score, text: `${e.symbol} is a ${e.relation} of ${sym}`, form: e.evidence?.form, filedAt: e.evidence?.filedAt })),
      ...all.filter(e => String(e.symbol).toUpperCase() === sym)
        .map(e => ({ score: e.score, text: `${sym} is a ${e.relation} of ${e.anchor}`, form: e.evidence?.form, filedAt: e.evidence?.filedAt })),
    ]
    return phrased.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 4)
  } catch { return [] }
}

function strategiesFor(sym) {
  try {
    return library.readLibrary()
      .filter(e => e.symbol === sym && e.status !== 'retired')
      .map(e => ({
        strategy: e.strategy, fitness: e.fitness,
        forwardPasses: library.forwardPasses(e),
        lastAlpha: e.validations?.at(-1)?.alpha ?? null,
      }))
      .sort((a, b) => b.forwardPasses - a.forwardPasses || b.fitness - a.fitness)
  } catch { return [] }
}

/** The latest factor-mining run and this symbol's percentiles on its survivors. */
function minedFactorsFor(bars, fund = null) {
  try {
    const fm = require('../lib/factor-mining')
    const library = fm.readLibrary()
    return { library, ranks: library ? fm.percentilesFor(bars, library, { fund }) : [] }
  } catch { return null }
}

/** The symbol's last report, where it stands in the drift window, and the pooled study. */
function earningsDriftFor(sym, bars, fundamentals, secFacts = null) {
  try {
    const pead = require('../lib/pead')
    const studied = pead.readStudy()
    // Estimate-free surprise from the company's own filings, computed live.
    const sueLast = secFacts ? pead.sueSeries(require('../lib/sec-facts').epsQuarters(secFacts)).at(-1) : null
    const sue = sueLast ? { ...sueLast, group: sueLast.sue >= pead.SUE_BEAT ? 'beat' : sueLast.sue <= pead.SUE_MISS ? 'miss' : 'inline', window: pead.windowState({ date: sueLast.filed }, bars) } : null
    const last = (fundamentals?.eps_surprises || []).find(e => e.date && e.surprise_pct != null) || null
    const fromStudy = studied?.latestBySymbol?.[sym]
    const event = last ? { date: String(last.date).slice(0, 10), surprisePct: last.surprise_pct, group: pead.groupOf(last.surprise_pct), estimate: last.estimate, actual: last.actual } : null
    if (!event && !sue) return null
    return {
      study: studied,
      event: event && { ...event, toneChange: fromStudy?.date === event.date ? fromStudy.toneChange : null },
      window: event ? pead.windowState(event, bars) : null,
      sue,
    }
  } catch { return null }
}

/** Everything the thesis may rest on, computed server-side. */
async function gatherEvidence(sym, req) {
  const headers   = fwdKeys(req)
  const assetType = assetTypeOf(sym)
  const [bars, fundamentals, macro, regimes, secFacts] = await Promise.all([
    fetchDailyBars(sym, { range: '2y', headers, timeoutMs: 25_000 }),
    assetType === 'stock' ? fetchFundamentals(sym, headers) : Promise.resolve({ error: `not applicable to ${assetType}` }),
    macroSnapshot(),
    priceRegime.getCurrentRegimes({ fetchBars: s => fetchDailyBars(s, { range: '5y', headers, timeoutMs: 15_000 }) }).catch(() => null),
    // Reported figures straight from SEC filings — keyless, so the dossier keeps
    // its fundamentals when the FMP quota is spent.
    assetType === 'stock' ? require('../lib/sec-facts').getCompanyFacts(sym).catch(() => null) : Promise.resolve(null),
  ])
  if (bars.length < 60) {
    const err = new Error(`Not enough price history for ${sym} (${bars.length} daily bars, need 60+)`)
    err.status = 422
    throw err
  }

  const taLine = compactTaLine(sym, bars.map(b => b.o ?? b.c), bars.map(b => b.h ?? b.c), bars.map(b => b.l ?? b.c), bars.map(b => b.c), bars.map(b => b.v ?? 0),
    { lastBarForming: isLastBarForming(bars, { isCrypto: isCryptoSymbol(sym) }) })
  let records = [], stats = null
  try { records = readPredictions(); stats = computeStats(records) } catch { /* calibration optional */ }
  const horizon = stats?.segmentHorizon ?? 7

  const { items, gaps, facts } = desk.buildEvidence({
    symbol: sym, bars, taLine, fundamentals, macro,
    priceRegime: assetType === 'crypto' ? regimes?.crypto : regimes?.equity,
    minedFactors: assetType === 'stock' ? minedFactorsFor(bars, secFacts) : null,
    reported: secFacts ? require('../lib/sec-facts').snapshotAt(secFacts, new Date().toISOString().slice(0, 10), { price: bars.at(-1)?.c }) : null,
    earningsDrift: assetType === 'stock' ? earningsDriftFor(sym, bars, fundamentals, secFacts) : null,
    strategies: strategiesFor(sym),
    exposure:   exposureFor(sym),
    track:      desk.trackFor(records, { symbol: sym, assetType, horizon }),
  })
  const winProb = kelly.winProbFromStats(stats, { assetType })
  const levels = require('../lib/trade-levels').levelInputs(bars)
  const referenceLevels = levels ? require('../lib/trade-levels').tradeLevels({ price: facts.last, atr: levels.atr, support: levels.support, resistance: levels.resistance }) : null
  return { sym, assetType, facts, items, gaps, winProb, levels, referenceLevels, company: fundamentals?.company?.name ?? null }
}

// ── Journal ───────────────────────────────────────────────────────────────────

function readTheses(file = THESES_FILE) {
  try {
    if (!fs.existsSync(file)) return []
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

function appendThesis(entry, file = THESES_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(entry) + '\n')
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/theses', requireAuth, async (req, res) => {
  const mine = readTheses().filter(t => t.userId === req.user.userId).reverse().slice(0, 25)
  const symbols = [...new Set(mine.filter(t => t.judgement?.verdict === 'actionable').map(t => t.symbol))]
  const barsBy = {}
  await Promise.all(symbols.map(async s => { barsBy[s] = await fetchDailyBars(s, { range: '6mo', headers: fwdKeys(req) }) }))
  res.json({
    theses: mine.map(t => ({
      id: t.id, symbol: t.symbol, company: t.company ?? null, at: t.at, lastPrice: t.lastPrice,
      verdict: t.judgement?.verdict, stance: t.judgement?.stance, summary: t.judgement?.summary,
      horizonDays: t.judgement?.horizonDays, zones: t.judgement?.zones, reasons: t.judgement?.reasons,
      status: desk.thesisStatus(t, barsBy[t.symbol] || []),
    })),
  })
})

router.get('/track-record', requireAuth, (req, res) => {
  let stats = null
  try { stats = computeStats(readPredictions()) } catch { /* empty record */ }
  const edge = stats ? computeEdgeReport(stats) : null
  const persistence = durableFiles.status()
  res.json({
    persistence: { enabled: persistence.enabled, reason: persistence.reason },
    brain: stats && {
      totalResolved: stats.totalResolved, segmentHorizon: stats.segmentHorizon,
      h7: stats.h7, h30: stats.h30, barriers: stats.barriers,
      byAssetType: stats.byAssetType, calibration: stats.calibration,
      autoTune: stats.autoTune, baseline: stats.baseline,
      exitQuality: stats.exitQuality,
      byPriceRegime: stats.byPriceRegime,
    },
    // The benchmarks' current trend/volatility state and what followed each
    // state historically (last fetched by a scan or a dossier — no network here).
    priceRegime: (() => { try { return require('../lib/price-regime').cachedRegimes() } catch { return null } })(),
    // Post-earnings drift: do beats keep beating SPY here, net of costs (lib/pead.js)?
    pead: (() => { try { const p = require('../lib/pead').readStudy(); return p && {
      ranAt: p.ranAt, universe: p.universe, events: p.events, params: p.params, groups: p.groups,
      strategy: p.strategy, spreadVsMiss: p.spreadVsMiss, tone: p.tone, caveats: p.caveats,
      analystNames: p.analystNames ?? null,
      sue: p.sue ? { events: p.sue.events, params: p.sue.params, groups: p.sue.groups, strategy: p.sue.strategy, spreadVsMiss: p.sue.spreadVsMiss } : null,
    } } catch { return null } })(),
    // The second-opinion model on AI Brain picks (lib/meta-label.js).
    metaLabel: (() => { try { const m = require('../lib/meta-label').loadModel(); return m && { validated: m.validated, reason: m.reason, validation: m.validation ?? null, labelled: m.labelled, trainedAt: m.trainedAt } } catch { return null } })(),
    // Which price factors rank the large-cap list (lib/factor-mining.js), last weekly run.
    factors: (() => { try { const l = require('../lib/factor-mining').readLibrary(); return l && {
      ranAt: l.ranAt, universe: l.universe, tested: l.tested, periods: l.periods, horizon: l.horizon, admitted: l.admitted, caveats: l.caveats,
      withFundamentals: l.withFundamentals ?? null,
      proposals: (l.proposals || []).map(p => ({ name: p.name, hypothesis: p.hypothesis, status: p.status, reason: p.reason ?? null })),
      factors: l.factors.map(f => ({ name: f.name, label: f.label, source: f.source ?? 'builtin', verdict: f.verdict, direction: f.direction, train: f.train, holdout: f.holdout, dsr: f.deflated?.dsr ?? null, decay: f.decay ?? null, turnover: f.turnover ?? null })),
    } } catch { return null } })(),
    // Do the self-learned findings hold up against the stats, and do picks
    // made with them beat picks made without (lib/learning-health.js)?
    learningHealth: (() => { try { return getLearningHealth() } catch { return null } })(),
    // The picks vs random picks from the SAME priced list (lib/shadow-baseline.js):
    // beating SPY can be the list; beating these is the model.
    vsRandom: (() => { try { const sb = require('../lib/shadow-baseline'); return sb.compareToShadows(readPredictions(), sb.readShadows()) } catch { return null } })(),
    edges: edge && { overall: edge.overall, tested: edge.tested, topEdges: edge.topEdges, topDrags: edge.topDrags },
    decisions: learningStore.getCalibration(),
    strategies: library.libraryStats(),
    paper: paperFacts(),
  })
})

/** The paper book's record, if paper trading is on. Marked at cost (no live quotes here). */
function paperFacts() {
  try {
    const pb = require('../lib/paper-broker')
    if (!pb.isEnabled()) return { enabled: false }
    const book = pb.loadPortfolio()
    const perf = pb.performance(book, pb.loadTrades())
    return {
      enabled: true,
      openPositions: perf.openPositions, closedTrades: perf.closedTrades, winRate: perf.winRate,
      realizedPnl: perf.realizedPnl, exitsByKind: perf.exitsByKind,
      unmanaged: pb.unmanagedPositions(book),
      protections: pb.protections(pb.loadTrades(), book),
    }
  } catch { return null }
}

// "Is it working?" — every moving part of the research pipeline checked live
// and reported as ok / warn / fail with the reason and the fix. One probe
// quote and one FMP profile are the only quota it spends; it never calls an LLM.
const STATUS_JOBS = ['pre-market-scan', 'brain-learning-cycle', 'brain-evolution', 'symbol-db-refresh', 'macro-pulse']
router.get('/system-status', requireAuth, evidenceLimit, async (req, res) => {
  const headers = fwdKeys(req)
  const facts = {}
  try {
    const port = process.env.PORT || 3001
    const r = await fetch(`http://127.0.0.1:${port}/api/quote?symbols=SPY`, { headers, signal: AbortSignal.timeout(10_000) })
    const q = (await r.json())?.quoteResponse?.result?.[0]
    if (q?.regularMarketPrice > 0 && !q.stale) facts.probeQuote = { symbol: 'SPY', price: q.regularMarketPrice }
  } catch { /* reported as a failed check */ }
  if (!facts.probeQuote) {
    const bars = await fetchDailyBars('SPY', { range: '1mo', headers, timeoutMs: 10_000 })
    if (bars.length) facts.probeBars = { lastClose: bars.at(-1).c, asOf: new Date(bars.at(-1).t).toISOString().slice(0, 10) }
  }
  const { claudePaused } = require('../lib/ai-pause')
  facts.ai = {
    claude: !!process.env.ANTHROPIC_API_KEY, groq: !!process.env.GROQ_API_KEY,
    paused: claudePaused(), pausedUntil: process.env.CLAUDE_PAUSE_UNTIL || null,
  }
  facts.keys = { fred: !!process.env.FRED_API_KEY, fmp: !!(process.env.FMP_API_KEY || req.headers['x-fmp-key']) }
  // A key that is set is not a key that works: FMP refuses retired endpoints
  // and plan-limited ones in the response body. One profile call proves it.
  if (facts.keys.fmp) {
    try {
      const prof = await require('../lib/fmp').profile('AAPL', { key: req.headers['x-fmp-key'] || process.env.FMP_API_KEY, timeoutMs: 8_000 })
      facts.fmpProbe = prof ? { ok: true } : { ok: false, error: 'no data returned for AAPL' }
    } catch (e) { facts.fmpProbe = { ok: false, error: e.message } }
  }
  facts.email = require('../lib/email').emailConfig()
  facts.appUrl = !!process.env.APP_URL
  facts.persistence = durableFiles.status()
  try { facts.symbolIndex = require('../lib/symbol-db').stats() } catch { facts.symbolIndex = { loaded: false } }
  try {
    const last = require('../lib/ai-job-queue').getLatestResult(req.user.userId, 'scan')
    if (last) {
      facts.lastScanAt      = last.finishedAt || last.result?.processedAt || null
      facts.lastScanSymbols = last.result?.universeAnalyzed?.length ?? null
      facts.lastScanDataAge = last.result?.dataAge ?? null
    }
  } catch { /* no scan yet */ }
  try {
    const all = require('../lib/scheduler').getStatus()
    facts.jobs = STATUS_JOBS.map(id => all.find(j => j.id === id)).filter(Boolean)
  } catch { facts.jobs = [] }
  try { facts.record = recordFacts(readPredictions()) } catch { facts.record = {} }
  try { facts.learningHealth = getLearningHealth() } catch { facts.learningHealth = null }
  // Fallbacks that would otherwise show only in the server log: a provider
  // refusing an output schema, or the API refusing code mode.
  try {
    facts.aiFallbacks = {
      refusedSchemas: require('../lib/ai-router').refusedSchemas(),
      codeMode: require('../lib/code-mode').codeModeStatus(),
      codeModeSwitchedOff: String(process.env.COPILOT_CODE_MODE || 'on').toLowerCase() === 'off',
    }
  } catch { facts.aiFallbacks = null }
  facts.paper = paperFacts()
  res.json(evaluateStatus(facts))
})

router.get('/:symbol/evidence', requireAuth, evidenceLimit, async (req, res) => {
  const sym = cleanSymbol(req.params.symbol)
  if (!sym) return res.status(400).json({ error: 'Invalid symbol' })
  try {
    const ev = await gatherEvidence(sym, req)
    res.json({ symbol: sym, company: ev.company, assetType: ev.assetType, lastPrice: ev.facts.last, asOf: ev.facts.date, evidence: ev.items, gaps: ev.gaps, winProb: ev.winProb, referenceLevels: ev.referenceLevels })
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

router.post('/:symbol/thesis', requireAuth, thesisLimit, async (req, res) => {
  // Bars + fundamentals + one LLM call: long enough for a mobile connection to
  // idle out. After the first heartbeat the status is pinned to 200, so
  // failures arrive as 200 + `error` in the body.
  startJsonHeartbeat(res)
  const sym = cleanSymbol(req.params.symbol)
  if (!sym) return res.status(400).json({ error: 'Invalid symbol' })

  let ev
  try { ev = await gatherEvidence(sym, req) }
  catch (e) { return res.status(e.status || 500).json({ error: e.message }) }

  // 'debate': separate bull → bear (sees the bull) → decision calls; 'single':
  // one call writes both sides. Same judge either way; the method is recorded
  // so which one produces better outcomes is measured, not assumed.
  const method = req.body?.method === 'debate' ? 'debate' : 'single'
  let thesis = null, llmUsed = null
  try {
    if (method === 'debate') {
      const ask = async (prompt, schema, schemaName, maxTokens = 1800) => {
        const out = await aiRouter.call({ prompt, maxTokens, symbols: [sym], schema, schemaName })
        llmUsed = out.llmUsed
        return tryParseAiJson(out.text)
      }
      const bull = await ask(desk.buildBullPrompt({ symbol: sym, items: ev.items, gaps: ev.gaps }), BULL_SCHEMA, 'research-bull')
      const bear = await ask(desk.buildBearPrompt({ symbol: sym, items: ev.items, gaps: ev.gaps, bull: bull?.bull }), BEAR_SCHEMA, 'research-bear')
      const decision = await ask(desk.buildDecisionPrompt({ symbol: sym, bull: bull?.bull, bear: bear?.bear, targetReturn: bull?.targetReturn, stopLoss: bull?.stopLoss, horizonDays: bull?.horizonDays }), DECISION_SCHEMA, 'research-decision', 600)
      if (bull && bear && decision) thesis = desk.assembleDebate(bull, bear, decision)
    } else {
      const out = await aiRouter.call({ prompt: desk.buildThesisPrompt({ symbol: sym, items: ev.items, gaps: ev.gaps }), maxTokens: 2500, symbols: [sym], schema: THESIS_SCHEMA, schemaName: 'research-thesis' })
      llmUsed = out.llmUsed
      thesis = desk.parseThesis(out.text)
    }
  } catch (err) {
    if (err instanceof CircuitOpenError) return res.status(503).json({ error: err.message, circuitOpen: true })
    return res.status(err.status === 503 ? 503 : 502).json({ error: `AI unavailable: ${err.message}` })
  }

  if (!thesis) return res.status(502).json({ error: 'The AI returned no usable thesis — please try again' })

  const judgement = desk.judgeThesis({ thesis, items: ev.items, lastPrice: ev.facts.last, assetType: ev.assetType, winProb: ev.winProb, levels: ev.levels })
  const entry = {
    id: crypto.randomBytes(5).toString('hex'),
    userId: req.user.userId,
    symbol: sym, company: ev.company, assetType: ev.assetType,
    at: new Date().toISOString(),
    lastPrice: ev.facts.last, asOf: ev.facts.date,
    evidence: ev.items, gaps: ev.gaps,
    thesis, judgement, llmUsed, method,
  }
  try { appendThesis(entry) } catch (e) { console.warn('[research-desk] journal write failed:', e.message) }

  // Only an actionable long is a directional claim to score; a decline is not
  // a short, and recording it would score a trade nobody was told to take.
  if (judgement.verdict === 'actionable') {
    try {
      learningStore.recordDecision({
        surface: 'research', symbol: sym, action: 'buy', price: ev.facts.last,
        meta: { assetType: ev.assetType, targetReturn: judgement.zones.targetReturn, stopLoss: judgement.zones.stopLoss, horizonDays: judgement.horizonDays, thesisId: entry.id, method },
      })
    } catch (e) { console.warn('[research-desk] learning-store write failed:', e.message) }
  }

  const { userId, ...publicEntry } = entry
  res.json(publicEntry)
})

module.exports = router
module.exports._internals = { readTheses, appendThesis, assetTypeOf, cleanSymbol, THESES_FILE }
