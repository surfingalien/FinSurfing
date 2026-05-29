/**
 * GovernancePanel — AI automation governance status.
 * Shows circuit breaker states, kill switch status, and recent AI call audit log.
 * Displayed inside AdminDashboard.
 */
import { useState, useEffect, useCallback } from 'react'
import {
  Shield, Activity, Zap, RefreshCw, AlertTriangle,
  CheckCircle2, XCircle, ToggleLeft, ToggleRight, Clock,
  DollarSign, Brain, Sparkles,
} from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'

const BASE = import.meta.env.VITE_API_URL || ''

function timeSince(iso) {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60)  return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60)  return `${m}m ago`
  return `${Math.floor(m / 60)}h ago`
}

function fmtMs(ms) {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function fmtCost(usd) {
  if (usd == null) return '—'
  if (usd < 0.001) return '<$0.001'
  return `$${usd.toFixed(4)}`
}

/* ── Circuit breaker badge ───────────────────────────────────────── */
function CircuitBadge({ state }) {
  const cfg = {
    CLOSED:    { label: 'Healthy',   color: 'text-emerald-400', bg: 'bg-emerald-500/15', border: 'border-emerald-500/30', icon: CheckCircle2 },
    HALF_OPEN: { label: 'Testing',   color: 'text-amber-400',   bg: 'bg-amber-500/15',   border: 'border-amber-500/30',   icon: AlertTriangle },
    OPEN:      { label: 'Open',      color: 'text-red-400',     bg: 'bg-red-500/15',      border: 'border-red-500/30',     icon: XCircle },
  }[state] || { label: state, color: 'text-slate-400', bg: 'bg-white/[0.04]', border: 'border-white/[0.08]', icon: Activity }
  const Icon = cfg.icon
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${cfg.bg} ${cfg.color} ${cfg.border}`}>
      <Icon className="w-2.5 h-2.5" /> {cfg.label}
    </span>
  )
}

/* ── Circuit breaker card ────────────────────────────────────────── */
function BreakerCard({ breaker, onReset, authFetch }) {
  const [resetting, setResetting] = useState(false)

  const handleReset = async () => {
    setResetting(true)
    try {
      await authFetch(`/api/governance/circuit-reset/${breaker.name}`, { method: 'POST' })
      onReset?.()
    } catch {}
    setResetting(false)
  }

  const routeLabel = { 'ai-brain': 'AI Brain (Opus)', recommendations: 'AI Buy Signals' }[breaker.name] || breaker.name
  const RouteIcon  = breaker.name === 'ai-brain' ? Brain : Sparkles

  return (
    <div className={`rounded-xl p-3 border ${breaker.state === 'OPEN' ? 'border-red-500/30 bg-red-500/8' : 'border-white/[0.07] bg-white/[0.03]'}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <RouteIcon className={`w-3.5 h-3.5 ${breaker.state === 'OPEN' ? 'text-red-400' : 'text-mint-400'}`} />
          <span className="text-xs font-semibold text-white">{routeLabel}</span>
        </div>
        <CircuitBadge state={breaker.state} />
      </div>

      <div className="grid grid-cols-3 gap-2 text-[10px] mb-2">
        <div>
          <div className="text-slate-500">Calls</div>
          <div className="text-white font-mono">{breaker.totalCalls}</div>
        </div>
        <div>
          <div className="text-slate-500">Failures</div>
          <div className={`font-mono ${breaker.totalFailures > 0 ? 'text-red-400' : 'text-white'}`}>{breaker.totalFailures}</div>
        </div>
        <div>
          <div className="text-slate-500">Last OK</div>
          <div className="text-white font-mono">{timeSince(breaker.lastSuccessAt)}</div>
        </div>
      </div>

      {breaker.state !== 'CLOSED' && (
        <button
          onClick={handleReset}
          disabled={resetting}
          className="w-full text-[10px] py-1 rounded-lg bg-amber-500/15 text-amber-400 border border-amber-500/30 hover:bg-amber-500/25 transition-all disabled:opacity-50"
        >
          {resetting ? 'Resetting…' : 'Reset Circuit'}
        </button>
      )}
    </div>
  )
}

/* ── Audit log row ───────────────────────────────────────────────── */
function AuditRow({ entry }) {
  const routeLabel = { 'ai-brain': 'AI Brain', recommendations: 'Buy Signals' }[entry.route] || entry.route
  return (
    <div className={`flex items-center gap-2 py-1.5 border-b border-white/[0.04] text-[10px] ${!entry.success ? 'opacity-60' : ''}`}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${entry.success ? 'bg-emerald-400' : 'bg-red-400'}`} />
      <span className="text-slate-400 w-20 shrink-0">{routeLabel}</span>
      <span className="text-slate-500 truncate flex-1 font-mono">{entry.model?.replace('claude-', '').replace('-4-', ' ')}</span>
      <span className="text-slate-500 w-12 text-right shrink-0">{fmtMs(entry.durationMs)}</span>
      <span className="text-emerald-400/80 w-14 text-right shrink-0 font-mono">{fmtCost(entry.costUsd)}</span>
      <span className="text-slate-600 w-16 text-right shrink-0">{timeSince(entry.ts)}</span>
    </div>
  )
}

/* ── Main panel ──────────────────────────────────────────────────── */
export default function GovernancePanel() {
  const { authFetch } = useAuth()
  const [status,  setStatus]  = useState(null)
  const [audit,   setAudit]   = useState(null)
  const [loading, setLoading] = useState(false)
  const [tab,     setTab]     = useState('status')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [s, a] = await Promise.all([
        fetch(`${BASE}/api/governance/status`).then(r => r.json()),
        fetch(`${BASE}/api/governance/audit?limit=20`).then(r => r.json()),
      ])
      setStatus(s)
      setAudit(a)
    } catch {}
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const stats = status?.aiStats

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-cyan-400" />
          <div>
            <h2 className="text-sm font-semibold text-white">AI Governance</h2>
            <p className="text-[10px] text-slate-500">Circuit breakers · Kill switches · Audit log</p>
          </div>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1 px-2 py-1 text-[10px] rounded-lg border border-white/[0.07] text-slate-400 hover:text-white transition-colors disabled:opacity-40"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {/* Summary stats */}
      {stats && (
        <div className="grid grid-cols-4 gap-2">
          {[
            { label: 'Total Calls',   value: stats.total,         color: 'text-white' },
            { label: 'Success Rate',  value: stats.successRate != null ? `${stats.successRate}%` : '—', color: stats.successRate >= 90 ? 'text-emerald-400' : 'text-amber-400' },
            { label: 'Avg Latency',   value: fmtMs(stats.avgDurationMs), color: 'text-white' },
            { label: 'Est. Cost',     value: fmtCost(stats.totalCostUsd), color: 'text-amber-400' },
          ].map(s => (
            <div key={s.label} className="rounded-xl p-2.5 bg-white/[0.03] border border-white/[0.06] text-center">
              <div className={`text-sm font-bold font-mono ${s.color}`}>{s.value}</div>
              <div className="text-[9px] text-slate-500 mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1">
        {['status', 'audit'].map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1 text-[10px] font-medium rounded-lg border transition-all capitalize ${
              tab === t
                ? 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30'
                : 'bg-white/[0.03] text-slate-500 border-white/[0.06] hover:text-white'
            }`}
          >
            {t === 'status' ? 'Circuit Breakers' : 'Audit Log'}
          </button>
        ))}
      </div>

      {/* Circuit Breakers tab */}
      {tab === 'status' && (
        <div className="space-y-3">
          {/* Kill switches */}
          {status?.killSwitches && (
            <div className="rounded-xl p-3 border border-white/[0.07] bg-white/[0.03]">
              <div className="flex items-center gap-2 mb-2">
                <ToggleLeft className="w-3.5 h-3.5 text-slate-400" />
                <span className="text-[11px] font-semibold text-slate-300">Kill Switches</span>
                <span className="text-[9px] text-slate-600 ml-auto">Set AI_BRAIN_DISABLED=true in Railway env to toggle</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: 'AI Brain (Opus)', disabled: status.killSwitches.aiBrain },
                  { label: 'AI Buy Signals',  disabled: status.killSwitches.recommendations },
                ].map(ks => (
                  <div key={ks.label} className={`flex items-center justify-between p-2 rounded-lg border text-[10px] ${
                    ks.disabled ? 'border-red-500/30 bg-red-500/8' : 'border-white/[0.06] bg-white/[0.02]'
                  }`}>
                    <span className="text-slate-300">{ks.label}</span>
                    <span className={`flex items-center gap-1 font-medium ${ks.disabled ? 'text-red-400' : 'text-emerald-400'}`}>
                      {ks.disabled ? <XCircle className="w-3 h-3" /> : <CheckCircle2 className="w-3 h-3" />}
                      {ks.disabled ? 'Disabled' : 'Active'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Circuit breakers */}
          {status?.circuitBreakers?.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {status.circuitBreakers.map(b => (
                <BreakerCard key={b.name} breaker={b} onReset={load} authFetch={authFetch} />
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-slate-600 text-center py-6">
              No circuit breakers registered yet — activate AI Brain or Buy Signals first
            </div>
          )}
        </div>
      )}

      {/* Audit log tab */}
      {tab === 'audit' && (
        <div className="rounded-xl border border-white/[0.07] overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 bg-white/[0.03] border-b border-white/[0.06]">
            <Activity className="w-3 h-3 text-slate-400" />
            <span className="text-[10px] font-semibold text-slate-400">Recent AI Calls</span>
            <span className="ml-auto text-[9px] text-slate-600 flex items-center gap-1">
              <DollarSign className="w-2.5 h-2.5" /> Costs are estimates
            </span>
          </div>
          <div className="px-3 divide-y divide-white/[0.04]">
            {audit?.entries?.length > 0 ? (
              audit.entries.map(e => <AuditRow key={e.id} entry={e} />)
            ) : (
              <div className="text-[11px] text-slate-600 text-center py-6">
                No AI calls logged yet — activate AI Brain or Buy Signals
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
