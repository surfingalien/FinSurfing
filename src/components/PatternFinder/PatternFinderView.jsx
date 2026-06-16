import { useState, useCallback } from 'react'
import { Search, AlertTriangle, ArrowRight } from 'lucide-react'
import { getApiKeyHeaders } from '../../services/api'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']

function fmtPct(value) {
  if (value == null || isNaN(value)) return '—'
  const v = Number(value)
  return (v >= 0 ? '+' : '') + v.toFixed(1) + '%'
}

function fmtMoneyShort(value) {
  if (value == null || isNaN(value)) return '—'
  const v = Number(value)
  const abs = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  return abs >= 1e9
    ? sign + '$' + (abs / 1e9).toFixed(1) + 'B'
    : abs >= 1e6
      ? sign + '$' + (abs / 1e6).toFixed(1) + 'M'
      : sign + '$' + abs.toFixed(0)
}

function monthColor(v) {
  const n = Number(v)
  if (n >= 2) return 'bg-emerald-500/30 text-emerald-300'
  if (n > 0) return 'bg-emerald-500/12 text-emerald-400'
  if (n > -2) return 'bg-red-500/12 text-red-400'
  return 'bg-red-500/30 text-red-300'
}

function sentimentStyle(s) {
  const v = String(s || '').toLowerCase()
  if (v.includes('buy')) return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
  if (v.includes('sell')) return 'bg-red-500/10 text-red-400 border-red-500/20'
  return 'bg-slate-500/10 text-slate-400 border-slate-500/20'
}

function trendStyle(t) {
  const v = String(t || '').toLowerCase()
  if (v.includes('increas')) return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
  if (v.includes('decreas')) return 'bg-red-500/10 text-red-400 border-red-500/20'
  return 'bg-slate-500/10 text-slate-400 border-slate-500/20'
}

function squeezeStyle(r) {
  const v = String(r || '').toLowerCase()
  if (v.includes('high')) return 'bg-amber-500/10 text-amber-400 border-amber-500/20'
  if (v.includes('low')) return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
  return 'bg-slate-500/10 text-slate-400 border-slate-500/20'
}

function Skeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="glass rounded-2xl p-4 border border-white/[0.06] h-24" />
      <div className="glass rounded-2xl p-4 border border-white/[0.06] h-48" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="glass rounded-2xl p-4 border border-white/[0.06] h-40" />
        <div className="glass rounded-2xl p-4 border border-white/[0.06] h-40" />
      </div>
    </div>
  )
}

export default function PatternFinderView({ onAnalyze }) {
  const [symbol, setSymbol] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const run = useCallback(async (e) => {
    e?.preventDefault()
    const sym = symbol.trim().toUpperCase()
    if (!sym) return
    setLoading(true)
    setError(null)
    setData(null)
    try {
      const res = await fetch(`/api/patterns/${encodeURIComponent(sym)}`, {
        headers: getApiKeyHeaders(),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Request failed (${res.status})`)
      }
      const json = await res.json()
      setData(json)
    } catch (err) {
      setError(err.message || 'Failed to analyze patterns')
    } finally {
      setLoading(false)
    }
  }, [symbol])

  const seasonal = data?.computed?.seasonalPatterns || data?.seasonalPatterns?.monthlyReturns || data?.monthlyReturns || []
  const dayOfWeek = data?.computed?.dayOfWeekPatterns || data?.dayOfWeekPatterns || data?.dayOfWeekReturns || []
  const insider = data?.computed?.insiderActivity || data?.insiderActivity || data?.insider || {}
  const institutional = data?.computed?.institutionalOwnership || data?.institutionalOwnership || data?.institutional || {}
  const shortInterest = data?.computed?.shortInterest || data?.shortInterest || {}

  const maxDay = Math.max(1, ...dayOfWeek.map(d => Math.abs(Number(d.avgReturn ?? d.return ?? 0))))

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center gap-3">
        <div className="p-2.5 rounded-xl bg-mint-500/10 border border-mint-500/20">
          <Search className="w-5 h-5 text-mint-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Pattern Finder</h1>
          <p className="text-xs text-slate-500">Quantitative pattern analysis — seasonal, insider, and statistical edge</p>
        </div>
      </div>

      <form onSubmit={run} className="glass rounded-2xl p-4 border border-white/[0.06]">
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="Enter symbol (e.g. NVDA)"
            className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-mint-500/40"
          />
          <button type="submit" disabled={loading} className="btn-primary flex items-center gap-2 disabled:opacity-50">
            <Search className="w-4 h-4" />
            {loading ? 'Analyzing…' : 'Analyze'}
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
          <div className="glass rounded-2xl p-4 border border-mint-500/20 bg-mint-500/[0.04]">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-mint-400">Statistical Edge</h2>
              <button
                onClick={() => onAnalyze?.(data.symbol || symbol.trim().toUpperCase())}
                className="text-xs text-slate-400 hover:text-mint-400 flex items-center gap-1"
              >
                {data.symbol || symbol.trim().toUpperCase()} <ArrowRight className="w-3 h-3" />
              </button>
            </div>
            {data.statisticalEdge && <p className="text-sm text-slate-200">{data.statisticalEdge}</p>}
            {Array.isArray(data.keyPatterns) && data.keyPatterns.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {data.keyPatterns.map((p, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-slate-300">
                    <span className="text-mint-400 mt-1">•</span>
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {seasonal.length > 0 && (
            <div className="glass rounded-2xl p-4 border border-white/[0.06]">
              <h2 className="text-sm font-semibold text-white mb-3">Seasonal Performance</h2>
              <div className="grid grid-cols-4 gap-2">
                {seasonal.slice(0, 12).map((m, i) => {
                  const ret = Number(m.avgReturn ?? m.return ?? 0)
                  const label = m.month ? (MONTHS[m.month - 1] || m.month) : MONTHS[i]
                  return (
                    <div key={i} className={`rounded-xl p-3 text-center ${monthColor(ret)}`}>
                      <div className="text-xs font-medium opacity-80">{label}</div>
                      <div className="font-mono font-bold text-sm mt-0.5">{fmtPct(ret)}</div>
                    </div>
                  )
                })}
              </div>
              <div className="flex flex-wrap gap-4 mt-4">
                {Array.isArray(data.bestMonths) && data.bestMonths.length > 0 && (
                  <div>
                    <div className="text-xs text-slate-500 mb-1.5">Best Months</div>
                    <div className="flex flex-wrap gap-1.5">
                      {data.bestMonths.map((m, i) => (
                        <span key={i} className="px-2.5 py-1 rounded-lg text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">{m}</span>
                      ))}
                    </div>
                  </div>
                )}
                {Array.isArray(data.worstMonths) && data.worstMonths.length > 0 && (
                  <div>
                    <div className="text-xs text-slate-500 mb-1.5">Worst Months</div>
                    <div className="flex flex-wrap gap-1.5">
                      {data.worstMonths.map((m, i) => (
                        <span key={i} className="px-2.5 py-1 rounded-lg text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20">{m}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {dayOfWeek.length > 0 && (
            <div className="glass rounded-2xl p-4 border border-white/[0.06]">
              <h2 className="text-sm font-semibold text-white mb-3">Day of Week Performance</h2>
              <div className="space-y-2.5">
                {dayOfWeek.slice(0, 5).map((d, i) => {
                  const ret = Number(d.avgReturn ?? d.return ?? 0)
                  const label = d.day || DAYS[i]
                  const width = (Math.abs(ret) / maxDay) * 100
                  const pos = ret >= 0
                  return (
                    <div key={i} className="flex items-center gap-3">
                      <span className="text-xs text-slate-400 w-10 shrink-0">{label}</span>
                      <div className="flex-1 h-5 rounded bg-white/[0.03] relative overflow-hidden">
                        <div
                          className={`h-full rounded ${pos ? 'bg-emerald-500/40' : 'bg-red-500/40'}`}
                          style={{ width: `${width}%` }}
                        />
                      </div>
                      <span className={`text-xs font-mono font-bold w-14 text-right ${pos ? 'text-emerald-400' : 'text-red-400'}`}>{fmtPct(ret)}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="glass rounded-2xl p-4 border border-white/[0.06]">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-white">Insider Activity</h2>
                {insider.sentiment && (
                  <span className={`px-2.5 py-1 rounded-lg text-xs font-semibold border ${sentimentStyle(insider.sentiment)}`}>{insider.sentiment}</span>
                )}
              </div>
              {insider.netValue90d != null && (
                <div className="mb-3 text-sm">
                  <span className="text-slate-500">Net 90-day: </span>
                  <span className={`font-mono font-bold ${Number(insider.netValue90d) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {fmtMoneyShort(insider.netValue90d)} {Number(insider.netValue90d) >= 0 ? 'bought' : 'sold'}
                  </span>
                </div>
              )}
              {Array.isArray(insider.recentTransactions || insider.transactions) && (insider.recentTransactions || insider.transactions).length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-slate-500 border-b border-white/[0.06]">
                        <th className="py-1.5 pr-3 font-medium">Date</th>
                        <th className="py-1.5 pr-3 font-medium">Insider</th>
                        <th className="py-1.5 pr-3 font-medium">Type</th>
                        <th className="py-1.5 pr-3 font-medium text-right">Shares</th>
                        <th className="py-1.5 font-medium text-right">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(insider.recentTransactions || insider.transactions).slice(0, 8).map((t, i) => (
                        <tr key={i} className="border-b border-white/[0.03]">
                          <td className="py-1.5 pr-3 text-slate-400">{t.date}</td>
                          <td className="py-1.5 pr-3 text-slate-300">{t.name || t.insider}</td>
                          <td className={`py-1.5 pr-3 ${String(t.type).toLowerCase().includes('buy') ? 'text-emerald-400' : 'text-red-400'}`}>{t.type}</td>
                          <td className="py-1.5 pr-3 text-right font-mono text-slate-300">{Number(t.shares || 0).toLocaleString()}</td>
                          <td className="py-1.5 text-right font-mono text-white">{fmtMoneyShort(t.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="glass rounded-2xl p-4 border border-white/[0.06]">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-white">Institutional Ownership</h2>
                {institutional.trend && (
                  <span className={`px-2.5 py-1 rounded-lg text-xs font-semibold border ${trendStyle(institutional.trend)}`}>{institutional.trend}</span>
                )}
              </div>
              {Array.isArray(institutional.topHolders) && institutional.topHolders.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-slate-500 border-b border-white/[0.06]">
                        <th className="py-1.5 pr-3 font-medium">Holder</th>
                        <th className="py-1.5 pr-3 font-medium text-right">Shares</th>
                        <th className="py-1.5 font-medium text-right">Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {institutional.topHolders.slice(0, 8).map((h, i) => (
                        <tr key={i} className="border-b border-white/[0.03]">
                          <td className="py-1.5 pr-3 text-slate-300">{h.holder || h.name}</td>
                          <td className="py-1.5 pr-3 text-right font-mono text-slate-300">{Number(h.shares || 0).toLocaleString()}</td>
                          <td className="py-1.5 text-right text-slate-400">{h.date}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className="glass rounded-2xl p-4 border border-white/[0.06]">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-white">Short Interest</h2>
              {shortInterest.squeezeRisk && (
                <span className={`px-2.5 py-1 rounded-lg text-xs font-semibold border ${squeezeStyle(shortInterest.squeezeRisk)}`}>
                  Squeeze Risk: {shortInterest.squeezeRisk}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="glass-card text-center">
                <div className="text-xs text-slate-500">Short Float</div>
                <div className="font-mono font-bold text-white text-lg">{shortInterest.shortFloat != null ? Number(shortInterest.shortFloat).toFixed(1) + '%' : '—'}</div>
              </div>
              <div className="glass-card text-center">
                <div className="text-xs text-slate-500">Short Ratio (days to cover)</div>
                <div className="font-mono font-bold text-white text-lg">{shortInterest.shortRatio != null ? Number(shortInterest.shortRatio).toFixed(1) : '—'}</div>
              </div>
            </div>
          </div>

          {Array.isArray(data.riskFactors) && data.riskFactors.length > 0 && (
            <div className="glass rounded-2xl p-4 border border-amber-500/20">
              <h2 className="text-sm font-semibold text-amber-400 mb-3 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" /> Risk Factors
              </h2>
              <ul className="space-y-2">
                {data.riskFactors.map((r, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-amber-400">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(data.earningsPatterns || data.correlationSignals) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {data.earningsPatterns && (
                <div className="glass rounded-2xl p-4 border border-white/[0.06]">
                  <h3 className="text-xs font-semibold text-slate-400 mb-2">Earnings Patterns</h3>
                  <p className="text-sm text-slate-300">{data.earningsPatterns}</p>
                </div>
              )}
              {data.correlationSignals && (
                <div className="glass rounded-2xl p-4 border border-white/[0.06]">
                  <h3 className="text-xs font-semibold text-slate-400 mb-2">Correlation Signals</h3>
                  <p className="text-sm text-slate-300">{data.correlationSignals}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
