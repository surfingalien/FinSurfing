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

module.exports = { parseAiJson, tryParseAiJson }
