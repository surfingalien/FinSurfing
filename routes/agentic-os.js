'use strict'
/**
 * routes/agentic-os.js
 *
 * Graphify-style knowledge graph of the FinSurfing codebase, served as JSON.
 * Claude can query this instead of reading individual files.
 *
 * GET /api/agentic-os/graph     — full node+edge graph of the application
 * GET /api/agentic-os/stats     — live system stats (routes, libs, components, scheduled jobs)
 * GET /api/agentic-os/node/:id  — single node detail with neighbours
 * GET /api/agentic-os/skills    — list of FinSurfing AI capabilities (skills)
 * GET /api/agentic-os/mcps      — MCP-style tool list (internal APIs as tools)
 */

const express = require('express')
const fs      = require('fs')
const path    = require('path')
const router  = express.Router()

const ROOT = path.join(__dirname, '..')

// ── Graph builder — scans routes, lib, src/components ────────────────────────

function buildGraph() {
  const nodes = []
  const edges = []
  const seen  = new Set()

  function addNode(id, label, type, meta = {}) {
    if (seen.has(id)) return
    seen.add(id)
    nodes.push({ id, label, type, ...meta })
  }

  function addEdge(source, target, label = 'uses') {
    edges.push({ source, target, label })
  }

  // ── Routes ──
  const routeFiles = fs.readdirSync(path.join(ROOT, 'routes')).filter(f => f.endsWith('.js'))
  for (const f of routeFiles) {
    const id    = `route:${f.replace('.js', '')}`
    const label = f.replace('.js', '').replace(/-/g, ' ')
    let desc = ''
    try {
      const src = fs.readFileSync(path.join(ROOT, 'routes', f), 'utf8').slice(0, 600)
      const m   = src.match(/\/\*\*[\s\S]*?\*\//)
      if (m) desc = m[0].replace(/\/\*\*|\*\/|\* ?/g, '').trim().split('\n')[0].trim()
    } catch {}
    addNode(id, label, 'route', { file: `routes/${f}`, description: desc, group: 'routes' })
  }

  // ── Libs ──
  const libFiles = fs.readdirSync(path.join(ROOT, 'lib')).filter(f => f.endsWith('.js'))
  for (const f of libFiles) {
    const id    = `lib:${f.replace('.js', '')}`
    const label = f.replace('.js', '').replace(/-/g, ' ')
    addNode(id, label, 'lib', { file: `lib/${f}`, group: 'lib' })
  }

  // ── Components ──
  const compDirs = fs.readdirSync(path.join(ROOT, 'src/components'))
  for (const dir of compDirs) {
    const id = `component:${dir}`
    addNode(id, dir, 'component', { group: 'frontend' })
    // find JSX files inside
    try {
      const files = fs.readdirSync(path.join(ROOT, 'src/components', dir)).filter(f => f.endsWith('.jsx'))
      for (const f of files) {
        const fid = `jsx:${dir}/${f.replace('.jsx', '')}`
        addNode(fid, f.replace('.jsx', ''), 'jsx', { file: `src/components/${dir}/${f}`, group: 'frontend' })
        addEdge(id, fid, 'contains')
      }
    } catch {}
  }

  // ── Cross-edges: routes that require libs ──
  const ROUTE_LIB_EDGES = [
    ['route:copilot',       'lib:social-sentiment',  'imports'],
    ['route:copilot',       'lib:alt-data',          'imports'],
    ['route:ai-brain',      'lib:ai-router',         'imports'],
    ['route:ai-brain',      'lib:social-sentiment',  'imports'],
    ['route:ai-brain',      'lib:circuit-breaker',   'imports'],
    ['route:recommendations','lib:ai-router',        'imports'],
    ['route:recommendations','lib:investor-personas', 'imports'],
    ['route:trading-analysis','lib:ai-router',       'imports'],
    ['route:scheduler',     'lib:scheduler',         'imports'],
    ['route:agents',        'lib:ai-router',         'imports'],
    ['route:alerts',        'lib:alert-broadcaster', 'imports'],
    ['route:alerts',        'lib:scheduled-jobs',    'imports'],
    ['route:backtest-queue','lib:backtest-queue',     'imports'],
    ['route:market-intel',  'lib:alt-data',          'imports'],
    ['route:macro',         'lib:scheduler',         'uses'],
    ['lib:scheduled-jobs',  'lib:scheduler',         'imports'],
    ['lib:scheduled-jobs',  'lib:alt-data',          'imports'],
    ['lib:scheduled-jobs',  'lib:email',             'imports'],
    ['lib:backtest-queue',  'route:backtest',        'calls'],
    ['lib:alert-broadcaster','lib:scheduled-jobs',   'used-by'],
  ]
  for (const [s, t, l] of ROUTE_LIB_EDGES) {
    if (seen.has(s) && seen.has(t)) addEdge(s, t, l)
  }

  // ── Component → route edges ──
  const COMP_ROUTE_EDGES = [
    ['component:Copilot',    'route:copilot',          'calls'],
    ['component:AIBrain',    'route:ai-brain',         'calls'],
    ['component:AgentHub',   'route:agents',           'calls'],
    ['component:AgentHub',   'route:scheduler',        'calls'],
    ['component:Backtest',   'route:backtest',         'calls'],
    ['component:Backtest',   'route:backtest-queue',   'calls'],
    ['component:Timeline',   'route:timeline',         'calls'],
    ['component:Recommendations','route:recommendations','calls'],
    ['component:Portfolio',  'route:portfolios',       'calls'],
    ['component:Dashboard',  'route:macro',            'calls'],
  ]
  for (const [s, t, l] of COMP_ROUTE_EDGES) {
    if (seen.has(s) && seen.has(t)) addEdge(s, t, l)
  }

  return { nodes, edges, generatedAt: new Date().toISOString() }
}

// Cache graph for 5 minutes
let _graphCache = null
let _graphCacheAt = 0

function getGraph() {
  if (_graphCache && Date.now() - _graphCacheAt < 5 * 60_000) return _graphCache
  _graphCache   = buildGraph()
  _graphCacheAt = Date.now()
  return _graphCache
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/graph', (req, res) => {
  res.json(getGraph())
})

router.get('/stats', (req, res) => {
  const graph = getGraph()
  const byType = {}
  for (const n of graph.nodes) byType[n.type] = (byType[n.type] || 0) + 1

  // Scheduled jobs
  let jobs = []
  try { jobs = require('../lib/scheduler').getStatus() } catch {}

  res.json({
    nodes:       graph.nodes.length,
    edges:       graph.edges.length,
    byType,
    routes:      byType.route   || 0,
    libs:        byType.lib     || 0,
    components:  byType.component || 0,
    jsxFiles:    byType.jsx     || 0,
    scheduledJobs: jobs.length,
    runningJobs:   jobs.filter(j => j.result?.status === 'running').length,
    generatedAt: graph.generatedAt,
  })
})

router.get('/node/:id', (req, res) => {
  const graph = getGraph()
  const id    = req.params.id
  const node  = graph.nodes.find(n => n.id === id)
  if (!node) return res.status(404).json({ error: 'Node not found' })

  const neighbours = graph.edges
    .filter(e => e.source === id || e.target === id)
    .map(e => {
      const otherId = e.source === id ? e.target : e.source
      const other   = graph.nodes.find(n => n.id === otherId)
      return { id: otherId, label: other?.label || otherId, type: other?.type, relation: e.label, direction: e.source === id ? 'out' : 'in' }
    })

  res.json({ node, neighbours })
})

router.get('/skills', (req, res) => {
  res.json({
    skills: [
      { id: 'market-scan',        name: 'Market Scanner',       description: 'AI Brain 5-agent scan across 30+ universes',    endpoint: '/api/ai-brain/analyze',          status: 'active', triggerCount: null },
      { id: 'symbol-analysis',    name: 'Symbol Analyzer',      description: 'Deep technical + AI signal for any ticker',     endpoint: '/api/trading-analysis/analyze',  status: 'active', triggerCount: null },
      { id: 'recommendations',    name: 'Advisory Engine',      description: '10 investor personas × buy signals',            endpoint: '/api/recommendations',           status: 'active', triggerCount: null },
      { id: 'social-sentiment',   name: 'Social Sentiment',     description: 'Real-time Reddit/WSB sentiment (free API)',     endpoint: 'lib/social-sentiment',           status: 'active', triggerCount: null },
      { id: 'macro-pulse',        name: 'Macro Pulse',          description: '14 FRED series + regime assessment',            endpoint: '/api/macro/summary',             status: 'active', triggerCount: null },
      { id: 'alt-data',           name: 'Alt Data',             description: 'SEC Form 4 insider + FINRA short interest',     endpoint: '/api/market-intel',              status: 'active', triggerCount: null },
      { id: 'copilot',            name: 'MarketPulse Copilot',  description: 'Agentic SSE chat (Claude + Groq + Codex)',      endpoint: '/api/copilot/chat',              status: 'active', triggerCount: null },
      { id: 'agent-research',     name: 'Agent Research',       description: '5-agent parallel research orchestrator',        endpoint: '/api/agents/research',           status: 'active', triggerCount: null },
      { id: 'backtest',           name: 'Backtest Engine',      description: '4 strategies × 3 ranges, sequential queue',    endpoint: '/api/backtest',                  status: 'active', triggerCount: null },
      { id: 'alert-trigger',      name: 'Alert → AI Trigger',  description: 'Price alert fires → analyze_symbol auto-runs', endpoint: '/api/alerts/trigger',            status: 'active', triggerCount: null },
      { id: 'timeline',           name: 'Trade Timeline',       description: 'JSONL prediction log + signal change detection',endpoint: '/api/timeline',                  status: 'active', triggerCount: null },
      { id: 'scheduler',          name: 'Job Scheduler',        description: '7 cron jobs: scans, digest, alt-data refresh', endpoint: '/api/scheduler/jobs',            status: 'active', triggerCount: null },
    ]
  })
})

router.get('/mcps', (req, res) => {
  res.json({
    servers: [
      { id: 'anthropic-claude',  name: 'Claude claude-sonnet-4-6',      status: process.env.ANTHROPIC_API_KEY ? 'connected' : 'disconnected', tool: 'claude-sonnet-4-6',  purpose: 'Primary AI reasoning + tool use' },
      { id: 'groq-llama',        name: 'Groq LLaMA 3.3 70B',    status: process.env.GROQ_API_KEY     ? 'connected' : 'idle',         tool: 'llama-3.3-70b',       purpose: 'Fallback fast inference' },
      { id: 'finnhub',           name: 'Finnhub Market Data',   status: process.env.FINNHUB_API_KEY  ? 'connected' : 'idle',         tool: 'quote/chart/search',  purpose: 'Real-time US equity data' },
      { id: 'fmp',               name: 'FMP Financial Data',    status: process.env.FMP_API_KEY      ? 'connected' : 'idle',         tool: 'analyst/earnings',    purpose: 'Fundamentals + analyst ratings' },
      { id: 'fred',              name: 'FRED Macro Data',       status: process.env.FRED_API_KEY     ? 'connected' : 'idle',         tool: '14 macro series',     purpose: 'Rates, inflation, VIX, GDP' },
      { id: 'sec-edgar',         name: 'SEC EDGAR',             status: 'connected',                                                  tool: 'Form 4 / EFTS',       purpose: 'Insider transactions (free)' },
      { id: 'finra',             name: 'FINRA Short Interest',  status: 'connected',                                                  tool: 'weeklySummary',       purpose: 'Short interest ratio (free)' },
      { id: 'reddit',            name: 'Reddit Social',         status: 'connected',                                                  tool: 'r/wsb r/stocks',      purpose: 'Social sentiment (free JSON)' },
      { id: 'binance',           name: 'Binance WebSocket',     status: 'connected',                                                  tool: 'crypto ticks',        purpose: 'Real-time crypto prices' },
      { id: 'postgres',          name: 'PostgreSQL',            status: process.env.DATABASE_URL     ? 'connected' : 'idle',         tool: 'portfolio/auth DB',   purpose: 'Portfolio + auth persistence' },
    ]
  })
})

module.exports = router
