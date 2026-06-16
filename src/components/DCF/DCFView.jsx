import { useState, useCallback } from 'react'
import { TrendingUp, AlertTriangle, ArrowRight } from 'lucide-react'
import { getApiKeyHeaders } from '../../services/api'

function fmtMoney(value) {
  if (value == null || isNaN(value)) return '—'
  const v = Number(value)
  return v >= 1e9
    ? '$' + (v / 1e9).toFixed(2) + 'B'
    : v >= 1e6
      ? '$' + (v / 1e6).toFixed(2) + 'M'
      : '$' + v.toFixed(2)
}

function fmtPct(value) {
  if (value == null || isNaN(value)) return '—'
  const v = Number(value)
  return (v >= 0 ? '+' : '') + v.toFixed(1) + '%'
}

function pctClass(value) {
  if (value == null || isNaN(value)) return 'text-slate-400'
  return Number(value) >= 0 ? 'text-emerald-400' : 'text-red-400'
}

function verdictStyle(verdict) {
  const v = String(verdict || '').toLowerCase()
  if (v.includes('under')) return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
  if (v.includes('over')) return 'bg-red-500/10 text-red-400 border-red-500/20'
  return 'bg-slate-500/10 text-slate-400 border-slate-500/20'
}

function Skeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="glass rounded-2xl p-4 border border-white/[0.06] h-28" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="glass rounded-2xl p-4 border border-white/[0.06] h-48" />
        <div className="glass rounded-2xl p-4 border border-white/[0.06] h-48" />
      </div>
      <div className="glass rounded-2xl p-4 border border-white/[0.06] h-40" />
    </div>
  )
}

export default function DCFView({ onAnalyze }) {
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
      const res = await fetch('/api/dcf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getApiKeyHeaders() },
        body: JSON.stringify({ symbol: sym }),
      })
      if (!res.ok) throw new Error(`Request failed (${res.status})`)
      const json = await res.json()
      setData(json)
    } catch (err) {
      setError(err.message || 'Failed to run DCF valuation')
    } finally {
      setLoading(false)
    }
  }, [symbol])

  const currentPrice = data?.currentPrice ?? 0

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center gap-3">
        <div className="p-2.5 rounded-xl bg-mint-500/10 border border-mint-500/20">
          <TrendingUp className="w-5 h-5 text-mint-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">DCF Valuation</h1>
          <p className="text-xs text-slate-500">Morgan Stanley-style discounted cash flow analysis</p>
        </div>
      </div>

      <form onSubmit={run} className="glass rounded-2xl p-4 border border-white/[0.06]">
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="Enter symbol (e.g. AAPL)"
            className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-mint-500/40"
          />
          <button type="submit" disabled={loading} className="btn-primary flex items-center gap-2 disabled:opacity-50">
            <TrendingUp className="w-4 h-4" />
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
          <div className="glass rounded-2xl p-5 border border-white/[0.06]">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <button
                  onClick={() => onAnalyze?.(data.symbol)}
                  className="text-lg font-bold text-white hover:text-mint-400 transition-colors flex items-center gap-1.5"
                >
                  {data.symbol}
                  <ArrowRight className="w-4 h-4" />
                </button>
                <div className="text-sm text-slate-400">{data.companyName || data.name}</div>
              </div>
              <div className="flex flex-wrap items-center gap-6">
                <div>
                  <div className="text-xs text-slate-500">Current Price</div>
                  <div className="font-mono font-bold text-white text-lg">{fmtMoney(currentPrice)}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">Blended Fair Value</div>
                  <div className="font-mono font-bold text-mint-400 text-lg">{fmtMoney(data.blendedValue ?? data.fairValue)}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">Upside</div>
                  <div className={`font-mono font-bold text-lg ${pctClass(data.upside)}`}>{fmtPct(data.upside)}</div>
                </div>
                <span className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${verdictStyle(data.verdict)}`}>
                  {data.verdict || 'Fairly Valued'}
                </span>
              </div>
            </div>
          </div>

          {Array.isArray(data.historicalData) && data.historicalData.length > 0 && (
            <div className="glass rounded-2xl p-4 border border-white/[0.06]">
              <h2 className="text-sm font-semibold text-white mb-3">Historical Financials</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-500 border-b border-white/[0.06]">
                      <th className="py-2 pr-4 font-medium">Year</th>
                      <th className="py-2 pr-4 font-medium text-right">Revenue</th>
                      <th className="py-2 pr-4 font-medium text-right">FCF</th>
                      <th className="py-2 font-medium text-right">FCF Margin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.historicalData.map((row, i) => (
                      <tr key={i} className="border-b border-white/[0.03]">
                        <td className="py-2 pr-4 text-slate-300">{row.year}</td>
                        <td className="py-2 pr-4 text-right font-mono text-white">{fmtMoney(row.revenue)}</td>
                        <td className="py-2 pr-4 text-right font-mono text-white">{fmtMoney(row.fcf)}</td>
                        <td className="py-2 text-right font-mono text-slate-300">{fmtPct(row.fcfMargin)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {Array.isArray(data.projections) && data.projections.length > 0 && (
            <div className="glass rounded-2xl p-4 border border-white/[0.06]">
              <h2 className="text-sm font-semibold text-white mb-3">5-Year Projections</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-500 border-b border-white/[0.06]">
                      <th className="py-2 pr-4 font-medium">Year</th>
                      <th className="py-2 pr-4 font-medium text-right">Revenue</th>
                      <th className="py-2 pr-4 font-medium text-right">Rev Growth</th>
                      <th className="py-2 pr-4 font-medium text-right">EBITDA Margin</th>
                      <th className="py-2 font-medium text-right">FCF</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.projections.map((row, i) => (
                      <tr key={i} className="border-b border-white/[0.03]">
                        <td className="py-2 pr-4 text-slate-300">{row.year}</td>
                        <td className="py-2 pr-4 text-right font-mono text-white">{fmtMoney(row.revenue)}</td>
                        <td className="py-2 pr-4 text-right font-mono text-slate-300">{fmtPct(row.revenueGrowth)}</td>
                        <td className="py-2 pr-4 text-right font-mono text-slate-300">{fmtPct(row.ebitdaMargin)}</td>
                        <td className="py-2 text-right font-mono text-white">{fmtMoney(row.fcf)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="glass rounded-2xl p-4 border border-white/[0.06]">
            <h2 className="text-sm font-semibold text-white mb-3">Valuation Summary</h2>
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="glass-card text-center">
                <div className="text-xs text-slate-500">WACC</div>
                <div className="font-mono font-bold text-white text-lg">{data.wacc != null ? data.wacc + '%' : '—'}</div>
              </div>
              <div className="glass-card text-center">
                <div className="text-xs text-slate-500">Terminal Growth</div>
                <div className="font-mono font-bold text-white text-lg">{data.terminalGrowthRate != null ? data.terminalGrowthRate + '%' : '—'}</div>
              </div>
              <div className="glass-card text-center">
                <div className="text-xs text-slate-500">Exit Multiple</div>
                <div className="font-mono font-bold text-white text-lg">{data.exitMultiple != null ? data.exitMultiple + 'x' : '—'}</div>
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm py-2 border-b border-white/[0.04]">
                <span className="text-slate-400">Perpetuity Method</span>
                <span className="flex items-center gap-2">
                  <span className="font-mono font-bold text-white">{fmtMoney(data.perpetuityValue)}</span>
                  <span className={`font-mono text-xs ${pctClass(data.perpetuityUpside)}`}>({fmtPct(data.perpetuityUpside)})</span>
                </span>
              </div>
              <div className="flex items-center justify-between text-sm py-2 border-b border-white/[0.04]">
                <span className="text-slate-400">Exit Multiple Method</span>
                <span className="flex items-center gap-2">
                  <span className="font-mono font-bold text-white">{fmtMoney(data.exitMultipleValue)}</span>
                  <span className={`font-mono text-xs ${pctClass(data.exitMultipleUpside)}`}>({fmtPct(data.exitMultipleUpside)})</span>
                </span>
              </div>
              <div className="flex items-center justify-between py-2">
                <span className="text-sm font-semibold text-white">Blended Fair Value</span>
                <span className="font-mono font-bold text-mint-400 text-2xl">{fmtMoney(data.blendedValue ?? data.fairValue)}</span>
              </div>
            </div>
          </div>

          {Array.isArray(data.sensitivity) && data.sensitivity.length > 0 && (
            <div className="glass rounded-2xl p-4 border border-white/[0.06]">
              <h2 className="text-sm font-semibold text-white mb-1">Sensitivity Table</h2>
              <p className="text-xs text-slate-500 mb-3">Fair value by discount rate (rows) vs terminal growth (columns)</p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-slate-500">
                      <th className="py-2 pr-3 font-medium text-left">Disc / Term</th>
                      {(data.sensitivity[0]?.cells || []).map((c, i) => (
                        <th key={i} className="py-2 px-3 font-medium text-center font-mono">{c.terminalGrowth}%</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.sensitivity.map((row, i) => (
                      <tr key={i}>
                        <td className="py-2 pr-3 text-slate-400 font-mono text-xs">{row.discountRate}%</td>
                        {(row.cells || []).map((cell, j) => {
                          const fv = cell.fairValue
                          const cls = fv > currentPrice * 1.2
                            ? 'bg-emerald-500/15 text-emerald-400'
                            : fv > currentPrice
                              ? 'bg-amber-500/15 text-amber-400'
                              : 'bg-red-500/15 text-red-400'
                          return (
                            <td key={j} className="py-1 px-1">
                              <div className={`rounded-lg py-2 text-center font-mono font-bold ${cls}`}>{fmtMoney(fv)}</div>
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {(data.bearCase != null || data.bullCase != null) && (
            <div className="glass rounded-2xl p-4 border border-white/[0.06]">
              <h2 className="text-sm font-semibold text-white mb-4">Bull / Bear Range</h2>
              {(() => {
                const bear = Number(data.bearCase ?? 0)
                const bull = Number(data.bullCase ?? 0)
                const fair = Number(data.blendedValue ?? data.fairValue ?? 0)
                const span = bull - bear || 1
                const pos = (v) => Math.max(0, Math.min(100, ((v - bear) / span) * 100))
                return (
                  <div>
                    <div className="relative h-2 rounded-full bg-gradient-to-r from-red-500/40 via-slate-500/40 to-emerald-500/40">
                      <div className="absolute -top-1 w-1 h-4 bg-white rounded" style={{ left: `${pos(currentPrice)}%` }} />
                      <div className="absolute -top-1 w-1 h-4 bg-mint-400 rounded" style={{ left: `${pos(fair)}%` }} />
                    </div>
                    <div className="flex items-center justify-between mt-3 text-xs">
                      <div className="text-red-400">
                        <div className="text-slate-500">Bear</div>
                        <div className="font-mono font-bold">{fmtMoney(bear)}</div>
                      </div>
                      <div className="text-white text-center">
                        <div className="text-slate-500">Current</div>
                        <div className="font-mono font-bold">{fmtMoney(currentPrice)}</div>
                      </div>
                      <div className="text-mint-400 text-center">
                        <div className="text-slate-500">Fair</div>
                        <div className="font-mono font-bold">{fmtMoney(fair)}</div>
                      </div>
                      <div className="text-emerald-400 text-right">
                        <div className="text-slate-500">Bull</div>
                        <div className="font-mono font-bold">{fmtMoney(bull)}</div>
                      </div>
                    </div>
                  </div>
                )
              })()}
            </div>
          )}

          {Array.isArray(data.keyAssumptions) && data.keyAssumptions.length > 0 && (
            <div className="glass rounded-2xl p-4 border border-white/[0.06]">
              <h2 className="text-sm font-semibold text-white mb-3">Key Assumptions</h2>
              <ul className="space-y-2">
                {data.keyAssumptions.map((a, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-slate-300">
                    <span className="text-mint-400 mt-1">•</span>
                    <span>{a}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {Array.isArray(data.modelBreakers) && data.modelBreakers.length > 0 && (
            <div className="glass rounded-2xl p-4 border border-red-500/20">
              <h2 className="text-sm font-semibold text-red-400 mb-3 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" /> Model Breakers
              </h2>
              <ul className="space-y-2">
                {data.modelBreakers.map((m, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-red-400">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>{m}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
