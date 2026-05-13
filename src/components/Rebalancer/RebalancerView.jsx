/**
 * RebalancerView.jsx
 *
 * AI-powered portfolio rebalancer.
 * User adjusts target sector allocations with sliders → Claude streams a
 * concrete rebalancing plan with specific buy/sell/trim actions.
 */

import { useState, useRef, useEffect } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { usePortfolioContext } from '../../contexts/PortfolioContext'
import { usePortfolio } from '../../hooks/usePortfolio'
import {
  SlidersHorizontal, Sparkles, AlertTriangle, RotateCcw, Info, ChevronDown,
} from 'lucide-react'

const RISK_PROFILES = [
  { id: 'conservative', label: 'Conservative', desc: 'Capital preservation, lower volatility' },
  { id: 'moderate',     label: 'Moderate',     desc: 'Balanced growth and risk' },
  { id: 'aggressive',   label: 'Aggressive',   desc: 'Maximum growth, higher volatility' },
]

const SECTOR_COLORS = {
  'Technology':         '#6366f1',
  'Healthcare':         '#14b8a6',
  'Financial Services': '#f59e0b',
  'Consumer Cyclical':  '#ec4899',
  'Industrials':        '#60a5fa',
  'Communication Services': '#a78bfa',
  'Consumer Defensive': '#34d399',
  'Energy':             '#fb923c',
  'Utilities':          '#94a3b8',
  'Real Estate':        '#f87171',
  'Basic Materials':    '#fbbf24',
  'Unknown':            '#475569',
}

function colorFor(sector) {
  return SECTOR_COLORS[sector] || '#6366f1'
}

// ── Allocation slider row ─────────────────────────────────────────────────────

function SectorRow({ sector, current, target, onChange }) {
  const total = 100
  const diff  = target - current
  const color = colorFor(sector)
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-sm" style={{ background: color }} />
          <span className="text-slate-300">{sector}</span>
          <span className="text-slate-600 text-[10px]">now {current.toFixed(1)}%</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-mono ${diff > 0 ? 'text-mint-400' : diff < 0 ? 'text-red-400' : 'text-slate-500'}`}>
            {diff > 0 ? '+' : ''}{diff.toFixed(1)}%
          </span>
          <span className="font-mono font-semibold text-white w-10 text-right">{target}%</span>
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={target}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
        style={{ accentColor: color }}
      />
    </div>
  )
}

// ── Streamed markdown renderer (simple) ──────────────────────────────────────

function StreamedText({ text }) {
  return (
    <div className="text-sm text-slate-300 leading-relaxed space-y-3 whitespace-pre-wrap">
      {text}
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────

export default function RebalancerView() {
  const { authFetch, isAuthenticated, user } = useAuth()
  const { activePortfolioId } = usePortfolioContext()
  const portfolio = usePortfolio(
    isAuthenticated && activePortfolioId
      ? { userId: user?.id, activePortfolioId, authFetch }
      : { userId: null }
  )

  const [riskProfile, setRiskProfile] = useState('moderate')
  const [targets,     setTargets]     = useState({})
  const [streaming,   setStreaming]   = useState(false)
  const [plan,        setPlan]        = useState('')
  const [error,       setError]       = useState(null)
  const planRef = useRef(null)

  // Compute current sector breakdown from portfolio
  const sectorMap = {}
  let totalVal = 0
  for (const pos of portfolio.positions) {
    const q   = portfolio.quotes?.[pos.symbol]
    const price = q?.regularMarketPrice ?? pos.avgCost ?? 0
    const val   = pos.shares * price
    const sec   = pos.sector || 'Unknown'
    sectorMap[sec] = (sectorMap[sec] || 0) + val
    totalVal += val
  }
  const currentAlloc = Object.fromEntries(
    Object.entries(sectorMap).map(([s, v]) => [s, totalVal > 0 ? +((v / totalVal) * 100).toFixed(1) : 0])
  )
  const sectors = Object.keys(currentAlloc).sort()

  // Initialize targets from current on first load
  useEffect(() => {
    if (sectors.length > 0 && Object.keys(targets).length === 0) {
      const init = {}
      sectors.forEach(s => { init[s] = Math.round(currentAlloc[s]) })
      setTargets(init)
    }
  }, [sectors.join(',')])

  const getTarget = s => targets[s] ?? Math.round(currentAlloc[s] ?? 0)

  const totalTarget = sectors.reduce((sum, s) => sum + getTarget(s), 0)

  const reset = () => {
    const init = {}
    sectors.forEach(s => { init[s] = Math.round(currentAlloc[s]) })
    setTargets(init)
    setPlan('')
    setError(null)
  }

  const runRebalancer = async () => {
    if (streaming) return
    if (portfolio.positions.length === 0) {
      setError('No holdings in portfolio.'); return
    }

    const holdings = portfolio.positions.map(pos => {
      const q = portfolio.quotes?.[pos.symbol]
      return {
        symbol:       pos.symbol,
        shares:       pos.shares,
        currentPrice: q?.regularMarketPrice ?? pos.avgCost ?? 0,
        sector:       pos.sector || 'Unknown',
      }
    }).filter(h => h.currentPrice > 0)

    if (holdings.length === 0) {
      setError('No live prices available. Try refreshing.'); return
    }

    const targetAllocation = {}
    sectors.forEach(s => { targetAllocation[s] = getTarget(s) })

    setStreaming(true); setPlan(''); setError(null)

    try {
      const resp = await authFetch('/api/rebalancer/suggest', {
        method: 'POST',
        body:   { holdings, targetAllocation, riskProfile },
      })

      if (!resp.ok) {
        const d = await resp.json().catch(() => ({}))
        throw new Error(d.error || 'Rebalancer failed')
      }

      const reader  = resp.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const payload = line.slice(6)
          if (payload === '[DONE]') continue
          let obj
          try { obj = JSON.parse(payload) } catch { continue } // skip malformed lines
          if (obj.error) throw new Error(obj.error)            // propagate to outer catch
          if (obj.text)  setPlan(prev => prev + obj.text)
        }
        if (planRef.current) planRef.current.scrollTop = planRef.current.scrollHeight
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setStreaming(false)
    }
  }

  if (!isAuthenticated) {
    return (
      <div className="p-8 text-center text-slate-500 text-sm">
        Sign in to use the AI portfolio rebalancer.
      </div>
    )
  }

  if (portfolio.positions.length === 0) {
    return (
      <div className="p-8 text-center text-slate-500 text-sm">
        Add holdings to your portfolio to use the rebalancer.
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2.5 rounded-xl bg-mint-500/10 border border-mint-500/20">
          <SlidersHorizontal className="w-5 h-5 text-mint-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">AI Portfolio Rebalancer</h1>
          <p className="text-xs text-slate-500">Set target allocations · Claude generates a concrete action plan</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: config */}
        <div className="space-y-5">
          {/* Risk profile */}
          <div className="bg-white/[0.02] border border-white/[0.06] rounded-2xl p-5">
            <div className="text-xs font-semibold text-slate-400 mb-3">Risk Profile</div>
            <div className="space-y-2">
              {RISK_PROFILES.map(p => (
                <button
                  key={p.id}
                  onClick={() => setRiskProfile(p.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-xl border transition-all ${
                    riskProfile === p.id
                      ? 'bg-mint-500/10 border-mint-500/30 text-mint-300'
                      : 'bg-white/[0.02] border-white/[0.06] text-slate-400 hover:text-white hover:border-white/10'
                  }`}
                >
                  <div className="text-xs font-semibold">{p.label}</div>
                  <div className="text-[10px] text-slate-600">{p.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Target allocations */}
          <div className="bg-white/[0.02] border border-white/[0.06] rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="text-xs font-semibold text-slate-400">Target Allocation</div>
              <div className={`text-xs font-mono ${Math.abs(totalTarget - 100) > 5 ? 'text-amber-400' : 'text-mint-400'}`}>
                Total: {totalTarget}%
              </div>
            </div>
            {Math.abs(totalTarget - 100) > 5 && (
              <div className="flex items-center gap-2 text-xs text-amber-400 mb-3 p-2.5 rounded-lg bg-amber-500/8 border border-amber-500/20">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                Allocations should sum to ~100% for best results.
              </div>
            )}
            <div className="space-y-4">
              {sectors.map(s => (
                <SectorRow
                  key={s}
                  sector={s}
                  current={currentAlloc[s] ?? 0}
                  target={getTarget(s)}
                  onChange={val => setTargets(prev => ({ ...prev, [s]: val }))}
                />
              ))}
            </div>

            <div className="flex gap-2 mt-5">
              <button
                onClick={runRebalancer}
                disabled={streaming}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5
                           bg-mint-500 hover:bg-mint-400 disabled:opacity-50 disabled:cursor-not-allowed
                           text-[#070b14] text-sm font-bold rounded-xl transition-colors"
              >
                <Sparkles className="w-4 h-4" />
                {streaming ? 'Generating plan…' : 'Generate Plan'}
              </button>
              <button onClick={reset}
                className="px-3 py-2.5 rounded-xl border border-white/[0.08] text-slate-500
                           hover:text-white hover:border-white/10 transition-all">
                <RotateCcw className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Right: plan output */}
        <div className="bg-white/[0.02] border border-white/[0.06] rounded-2xl p-5 flex flex-col min-h-[400px]">
          <div className="flex items-center gap-2 mb-4">
            <Sparkles className="w-4 h-4 text-mint-400" />
            <span className="text-sm font-semibold text-white">Rebalancing Plan</span>
            {streaming && (
              <span className="ml-auto flex items-center gap-1 text-[10px] text-mint-400">
                <span className="w-1.5 h-1.5 rounded-full bg-mint-400 animate-pulse" />
                Generating
              </span>
            )}
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/25 text-red-400 text-xs mb-3">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />{error}
            </div>
          )}

          {!plan && !streaming && !error && (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-600 text-sm text-center gap-2">
              <SlidersHorizontal className="w-8 h-8 opacity-30" />
              <p>Adjust your target allocations and click<br />"Generate Plan" to get AI recommendations.</p>
            </div>
          )}

          {(plan || streaming) && (
            <div ref={planRef} className="flex-1 overflow-y-auto">
              <StreamedText text={plan} />
              {streaming && <span className="inline-block w-1.5 h-4 bg-mint-400 animate-pulse ml-0.5 align-middle" />}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-start gap-2 text-[10px] text-slate-600 p-3 rounded-lg bg-white/[0.02]">
        <Info className="w-3 h-3 mt-0.5 shrink-0" />
        AI recommendations are for informational purposes only. Not financial advice.
        Always consult a licensed financial professional before making investment decisions.
      </div>
    </div>
  )
}
