'use strict'
/**
 * lib/ops-alerts.js — the things an operator must hear about without opening
 * the app: the paper book paused by a risk limit, a broken data feed, a run
 * of refused orders, a strategy that stopped trading, the Agent Desk out of
 * budget or waiting on approvals. Each alert fires at most once a day (keyed),
 * by email to MORNING_BRIEF_EMAIL || ADMIN_EMAIL, and is listed on the Agent
 * Desk page. Pure collection; the job does the I/O.
 * Tests: tests/ops-alerts.test.js
 */
const fs = require('fs')
const path = require('path')
const atomic = require('./atomic-write')
const { DATA_DIR } = require('./data-dir')

const STORE = path.join(DATA_DIR, 'ops-alerts.json')
let _last = []

/**
 * @param {object} o
 * @param {object} o.paper   paper-broker snapshot()
 * @param {Array}  o.trades  paper-broker loadTrades()
 * @param {{ok: boolean, detail?: string}|null} o.dataFeed  a live SPY quote probe
 * @param {object|null} o.desk   agent-desk status()
 */
function collectAlerts({ paper = null, trades = [], dataFeed = null, desk = null, now = new Date() } = {}) {
  const out = []
  const day = now.toISOString().slice(0, 10)
  if (paper?.enabled) {
    const g = paper.protections?.global
    if (g) out.push({ key: `paper-pause:${g.kind}`, severity: 'high', title: g.kind === 'daily-loss' ? 'Daily loss limit hit — paper buys paused' : g.kind === 'max-drawdown' ? 'Drawdown limit breached — paper buys paused' : 'Paper buys paused after repeated stop-outs', detail: `${g.reason}. Paused until ${String(g.until).slice(0, 16)}Z. Exits still run.` })
    const today = (trades || []).filter(t => String(t.at || '').slice(0, 10) === day)
    const refused = today.filter(t => t.status === 'rejected' && !/paused/.test(t.rejectReason || ''))
    if (refused.length >= 3) out.push({ key: 'paper-rejections', severity: 'medium', title: `${refused.length} paper orders refused today`, detail: refused.slice(0, 5).map(t => `${t.symbol}: ${t.rejectReason}`).join('; ') })
    const slip = today.filter(t => t.status === 'filled' && t.slippageBps > 0 && t.quotePrice > 0 && Math.abs(t.price - t.quotePrice) / t.quotePrice * 1e4 > 2 * t.slippageBps)
    if (slip.length) out.push({ key: 'paper-slippage', severity: 'medium', title: 'Unusual slippage on paper fills', detail: slip.map(t => t.symbol).join(', ') })
    const lastFill = (trades || []).filter(t => t.status === 'filled' && t.side === 'buy').at(-1)
    const quietDays = lastFill ? (now - new Date(lastFill.at)) / 86_400_000 : null
    if (quietDays != null && quietDays > 10) out.push({ key: 'paper-quiet', severity: 'low', title: 'The paper book has not opened a position in over 10 days', detail: `Last buy ${String(lastFill.at).slice(0, 10)}. Check that scans produce actionable buy picks and the executor runs.` })
    if (paper.performance?.openPositions && (paper.unmanaged || []).length) out.push({ key: 'paper-unmanaged', severity: 'medium', title: 'Paper positions without exits', detail: paper.unmanaged.join(', ') })
  }
  if (dataFeed && !dataFeed.ok) out.push({ key: 'data-feed', severity: 'high', title: 'Market data feed is down', detail: dataFeed.detail || 'the live SPY quote probe failed' })
  if (desk?.enabled) {
    if (desk.budget?.exhausted) out.push({ key: `desk-budget:${desk.budget.month}`, severity: 'medium', title: 'Agent Desk monthly AI budget reached', detail: `$${desk.budget.spentUsd} of $${desk.budget.capUsd}. It keeps running the code-only checks; it will not call a model until next month or until you raise AGENT_MONTHLY_BUDGET_USD.` })
    const pending = (desk.proposals || []).filter(p => p.status === 'pending')
    if (pending.length) out.push({ key: 'desk-pending', severity: 'low', title: `${pending.length} Agent Desk proposal(s) waiting for your approval`, detail: pending.slice(0, 5).map(p => p.title).join('; ') })
    const err = (desk.lastCycle?.steps || []).find(s => s.name === 'error')
    if (err) out.push({ key: `desk-error:${desk.lastCycle.cycleId}`, severity: 'medium', title: 'The last Agent Desk cycle failed', detail: err.detail })
    if (desk.ledger?.verdict === 'does-not-cover') out.push({ key: `desk-ledger:${desk.ledger.month}`, severity: 'low', title: 'The Agent Desk does not cover its costs this month', detail: desk.ledger.recommendation })
  }
  return out
}

/** Alerts not yet sent today. Pure. */
function newSince(alerts, sent = {}, now = new Date()) {
  const day = now.toISOString().slice(0, 10)
  return alerts.filter(a => sent[a.key] !== day)
}

function readSent(file = STORE) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} } }
function markSent(alerts, now = new Date(), file = STORE) {
  const s = readSent(file), day = now.toISOString().slice(0, 10)
  for (const a of alerts) s[a.key] = day
  for (const [k, v] of Object.entries(s)) if (v < new Date(now - 30 * 86_400_000).toISOString().slice(0, 10)) delete s[k]
  fs.mkdirSync(path.dirname(file), { recursive: true })
  atomic.writeJsonAtomic(file, s)
}

function setCurrent(alerts) { _last = alerts }
function currentAlerts() { return _last }

module.exports = { STORE, collectAlerts, newSince, readSent, markSent, setCurrent, currentAlerts }
