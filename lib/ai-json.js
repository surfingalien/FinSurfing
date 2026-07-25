'use strict'
/**
 * lib/ai-json.js
 *
 * Robust parsing for LLM responses that are supposed to be JSON.
 * Promoted from routes/research-notes.js so every AI route shares one
 * implementation instead of hand-rolling fence-stripping and {...} extraction.
 */

/** Parse LLM output as JSON; throws a user-presentable Error on failure. */
function parseAiJson(text) {
  if (!text?.trim()) throw new Error('AI returned an empty response — please try again.')
  // Strip markdown code fences (```json ... ```)
  const unwrapped = text.replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/im, '').trim()
  // Direct parse
  try { return JSON.parse(unwrapped) } catch {}
  // Extract first JSON object
  const match = unwrapped.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('AI response did not contain valid JSON — please try again.')
  try { return JSON.parse(match[0]) } catch (e) {
    throw new Error(`AI response JSON parse failed — please try again. (${e.message.slice(0, 60)})`)
  }
}

/** Like parseAiJson but returns null instead of throwing — for optional payloads. */
function tryParseAiJson(text) {
  try { return parseAiJson(text) } catch { return null }
}

/**
 * Recover the COMPLETE objects from a (possibly truncated) JSON array that
 * lives under `"key": [ ... ]` in the text. When an LLM response is cut off at
 * the token ceiling, the whole payload won't JSON.parse, but every object that
 * finished before the cut is still intact — this salvages those so a slightly
 * over-budget response yields usable items instead of a hard failure.
 *
 * Brace/bracket counting is string- and escape-aware, so braces or quotes
 * inside string values never confuse the scan. Objects that don't parse are
 * skipped. Returns [] when the key/array isn't found.
 */
function extractArrayObjects(text, key) {
  if (!text || !key) return []
  const keyIdx = text.indexOf(`"${key}"`)
  if (keyIdx === -1) return []
  const bracket = text.indexOf('[', keyIdx)
  if (bracket === -1) return []

  const out = []
  let depth = 0, start = -1, inStr = false, esc = false
  for (let i = bracket + 1; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') { if (depth === 0) start = i; depth++; continue }
    if (ch === '}') {
      if (depth > 0 && --depth === 0 && start !== -1) {
        try { out.push(JSON.parse(text.slice(start, i + 1))) } catch { /* skip partial */ }
        start = -1
      }
      continue
    }
    if (ch === ']' && depth === 0) break // clean end of the array
  }
  return out
}

module.exports = { parseAiJson, tryParseAiJson, extractArrayObjects }
