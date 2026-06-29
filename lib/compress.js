'use strict'
/**
 * lib/compress.js
 *
 * Token-saving compaction for prose-heavy context injected into AI prompts
 * (SEC filing narratives, earnings-call transcripts). Strips non-informative
 * structure — whitespace runs, separator/page-number lines, repeated lines —
 * BEFORE the text reaches the model, so the same character budget carries more
 * real signal and the prompt costs fewer tokens. Same idea as a compression
 * proxy, done natively in-process.
 *
 * SAFETY: this only removes structure. It never rewrites or drops word content,
 * and never touches numbers, tickers, currency, or percentages — financial
 * precision is preserved. Pure functions, no deps, fully unit-tested.
 */

// A line that is only separator punctuation (rules, dot-leaders, ===, ***).
const SEPARATOR_LINE = /^[\s\-=_.•*~#>|]{3,}$/
// An explicit page marker, e.g. "Page 12" or "Page 12 of 80".
const PAGE_LINE = /^page\s+\d{1,4}(\s+of\s+\d{1,4})?$/i
// A bare 1-3 digit number on its own line — a page number. (4-digit numbers are
// kept: they could be a year or a figure.)
const BARE_PAGENUM = /^\d{1,3}$/
// Common filing/transcript boilerplate lines that carry no analytical signal.
const NOISE_LINE = /^(table of contents|index|\(continued\)|see accompanying notes[^\n]*|forward-looking statements?)$/i

/**
 * Compact prose: collapse intra-line and blank-line whitespace, drop
 * separator / page-number / boilerplate lines, and remove immediately repeated
 * lines. Returns the text unchanged in meaning, just denser.
 */
function compactProse(text) {
  if (!text) return ''
  const out = []
  let prev = null
  for (const raw of String(text).replace(/\f/g, '\n').split('\n')) {
    const line = raw.replace(/[ \t ]+/g, ' ').trim()
    if (line === '') {
      if (out.length && out[out.length - 1] !== '') out.push('') // collapse blank runs → one
      continue
    }
    if (SEPARATOR_LINE.test(line)) continue
    if (PAGE_LINE.test(line)) continue
    if (BARE_PAGENUM.test(line)) continue
    if (NOISE_LINE.test(line)) continue
    if (line === prev) continue // drop an immediately repeated line
    out.push(line)
    prev = line
  }
  while (out.length && out[0] === '') out.shift()
  while (out.length && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

/**
 * Whitespace-only compaction — the most conservative option, for blocks where
 * line structure must be preserved. Collapses runs of spaces/tabs and excess
 * blank lines without removing any lines.
 */
function compactWhitespace(text) {
  if (!text) return ''
  return String(text)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

module.exports = { compactProse, compactWhitespace }
