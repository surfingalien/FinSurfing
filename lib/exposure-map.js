'use strict'
/**
 * lib/exposure-map.js — turning "who does business with X" into a ranked,
 * checkable list of LISTED tickers.
 *
 * THE PROBLEM THIS EXISTS TO SOLVE. Ask any model for "SpaceX's suppliers" and
 * it will produce a confident list that is mostly right, partly stale, and
 * partly invented — and the invented rows look exactly like the real ones. For
 * a research product that is worse than no list at all, because a fabricated
 * supply-chain link is indistinguishable from a researched one at the point of
 * use.
 *
 * So the division of labour here is the same one the rest of this repo uses
 * (strategy-lab, strategy-dsl, brain-evolution): the model PROPOSES, and
 * deterministic code JUDGES. Concretely:
 *
 *   - Candidates come from EDGAR, not from the model (lib/edgar-search.js).
 *   - The model only ever sees text windows retrieved from a real filing, and
 *     its job is narrow: classify the RELATIONSHIP and quote the sentence.
 *   - verifyFinding() then checks that quote back against the source text
 *     character-for-character. A quote that is not literally present means the
 *     finding is discarded — not softened, not flagged, discarded. This is the
 *     analogue of validateRule() in strategy-dsl.js: an allow-list boundary the
 *     model cannot talk its way past.
 *   - scoreEdge() ranks what survives from MEASURED facts (form type, recency,
 *     corroboration, disclosed revenue %), never from model confidence.
 *
 * The output is a universe, not a verdict. Ranked tickers feed the existing
 * research stack (ai-brain scan -> factor model -> expected-value gate ->
 * kelly sizing); nothing here decides what to buy.
 *
 * Pure functions, no I/O, no deps. Tests: tests/exposure-map.test.js
 */

/**
 * Relationship types, and what each one means for the reader.
 *
 * `weight` is the multiplier applied to an edge's evidence score. It encodes
 * how much a confirmed edge of this type tells you about economic exposure —
 * a named supplier's revenue genuinely depends on the anchor; a competitor's
 * does not, though the mention is still worth keeping.
 */
const RELATIONS = {
  supplier:   { weight: 1.00, desc: 'sells goods/services TO the anchor — revenue depends on it' },
  customer:   { weight: 0.85, desc: 'buys FROM the anchor — demand-side exposure' },
  partner:    { weight: 0.70, desc: 'joint venture, reseller or co-development' },
  holder:     { weight: 0.65, desc: 'listed fund/BDC holding equity in the anchor' },
  peer:       { weight: 0.45, desc: 'same industry classification, no stated relationship' },
  competitor: { weight: 0.40, desc: 'names the anchor as competition — inverse exposure' },
}
const RELATION_NAMES = Object.keys(RELATIONS)

/**
 * Evidence weight by filing form.
 *
 * A 10-K/20-F is audited, annual, and the place a material customer MUST be
 * named — the strongest evidence available. An 8-K/6-K is a dated event
 * (a contract award), strong but narrow. A 10-Q mention is real but lighter.
 * `peer_sic` is not a filing at all: it is the SEC's own industry code, which
 * is a fact about classification rather than about a business relationship,
 * and is scored accordingly.
 */
const FORM_WEIGHT = {
  '10-K': 1.00, '20-F': 1.00, '40-F': 1.00,
  '8-K':  0.80, '6-K':  0.80,
  '10-Q': 0.70,
  // Both EDGAR spellings of each fund form. Getting this wrong is not a
  // rounding error: at the DEFAULT_FORM_WEIGHT below, a fund holding scores
  // 0.65 x 0.50 x 75 = 24 against a floor of 25, so an unlisted spelling
  // deletes the entire fund-holding path without ever raising an error.
  'NPORT-P': 0.90, 'N-PORT': 0.90,
  'N-CSR':   0.85, 'N-CSRS': 0.85,
  // Industry classification is not weak EVIDENCE — the classification is a
  // fact, and a certain one. What is weak is the KIND of claim it supports,
  // and RELATIONS.peer already prices that in. Weighting it low here as well
  // double-penalises it, and at 0.50 no peer edge could clear MIN_EDGE_SCORE
  // at all, which silently deleted an entire discovery path.
  'peer_sic': 0.80,
}
const DEFAULT_FORM_WEIGHT = 0.5

/** Below this score an edge is noise — a passing mention, not exposure. */
const MIN_EDGE_SCORE = 25

/** Filings older than this contribute little: relationships churn. */
const STALE_DAYS = 730

/** How much source text a deterministically-sliced holding quote carries. */
const HOLDING_QUOTE_CHARS = 320
/** How far past a holding's name a stated percentage may sit to count as its own. */
const MATERIALITY_LOOKAHEAD = 120

// ── Hallucination gate ───────────────────────────────────────────────────────

/** Collapse whitespace/quote variants so verification survives HTML mangling. */
function normalizeForMatch(s) {
  return String(s || '')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Verify one model-produced finding against the text it was supposedly read
 * from. This is the single most important function in the module.
 *
 * A finding survives only if ALL of these hold:
 *   1. the relation is one of RELATIONS (unknown types are not coerced)
 *   2. the quote is long enough to be a real sentence, not a fragment that
 *      would trivially appear in any document
 *   3. the quote appears VERBATIM in the source window (whitespace/quote-mark
 *      normalisation only — no fuzzy matching, no "close enough")
 *   4. the quote actually mentions the anchor, so a real sentence lifted from
 *      elsewhere in the filing cannot be passed off as evidence of a link
 *
 * @returns {{ok:true, finding:object} | {ok:false, reason:string}}
 */
function verifyFinding(finding, sourceText, { anchorAliases = [], minQuoteChars = 40 } = {}) {
  if (!finding || typeof finding !== 'object') return { ok: false, reason: 'not an object' }

  const relation = String(finding.relation || '').toLowerCase().trim()
  if (!RELATION_NAMES.includes(relation))
    return { ok: false, reason: `unknown relation: ${finding.relation}` }

  const quote = String(finding.quote || '').trim()
  if (quote.length < minQuoteChars)
    return { ok: false, reason: `quote too short (${quote.length} < ${minQuoteChars} chars)` }

  const haystack = normalizeForMatch(sourceText)
  const needle   = normalizeForMatch(quote)
  if (!needle || !haystack.includes(needle))
    return { ok: false, reason: 'quote not found verbatim in source filing text' }

  // A quote can be genuine text from the filing and still not be about the
  // anchor. Requiring the anchor inside the quote is what makes it evidence
  // of a RELATIONSHIP rather than evidence the model read the document.
  if (anchorAliases.length) {
    const mentions = anchorAliases.some(a => needle.includes(normalizeForMatch(a)))
    if (!mentions) return { ok: false, reason: 'quote does not mention the anchor' }
  }

  // materialityPct is optional; when present it must be a plausible share of
  // revenue. An out-of-range number is dropped rather than failing the finding
  // — the relationship can be real even if the model garbled the percentage.
  let materialityPct = null
  const raw = Number(finding.materialityPct)
  if (Number.isFinite(raw) && raw > 0 && raw <= 100) materialityPct = +raw.toFixed(1)

  return {
    ok: true,
    finding: {
      relation,
      materialityPct,
      quote,
      note: typeof finding.note === 'string' ? finding.note.slice(0, 300) : null,
    },
  }
}

/**
 * Pull holding evidence out of a fund filing WITHOUT a model.
 *
 * A schedule of investments is not prose: it is a table that already states the
 * relationship. "Fund F holds N shares of company C, X% of net assets" is the
 * disclosure — there is nothing for a model to classify, and asking one to
 * would add a hallucination surface to a fact that is already machine-readable.
 * So this slices the quote directly OUT of the source text, which makes it
 * verbatim by construction rather than by verification. (verifyFinding is still
 * run over the result by the caller, so the feature keeps exactly one
 * definition of what counts as evidence — it simply never fires on this path.)
 *
 * @returns {{quote:string, materialityPct:number|null, alias:string}|null}
 */
function extractHoldingEvidence(sourceText, aliases = [], { quoteChars = HOLDING_QUOTE_CHARS, minChars = 40 } = {}) {
  const text = String(sourceText || '')
  if (!text) return null

  // Longest alias first. A schedule of investments lists legal names, so
  // "Space Exploration Technologies Corp" is a far better anchor than "SpaceX"
  // — and matching the longer one also puts the row's numbers inside reach.
  const ordered = (aliases || []).filter(Boolean).map(String).sort((a, b) => b.length - a.length)
  const lower = text.toLowerCase()
  let idx = -1
  let hit = null
  for (const a of ordered) {
    const i = lower.indexOf(a.toLowerCase())
    if (i !== -1) { idx = i; hit = a; break }
  }
  if (idx === -1) return null

  const pad = Math.max(0, Math.floor((quoteChars - hit.length) / 2))
  let start = Math.max(0, idx - pad)
  let end   = Math.min(text.length, idx + hit.length + pad)
  // Never cut a word in half: the quote is shown to a reader as the evidence,
  // and a fragment starting mid-word reads as a parsing bug rather than as a
  // disclosure. Both adjustments are clamped so the mention itself stays in.
  if (start > 0) {
    const s = text.indexOf(' ', start)
    if (s !== -1 && s < idx) start = s + 1
  }
  if (end < text.length) {
    const e = text.lastIndexOf(' ', end)
    if (e > idx + hit.length) end = e
  }

  const quote = text.slice(start, end).trim()
  if (quote.length < minChars) return null

  // Percentage of net assets, when the row states one. ONLY a number carrying
  // an explicit % sign, and only just behind the mention where a schedule row
  // prints it. A bare number in an N-PORT XML dump could be a share count, a
  // dollar value or part of a CUSIP, and guessing which would put an invented
  // percentage on the card — the one outcome this whole feature exists to
  // prevent.
  let materialityPct = null
  const tail = text.slice(idx + hit.length, idx + hit.length + MATERIALITY_LOOKAHEAD)
  const m = tail.match(/(\d{1,3}(?:\.\d+)?)\s*%/)
  if (m) {
    const v = Number(m[1])
    if (v > 0 && v <= 100) materialityPct = +v.toFixed(1)
  }

  return { quote, materialityPct, alias: hit }
}

// ── Scoring ──────────────────────────────────────────────────────────────────

/** Linear decay from 1.0 (today) to 0.35 at STALE_DAYS, floored there. */
function recencyFactor(filedAt, now = Date.now()) {
  const t = new Date(filedAt).getTime()
  if (!Number.isFinite(t)) return 0.5
  const days = Math.max(0, (now - t) / 86_400_000)
  if (days >= STALE_DAYS) return 0.35
  return 1 - (days / STALE_DAYS) * 0.65
}

/**
 * Score one edge 0-100 from measured facts only.
 *
 *   base       relation weight x form weight x recency
 *   corroborat +8 per additional independent filing saying the same thing,
 *              capped — three filings agreeing is meaningfully stronger than
 *              one, ten is not meaningfully stronger than three
 *   materialit +up to 25 when the filing states a revenue percentage. This is
 *              the difference between "mentions the anchor" and "the anchor is
 *              34% of this company's revenue", and it is the single most
 *              decision-relevant fact an edge can carry.
 */
function scoreEdge({ relation, form, filedAt, corroboratingFilings = 1, materialityPct = null }, now = Date.now()) {
  const rel  = RELATIONS[relation]?.weight ?? 0.3
  const frm  = FORM_WEIGHT[form] ?? DEFAULT_FORM_WEIGHT
  const rec  = recencyFactor(filedAt, now)

  // 75 is chosen so the weakest edge worth showing still clears MIN_EDGE_SCORE:
  // a fresh competitor mention in a 10-K lands at 30 and a same-industry peer
  // at 27, while a two-year-old passing mention in a 10-Q falls to ~7 and is
  // dropped. At the previous 60 the ceiling for a competitor edge was 24 —
  // below the floor — so no competitor could ever be surfaced regardless of
  // how recent or well-sourced the disclosure was.
  const base = rel * frm * rec * 75
  const corr = Math.min(Math.max(corroboratingFilings - 1, 0), 3) * 8
  const mat  = materialityPct != null ? Math.min(materialityPct / 40, 1) * 25 : 0

  return Math.max(0, Math.min(100, Math.round(base + corr + mat)))
}

/** True when an edge clears the noise floor and is worth showing. */
function isActionable(edge, minScore = MIN_EDGE_SCORE) {
  return !!edge && edge.score >= minScore
}

// ── Graph assembly ───────────────────────────────────────────────────────────

/**
 * Fold verified findings into one edge per (anchor, symbol, relation).
 *
 * The same relationship usually shows up in several filings. Collapsing them
 * keeps one row per relationship while counting the corroboration, and keeps
 * the STRONGEST evidence as the quote shown to the reader — the disclosure
 * that states a revenue percentage beats the one that merely names the anchor.
 */
function buildEdges(anchor, findings, { now = Date.now(), minScore = MIN_EDGE_SCORE } = {}) {
  const byKey = new Map()

  for (const f of findings || []) {
    if (!f?.symbol || !f?.relation) continue
    const key = `${f.symbol.toUpperCase()}::${f.relation}`
    const prev = byKey.get(key)
    if (prev) {
      prev.corroboratingFilings++
      // Prefer the evidence carrying a stated revenue share, then the newer one.
      const better = (f.materialityPct != null && prev.materialityPct == null)
        || (new Date(f.filedAt) > new Date(prev.evidence.filedAt) && prev.materialityPct == null)
      if (better) {
        prev.materialityPct = f.materialityPct ?? prev.materialityPct
        prev.evidence = { quote: f.quote, form: f.form, filedAt: f.filedAt, url: f.url, verified: true }
      }
      continue
    }
    byKey.set(key, {
      anchor,
      symbol: f.symbol.toUpperCase(),
      cik: f.cik ?? null,
      company: f.company ?? null,
      relation: f.relation,
      materialityPct: f.materialityPct ?? null,
      corroboratingFilings: 1,
      evidence: { quote: f.quote, form: f.form, filedAt: f.filedAt, url: f.url, verified: true },
      discovery: f.discovery ?? 'filing_search',
    })
  }

  return [...byKey.values()]
    .map(e => ({ ...e, score: scoreEdge({ ...e, form: e.evidence.form, filedAt: e.evidence.filedAt }, now) }))
    .filter(e => isActionable(e, minScore))
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))
}

/**
 * The ranked ticker list to hand the research stack.
 *
 * Competitors are excluded by default: their exposure to the anchor is inverse,
 * so mixing them into a "who benefits from the anchor" universe would quietly
 * add shorts to a long screen.
 */
function toUniverse(edges, { limit = 25, exclude = ['competitor'] } = {}) {
  const seen = new Set()
  const out = []
  for (const e of edges || []) {
    if (exclude.includes(e.relation)) continue
    const sym = e.symbol.toUpperCase()
    if (seen.has(sym)) continue
    seen.add(sym)
    out.push(sym)
    if (out.length >= limit) break
  }
  return out
}

/** Compact prompt block; '' when there is nothing evidenced to say. */
function exposureBlock(anchor, edges, { limit = 12 } = {}) {
  const rows = (edges || []).slice(0, limit)
  if (!rows.length) return ''
  const lines = rows.map(e => {
    const mat = e.materialityPct != null ? ` ${e.materialityPct}% of revenue,` : ''
    return `  ${e.symbol} — ${e.relation} (score ${e.score},${mat} ${e.evidence.form} ${e.evidence.filedAt})`
  })
  return `LISTED COMPANIES WITH DISCLOSED EXPOSURE TO ${anchor} (from SEC filings, quotes verified):\n${lines.join('\n')}`
}

// ── Prompt construction ──────────────────────────────────────────────────────

/**
 * Build the classification prompt for one candidate company.
 *
 * The model is given ONLY windows retrieved from that company's real filing,
 * and is told plainly that its quotes will be checked back against the source.
 * That is not a politeness — verifyFinding() enforces it, and a model that
 * knows the check exists produces quotes it can actually find rather than
 * paraphrases.
 *
 * It is asked for the RELATION and the QUOTE, and nothing else. It is not asked
 * whether the stock is a buy, how strong the relationship is, or what the score
 * should be: those are computed here from measured facts, so there is no room
 * for a confident-sounding number that nothing backs.
 */
function buildClassifyPrompt({ anchorLabel, candidateSymbol, candidateCompany, windows }) {
  const { wrapUntrusted } = require('./untrusted')
  // Filing text is third-party prose. A company that wants to be read as a
  // supplier can write the sentence that says so — and this model's whole job
  // is to decide what relationship the text establishes.
  const passages = (windows || [])
    .map((w, i) => `[PASSAGE ${i + 1}]\n${wrapUntrusted(
      typeof w === 'string' ? w : w.text,
      `filing:${candidateSymbol}`,
      { label: 'SEC filing excerpt' })}`)
    .join('\n\n')

  return `You are reading excerpts from ${candidateCompany || candidateSymbol}'s SEC filing.
${require('./untrusted').UNTRUSTED_POLICY}
Every excerpt below contains a mention of ${anchorLabel}.

Your ONLY task: determine what business relationship, if any, these passages
establish between ${candidateSymbol} and ${anchorLabel}.

Relationship types (choose exactly one):
${RELATION_NAMES.map(r => `  ${r} — ${RELATIONS[r].desc}`).join('\n')}

Rules:
- Quote VERBATIM from a passage. Your quote is checked character-for-character
  against the source text; a quote that is not literally present is discarded,
  and so is the finding attached to it. Do not paraphrase, correct, tidy or
  join fragments from different passages.
- The quote must itself mention ${anchorLabel}. A true sentence about something
  else is not evidence of a relationship.
- If the passages establish no business relationship (a passing reference, an
  industry-trend aside, a list of market participants), return relation "none".
- materialityPct: ONLY if the text states a percentage of revenue, customers or
  business attributable to ${anchorLabel}. Otherwise null. Never estimate it.

${passages}

Respond with ONLY this JSON, no markdown:
{"relation":"supplier|customer|partner|holder|peer|competitor|none","quote":"verbatim sentence from a passage above","materialityPct":number|null,"note":"one short clause on what the relationship is"}`
}

module.exports = {
  RELATIONS, RELATION_NAMES, FORM_WEIGHT, MIN_EDGE_SCORE, STALE_DAYS,
  HOLDING_QUOTE_CHARS, MATERIALITY_LOOKAHEAD,
  buildClassifyPrompt,
  normalizeForMatch, verifyFinding, extractHoldingEvidence,
  recencyFactor, scoreEdge, isActionable,
  buildEdges, toUniverse, exposureBlock,
}
