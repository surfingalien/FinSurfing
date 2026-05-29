'use strict'
/**
 * lib/circuit-breaker.js
 *
 * Simple in-memory circuit breaker for external AI / API calls.
 * States: CLOSED (normal) → OPEN (failing, rejects fast) → HALF_OPEN (testing recovery)
 */

class CircuitOpenError extends Error {
  constructor(msg) {
    super(msg)
    this.name = 'CircuitOpenError'
    this.status = 503
  }
}

class CircuitBreaker {
  constructor(name, { threshold = 3, resetTimeoutMs = 60_000 } = {}) {
    this.name            = name
    this.threshold       = threshold       // consecutive failures before opening
    this.resetTimeoutMs  = resetTimeoutMs  // ms before attempting half-open
    this.state           = 'CLOSED'
    this.failures        = 0
    this.lastFailureAt   = null
    this.lastSuccessAt   = null
    this.totalCalls      = 0
    this.totalFailures   = 0
  }

  async call(fn) {
    this.totalCalls++

    if (this.state === 'OPEN') {
      if (this.lastFailureAt && Date.now() - this.lastFailureAt >= this.resetTimeoutMs) {
        this.state = 'HALF_OPEN'
        console.log(`[circuit:${this.name}] HALF_OPEN — testing recovery`)
      } else {
        throw new CircuitOpenError(
          `Circuit '${this.name}' is OPEN — too many recent failures, retry in ${Math.ceil((this.resetTimeoutMs - (Date.now() - this.lastFailureAt)) / 1000)}s`
        )
      }
    }

    const start = Date.now()
    try {
      const result = await fn()
      this._onSuccess()
      return { result, durationMs: Date.now() - start }
    } catch (err) {
      this._onFailure()
      err._durationMs = Date.now() - start
      throw err
    }
  }

  _onSuccess() {
    this.failures      = 0
    this.lastSuccessAt = Date.now()
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED'
      console.log(`[circuit:${this.name}] CLOSED — recovered`)
    }
  }

  _onFailure() {
    this.failures++
    this.totalFailures++
    this.lastFailureAt = Date.now()
    if (this.failures >= this.threshold) {
      if (this.state !== 'OPEN') {
        this.state = 'OPEN'
        console.warn(`[circuit:${this.name}] OPEN — ${this.failures} consecutive failures`)
      }
    }
  }

  reset() {
    this.failures      = 0
    this.state         = 'CLOSED'
    this.lastFailureAt = null
    console.log(`[circuit:${this.name}] manually RESET`)
  }

  status() {
    return {
      name:          this.name,
      state:         this.state,
      failures:      this.failures,
      threshold:     this.threshold,
      totalCalls:    this.totalCalls,
      totalFailures: this.totalFailures,
      lastFailureAt: this.lastFailureAt  ? new Date(this.lastFailureAt).toISOString()  : null,
      lastSuccessAt: this.lastSuccessAt  ? new Date(this.lastSuccessAt).toISOString()  : null,
      resetInMs:     this.state === 'OPEN' && this.lastFailureAt
        ? Math.max(0, this.resetTimeoutMs - (Date.now() - this.lastFailureAt))
        : null,
    }
  }
}

// ── Singleton registry ─────────────────────────────────────────────────────────
const breakers = {}

function getBreaker(name, opts) {
  if (!breakers[name]) breakers[name] = new CircuitBreaker(name, opts)
  return breakers[name]
}

function getAllStatuses() {
  return Object.values(breakers).map(b => b.status())
}

module.exports = { CircuitBreaker, CircuitOpenError, getBreaker, getAllStatuses }
