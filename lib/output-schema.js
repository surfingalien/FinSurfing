'use strict'

/**
 * lib/output-schema.js — constrained decoding: the model can only emit JSON of
 * a declared shape.
 *
 * Every AI surface asked for JSON in prose ("respond ONLY with valid JSON…")
 * and then repaired whatever came back: fence stripping, `{…}` extraction,
 * salvage of truncated arrays, and a "returned no parseable JSON — try again"
 * error that threw away a paid call. Both providers can enforce a schema at
 * decode time instead — Claude `output_config.format`, Groq strict
 * `response_format.json_schema` — so the token stream itself cannot leave the
 * grammar: no prose around the JSON, no missing field, no "Buy " with a
 * trailing space for an enum, no price written as a string.
 *
 * What it does NOT do: it guarantees SHAPE, never TRUTH. A schema cannot say
 * "stopLoss is a percent, not a price" (numeric bounds are unsupported by both
 * providers), so price-coherence, the citation gate, the EV gate and every
 * other judge stays exactly where it is. The model proposes; code judges.
 *
 * One schema serves both providers, so it is written to the intersection of
 * their rules (`lintSchema` enforces it, and tests/ai-schemas.test.js runs it
 * over every registered schema — a schema either API would reject fails CI
 * rather than production):
 *   - every object: all properties `required`, `additionalProperties: false`
 *     (Groq strict refuses optional fields; Claude caps optional params at 24)
 *   - no numeric/length bounds (`minimum`, `maxLength`, `maxItems`, …) — both
 *     reject them; state the bound in `description` and enforce it in code
 *   - `minItems` only 0 or 1; enums of scalars only; no recursion
 *   - at most MAX_UNIONS anyOf/type-array unions (Claude's limit is 16)
 *
 * Schemas must be STATIC per surface: changing `output_config.format`
 * invalidates the prompt cache and recompiles the grammar (first use of a new
 * schema is slower; compiled grammars are cached ~24h).
 */

const MAX_UNIONS = 16
const FORBIDDEN = [
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'maxItems', 'uniqueItems', 'contains',
  'minProperties', 'maxProperties', 'patternProperties', 'propertyNames',
  'oneOf', 'not', 'if', 'then', 'else', 'dependentRequired', 'dependentSchemas',
]

// ── Builders — terse, and correct by construction ────────────────────────────
const d = description => (description ? { description } : {})
const str  = description => ({ type: 'string', ...d(description) })
const num  = description => ({ type: 'number', ...d(description) })
const int  = description => ({ type: 'integer', ...d(description) })
const bool = description => ({ type: 'boolean', ...d(description) })
const oneOf = (values, description) => ({ type: typeof values[0] === 'number' ? (values.every(Number.isInteger) ? 'integer' : 'number') : 'string', enum: [...values], ...d(description) })
const arr = (items, description) => ({ type: 'array', items, ...d(description) })
const pattern = (re, description) => ({ type: 'string', pattern: re, ...d(description) })
function obj(properties, description) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false, ...d(description) }
}

/**
 * Problems that would make either provider reject the schema (or make
 * Groq strict refuse it). [] when it is safe to send. Pure.
 */
function lintSchema(schema) {
  const problems = []
  let unions = 0
  const seen = new Set()
  ;(function walk(node, path) {
    if (!node || typeof node !== 'object') { problems.push(`${path}: not a schema`); return }
    if (seen.has(node)) { problems.push(`${path}: recursive schema`); return }
    seen.add(node)
    for (const k of FORBIDDEN) if (k in node) problems.push(`${path}: "${k}" is not supported by constrained decoding — state it in the description and check it in code`)
    if ('$ref' in node) problems.push(`${path}: $ref is not used here (keep schemas flat)`)
    if (Array.isArray(node.type)) unions++
    if (node.anyOf) { unions++; node.anyOf.forEach((s, i) => walk(s, `${path}.anyOf[${i}]`)) }
    if (node.enum) {
      if (!Array.isArray(node.enum) || !node.enum.length) problems.push(`${path}: empty enum`)
      else if (node.enum.some(v => v !== null && typeof v === 'object')) problems.push(`${path}: enum values must be scalars`)
    }
    const type = node.type
    if (type === 'object') {
      const props = node.properties || {}
      const keys = Object.keys(props)
      if (node.additionalProperties !== false) problems.push(`${path}: object needs additionalProperties: false`)
      const req = new Set(node.required || [])
      const missing = keys.filter(k => !req.has(k))
      if (missing.length) problems.push(`${path}: every property must be required (Groq strict) — missing ${missing.join(', ')}`)
      const extra = [...req].filter(k => !keys.includes(k))
      if (extra.length) problems.push(`${path}: required names unknown properties ${extra.join(', ')}`)
      for (const k of keys) walk(props[k], `${path}.${k}`)
    } else if (type === 'array') {
      if (node.minItems != null && node.minItems !== 0 && node.minItems !== 1) problems.push(`${path}: minItems may only be 0 or 1`)
      if (!node.items) problems.push(`${path}: array needs items`)
      else walk(node.items, `${path}[]`)
    } else if (type == null && !node.anyOf && !node.enum && !('const' in node)) {
      problems.push(`${path}: missing type`)
    }
    seen.delete(node)
  })(schema, '$')
  if (schema?.type !== 'object') problems.push('$: the root must be an object')
  if (unions > MAX_UNIONS) problems.push(`$: ${unions} unions — the limit is ${MAX_UNIONS}`)
  return problems
}

/** Claude Messages API: `output_config.format`. */
const claudeFormat = schema => ({ type: 'json_schema', schema })

/** Groq (OpenAI-compatible): strict json_schema = constrained decoding. */
const groqFormat = (name, schema) => ({ type: 'json_schema', json_schema: { name: String(name || 'output').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64), strict: true, schema } })

/**
 * Claude may return an enum value that differs from the schema only in
 * capitalisation (documented). Map such values back to the declared spelling
 * so `"strong buy"` can never fall through a lookup keyed on `"Strong Buy"`.
 * Walks schema and value together; returns a new value. Pure.
 */
function canonicalizeEnums(schema, value) {
  if (!schema || value == null) return value
  if (Array.isArray(schema.enum) && typeof value === 'string') {
    if (schema.enum.includes(value)) return value
    const hit = schema.enum.find(e => typeof e === 'string' && e.toLowerCase() === value.trim().toLowerCase())
    return hit ?? value
  }
  if (schema.type === 'array' && Array.isArray(value)) return value.map(v => canonicalizeEnums(schema.items, v))
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const out = { ...value }
    for (const [k, s] of Object.entries(schema.properties || {})) if (k in out) out[k] = canonicalizeEnums(s, out[k])
    return out
  }
  return value
}

/**
 * Does this provider error say the SCHEMA was refused (vs. an outage)? Used to
 * switch constrained decoding off for that schema and retry unconstrained, so
 * a schema the API will not compile can never take a feature down.
 */
function isSchemaRejection(err) {
  const status = err?.status ?? err?.statusCode
  if (status !== 400 && status !== 422) return false
  return /output_config|json_schema|response_format|schema|grammar|compil/i.test(String(err?.message || ''))
}

module.exports = {
  str, num, int, bool, oneOf, arr, obj, pattern,
  lintSchema, claudeFormat, groqFormat, canonicalizeEnums, isSchemaRejection,
  MAX_UNIONS,
}
