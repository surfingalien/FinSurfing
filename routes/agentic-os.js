'use strict'
/**
 * routes/agentic-os.js
 *
 * Graphify-style knowledge graph of the FinSurfing codebase, served as JSON.
 *
 * GET /api/agentic-os/graph     — full node+edge graph (auto-scanned from require() calls)
 * GET /api/agentic-os/stats     — live system stats + scheduler jobs
 * GET /api/agentic-os/node/:id  — single node detail with neighbours
 * GET /api/agentic-os/skills    — FinSurfing AI capabilities
 * GET /api/agentic-os/mcps      — MCP-style provider list with live env-var status
 * GET /api/agentic-os/refresh   — bust graph cache
 */

const express = require('express')
const fs      = require('fs')
const path    = require('path')
const router  = express.Router()

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

router.get('/skills', (_req, res) => {
  res.json({
    skills: [
      { id: 'market-scan',      name: 'Market Scanner',      description: 'AI Brain 5-agent scan across 30+ universes',      endpoint: '/api/ai-brain/analyze',          status: 'active', triggerCount: null, tags: ['ai','scan','multi-agent'] },
      { id: 'symbol-analysis',  name: 'Symbol Analyzer',     description: 'Deep technical + AI signal for any ticker',       endpoint: '/api/trading-analysis/analyze',  status: 'active', triggerCount: null, tags: ['ai','technical','signals'] },
      { id: 'recommendations',  name: 'Advisory Engine',     description: '10 investor personas × buy signals',              endpoint: '/api/recommendations',           status: 'active', triggerCount: null, tags: ['ai','personas','advisory'] },
      { id: 'social-sentiment', name: 'Social Sentiment',    description: 'Real-time Reddit/WSB sentiment (free API)',       endpoint: '/api/market-intel',              status: 'active', triggerCount: null, tags: ['alt-data','reddit','wsb'] },
      { id: 'macro-pulse',      name: 'Macro Pulse',         description: '14 FRED series + regime assessment + AI summary', endpoint: '/api/macro/summary',             status: 'active', triggerCount: null, tags: ['macro','fred','rates'] },
      { id: 'alt-data',         name: 'Alt Data',            description: 'SEC Form 4 insider + FINRA short interest',       endpoint: '/api/market-intel',              status: 'active', triggerCount: null, tags: ['sec','finra','insider'] },
      { id: 'copilot',          name: 'MarketPulse Copilot', description: 'Agentic SSE chat (Claude + Groq + Codex)',        endpoint: '/api/copilot/chat',              status: 'active', triggerCount: null, tags: ['ai','sse','agentic'] },
      { id: 'agent-research',   name: 'Agent Research',      description: '5-agent parallel research orchestrator',          endpoint: '/api/agents/research',           status: 'active', triggerCount: null, tags: ['ai','agents','parallel'] },
      { id: 'backtest',         name: 'Backtest Engine',     description: '4 strategies × 3 ranges, sequential queue',      endpoint: '/api/backtest',                  status: 'active', triggerCount: null, tags: ['backtest','queue','jsonl'] },
      { id: 'alert-trigger',    name: 'Alert → AI Trigger',  description: 'Price alert fires → analyze_symbol auto-runs',   endpoint: '/api/alerts/trigger',            status: 'active', triggerCount: null, tags: ['alerts','sse','trigger'] },
      { id: 'timeline',         name: 'Trade Timeline',      description: 'JSONL prediction log + signal change detection',  endpoint: '/api/timeline',                  status: 'active', triggerCount: null, tags: ['timeline','jsonl','signals'] },
      { id: 'scheduler',        name: 'Job Scheduler',       description: '7 cron jobs: scans, digest, alt-data refresh',   endpoint: '/api/scheduler/jobs',            status: 'active', triggerCount: null, tags: ['scheduler','cron','jobs'] },
    ]
  })
})

router.get('/mcps', (_req, res) => {
  const E = process.env
  res.json({
    servers: [
      { id: 'anthropic-claude', name: 'Claude claude-sonnet-4-6',  status: E.ANTHROPIC_API_KEY ? 'connected' : 'disconnected', transport: 'HTTP/SSE', tool: 'claude-sonnet-4-6',  purpose: 'Primary AI reasoning + tool use',         toolCount: 8 },
      { id: 'groq-llama',       name: 'Groq LLaMA 3.3 70B', status: E.GROQ_API_KEY     ? 'connected' : 'idle',         transport: 'HTTP',     tool: 'llama-3.3-70b',       purpose: 'Fallback fast inference',                 toolCount: 3 },
      { id: 'finnhub',          name: 'Finnhub Market Data', status: E.FINNHUB_API_KEY  ? 'connected' : 'idle',         transport: 'HTTP',     tool: 'quote/chart/search',  purpose: 'Real-time US equity data',                toolCount: 5 },
      { id: 'fmp',              name: 'FMP Financial Data',  status: E.FMP_API_KEY      ? 'connected' : 'idle',         transport: 'HTTP',     tool: 'analyst/earnings',    purpose: 'Fundamentals + analyst ratings',          toolCount: 4 },
      { id: 'fred',             name: 'FRED Macro Data',     status: E.FRED_API_KEY     ? 'connected' : 'idle',         transport: 'HTTP',     tool: '14 macro series',     purpose: 'Rates, inflation, VIX, GDP',              toolCount: 14 },
      { id: 'sec-edgar',        name: 'SEC EDGAR',           status: 'connected',                                        transport: 'HTTP',     tool: 'Form 4/EFTS',         purpose: 'Insider transactions (free)',              toolCount: 2 },
      { id: 'finra',            name: 'FINRA Short Interest',status: 'connected',                                        transport: 'HTTP',     tool: 'weeklySummary',       purpose: 'Short interest ratio (free)',              toolCount: 1 },
      { id: 'reddit',           name: 'Reddit Social',       status: 'connected',                                        transport: 'HTTP',     tool: 'r/wsb r/stocks',      purpose: 'Social sentiment (free JSON)',             toolCount: 2 },
      { id: 'binance',          name: 'Binance WebSocket',   status: 'connected',                                        transport: 'WSS',      tool: 'crypto ticks',        purpose: 'Real-time crypto prices',                 toolCount: 1 },
      { id: 'postgres',         name: 'PostgreSQL',          status: E.DATABASE_URL     ? 'connected' : 'idle',         transport: 'TCP',      tool: 'portfolio/auth DB',   purpose: 'Portfolio + auth persistence',             toolCount: 6 },
    ]
  })
})

module.exports = router
