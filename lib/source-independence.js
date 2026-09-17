'use strict'
/**
 * lib/source-independence.js — syndication must not multiply consensus.
 *
 * THE BUG THIS EXISTS TO FIX. Every provider in routes/sentiment.js averages
 * per-article sentiment and reports `headline_count` as the number of articles
 * it saw. A wire story republished by five outlets is ONE story wearing five
 * outfits: it contributes five identical scores to the mean and inflates the
 * headline count fivefold. The mean looks unmoved — until the sixth article is
 * an independent piece pointing the other way, at which point one press release
 * outvotes it 5:1. Downstream, `sentimentScore` feeds the AI Brain prompt, the
 * picks it produces feed `lib/brain-learnings.js`, and the calibration layer
 * ends up measuring confidence that was never there.
 *
 * So: cluster derivative copies, give each CLUSTER one vote, and report how
 * many independent stories actually exist.
 *
 * Four signals, strongest first:
 *   url    — identical canonical URL (scheme/www/trailing-slash/tracking stripped)
 *   wire   — wire-service boilerplate (PR Newswire, Business Wire, …) plus a
 *            fingerprint of the text that follows it
 *   title  — near-duplicate normalized headline
 *   body   — near-duplicate body/summary text, when the provider gives one
 *
 * TWO DELIBERATE DEPARTURES from the prior art this is modelled on
 * (hyperresearch's core/independence.py), both because this is finance news
 * rather than a general research corpus:
 *
 *  1. TITLE IS A FIRST-CLASS SIGNAL. That implementation keys syndication on
 *     the body head and explicitly NOT on the title, because outlets retitle
 *     wire copy. True — but our providers return headlines and one-line
 *     summaries, not article bodies, so a body-only rule would cluster almost
 *     nothing. We use both and let the union find whichever fires.
 *
 *  2. A CLUSTER SUMS TO EXACTLY 1.0. That implementation gives the cluster root
 *     1.0 AND each of the n−1 members 1/n, which totals ~1.8 for a cluster of
 *     five — not the "five copies argue with the weight of one source" its own
 *     docs claim. Here every member gets 1/n, so a cluster contributes exactly
 *     one vote and `independentCount` is a true count of distinct stories.
 *
 * POLARITY GUARD (the one that matters most here). "Apple Q3 earnings beat" and
 * "Apple Q3 earnings miss" share four of five tokens — a naive title-similarity
 * rule merges them and silently deletes half of a genuine disagreement. Two
 * articles whose sentiment points in OPPOSITE directions are never the same
 * story, so `polarity` blocks the union no matter how similar the text is.
 *
 * Pure functions, no I/O, no deps. Tests: tests/source-independence.test.js
 */

/** Text that only ever appears because a story came off a wire. */
const WIRE_MARKERS = [
  'prnewswire', 'pr newswire', 'business wire', 'businesswire',
  'globe newswire', 'globenewswire', 'accesswire', 'newsfile corp',
  'associated press', '(reuters)', '(ap)', 'ein presswire', 'newsdirect',
  'cision', 'marketwired',
]

/** Query params that identify the referrer, never the article. */
const TRACKING_PARAM = /^(utm_|fbclid|gclid|mc_cid|mc_eid|ref$|source$|src$|partner$|yptr$)/i

/**
 * Headline-similarity floor. High on purpose: headlines are short, so two
 * unrelated stories about the same company share tokens easily. Paired with
 * MIN_TITLE_TOKENS and the polarity guard, this is the conservative corner —
 * we would rather under-cluster (and over-count independence) than merge two
 * genuinely different stories and delete a disagreement.
 */
const TITLE_JACCARD = 0.85
const MIN_TITLE_TOKENS = 4
/** Bodies are long enough that a lower bar is still safe. */
const BODY_JACCARD = 0.7
const SHINGLE_SIZE = 5

/** Tokens that carry no topical information in a headline. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'as', 'at',
  'by', 'with', 'from', 'is', 'are', 'was', 'were', 'be', 'its', 'it', 'this',
  'that', 'after', 'over', 'amid', 'says', 'say', 'said', 'has', 'have', 'will',
  'new', 'more', 'than', 'about', 'into', 'out', 'up', 'down',
])

// ── Normalisation ────────────────────────────────────────────────────────────

/**
 * Collapse a URL so syndication mirrors and re-shares land on the same key.
 * Returns '' for anything unparseable — an empty key never clusters.
 */
function canonicalUrl(url) {
  const raw = String(url || '').trim()
  if (!raw) return ''
  let u
  try {
    u = new URL(raw.includes('://') ? raw : `https://${raw}`)
  } catch { return '' }
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const path = u.pathname.replace(/\/+$/, '').toLowerCase()
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAM.test(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  return `${host}${path}${params ? `?${params}` : ''}`
}

/**
 * Strip the outlet attribution outlets append to syndicated headlines
 * ("… - Reuters", "… | Bloomberg", "… — CNBC") and reduce to comparable text.
 */
function normalizeTitle(title) {
  return String(title || '')
    .replace(/\s+[-–—|]\s+[^-–—|]{2,30}$/u, '')   // trailing " - Outlet Name"
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[^a-z0-9$%.\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Content tokens of a headline, stopwords removed.
 *
 * Single-character tokens are dropped EXCEPT digits: in a financial headline
 * the figure is often the only thing distinguishing two otherwise identical
 * sentences ("raises guidance to $5" / "to $9"), and dropping it merges a
 * revision with the thing it revised.
 */
function titleTokens(title) {
  return new Set(
    normalizeTitle(title)
      .split(' ')
      .filter(t => (t.length > 1 || /\d/.test(t)) && !STOPWORDS.has(t))
  )
}

/** Overlapping word n-grams — the unit body similarity is measured in. */
function shingle(text, n = SHINGLE_SIZE) {
  const words = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  const out = new Set()
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '))
  return out
}

/** |A ∩ B| / |A ∪ B|. 0 when either side is empty. */
function jaccard(a, b) {
  if (!a?.size || !b?.size) return 0
  let inter = 0
  for (const v of a) if (b.has(v)) inter++
  return inter / (a.size + b.size - inter)
}

/**
 * Wire fingerprint: the marker plus the first content tokens that follow it.
 *
 * Keyed on the TEXT rather than the headline, because the one thing outlets
 * reliably do not rewrite is the body of the release they pasted.
 * Returns null when nothing identifies the text as wire copy.
 */
function wireSignature(text) {
  const head = String(text || '').slice(0, 1500).toLowerCase()
  if (!head) return null
  const marker = WIRE_MARKERS.find(m => head.includes(m))
  if (!marker) return null
  const tokens = (head.match(/[a-z0-9]{4,}/g) || [])
    .filter(t => !STOPWORDS.has(t))
    .slice(0, 12)
  if (tokens.length < 4) return null
  return `${marker}|${tokens.join(' ')}`
}

// ── Clustering ───────────────────────────────────────────────────────────────

/** Sign of an article's sentiment: 1, -1, or 0 when unknown/neutral. */
function polarityOf(article) {
  const p = article?.polarity
  if (typeof p !== 'number' || !Number.isFinite(p)) return 0
  if (p > 0) return 1
  if (p < 0) return -1
  return 0
}

/**
 * Cluster derivative articles and weight them so each distinct story votes once.
 *
 * @param {Array<{title?, url?, body?, publishedAt?, polarity?}>} articles
 * @returns {{weights:number[], clusters:Array, independentCount:number, total:number}}
 *          `weights` is aligned to the input array; a cluster of n gives each
 *          member 1/n, so the weights sum to the number of distinct stories.
 */
function clusterArticles(articles, {
  titleThreshold = TITLE_JACCARD,
  bodyThreshold  = BODY_JACCARD,
} = {}) {
  const rows = Array.isArray(articles) ? articles : []
  const n = rows.length
  if (!n) return { weights: [], clusters: [], independentCount: 0, total: 0 }

  const parent = rows.map((_, i) => i)
  const kinds  = new Map()   // "i:j" -> signal that merged them

  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] }
    return x
  }
  const polarity = rows.map(polarityOf)
  /** Merge i and j unless their sentiment points opposite ways. */
  const union = (i, j, kind) => {
    // The guard that keeps a real disagreement from being deleted as a duplicate.
    if (polarity[i] !== 0 && polarity[j] !== 0 && polarity[i] !== polarity[j]) return false
    const a = find(i), b = find(j)
    kinds.set(`${Math.min(i, j)}:${Math.max(i, j)}`, kind)
    if (a === b) return false
    parent[b] = a
    return true
  }

  // 1. Same canonical URL.
  const byUrl = new Map()
  rows.forEach((r, i) => {
    const key = canonicalUrl(r.url)
    if (!key) return
    if (byUrl.has(key)) union(byUrl.get(key), i, 'url')
    else byUrl.set(key, i)
  })

  // 2. Same wire release. Checked against body first, headline as a fallback
  //    for providers that return no body at all.
  const byWire = new Map()
  rows.forEach((r, i) => {
    const sig = wireSignature(r.body) || wireSignature(r.title)
    if (!sig) return
    if (byWire.has(sig)) union(byWire.get(sig), i, 'wire')
    else byWire.set(sig, i)
  })

  // 3/4. Pairwise near-duplicate title and body. Quadratic, which is fine:
  //      a sentiment call carries tens of articles, not thousands.
  const tTokens = rows.map(r => titleTokens(r.title))
  const bShingles = rows.map(r => shingle(r.body))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (find(i) === find(j)) continue
      if (tTokens[i].size >= MIN_TITLE_TOKENS && tTokens[j].size >= MIN_TITLE_TOKENS &&
          jaccard(tTokens[i], tTokens[j]) >= titleThreshold) {
        union(i, j, 'title')
        continue
      }
      if (bShingles[i].size && bShingles[j].size &&
          jaccard(bShingles[i], bShingles[j]) >= bodyThreshold) {
        union(i, j, 'body')
      }
    }
  }

  // Materialise. The root is the EARLIEST published member — the upstream
  // original rather than whichever mirror the provider happened to return first.
  const groups = new Map()
  for (let i = 0; i < n; i++) {
    const root = find(i)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(i)
  }

  const weights = new Array(n).fill(1)
  const clusters = []
  const timeOf = (i) => {
    const t = new Date(rows[i].publishedAt ?? '').getTime()
    return Number.isFinite(t) ? t : Infinity   // undated members never win the root
  }

  for (const members of groups.values()) {
    if (members.length === 1) continue
    members.sort((a, b) => timeOf(a) - timeOf(b) || a - b)
    const share = 1 / members.length
    for (const i of members) weights[i] = share
    const kindSet = new Set()
    for (const a of members) for (const b of members) {
      const k = kinds.get(`${Math.min(a, b)}:${Math.max(a, b)}`)
      if (k) kindSet.add(k)
    }
    clusters.push({
      root: members[0],
      members: members.slice(1),
      size: members.length,
      kind: [...kindSet].sort().join('+') || 'mixed',
    })
  }

  const independentCount = weights.reduce((s, w) => s + w, 0)
  return {
    weights,
    clusters,
    independentCount: +independentCount.toFixed(4),
    total: n,
  }
}

/**
 * Sentiment for one symbol, with syndicated copies counted once.
 *
 * Returns the independence-weighted mean alongside the naive one so the
 * difference is visible rather than silently applied — `syndicated: true`
 * means the raw average was being driven by republished copy.
 */
function weightedSentiment(articles, { scoreOf = a => a.score } = {}) {
  const rows = (Array.isArray(articles) ? articles : []).filter(a => {
    const s = scoreOf(a)
    return typeof s === 'number' && Number.isFinite(s)
  })
  if (!rows.length) {
    return { mean: 0, rawMean: 0, independentCount: 0, total: 0, syndicated: false, clusters: [] }
  }

  const { weights, clusters, independentCount, total } = clusterArticles(rows)
  let num = 0, den = 0, rawSum = 0
  rows.forEach((a, i) => {
    const s = scoreOf(a)
    num += s * weights[i]
    den += weights[i]
    rawSum += s
  })

  // `clusters` indexes the FILTERED rows, not the caller's array, so exposing
  // raw indices here would hand every caller an off-by-N waiting to happen.
  // These are the resolved forms:
  //   representatives — one article per distinct story (cluster roots included)
  //   unsyndicated    — the stories that were NEVER republished
  // A caller showing a single headline wants `unsyndicated` first: a press
  // release is a real story, but it is the least informative thing to quote
  // when independent reporting on the same company exists.
  const suppressed = new Set(clusters.flatMap(c => c.members))
  const rootIds = new Set(clusters.map(c => c.root))
  const representatives = rows.filter((_, i) => !suppressed.has(i))
  const unsyndicated = rows.filter((_, i) => !suppressed.has(i) && !rootIds.has(i))

  return {
    mean: den > 0 ? num / den : 0,
    rawMean: rawSum / rows.length,
    independentCount,
    total,
    syndicated: clusters.length > 0,
    clusters,
    representatives,
    unsyndicated,
  }
}

module.exports = {
  WIRE_MARKERS, TITLE_JACCARD, BODY_JACCARD, MIN_TITLE_TOKENS, SHINGLE_SIZE,
  canonicalUrl, normalizeTitle, titleTokens, shingle, jaccard, wireSignature,
  clusterArticles, weightedSentiment,
}
