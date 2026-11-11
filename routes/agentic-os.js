'use strict'
/**
 * routes/agentic-os.js
 *
 * Graphify-style knowledge graph of the FinSurfing codebase, served as JSON.
 *
 * GET /api/agentic-os/overview   — the page: verdict, what needs attention, the agents,
 *                                   spend, connections, activity (lib/agentic-overview.js)
 * GET /api/agentic-os/data-flow  — how data moves from provider to screen
 * GET /api/agentic-os/graph      — code graph (auto-scanned from require() calls)
 * GET /api/agentic-os/stats      — code-graph + scheduler counts
 * GET /api/agentic-os/node/:id   — single node detail with neighbours
 * GET /api/agentic-os/refresh    — bust graph cache
 *
 * (/skills and /mcps were removed: hand-written lists that claimed sources were
 * "connected" regardless of whether they were, and named a retired Groq model.)
 */

const express = require('express')
const fs      = require('fs')
const path    = require('path')
const router  = express.Router()
const { requireAuth } = require('../middleware/auth')
// Sign-in only: the scan cache, scheduler state and system map are not for
// anonymous visitors.
router.use(requireAuth)

const ROOT = path.join(__dirname, '..')

// ── helpers ───────────────────────────────────────────────────────────────────

function safeReadFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf8') } catch { return '' }
}

function countLines(src) {
  return src ? src.split('\n').length : 0
}

function extractJsDoc(src) {
  const m = src.match(/\/\*\*([\s\S]*?)\*\//)
  if (!m) return ''
  return m[1].replace(/\* ?/g, '').trim().split('\n')[0].trim()
}

function extractRequires(src) {
  const re = /require\s*\(\s*['"](?:\.\.\/|\.\/)((?:lib|routes)\/[\w-]+)['"]\s*\)/g
  const deps = new Set()
  let m
  while ((m = re.exec(src)) !== null) {
    deps.add(m[1].replace(/^(lib|routes)\//, '$1:'))
  }
  return [...deps]
}

// ── Graph builder ─────────────────────────────────────────────────────────────

function buildGraph() {
  const nodes   = []
  const edges   = []
  const seen    = new Set()
  const depMap  = {}

  function addNode(id, label, type, meta = {}) {
    if (seen.has(id)) return
    seen.add(id)
    nodes.push({ id, label, type, ...meta })
  }

  function addEdge(source, target, label = 'uses') {
    if (!seen.has(source) || !seen.has(target)) return
    if (!edges.find(e => e.source === source && e.target === target)) {
      edges.push({ source, target, label })
    }
  }

  let routeFiles = []
  try { routeFiles = fs.readdirSync(path.join(ROOT, 'routes')).filter(f => f.endsWith('.js')) } catch {}

  for (const f of routeFiles) {
    const id       = `route:${f.replace('.js', '')}`
    const label    = f.replace('.js', '').replace(/-/g, ' ')
    const src      = safeReadFile(path.join(ROOT, 'routes', f))
    const desc     = extractJsDoc(src)
    const lines    = countLines(src)
    const deps     = extractRequires(src)
    addNode(id, label, 'route', { file: `routes/${f}`, description: desc, lineCount: lines, group: 'routes' })
    depMap[id] = deps
  }

  let libFiles = []
  try { libFiles = fs.readdirSync(path.join(ROOT, 'lib')).filter(f => f.endsWith('.js')) } catch {}

  for (const f of libFiles) {
    const id    = `lib:${f.replace('.js', '')}`
    const label = f.replace('.js', '').replace(/-/g, ' ')
    const src   = safeReadFile(path.join(ROOT, 'lib', f))
    const desc  = extractJsDoc(src)
    const lines = countLines(src)
    const deps  = extractRequires(src)
    addNode(id, label, 'lib', { file: `lib/${f}`, description: desc, lineCount: lines, group: 'lib' })
    depMap[id] = deps
  }

  let compDirs = []
  try { compDirs = fs.readdirSync(path.join(ROOT, 'src/components')) } catch {}

  for (const dir of compDirs) {
    const id = `component:${dir}`
    addNode(id, dir, 'component', { group: 'frontend' })
    try {
      const files = fs.readdirSync(path.join(ROOT, 'src/components', dir)).filter(f => f.endsWith('.jsx'))
      for (const f of files) {
        const fid  = `jsx:${dir}/${f.replace('.jsx', '')}`
        const src  = safeReadFile(path.join(ROOT, 'src/components', dir, f))
        addNode(fid, f.replace('.jsx', ''), 'jsx', {
          file: `src/components/${dir}/${f}`,
          lineCount: countLines(src),
          group: 'frontend',
        })
        addEdge(id, fid, 'contains')
      }
    } catch {}
  }

  for (const [sourceId, deps] of Object.entries(depMap)) {
    for (const dep of deps) {
      addEdge(sourceId, dep, 'imports')
    }
  }

  const COMP_ROUTE = [
    ['component:Copilot',         'route:copilot',          'calls'],
    ['component:AIBrain',         'route:ai-brain',         'calls'],
    ['component:AgentHub',        'route:agents',           'calls'],
    ['component:AgentHub',        'route:scheduler',        'calls'],
    ['component:Backtest',        'route:backtest',         'calls'],
    ['component:Backtest',        'route:backtest-queue',   'calls'],
    ['component:Timeline',        'route:timeline',         'calls'],
    ['component:Recommendations', 'route:recommendations',  'calls'],
    ['component:Portfolio',       'route:portfolios',       'calls'],
    ['component:Dashboard',       'route:macro',            'calls'],
    ['component:AgenticOS',       'route:agentic-os',       'calls'],
    ['component:Alerts',          'route:alerts',           'calls'],
    ['component:Analysis',        'route:trading-analysis', 'calls'],
    ['component:Watchlist',       'route:market',           'calls'],
  ]
  for (const [s, t, l] of COMP_ROUTE) addEdge(s, t, l)

  return { nodes, edges, generatedAt: new Date().toISOString() }
}

let _cache   = null
let _cacheAt = 0

function getGraph() {
  if (_cache && Date.now() - _cacheAt < 5 * 60_000) return _cache
  _cache   = buildGraph()
  _cacheAt = Date.now()
  return _cache
}

router.get('/graph', (_req, res) => {
  try {
    res.json(getGraph())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/refresh', (_req, res) => {
  try {
    _cache = null; _cacheAt = 0
    res.json({ ok: true, graph: getGraph() })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/stats', (_req, res) => {
  try {
    const graph = getGraph()
    const byType = {}
    for (const n of graph.nodes) byType[n.type] = (byType[n.type] || 0) + 1

    let jobs = []
    try { jobs = require('../lib/scheduler').getStatus() } catch {}

    const totalLines = graph.nodes.reduce((sum, n) => sum + (n.lineCount || 0), 0)

    res.json({
      nodes:         graph.nodes.length,
      edges:         graph.edges.length,
      byType,
      routes:        byType.route     || 0,
      libs:          byType.lib       || 0,
      components:    byType.component || 0,
      jsxFiles:      byType.jsx       || 0,
      totalLines,
      scheduledJobs: jobs.length,
      runningJobs:   jobs.filter(j => j.result?.status === 'running').length,
      jobs,
      generatedAt:   graph.generatedAt,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/node/:id', (req, res) => {
  try {
    const graph = getGraph()
    const id    = decodeURIComponent(req.params.id)
    const node  = graph.nodes.find(n => n.id === id)
    if (!node) return res.status(404).json({ error: 'Node not found', id })

    const neighbours = graph.edges
      .filter(e => e.source === id || e.target === id)
      .map(e => {
        const otherId = e.source === id ? e.target : e.source
        const other   = graph.nodes.find(n => n.id === otherId)
        return {
          id:        otherId,
          label:     other?.label || otherId,
          type:      other?.type,
          relation:  e.label,
          direction: e.source === id ? 'out' : 'in',
        }
      })

    res.json({ node, neighbours })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Overview ──────────────────────────────────────────────────────────────────
// The same for every signed-in user (nothing here is per-user), so one short
// shared cache keeps a few open tabs from recomputing the Agent Desk ledger.
let _overview = null
let _overviewAt = 0
const OVERVIEW_TTL_MS = 5_000
const OVERVIEW_FRESH_MS = 1_000   // ?fresh=1 (after an action, or the Refresh button) — still rate-limited to 1/s

/** One failing source must never take the page down: it is reported as unavailable. */
function tryOr(fn, fallback = null) { try { return fn() } catch (e) { console.warn('[agentic-os] source failed:', e.message); return fallback } }

function gatherOverview() {
  const E = process.env
  const scheduler = tryOr(() => require('../lib/scheduler').getStatus(), [])
  const desk = tryOr(() => {
    const d = require('../lib/agent-desk')
    const pb = require('../lib/paper-broker')
    const opsAlerts = require('../lib/ops-alerts')
    const st = d.status()
    const live = tryOr(() => opsAlerts.collectAlerts({ paper: pb.snapshot(), trades: pb.loadTrades(), desk: st }), [])
    const feed = tryOr(() => opsAlerts.currentAlerts().filter(a => a.key === 'data-feed'), [])
    return { ...st, alerts: [...feed, ...live] }
  })
  const deskLog = tryOr(() => require('../lib/agent-desk').readLog().slice(-80), [])
  const brain = tryOr(() => require('../lib/strategy-brain').status())
  const audit = tryOr(() => require('../lib/ai-audit').getStats())
  const breakers = tryOr(() => require('../lib/circuit-breaker').getAllStatuses(), [])
  const persistence = tryOr(() => {
    const s = require('../lib/durable-files').status()
    return { enabled: !!s.enabled, reason: s.reason, production: E.NODE_ENV === 'production' }
  })
  const { claudePaused } = require('../lib/ai-pause')
  return require('../lib/agentic-overview').buildOverview({
    jobs: scheduler, desk, deskLog, brain, audit, breakers, persistence,
    killSwitches: { aiBrain: E.AI_BRAIN_DISABLED === 'true', recommendations: E.AI_RECOMMENDATIONS_DISABLED === 'true' },
    ai: { claude: !!E.ANTHROPIC_API_KEY, groq: !!E.GROQ_API_KEY, paused: tryOr(() => claudePaused(), false), pausedUntil: E.CLAUDE_PAUSE_UNTIL || null },
    // Booleans only — a key never leaves the process.
    env: {
      anthropic: !!E.ANTHROPIC_API_KEY, groq: !!E.GROQ_API_KEY, finnhub: !!(E.FINNHUB_API_KEY || E.FINNHUB_API_KEYS), fmp: !!E.FMP_API_KEY,
      alphavantage: !!E.ALPHA_VANTAGE_API_KEY || !!E.AV_API_KEY, twelvedata: !!(E.TWELVE_DATA_API_KEY || E.TD_API_KEY), tiingo: !!E.TIINGO_API_KEY, polygon: !!(E.POLYGON_API_KEY || E.MASSIVE_API_KEY),
      fred: !!E.FRED_API_KEY, database: !!E.DATABASE_URL, resend: !!(E.RESEND_API_KEY || E.SMTP_HOST), firecrawl: !!E.FIRECRAWL_API_KEY,
    },
  })
}

router.get('/overview', (req, res) => {
  try {
    const ttl = req.query.fresh === '1' ? OVERVIEW_FRESH_MS : OVERVIEW_TTL_MS
    if (!_overview || Date.now() - _overviewAt > ttl) { _overview = gatherOverview(); _overviewAt = Date.now() }
    res.json(_overview)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Data-flow graph: how market data moves from source to display ─────────────
// Each node has a tier (0=external, 1=server, 2=cache, 3=frontend) and status.
// Edges carry a `dataType` label describing what moves across the connection.
router.get('/data-flow', (req, res) => {
  const E = process.env

  // What is CONFIGURED, not what is proven to work: 'set' (key present), 'missing' (no key),
  // 'keyless' (needs none). A hard-wired "connected" here used to claim Reddit worked while
  // its API answers cloud servers with 403.
  const has = (...names) => ({ status: names.some(n => E[n]) ? 'set' : 'missing' })
  const keyless = { status: 'keyless' }
  const connected = id => ({
    finnhub: has('FINNHUB_API_KEY', 'FINNHUB_API_KEYS'), fmp: has('FMP_API_KEY'), aisa: has('AISA_API_KEY'),
    av: has('ALPHA_VANTAGE_API_KEY', 'AV_API_KEY'), twelvedata: has('TWELVE_DATA_API_KEY', 'TD_API_KEY'),
    tiingo: has('TIINGO_API_KEY'), polygon: has('POLYGON_API_KEY', 'MASSIVE_API_KEY'),
    anthropic: has('ANTHROPIC_API_KEY'), groq: has('GROQ_API_KEY'), postgres: has('DATABASE_URL'),
    fred: E.FRED_API_KEY ? { status: 'set' } : keyless,
  }[id] || keyless)

  const nodes = [
    // Tier 0 — external data providers
    { id: 'finnhub',   label: 'Finnhub',       tier: 0, category: 'market',    transport: 'HTTP', ...connected('finnhub'),  dataTypes: ['price','chart','search'], priority: 1 },
    { id: 'fmp',       label: 'FMP',           tier: 0, category: 'market',    transport: 'HTTP', ...connected('fmp'),      dataTypes: ['fundamentals','earnings','analyst'], priority: 2 },
    { id: 'aisa',      label: 'AISA',          tier: 0, category: 'market',    transport: 'HTTP', ...connected('aisa'),     dataTypes: ['price'], priority: 3 },
    { id: 'av',        label: 'AlphaVantage',  tier: 0, category: 'market',    transport: 'HTTP', ...connected('av'),       dataTypes: ['price','chart'], priority: 4 },
    { id: 'twelvedata',label: 'TwelveData',    tier: 0, category: 'market',    transport: 'HTTP', ...connected('twelvedata'),           dataTypes: ['price','chart'], priority: 5 },
    { id: 'tiingo',    label: 'Tiingo',        tier: 0, category: 'market',    transport: 'HTTP', ...connected('tiingo'),           dataTypes: ['price','chart'], priority: 6 },
    { id: 'polygon',   label: 'Polygon',       tier: 0, category: 'market',    transport: 'HTTP', ...connected('polygon'),           dataTypes: ['price'], priority: 7 },
    { id: 'stooq',     label: 'Stooq',         tier: 0, category: 'market',    transport: 'HTTP', ...connected('stooq'),    dataTypes: ['price (delayed)'], priority: 8 },
    { id: 'binance',   label: 'Binance',       tier: 0, category: 'crypto',    transport: 'WSS',  ...connected('binance'),  dataTypes: ['crypto tick'], priority: 1 },
    { id: 'coingecko', label: 'CoinGecko',     tier: 0, category: 'crypto',    transport: 'HTTP', ...keyless,      dataTypes: ['crypto price','market cap'], priority: 2 },
    { id: 'anthropic', label: 'Anthropic',     tier: 0, category: 'ai',        transport: 'HTTP', ...connected('anthropic'),dataTypes: ['AI analysis','streaming chat'], priority: 1 },
    { id: 'groq',      label: 'Groq',          tier: 0, category: 'ai',        transport: 'HTTP', ...connected('groq'),     dataTypes: ['AI fallback','ensemble scan'], priority: 2 },
    { id: 'fred',      label: 'FRED',          tier: 0, category: 'macro',     transport: 'HTTP', ...connected('fred'),     dataTypes: ['14 macro series'], priority: 1 },
    { id: 'freesent',  label: 'Free sentiment', tier: 0, category: 'alt',      transport: 'HTTP', ...keyless, dataTypes: ['StockTwits bull/bear','ApeWisdom mentions','news stories'], priority: 1 },
    { id: 'sec',       label: 'SEC EDGAR',     tier: 0, category: 'alt',       transport: 'HTTP', ...connected('sec'),      dataTypes: ['Form 4 insider'], priority: 2 },
    { id: 'finra',     label: 'FINRA',         tier: 0, category: 'alt',       transport: 'HTTP', ...connected('finra'),    dataTypes: ['short interest'], priority: 3 },
    { id: 'postgres',  label: 'PostgreSQL',    tier: 0, category: 'db',        transport: 'TCP',  ...connected('postgres'), dataTypes: ['portfolio','auth','watchlist'], priority: 1 },

    // Tier 1 — Express API routes
    { id: 'rt:market',   label: '/api/market',           tier: 1, category: 'route', description: 'Quote / search / chart — 9-provider waterfall fallback' },
    { id: 'rt:ai-brain', label: '/api/ai-brain',         tier: 1, category: 'route', description: '5-agent scan + ensemble + calibration injection' },
    { id: 'rt:analysis', label: '/api/trading-analysis', tier: 1, category: 'route', description: 'Per-symbol deep analysis with AI + TA' },
    { id: 'rt:rec',      label: '/api/recommendations',  tier: 1, category: 'route', description: '10 investor personas × AI advisory' },
    { id: 'rt:macro',    label: '/api/macro',            tier: 1, category: 'route', description: 'FRED 14-series + regime assessment + AI summary' },
    { id: 'rt:portfolio',label: '/api/portfolios',       tier: 1, category: 'route', description: 'CRUD holdings → Postgres / in-memory fallback' },
    { id: 'rt:copilot',  label: '/api/copilot',          tier: 1, category: 'route', description: 'Agentic streaming chat with 10 registered tools' },
    { id: 'rt:alt',      label: '/lib/alt-data',         tier: 1, category: 'route', description: 'SEC Form 4 + FINRA short interest aggregator' },
    { id: 'rt:sentiment',label: '/lib/social-sentiment', tier: 1, category: 'route', description: 'Free sentiment lanes — StockTwits, ApeWisdom, Google News (counts only reach the model)' },
    { id: 'rt:ta',       label: '/lib/technical-ind.',   tier: 1, category: 'route', description: 'RSI/MACD/BB/OBV/RS rank — pure TA math' },

    // Tier 2 — cache / persistence layers
    { id: 'cache:quotes',   label: 'Last-Known Quotes',  tier: 2, category: 'cache', description: 'Disk-persisted fallback; served stale=true when providers fail' },
    { id: 'cache:options',  label: 'Options Flow Cache', tier: 2, category: 'cache', description: '15-min P/C ratio + unusual activity cache' },
    { id: 'cache:macro',    label: 'Macro Cache',        tier: 2, category: 'cache', description: '1h FRED cache; regime + AI summary cached together' },
    { id: 'cache:pnl',      label: 'P&L Module',         tier: 2, category: 'cache', description: 'enrichPosition + portfolioSummary — shared browser+server' },
    { id: 'cache:learnings',label: 'Brain Learnings',    tier: 2, category: 'cache', description: 'Nightly calibration stats; injected into AI Brain system prompt' },
    { id: 'cache:symbols',  label: 'Symbol DB',          tier: 2, category: 'cache', description: 'FinanceDatabase weekly snapshot → symbol-db.json' },

    // Tier 3 — frontend components
    { id: 'ui:portfolio',   label: 'Portfolio',      tier: 3, category: 'ui' },
    { id: 'ui:aibrain',     label: 'AI Brain',       tier: 3, category: 'ui' },
    { id: 'ui:dashboard',   label: 'Dashboard',      tier: 3, category: 'ui' },
    { id: 'ui:analysis',    label: 'Analysis',       tier: 3, category: 'ui' },
    { id: 'ui:watchlist',   label: 'Watchlist',      tier: 3, category: 'ui' },
    { id: 'ui:copilot',     label: 'Copilot',        tier: 3, category: 'ui' },
    { id: 'ui:timeline',    label: 'Timeline',       tier: 3, category: 'ui' },
    { id: 'ui:research',    label: 'Research',       tier: 3, category: 'ui' },
  ]

  const edges = [
    // Market data waterfall → /api/market
    { source: 'finnhub',    target: 'rt:market',   dataType: 'price/chart',        priority: 1 },
    { source: 'fmp',        target: 'rt:market',   dataType: 'fundamentals',       priority: 2 },
    { source: 'aisa',       target: 'rt:market',   dataType: 'price fallback',     priority: 3 },
    { source: 'av',         target: 'rt:market',   dataType: 'price fallback',     priority: 4 },
    { source: 'twelvedata', target: 'rt:market',   dataType: 'price fallback',     priority: 5 },
    { source: 'tiingo',     target: 'rt:market',   dataType: 'price fallback',     priority: 6 },
    { source: 'polygon',    target: 'rt:market',   dataType: 'price fallback',     priority: 7 },
    { source: 'stooq',      target: 'rt:market',   dataType: 'delayed CSV',        priority: 8 },
    { source: 'rt:market',  target: 'cache:quotes',dataType: 'last-known persist' },
    { source: 'cache:quotes',target: 'rt:market',  dataType: 'stale fallback' },
    // Crypto providers
    { source: 'binance',    target: 'rt:market',   dataType: 'WSS crypto tick' },
    { source: 'coingecko',  target: 'rt:market',   dataType: 'crypto fallback' },
    // AI pipelines
    { source: 'anthropic',  target: 'rt:ai-brain', dataType: 'scan analysis' },
    { source: 'groq',       target: 'rt:ai-brain', dataType: 'ensemble scan' },
    { source: 'anthropic',  target: 'rt:analysis', dataType: 'deep analysis' },
    { source: 'anthropic',  target: 'rt:rec',      dataType: 'persona advisory' },
    { source: 'groq',       target: 'rt:rec',      dataType: 'recommendation fallback' },
    { source: 'anthropic',  target: 'rt:copilot',  dataType: 'streaming chat' },
    { source: 'groq',       target: 'rt:copilot',  dataType: 'chat fallback' },
    // TA feeds AI brain
    { source: 'rt:ta',      target: 'rt:ai-brain', dataType: 'RSI/MACD/OBV/RSRank' },
    { source: 'rt:ta',      target: 'rt:analysis', dataType: 'computed technicals' },
    // Macro
    { source: 'fred',       target: 'rt:macro',    dataType: '14 FRED series' },
    { source: 'rt:macro',   target: 'cache:macro', dataType: '1h cache' },
    { source: 'cache:macro',target: 'rt:ai-brain', dataType: 'macro regime' },
    { source: 'cache:macro',target: 'rt:copilot',  dataType: 'macro context' },
    // Alt data
    { source: 'sec',        target: 'rt:alt',      dataType: 'Form 4 insider' },
    { source: 'finra',      target: 'rt:alt',      dataType: 'short interest' },
    { source: 'rt:alt',     target: 'rt:ai-brain', dataType: 'insider+short signal' },
    // Sentiment
    { source: 'freesent',   target: 'rt:sentiment',dataType: 'sentiment lanes' },
    { source: 'rt:sentiment',target: 'rt:ai-brain',dataType: 'social sentiment' },
    // Options
    { source: 'finnhub',    target: 'cache:options',dataType: 'P/C ratio' },
    { source: 'cache:options',target: 'rt:ai-brain',dataType: 'options flow' },
    // Brain learnings feedback
    { source: 'cache:learnings',target: 'rt:ai-brain',dataType: 'calibration injection' },
    // Portfolio / DB
    { source: 'postgres',   target: 'rt:portfolio',dataType: 'holdings CRUD' },
    { source: 'rt:portfolio',target: 'cache:pnl',  dataType: 'position data' },
    { source: 'cache:pnl',  target: 'ui:portfolio',dataType: 'enriched P&L' },
    // Symbol DB
    { source: 'cache:symbols',target: 'rt:ai-brain',dataType: 'scan universes' },
    // Route → UI flows
    { source: 'rt:market',   target: 'ui:watchlist',  dataType: 'quotes' },
    { source: 'rt:market',   target: 'ui:portfolio',  dataType: 'live prices' },
    { source: 'rt:market',   target: 'ui:dashboard',  dataType: 'market data' },
    { source: 'rt:ai-brain', target: 'ui:aibrain',    dataType: 'ranked picks' },
    { source: 'rt:analysis', target: 'ui:analysis',   dataType: 'AI signals' },
    { source: 'rt:analysis', target: 'ui:research',   dataType: 'AI signals' },
    { source: 'rt:macro',    target: 'ui:dashboard',  dataType: 'macro panel' },
    { source: 'rt:copilot',  target: 'ui:copilot',    dataType: 'SSE chat stream' },
    { source: 'rt:portfolio',target: 'ui:timeline',   dataType: 'prediction log' },
    { source: 'rt:rec',      target: 'ui:research',   dataType: 'advisory picks' },
  ]

  res.json({ nodes, edges, generatedAt: new Date().toISOString() })
})

// ── Entity graph: financial universe hierarchy ─────────────────────────────────
// Symbols → scan categories → asset classes for the "financial knowledge graph"
router.get('/entities', (_req, res) => {
  const universes = {
    stocks:     { label: 'US Stocks',    assetClass: 'equity',  color: '#6366f1', symbols: ['NVDA','MSFT','AAPL','AMZN','GOOGL','META','TSLA','JPM','LLY','CRWD','BRK-B','UNH','JNJ','XOM','V','AVGO','MA','PG','HD','ABBV'] },
    tech:       { label: 'Tech',         assetClass: 'equity',  color: '#818cf8', symbols: ['NVDA','MSFT','AAPL','GOOGL','META','AMD','AVGO','CRM','PLTR','CRWD','SNOW','ANET','ARM','INTC','QCOM'] },
    finance:    { label: 'Finance',      assetClass: 'equity',  color: '#818cf8', symbols: ['JPM','BAC','WFC','GS','MS','V','MA','BRK-B','SCHW','AXP','BLK','KKR'] },
    healthcare: { label: 'Healthcare',   assetClass: 'equity',  color: '#818cf8', symbols: ['LLY','UNH','JNJ','ABBV','MRK','PFE','AMGN','ISRG','VRTX','REGN'] },
    energy:     { label: 'Energy',       assetClass: 'equity',  color: '#818cf8', symbols: ['XOM','CVX','COP','SLB','EOG','HAL','VLO','PSX','MPC','OXY'] },
    etfs_broad: { label: 'Broad ETFs',   assetClass: 'etf',     color: '#f59e0b', symbols: ['SPY','QQQ','VTI','IWM','DIA','MDY','VUG','VTV','VO','VB'] },
    etfs_sector:{ label: 'Sector ETFs',  assetClass: 'etf',     color: '#fbbf24', symbols: ['XLK','XLE','XLF','XLV','XLI','XLY','XLP','XLU','XLB','XLRE','XLC'] },
    etfs_bond:  { label: 'Bond ETFs',    assetClass: 'etf',     color: '#fcd34d', symbols: ['TLT','AGG','BND','HYG','LQD','SHY','IEF','TIP'] },
    etfs_commodity:{ label: 'Commodity ETFs', assetClass: 'etf', color: '#fde68a', symbols: ['GLD','SLV','USO','DBA','IAU','GDX','GDXJ','COPX'] },
    crypto_l1:  { label: 'L1 Chains',    assetClass: 'crypto',  color: '#10b981', symbols: ['BTC-USD','ETH-USD','SOL-USD','BNB-USD','ADA-USD','AVAX-USD','DOT-USD','ATOM-USD','NEAR-USD','APT-USD'] },
    crypto_defi:{ label: 'DeFi',         assetClass: 'crypto',  color: '#34d399', symbols: ['UNI-USD','AAVE-USD','MKR-USD','COMP-USD','CRV-USD','LDO-USD','GMX-USD'] },
    crypto_ai:  { label: 'AI Tokens',    assetClass: 'crypto',  color: '#6ee7b7', symbols: ['FET-USD','OCEAN-USD','RNDR-USD','WLD-USD','GRT-USD','TAO-USD','ARKM-USD'] },
    crypto_l2:  { label: 'L2 Scaling',   assetClass: 'crypto',  color: '#a7f3d0', symbols: ['MATIC-USD','ARB-USD','OP-USD','IMX-USD','LRC-USD','MNT-USD'] },
  }

  const assetClasses = [
    { id: 'equity', label: 'Equities',        color: '#6366f1', symbolCount: 0 },
    { id: 'etf',    label: 'ETFs',            color: '#f59e0b', symbolCount: 0 },
    { id: 'crypto', label: 'Crypto',          color: '#10b981', symbolCount: 0 },
  ]

  const nodes = []
  const edges = []

  for (const ac of assetClasses) {
    nodes.push({ id: `ac:${ac.id}`, label: ac.label, tier: 0, color: ac.color, type: 'assetClass' })
  }

  const seenSymbols = new Set()
  for (const [key, u] of Object.entries(universes)) {
    nodes.push({ id: `u:${key}`, label: u.label, tier: 1, color: u.color, type: 'universe', assetClass: u.assetClass, symbolCount: u.symbols.length })
    edges.push({ source: `ac:${u.assetClass}`, target: `u:${key}`, label: 'contains' })

    // Add up to 8 symbols per universe (de-dup across universes)
    for (const sym of u.symbols.slice(0, 8)) {
      const symId = `sym:${sym}`
      if (!seenSymbols.has(sym)) {
        seenSymbols.add(sym)
        const isCrypto = sym.includes('-USD')
        const isEtf    = ['SPY','QQQ','VTI','IWM','DIA','MDY','VUG','VTV','VO','VB','XLK','XLE','XLF','XLV','XLI','XLY','XLP','XLU','XLB','XLRE','XLC','TLT','AGG','BND','HYG','LQD','SHY','IEF','TIP','GLD','SLV','USO','DBA','IAU','GDX','GDXJ','COPX'].includes(sym)
        nodes.push({ id: symId, label: sym, tier: 2, color: isCrypto ? '#10b981' : isEtf ? '#f59e0b' : '#6366f1', type: 'symbol', assetClass: u.assetClass })
      }
      edges.push({ source: `u:${key}`, target: symId, label: 'includes' })
    }
  }

  res.json({ nodes, edges, assetClasses, universeCount: Object.keys(universes).length, symbolCount: seenSymbols.size, generatedAt: new Date().toISOString() })
})

module.exports = router
