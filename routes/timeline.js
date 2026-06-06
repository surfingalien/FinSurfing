'use strict'
/**
 * routes/timeline.js
 *
 * GET /api/timeline  — trade thesis history timeline
 *
 * Reads ai-brain-predictions.jsonl and returns a structured event feed
 * for the TradeTimelineView. Inspired by obsidian-auto-timelines:
 * each prediction is a "card" plotted at its generatedAt date,
 * showing signal, scores, thesis assumptions, and agent conflicts.
 *
 * Query params:
 *   symbols  — comma-separated list of symbols to filter (optional)
 *   limit    — max events to return (default 100)
 *   offset   — pagination offset (default 0)
 */

const express = require('express')
const fs      = require('fs')
const path    = require('path')

const router         = express.Router()
const PREDICTION_LOG = path.join(__dirname, '../data/ai-brain-predictions.jsonl')

function readPredictions() {
  if (!fs.existsSync(PREDICTION_LOG)) return []
  try {
    return fs.readFileSync(PREDICTION_LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line) } catch { return null } })
      .filter(Boolean)
  } catch { return [] }
}

const VERDICT_ORDER = {
  'Strong Buy': 0, 'Buy': 1, 'Moderate Buy': 2,
  'Hold': 3, 'Moderate Sell': 4, 'Sell': 5, 'Strong Sell': 6,
}

const VERDICT_COLOR = {
  'Strong Buy':    '#00ffcc',
  'Buy':           '#4ade80',
  'Moderate Buy':  '#86efac',
  'Hold':          '#94a3b8',
  'Moderate Sell': '#fbbf24',
  'Sell':          '#f87171',
  'Strong Sell':   '#ef4444',
}

router.get('/', (req, res) => {
  const { symbols, limit = '100', offset = '0' } = req.query
  const filterSyms = symbols ? symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : null
  const lim = Math.min(parseInt(limit) || 100, 500)
  const off = parseInt(offset) || 0

  const all = readPredictions()

  // Filter by symbols if provided
  const filtered = filterSyms
    ? all.filter(p => filterSyms.includes(p.symbol?.toUpperCase()))
    : all

  // Sort newest first
  const sorted = filtered.sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt))

  // Detect signal changes per symbol (compare each event to the previous for that symbol)
  const lastVerdictBySymbol = {}
  const withChanges = [...sorted].reverse().map(p => {
    const sym = p.symbol
    const prev = lastVerdictBySymbol[sym]
    const changed = prev && prev !== p.verdict
    lastVerdictBySymbol[sym] = p.verdict
    return { ...p, verdictChanged: changed, prevVerdict: changed ? prev : undefined }
  }).reverse()

  const page = withChanges.slice(off, off + lim)

  // Summary per symbol (for the symbol filter chips in the UI)
  const symbolSummary = {}
  for (const p of sorted) {
    const sym = p.symbol
    if (!symbolSummary[sym]) {
      symbolSummary[sym] = {
        symbol: sym,
        count: 0,
        latestVerdict: p.verdict,
        latestScore: p.compositeScore,
        latestDate: p.generatedAt,
        verdictColor: VERDICT_COLOR[p.verdict] || '#94a3b8',
      }
    }
    symbolSummary[sym].count++
  }

  res.json({
    events: page.map(p => ({
      ...p,
      verdictColor: VERDICT_COLOR[p.verdict] || '#94a3b8',
    })),
    total:   filtered.length,
    offset:  off,
    limit:   lim,
    symbols: Object.values(symbolSummary).sort((a, b) => new Date(b.latestDate) - new Date(a.latestDate)),
  })
})

module.exports = router
