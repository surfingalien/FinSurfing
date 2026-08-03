'use strict'
/**
 * lib/canonical-json.js
 *
 * Deterministic, key-order-independent JSON serialization — ONE implementation.
 *
 * Two subsystems depend on this for IDENTITY, where a change in output is a
 * change in meaning:
 *   - lib/rec-journal.js   — the tamper-evident hash chain over journal entries
 *   - lib/strategy-library.js — strategy ids (a composed rule tree is a nested
 *     param, so plain interpolation would render every distinct rule as
 *     "[object Object]" and collapse them into a single identity)
 *
 * These previously carried byte-identical private copies. Duplicated hashing
 * logic is a latent correctness bug: if one copy is ever "improved" and the
 * other isn't, previously-written hashes silently stop verifying and history
 * looks corrupted. Hence one shared implementation.
 *
 * CONTRACT — treat this as frozen. Its output is baked into hashes already
 * written to disk, so any behavioural change invalidates existing chains and
 * strategy ids. Extend by adding a NEW function, never by altering this one.
 *
 * Rules: object keys sorted at every level; arrays keep order (order is
 * meaningful); primitives use JSON.stringify. Values JSON cannot represent
 * (undefined, functions) follow JSON.stringify semantics.
 *
 * Pure, no deps. Tests: tests/canonical-json.test.js
 */

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}'
}

module.exports = { canonicalJson }
