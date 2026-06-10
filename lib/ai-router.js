'use strict'
/**
 * lib/ai-router.js
 *
 * Unified LLM routing for all AI routes.
 * Claude primary → Groq (llama-3.3-70b) fallback on overload.
 * Handles circuit breaking, audit logging, and streaming in one place
 * so individual routes don't each duplicate that boilerplate.
 */

const Anthropic = require('@anthropic-ai/sdk')
const { getBreaker, CircuitOpenError } = require('./circuit-breaker')
const { logCall } = require('./ai-audit')

const CLAUDE_MODEL = 'claude-sonnet-4-6'
const GROQ_MODEL   = 'llama-3.3-70b-versatile'

class AIRouter {
  constructor(route, opts = {}) {
    this.route   = route
    this.breaker = getBreaker(route, { threshold: 3, resetTimeoutMs: 60_000, ...opts })
  }

  /**
   * Call Claude with Groq fallback on overload.
   * @param {object} opts
   * @param {string}   opts.prompt       - user message content
   * @param {number}   [opts.maxTokens]  - default 4096
   * @param {string}   [opts.system]     - optional system prompt
   * @param {string[]} [opts.symbols]    - for audit logging
   * @returns {Promise<{ text, llmUsed, tokensIn, tokensOut, durationMs }>}
   */
  async call({ prompt, maxTokens = 4096, system = null, symbols = [] }) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      const err = new Error('AI service not configured (ANTHROPIC_API_KEY missing)')
      err.status = 503
      throw err
    }

    // ── Claude via circuit breaker ────────────────────────────────────────────
    try {
      const params = { model: CLAUDE_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }
      if (system) params.system = system

      const { result: msg, durationMs } = await this.breaker.call(async () =>
        new Anthropic({ apiKey }).messages.create(params)
      )

      const text      = msg.content?.[0]?.text || ''
      const tokensIn  = msg.usage?.input_tokens  ?? null
      const tokensOut = msg.usage?.output_tokens ?? null
      logCall({ route: this.route, model: CLAUDE_MODEL, llm: 'claude', symbols, success: true, tokensIn, tokensOut, durationMs })
      return { text, llmUsed: 'claude', tokensIn, tokensOut, durationMs }

    } catch (claudeErr) {
      if (claudeErr instanceof CircuitOpenError) {
        logCall({ route: this.route, model: CLAUDE_MODEL, llm: 'claude', symbols, success: false, error: claudeErr.message, durationMs: 0 })
        throw claudeErr
      }

      const isOverloaded = claudeErr.status === 529 || claudeErr.message?.includes('overloaded')
      if (!isOverloaded || !process.env.GROQ_API_KEY) {
        logCall({ route: this.route, model: CLAUDE_MODEL, llm: 'claude', symbols, success: false, error: claudeErr.message, durationMs: claudeErr._durationMs || 0 })
        throw claudeErr
      }

      // ── Groq fallback ─────────────────────────────────────────────────────
      console.warn(`[ai-router:${this.route}] Claude overloaded — falling back to Groq`)
      return this.callGroq({ prompt, maxTokens, system, symbols })
    }
  }

  /**
   * Call Groq directly (no Claude). Used both as the overload fallback and as
   * the independent second opinion in ensemble scans.
   * @returns {Promise<{ text, llmUsed, tokensIn, tokensOut, durationMs }>}
   */
  async callGroq({ prompt, maxTokens = 4096, system = null, symbols = [] }) {
    if (!process.env.GROQ_API_KEY) {
      const err = new Error('Groq not configured (GROQ_API_KEY missing)')
      err.status = 503
      throw err
    }
    const t0 = Date.now()
    try {
      const groqMessages = system
        ? [{ role: 'system', content: system }, { role: 'user', content: prompt }]
        : [{ role: 'user', content: prompt }]
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        body:    JSON.stringify({ model: GROQ_MODEL, max_tokens: maxTokens, messages: groqMessages }),
        signal:  AbortSignal.timeout(60_000),
      })
      if (!r.ok) throw new Error(`Groq API error ${r.status}`)
      const d          = await r.json()
      const text       = d.choices?.[0]?.message?.content || ''
      const durationMs = Date.now() - t0
      logCall({ route: this.route, model: GROQ_MODEL, llm: 'groq', symbols, success: true, durationMs })
      return { text, llmUsed: 'groq', tokensIn: null, tokensOut: null, durationMs }
    } catch (groqErr) {
      logCall({ route: this.route, model: GROQ_MODEL, llm: 'groq', symbols, success: false, error: groqErr.message, durationMs: Date.now() - t0 })
      throw groqErr
    }
  }

  /**
   * Stream Claude response — no Groq fallback (streaming requires SSE passthrough).
   * Returns an Anthropic stream object with .on('text') events.
   */
  stream({ prompt, maxTokens = 1024, system = null }) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      const err = new Error('AI service not configured (ANTHROPIC_API_KEY missing)')
      err.status = 503
      throw err
    }
    const params = { model: CLAUDE_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }
    if (system) params.system = system
    return new Anthropic({ apiKey }).messages.stream(params)
  }
}

// ── Singleton registry — one router per route name ─────────────────────────────
const _routers = {}
function getRouter(route, opts) {
  if (!_routers[route]) _routers[route] = new AIRouter(route, opts)
  return _routers[route]
}

module.exports = { AIRouter, getRouter, CLAUDE_MODEL, GROQ_MODEL }
