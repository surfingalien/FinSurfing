// ── Portfolio backtest panel ─────────────────────────────────────────────────
// UI for POST /api/backtest/portfolio (utils/portfolio-backtest.js): multi-
// asset portfolio with target weights, rebalancing, optional stops, measured
// against a same-weights buy-and-hold benchmark.

import { useState } from 'react'
import { Play, AlertTriangle, Layers, TrendingUp, Shield, Repeat } from 'lucide-react'
import MetricCard from './MetricCard'
import EquityChart from './EquityChart'

const REBALANCE_MODES = [
  { id: 'monthly',   label: 'Monthly' },
  { id: 'quarterly', label: 'Quarterly' },
  { id: 'threshold', label: 'On 5% drift' },
  { id: 'none',      label: 'Never (buy & hold)' },
]

const inputCls = 'w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500/40'

export default function PortfolioBacktestPanel({ getApiKeyHeaders }) {
  const [symbolsText, setSymbolsText] = useState('NVDA, MSFT, GLD, TLT')
  const [range,       setRange]       = useState('2y')
  const [capital,     setCapital]     = useState(10000)
  const [rebalance,   setRebalance]   = useState('monthly')
  const [stopLoss,    setStopLoss]    = useState('')
  const [takeProfit,  setTakeProfit]  = useState('')
  const [loading,     setLoading]     = useState(false)
  const [error,       setError]       = useState(null)
  const [result,      setResult]      = useState(null)

  const symbols = symbolsText.split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 15)

  const run = async () => {
    if (symbols.length < 2) { setError('Enter at least 2 symbols (comma-separated)'); return }
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/backtest/portfolio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getApiKeyHeaders() },
        body: JSON.stringify({
          symbols, range, initialCapital: capital, rebalance,
          stopLossPct:   stopLoss   !== '' ? Math.abs(parseFloat(stopLoss))   : null,
          takeProfitPct: takeProfit !== '' ? Math.abs(parseFloat(takeProfit)) : null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setResult(data)
    } catch (e) { setError(e.message); setResult(null) }
    setLoading(false)
  }

  const m = result?.metrics, b = result?.benchmark
  const beat = m && b && m.totalReturn != null && b.totalReturn != null ? m.totalReturn - b.totalReturn : null

  return (
    <div className="space-y-5">
      {/* Config */}
      <div className="bg-white/[0.02] border border-white/[0.06] rounded-2xl p-5 space-y-4">
        <div className="grid sm:grid-cols-3 gap-4">
          <div className="sm:col-span-2">
            <label className="text-xs text-slate-500 block mb-1.5">Symbols (2–15, comma-separated — equal weight)</label>
            <input value={symbolsText} onChange={e => setSymbolsText(e.target.value)} className={inputCls}
              placeholder="NVDA, MSFT, GLD, TLT" />
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1.5">Range</label>
            <select value={range} onChange={e => setRange(e.target.value)} className={inputCls}>
              {['1y', '2y', '5y'].map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <label className="text-xs text-slate-500 block mb-1.5">Rebalance</label>
            <select value={rebalance} onChange={e => setRebalance(e.target.value)} className={inputCls}>
              {REBALANCE_MODES.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1.5">Stop-loss % (optional)</label>
            <input type="number" min="1" max="90" value={stopLoss} onChange={e => setStopLoss(e.target.value)}
              className={inputCls} placeholder="e.g. 15" />
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1.5">Take-profit % (optional)</label>
            <input type="number" min="1" max="500" value={takeProfit} onChange={e => setTakeProfit(e.target.value)}
              className={inputCls} placeholder="e.g. 40" />
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1.5">Initial capital</label>
            <input type="number" min="100" value={capital}
              onChange={e => setCapital(Math.max(100, parseInt(e.target.value) || 10000))} className={inputCls} />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={run} disabled={loading || symbols.length < 2}
            className="btn-primary flex items-center gap-2 text-sm disabled:opacity-50">
            <Play className="w-4 h-4" /> {loading ? 'Running…' : 'Run Portfolio Backtest'}
          </button>
          <span className="text-[11px] text-slate-600">
            Benchmark: same weights, buy &amp; hold — answers “did rebalancing/stops add value?”
          </span>
        </div>
        {error && (
          <p className="text-xs text-red-400 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" /> {error}
          </p>
        )}
      </div>

      {/* Results */}
      {result && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <MetricCard big icon={TrendingUp} label="Total Return"
              value={`${m.totalReturn >= 0 ? '+' : ''}${m.totalReturn}%`}
              positive={m.totalReturn >= 0}
              sub={`buy & hold: ${b.totalReturn >= 0 ? '+' : ''}${b.totalReturn}%`} />
            <MetricCard big icon={Layers} label="Vs Benchmark"
              value={beat != null ? `${beat >= 0 ? '+' : ''}${beat.toFixed(2)}%` : '—'}
              positive={beat != null ? beat >= 0 : undefined}
              sub={beat != null ? (beat >= 0 ? 'strategy added value' : 'buy & hold won') : null} />
            <MetricCard label="Sharpe" value={m.sharpeRatio ?? '—'}
              positive={m.sharpeRatio != null && b.sharpeRatio != null ? m.sharpeRatio >= b.sharpeRatio : undefined}
              sub={b.sharpeRatio != null ? `benchmark ${b.sharpeRatio}` : null} />
            <MetricCard label="Sortino" value={m.sortinoRatio ?? '—'}
              sub={b.sortinoRatio != null ? `benchmark ${b.sortinoRatio}` : null} />
            <MetricCard label="Max Drawdown" value={m.maxDrawdown != null ? `${m.maxDrawdown}%` : '—'}
              positive={m.maxDrawdown != null && b.maxDrawdown != null ? m.maxDrawdown >= b.maxDrawdown : undefined}
              sub={b.maxDrawdown != null ? `benchmark ${b.maxDrawdown}%` : null} />
            <MetricCard label="Volatility" value={m.volatility != null ? `${m.volatility}%` : '—'}
              sub={b.volatility != null ? `benchmark ${b.volatility}%` : null} />
            <MetricCard label="1-day VaR 95%" value={m.var95 != null ? `${m.var95}%` : '—'}
              sub={m.cvar95 != null ? `CVaR ${m.cvar95}%` : null} />
            <MetricCard icon={Repeat} label="Activity"
              value={`${result.activity.rebalances} rebal`}
              sub={`${result.activity.trades} trades · ${result.activity.stopsTriggered} stops · ${result.activity.takesTriggered} takes`} />
          </div>

          <EquityChart equity={result.equity} />

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
            <span className="flex items-center gap-1"><Shield className="w-3 h-3" />
              {result.days} trading days · {result.startDate} → {result.endDate}</span>
            <span>Weights: {Object.entries(result.weights).map(([s, w]) => `${s} ${(w * 100).toFixed(0)}%`).join(' · ')}</span>
            <span>Final value: ${result.finalValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
          </div>

          {result.trades?.length > 0 && (
            <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-4">
              <div className="text-xs font-semibold text-slate-400 mb-2">Recent Trades (last {Math.min(result.trades.length, 12)})</div>
              <div className="space-y-1">
                {result.trades.slice(-12).reverse().map((t, i) => (
                  <div key={i} className="flex items-center gap-3 text-[11px] font-mono">
                    <span className="text-slate-600 w-20 shrink-0">{t.date}</span>
                    <span className={`w-10 shrink-0 font-bold ${t.side === 'buy' ? 'text-mint-400' : 'text-red-400'}`}>{t.side.toUpperCase()}</span>
                    <span className="text-white w-14 shrink-0">{t.symbol}</span>
                    <span className="text-slate-400">{t.shares} @ ${t.price}</span>
                    <span className="text-slate-600 ml-auto">{t.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
