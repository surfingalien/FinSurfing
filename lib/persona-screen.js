'use strict'
/**
 * lib/persona-screen.js — each AI Buy Signals persona's rules, checked in code.
 *
 * Before this the Advisory prompt named a persona ("Buffett: positive free cash
 * flow, P/E < 35, ROE > 15%") and asked for a FIXED slate of 20 — 7 three-month
 * stocks, 4 ETFs, 3 cryptos — whatever the persona. With no candidate list and
 * no data the model picked from memory, a stock-only persona was asked for
 * crypto, and nothing checked a single rule after it answered.
 *
 *   A. screen      the persona's rules run over a fixed universe of measured
 *                  names (large caps from the symbol index, curated ETF / crypto
 *                  / fund lists); figures are SEC first-filed fundamentals
 *                  (sec-facts.snapshotAt) and daily bars. A rule whose figure is
 *                  unknown is NOT passed — the name is counted as `unknown`,
 *                  never treated as meeting the rule. The survivors, ranked, are
 *                  the ONLY names the model may choose from.
 *   B. slate       how many of each asset class and which horizons come from the
 *                  persona (`SCREENS`), as maximums — "up to", never "exactly",
 *                  so the model is not asked to pad.
 *   C. check       after the model answers, every pick is checked against the
 *                  screen: a name not on the list, an asset class the persona
 *                  does not use, a horizon it does not hold, or a pick beyond the
 *                  slate's count is DROPPED and reported (same contract as the
 *                  edge gate's `rejected`). In focus mode the user chose the
 *                  names, so nothing is dropped — each pick says which rules it
 *                  passes, fails or could not be checked.
 *
 * Proxies are named where the data differs from the persona's wording (Lynch's
 * PEG uses revenue growth, Greenblatt's return on capital uses ROE, his
 * earnings yield is E/P not EBIT/EV) — the label says so on every card.
 *
 * Pure apart from `buildMeasures` (injectable fetchers). Tests: tests/persona-screen.test.js
 */

const DAY = 86_400_000

// ── Universes ─────────────────────────────────────────────────────────────────
const ETF_GROUPS = {
  broad:     ['SPY', 'QQQ', 'IWM', 'DIA', 'VTI', 'RSP'],
  sector:    ['XLK', 'XLF', 'XLV', 'XLE', 'XLI', 'XLP', 'XLU', 'XLY', 'XLB', 'XLRE', 'XLC', 'SMH'],
  bond:      ['TLT', 'IEF', 'SHY', 'TIP', 'LQD', 'HYG', 'AGG'],
  intl:      ['EFA', 'EEM', 'VEA', 'VWO', 'FXI', 'EWJ', 'INDA', 'EWZ'],
  commodity: ['GLD', 'SLV', 'DBC', 'USO', 'DBA', 'GDX'],
  thematic:  ['ARKK', 'BOTZ', 'ICLN', 'LIT', 'ARKG', 'UFO', 'FINX', 'CIBR'],
}
const CRYPTO = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'ADA-USD', 'AVAX-USD', 'LINK-USD', 'DOT-USD']
const FUNDS  = ['FXAIX', 'VFIAX', 'FCNTX', 'FDGRX', 'PRGFX', 'PRWCX']

// Sector of the fallback large caps, for when the symbol index is not loaded.
const FALLBACK_SECTORS = {
  'Information Technology': ['AAPL', 'MSFT', 'NVDA', 'AVGO', 'ORCL', 'CRM', 'ADBE', 'CSCO', 'AMD', 'INTC', 'QCOM', 'TXN'],
  'Consumer Discretionary': ['AMZN', 'TSLA', 'HD', 'MCD', 'NKE', 'SBUX', 'LOW', 'BKNG'],
  'Communication Services': ['GOOGL', 'META', 'NFLX', 'DIS', 'T', 'VZ'],
  Financials:               ['JPM', 'BAC', 'WFC', 'GS', 'MS', 'BLK', 'AXP', 'C'],
  'Health Care':            ['LLY', 'UNH', 'JNJ', 'MRK', 'ABBV', 'PFE', 'TMO', 'ABT'],
  Energy:                   ['XOM', 'CVX', 'COP', 'SLB', 'EOG'],
  'Consumer Staples':       ['PG', 'KO', 'PEP', 'WMT', 'COST'],
  Industrials:              ['CAT', 'GE', 'HON', 'UNP', 'RTX', 'DE'],
  Materials:                ['LIN', 'APD'],
  Utilities:                ['NEE', 'DUK', 'SO'],
  'Real Estate':            ['PLD', 'AMT', 'EQIX'],
}
const SECTOR_OF = Object.fromEntries(Object.entries(FALLBACK_SECTORS).flatMap(([s, list]) => list.map(x => [x, s])))
const INNOVATION_SECTORS = ['Information Technology', 'Communication Services', 'Health Care', 'Consumer Discretionary']

// ── Rules ─────────────────────────────────────────────────────────────────────
// field: a measured figure (see measureStock); op compares; label is printed.
const r = (field, op, value, label) => ({ field, op, value, label })

const SCREENS = {
  default: {
    slate: { Stock: 12, ETF: 4, Crypto: 3, Fund: 3 }, periods: ['3m', '6m'],
    stock: { rules: [], rank: 'momentum' },
    etfGroups: ['broad', 'sector', 'intl', 'bond', 'commodity'], crypto: CRYPTO,
  },
  buffett: {
    slate: { Stock: 10 }, periods: ['6m'],
    stock: { rules: [r('fcfYield', '>', 0, 'free cash flow positive'), r('pe', '<=', 35, 'P/E ≤ 35'), r('roe', '>=', 15, 'ROE ≥ 15%'), r('debtToEquity', '<=', 1, 'debt/equity ≤ 1')], rank: 'quality' },
  },
  munger: {
    slate: { Stock: 10 }, periods: ['6m'],
    stock: { rules: [r('roe', '>=', 15, 'ROE ≥ 15%'), r('netMargin', '>=', 10, 'net margin ≥ 10%'), r('fcfYield', '>', 0, 'free cash flow positive'), r('debtToEquity', '<=', 1.5, 'debt/equity ≤ 1.5')], rank: 'quality' },
  },
  lynch: {
    slate: { Stock: 10, ETF: 2 }, periods: ['3m', '6m'],
    stock: { rules: [r('revenueGrowthYoY', '>', 0, 'revenue growing'), r('peg', '<=', 1.5, 'P/E ÷ revenue growth ≤ 1.5 (PEG proxy)')], rank: 'garp' },
    etfGroups: ['broad', 'sector'],
    notes: ['PEG uses revenue growth — EPS growth is not in the first-filed data', 'the universe is large caps; Lynch favoured smaller companies'],
  },
  dalio: {
    slate: { ETF: 8, Stock: 3, Crypto: 1 }, periods: ['3m', '6m'],
    stock: { rules: [r('vol', '<=', 30, 'volatility ≤ 30%/yr')], rank: 'lowvol' },
    etfGroups: ['broad', 'intl', 'bond', 'commodity'], crypto: ['BTC-USD'],
  },
  burry: {
    slate: { Stock: 8 }, periods: ['6m'],
    stock: { rules: [r('fcfYield', '>=', 8, 'free cash flow yield ≥ 8%')], rank: 'fcfYield' },
    notes: ['below-book screens need book value per share, which is not measured here'],
  },
  wood: {
    slate: { Stock: 8, ETF: 3, Crypto: 3 }, periods: ['3m', '6m'],
    stock: { rules: [r('revenueGrowthYoY', '>=', 20, 'revenue growth ≥ 20%')], sectors: INNOVATION_SECTORS, rank: 'growth' },
    etfGroups: ['thematic'], crypto: CRYPTO,
  },
  marks: {
    slate: { Stock: 8, ETF: 4 }, periods: ['3m', '6m'],
    stock: { rules: [r('pe', '<=', 25, 'P/E ≤ 25'), r('debtToEquity', '<=', 1, 'debt/equity ≤ 1'), r('vol', '<=', 35, 'volatility ≤ 35%/yr'), r('momRank', '<', 0.8, 'not in the top fifth by 12-month return')], rank: 'quality' },
    etfGroups: ['broad', 'bond', 'sector'],
  },
  soros: {
    slate: { ETF: 8, Stock: 4, Crypto: 2 }, periods: ['3m', '6m'],
    stock: { rules: [r('ret63', '>', 0, 'up over 3 months')], rank: 'momentum' },
    etfGroups: ['intl', 'commodity', 'bond', 'broad'], crypto: ['BTC-USD', 'ETH-USD'],
  },
  greenblatt: {
    slate: { Stock: 10 }, periods: ['6m'],
    stock: { rules: [r('earningsYield', '>', 0, 'earnings yield positive'), r('roe', '>', 0, 'ROE positive')], excludeSectors: ['Financials', 'Utilities'], rank: 'magic', top: 15 },
    notes: ['earnings yield is E/P and return on capital is ROE — EBIT/EV and ROC need balance-sheet items not measured here'],
  },
}

const ASSET_CLASSES = ['Stock', 'ETF', 'Crypto', 'Fund']

function screenFor(personaId, { includeFunds = false } = {}) {
  const s = SCREENS[personaId] || SCREENS.default
  const slate = { ...s.slate }
  if (!includeFunds) delete slate.Fund
  return { ...s, slate }
}

// ── Measures ──────────────────────────────────────────────────────────────────
const round = (x, d = 1) => (Number.isFinite(x) ? +x.toFixed(d) : null)

/** Price measures from daily bars [{t, c}] (oldest first). Pure. */
function barMeasures(bars) {
  const b = (bars || []).filter(x => Number.isFinite(x?.c) && x.c > 0)
  if (b.length < 20) return null
  const last = b[b.length - 1]
  const back = k => (b.length > k ? b[b.length - 1 - k].c : null)
  const pct = (a, z) => (a && z ? ((z / a) - 1) * 100 : null)
  const year = b.slice(-253)
  const rets = []
  for (let i = 1; i < year.length; i++) rets.push(Math.log(year[i].c / year[i - 1].c))
  const m = rets.reduce((a, x) => a + x, 0) / (rets.length || 1)
  const sd = Math.sqrt(rets.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, rets.length - 1))
  const high = Math.max(...year.map(x => x.c))
  return {
    price: round(last.c, 2), asOf: new Date(last.t).toISOString().slice(0, 10),
    ret63: round(pct(back(63), last.c)), ret252: round(pct(back(252), last.c)),
    vol: rets.length >= 60 ? round(sd * Math.sqrt(252) * 100) : null,
    offHigh: round(((last.c / high) - 1) * 100),
  }
}

/** SEC first-filed fundamentals → the fields the rules read. */
function factMeasures(snap) {
  if (!snap) return {}
  const out = {}
  for (const k of ['pe', 'roe', 'fcfYield', 'earningsYield', 'debtToEquity', 'revenueGrowthYoY', 'netMargin']) out[k] = Number.isFinite(snap[k]) ? snap[k] : null
  out.peg = out.pe > 0 && out.revenueGrowthYoY > 0 ? round(out.pe / out.revenueGrowthYoY, 2) : null
  return out
}

/** Cross-sectional rank of 12-month return (0 = worst, 1 = best) among the stocks measured. */
function attachMomentumRank(stocks) {
  const known = stocks.filter(s => Number.isFinite(s.ret252)).sort((a, b) => a.ret252 - b.ret252)
  known.forEach((s, i) => { s.momRank = known.length > 1 ? +(i / (known.length - 1)).toFixed(3) : 0.5 })
  return stocks
}

// ── A. Screen ─────────────────────────────────────────────────────────────────
const OPS = { '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b }

/** Each rule passed / failed / unknown for one name's measures. Pure. */
function evaluateRules(rules, m) {
  const passed = [], failed = [], unknown = []
  for (const rule of rules || []) {
    const v = m?.[rule.field]
    if (!Number.isFinite(v)) unknown.push(rule.label)
    else (OPS[rule.op](v, rule.value) ? passed : failed).push(rule.label)
  }
  return { passed, failed, unknown, ok: !failed.length && !unknown.length }
}

const RANKERS = {
  momentum: s => s.ret252 ?? -Infinity,
  quality:  s => (s.roe ?? 0) + 2 * (s.fcfYield ?? 0),
  garp:     s => -(s.peg ?? Infinity),
  lowvol:   s => -(s.vol ?? Infinity),
  fcfYield: s => s.fcfYield ?? -Infinity,
  growth:   s => s.revenueGrowthYoY ?? -Infinity,
}
/** Greenblatt: sum of ranks on earnings yield and ROE (lower = better). */
function magicOrder(list) {
  const rankBy = key => {
    const sorted = [...list].sort((a, b) => b[key] - a[key])
    return new Map(sorted.map((s, i) => [s.symbol, i]))
  }
  const ey = rankBy('earningsYield'), roe = rankBy('roe')
  return [...list].sort((a, b) => (ey.get(a.symbol) + roe.get(a.symbol)) - (ey.get(b.symbol) + roe.get(b.symbol)))
}

/**
 * The persona's candidate list. measures: { SYM: {assetClass, sector?, ...figures} }.
 * Returns { stocks, etfs, crypto, funds } each [{symbol, ...figures, passed}],
 * plus counts of what was screened out and why. Pure.
 */
function screen(personaId, measures, { includeFunds = false } = {}) {
  const cfg = screenFor(personaId, { includeFunds })
  const all = Object.entries(measures || {}).map(([symbol, m]) => ({ symbol, ...m }))
  const priced = all.filter(x => x.price > 0)
  const out = { persona: personaId in SCREENS ? personaId : 'default', slate: cfg.slate, periods: cfg.periods, notes: cfg.notes || [], rules: cfg.stock?.rules?.map(x => x.label) || [], stocks: [], etfs: [], crypto: [], funds: [], screenedOut: { failed: 0, unknown: 0, sector: 0, unpriced: all.length - priced.length } }

  if (cfg.slate.Stock) {
    const stocks = attachMomentumRank(priced.filter(x => x.assetClass === 'Stock'))
    const ok = []
    for (const s of stocks) {
      if (cfg.stock.sectors && !cfg.stock.sectors.includes(s.sector)) { out.screenedOut.sector++; continue }
      if (cfg.stock.excludeSectors?.includes(s.sector)) { out.screenedOut.sector++; continue }
      const ev = evaluateRules(cfg.stock.rules, s)
      if (ev.failed.length) { out.screenedOut.failed++; continue }
      if (ev.unknown.length) { out.screenedOut.unknown++; continue }
      ok.push({ ...s, passed: ev.passed })
    }
    const ordered = cfg.stock.rank === 'magic' ? magicOrder(ok) : ok.sort((a, b) => RANKERS[cfg.stock.rank](b) - RANKERS[cfg.stock.rank](a))
    out.stocks = ordered.slice(0, cfg.stock.top || 30)
  }
  if (cfg.slate.ETF) {
    const allowed = new Set((cfg.etfGroups || []).flatMap(g => ETF_GROUPS[g] || []))
    out.etfs = priced.filter(x => x.assetClass === 'ETF' && allowed.has(x.symbol)).map(x => ({ ...x, passed: [] }))
  }
  if (cfg.slate.Crypto) {
    const allowed = new Set(cfg.crypto || CRYPTO)
    out.crypto = priced.filter(x => x.assetClass === 'Crypto' && allowed.has(x.symbol)).map(x => ({ ...x, passed: [] }))
  }
  if (cfg.slate.Fund) out.funds = priced.filter(x => x.assetClass === 'Fund').map(x => ({ ...x, passed: [] }))
  return out
}

/** Every symbol a persona's screen could need, by asset class. */
function universeFor(personaId, { includeFunds = false, stocks = [] } = {}) {
  const cfg = screenFor(personaId, { includeFunds })
  const out = []
  if (cfg.slate.Stock) for (const s of stocks) out.push([s, 'Stock'])
  if (cfg.slate.ETF) for (const s of new Set((cfg.etfGroups || []).flatMap(g => ETF_GROUPS[g] || []))) out.push([s, 'ETF'])
  if (cfg.slate.Crypto) for (const s of cfg.crypto || CRYPTO) out.push([s, 'Crypto'])
  if (cfg.slate.Fund) for (const s of FUNDS) out.push([s, 'Fund'])
  return out
}

// ── Prompt ────────────────────────────────────────────────────────────────────
const pctTxt = (v, signed = true) => (v == null ? null : `${signed && v > 0 ? '+' : ''}${v}%`)
function factLine(c) {
  const parts = [`$${c.price}`]
  const add = (label, v) => { if (v != null) parts.push(`${label} ${v}`) }
  add('3m', pctTxt(c.ret63)); add('12m', pctTxt(c.ret252)); add('vol', c.vol != null ? `${c.vol}%/yr` : null)
  add('P/E', c.pe); add('ROE', pctTxt(c.roe, false)); add('FCF yield', pctTxt(c.fcfYield, false))
  add('earnings yield', pctTxt(c.earningsYield, false)); add('D/E', c.debtToEquity)
  add('revenue growth', pctTxt(c.revenueGrowthYoY)); add('net margin', pctTxt(c.netMargin, false)); add('PEG*', c.peg)
  return parts.join(' | ')
}

/** The CANDIDATES block injected into the prompt (and the evidence the citation gate checks). */
function candidateBlock(sc) {
  const lines = ['', `PERSONA SCREEN — the ONLY names you may recommend (screened in code from measured data: SEC first-filed fundamentals and daily closes${sc.rules.length ? `; stock rules: ${sc.rules.join(', ')}` : ''}):`]
  const section = (title, list, cap) => {
    if (!list.length) return
    lines.push(`${title}:`)
    for (const c of list.slice(0, cap)) lines.push(`  ${c.symbol}${c.sector ? ` [${c.sector}]` : ''}: ${factLine(c)}`)
  }
  section('STOCKS (ranked)', sc.stocks, 30)
  section('ETFS', sc.etfs, 20)
  section('CRYPTO', sc.crypto, 10)
  section('MUTUAL FUNDS', sc.funds, 10)
  for (const n of sc.notes) lines.push(`  note: ${n}`)
  return lines.join('\n')
}

/** B. The slate instruction: maximums per asset class and the allowed horizons. */
function slateInstructions(sc) {
  const avail = { Stock: sc.stocks.length, ETF: sc.etfs.length, Crypto: sc.crypto.length, Fund: sc.funds.length }
  const rows = ASSET_CLASSES.filter(k => sc.slate[k] && avail[k]).map(k => `- up to ${Math.min(sc.slate[k], avail[k])} ${k === 'Fund' ? 'Mutual Funds (type "Fund")' : k === 'Crypto' ? 'Cryptocurrencies' : `${k}s`}`)
  const none = ASSET_CLASSES.filter(k => !sc.slate[k]).map(k => (k === 'Fund' ? 'mutual funds' : k === 'Crypto' ? 'crypto' : `${k}s`))
  return [
    'Choose recommendations ONLY from the PERSONA SCREEN list above:',
    ...rows,
    `- holding period: ${sc.periods.length === 1 ? `"${sc.periods[0]}" only` : sc.periods.map(p => `"${p}"`).join(' or ')}`,
    ...(none.length ? [`- no ${none.join(', no ')} for this persona`] : []),
    'These are MAXIMUMS. Return fewer — even none — rather than include a name you would not back on its figures. Never add a symbol that is not on the list.',
  ].join('\n')
}

// ── C. Check ──────────────────────────────────────────────────────────────────
const normType = t => {
  const s = String(t || '').toLowerCase()
  return s.startsWith('etf') ? 'ETF' : s.startsWith('crypto') ? 'Crypto' : s.startsWith('fund') || s.includes('mutual') ? 'Fund' : 'Stock'
}

/**
 * Check the model's picks against the screen. Non-focus: drop what breaks a
 * rule (with the reason). Focus: keep everything, attach `personaFit`.
 * Returns { picks, check }. Pure.
 */
function checkPicks(picks, sc, { focus = false, rules = null, measures = {} } = {}) {
  const bySym = new Map()
  for (const [list, cls] of [[sc.stocks, 'Stock'], [sc.etfs, 'ETF'], [sc.crypto, 'Crypto'], [sc.funds, 'Fund']]) for (const c of list) bySym.set(c.symbol, { ...c, assetClass: cls })
  const dropped = [], repaired = []
  const used = { Stock: 0, ETF: 0, Crypto: 0, Fund: 0 }
  const kept = []
  const stockRules = rules || SCREENS[sc.persona]?.stock?.rules || []

  for (const p of picks || []) {
    const sym = String(p?.symbol || '').toUpperCase()
    if (focus) {
      const m = measures[sym]
      const fit = m?.assetClass === 'Stock' ? evaluateRules(stockRules, m) : null
      kept.push({ ...p, personaFit: fit ? { passed: fit.passed, failed: fit.failed, unknown: fit.unknown } : null })
      continue
    }
    const c = bySym.get(sym)
    if (!c) { dropped.push({ symbol: sym, reason: 'not on the persona\'s screened list' }); continue }
    const cls = c.assetClass
    if (normType(p.type) !== cls) repaired.push({ symbol: sym, from: p.type ?? null, to: cls })
    if (!sc.slate[cls]) { dropped.push({ symbol: sym, reason: `${cls} is not an asset this persona holds` }); continue }
    if (!sc.periods.includes(p.period)) { dropped.push({ symbol: sym, reason: `holding period ${p.period ?? 'missing'} — this persona holds ${sc.periods.join('/')}` }); continue }
    if (used[cls] >= sc.slate[cls]) { dropped.push({ symbol: sym, reason: `beyond the persona's limit of ${sc.slate[cls]} ${cls}` }); continue }
    if (kept.some(k => String(k.symbol).toUpperCase() === sym)) { dropped.push({ symbol: sym, reason: 'duplicate' }); continue }
    used[cls]++
    const facts = Object.fromEntries(['price', 'asOf', 'ret63', 'ret252', 'vol', 'pe', 'roe', 'fcfYield', 'earningsYield', 'debtToEquity', 'revenueGrowthYoY', 'netMargin', 'peg'].filter(k => c[k] != null).map(k => [k, c[k]]))
    kept.push({ ...p, symbol: sym, type: cls, screen: { facts, passed: c.passed || [] } })
  }
  return {
    picks: kept,
    check: { mode: focus ? 'focus' : 'screened', evaluated: (picks || []).length, kept: kept.length, dropped, repaired, candidates: { stocks: sc.stocks.length, etfs: sc.etfs.length, crypto: sc.crypto.length, funds: sc.funds.length }, screenedOut: sc.screenedOut, rules: sc.rules, notes: sc.notes, slate: sc.slate, periods: sc.periods },
  }
}

// ── Data (impure, injectable) ─────────────────────────────────────────────────
const _cache = new Map()      // symbol → { at, m }
const CACHE_MS = 6 * 3600_000

function sectorOf(sym) {
  try { const c = require('./symbol-db').classify(sym); if (c?.sector) return c.sector } catch { /* index not loaded */ }
  return SECTOR_OF[sym] || null
}

/**
 * Measure every [symbol, assetClass] pair: bars for all, SEC facts for stocks.
 * A name that cannot be priced is left out and listed in `failed`. Within
 * `budgetMs` whatever finished is used.
 */
async function buildMeasures(pairs, { fetchBars, fetchFacts, concurrency = 6, budgetMs = 90_000, now = Date.now() } = {}) {
  const measures = {}, failed = []
  const deadline = now + budgetMs
  const queue = [...pairs]
  async function one([sym, cls]) {
    const hit = _cache.get(sym)
    if (hit && Date.now() - hit.at < CACHE_MS) { measures[sym] = hit.m; return }
    const bars = await fetchBars(sym).catch(() => null)
    const bm = barMeasures(bars)
    if (!bm) { failed.push(sym); return }
    let facts = {}
    if (cls === 'Stock' && fetchFacts) {
      try { facts = factMeasures(await fetchFacts(sym, bm.price)) } catch { facts = {} }
    }
    const m = { assetClass: cls, ...(cls === 'Stock' ? { sector: sectorOf(sym) } : {}), ...bm, ...facts }
    measures[sym] = m
    _cache.set(sym, { at: Date.now(), m })
  }
  async function worker() {
    while (queue.length && Date.now() < deadline) await one(queue.shift())
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  for (const [sym] of queue) failed.push(sym)
  return { measures, failed }
}

const ALL_ETFS = new Set(Object.values(ETF_GROUPS).flat())
/** Asset class of a user-typed symbol (focus mode). */
function classOf(sym) {
  const s = String(sym || '').toUpperCase()
  if (/-(USD|USDT)$/.test(s) || CRYPTO.includes(s)) return 'Crypto'
  if (ALL_ETFS.has(s)) return 'ETF'
  if (FUNDS.includes(s) || /^[A-Z]{4}X$/.test(s)) return 'Fund'
  try { const c = require('./symbol-db').classify(s); if (c?.assetClass === 'etf') return 'ETF'; if (c?.assetClass === 'fund') return 'Fund' } catch { /* index not loaded */ }
  return 'Stock'
}

/** The stock universe: the factor-mining large caps (symbol index, else the fallback list). */
function stockUniverse() {
  try { return require('./factor-mining').defaultUniverse() } catch { return Object.keys(SECTOR_OF) }
}

/** Live wiring: bars over loopback, SEC facts → snapshot at today's price. */
async function screenLive(personaId, { includeFunds = false, extraStocks = [], headers = {}, budgetMs } = {}) {
  const { fetchDailyBars } = require('./internal-api')
  const secFacts = require('./sec-facts')
  const pairs = universeFor(personaId, { includeFunds, stocks: [...new Set([...stockUniverse(), ...extraStocks])] })
  const { measures, failed } = await buildMeasures(pairs, {
    fetchBars: sym => fetchDailyBars(sym, { range: '1y', headers, timeoutMs: 8000 }),
    fetchFacts: async (sym, price) => { const c = await secFacts.getCompanyFacts(sym); return c ? secFacts.snapshotAt(c, new Date().toISOString().slice(0, 10), { price }) : null },
    budgetMs,
  })
  return { screen: screen(personaId, measures, { includeFunds }), measures, failed }
}

function _resetForTests() { _cache.clear() }

module.exports = {
  SCREENS, ETF_GROUPS, CRYPTO, FUNDS, ASSET_CLASSES,
  screenFor, barMeasures, factMeasures, evaluateRules, screen, universeFor,
  candidateBlock, slateInstructions, checkPicks, normType, classOf,
  buildMeasures, screenLive, stockUniverse, _resetForTests,
}
