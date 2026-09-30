'use strict'
/**
 * routes/screener.js
 *
 * POST /api/screener/run   (requireAuth, heartbeated)
 *   body: { sector?, minMarketCap?, minYield?, limit?, weights?, explain? }
 * GET  /api/screener/sectors
 *
 * Broad fundamental discovery. Until now every discovery surface in this repo
 * ran over a hardcoded ~20-symbol list (routes/dividend.js:DEFAULT_UNIVERSE,
 * every ai-brain SCAN_UNIVERSES entry) while lib/symbol-db.js sat on 300k+
 * classified symbols. This searches broadly and ranks on measured fundamentals.
 *
 * Division of labour, as everywhere else in this repo: lib/fundamental-screen.js
 * does ALL the ranking from real numbers, and the LLM is handed the finished
 * ranking and asked only to EXPLAIN it. It cannot reorder, add or remove a
 * name — `explain` is annotation, and a pick with no explanation still ranks.
 *
 * Two stages, because a per-symbol fundamentals call over a broad universe is
 * not affordable:
 *   1. CANDIDATES — one bulk FMP stock-screener call (price, market cap, last
 *      annual dividend, sector, beta). Falls back to lib/symbol-db.js when FMP
 *      is unavailable, same shape as exposure-map falling back to peers.
 *   2. ENRICH — key-metrics-ttm + ratios-ttm for the top ENRICH_LIMIT
 *      candidates only, which is what supplies the profitability pillar.
 *
 * Heartbeated rather than queued (see CLAUDE.md): the work is bounded and the
 * result is cheap to reproduce, so it matches dividend/screen rather than the
 * AI Brain scan. Once heartbeating starts the status pins to 200, so CLIENTS
 * MUST CHECK data.error AS WELL AS res.ok.
 */

const express   = require('express')
const rateLimit = require('express-rate-limit')

const { requireAuth }        = require('../middleware/auth')
const { startJsonHeartbeat } = require('../lib/http-heartbeat')
const { getRouter }          = require('../lib/ai-router')
const symbolDb               = require('../lib/symbol-db')
const { rankCandidates, DEFAULT_WEIGHTS, looksLikeFraction } = require('../lib/fundamental-screen')

const router   = express.Router()
const aiRouter = getRouter('screener')

const fmp     = require('../lib/fmp')
const FMP_KEY = () => process.env.FMP_API_KEY || null

/** How many candidates get the expensive per-symbol enrichment. */
const ENRICH_LIMIT   = 40
/** How many candidates the bulk stage asks for before ranking trims them. */
const CANDIDATE_LIMIT = 250
const DEFAULT_MIN_CAP = 2_000_000_000
const CACHE_TTL       = 6 * 60 * 60 * 1000

const _cache = new Map()

const screenerLimit = rateLimit({
  windowMs: 60 * 1000, max: 6,
  message: { error: 'Too many screener runs — wait a minute' },
})

const num = (v) => {
  const x = parseFloat(v)
  return Number.isFinite(x) ? x : null
}

/** FMP returns ratios as decimals; every field this module hands to the
 *  scorer is percent-valued. This is the one place that conversion happens. */
const toPct = (v) => (num(v) == null ? null : +(num(v) * 100).toFixed(2))

/**
 * FMP renames TTM fields between plan tiers and API versions (and ships at
 * least one long-standing typo, `dividendYielTTM`). Try each spelling rather
 * than silently reading undefined and scoring the row as missing data.
 */
function pick(obj, ...names) {
  for (const n of names) {
    if (obj && obj[n] != null) return obj[n]
  }
  return null
}

/** Stage 1a — the bulk screener call. */
async function fmpCandidates({ sector, minMarketCap, minYield }, key) {
  const params = {
    marketCapMoreThan: minMarketCap,
    isActivelyTrading: true,
    isEtf:             false,
    limit:             CANDIDATE_LIMIT,
    sector:            sector || null,
  }
  // FMP signals plan/rate problems in the body; lib/fmp throws them, which
  // surfaces the reason instead of an empty screen.
  const rows = await fmp.screener(params, { key, timeoutMs: 15_000 })
  return rows
    .filter(r => r?.symbol && num(r.price) > 0)
    .map(r => {
      const price = num(r.price)
      const div   = num(r.lastAnnualDividend)
      return {
        symbol:        r.symbol,
        name:          r.companyName ?? null,
        sector:        r.sector ?? null,
        industry:      r.industry ?? null,
        price,
        marketCap:     num(r.marketCap),
        beta:          num(r.beta),
        exchange:      r.exchangeShortName ?? null,
        // Yield computed here from price + dividend rather than trusted from a
        // field, so it can never disagree with the two numbers beside it.
        dividendYield: div != null && div > 0 ? +((div / price) * 100).toFixed(2) : 0,
      }
    })
    .filter(r => minYield == null || r.dividendYield >= minYield)
}

/** Stage 1b — the keyless fallback when FMP is unavailable. */
function symbolDbCandidates({ sector }) {
  try {
    const universe = sector
      ? symbolDb.sectorUniverse(sector, { size: ENRICH_LIMIT, minCap: 'Mid Cap' })
      : []
    return universe.map(symbol => ({ symbol, name: null, sector: sector ?? null, dividendYield: null }))
  } catch { return [] }
}

/** Stage 2 — per-symbol fundamentals for the shortlist. */
async function enrich(rows, key) {
  const out = []
  await Promise.all(rows.map(async row => {
    try {
      // key-metrics-ttm + ratios-ttm, merged with both stable and legacy
      // field names — so every `pick` below finds its field on either object.
      const km  = await fmp.metricsTtm(row.symbol, { key, timeoutMs: 10_000 })
      const rat = km

      const dividendYield = row.dividendYield != null
        ? row.dividendYield
        : toPct(pick(km, 'dividendYieldTTM') ?? pick(rat, 'dividendYieldTTM', 'dividendYielTTM'))

      out.push({
        ...row,
        dividendYield,
        payoutRatio:     toPct(pick(rat, 'payoutRatioTTM', 'dividendPayoutRatioTTM')),
        fcfPayoutRatio:  fcfPayout(km, rat),
        debtToEquity:    toPct(pick(rat, 'debtEquityRatioTTM', 'debtToEquityTTM')),
        roe:             toPct(pick(km, 'roeTTM') ?? pick(rat, 'returnOnEquityTTM')),
        roic:            toPct(pick(km, 'roicTTM')),
        netMargin:       toPct(pick(rat, 'netProfitMarginTTM')),
        operatingMargin: toPct(pick(rat, 'operatingProfitMarginTTM')),
        fcfMargin:       toPct(pick(rat, 'freeCashFlowOperatingCashFlowRatioTTM')),
        fcfYield:        toPct(pick(km, 'freeCashFlowYieldTTM')),
      })
    } catch {
      // A symbol FMP cannot price is dropped, not scored from nothing.
    }
  }))
  return out
}

/**
 * Dividend as a share of free cash flow. Derived rather than read, because the
 * question "can it pay for this" is exactly what the raw payout ratio misses
 * when earnings and cash flow diverge.
 */
function fcfPayout(km, rat) {
  const perShareFcf = num(pick(km, 'freeCashFlowPerShareTTM'))
  const perShareDiv = num(pick(km, 'dividendPerShareTTM')) ?? num(pick(rat, 'dividendPerShareTTM'))
  if (perShareFcf == null || perShareDiv == null || perShareDiv <= 0) return null
  if (perShareFcf <= 0) return -1            // negative FCF — sustainability() treats this as the worst case
  return +((perShareDiv / perShareFcf) * 100).toFixed(2)
}

/**
 * Ask the model to explain a ranking it did not produce. It is told the
 * numbers are already computed and that it must not reorder or invent — the
 * response is annotation only, keyed by symbol, and anything it returns for a
 * symbol not in the ranking is discarded.
 */
async function explainRanking(ranked) {
  const lines = ranked.slice(0, 10).map(r =>
    `${r.symbol} (${r.name || r.symbol}) sector=${r.sector ?? 'n/a'} | composite=${r.composite} ` +
    `yieldScore=${r.yieldScore ?? 'n/a'} profitScore=${r.profitScore ?? 'n/a'} | ` +
    `yield=${r.dividendYield ?? 'n/a'}% payout=${r.payoutRatio ?? 'n/a'}% fcfPayout=${r.fcfPayoutRatio ?? 'n/a'}% ` +
    `roe=${r.roe ?? 'n/a'}% netMargin=${r.netMargin ?? 'n/a'}% D/E=${r.debtToEquity ?? 'n/a'}%` +
    (r.flags.length ? ` | flags: ${r.flags.map(f => f.code).join(', ')}` : ''))

  const prompt =
    'These stocks have ALREADY been scored and ranked by a deterministic model from the ' +
    'measured fundamentals shown. Your job is ONLY to explain each one in plain language.\n\n' +
    'Rules:\n' +
    '- Do NOT reorder, add, or remove any symbol.\n' +
    '- Do NOT state any number that is not shown below.\n' +
    '- Reference the SPECIFIC figures given for that symbol.\n' +
    '- For a flagged row, say plainly what the risk is.\n' +
    '- Each explanation ≤ 25 words.\n\n' +
    `RANKED STOCKS:\n${lines.join('\n')}\n\n` +
    'Respond with ONLY a JSON object mapping symbol → explanation string. No markdown.'

  const { text } = await aiRouter.call({
    prompt, maxTokens: 1500,
    system: 'You explain quantitative rankings. Return ONLY valid JSON. Never invent figures.',
    symbols: ranked.map(r => r.symbol),
  })

  const match = String(text).match(/\{[\s\S]*\}/)
  if (!match) return {}
  try {
    const parsed = JSON.parse(match[0])
    const allowed = new Set(ranked.map(r => r.symbol))
    // A symbol the model volunteered that is not in the ranking is discarded —
    // the ranking is the deterministic side's, and this call cannot extend it.
    return Object.fromEntries(Object.entries(parsed)
      .filter(([sym, v]) => allowed.has(sym) && typeof v === 'string')
      .map(([sym, v]) => [sym, v.trim()]))
  } catch { return {} }
}

router.get('/sectors', (_req, res) => {
  try { res.json({ sectors: symbolDb.listSectors() }) }
  catch { res.json({ sectors: [] }) }
})

router.post('/run', requireAuth, screenerLimit, async (req, res) => {
  const body         = req.body || {}
  const sector       = typeof body.sector === 'string' && body.sector.trim() ? body.sector.trim() : null
  const minMarketCap = Math.max(0, num(body.minMarketCap) ?? DEFAULT_MIN_CAP)
  const minYield     = num(body.minYield)
  const limit        = Math.max(1, Math.min(50, num(body.limit) ?? 25))
  const explain      = body.explain !== false

  const weights = { ...DEFAULT_WEIGHTS }
  if (body.weights && typeof body.weights === 'object') {
    const wy = num(body.weights.yield)
    const wp = num(body.weights.profitability)
    // Fractions and percentages both arrive here from real callers; normalising
    // means the ratio is what matters, not the scale someone happened to use.
    if (wy != null && wp != null && wy >= 0 && wp >= 0 && wy + wp > 0) {
      weights.yield = wy / (wy + wp)
      weights.profitability = wp / (wy + wp)
    }
  }

  const cacheKey = JSON.stringify({ sector, minMarketCap, minYield, limit, weights, explain })
  const hit = _cache.get(cacheKey)
  if (hit && Date.now() - hit.ts < CACHE_TTL) return res.json({ ...hit.data, cached: true })

  startJsonHeartbeat(res)

  try {
    const key = (req.headers['x-fmp-key'] || '').trim() || FMP_KEY()
    if (!key) return res.status(400).json({ error: 'FMP_API_KEY required for the fundamental screener' })

    let candidates = []
    let candidateSource = 'fmp-screener'
    let notes = []

    try {
      candidates = await fmpCandidates({ sector, minMarketCap, minYield }, key)
    } catch (e) {
      notes.push(`bulk screener unavailable (${e.message}) — fell back to the local symbol index`)
      candidateSource = 'symbol-db'
      candidates = symbolDbCandidates({ sector })
    }

    if (!candidates.length) {
      return res.json({
        ranked: [], excluded: [], candidateSource, notes,
        error: sector
          ? `No candidates for sector "${sector}" above a $${(minMarketCap / 1e9).toFixed(1)}B market cap`
          : 'No candidates matched the filters',
      })
    }

    // Enrichment is the expensive stage, so it only ever sees a shortlist.
    // Pre-sorting by yield when a yield floor was asked for puts the budget
    // where the user pointed it; otherwise market cap is the neutral prior.
    const shortlist = candidates
      .slice()
      .sort((a, b) => (minYield != null
        ? (b.dividendYield ?? 0) - (a.dividendYield ?? 0)
        : (b.marketCap ?? 0) - (a.marketCap ?? 0)))
      .slice(0, ENRICH_LIMIT)

    const enriched = await enrich(shortlist, key)
    if (!enriched.length) {
      return res.json({
        ranked: [], excluded: [], candidateSource, notes,
        error: 'Fundamentals were unavailable for every candidate — check the FMP plan tier',
      })
    }

    const { ranked, excluded } = rankCandidates(enriched, { weights, limit })

    let explanations = {}
    if (explain && ranked.length) {
      try { explanations = await explainRanking(ranked) }
      catch (e) { notes.push(`explanations unavailable (${e.message})`) }
    }

    const payload = {
      ranked: ranked.map(r => ({ ...r, explanation: explanations[r.symbol] ?? null })),
      excluded,
      weights,
      candidateSource,
      candidatesScanned: candidates.length,
      enriched: enriched.length,
      notes,
      generatedAt: new Date().toISOString(),
    }

    _cache.set(cacheKey, { ts: Date.now(), data: payload })
    res.json(payload)
  } catch (e) {
    console.error('[screener] run failed:', e.message)
    res.status(500).json({ error: `Screener failed: ${e.message}` })
  }
})

module.exports = router
module.exports.looksLikeFraction = looksLikeFraction
