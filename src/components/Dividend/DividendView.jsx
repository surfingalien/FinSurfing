import { useState, useMemo, useCallback } from 'react'
import { DollarSign, AlertTriangle, ArrowRight } from 'lucide-react'
import { getApiKeyHeaders } from '../../services/api'

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'safe', label: 'Safe (7+)' },
  { id: 'moderate', label: 'Moderate (4-6)' },
  { id: 'risky', label: 'Risky (<4)' },
]

function fmtUsd(value) {
  if (value == null || isNaN(value)) return '—'
  return '$' + Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

function safetyColor(score) {
  const s = Number(score)
  if (s >= 7) return 'bg-emerald-400'
  if (s >= 4) return 'bg-amber-400'
  return 'bg-red-400'
}

function safetyText(score) {
  const s = Number(score)
  if (s >= 7) return 'text-emerald-400'
  if (s >= 4) return 'text-amber-400'
  return 'text-red-400'
}

function recStyle(rec) {
  const v = String(rec || '').toLowerCase()
  if (v.includes('core') || v.includes('buy')) return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
  if (v.includes('monitor')) return 'bg-amber-500/10 text-amber-400 border-amber-500/20'
  if (v.includes('avoid')) return 'bg-red-500/10 text-red-400 border-red-500/20'
  return 'bg-slate-500/10 text-slate-400 border-slate-500/20'
}

function Skeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 animate-pulse">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="glass rounded-2xl p-4 border border-white/[0.06] h-56" />
      ))}
    </div>
  )
}

export default function DividendView({ onAnalyze }) {
  const [amount, setAmount] = useState(10000)
  const [goal, setGoal] = useState(500)
  const [customSymbols, setCustomSymbols] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('all')

  const run = useCallback(async (e) => {
    e?.preventDefault()
    setLoading(true)
    setError(null)
    setData(null)
    try {
      const symbols = customSymbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
      const res = await fetch('/api/dividend/screen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getApiKeyHeaders() },
        body: JSON.stringify({ investmentAmount: Number(amount) || 0, monthlyIncomeGoal: Number(goal) || 0, symbols }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Request failed (${res.status})`)
      }
      const json = await res.json()
      setData(json)
    } catch (err) {
      setError(err.message || 'Failed to screen dividends')
    } finally {
      setLoading(false)
    }
  }, [amount, goal, customSymbols])

  const summary = data?.portfolioSummary || data?.summary || {}
  const stocks = data?.stocks || []

  const filtered = useMemo(() => {
    return stocks.filter(s => {
      const score = Number(s.safetyScore)
      if (filter === 'safe') return score >= 7
      if (filter === 'moderate') return score >= 4 && score < 7
      if (filter === 'risky') return score < 4
      return true
    })
  }, [stocks, filter])

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center gap-3">
        <div className="p-2.5 rounded-xl bg-mint-500/10 border border-mint-500/20">
          <DollarSign className="w-5 h-5 text-mint-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Dividend Screener</h1>
          <p className="text-xs text-slate-500">Safety-scored dividend portfolio with DRIP projections</p>
        </div>
      </div>

      <form onSubmit={run} className="glass rounded-2xl p-4 border border-white/[0.06]">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
          <div>
            <label className="block text-xs text-slate-500 mb-1.5">Investment Amount ($)</label>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-mint-500/40"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1.5">Monthly Income Goal ($)</label>
            <input
              type="number"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-mint-500/40"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1.5">Custom Symbols (optional)</label>
            <input
              value={customSymbols}
              onChange={(e) => setCustomSymbols(e.target.value)}
              placeholder="KO, JNJ, O"
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-mint-500/40"
            />
          </div>
          <button type="submit" disabled={loading} className="btn-primary flex items-center gap-2 justify-center disabled:opacity-50">
            <DollarSign className="w-4 h-4" />
            {loading ? 'Screening…' : 'Screen'}
          </button>
        </div>
      </form>

      {error && (
        <div className="glass rounded-2xl p-4 border border-red-500/20 flex items-center gap-3 text-red-400">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <span className="text-sm">{error}</span>
        </div>
      )}

      {loading && <Skeleton />}

      {data && !loading && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <div className="glass-card text-center">
              <div className="text-xs text-slate-500">Total Annual Income</div>
              <div className="font-mono font-bold text-emerald-400 text-lg">{fmtUsd(summary.totalAnnualIncome)}</div>
            </div>
            <div className="glass-card text-center">
              <div className="text-xs text-slate-500">Monthly Income</div>
              <div className="font-mono font-bold text-white text-lg">{fmtUsd(summary.monthlyIncome)}</div>
            </div>
            <div className="glass-card text-center">
              <div className="text-xs text-slate-500">Average Yield</div>
              <div className="font-mono font-bold text-mint-400 text-lg">{(summary.avgYield ?? summary.averageYield) != null ? Number(summary.avgYield ?? summary.averageYield).toFixed(1) + '%' : '—'}</div>
            </div>
            <div className="glass-card text-center">
              <div className="text-xs text-slate-500">Avg Safety Score</div>
              <div className="font-mono font-bold text-white text-lg">{(summary.avgSafetyScore ?? summary.averageSafetyScore) != null ? Number(summary.avgSafetyScore ?? summary.averageSafetyScore).toFixed(1) + '/10' : '—'}</div>
            </div>
            <div className="glass-card text-center">
              <div className="text-xs text-slate-500">10-Year DRIP Value</div>
              <div className="font-mono font-bold text-emerald-400 text-lg">{fmtUsd(summary.drip10yr ?? summary.dripValue10yr)}</div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {FILTERS.map(f => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  filter === f.id
                    ? 'bg-mint-500/10 text-mint-400 border-mint-500/20'
                    : 'bg-white/[0.03] text-slate-400 border-white/[0.06] hover:text-white'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filtered.map((s, i) => (
              <div key={i} className="glass rounded-2xl p-4 border border-white/[0.06] flex flex-col">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <button
                      onClick={() => onAnalyze?.(s.symbol)}
                      className="font-bold text-white hover:text-mint-400 transition-colors flex items-center gap-1"
                    >
                      {s.symbol} <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                    <div className="text-xs text-slate-500 truncate">{s.name}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-mono font-bold text-emerald-400 text-2xl leading-none">{(s.currentYield ?? s.yield) != null ? Number(s.currentYield ?? s.yield).toFixed(1) + '%' : '—'}</div>
                    <div className="text-xs text-slate-500">yield</div>
                  </div>
                </div>

                <div className="flex items-center gap-2 mt-3">
                  <span className={`w-2.5 h-2.5 rounded-full ${safetyColor(s.safetyScore)}`} />
                  <span className="text-xs text-slate-400">Safety</span>
                  <span className={`text-sm font-mono font-bold ${safetyText(s.safetyScore)}`}>{s.safetyScore != null ? Number(s.safetyScore).toFixed(0) + '/10' : '—'}</span>
                </div>

                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 mt-3 text-xs">
                  <div className="flex justify-between"><span className="text-slate-500">Growth yrs</span><span className="text-slate-300 font-mono">{(s.consecutiveGrowthYears ?? s.consecutiveYearsGrowth) ?? '—'}</span></div>
                  {s.payoutRatio != null && (
                    <div className="flex justify-between"><span className="text-slate-500">Payout</span><span className="text-slate-300 font-mono">{Number(s.payoutRatio).toFixed(0)}%</span></div>
                  )}
                  <div className="flex justify-between"><span className="text-slate-500">5yr growth</span><span className="text-slate-300 font-mono">{(s.dividendGrowthRate5yr ?? s.dividendGrowth5yr) != null ? Number(s.dividendGrowthRate5yr ?? s.dividendGrowth5yr).toFixed(1) + '%' : '—'}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">Inc / $1k</span><span className="text-slate-300 font-mono">{s.currentYield != null ? '$' + (s.currentYield / 100 * 1000).toFixed(0) : s.incomePer1000 != null ? '$' + Number(s.incomePer1000).toFixed(0) : '—'}</span></div>
                </div>

                <div className="flex flex-wrap items-center gap-2 mt-3">
                  {s.recommendation && (
                    <span className={`px-2.5 py-1 rounded-lg text-xs font-semibold border ${recStyle(s.recommendation)}`}>{s.recommendation}</span>
                  )}
                  {s.risk && (
                    <span className="px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">{s.risk}</span>
                  )}
                </div>

                {s.thesis && <p className="text-xs text-slate-400 mt-3 leading-relaxed">{s.thesis}</p>}
              </div>
            ))}
          </div>

          {filtered.length === 0 && (
            <div className="glass rounded-2xl p-8 border border-white/[0.06] text-center text-sm text-slate-500">
              No stocks match this filter.
            </div>
          )}

          <p className="text-xs text-slate-600 text-center pt-2">
            Dividend projections are estimates based on historical data and assume reinvestment (DRIP). Past performance does not guarantee future results. Not financial advice.
          </p>
        </div>
      )}
    </div>
  )
}
