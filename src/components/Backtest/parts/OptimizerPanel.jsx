import { useState, useEffect } from 'react'
import { Cpu, AlertTriangle } from 'lucide-react'

// ── Optimizer results table ───────────────────────────────────────────────────
const SORT_OPTIONS = [
  { value: 'sharpeRatio',    label: 'Sharpe' },
  { value: 'totalReturn',    label: 'Return' },
  { value: 'winRate',        label: 'Win Rate' },
  { value: 'maxDrawdown',    label: 'Drawdown ↑' },
  { value: 'profitFactor',   label: 'Prof. Factor' },
]

export default function OptimizerPanel({ strategy, symbol, range, initialCapital, getApiKeyHeaders }) {
  const [paramRanges, setParamRanges] = useState(() => {
    const r = {}
    for (const p of strategy.params) {
      r[p.key] = { min: p.min, max: Math.min(p.min + (p.max - p.min) / 2, p.max), step: p.step ?? 1 }
    }
    return r
  })
  const [sortBy,   setSortBy]   = useState('sharpeRatio')
  const [results,  setResults]  = useState(null)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState(null)
  const [combos,   setCombos]   = useState(0)

  // Estimate combinations
  useEffect(() => {
    const n = Object.values(paramRanges).reduce((acc, { min, max, step }) => {
      return acc * (Math.max(1, Math.ceil((max - min) / step) + 1))
    }, 1)
    setCombos(n)
  }, [paramRanges])

  const setRange_ = (key, field, val) =>
    setParamRanges(r => ({ ...r, [key]: { ...r[key], [field]: +val } }))

  const optimize = async () => {
    const sym = symbol.trim().toUpperCase()
    if (!sym) return
    setLoading(true); setError(null); setResults(null)
    try {
      const r = await fetch('/api/backtest/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getApiKeyHeaders() },
        body: JSON.stringify({ symbol: sym, strategy: strategy.id, paramRanges, range, initialCapital, sortBy }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'Optimization failed')
      setResults(data)
    } catch (e) {
      setError(e.message)
    }
    setLoading(false)
  }

  const top = results?.results ?? []
  const paramKeys = strategy.params.map(p => p.key)

  return (
    <div className="space-y-4 pt-2">
      <div className="text-xs text-slate-500 flex items-center gap-2">
        <Cpu className="w-3.5 h-3.5 text-indigo-400" />
        Grid-search all parameter combinations for <strong className="text-white">{symbol || '—'}</strong> · {range}
      </div>

      {/* Range inputs per param */}
      <div className="space-y-3">
        {strategy.params.map(p => {
          const pr = paramRanges[p.key] ?? { min: p.min, max: p.max, step: p.step ?? 1 }
          return (
            <div key={p.key} className="glass rounded-xl p-3 space-y-2">
              <div className="text-xs font-semibold text-slate-300">{p.label}</div>
              <div className="grid grid-cols-3 gap-2">
                {['min','max','step'].map(f => (
                  <div key={f} className="space-y-1">
                    <label className="text-[10px] text-slate-600 capitalize">{f}</label>
                    <input type="number" value={pr[f]}
                      onChange={e => setRange_(p.key, f, e.target.value)}
                      step={f === 'step' ? 1 : 1} min={f === 'step' ? 1 : p.min} max={p.max}
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-indigo-500/40" />
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* Sort + run */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-500">Sort by</label>
          <select value={sortBy} onChange={e => setSortBy(e.target.value)}
            className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500/40">
            {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <span className="text-[10px] text-slate-600">~{combos} combinations</span>
        {combos > 3000 && <span className="text-[10px] text-amber-400">⚠ Too many — reduce range</span>}
        <button onClick={optimize} disabled={loading || combos > 3000}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 text-white text-xs font-semibold rounded-lg transition-colors ml-auto">
          <Cpu className="w-3.5 h-3.5" />
          {loading ? 'Optimizing…' : 'Run Optimizer'}
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {error}
        </div>
      )}

      {/* Results table */}
      {top.length > 0 && (
        <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-white/[0.05] flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-400">Top {top.length} parameter sets</span>
            <span className="text-[10px] text-slate-600 ml-auto">sorted by {SORT_OPTIONS.find(o => o.value === sortBy)?.label}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-white/[0.05] text-slate-600">
                  <th className="px-3 py-2 text-left">#</th>
                  {paramKeys.map(k => <th key={k} className="px-3 py-2 text-right font-medium">{k}</th>)}
                  <th className="px-3 py-2 text-right font-medium">Return</th>
                  <th className="px-3 py-2 text-right font-medium">Sharpe</th>
                  <th className="px-3 py-2 text-right font-medium">Drawdown</th>
                  <th className="px-3 py-2 text-right font-medium">Win %</th>
                  <th className="px-3 py-2 text-right font-medium">Trades</th>
                </tr>
              </thead>
              <tbody>
                {top.map((r, i) => {
                  const m = r.metrics
                  const isTop = i === 0
                  return (
                    <tr key={i} className={`border-t border-white/[0.03] ${isTop ? 'bg-indigo-500/5' : 'hover:bg-white/[0.02]'}`}>
                      <td className="px-3 py-2 font-mono text-slate-500">{i + 1}</td>
                      {paramKeys.map(k => (
                        <td key={k} className="px-3 py-2 font-mono text-right text-slate-300">{r.params[k]}</td>
                      ))}
                      <td className={`px-3 py-2 font-mono text-right font-semibold ${m.totalReturn >= 0 ? 'text-mint-400' : 'text-red-400'}`}>
                        {m.totalReturn >= 0 ? '+' : ''}{m.totalReturn}%
                      </td>
                      <td className={`px-3 py-2 font-mono text-right ${m.sharpeRatio > 1 ? 'text-emerald-400' : m.sharpeRatio > 0 ? 'text-amber-400' : 'text-red-400'}`}>
                        {m.sharpeRatio}
                      </td>
                      <td className="px-3 py-2 font-mono text-right text-red-400">-{m.maxDrawdown}%</td>
                      <td className={`px-3 py-2 font-mono text-right ${m.winRate >= 50 ? 'text-emerald-400' : 'text-slate-400'}`}>
                        {m.winRate}%
                      </td>
                      <td className="px-3 py-2 font-mono text-right text-slate-500">{m.totalTrades}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
