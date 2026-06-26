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

const VALID_PROVIDERS = new Set(['claude', 'groq', 'zai', 'qwen'])

// Ordered provider chain for the model-driven research routes. Each provider is
// tried in order; on a rate-limit / overload / transient error the router
// switches automatically to the next. Set AI_PROVIDER_CHAIN (e.g. "zai,qwen" to
// run all research on GLM and fail over to Qwen, or "zai,qwen,claude" to also
// fall back to Claude). Default preserves prior behaviour: Claude →
// AI_FALLBACK_PROVIDER (groq).
function providerChain() {
  const raw = (process.env.AI_PROVIDER_CHAIN || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  const chain = raw.filter(p => VALID_PROVIDERS.has(p))
  return chain.length ? [...new Set(chain)] : ['claude', fallbackProviderName()]
}

function providerConfigured(p) {
  return p === 'claude' ? !!process.env.ANTHROPIC_API_KEY : compatConfigured(p)
}

// Worth switching providers for? Rate-limit (429), overload (529), 5xx, circuit
// open, and network/timeout are transient; hard 4xx (auth/bad request) are not —
// those should surface, not be masked by a silent provider switch.
function isSwitchable(err) {
  if (err instanceof CircuitOpenError) return true
  const s = err?.status
  if (s === 429 || s === 529) return true
  if (typeof s === 'number' && s >= 500) return true
  if (typeof s === 'number' && s >= 400 && s < 500) return false
  return /rate.?limit|too many requests|overload|timeout|ETIMEDOUT|ECONN|fetch failed|API error 5\d\d/i.test(err?.message || '')
}

class AIRouter {
  constructor(route, opts = {}) {
    this.route   = route
    this.breaker = getBreaker(route, { threshold: 3, resetTimeoutMs: 60_000, ...opts })
  }

  /**
   * Run the prompt through the configured provider chain (AI_PROVIDER_CHAIN),
   * automatically switching to the next provider on a rate-limit / overload /
   * transient error. Claude is skipped while paused (CLAUDE_PAUSE_UNTIL).
   * @param {object} opts
   * @param {string}   opts.prompt       - user message content
   * @param {number}   [opts.maxTokens]  - default 4096
   * @param {string}   [opts.system]     - optional system prompt
   * @param {string[]} [opts.symbols]    - for audit logging
   * @returns {Promise<{ text, llmUsed, tokensIn, tokensOut, durationMs }>}
   */
  async call({ prompt, maxTokens = 4096, system = null, symbols = [] }) {
    let chain = providerChain().filter(providerConfigured)
    if (claudePaused()) chain = chain.filter(p => p !== 'claude')

    if (chain.length === 0) {
      if (claudePaused()) throw pausedError()
      const err = new Error('No AI provider configured (set ANTHROPIC_API_KEY or an OpenAI-compatible provider key)')
      err.status = 503
      throw err
    }

    let lastErr
    for (let i = 0; i < chain.length; i++) {
      const provider = chain[i]
      const isLast = i === chain.length - 1
      try {
        return provider === 'claude'
          ? await this._callClaude({ prompt, maxTokens, system, symbols })
          : await this.callOpenAI(provider, { prompt, maxTokens, system, symbols })
      } catch (err) {
        lastErr = err
        if (isLast || !isSwitchable(err)) throw err
        console.warn(`[ai-router:${this.route}] ${provider} failed (${err.message}) — switching to ${chain[i + 1]}`)
      }
    }
    throw lastErr
  }

  // Claude call via circuit breaker. Throws on failure (caller handles failover).
  async _callClaude({ prompt, maxTokens = 4096, system = null, symbols = [] }) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    const params = { model: CLAUDE_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }
    if (system) params.system = system
    try {
      const { result: msg, durationMs } = await this.breaker.call(async () =>
        new Anthropic({ apiKey }).messages.create(params)
      )
      const text      = msg.content?.[0]?.text || ''
      const tokensIn  = msg.usage?.input_tokens  ?? null
      const tokensOut = msg.usage?.output_tokens ?? null
      logCall({ route: this.route, model: CLAUDE_MODEL, llm: 'claude', symbols, success: true, tokensIn, tokensOut, durationMs })
      return { text, llmUsed: 'claude', tokensIn, tokensOut, durationMs }
    } catch (claudeErr) {
      logCall({ route: this.route, model: CLAUDE_MODEL, llm: 'claude', symbols, success: false, error: claudeErr.message, durationMs: claudeErr._durationMs || 0 })
      throw claudeErr
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
      if (!r.ok) {
        const e = new Error(`${providerName} API error ${r.status}`)
        e.status = r.status   // lets the chain detect 429/5xx and fail over
        throw e
      }
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

module.exports = { AIRouter, getRouter, CLAUDE_MODEL, GROQ_MODEL, OPENAI_COMPAT, fallbackProviderName, compatConfigured, providerChain, isSwitchable }
