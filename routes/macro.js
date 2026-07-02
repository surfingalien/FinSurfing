'use strict'
/**
 * routes/macro.js
 *
 * GET /api/macro/indicators  — key FRED macroeconomic indicators
 * GET /api/macro/summary     — AI-formatted macro context string (for prompt injection)
 *
 * Data sources (in order of preference):
 *   1. FRED API  — requires FRED_API_KEY env var (free at https://fred.stlouisfed.org/docs/api/api_key.html)
 *   2. World Bank API — no key required, used as fallback for a subset of series
 *
 * Results are cached in-process for 1 hour (macro data changes daily at most).
 */

const express = require('express')
const router  = express.Router()
const { buildRegimePlaybook } = require('../lib/macro-playbook')

const FRED_BASE  = 'https://api.stlouisfed.org/fred/series/observations'
const CACHE_TTL  = 60 * 60 * 1000   // 1 hour

// In-process cache: { data, fetchedAt }
let _cache = null

// ── FRED series definitions ───────────────────────────────────────────────────
const FRED_SERIES = [
  { id: 'FEDFUNDS',  label: 'Fed Funds Rate',       unit: '%',  category: 'rates',     description: 'Federal Funds Effective Rate' },
  { id: 'DGS10',     label: '10Y Treasury',          unit: '%',  category: 'rates',     description: '10-Year Treasury Constant Maturity' },
  { id: 'T10Y2Y',    label: 'Yield Curve (10Y-2Y)',  unit: '%',  category: 'rates',     description: 'Spread signals recession risk when negative' },
  { id: 'CPIAUCSL',  label: 'CPI (YoY inflation)',   unit: '%',  category: 'inflation', description: 'Consumer Price Index (% change YoY derived)', yoyDerived: true },
  { id: 'PCEPI',     label: 'PCE Inflation',         unit: '%',  category: 'inflation', description: 'Fed preferred inflation gauge (% change YoY derived)', yoyDerived: true },
  { id: 'UNRATE',    label: 'Unemployment Rate',     unit: '%',  category: 'labor',     description: 'US Civilian Unemployment Rate' },
  { id: 'PAYEMS',    label: 'Nonfarm Payrolls',      unit: 'K',  category: 'labor',     description: 'Monthly change in nonfarm payrolls', momDerived: true },
  { id: 'GDP',       label: 'GDP Growth (QoQ ann.)', unit: '%',  category: 'growth',    description: 'Real GDP Growth Rate (quarterly annualized)', yoyDerived: true },
  { id: 'INDPRO',    label: 'Industrial Production', unit: '%',  category: 'growth',    description: 'Industrial Production Index (YoY change derived)', yoyDerived: true },
  { id: 'UMCSENT',   label: 'Consumer Sentiment',    unit: 'pts',category: 'sentiment', description: 'University of Michigan Consumer Sentiment' },
  { id: 'DTWEXBGS',  label: 'USD Index',             unit: 'idx',category: 'currency',  description: 'Broad US Dollar Index (trade-weighted)' },
  { id: 'VIXCLS',    label: 'VIX (Fear Index)',      unit: 'pts',category: 'risk',      description: 'CBOE Volatility Index — market fear gauge' },
  { id: 'MORTGAGE30US', label: '30Y Mortgage Rate',  unit: '%',  category: 'housing',   description: '30-Year Fixed Rate Mortgage Average' },
  { id: 'BAMLH0A0HYM2', label: 'HY Credit Spread',  unit: '%',  category: 'credit',    description: 'High-Yield OAS spread — rising = tightening credit' },
]

// ── Fetch a single FRED series (last 13 obs for YoY/MoM derivation) ──────────
async function fetchFredSeries(seriesId, apiKey, limit = 2) {
  const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=${limit}`
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`FRED ${seriesId}: HTTP ${res.status}`)
  const json = await res.json()
  const obs  = (json.observations ?? []).filter(o => o.value !== '.')
  return obs
}

// Derive YoY % change from last 13 monthly observations
function yoyChange(obs) {
  if (obs.length < 13) return null
  const latest = parseFloat(obs[0].value)
  const year   = parseFloat(obs[12].value)
  if (isNaN(latest) || isNaN(year) || year === 0) return null
  return +((latest - year) / Math.abs(year) * 100).toFixed(2)
}

// Derive MoM change (absolute)
function momChange(obs) {
  if (obs.length < 2) return null
  const latest = parseFloat(obs[0].value)
  const prev   = parseFloat(obs[1].value)
  if (isNaN(latest) || isNaN(prev)) return null
  return +(latest - prev).toFixed(1)
}

// ── Fetch all FRED series ─────────────────────────────────────────────────────
async function fetchAllFred(apiKey) {
  const results = await Promise.allSettled(
    FRED_SERIES.map(s => {
      const limit = (s.yoyDerived || s.momDerived) ? 14 : 2
      return fetchFredSeries(s.id, apiKey, limit).then(obs => ({ s, obs }))
    })
  )

  return results.map((r, i) => {
    const { s } = r.status === 'fulfilled' ? r.value : { s: FRED_SERIES[i] }
    if (r.status !== 'fulfilled') return { ...s, value: null, date: null, error: r.reason?.message }

    const { obs } = r.value
    if (!obs.length) return { ...s, value: null, date: null }

    const rawValue = parseFloat(obs[0].value)
    let value = isNaN(rawValue) ? null : rawValue
    let changeLabel = null

    if (s.yoyDerived) {
      const yoy = yoyChange(obs)
      if (yoy !== null) { value = yoy; changeLabel = 'YoY' }
    } else if (s.momDerived) {
      const mom = momChange(obs)
      if (mom !== null) { value = mom; changeLabel = 'MoM change' }
    }

    const prev  = obs.length > 1 ? parseFloat(obs[1].value) : null
    const delta = (value != null && prev != null && !s.yoyDerived && !s.momDerived)
      ? +(value - prev).toFixed(3) : null

    return {
      ...s,
      value,
      prev: (s.yoyDerived || s.momDerived) ? null : (!isNaN(prev) ? prev : null),
      delta,
      changeLabel,
      date: obs[0]?.date ?? null,
    }
  })
}

// ── Macro regime assessment ───────────────────────────────────────────────────
function assessRegime(indicators) {
  const get = id => indicators.find(i => i.id === id)?.value ?? null

  const fedFunds    = get('FEDFUNDS')
  const t10y2y      = get('T10Y2Y')
  const cpiYoy      = get('CPIAUCSL')
  const unrate      = get('UNRATE')
  const vix         = get('VIXCLS')
  const hySpread    = get('BAMLH0A0HYM2')
  const sentiment   = get('UMCSENT')

  const signals = []

  // Yield curve
  if (t10y2y !== null) {
    if (t10y2y < -0.5)      signals.push({ type: 'warning', text: 'Inverted yield curve — elevated recession risk' })
    else if (t10y2y < 0)    signals.push({ type: 'caution', text: 'Flat/slightly inverted yield curve — slowdown watch' })
    else if (t10y2y > 1.5)  signals.push({ type: 'positive', text: 'Steep yield curve — growth expectations strong' })
  }

  // Inflation
  if (cpiYoy !== null) {
    if (cpiYoy > 5)          signals.push({ type: 'warning', text: `High inflation (${cpiYoy.toFixed(1)}%) — Fed likely hawkish, pressure on valuations` })
    else if (cpiYoy > 3)     signals.push({ type: 'caution', text: `Above-target inflation (${cpiYoy.toFixed(1)}%) — Fed may stay higher for longer` })
    else if (cpiYoy < 1.5)   signals.push({ type: 'caution', text: `Deflation risk (${cpiYoy.toFixed(1)}%) — growth concerns` })
    else                     signals.push({ type: 'positive', text: `Inflation near target (${cpiYoy.toFixed(1)}%) — Fed can be patient` })
  }

  // Labor market
  if (unrate !== null) {
    if (unrate > 5.5)        signals.push({ type: 'warning', text: `Rising unemployment (${unrate}%) — consumer spending at risk` })
    else if (unrate < 4)     signals.push({ type: 'positive', text: `Tight labor market (${unrate}%) — consumer resilient` })
  }

  // Fear/risk
  if (vix !== null) {
    if (vix > 30)            signals.push({ type: 'warning', text: `Elevated fear (VIX ${vix.toFixed(0)}) — consider reducing risk` })
    else if (vix < 15)       signals.push({ type: 'positive', text: `Low volatility (VIX ${vix.toFixed(0)}) — calm market environment` })
  }

  // Credit
  if (hySpread !== null) {
    if (hySpread > 6)        signals.push({ type: 'warning', text: `Wide HY spreads (${hySpread.toFixed(1)}%) — credit stress / risk-off` })
    else if (hySpread < 3)   signals.push({ type: 'positive', text: `Tight HY spreads (${hySpread.toFixed(1)}%) — credit healthy, risk appetite high` })
  }

  // Rate level
  if (fedFunds !== null) {
    if (fedFunds > 4.5)      signals.push({ type: 'caution', text: `High rates (${fedFunds.toFixed(2)}%) — expensive to borrow, favors value over growth` })
    else if (fedFunds < 2)   signals.push({ type: 'positive', text: `Low rates (${fedFunds.toFixed(2)}%) — accommodative, favors growth stocks` })
  }

  // Derive overall regime
  const warnings  = signals.filter(s => s.type === 'warning').length
  const positives = signals.filter(s => s.type === 'positive').length

  let regime, regimeColor
  if (warnings >= 2)          { regime = 'Risk-Off / Defensive'; regimeColor = 'red' }
  else if (warnings === 1)    { regime = 'Cautious / Selective'; regimeColor = 'amber' }
  else if (positives >= 3)    { regime = 'Risk-On / Growth Favoured'; regimeColor = 'emerald' }
  else                        { regime = 'Neutral / Balanced'; regimeColor = 'slate' }

  return { regime, regimeColor, signals }
}

// ── Build concise macro summary string for AI prompt injection ────────────────
// `playbook` (lib/macro-playbook.js) appends deterministic regime→strategy
// tilts so every consumer of macroSummary gets actionable direction, not
// just raw indicator context.
function buildMacroSummary(indicators, regime, playbook) {
  const get    = (id, dec = 2) => { const v = indicators.find(i => i.id === id)?.value; return v != null ? v.toFixed(dec) : 'N/A' }
  const getDate = id           => indicators.find(i => i.id === id)?.date ?? ''

  return `
CURRENT MACRO ENVIRONMENT (${new Date().toISOString().split('T')[0]}):
Regime: ${regime.regime}
Fed Funds Rate: ${get('FEDFUNDS')}% | 10Y Treasury: ${get('DGS10')}% | Yield Curve (10Y-2Y): ${get('T10Y2Y')}%
CPI Inflation (YoY): ${get('CPIAUCSL')}% | PCE Inflation (YoY): ${get('PCEPI')}%
Unemployment: ${get('UNRATE')}% | VIX: ${get('VIXCLS', 1)}
HY Credit Spread: ${get('BAMLH0A0HYM2')}% | USD Index: ${get('DTWEXBGS', 1)}
Consumer Sentiment: ${get('UMCSENT', 1)} | 30Y Mortgage: ${get('MORTGAGE30US')}%
Key regime signals: ${regime.signals.map(s => s.text).join('; ')}
${playbook?.text || ''}
Use this macro context to inform your recommendations — factor in rate environment, inflation, and credit conditions.`
}

// ── Main fetch function ───────────────────────────────────────────────────────
async function getIndicators() {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL) return _cache.data

  const apiKey = process.env.FRED_API_KEY
  if (!apiKey) {
    return { error: 'FRED_API_KEY not set', indicators: [], regime: null, macroSummary: '' }
  }

  const indicators = await fetchAllFred(apiKey)
  const regime     = assessRegime(indicators)
  const playbook   = buildRegimePlaybook(indicators)
  const macroSummary = buildMacroSummary(indicators, regime, playbook)

  const data = {
    indicators,
    regime,
    playbook,
    macroSummary,
    fetchedAt: new Date().toISOString(),
    source: 'FRED (Federal Reserve Bank of St. Louis)',
  }
  _cache = { data, fetchedAt: Date.now() }
  return data
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/indicators', async (req, res) => {
  try {
    const data = await getIndicators()
    if (data.error) return res.status(503).json(data)
    return res.json(data)
  } catch (err) {
    console.error('[macro] indicators error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

// Returns only the compact macro summary string — used for prompt injection
router.get('/summary', async (req, res) => {
  try {
    const data = await getIndicators()
    if (data.error) return res.status(503).json(data)
    return res.json({ macroSummary: data.macroSummary, regime: data.regime, playbook: data.playbook, fetchedAt: data.fetchedAt })
  } catch (err) {
    console.error('[macro] summary error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

module.exports = router
module.exports.getIndicators = getIndicators   // exported for use in recommendations route
