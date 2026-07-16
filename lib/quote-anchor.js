'use strict'
/**
 * lib/quote-anchor.js — evidence verification for AI-generated analyst cards.
 *
 * The earnings-call analyst asks the model to attach the verbatim transcript
 * quote that triggered each bull/bear point. These helpers CHECK those quotes
 * against the real transcript (normalized substring match), so the UI can
 * distinguish evidence-backed points from unverified ones instead of
 * presenting both as equally grounded. Pure functions — no I/O, no AI.
 */

function normalizeForMatch(s) {
  return String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function quoteAppears(quote, normalizedTranscript) {
  const q = normalizeForMatch(quote)
  if (q.length < 12) return false // too short to be meaningful evidence
  return normalizedTranscript.includes(q)
}

/**
 * Normalizes model output (legacy string arrays or {point, quote} objects)
 * into [{ point, quote, anchored }], verifying each quote against the
 * transcript. Caps at 4 points, drops empties.
 */
function anchorPoints(rawPoints, normalizedTranscript) {
  if (!Array.isArray(rawPoints)) return []
  return rawPoints.slice(0, 4).map(p => {
    if (typeof p === 'string') return { point: p, quote: null, anchored: false }
    const point = String(p?.point || '').trim()
    const quote = String(p?.quote || '').trim() || null
    if (!point) return null
    return { point, quote, anchored: quote ? quoteAppears(quote, normalizedTranscript) : false }
  }).filter(Boolean)
}

module.exports = { normalizeForMatch, quoteAppears, anchorPoints }
