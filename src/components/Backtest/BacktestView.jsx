/**
 * BacktestView.jsx
 *
 * Strategy backtester: pick symbol + strategy + params, see equity curve,
 * trade log, and full performance metrics vs buy-and-hold.
 */

import { useState, useCallback, useEffect } from 'react'
import {
  FlaskConical, Play, TrendingUp, TrendingDown, BarChart3,
  AlertTriangle, CheckCircle2, Clock, DollarSign, Percent, Info,
  Cpu, ListOrdered, Loader2, Trash2,
} from 'lucide-react'

// ── Strategy definitions ──────────────────────────────────────────────────────

const STRATEGIES = [
  {
    id: 'sma_crossover',
    label: 'SMA Crossover',
    description: 'Buy golden cross, sell death cross',
    params: [
      { key: 'fastPeriod', label: 'Fast Period', type: 'number', default: 20, min: 5, max: 50 },
      { key: 'slowPeriod', label: 'Slow Period', type: 'number', default: 50, min: 20, max: 200 },
    ],
  },
  {
    id: 'rsi_threshold',
    label: 'RSI Threshold',
    description: 'Buy oversold bounce, sell overbought',
    params: [
      { key: 'period',     label: 'RSI Period',  type: 'number', default: 14, min: 5, max: 30 },
      { key: 'oversold',   label: 'Oversold',    type: 'number', default: 30, min: 10, max: 45 },
      { key: 'overbought', label: 'Overbought',  type: 'number', default: 70, min: 55, max: 90 },
    ],
  },
  {
    id: 'macd_signal',
    label: 'MACD Signal',
    description: 'Buy MACD cross above signal, sell cross below',
    params: [
      { key: 'fast',   label: 'Fast EMA',   type: 'number', default: 12, min: 5,  max: 30 },
      { key: 'slow',   label: 'Slow EMA',   type: 'number', default: 26, min: 15, max: 60 },
      { key: 'signal', label: 'Signal EMA', type: 'number', default: 9,  min: 3,  max: 20 },
    ],
  },
  {
    id: 'bb_reversion',
    label: 'Bollinger Reversion',
    description: 'Buy lower band touch, sell upper band touch',
    params: [
      { key: 'period', label: 'Period', type: 'number', default: 20, min: 5,  max: 50 },
      { key: 'mult',   label: 'Std Dev Multiplier', type: 'number', default: 2, min: 1, max: 4, step: 0.5 },
    ],
  },
]

const RANGES = [
  { value: '1y', label: '1 Year' },
  { value: '2y', label: '2 Years' },
  { value: '5y', label: '5 Years' },
]

// ── Metric card ───────────────────────────────────────────────────────────────

function MetricCard({ label, value, sub, positive, icon: Icon, big }) {
  const color = positive === true  ? 'text-mint-400'
               : positive === false ? 'text-red-400'
               : 'text-white'
  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
      {Icon && <Icon className="w-3.5 h-3.5 text-slate-500 mb-2" />}
      <div className={`${big ? 'text-2xl' : 'text-lg'} font-bold font-mono ${color}`}>{value}</div>
      <div className="text-xs text-slate-500 mt-0.5">{label}</div>
      {sub && <div className="text-[10px] text-slate-600 mt-0.5">{sub}</div>}
    </div>
  )
}

// ── Mini equity chart (SVG sparkline) ────────────────────────────────────────

function EquityChart({ equity }) {
  if (!equity?.length) return null
  const values  = equity.map(e => e.value)
  const minV    = Math.min(...values)
  const maxV    = Math.max(...values)
  const range   = maxV - minV || 1
  const W = 600; const H = 140
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * W
    const y = H - ((v - minV) / range) * H
    return `${x},${y}`
  }).join(' ')

  const isUp = values.at(-1) >= values[0]

  return (
    <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-4">
      <div className="text-xs font-semibold text-slate-400 mb-3">Equity Curve</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-28" preserveAspectRatio="none">
        <defs>
          <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={isUp ? '#00ffcc' : '#f87171'} stopOpacity="0.15" />
            <stop offset="100%" stopColor={isUp ? '#00ffcc' : '#f87171'} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Fill */}
        <polygon
          points={`0,${H} ${pts} ${W},${H}`}
          fill="url(#eqGrad)"
        />
        {/* Line */}
        <polyline
          points={pts}
          fill="none"
          stroke={isUp ? '#00ffcc' : '#f87171'}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div className="flex justify-between text-[10px] text-slate-600 mt-1">
        <span>{equity[0]?.date}</span>
        <span>{equity.at(-1)?.date}</span>
      </div>
    </div>
  )
}

// ── Trade log ─────────────────────────────────────────────────────────────────

function TradeLog({ trades }) {
  if (!trades?.length) return null
  const sells = trades.filter(t => t.type === 'sell')
  return (
    <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-white/[0.05]">
        <span className="text-xs font-semibold text-slate-400">Trade Log</span>
        <span className="ml-2 text-[10px] text-slate-600">({sells.length} closed trades)</span>
      </div>
      <div className="max-h-64 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-[#0a0e1a] text-slate-600">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Date</th>
              <th className="px-4 py-2 text-right font-medium">Price</th>
              <th className="px-4 py-2 text-right font-medium">Shares</th>
              <th className="px-4 py-2 text-right font-medium">P&L %</th>
              <th className="px-4 py-2 text-right font-medium">Days</th>
            </tr>
          </thead>
          <tbody>
            {sells.map((t, i) => (
              <tr key={i} className="border-t border-white/[0.03] hover:bg-white/[0.02]">
                <td className="px-4 py-2 font-mono text-slate-400">
                  {t.date}
                  {t.open && <span className="ml-1 text-[9px] text-amber-400">OPEN</span>}
                </td>
                <td className="px-4 py-2 font-mono text-right text-white">${t.price}</td>
                <td className="px-4 py-2 font-mono text-right text-slate-400">{t.shares}</td>
                <td className={`px-4 py-2 font-mono text-right font-semibold ${t.pnl >= 0 ? 'text-mint-400' : 'text-red-400'}`}>
                  {t.pnl >= 0 ? '+' : ''}{t.pnl}%
                </td>
                <td className="px-4 py-2 font-mono text-right text-slate-500">{t.durationDays}d</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Optimizer results table ───────────────────────────────────────────────────
const SORT_OPTIONS = [
  { value: 'sharpeRatio',    label: 'Sharpe' },
  { value: 'totalReturn',    label: 'Return' },
  { value: 'winRate',        label: 'Win Rate' },
  { value: 'maxDrawdown',    label: 'Drawdown ↑' },
  { value: 'profitFactor',   label: 'Prof. Factor' },
]

function OptimizerPanel({ strategy, symbol, range, initialCapital, getApiKeyHeaders }) {
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

// ── Main view ─────────────────────────────────────────────────────────────────

export default function BacktestView() {
  const [tab,             setTab]             = useState('backtest')   // 'backtest' | 'optimize'
  const [symbol,          setSymbol]          = useState('AAPL')
  const [strategyId,      setStrategyId]       = useState('sma_crossover')
  const [range,           setRange]            = useState('1y')
  const [initialCapital,  setInitialCapital]   = useState(10000)
  const [paramValues,     setParamValues]      = useState({})
  const [result,          setResult]           = useState(null)
  const [loading,         setLoading]          = useState(false)
  const [error,           setError]            = useState(null)

  const strategy = STRATEGIES.find(s => s.id === strategyId)

  const getParam = (key, def) => paramValues[`${strategyId}_${key}`] ?? def

  const setParam = (key, val) =>
    setParamValues(prev => ({ ...prev, [`${strategyId}_${key}`]: val }))

  function getApiKeyHeaders() {
    try {
      const stored = JSON.parse(localStorage.getItem('finsurf_api_keys') || '{}')
      const h = {}
      if (stored.aisa?.trim())    h['x-aisa-key']    = stored.aisa.trim()
      if (stored.finnhub?.trim()) h['x-finnhub-key'] = stored.finnhub.trim()
      if (stored.fmp?.trim())     h['x-fmp-key']     = stored.fmp.trim()
      if (stored.td?.trim())      h['x-td-key']      = stored.td.trim()
      if (stored.av?.trim())      h['x-av-key']      = stored.av.trim()
      return h
    } catch { return {} }
  }

  const run = useCallback(async () => {
    const sym = symbol.trim().toUpperCase()
    if (!sym) return
    setLoading(true); setError(null); setResult(null)

    const params = {}
    strategy.params.forEach(p => { params[p.key] = Number(getParam(p.key, p.default)) })

    try {
      const r = await fetch('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getApiKeyHeaders() },
        body: JSON.stringify({ symbol: sym, strategy: strategyId, params, range, initialCapital }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'Backtest failed')
      setResult(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [symbol, strategyId, range, initialCapital, paramValues, strategy])

  const m = result?.metrics

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2.5 rounded-xl bg-indigo-500/10 border border-indigo-500/20">
          <FlaskConical className="w-5 h-5 text-indigo-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Strategy Backtester</h1>
          <p className="text-xs text-slate-500">Simulate strategies · Optimise parameters · Compare vs buy-and-hold</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-white/[0.06] pb-0">
        {[
          { id: 'backtest', label: 'Backtest',  icon: <Play        className="w-3.5 h-3.5" /> },
          { id: 'optimize', label: 'Optimizer', icon: <Cpu         className="w-3.5 h-3.5" /> },
          { id: 'queue',    label: 'Queue',     icon: <ListOrdered className="w-3.5 h-3.5" /> },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-all ${
              tab === t.id ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-slate-400 hover:text-white'
            }`}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {tab === 'backtest' && (<>
      {/* Config panel */}
      <div className="bg-white/[0.02] border border-white/[0.06] rounded-2xl p-5 space-y-5">
        {/* Row 1: symbol, range, capital */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="text-xs text-slate-500 mb-1.5 block">Symbol</label>
            <input
              value={symbol}
              onChange={e => setSymbol(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && run()}
              placeholder="AAPL"
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2
                         text-sm text-white placeholder-slate-600 focus:outline-none
                         focus:border-indigo-500/50 transition-colors font-mono"
            />
          </div>
          <div>
            <label className="text-xs text-slate-500 mb-1.5 block">Range</label>
            <select
              value={range}
              onChange={e => setRange(e.target.value)}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2
                         text-sm text-white focus:outline-none focus:border-indigo-500/50 transition-colors">
              {RANGES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-500 mb-1.5 block">Starting Capital ($)</label>
            <input
              type="number"
              value={initialCapital}
              onChange={e => setInitialCapital(Math.max(100, Number(e.target.value)))}
              min={100}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2
                         text-sm text-white focus:outline-none focus:border-indigo-500/50 transition-colors font-mono"
            />
          </div>
        </div>

        {/* Row 2: strategy picker */}
        <div>
          <label className="text-xs text-slate-500 mb-2 block">Strategy</label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {STRATEGIES.map(s => (
              <button
                key={s.id}
                onClick={() => setStrategyId(s.id)}
                className={`px-3 py-2.5 rounded-lg border text-left transition-all ${
                  strategyId === s.id
                    ? 'bg-indigo-500/15 border-indigo-500/40 text-indigo-300'
                    : 'bg-white/[0.03] border-white/[0.06] text-slate-400 hover:text-white hover:border-white/10'
                }`}
              >
                <div className="text-xs font-semibold">{s.label}</div>
                <div className="text-[10px] text-slate-600 mt-0.5">{s.description}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Row 3: strategy params */}
        <div>
          <label className="text-xs text-slate-500 mb-2 block">Parameters</label>
          <div className="flex flex-wrap gap-4">
            {strategy.params.map(p => (
              <div key={p.key} className="flex flex-col gap-1">
                <label className="text-[10px] text-slate-600">{p.label}</label>
                <input
                  type="number"
                  value={getParam(p.key, p.default)}
                  onChange={e => setParam(p.key, e.target.value)}
                  min={p.min}
                  max={p.max}
                  step={p.step ?? 1}
                  className="w-24 bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-1.5
                             text-sm text-white focus:outline-none focus:border-indigo-500/50 transition-colors font-mono"
                />
              </div>
            ))}
          </div>
        </div>

        {/* Run button */}
        <button
          onClick={run}
          disabled={loading}
          className="flex items-center gap-2 px-5 py-2.5 bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50
                     disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl transition-colors"
        >
          <Play className="w-4 h-4" />
          {loading ? 'Running…' : 'Run Backtest'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Results */}
      {result && m && (
        <div className="space-y-4">
          {/* Summary row */}
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <CheckCircle2 className="w-3.5 h-3.5 text-mint-400" />
            <span>
              {result.symbol} · {result.strategy.replace('_', ' ')} · {result.range} ·{' '}
              {result.dataPoints} days · ${result.initialCapital.toLocaleString()} capital
            </span>
          </div>

          {/* Metrics grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            <MetricCard
              label="Total Return"
              value={`${m.totalReturn >= 0 ? '+' : ''}${m.totalReturn}%`}
              sub={`Final: $${m.finalValue.toLocaleString()}`}
              positive={m.totalReturn >= 0}
              big
            />
            <MetricCard
              label="Buy & Hold"
              value={`${m.buyHoldReturn >= 0 ? '+' : ''}${m.buyHoldReturn}%`}
              sub={`Alpha: ${m.alpha >= 0 ? '+' : ''}${m.alpha}%`}
              positive={m.buyHoldReturn >= 0}
              big
            />
            <MetricCard
              label="Max Drawdown"
              value={`-${m.maxDrawdown}%`}
              positive={false}
              icon={TrendingDown}
            />
            <MetricCard
              label="Sharpe Ratio"
              value={m.sharpeRatio}
              sub="annualised, rf=5%"
              positive={m.sharpeRatio > 1}
              icon={BarChart3}
            />
            <MetricCard
              label="Win Rate"
              value={`${m.winRate}%`}
              sub={`${m.profitableTrades}/${m.totalTrades} trades`}
              positive={m.winRate >= 50}
              icon={Percent}
            />
            <MetricCard
              label="Avg Win"
              value={`+${m.avgWinPct}%`}
              positive={true}
              icon={TrendingUp}
            />
            <MetricCard
              label="Avg Loss"
              value={`${m.avgLossPct}%`}
              positive={false}
              icon={TrendingDown}
            />
            {m.profitFactor != null && (
              <MetricCard
                label="Profit Factor"
                value={m.profitFactor}
                sub="gross wins / gross losses"
                positive={m.profitFactor > 1}
                icon={DollarSign}
              />
            )}
            <MetricCard
              label="Calmar Ratio"
              value={m.calmarRatio}
              sub="ann. return / max drawdown"
              positive={m.calmarRatio > 0.5}
              icon={BarChart3}
            />
            <MetricCard
              label="Ann. Return"
              value={`${m.annualizedReturn >= 0 ? '+' : ''}${m.annualizedReturn}%`}
              positive={m.annualizedReturn >= 0}
              icon={TrendingUp}
            />
            <MetricCard
              label="Total Trades"
              value={m.totalTrades}
              icon={Clock}
            />
            {m.sortinoRatio != null && (
              <MetricCard
                label="Sortino Ratio"
                value={m.sortinoRatio}
                sub="downside risk-adjusted"
                positive={m.sortinoRatio > 1}
                icon={BarChart3}
              />
            )}
            {m.recoveryFactor != null && (
              <MetricCard
                label="Recovery Factor"
                value={m.recoveryFactor}
                sub="return / max drawdown"
                positive={m.recoveryFactor > 1}
                icon={TrendingUp}
              />
            )}
            {m.maxConsecWins != null && (
              <MetricCard
                label="Max Consec. Wins"
                value={m.maxConsecWins}
                positive={true}
                icon={CheckCircle2}
              />
            )}
            {m.maxConsecLoss != null && (
              <MetricCard
                label="Max Consec. Losses"
                value={m.maxConsecLoss}
                positive={false}
                icon={AlertTriangle}
              />
            )}
            {m.avgDurationDays != null && (
              <MetricCard
                label="Avg Trade Duration"
                value={`${m.avgDurationDays}d`}
                icon={Clock}
              />
            )}
          </div>

          {/* Equity chart */}
          <EquityChart equity={result.equity} />

          {/* Trade log */}
          <TradeLog trades={result.trades} />

          {/* Disclaimer */}
          <div className="flex items-start gap-2 text-[10px] text-slate-600 p-3 rounded-lg bg-white/[0.02]">
            <Info className="w-3 h-3 mt-0.5 shrink-0" />
            Past performance does not guarantee future results. No transaction costs or slippage are modelled.
            Fractional share buying assumed; positions sized to full shares.
          </div>
        </div>
      )}
      </>)}

      {tab === 'optimize' && (
        <OptimizerPanel
          strategy={strategy}
          symbol={symbol}
          range={range}
          initialCapital={initialCapital}
          getApiKeyHeaders={getApiKeyHeaders}
        />
      )}

      {tab === 'queue' && <QueuePanel />}
    </div>
  )
}

// ── Backtest Queue Panel ───────────────────────────────────────────────────────

const QUEUE_STRATEGY_IDS = ['sma_crossover', 'rsi_threshold', 'macd_signal', 'bb_reversion']
const QUEUE_RANGES       = ['1y', '2y', '5y']

function QueuePanel() {
  const [queueState, setQueueState] = useState({ pending: [], running: null, completedCount: 0 })
  const [results,    setResults]    = useState([])
  const [form, setForm] = useState({ symbol: '', strategy: 'sma_crossover', range: '1y', initialCapital: 10000 })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const [q, r] = await Promise.all([
        fetch('/api/backtest/queue').then(r => r.json()),
        fetch('/api/backtest/queue/results?limit=20').then(r => r.json()),
      ])
      setQueueState(q)
      setResults(r.results || [])
    } catch {}
  }, [])

  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t) }, [refresh])

  const submit = async () => {
    if (!form.symbol.trim()) return
    setSubmitting(true); setError(null)
    try {
      const r = await fetch('/api/backtest/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, symbol: form.symbol.toUpperCase() }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error)
      setForm(f => ({ ...f, symbol: '' }))
      refresh()
    } catch (e) { setError(e.message) } finally { setSubmitting(false) }
  }

  const cancel = async (id) => {
    await fetch(`/api/backtest/queue/${id}`, { method: 'DELETE' }).catch(() => {})
    refresh()
  }

  return (
    <div className="space-y-4 p-1">
      {/* Enqueue form */}
      <div className="glass rounded-xl border border-white/[0.08] p-4 space-y-3">
        <h3 className="text-sm font-semibold text-white">Queue a Backtest</h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <input value={form.symbol} onChange={e => setForm(f => ({ ...f, symbol: e.target.value.toUpperCase() }))}
            placeholder="Symbol (e.g. AAPL)"
            className="col-span-2 sm:col-span-1 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 outline-none focus:border-indigo-500/40" />
          <select value={form.strategy} onChange={e => setForm(f => ({ ...f, strategy: e.target.value }))}
            className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-2 text-sm text-white outline-none">
            {QUEUE_STRATEGY_IDS.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
          <select value={form.range} onChange={e => setForm(f => ({ ...f, range: e.target.value }))}
            className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-2 text-sm text-white outline-none">
            {QUEUE_RANGES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <button onClick={submit} disabled={submitting || !form.symbol.trim()}
            className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-500/15 border border-indigo-500/25 text-indigo-400 text-sm hover:bg-indigo-500/25 disabled:opacity-30 disabled:cursor-not-allowed transition-all">
            {submitting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            Enqueue
          </button>
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>

      {/* Queue status */}
      <div className="flex items-center gap-3 text-xs text-slate-500">
        <span className="flex items-center gap-1"><Clock size={11} /> {queueState.pending?.length || 0} pending</span>
        {queueState.running && <span className="flex items-center gap-1 text-indigo-400"><Loader2 size={11} className="animate-spin" /> Running: {queueState.running.job?.symbol} {queueState.running.job?.strategy}</span>}
        <span>{queueState.completedCount || 0} completed</span>
      </div>

      {/* Pending jobs */}
      {queueState.pending?.length > 0 && (
        <div className="space-y-1">
          {queueState.pending.map((p, i) => (
            <div key={p.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.06] text-xs">
              <span className="text-slate-400">#{i + 1} · <span className="text-white font-medium">{p.job.symbol}</span> · {p.job.strategy} · {p.job.range}</span>
              <button onClick={() => cancel(p.id)} className="text-slate-600 hover:text-red-400 transition-colors"><Trash2 size={12} /></button>
            </div>
          ))}
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Completed</h4>
          {results.map(r => (
            <div key={r.id} className={`rounded-xl border p-3 text-xs space-y-1 ${r.status === 'done' ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-red-500/20 bg-red-500/5'}`}>
              <div className="flex items-center justify-between">
                <span className="font-semibold text-white">{r.job.symbol} · {r.job.strategy} · {r.job.range}</span>
                <span className={r.status === 'done' ? 'text-emerald-400' : 'text-red-400'}>{r.status}</span>
              </div>
              {r.status === 'done' && r.result && (
                <div className="flex gap-4 text-slate-400">
                  <span>Return: <span className={r.result.totalReturnPct >= 0 ? 'text-emerald-400' : 'text-red-400'}>{r.result.totalReturnPct?.toFixed(1)}%</span></span>
                  <span>Trades: {r.result.totalTrades}</span>
                  <span>Win: {r.result.winRate?.toFixed(0)}%</span>
                  <span>MaxDD: {r.result.maxDrawdownPct?.toFixed(1)}%</span>
                </div>
              )}
              {r.status === 'failed' && <p className="text-red-400">{r.error}</p>}
              <span className="text-slate-600">{new Date(r.finishedAt).toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
