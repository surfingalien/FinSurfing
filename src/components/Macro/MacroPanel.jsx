/**
 * MacroPanel — compact macro indicator panel.
 * Fetches /api/macro/indicators and renders the key series grouped by category,
 * plus the AI-derived regime assessment.
 *
 * Props:
 *   compact  — if true renders a slim inline banner instead of the full grid
 */

import { TrendingUp, TrendingDown, Minus, RefreshCw, AlertTriangle, Globe } from 'lucide-react'
import { useQuery, fetchJson } from '../../hooks/useQuery'

const CATEGORY_LABELS = {
  rates:     '📈 Rates',
  inflation: '🔥 Inflation',
  labor:     '👷 Labor',
  growth:    '📊 Growth',
  sentiment: '💭 Sentiment',
  currency:  '💱 Currency',
  risk:      '⚡ Risk',
  housing:   '🏠 Housing',
  credit:    '💳 Credit',
}

const REGIME_STYLE = {
  red:     { bg: 'bg-red-500/10',     border: 'border-red-500/30',     text: 'text-red-400' },
  amber:   { bg: 'bg-amber-500/10',   border: 'border-amber-500/30',   text: 'text-amber-400' },
  emerald: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-400' },
  slate:   { bg: 'bg-white/[0.04]',   border: 'border-white/[0.08]',   text: 'text-slate-400' },
}

const SIGNAL_STYLE = {
  warning:  'text-red-400',
  caution:  'text-amber-400',
  positive: 'text-emerald-400',
}

function fmt(value, unit) {
  if (value == null) return '—'
  const n = typeof value === 'number' ? value : parseFloat(value)
  if (isNaN(n)) return '—'
  if (unit === 'pts' || unit === 'idx') return n.toFixed(1)
  if (unit === 'K') return (n > 0 ? '+' : '') + n.toLocaleString()
  return n.toFixed(2)
}

function Delta({ delta, unit }) {
  if (delta == null) return null
  const pos = delta >= 0
  return (
    <span className={`text-[9px] font-mono ${pos ? 'text-emerald-400' : 'text-red-400'} flex items-center gap-0.5`}>
      {pos ? <TrendingUp className="w-2.5 h-2.5" /> : <TrendingDown className="w-2.5 h-2.5" />}
      {pos ? '+' : ''}{delta.toFixed(2)}
    </span>
  )
}

/* ── Compact banner (used inside BuySignalsView) ─────────────────────────── */
export function MacroBanner({ regime, signals }) {
  if (!regime) return null
  const style = REGIME_STYLE[regime.regimeColor] ?? REGIME_STYLE.slate
  return (
    <div className={`rounded-xl p-3 border ${style.bg} ${style.border} flex items-start gap-3`}>
      <Globe className={`w-4 h-4 mt-0.5 shrink-0 ${style.text}`} />
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-xs font-bold ${style.text}`}>Macro: {regime.regime}</span>
          {signals?.slice(0, 2).map((s, i) => (
            <span key={i} className={`text-[10px] ${SIGNAL_STYLE[s.type] ?? 'text-slate-500'}`}>
              · {s.text}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ── Full panel ─────────────────────────────────────────────────────────── */
export default function MacroPanel() {
  // Server caches FRED for 1h — share one fetch app-wide and keep it for 10 min
  const { data, error: queryError, loading, refetch: load } = useQuery(
    'macro-indicators',
    () => fetchJson('/api/macro/indicators'),
    { staleMs: 10 * 60_000 },
  )
  const error = queryError?.message ?? null

  if (loading) return (
    <div className="glass rounded-xl p-6 flex items-center gap-3 text-slate-400 text-sm">
      <RefreshCw className="w-4 h-4 animate-spin" /> Loading macro indicators…
    </div>
  )

  if (error) return (
    <div className="glass rounded-xl p-4 border border-amber-500/20 flex items-start gap-3">
      <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
      <div>
        <p className="text-amber-400 text-sm font-medium">Macro data unavailable</p>
        <p className="text-slate-500 text-xs mt-0.5">{error}</p>
        {error.includes('FRED_API_KEY') && (
          <p className="text-slate-600 text-xs mt-1">
            Set <code className="text-mint-400">FRED_API_KEY</code> in Railway env vars to enable macro indicators
            (free key at <span className="text-mint-400">fred.stlouisfed.org/docs/api/api_key.html</span>)
          </p>
        )}
      </div>
    </div>
  )

  if (!data) return null

  const { indicators, regime, fetchedAt } = data
  const grouped = {}
  for (const ind of indicators) {
    if (!grouped[ind.category]) grouped[ind.category] = []
    grouped[ind.category].push(ind)
  }

  const regStyle = REGIME_STYLE[regime?.regimeColor] ?? REGIME_STYLE.slate

  return (
    <div className="space-y-4">
      {/* ── Regime badge ── */}
      <div className={`rounded-xl p-4 border ${regStyle.bg} ${regStyle.border}`}>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <div className="flex items-center gap-2">
              <Globe className={`w-4 h-4 ${regStyle.text}`} />
              <span className={`font-bold text-sm ${regStyle.text}`}>{regime?.regime}</span>
            </div>
            <div className="mt-2 space-y-1">
              {(regime?.signals ?? []).map((s, i) => (
                <div key={i} className={`text-xs flex items-start gap-1.5 ${SIGNAL_STYLE[s.type] ?? 'text-slate-500'}`}>
                  {s.type === 'warning' ? '⚠' : s.type === 'positive' ? '✓' : '·'} {s.text}
                </div>
              ))}
            </div>
          </div>
          <button onClick={load} className="text-slate-600 hover:text-slate-400 transition-colors">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ── Indicator grid ── */}
      {Object.entries(grouped).map(([cat, items]) => (
        <div key={cat}>
          <div className="text-xs font-semibold text-slate-500 mb-2">{CATEGORY_LABELS[cat] ?? cat}</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {items.map(ind => (
              <div key={ind.id} className="glass rounded-xl p-3 border border-white/[0.06]">
                <div className="text-[10px] text-slate-500 mb-1 truncate" title={ind.description}>{ind.label}</div>
                <div className="flex items-baseline gap-1.5">
                  <span className="font-mono font-bold text-white text-base">
                    {fmt(ind.value, ind.unit)}
                  </span>
                  <span className="text-[10px] text-slate-600">{ind.unit}</span>
                </div>
                <div className="flex items-center justify-between mt-1">
                  {ind.delta != null
                    ? <Delta delta={ind.delta} unit={ind.unit} />
                    : ind.changeLabel
                      ? <span className="text-[9px] text-slate-600">{ind.changeLabel}</span>
                      : <span />
                  }
                  <span className="text-[9px] text-slate-700">{ind.date?.slice(0, 7)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="text-[10px] text-slate-700 text-right">
        Source: FRED (Federal Reserve Bank of St. Louis) · Updated {fetchedAt ? new Date(fetchedAt).toLocaleTimeString() : '—'}
      </div>
    </div>
  )
}
