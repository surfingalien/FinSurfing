import { useState, useEffect } from 'react'
import { LayoutGrid, RefreshCw, AlertTriangle } from 'lucide-react'
import { getApiKeyHeaders, fetchQuotes } from '../../services/api'

// Cap-tier ETF proxies
const CAP_ETFS = [
  { symbol: 'SPY',  label: 'S&P 500',    tier: 'Large Cap'  },
  { symbol: 'MDY',  label: 'Mid Cap 400', tier: 'Mid Cap'   },
  { symbol: 'IWM',  label: 'Russell 2000',tier: 'Small Cap' },
  { symbol: 'QQQ',  label: 'Nasdaq 100',  tier: 'Tech'      },
  { symbol: 'DIA',  label: 'Dow 30',      tier: 'Blue Chip' },
]

function pctColor(p) {
  if (p == null) return 'rgba(100,116,139,0.15)'
  if (p >= 3)   return 'rgba(16,185,129,0.85)'
  if (p >= 1.5) return 'rgba(16,185,129,0.55)'
  if (p >= 0.3) return 'rgba(52,211,153,0.30)'
  if (p >= -0.3) return 'rgba(100,116,139,0.22)'
  if (p >= -1.5) return 'rgba(248,113,113,0.30)'
  if (p >= -3)   return 'rgba(248,113,113,0.55)'
  return 'rgba(239,68,68,0.85)'
}

function pctText(p) {
  if (p == null) return 'text-slate-500'
  return p >= 0 ? 'text-emerald-300' : 'text-red-300'
}

function parseChangePct(raw) {
  if (raw == null) return null
  const s = String(raw).replace('%', '')
  const n = parseFloat(s)
  return isNaN(n) ? null : n
}

function HeatCell({ label, pct, sub }) {
  const bg  = pctColor(pct)
  const txt = pctText(pct)
  return (
    <div className="rounded-xl p-3 flex flex-col gap-1 border border-white/[0.04]" style={{ background: bg, minHeight: 72 }}>
      <div className="text-xs font-semibold text-white truncate">{label}</div>
      {sub && <div className="text-[10px] text-white/50 truncate">{sub}</div>}
      <div className={`text-sm font-bold font-mono mt-auto ${txt}`}>
        {pct != null ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : '—'}
      </div>
    </div>
  )
}

export default function HeatmapView() {
  const [sectors,    setSectors]    = useState([])
  const [industries, setIndustries] = useState([])
  const [capQuotes,  setCapQuotes]  = useState({})
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState(null)
  const [view,       setView]       = useState('sectors')  // 'sectors' | 'industries' | 'caps'

  const load = async () => {
    setLoading(true); setError(null)
    try {
      const [sectorRes, capRes] = await Promise.allSettled([
        fetch('/api/market-intel/sectors', { headers: getApiKeyHeaders() }).then(r => r.json()),
        fetchQuotes(CAP_ETFS.map(e => e.symbol)),
      ])

      if (sectorRes.status === 'fulfilled') {
        const d = sectorRes.value
        if (d.error) throw new Error(d.error)
        setSectors(
          (d.sectors || []).map(s => ({
            ...s,
            pct: parseChangePct(s.changesPercentage),
          })).sort((a, b) => (b.pct ?? -99) - (a.pct ?? -99))
        )
        setIndustries(
          (d.industries || []).map(i => ({
            ...i,
            pct: parseChangePct(i.changesPercentage),
          })).sort((a, b) => (b.pct ?? -99) - (a.pct ?? -99))
        )
      }

      if (capRes.status === 'fulfilled') {
        const map = {}
        ;(capRes.value || []).forEach(q => { if (q.symbol) map[q.symbol] = q })
        setCapQuotes(map)
      }
    } catch (e) { setError(e.message) }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const VIEWS = [
    { id: 'sectors',    label: `Sectors (${sectors.length})` },
    { id: 'industries', label: `Industries (${industries.length})` },
    { id: 'caps',       label: 'Cap Tiers' },
  ]

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2.5 rounded-xl bg-violet-500/10 border border-violet-500/20">
          <LayoutGrid className="w-5 h-5 text-violet-400" />
        </div>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-white">Market Heatmap</h1>
          <p className="text-xs text-slate-500">Sector &amp; industry performance · Cap tier breakdown</p>
        </div>
        <button onClick={load} disabled={loading}
          className="p-2 rounded-lg text-slate-500 hover:text-white hover:bg-white/[0.05] transition-colors disabled:opacity-40">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Tab row */}
      <div className="flex items-center gap-1 border-b border-white/[0.06] pb-0">
        {VIEWS.map(v => (
          <button key={v.id} onClick={() => setView(v.id)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-all ${
              view === v.id
                ? 'border-violet-500 text-violet-400'
                : 'border-transparent text-slate-400 hover:text-white'
            }`}>{v.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="flex items-center gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-violet-500/30 border-t-violet-400 rounded-full animate-spin" />
        </div>
      )}

      {/* Sectors view */}
      {!loading && view === 'sectors' && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2">
          {sectors.length === 0
            ? <p className="col-span-full text-center text-slate-600 py-12 text-sm">No data — FMP API key required</p>
            : sectors.map(s => (
                <HeatCell key={s.sector} label={s.sector} pct={s.pct} />
              ))
          }
        </div>
      )}

      {/* Industries view */}
      {!loading && view === 'industries' && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2">
          {industries.length === 0
            ? <p className="col-span-full text-center text-slate-600 py-12 text-sm">No data — FMP API key required</p>
            : industries.map(ind => (
                <HeatCell key={ind.industry} label={ind.industry} pct={ind.pct} />
              ))
          }
        </div>
      )}

      {/* Cap tiers view */}
      {!loading && view === 'caps' && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {CAP_ETFS.map(etf => {
            const q = capQuotes[etf.symbol]
            const pct = q?.changePct ?? null
            return (
              <HeatCell
                key={etf.symbol}
                label={etf.label}
                sub={etf.symbol}
                pct={pct}
              />
            )
          })}
        </div>
      )}

      {/* Legend */}
      <div className="flex items-center gap-3 text-[10px] text-slate-600 flex-wrap">
        <span className="font-semibold text-slate-500">Scale:</span>
        {[
          { label: '≥ +3%',  color: 'rgba(16,185,129,0.85)' },
          { label: '+1.5–3%',color: 'rgba(16,185,129,0.55)' },
          { label: '0–+1.5%',color: 'rgba(52,211,153,0.30)' },
          { label: '0',       color: 'rgba(100,116,139,0.22)' },
          { label: '0–-1.5%',color: 'rgba(248,113,113,0.30)' },
          { label: '-1.5–-3%',color:'rgba(248,113,113,0.55)' },
          { label: '≤ -3%',  color: 'rgba(239,68,68,0.85)' },
        ].map(l => (
          <span key={l.label} className="flex items-center gap-1">
            <span className="w-3 h-3 rounded inline-block" style={{ background: l.color }} />
            {l.label}
          </span>
        ))}
      </div>

      <div className="text-[10px] text-slate-600 text-center">
        Sector data via FMP · Cap tier data via Yahoo Finance · Delayed 15–20 min
      </div>
    </div>
  )
}
