/**
 * RiskRulesView — composable pre-trade guardrails (StockSharp IRiskRule inspired).
 * Rules are stored in localStorage. Evaluation checks the live portfolio
 * against all active rules and surfaces violations as warnings.
 *
 * Rule types:
 *   max_position_size     — no single position > X% of total portfolio value
 *   max_drawdown          — portfolio is down > X% from its recorded peak
 *   max_sector_concentration — single sector > X% of portfolio
 *   min_cash_reserve      — cash position below X% of total value
 *   max_single_loss       — any position down > X% from cost basis
 *   max_portfolio_loss    — total portfolio unrealised loss > X%
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Shield, Plus, Trash2, ToggleLeft, ToggleRight,
  AlertTriangle, CheckCircle2, ChevronDown, ChevronUp,
  Info, Play, TrendingDown, Zap,
} from 'lucide-react'

const STORAGE_KEY = 'finsurf_risk_rules'
const PEAK_KEY    = 'finsurf_portfolio_peak'

// ── Rule type definitions ─────────────────────────────────────────────────────
const RULE_TYPES = [
  {
    id:          'max_position_size',
    label:       'Max Position Size',
    description: 'Flag any single holding that exceeds X% of total portfolio value.',
    unit:        '%',
    defaultValue: 15,
    min: 1, max: 50,
    icon:        '📊',
    evaluate(rule, portfolio) {
      const totalValue = portfolio.totalValue
      if (!totalValue) return null
      const violations = portfolio.positions
        .filter(p => (p.marketValue / totalValue) * 100 > rule.value)
        .map(p => `${p.symbol} is ${((p.marketValue / totalValue) * 100).toFixed(1)}% of portfolio (limit ${rule.value}%)`)
      return violations.length > 0 ? violations : null
    },
  },
  {
    id:          'max_drawdown',
    label:       'Max Portfolio Drawdown',
    description: 'Alert when portfolio value drops X% below its recorded peak.',
    unit:        '%',
    defaultValue: 15,
    min: 2, max: 50,
    icon:        '📉',
    evaluate(rule, portfolio) {
      const peak = parseFloat(localStorage.getItem(PEAK_KEY) || '0')
      const curr = portfolio.totalValue
      if (!peak || !curr) return null
      // Update peak if we're at a new high
      if (curr > peak) { localStorage.setItem(PEAK_KEY, String(curr)); return null }
      const dd = ((peak - curr) / peak) * 100
      if (dd >= rule.value) return [`Portfolio is down ${dd.toFixed(1)}% from peak $${peak.toFixed(0)} (limit ${rule.value}%)`]
      return null
    },
  },
  {
    id:          'max_sector_concentration',
    label:       'Max Sector Concentration',
    description: 'Flag when a single sector makes up more than X% of portfolio.',
    unit:        '%',
    defaultValue: 30,
    min: 10, max: 80,
    icon:        '🏭',
    evaluate(rule, portfolio) {
      const totalValue = portfolio.totalValue
      if (!totalValue) return null
      const sectorMap = {}
      for (const p of portfolio.positions) {
        const s = p.sector || 'Unknown'
        sectorMap[s] = (sectorMap[s] || 0) + (p.marketValue || 0)
      }
      const violations = Object.entries(sectorMap)
        .filter(([, v]) => (v / totalValue) * 100 > rule.value)
        .map(([s, v]) => `${s} sector is ${((v / totalValue) * 100).toFixed(1)}% of portfolio (limit ${rule.value}%)`)
      return violations.length > 0 ? violations : null
    },
  },
  {
    id:          'max_single_loss',
    label:       'Max Single Position Loss',
    description: 'Alert when any position is down more than X% from cost basis.',
    unit:        '%',
    defaultValue: 20,
    min: 5, max: 50,
    icon:        '🔴',
    evaluate(rule, portfolio) {
      const violations = portfolio.positions
        .filter(p => {
          if (p.avgCost == null || p.currentPrice == null) return false
          const loss = ((p.currentPrice - p.avgCost) / p.avgCost) * 100
          return loss < -rule.value
        })
        .map(p => {
          const loss = ((p.currentPrice - p.avgCost) / p.avgCost) * 100
          return `${p.symbol} is down ${Math.abs(loss).toFixed(1)}% from cost (limit ${rule.value}%)`
        })
      return violations.length > 0 ? violations : null
    },
  },
  {
    id:          'max_portfolio_loss',
    label:       'Max Portfolio Unrealised Loss',
    description: 'Alert when total unrealised P&L is worse than -X%.',
    unit:        '%',
    defaultValue: 10,
    min: 2, max: 40,
    icon:        '⚠️',
    evaluate(rule, portfolio) {
      const totalCost  = portfolio.positions.reduce((s, p) => s + (p.avgCost ?? 0) * (p.shares ?? 0), 0)
      const totalValue = portfolio.totalValue
      if (!totalCost || !totalValue) return null
      const loss = ((totalValue - totalCost) / totalCost) * 100
      if (loss < -rule.value)
        return [`Portfolio unrealised loss is ${loss.toFixed(1)}% (limit -${rule.value}%)`]
      return null
    },
  },
  {
    id:          'min_cash_reserve',
    label:       'Min Cash Reserve',
    description: 'Warn when cash position falls below X% of portfolio value.',
    unit:        '%',
    defaultValue: 5,
    min: 1, max: 30,
    icon:        '💵',
    evaluate(rule, portfolio) {
      const totalValue = portfolio.totalValue
      const cash       = portfolio.cash ?? 0
      if (!totalValue) return null
      const cashPct = (cash / totalValue) * 100
      if (cashPct < rule.value)
        return [`Cash reserve is ${cashPct.toFixed(1)}% of portfolio (minimum ${rule.value}%)`]
      return null
    },
  },
]

// ── Persistence helpers ───────────────────────────────────────────────────────
function loadRules() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') } catch { return [] }
}
function saveRules(rules) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rules))
}
function makeId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6) }

// ── Evaluate all active rules against current portfolio ───────────────────────
function evaluateAll(rules, portfolio) {
  if (!portfolio?.positions) return []
  const results = []
  for (const rule of rules) {
    if (!rule.active) continue
    const def = RULE_TYPES.find(t => t.id === rule.type)
    if (!def) continue
    const violations = def.evaluate(rule, portfolio)
    results.push({ rule, violations, ok: !violations })
  }
  return results
}

// ── Components ────────────────────────────────────────────────────────────────

function RuleCard({ rule, onToggle, onDelete, onEdit, evaluation }) {
  const def       = RULE_TYPES.find(t => t.id === rule.type)
  const violated  = evaluation?.violations?.length > 0
  const [expanded, setExpanded] = useState(false)

  return (
    <div className={`glass rounded-xl border transition-all ${
      violated ? 'border-red-500/40' : rule.active ? 'border-white/[0.08]' : 'border-white/[0.04] opacity-60'
    }`}>
      <div className="flex items-center gap-3 p-4">
        <span className="text-xl shrink-0">{def?.icon ?? '🛡️'}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-white">{def?.label ?? rule.type}</span>
            <span className={`text-xs font-mono px-2 py-0.5 rounded-full border font-bold ${
              violated
                ? 'bg-red-500/15 text-red-400 border-red-500/30'
                : rule.active
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                  : 'bg-white/[0.04] text-slate-600 border-white/[0.06]'
            }`}>
              {rule.value}{def?.unit} limit
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5 truncate">{def?.description}</p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {evaluation && !violated && rule.active && (
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          )}
          {violated && (
            <button onClick={() => setExpanded(v => !v)} className="text-red-400">
              <AlertTriangle className="w-4 h-4" />
            </button>
          )}
          <button onClick={() => onToggle(rule.id)}
            className="text-slate-400 hover:text-mint-400 transition-colors">
            {rule.active
              ? <ToggleRight className="w-5 h-5 text-mint-400" />
              : <ToggleLeft className="w-5 h-5 text-slate-600" />}
          </button>
          <button onClick={() => onDelete(rule.id)}
            className="text-slate-600 hover:text-red-400 transition-colors">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Violations detail */}
      {violated && expanded && (
        <div className="border-t border-red-500/20 px-4 py-3 space-y-1.5">
          {evaluation.violations.map((v, i) => (
            <div key={i} className="flex items-start gap-2 text-xs text-red-400">
              <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
              <span>{v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function AddRuleModal({ onAdd, onClose }) {
  const [selectedType, setSelectedType] = useState(RULE_TYPES[0].id)
  const [value, setValue]               = useState(RULE_TYPES[0].defaultValue)
  const def = RULE_TYPES.find(t => t.id === selectedType)

  const handleTypeChange = (id) => {
    setSelectedType(id)
    setValue(RULE_TYPES.find(t => t.id === id)?.defaultValue ?? 10)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="glass rounded-2xl p-6 w-full max-w-md mx-4 space-y-5 border border-white/[0.1]">
        <div className="flex items-center gap-3">
          <Shield className="w-5 h-5 text-mint-400" />
          <h2 className="text-base font-bold text-white">Add Risk Rule</h2>
        </div>

        {/* Type selector */}
        <div className="space-y-2">
          <label className="text-xs text-slate-400 font-medium">Rule Type</label>
          <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
            {RULE_TYPES.map(t => (
              <button
                key={t.id}
                onClick={() => handleTypeChange(t.id)}
                className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${
                  selectedType === t.id
                    ? 'border-mint-500/40 bg-mint-500/5'
                    : 'border-white/[0.06] bg-white/[0.02] hover:border-white/[0.12]'
                }`}
              >
                <span className="text-lg">{t.icon}</span>
                <div>
                  <div className="text-xs font-semibold text-white">{t.label}</div>
                  <div className="text-[10px] text-slate-500">{t.description}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Value input */}
        <div className="space-y-1.5">
          <label className="text-xs text-slate-400 font-medium">
            Threshold ({def?.unit ?? '%'})
          </label>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={def?.min ?? 1}
              max={def?.max ?? 50}
              step={1}
              value={value}
              onChange={e => setValue(+e.target.value)}
              className="flex-1 accent-mint-400"
            />
            <span className="font-mono text-lg font-bold text-mint-400 w-14 text-right">
              {value}{def?.unit}
            </span>
          </div>
        </div>

        <div className="flex gap-3 pt-1">
          <button onClick={onClose}
            className="flex-1 py-2 rounded-xl border border-white/[0.08] text-slate-400 hover:text-white text-sm transition-colors">
            Cancel
          </button>
          <button
            onClick={() => onAdd({ id: makeId(), type: selectedType, value, active: true })}
            className="flex-1 py-2 rounded-xl bg-mint-500/20 border border-mint-500/30 text-mint-400 font-semibold text-sm hover:bg-mint-500/30 transition-all"
          >
            Add Rule
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Sector beta estimates for stress testing (when analytics data unavailable) ─
const SECTOR_BETA = {
  'Technology': 1.35, 'Communication Services': 1.25, 'Consumer Discretionary': 1.20,
  'Financials': 1.10, 'Industrials': 1.05, 'Materials': 1.00, 'Energy': 0.95,
  'Health Care': 0.80, 'Real Estate': 0.75, 'Consumer Staples': 0.65, 'Utilities': 0.55,
  'Digital Asset': 2.10, 'Crypto': 2.10,
}
const ASSET_BETA = { equity: 1.0, etf: 0.90, crypto: 2.10, bond: 0.30, fund: 0.75 }

function estimateBeta(pos) {
  if (pos.sector && SECTOR_BETA[pos.sector]) return SECTOR_BETA[pos.sector]
  if (pos.assetClass && ASSET_BETA[pos.assetClass]) return ASSET_BETA[pos.assetClass]
  return 1.0
}

const SCENARIOS = [
  { label: 'Correction',   mktMove: -0.10, color: 'text-amber-400',  bg: 'bg-amber-500/10',  border: 'border-amber-500/20'  },
  { label: 'Bear Market',  mktMove: -0.20, color: 'text-orange-400', bg: 'bg-orange-500/10', border: 'border-orange-500/20' },
  { label: 'Crash',        mktMove: -0.30, color: 'text-red-400',    bg: 'bg-red-500/10',    border: 'border-red-500/20'    },
  { label: 'Severe Crash', mktMove: -0.50, color: 'text-red-500',    bg: 'bg-red-500/15',    border: 'border-red-500/30'    },
  { label: 'Rally +15%',   mktMove: +0.15, color: 'text-emerald-400',bg: 'bg-emerald-500/10',border: 'border-emerald-500/20'},
]

function StressTestPanel({ portfolio }) {
  const positions = portfolio?.positions ?? []
  const totalValue = portfolio?.summary?.totalValue ?? positions.reduce((s, p) => s + (p.mktValue ?? p.costBasis ?? 0), 0)

  const weightedBeta = useMemo(() => {
    if (!totalValue) return 1.0
    return positions.reduce((sum, p) => {
      const weight = (p.mktValue ?? 0) / totalValue
      return sum + estimateBeta(p) * weight
    }, 0)
  }, [positions, totalValue])

  const hedgingSuggestions = useMemo(() => {
    if (!positions.length) return []
    const suggestions = []
    const cryptoVal = positions.filter(p => p.assetClass === 'crypto' || SECTOR_BETA[p.sector] === 2.10).reduce((s, p) => s + (p.mktValue ?? 0), 0)
    const techVal   = positions.filter(p => p.sector === 'Technology' || p.sector === 'Communication Services').reduce((s, p) => s + (p.mktValue ?? 0), 0)
    const cryptoPct = totalValue ? (cryptoVal / totalValue) * 100 : 0
    const techPct   = totalValue ? (techVal / totalValue) * 100 : 0

    if (weightedBeta > 1.3) suggestions.push({ hedge: 'SPY Puts / SPXU', reason: `Portfolio β ${weightedBeta.toFixed(2)} — high market sensitivity`, urgency: 'high' })
    if (cryptoPct > 15)     suggestions.push({ hedge: 'BITI / BTC Puts',  reason: `${cryptoPct.toFixed(0)}% crypto exposure — volatile tail risk`, urgency: 'high' })
    if (techPct > 35)       suggestions.push({ hedge: 'QQQ Puts / SQQQ',  reason: `${techPct.toFixed(0)}% tech/comm concentration`, urgency: 'medium' })
    if (weightedBeta > 1.0) suggestions.push({ hedge: 'VXX / UVXY',       reason: 'Volatility hedge for market shock events', urgency: 'low' })
    if (positions.length <= 5) suggestions.push({ hedge: 'Add 3–5 uncorrelated positions', reason: 'Concentrated portfolio amplifies single-name risk', urgency: 'medium' })
    return suggestions.slice(0, 4)
  }, [positions, totalValue, weightedBeta])

  if (!totalValue) return null

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <TrendingDown className="w-4 h-4 text-red-400" />
        <h2 className="text-sm font-semibold text-white">Portfolio Stress Test</h2>
        <span className="text-[10px] text-slate-600 ml-auto">β {weightedBeta.toFixed(2)} estimated</span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {SCENARIOS.map(s => {
          const portMove   = s.mktMove * weightedBeta
          const dollarMove = totalValue * portMove
          return (
            <div key={s.label} className={`rounded-xl p-3 border text-center ${s.bg} ${s.border}`}>
              <div className="text-[10px] text-slate-500 mb-1">{s.label}</div>
              <div className={`text-sm font-black font-mono ${s.color}`}>
                {portMove >= 0 ? '+' : ''}{(portMove * 100).toFixed(1)}%
              </div>
              <div className={`text-[11px] font-mono mt-0.5 ${s.color}`}>
                {dollarMove >= 0 ? '+' : ''}${Math.abs(dollarMove).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
              </div>
              <div className="text-[9px] text-slate-600 mt-0.5">mkt {s.mktMove >= 0 ? '+' : ''}{(s.mktMove*100).toFixed(0)}%</div>
            </div>
          )
        })}
      </div>

      {hedgingSuggestions.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-400">
            <Zap className="w-3.5 h-3.5 text-mint-400" /> Hedging Suggestions
          </div>
          {hedgingSuggestions.map((h, i) => (
            <div key={i} className={`flex items-start gap-3 p-3 rounded-xl border ${
              h.urgency === 'high' ? 'bg-red-500/5 border-red-500/20' :
              h.urgency === 'medium' ? 'bg-amber-500/5 border-amber-500/15' :
              'bg-white/[0.02] border-white/[0.06]'
            }`}>
              <span className={`text-xs font-mono font-bold shrink-0 ${
                h.urgency === 'high' ? 'text-red-400' : h.urgency === 'medium' ? 'text-amber-400' : 'text-slate-400'
              }`}>{h.hedge}</span>
              <span className="text-[11px] text-slate-500">{h.reason}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────
export default function RiskRulesView({ portfolio }) {
  const [rules,       setRules]       = useState(loadRules)
  const [evaluations, setEvaluations] = useState([])
  const [showAdd,     setShowAdd]     = useState(false)
  const [evaluated,   setEvaluated]   = useState(false)

  // Persist on every change
  useEffect(() => { saveRules(rules) }, [rules])

  const evaluate = useCallback(() => {
    if (!portfolio) return
    // Build a normalised portfolio object for rule evaluation
    const positions = (portfolio.positions ?? []).map(p => ({
      symbol:       p.symbol,
      marketValue:  (p.currentPrice ?? p.price ?? 0) * (p.shares ?? p.quantity ?? 0),
      avgCost:      p.avgCost ?? p.costBasis ?? p.price ?? 0,
      currentPrice: p.currentPrice ?? p.price ?? 0,
      shares:       p.shares ?? p.quantity ?? 0,
      sector:       p.sector ?? null,
    }))
    const totalValue = positions.reduce((s, p) => s + p.marketValue, 0)

    // Record portfolio peak for drawdown tracking
    const peak = parseFloat(localStorage.getItem(PEAK_KEY) || '0')
    if (totalValue > peak) localStorage.setItem(PEAK_KEY, String(totalValue))

    const result = evaluateAll(rules, { positions, totalValue, cash: portfolio.cash ?? 0 })
    setEvaluations(result)
    setEvaluated(true)
  }, [rules, portfolio])

  const addRule   = (rule) => { setRules(r => [...r, rule]); setShowAdd(false); setEvaluated(false) }
  const toggleRule = (id) => { setRules(r => r.map(x => x.id === id ? { ...x, active: !x.active } : x)); setEvaluated(false) }
  const deleteRule = (id) => { setRules(r => r.filter(x => x.id !== id)); setEvaluated(false) }

  const violations = evaluations.filter(e => e.violations?.length > 0)
  const passing    = evaluations.filter(e => e.ok && e.rule.active)

  return (
    <div className="space-y-6 animate-fade-in">
      {showAdd && <AddRuleModal onAdd={addRule} onClose={() => setShowAdd(false)} />}

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20">
            <Shield className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Risk Rules</h1>
            <p className="text-xs text-slate-500">Composable pre-trade guardrails — evaluated against your live portfolio</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={evaluate}
            disabled={!portfolio || rules.filter(r => r.active).length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30 hover:bg-amber-500/25 transition-all disabled:opacity-40"
          >
            <Play className="w-3.5 h-3.5" /> Evaluate
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="btn-primary flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" /> Add Rule
          </button>
        </div>
      </div>

      {/* Summary row after evaluation */}
      {evaluated && (
        <div className="grid grid-cols-3 gap-3">
          <div className={`glass rounded-xl p-4 border text-center ${violations.length > 0 ? 'border-red-500/30' : 'border-emerald-500/20'}`}>
            <div className={`text-2xl font-black font-mono ${violations.length > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
              {violations.length}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">Violations</div>
          </div>
          <div className="glass rounded-xl p-4 border border-emerald-500/15 text-center">
            <div className="text-2xl font-black font-mono text-emerald-400">{passing.length}</div>
            <div className="text-xs text-slate-500 mt-0.5">Passing</div>
          </div>
          <div className="glass rounded-xl p-4 border border-white/[0.06] text-center">
            <div className="text-2xl font-black font-mono text-slate-400">{rules.filter(r => !r.active).length}</div>
            <div className="text-xs text-slate-500 mt-0.5">Inactive</div>
          </div>
        </div>
      )}

      {/* Violations banner */}
      {violations.length > 0 && (
        <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-red-400">
            <AlertTriangle className="w-4 h-4" /> {violations.length} rule{violations.length > 1 ? 's' : ''} violated
          </div>
          {violations.map(({ rule, violations: v }) => {
            const def = RULE_TYPES.find(t => t.id === rule.type)
            return v.map((msg, i) => (
              <div key={`${rule.id}-${i}`} className="flex items-start gap-2 text-xs text-red-300">
                <span className="shrink-0">{def?.icon}</span> {msg}
              </div>
            ))
          })}
        </div>
      )}

      {/* Empty state */}
      {rules.length === 0 && (
        <div className="glass rounded-2xl p-16 text-center space-y-4">
          <Shield className="w-12 h-12 text-amber-400/30 mx-auto" />
          <div>
            <p className="text-white font-semibold">No risk rules configured</p>
            <p className="text-slate-500 text-sm mt-1">
              Add guardrails to alert you when your portfolio breaks pre-defined risk limits.
            </p>
          </div>
          <button onClick={() => setShowAdd(true)} className="btn-primary flex items-center gap-2 mx-auto">
            <Plus className="w-4 h-4" /> Add First Rule
          </button>
        </div>
      )}

      {/* Rule cards */}
      {rules.length > 0 && (
        <div className="space-y-3">
          {rules.map(rule => (
            <RuleCard
              key={rule.id}
              rule={rule}
              onToggle={toggleRule}
              onDelete={deleteRule}
              evaluation={evaluations.find(e => e.rule.id === rule.id)}
            />
          ))}
        </div>
      )}

      {/* Stress test */}
      {portfolio?.positions?.length > 0 && (
        <div className="glass rounded-xl p-4 border border-white/[0.06]">
          <StressTestPanel portfolio={portfolio} />
        </div>
      )}

      {/* Info */}
      <div className="flex items-start gap-2 p-3 rounded-xl bg-white/[0.02] border border-white/[0.05] text-xs text-slate-500">
        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-slate-600" />
        <span>Rules are stored locally in your browser. Click <strong className="text-slate-400">Evaluate</strong> to check your current portfolio against all active rules. Stress test uses beta estimates by sector/asset class — visit Risk Analytics for precise correlation data.</span>
      </div>
    </div>
  )
}
