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
const { claudePaused, pausedError } = require('./ai-pause')

const CLAUDE_MODEL = 'claude-sonnet-4-6'
const GROQ_MODEL   = 'llama-3.3-70b-versatile'

// OpenAI-compatible providers used as Claude fallback / pause target. baseUrl is
// fixed server-side (never client-supplied) so it can't be abused for SSRF.
// Model names are env-overridable since these vendors rev them frequently.
const OPENAI_COMPAT = {
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions',                       keyEnv: 'GROQ_API_KEY', model: () => GROQ_MODEL },
  zai:  { url: 'https://api.z.ai/api/paas/v4/chat/completions',                         keyEnv: 'ZAI_API_KEY',  model: () => process.env.ZAI_MODEL  || 'glm-4.6' },
  qwen: { url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', keyEnv: 'QWEN_API_KEY', model: () => process.env.QWEN_MODEL || 'qwen-plus' },
}

// Which OpenAI-compatible provider Claude falls back to (overload) or is replaced
// by (pause). Defaults to Groq; set AI_FALLBACK_PROVIDER=zai|qwen to use those.
function fallbackProviderName() {
  const p = (process.env.AI_FALLBACK_PROVIDER || 'groq').toLowerCase()
  return OPENAI_COMPAT[p] ? p : 'groq'
}
function compatConfigured(name) {
  const cfg = OPENAI_COMPAT[name]
  return !!(cfg && process.env[cfg.keyEnv])
}

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
    // Claude paused (quota preservation): use the configured OpenAI-compatible
    // fallback provider so the feature keeps working; only error if none is set.
    if (claudePaused()) {
      const fb = fallbackProviderName()
      if (compatConfigured(fb)) {
        console.warn(`[ai-router:${this.route}] Claude paused — routing to ${fb}`)
        return this.callOpenAI(fb, { prompt, maxTokens, system, symbols })
      }
      throw pausedError()
    }
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
      const fb = fallbackProviderName()
      if (!isOverloaded || !compatConfigured(fb)) {
        logCall({ route: this.route, model: CLAUDE_MODEL, llm: 'claude', symbols, success: false, error: claudeErr.message, durationMs: claudeErr._durationMs || 0 })
        throw claudeErr
      }

      // ── Fallback to configured OpenAI-compatible provider ──────────────────
      console.warn(`[ai-router:${this.route}] Claude overloaded — falling back to ${fb}`)
      return this.callOpenAI(fb, { prompt, maxTokens, system, symbols })
    }
  }

  /**
   * Call any OpenAI-compatible provider (Groq, Z.ai/GLM, Qwen) directly — used
   * as the Claude overload/pause fallback and the ensemble second opinion.
   * @param {'groq'|'zai'|'qwen'} providerName
   * @returns {Promise<{ text, llmUsed, tokensIn, tokensOut, durationMs }>}
   */
  async callOpenAI(providerName, { prompt, maxTokens = 4096, system = null, symbols = [] }) {
    const cfg = OPENAI_COMPAT[providerName] || OPENAI_COMPAT.groq
    const apiKey = process.env[cfg.keyEnv]
    if (!apiKey) {
      const err = new Error(`${providerName} not configured (${cfg.keyEnv} missing)`)
      err.status = 503
      throw err
    }
    const model = cfg.model()
    const t0 = Date.now()
    try {
      const messages = system
        ? [{ role: 'system', content: system }, { role: 'user', content: prompt }]
        : [{ role: 'user', content: prompt }]
      const r = await fetch(cfg.url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body:    JSON.stringify({ model, max_tokens: maxTokens, messages }),
        signal:  AbortSignal.timeout(60_000),
      })
      if (!r.ok) throw new Error(`${providerName} API error ${r.status}`)
      const d          = await r.json()
      const text       = d.choices?.[0]?.message?.content || ''
      const durationMs = Date.now() - t0
      logCall({ route: this.route, model, llm: providerName, symbols, success: true, durationMs })
      return { text, llmUsed: providerName, tokensIn: null, tokensOut: null, durationMs }
    } catch (err) {
      logCall({ route: this.route, model, llm: providerName, symbols, success: false, error: err.message, durationMs: Date.now() - t0 })
      throw err
    }
  }

  // Back-compat: the ai-brain ensemble calls callGroq directly.
  async callGroq(opts) { return this.callOpenAI('groq', opts) }

  /**
   * Stream Claude response — no Groq fallback (streaming requires SSE passthrough).
   * Returns an Anthropic stream object with .on('text') events.
   */
  stream({ prompt, maxTokens = 1024, system = null }) {
    if (claudePaused()) throw pausedError()
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

module.exports = { AIRouter, getRouter, CLAUDE_MODEL, GROQ_MODEL, OPENAI_COMPAT, fallbackProviderName, compatConfigured }
