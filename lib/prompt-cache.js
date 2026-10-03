'use strict'

/**
 * lib/prompt-cache.js — Anthropic prompt caching, laid out once.
 *
 * Every Claude call here used to send its whole prompt uncached: the Copilot
 * re-sent its ~2.5k-token system prompt and full tool registry on EVERY round
 * of its tool loop (up to 5 per question), the Analyst agent did the same over
 * 6 rounds, and every AI Brain scan re-sent the same ~2k tokens of schema and
 * scoring rules. A cache read costs ~0.1x the input price; a 5-minute write
 * costs 1.25x, so anything read back once has paid for itself.
 *
 * Caching is a PREFIX match (tools → system → messages, in that order), so the
 * layout rule is: stable text first, marked; anything that varies per user or
 * per request after the mark. A volatile byte inside the marked block — a
 * date, a user's portfolio — makes every request a fresh write and the cache
 * a pure surcharge. Hence two system blocks, not one string.
 *
 * Prefixes under the model's minimum (1024 tokens on Sonnet 4.6) silently do
 * not cache — no error, no charge — so marking a short block is harmless.
 *
 * Pure. Tests: tests/prompt-cache.test.js
 */

const EPHEMERAL = Object.freeze({ type: 'ephemeral' })

/**
 * System prompt as blocks: the stable part carries the cache mark, the
 * volatile part (may be empty) follows it unmarked.
 */
function cachedSystem(stable, volatile = '') {
  const blocks = [{ type: 'text', text: String(stable || ''), cache_control: EPHEMERAL }]
  if (volatile && String(volatile).trim()) blocks.push({ type: 'text', text: String(volatile) })
  return blocks
}

/**
 * The conversation with ONE cache mark on the last block of the last message,
 * so each round of a tool loop reads everything the previous round wrote and
 * pays full price only for what it appended. Earlier marks are removed — the
 * API allows four in total and the system block already holds one. Returns a
 * new array; the caller's history is never mutated (it is replayed later).
 */
function markConversationTail(messages) {
  if (!Array.isArray(messages) || !messages.length) return messages
  const out = messages.map(m => ({ ...m, content: stripMarks(m.content) }))
  const last = out[out.length - 1]
  const blocks = typeof last.content === 'string'
    ? [{ type: 'text', text: last.content }]
    : [...last.content]
  if (!blocks.length) return out
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: EPHEMERAL }
  out[out.length - 1] = { ...last, content: blocks }
  return out
}

function stripMarks(content) {
  if (!Array.isArray(content)) return content
  return content.map(b => {
    if (!b || !b.cache_control) return b
    const { cache_control, ...rest } = b   // eslint-disable-line no-unused-vars
    return rest
  })
}

/** The cache fields of a usage block, null when the API did not report them. */
function cacheUsage(usage) {
  if (!usage) return { cacheRead: null, cacheWrite: null }
  return {
    cacheRead:  usage.cache_read_input_tokens     ?? null,
    cacheWrite: usage.cache_creation_input_tokens ?? null,
  }
}

module.exports = { cachedSystem, markConversationTail, cacheUsage, EPHEMERAL }
