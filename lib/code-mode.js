'use strict'

/**
 * lib/code-mode.js — let the copilot answer fan-out questions by writing code.
 *
 * "Which tech names in the sector list have insider buying and P/E under 25?"
 * is one sector lookup, then two data calls per name, then a filter. Called
 * one tool at a time, every full result passes through the model's context
 * and every step costs a model round trip — 50 calls is 50 trips and tens of
 * thousands of tokens of tables the model only needed one number from.
 *
 * Code mode (Anthropic "programmatic tool calling"): the copilot gets the
 * `code_execution` tool, and the data tools below are marked callable from it
 * (`allowed_callers`). Claude writes a short Python program in Anthropic's
 * sandbox that calls those tools, filters the results, and returns only the
 * answer. Each call still arrives HERE as a `tool_use` block carrying a
 * `caller`, and is served by our own dispatcher — auth, rate limits and the
 * untrusted-content fencing are unchanged. Tool results consumed inside the
 * code are not billed as input tokens; only what the code prints is.
 *
 * Safety, enforced in code rather than trusted to the API:
 *   - CODE_CALLABLE is an allow-list of READ-ONLY data tools with a structured
 *     (JSON) form. The tools that spend a model call or take minutes —
 *     scan_market, get_recommendations, analyze_symbol, propose_strategies,
 *     critique_risk, analyze_filing, read_url — are direct-only: a loop must
 *     never fire twenty paid scans. `allowed_callers` is documented as NOT a
 *     security boundary, so `admitCall` refuses a non-listed tool from code
 *     even if the API forwards one.
 *   - A per-turn budget (MAX_CODE_CALLS) caps programmatic calls; past it,
 *     calls get an error result the program can see, not a silent hang.
 *   - It runs only for fan-out questions (`wantsCodeMode`) — Anthropic's own
 *     measurement is that sequential one-call turns cost ~8% MORE with it —
 *     and never with constrained decoding (strict tools are refused there).
 *   - Off switch: COPILOT_CODE_MODE=off. A request the API refuses for a
 *     code-mode reason disables it for the process and the turn reruns on the
 *     classic tool loop (same contract as a refused output schema).
 *
 * Pure. Tests: tests/code-mode.test.js
 */

// Latest version: same runtime as 20260120, and its description tells Claude
// about the 90-second limit per Python cell. allowed_callers accepts either.
const CODE_TOOL_VERSION = 'code_execution_20260521'
const CODE_TOOL = { type: CODE_TOOL_VERSION, name: 'code_execution' }

const CODE_CALLABLE = new Set([
  'sector_universe',
  'classify_symbol',
  'get_fundamentals',
  'get_analyst_consensus',
  'get_insider_activity',
  'find_exposure',
])

const MAX_CODE_CALLS = 60

/**
 * The copilot tool list for a code-mode request: the code execution tool plus
 * every tool, with the allow-listed ones also callable from code. Their
 * descriptions gain the JSON shape code receives (Claude parses results in
 * code, so the format must be documented). Static per process — tools are in
 * the cached prompt prefix.
 */
function withCodeMode(tools, codeShapes = {}) {
  return [
    CODE_TOOL,
    ...tools.map(t => {
      if (!CODE_CALLABLE.has(t.name)) return t
      const shape = codeShapes[t.name]
      return {
        ...t,
        description: shape ? `${t.description} When called from code it returns a JSON string: ${shape}` : t.description,
        allowed_callers: ['direct', CODE_TOOL_VERSION],
      }
    }),
  ]
}

/** A tool_use block that Claude's running code made (vs a direct call). */
function isProgrammatic(block) {
  return typeof block?.caller?.type === 'string' && block.caller.type.startsWith('code_execution')
}

/**
 * Decide whether a programmatic call may run. Mutates `budget.used`.
 * @returns {{ok:true} | {ok:false, error:string}}
 */
function admitCall(name, budget) {
  if (!CODE_CALLABLE.has(name)) {
    return { ok: false, error: `${name} cannot be called from code — it is expensive or slow. Call it directly instead.` }
  }
  if (budget.used >= budget.max) {
    return { ok: false, error: `Call budget for this question is spent (${budget.max} tool calls from code). Work with the results already fetched.` }
  }
  budget.used++
  return { ok: true }
}

const newBudget = (max = MAX_CODE_CALLS) => ({ used: 0, max })

// Questions that fan out over many names. Deliberately conservative: a miss
// costs nothing (the classic loop answers it, streamed), a false hit costs a
// little latency and an unstreamed reply.
const FANOUT_RE = /\b(which|screen(?:er|ing)?|filter|rank|each|every|across|all (?:the|of)|list of|names in|universe|sector|basket|exposure|suppliers?|customers|peers|competitors|supply chain|compare)\b/i
const TICKER_RE = /\b[A-Z]{2,5}(?:-USD)?\b/g
const NOT_TICKERS = new Set(['AND', 'THE', 'FOR', 'ARE', 'NOT', 'ETF', 'ETFS', 'USD', 'CEO', 'EPS', 'IPO', 'AI', 'PE', 'YTD', 'GDP', 'CPI', 'FED', 'SEC', 'US', 'USA'])

/** Does this user message look like a fan-out question? Pure. */
function wantsCodeMode(text) {
  const s = String(text || '')
  if (!s.trim()) return false
  if (FANOUT_RE.test(s)) return true
  const tickers = new Set((s.match(TICKER_RE) || []).filter(t => !NOT_TICKERS.has(t)))
  return tickers.size >= 3
}

/** Is code mode switched on for this process (env + refusal latch)? */
let _refused = null
function codeModeEnabled(env = process.env) {
  if (_refused) return false
  return String(env.COPILOT_CODE_MODE || 'on').toLowerCase() !== 'off'
}

/**
 * Does this API error say code mode itself was refused (model, org or
 * feature), as opposed to an outage? Latches code mode off for the process.
 */
function noteRefusal(err) {
  const status = err?.status ?? err?.statusCode
  if (status !== 400 && status !== 403 && status !== 404) return false
  if (!/code_execution|allowed_callers|programmatic|container/i.test(String(err?.message || ''))) return false
  _refused = { at: new Date().toISOString(), message: String(err.message).slice(0, 300) }
  return true
}

const codeModeStatus = () => ({ enabled: codeModeEnabled(), refused: _refused })
const _resetForTests = () => { _refused = null }

module.exports = {
  CODE_TOOL_VERSION, CODE_TOOL, CODE_CALLABLE, MAX_CODE_CALLS,
  withCodeMode, isProgrammatic, admitCall, newBudget, wantsCodeMode,
  codeModeEnabled, noteRefusal, codeModeStatus, _resetForTests,
}
