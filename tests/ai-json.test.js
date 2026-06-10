'use strict'
/**
 * Unit tests for lib/ai-json.js — shared LLM JSON parsing.
 */

const { parseAiJson, tryParseAiJson } = require('../lib/ai-json')

describe('parseAiJson', () => {
  test('parses plain JSON', () => {
    expect(parseAiJson('{"a":1}')).toEqual({ a: 1 })
  })

  test('strips markdown code fences', () => {
    expect(parseAiJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(parseAiJson('```\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  test('extracts the JSON object from surrounding prose', () => {
    expect(parseAiJson('Here is my analysis:\n{"signal":"BUY"}\nHope that helps!'))
      .toEqual({ signal: 'BUY' })
  })

  test('throws on empty input', () => {
    expect(() => parseAiJson('')).toThrow(/empty response/i)
    expect(() => parseAiJson(null)).toThrow(/empty response/i)
  })

  test('throws when no JSON object exists', () => {
    expect(() => parseAiJson('sorry, I cannot help with that')).toThrow(/did not contain valid JSON/i)
  })

  test('truncated JSON without a closing brace reports missing JSON', () => {
    expect(() => parseAiJson('{"a": [1, 2,')).toThrow(/did not contain valid JSON/i)
  })

  test('malformed JSON inside braces reports parse failure', () => {
    expect(() => parseAiJson('{"a": [1,}')).toThrow(/parse failed/i)
  })
})

describe('tryParseAiJson', () => {
  test('returns the parsed value on success', () => {
    expect(tryParseAiJson('```json\n{"ok":true}\n```')).toEqual({ ok: true })
  })

  test('returns null instead of throwing on any failure', () => {
    expect(tryParseAiJson('')).toBe(null)
    expect(tryParseAiJson('no json here')).toBe(null)
    expect(tryParseAiJson('{"truncated":')).toBe(null)
  })
})
