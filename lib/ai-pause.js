'use strict'
/**
 * lib/ai-pause.js
 *
 * Global, time-bounded pause for Claude/Anthropic usage — lets you stop burning
 * Anthropic quota until a date (e.g. when a monthly limit resets) without
 * touching every route or redeploying to flip it back on.
 *
 * Driven by one env var:
 *   CLAUDE_PAUSE_UNTIL = an ISO date/time, e.g. "2026-07-01"
 *
 * While now < that date, claudePaused() is true and:
 *   - lib/ai-router.js routes those features to Groq (so they keep working) and
 *     only errors if no GROQ_API_KEY is set;
 *   - direct Anthropic callers (copilot, quantmind, rebalancer, sentiment,
 *     agent, research-notes, brain-learnings) skip the Claude call and degrade
 *     gracefully instead of consuming quota.
 *
 * After the date passes, everything auto-resumes — no second deploy needed.
 * Unset/blank/invalid CLAUDE_PAUSE_UNTIL → never paused (default behaviour).
 */

function pauseUntilTs() {
  const v = (process.env.CLAUDE_PAUSE_UNTIL || '').trim()
  if (!v) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

function claudePaused(now = Date.now()) {
  const t = pauseUntilTs()
  return t != null && now < t
}

function pauseMessage() {
  const t = pauseUntilTs()
  const when = t ? new Date(t).toISOString().slice(0, 10) : 'a configured date'
  return `Claude AI is paused until ${when} to preserve quota. AI features using Groq still work; Claude-only features resume automatically.`
}

function pausedError() {
  const e = new Error(pauseMessage())
  e.status = 503
  e.claudePaused = true
  return e
}

module.exports = { claudePaused, pauseUntilTs, pauseMessage, pausedError }
