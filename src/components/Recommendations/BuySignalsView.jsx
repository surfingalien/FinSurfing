/**
 * BuySignalsView — AI-powered buy recommendations for 3-month and 6-month holding periods.
 * Covers stocks, ETFs, and cryptocurrencies.
 */

import { useState, useCallback, useEffect } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import {
  Sparkles, RefreshCw, TrendingUp, Clock,
  AlertTriangle, Search, X, Download,
} from 'lucide-react'
import { exportBuySignalsToPDF } from '../../utils/pdfExport'
import { MacroBanner } from '../Macro/MacroPanel'
import { TYPE_CONFIG } from './signals/config'
import { PersonaPicker } from './signals/PersonaPicker'
import { RecCard } from './signals/RecCard'

/* ── Helpers ─────────────────────────────────── */
function getApiKeyHeaders() {
  try {
    const stored = JSON.parse(localStorage.getItem('finsurf_api_keys') || '{}')
    const h = {}
    if (stored.aisa?.trim())    h['x-aisa-key']    = stored.aisa.trim()
    if (stored.finnhub?.trim()) h['x-finnhub-key'] = stored.finnhub.trim()
    if (stored.fmp?.trim())     h['x-fmp-key']     = stored.fmp.trim()
    return h
  } catch { return {} }
}

/* ── Main view ───────────────────────────────────── */
export default function BuySignalsView({ portfolio, onAnalyze }) {
  const { accessToken } = useAuth()
  const [recs,          setRecs]          = useState(null)
  const [loading,       setLoading]       = useState(false)
  const [error,         setError]         = useState(null)
  const [filter,        setFilter]        = useState('all')
  const [period,        setPeriod]        = useState('all')
  const [customSymbols, setCustomSymbols] = useState('')
  const [liveQuotes,    setLiveQuotes]    = useState({})
  const [includeFunds,  setIncludeFunds]  = useState(false)
  const [personaId,     setPersonaId]     = useState('default')
  const [personas,      setPersonas]      = useState([])

  const holdings = portfolio?.positions?.map(p => p.symbol) ?? []

  // Load available personas on mount
  useEffect(() => {
    fetch('/api/recommendations/personas')
      .then(r => r.json())
      .then(d => { if (d.personas) setPersonas(d.personas) })
      .catch(() => {})
  }, [])

  const parseSymbols = (str) =>
    str.split(/[,\s]+/)
      .map(s => s.trim().toUpperCase().replace(/[^A-Z0-9.-]/g, ''))
      .filter(Boolean)
      .slice(0, 15)

  const generate = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const body = { holdings, persona: personaId, includeMacro: true }
      if (customSymbols.trim()) body.focusSymbols = parseSymbols(customSymbols)
      if (includeFunds && !customSymbols.trim()) body.includeFunds = true
      const authHeader = accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
      const res = await fetch('/api/recommendations', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...getApiKeyHeaders(), ...authHeader },
        body:    JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to get recommendations')
      setRecs(data)

      // Fetch live market prices for all recommended symbols
      try {
        const syms = (data.recommendations ?? []).map(r => r.symbol).join(',')
        if (!syms) return
        const qRes = await fetch(`/api/quote?symbols=${syms}`, { headers: getApiKeyHeaders() })
        const qData = await qRes.json()
        const qMap = {}
        for (const q of qData?.quoteResponse?.result ?? []) {
          if (q.regularMarketPrice != null) {
            qMap[q.symbol] = {
              price:     q.regularMarketPrice,
              changePct: q.regularMarketChangePercent ?? null,
            }
          }
        }
        setLiveQuotes(qMap)
      } catch { /* live prices are optional */ }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [holdings, customSymbols, accessToken, personaId, includeFunds])

  const displayed = (recs?.recommendations ?? []).filter(r => {
    if (filter !== 'all' && r.type !== filter) return false
    if (period !== 'all' && r.period !== period) return false
    return true
  })

  const counts = (recs?.recommendations ?? []).reduce((acc, r) => {
    acc[r.type]   = (acc[r.type]   || 0) + 1
    acc[r.period] = (acc[r.period] || 0) + 1
    return acc
  }, {})

  return (
    <div className="space-y-6 animate-fade-in">

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-mint-500/10 border border-mint-500/20">
            <Sparkles className="w-5 h-5 text-mint-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">AI Buy Signals</h1>
            <p className="text-xs text-slate-500">Claude-powered picks for 3-month & 6-month horizons</p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {recs && (
            <button
              onClick={() => exportBuySignalsToPDF(recs)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white/[0.04] text-slate-400 hover:text-white border border-white/[0.07] hover:border-white/[0.15] transition-all"
            >
              <Download className="w-3.5 h-3.5" /> Export PDF
            </button>
          )}
          <button
            onClick={generate}
            disabled={loading}
            className="btn-primary flex items-center gap-2 disabled:opacity-50"
          >
            {loading
              ? <><RefreshCw className="w-4 h-4 animate-spin" /> Analyzing…</>
              : <><Sparkles className="w-4 h-4" /> {recs ? 'Regenerate' : 'Generate Picks'}</>
            }
          </button>
        </div>
      </div>

      {/* ── Investor persona picker ── */}
      {personas.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs text-slate-500 font-medium px-1">Investment Persona</div>
          <PersonaPicker selected={personaId} onChange={setPersonaId} personas={personas} />
        </div>
      )}

      {/* ── Mutual fund toggle ── */}
      <div className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/[0.08]">
        <label className="flex items-center gap-2.5 cursor-pointer select-none group">
          <div
            onClick={() => setIncludeFunds(v => !v)}
            className={`relative w-9 h-5 rounded-full transition-colors ${includeFunds ? 'bg-teal-500' : 'bg-white/[0.08]'}`}
          >
            <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${includeFunds ? 'translate-x-4' : 'translate-x-0'}`} />
          </div>
          <span className={`text-xs font-medium transition-colors ${includeFunds ? 'text-teal-400' : 'text-slate-500 group-hover:text-slate-300'}`}>
            🏦 Include Mutual Funds
          </span>
        </label>
        {includeFunds && (
          <span className="text-[10px] text-slate-500 ml-1">Top retail funds (FXAIX, VFIAX, FCNTX…) will be added to picks</span>
        )}
      </div>

      {/* ── Symbol search ── */}
      <div className="flex items-center gap-2 p-3 rounded-xl bg-white/[0.03] border border-white/[0.08]">
        <Search className="w-4 h-4 text-slate-500 shrink-0" />
        <input
          type="text"
          value={customSymbols}
          onChange={e => setCustomSymbols(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && !loading && customSymbols.trim() && generate()}
          disabled={loading}
          placeholder="Focus on specific symbols (e.g. NVDA,TSLA,ETH-USD) — press Enter or leave blank for AI picks"
          className="flex-1 bg-transparent text-sm text-white placeholder-slate-600 focus:outline-none font-mono disabled:opacity-40"
        />
        {customSymbols.trim() && !loading && (
          <button
            onClick={generate}
            className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg bg-mint-500/20 text-mint-400 border border-mint-500/30 hover:bg-mint-500/30 transition-all font-medium shrink-0"
          >
            <Sparkles className="w-3 h-3" /> Analyze
          </button>
        )}
        {customSymbols && (
          <button onClick={() => setCustomSymbols('')} disabled={loading} className="text-slate-500 hover:text-slate-300 shrink-0">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* ── Error ── */}
      {error && (
        <div className="flex items-center gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {error}
          {error.includes('ANTHROPIC_API_KEY') && (
            <span className="text-slate-500 text-xs ml-1">— Set ANTHROPIC_API_KEY in Railway env vars.</span>
          )}
        </div>
      )}

      {/* ── Loading skeleton ── */}
      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="glass rounded-2xl p-4 space-y-3 animate-pulse">
              <div className="flex gap-2">
                <div className="w-8 h-8 bg-white/[0.06] rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-4 bg-white/[0.06] rounded w-20" />
                  <div className="h-3 bg-white/[0.04] rounded w-28" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="h-10 bg-white/[0.04] rounded-lg" />
                <div className="h-10 bg-white/[0.04] rounded-lg" />
              </div>
              <div className="space-y-1.5">
                <div className="h-3 bg-white/[0.04] rounded w-full" />
                <div className="h-3 bg-white/[0.04] rounded w-4/5" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Empty state ── */}
      {!loading && !recs && !error && (
        <div className="glass rounded-2xl p-16 text-center space-y-4">
          <Sparkles className="w-12 h-12 text-mint-400/30 mx-auto" />
          <div>
            <p className="text-white font-semibold">Ready to generate recommendations</p>
            <p className="text-slate-500 text-sm mt-1">
              Claude will analyze current market conditions and suggest the best stocks, ETFs,
              and crypto for 3-month and 6-month holding periods.
            </p>
            {holdings.length > 0 && (
              <p className="text-xs text-slate-600 mt-2">
                Portfolio holdings ({holdings.length}) will be excluded from picks to avoid overlap.
              </p>
            )}
          </div>
          <button onClick={generate} className="btn-primary flex items-center gap-2 mx-auto">
            <Sparkles className="w-4 h-4" /> Generate Picks
          </button>
        </div>
      )}

      {/* ── Results ── */}
      {!loading && recs && (
        <>
          {/* Persona used */}
          {recs.persona && recs.persona.id !== 'default' && (
            <div className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/[0.08]">
              <span className="text-xl">{recs.persona.emoji}</span>
              <div>
                <span className="text-xs font-semibold text-white">{recs.persona.name}</span>
                <span className="text-xs text-slate-500 ml-2">· {recs.persona.style} · Recommendations styled to this investor's philosophy</span>
              </div>
            </div>
          )}

          {/* Macro regime banner */}
          {recs.macroRegime && (
            <MacroBanner regime={recs.macroRegime} signals={recs.macroRegime.signals} />
          )}

          {/* Market outlook banner */}
          <div className="glass rounded-xl p-4 border border-white/[0.06]">
            <div className="flex items-start gap-3">
              <TrendingUp className="w-4 h-4 text-mint-400 mt-0.5 shrink-0" />
              <div>
                <div className="text-xs font-semibold text-mint-400 mb-1">Market Outlook</div>
                <p className="text-sm text-slate-300">{recs.marketOutlook}</p>
                {recs.keyRisks && (
                  <div className="flex items-start gap-1.5 mt-2">
                    <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-400/80">{recs.keyRisks}</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Type filter */}
            <div className="flex gap-1 flex-wrap">
              {['all','Stock','ETF','Crypto','Fund'].map(f => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    filter === f
                      ? 'bg-mint-500/20 text-mint-400 border border-mint-500/30'
                      : 'bg-white/[0.03] text-slate-400 hover:text-white border border-white/[0.06]'
                  }`}
                >
                  {f === 'all' ? `All (${recs.recommendations.length})` : `${TYPE_CONFIG[f]?.emoji} ${f} (${counts[f] || 0})`}
                </button>
              ))}
            </div>

            <div className="w-px h-4 bg-white/[0.08] hidden sm:block" />

            {/* Period filter */}
            <div className="flex gap-1">
              {['all','3m','6m'].map(p => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1 ${
                    period === p
                      ? 'bg-mint-500/20 text-mint-400 border border-mint-500/30'
                      : 'bg-white/[0.03] text-slate-400 hover:text-white border border-white/[0.06]'
                  }`}
                >
                  <Clock className="w-3 h-3" />
                  {p === 'all' ? 'All Periods' : p === '3m' ? `3-Month (${counts['3m'] || 0})` : `6-Month (${counts['6m'] || 0})`}
                </button>
              ))}
            </div>

            <div className="ml-auto text-[10px] text-slate-600">
              Generated {new Date(recs.generatedAt).toLocaleTimeString()}
            </div>
          </div>

          {/* Cards grid */}
          {displayed.length === 0 ? (
            <div className="glass rounded-xl p-8 text-center text-slate-500 text-sm">
              No recommendations match the selected filters.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {displayed.map((rec, i) => (
                <RecCard key={`${rec.symbol}-${i}`} rec={rec} onAnalyze={onAnalyze} liveQuote={liveQuotes[rec.symbol]} />
              ))}
            </div>
          )}

          {/* Disclaimer */}
          <div className="text-center text-[11px] text-slate-600 border-t border-white/[0.04] pt-3">
            AI-generated recommendations are for informational purposes only. Not financial advice.
            Past performance does not guarantee future results. Always do your own research.
          </div>
        </>
      )}
    </div>
  )
}
