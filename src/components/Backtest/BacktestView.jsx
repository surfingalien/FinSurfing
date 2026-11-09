/**
 * BacktestView.jsx
 *
 * Strategy backtester: pick symbol + strategy + params, see equity curve,
 * trade log, and full performance metrics vs buy-and-hold.
 */

import { useState, useCallback } from 'react'
import {
  FlaskConical, Play, TrendingUp, TrendingDown, BarChart3,
  AlertTriangle, CheckCircle2, Clock, DollarSign, Percent, Info,
  Cpu, ListOrdered,
} from 'lucide-react'
import MetricCard from './parts/MetricCard'
import EquityChart from './parts/EquityChart'
import TradeLog from './parts/TradeLog'
import OptimizerPanel from './parts/OptimizerPanel'
import QueuePanel from './parts/QueuePanel'
import PortfolioBacktestPanel from './parts/PortfolioBacktestPanel'

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
  {
    id: 'donchian_breakout',
    label: 'Donchian Breakout',
    description: 'Buy a close above the prior N-day high, sell a close below the prior M-day low',
    params: [
      { key: 'entryPeriod', label: 'Breakout Lookback', type: 'number', default: 20, min: 10, max: 100 },
      { key: 'exitPeriod',  label: 'Exit Lookback',     type: 'number', default: 10, min: 5,  max: 50 },
    ],
  },
  {
    id: 'range_breakout_atr',
    label: 'Range Breakout + ATR Expansion',
    description: 'The same breakout, only on a day whose range is ≥ k × the prior ATR',
    params: [
      { key: 'entryPeriod', label: 'Breakout Lookback', type: 'number', default: 20, min: 10, max: 100 },
      { key: 'exitPeriod',  label: 'Exit Lookback',     type: 'number', default: 10, min: 5,  max: 50 },
      { key: 'atrPeriod',   label: 'ATR Period',        type: 'number', default: 14, min: 5,  max: 50 },
      { key: 'expansion',   label: 'Range ÷ ATR at least', type: 'number', default: 1.5, min: 1, max: 3, step: 0.25 },
    ],
  },
  {
    id: 'adx_trend',
    label: 'ADX Trend Filter',
    description: 'Long while ADX ≥ threshold, +DI above −DI and price above its average',
    params: [
      { key: 'period',    label: 'ADX Period',   type: 'number', default: 14, min: 5,  max: 50 },
      { key: 'threshold', label: 'ADX at least', type: 'number', default: 25, min: 15, max: 40 },
      { key: 'maPeriod',  label: 'Trend Average', type: 'number', default: 50, min: 10, max: 200 },
    ],
  },
]

const RANGES = [
  { value: '1y', label: '1 Year' },
  { value: '2y', label: '2 Years' },
  { value: '5y', label: '5 Years' },
]

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
  // Execution model (lib/execution-model.js): slippage beyond the flat cost and bracket exits like the paper broker's.
  const [slipModel,       setSlipModel]        = useState('none')
  const [maxPart,         setMaxPart]          = useState('')
  const [exitMode,        setExitMode]         = useState('signal')   // 'signal' | 'pct' | 'atr'
  const [exitVals,        setExitVals]         = useState({ stop: 8, t1: 10, target: 20, trail: '', hold: 63 })

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
        body: JSON.stringify({ symbol: sym, strategy: strategyId, params, range, initialCapital, ...executionBody() }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'Backtest failed')
      setResult(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [symbol, strategyId, range, initialCapital, paramValues, strategy, slipModel, maxPart, exitMode, exitVals])

  function executionBody() {
    const out = {}
    const mp = Number(maxPart)
    if (slipModel !== 'none' || mp > 0) out.slippage = { model: slipModel, ...(mp > 0 ? { maxParticipation: mp / 100 } : {}) }
    if (exitMode !== 'signal') {
      const v = k => (exitVals[k] === '' || exitVals[k] == null ? undefined : Number(exitVals[k]))
      const sfx = exitMode === 'atr' ? 'Atr' : 'Pct'
      out.exits = { [`stop${sfx}`]: v('stop'), [`t1${sfx}`]: v('t1'), [`target${sfx}`]: v('target'), trailPct: v('trail'), maxHoldBars: v('hold') }
    }
    return out
  }

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
          { id: 'backtest',  label: 'Backtest',  icon: <Play        className="w-3.5 h-3.5" /> },
          { id: 'portfolio', label: 'Portfolio', icon: <BarChart3   className="w-3.5 h-3.5" /> },
          { id: 'optimize',  label: 'Optimizer', icon: <Cpu         className="w-3.5 h-3.5" /> },
          { id: 'queue',     label: 'Queue',     icon: <ListOrdered className="w-3.5 h-3.5" /> },
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

        {/* Row 4: execution model */}
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-slate-500 mb-1.5 block">Slippage (on top of the round-trip cost)</label>
            <select value={slipModel} onChange={e => setSlipModel(e.target.value)}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500/50">
              <option value="none">None — flat cost only</option>
              <option value="range">Range — 10% of the previous day's high–low range</option>
              <option value="impact">Market impact — √(order ÷ average daily volume) × daily volatility</option>
            </select>
            <div className="flex items-center gap-2 mt-2">
              <label className="text-[10px] text-slate-600">Max share of daily volume per order (%)</label>
              <input type="number" value={maxPart} min={0.1} max={100} step={0.5} placeholder="no cap" onChange={e => setMaxPart(e.target.value)}
                className="w-24 bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-1 text-sm text-white font-mono" />
            </div>
            <p className="text-[10px] text-slate-600 mt-1">Uses only the days before each fill. Market impact matters with large capital or thinly traded stocks.</p>
          </div>
          <div>
            <label className="text-xs text-slate-500 mb-1.5 block">Exits</label>
            <select value={exitMode} onChange={e => setExitMode(e.target.value)}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500/50">
              <option value="signal">The strategy's sell signal only</option>
              <option value="pct">Bracket in % of entry (like the paper broker)</option>
              <option value="atr">Bracket in ATR multiples (wider for volatile stocks)</option>
            </select>
            {exitMode !== 'signal' && (
              <div className="flex flex-wrap gap-3 mt-2">
                {[['stop', exitMode === 'atr' ? 'Stop (ATR)' : 'Stop %'], ['t1', exitMode === 'atr' ? 'T1 — sell half (ATR)' : 'T1 % — sell half'], ['target', exitMode === 'atr' ? 'Target (ATR)' : 'Target %'], ['trail', 'Trailing stop %'], ['hold', 'Max days held']].map(([k, label]) => (
                  <div key={k} className="flex flex-col gap-1">
                    <label className="text-[10px] text-slate-600">{label}</label>
                    <input type="number" value={exitVals[k]} min={0} step={k === 'hold' ? 1 : 0.5} placeholder="off"
                      onChange={e => setExitVals(v => ({ ...v, [k]: e.target.value }))}
                      className="w-24 bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-sm text-white font-mono" />
                  </div>
                ))}
              </div>
            )}
            {exitMode !== 'signal' && <p className="text-[10px] text-slate-600 mt-1">After T1 the stop moves to breakeven. A day that touches both the stop and a target counts as the stop; a gap past a level fills at the open.</p>}
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
              {m.costBps != null && (
                <> · {m.fill === 'close' ? 'same-bar fills' : 'next-bar fills'} · {m.costBps}bps round-trip costs (${(m.costPaid ?? 0).toLocaleString()} paid)</>
              )}
              {m.slippage && <> · {m.slippage} slippage (${(m.slippagePaid ?? 0).toLocaleString()}){m.partialFills ? ` · ${m.partialFills} orders cut by the volume cap` : ''}{m.capUnavailable ? ` · volume cap not applied on ${m.capUnavailable} orders (no volume data)` : ''}</>}
              {m.exitsByKind && Object.keys(m.exitsByKind).length > 0 && <> · exits: {Object.entries(m.exitsByKind).map(([k, v]) => `${k} ×${v}`).join(', ')}</>}
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
              sub="annualised, rf=4.5%"
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

      {tab === 'portfolio' && <PortfolioBacktestPanel getApiKeyHeaders={getApiKeyHeaders} />}

      {tab === 'queue' && <QueuePanel />}
    </div>
  )
}
