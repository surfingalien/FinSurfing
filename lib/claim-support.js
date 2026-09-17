'use strict'
/**
 * lib/claim-support.js — a citation must be supported by the evidence it cites.
 *
 * THE GAP THIS CLOSES. `routes/recommendations.js` asks the model to ground
 * every pick in the SPECIFIC data injected above it and to "NEVER invent
 * figures or sources". Server-side, the only thing enforced was the SHAPE:
 * non-empty strings, at most four. A citation reading "analyst target $210
 * (12×)" was kept verbatim whether or not $210 appeared anywhere in the block
 * the model was shown — and it is displayed to the user as evidence.
 *
 * Every other evidence surface in this repo already has a gate. Exposure edges
 * pass `exposure-map.js:verifyFinding()`, which discards a quote that is not
 * VERBATIM in the source. Strategy proposals pass `strategy-dsl.js:validateRule()`.
 * Advisory citations were the one surface where the model's word was final.
 *
 * WHAT THIS CHECKS, and what it deliberately does not. This is the mechanical
 * tier only — no model call, no semantics. It answers one question: does the
 * figure or phrasing in this citation actually occur in the data we injected?
 * It cannot tell you whether "RSI 28 — oversold" is a GOOD reason to buy. It
 * can tell you the RSI we showed the model was 51.
 *
 * Numbers are the load-bearing check, because a fabricated figure is both the
 * most common failure and the most damaging: a reader can sanity-check a vague
 * thesis but takes a stated number at face value.
 *
 * The rule is NUMBERS **OR** WORDING, never both. A citation that states a
 * figure passes on that figure alone, because the words around a verified
 * number are the model's interpretation of it — "fwdP/E 31.2 below peers" is
 * honest analysis even though "below peers" appears nowhere in the data. A
 * citation that states NO figure has nothing else to check, so its wording must
 * be grounded. Requiring both would reject good analysis, and a gate that cries
 * wolf is one everybody learns to ignore.
 *
 * ROUNDING IS NOT FABRICATION. A cited number matches when some evidence number
 * rounds to it AT THE PRECISION IT WAS CITED TO. Evidence "$209.87" supports a
 * citation of "$210" (209.87 rounds to 210) but not "$212". That is stricter
 * than a percentage tolerance — at 1%, "$212" would pass against "$209.87" —
 * and it never punishes the model for writing a price the way a human would.
 *
 * KNOWN LIMITATION, stated rather than hidden: verification runs against the
 * whole injected block, so a figure belonging to a DIFFERENT symbol in the same
 * block can satisfy a citation. Scoping per symbol would catch that, at the cost
 * of false rejections on evidence that never names the symbol (macro, regime).
 * The dominant failure mode is invention, not mis-attribution, so this trades
 * the rarer miss for zero false rejections.
 *
 * Pure functions, no I/O, no deps. Tests: tests/claim-support.test.js
 */

/** Minimum share of a citation's content words that must occur in the evidence. */
const MIN_TOKEN_COVERAGE = 0.6
/** Citations shorter than this carry too little to verify either way. */
const MIN_CONTENT_TOKENS = 2

/**
 * Digit-bearing tokens that are NAMES, not quantities. "10-K" is a form, "Q3"
 * is a period, "FY26" is a fiscal year — reading them as the numbers 10, 3 and
 * 26 would demand those figures appear in the evidence and reject honest
 * citations wholesale.
 */
const NON_QUANTITY = /\b(?:\d{1,2}-[a-z]{1,2}|q[1-4]|fy\s?\d{2,4}|[a-z]+\d+|s-\d|\d{1,2}[a-z]{2})\b/gi

/** A number as it appears in prose: $1,234.56 · 14.2% · 12× · -3.5 */
const NUMBER_TOKEN = /-?\d[\d,]*(?:\.\d+)?/g

const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'as', 'at',
  'by', 'with', 'from', 'is', 'are', 'was', 'were', 'be', 'its', 'it', 'this',
  'that', 'has', 'have', 'had', 'will', 'per', 'vs', 'than', 'into', 'over',
])

// ── Extraction ───────────────────────────────────────────────────────────────

const normalize = (s) => String(s || '')
  .toLowerCase()
  .replace(/[‘’‚‛′]/g, "'")
  .replace(/[“”„‟″]/g, '"')
  .replace(/[‐-―−]/g, '-')
  .replace(/\s+/g, ' ')
  .trim()

/**
 * Quantities stated in a string, as {value, decimals}.
 *
 * `decimals` is the precision the number was WRITTEN to, which is what decides
 * whether an evidence figure rounds to it.
 */
function extractNumbers(text) {
  const cleaned = normalize(text).replace(NON_QUANTITY, ' ')
  const out = []
  for (const raw of cleaned.match(NUMBER_TOKEN) || []) {
    const bare = raw.replace(/,/g, '')
    const value = Number(bare)
    if (!Number.isFinite(value)) continue
    const dot = bare.indexOf('.')
    out.push({ value, decimals: dot === -1 ? 0 : bare.length - dot - 1, raw })
  }
  return out
}

/** Content words of a string, stopwords and bare quantities removed. */
function contentTokens(text) {
  return normalize(text)
    .replace(/[^a-z0-9%$.\s-]/g, ' ')
    .split(/\s+/)
    .map(t => t.replace(/^[-.]+|[-.]+$/g, ''))
    .filter(t => t.length > 1 && !STOPWORDS.has(t) && !/^-?[\d,.]+%?$/.test(t))
}

const roundTo = (v, d) => {
  const f = 10 ** d
  return Math.round(v * f) / f
}

/**
 * Does some evidence number round to `cited` at the precision it was written to?
 * Sign-sensitive: a -3.5% drawdown does not support a +3.5% gain.
 */
function numberSupported(cited, evidenceNumbers) {
  return evidenceNumbers.some(e =>
    Math.abs(roundTo(e.value, cited.decimals) - cited.value) < Number.EPSILON * 100 ||
    // Also accept an exact match at full precision, for evidence written to
    // FEWER decimals than the citation ("14" supporting "14.0").
    Math.abs(e.value - cited.value) < 1e-9
  )
}

// ── The gate ─────────────────────────────────────────────────────────────────

/**
 * Verify one citation against the evidence block it claims to come from.
 *
 * @returns {{verdict:string, ok:boolean, reason:string, missing?:string[]}}
 *   supported          — figures and phrasing occur in the evidence
 *   fabricated-number  — carries a figure the evidence never states
 *   unsupported        — too little of its wording occurs in the evidence
 *   too-short          — nothing substantive to verify
 *   unverifiable       — no evidence was injected; the gate stays inert
 */
function verifyCitation(citation, evidence, { minCoverage = MIN_TOKEN_COVERAGE } = {}) {
  const text = String(citation || '').trim()
  if (!text) return { verdict: 'too-short', ok: false, reason: 'empty citation' }

  const ev = String(evidence || '')
  // No evidence means nothing was injected for this run. Rejecting everything
  // here would make the gate fire hardest exactly when it knows least.
  if (!ev.trim()) return { verdict: 'unverifiable', ok: true, reason: 'no evidence block supplied' }

  const evNorm = normalize(ev)
  const evNumbers = extractNumbers(ev)

  // 1. Figures. The strongest signal, and the one worth being strict about.
  const cited = extractNumbers(text)
  const missing = cited.filter(c => !numberSupported(c, evNumbers)).map(c => c.raw)
  if (missing.length) {
    return {
      verdict: 'fabricated-number',
      ok: false,
      reason: `figure${missing.length > 1 ? 's' : ''} not present in the injected evidence: ${missing.join(', ')}`,
      missing,
    }
  }

  // Every figure checked out. That is sufficient on its own: the citation is
  // anchored to data we actually injected, and the words around a verified
  // figure are the model's INTERPRETATION of it ("31.2 below peers"). Demanding
  // the interpretation also appear verbatim would reject honest analysis and
  // teach everyone to ignore the gate — the one thing a gate must never become.
  if (cited.length) {
    return { verdict: 'supported', ok: true, reason: `${cited.length} figure${cited.length > 1 ? 's' : ''} verified` }
  }

  // 2. Wording, for citations that state no figure at all. Here there is
  //    nothing else to check, so the words themselves have to be grounded —
  //    otherwise any assertion whatsoever would pass.
  const tokens = contentTokens(text)
  if (tokens.length < MIN_CONTENT_TOKENS) {
    return { verdict: 'too-short', ok: false, reason: 'no verifiable content' }
  }

  const found = tokens.filter(t => evNorm.includes(t))
  const coverage = found.length / tokens.length
  if (coverage < minCoverage) {
    return {
      verdict: 'unsupported',
      ok: false,
      reason: `only ${Math.round(coverage * 100)}% of its wording appears in the evidence (needs ${Math.round(minCoverage * 100)}%)`,
      missing: tokens.filter(t => !evNorm.includes(t)),
    }
  }

  return { verdict: 'supported', ok: true, reason: `${Math.round(coverage * 100)}% wording match` }
}

/**
 * Audit a pick's citation list.
 *
 * Unsupported citations are DROPPED rather than flagged: they are rendered to
 * the user as evidence, and evidence that failed its own check is worse than no
 * evidence. The pick survives — a weak citation is not proof the thesis is
 * wrong — and every rejection is reported with its reason, the same contract
 * `edgeGate.rejected` already uses in this route.
 *
 * @returns {{kept:string[], rejected:Array, checked:number, allRejected:boolean}}
 */
function auditSources(sources, evidence, opts = {}) {
  const rows = (Array.isArray(sources) ? sources : []).filter(s => typeof s === 'string' && s.trim())
  const kept = []
  const rejected = []
  for (const s of rows) {
    const r = verifyCitation(s, evidence, opts)
    if (r.ok) kept.push(s)
    else rejected.push({ source: s, verdict: r.verdict, reason: r.reason })
  }
  return {
    kept,
    rejected,
    checked: rows.length,
    // Every citation failing is itself a signal — the pick is asserting
    // grounding it does not have.
    allRejected: rows.length > 0 && kept.length === 0,
  }
}

/** Roll per-pick audits into one report for the response. */
function summarizeAudits(audits) {
  const rows = audits || []
  const rejected = rows.flatMap(a => (a.rejected || []).map(r => ({ symbol: a.symbol, ...r })))
  return {
    picksAudited: rows.length,
    citationsChecked: rows.reduce((n, a) => n + (a.checked || 0), 0),
    citationsDropped: rejected.length,
    ungroundedPicks: rows.filter(a => a.allRejected).map(a => a.symbol),
    rejected: rejected.slice(0, 40),
  }
}

module.exports = {
  MIN_TOKEN_COVERAGE, MIN_CONTENT_TOKENS,
  extractNumbers, contentTokens, numberSupported,
  verifyCitation, auditSources, summarizeAudits,
}
