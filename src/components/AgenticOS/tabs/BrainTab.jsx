import { useState, useEffect } from 'react'
import { motion } from 'motion/react'
import {
  Brain, Database, Users, Code2, Search, CheckSquare,
  MessageSquare, Route, CheckCircle, ArrowRight, RefreshCw,
  TrendingUp, Zap, Activity, BarChart2, Cpu, Target,
  AlertTriangle, Clock, Shield, Star, ChevronUp, ChevronDown,
} from 'lucide-react'
import { apiFetch } from './shared'

// ── Tool registry — all 13 MarketPulse copilot tools ─────────────────────────
const TOOLS = [
  { name: 'scan_market',          desc: '5-agent AI Brain broad scan',          latency: '~120s', color: '#6366f1', category: 'scan'      },
  { name: 'get_recommendations',  desc: 'Investor persona buy signals',          latency: '~60s',  color: '#8b5cf6', category: 'advisory'  },
  { name: 'analyze_symbol',       desc: 'Deep TA + alt data for ticker',         latency: '~35s',  color: '#06b6d4', category: 'analysis'  },
  { name: 'get_earnings_catalyst',desc: 'Next earnings date + EPS surprise',     latency: '~10s',  color: '#f59e0b', category: 'catalyst'  },
  { name: 'get_options_flow',     desc: 'P/C ratio + unusual options activity',  latency: '~8s',   color: '#f97316', category: 'flow'      },
  { name: 'get_analyst_consensus',desc: 'Wall St. price target + consensus',     latency: '~8s',   color: '#84cc16', category: 'analysis'  },
  { name: 'get_insider_activity', desc: 'OpenInsider + FINRA short interest',    latency: '~12s',  color: '#ec4899', category: 'flow'      },
  { name: 'get_social_sentiment', desc: 'Reddit WSB + Google News sentiment',    latency: '~8s',   color: '#10b981', category: 'sentiment' },
  { name: 'get_macro',            desc: '14 FRED series + regime assessment',    latency: '~15s',  color: '#64748b', category: 'macro'     },
  { name: 'classify_symbol',      desc: 'Equity / ETF / crypto / fund catalog',  latency: '<1s',   color: '#a78bfa', category: 'utility'   },
  { name: 'sector_universe',      desc: 'Top US equities in a GICS sector',      latency: '<1s',   color: '#a78bfa', category: 'utility'   },
  { name: 'portfolio_risk',       desc: 'Sharpe / Sortino / VaR / drawdown',     latency: '~45s',  color: '#22d3ee', category: 'risk'      },
  { name: 'get_calibration',      desc: 'AI Brain track record & win rates',     latency: '<1s',   color: '#34d399', category: 'meta'      },
]

const CATEGORY_COLOR = {
  scan: 'text-indigo-400', advisory: 'text-purple-400', analysis: 'text-cyan-400',
  catalyst: 'text-amber-400', flow: 'text-orange-400', sentiment: 'text-emerald-400',
  macro: 'text-slate-400', utility: 'text-violet-400', risk: 'text-sky-400', meta: 'text-green-400',
}

const VERDICT_COLOR = v => {
  if (!v) return '#94a3b8'
  const s = String(v).toUpperCase()
  if (s.includes('STRONG BUY') || s.includes('STRONG_BUY')) return '#10b981'
  if (s.includes('BUY') || s.includes('ACCUMULATE')) return '#34d399'
  if (s.includes('SELL') || s.includes('AVOID')) return '#f87171'
  if (s.includes('REDUCE')) return '#fb923c'
  return '#fbbf24'
}

// ── Live signal radar card ────────────────────────────────────────────────────
function LiveSignalRadar({ scanCache }) {
  const stocks = scanCache?.broad?.rankedStocks?.slice(0, 6) ?? []
  const regime = scanCache?.broad?.marketRegime ?? null
  const updatedAt = scanCache?.updatedAt

  if (!stocks.length) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-[#12121a] p-5 flex items-center justify-center h-32">
        <div className="text-center">
          <Activity size={20} className="text-slate-600 mx-auto mb-2" />
          <div className="text-xs text-slate-600">No cached scan — fires at :05 each hour during market hours</div>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-white/[0.06] bg-[#12121a] overflow-hidden">
      <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-sm font-semibold text-white">Live AI Signal Radar</span>
          {regime && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-400 border border-indigo-500/25 font-mono">
              {regime}
            </span>
          )}
        </div>
        {updatedAt && (
          <span className="text-[10px] text-slate-600 font-mono">
            {new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>
      <div className="divide-y divide-white/[0.04]">
        {stocks.map((s, i) => {
          const vc = VERDICT_COLOR(s.agentVerdict)
          const score = s.compositeScore ?? 0
          const band = score >= 80 ? 'Elite' : score >= 70 ? 'High' : score >= 55 ? 'Mid' : 'Low'
          const bandColor = score >= 80 ? 'text-emerald-300' : score >= 70 ? 'text-emerald-400' : score >= 55 ? 'text-amber-400' : 'text-slate-500'
          return (
            <motion.div
              key={s.symbol}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.04 }}
              className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.02] transition-colors"
            >
              <div className="text-[10px] text-slate-600 font-mono w-3 text-right">{i + 1}</div>
              <div className="w-14 font-mono font-bold text-sm text-white">{s.symbol}</div>
              <div className="flex-1 min-w-0">
                <div className="w-full h-1 bg-white/[0.05] rounded-full overflow-hidden">
                  <motion.div
                    className="h-full rounded-full"
                    style={{ background: vc }}
                    initial={{ width: 0 }}
                    animate={{ width: `${score}%` }}
                    transition={{ delay: i * 0.04 + 0.1, duration: 0.5, ease: 'easeOut' }}
                  />
                </div>
              </div>
              <span className="text-[10px] font-mono font-bold" style={{ color: vc }}>
                {s.agentVerdict}
              </span>
              <span className={`text-[10px] font-mono w-12 text-right ${bandColor}`}>
                {score}/{band}
              </span>
              {s.highConviction && <Star size={10} className="text-amber-400 flex-shrink-0" />}
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}

// ── Animated Brain Architecture flow ─────────────────────────────────────────
function BrainArchitectureFlow() {
  const steps = [
    { icon: MessageSquare, label: 'User Input',     sub: 'Natural language',   color: 'bg-white/[0.04] border-white/[0.06]',         iconColor: 'text-slate-400' },
    { icon: Route,         label: 'Skill Router',   sub: 'Intent detection',   color: 'bg-indigo-500/10 border-indigo-500/30',        iconColor: 'text-indigo-400' },
    { icon: Brain,         label: 'LLM Reasoning',  sub: 'claude-sonnet-4-6',  color: 'bg-purple-500/10 border-purple-500/30',        iconColor: 'text-purple-400' },
    { icon: Database,      label: 'Graph Context',  sub: 'Graphify 71.5×',     color: 'bg-cyan-500/10 border-cyan-500/30',            iconColor: 'text-cyan-400' },
    { icon: CheckCircle,   label: 'Action Output',  sub: 'Code, data, plans',  color: 'bg-emerald-500/10 border-emerald-500/30',      iconColor: 'text-emerald-400' },
  ]

  return (
    <div className="p-6 flex items-center justify-center gap-3 flex-wrap">
      {steps.map((step, i) => {
        const Icon = step.icon
        return (
          <div key={step.label} className="flex items-center gap-3">
            <motion.div
              className="text-center"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.1 }}
            >
              <div className={`w-14 h-14 rounded-2xl ${step.color} border flex items-center justify-center mb-2 mx-auto`}>
                <Icon size={22} className={step.iconColor} />
              </div>
              <div className="text-xs font-medium text-white">{step.label}</div>
              <div className="text-[10px] text-slate-500">{step.sub}</div>
            </motion.div>
            {i < steps.length - 1 && (
              <motion.div
                initial={{ opacity: 0, scaleX: 0 }}
                animate={{ opacity: 1, scaleX: 1 }}
                transition={{ delay: i * 0.1 + 0.15 }}
              >
                <ArrowRight size={14} className="text-slate-600 flex-shrink-0 mt-[-18px]" />
              </motion.div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Self-Improvement Loop display ─────────────────────────────────────────────
function SelfImprovementPanel({ calibration }) {
  if (!calibration) {
    return (
      <div className="p-5 text-center text-xs text-slate-600">
        Calibration data accumulates as AI Brain picks age past 7 and 30 days
      </div>
    )
  }

  const fmt = v => v == null ? '—' : `${Math.round(v * 100)}%`
  const h7  = calibration.h7
  const h30 = calibration.h30

  return (
    <div className="p-4 grid grid-cols-3 gap-3">
      {[
        { label: '7-Day Alpha Win',  value: fmt(h7?.alphaWinRate),  sub: `${h7?.nTradeable ?? 0} picks`, color: 'text-indigo-400' },
        { label: '30-Day Alpha Win', value: fmt(h30?.alphaWinRate), sub: `${h30?.nTradeable ?? 0} picks`, color: 'text-purple-400' },
        { label: 'Target Hit Rate',  value: fmt(h30?.targetHitRate ?? h7?.targetHitRate), sub: 'take-profit reached', color: 'text-emerald-400' },
      ].map(m => (
        <div key={m.label} className="rounded-lg bg-white/[0.03] border border-white/[0.05] p-3 text-center">
          <div className={`text-xl font-black font-mono ${m.color}`}>{m.value}</div>
          <div className="text-[11px] font-medium text-white mt-0.5">{m.label}</div>
          <div className="text-[10px] text-slate-500">{m.sub}</div>
        </div>
      ))}
    </div>
  )
}

// ── Agentic Brain Tab ─────────────────────────────────────────────────────────

export default function BrainTab({ jobs, stats, mcps, onRefresh }) {
  const [scanCache,    setScanCache]    = useState(null)
  const [calibration,  setCalibration]  = useState(null)
  const [toolsOpen,    setToolsOpen]    = useState(false)
  const connected = mcps.filter(m => m.status === 'connected')

  useEffect(() => {
    apiFetch('/api/scheduler/cache/scan').then(setScanCache).catch(() => {})
    apiFetch('/api/ai-brain/activity').then(d => { if (d && !d.error) setCalibration(d) }).catch(() => {})
  }, [])

  const runningJobs   = jobs.filter(j => j.result?.status === 'running')
  const completedJobs = jobs.filter(j => j.result?.status === 'done')
  const failedJobs    = jobs.filter(j => j.result?.status === 'failed')

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">Agentic Brain</h2>
          <p className="text-xs text-slate-500 mt-0.5">Reasoning engine · memory · tool orchestration · self-improvement</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs text-emerald-400">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            Online
          </span>
          <button onClick={onRefresh} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-xs hover:bg-indigo-500/20 transition-all">
            <RefreshCw size={12} /> Sync Brain
          </button>
        </div>
      </div>

      {/* Live Signal Radar — top of page for immediate impact */}
      <LiveSignalRadar scanCache={scanCache} />

      {/* Status grid */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: 'Graph Nodes',  value: stats?.nodes  ?? '—', sub: `${stats?.edges ?? 0} edges`, color: 'text-indigo-400', icon: Database },
          { label: 'MCP Servers',  value: connected.length || '—',  sub: `of ${mcps.length} configured`, color: 'text-cyan-400',   icon: Cpu },
          { label: 'Jobs Running', value: runningJobs.length || '0', sub: `${completedJobs.length} done · ${failedJobs.length} failed`, color: 'text-amber-400', icon: Activity },
          { label: 'Tools Active', value: TOOLS.length,             sub: 'copilot registry',         color: 'text-purple-400', icon: Zap },
        ].map(c => {
          const Icon = c.icon
          return (
            <div key={c.label} className="rounded-xl border border-white/[0.06] bg-[#12121a] p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">{c.label}</span>
                <Icon size={13} className={c.color} />
              </div>
              <div className={`text-2xl font-black font-mono ${c.color}`}>{c.value}</div>
              <div className="text-[10px] text-slate-600 mt-0.5">{c.sub}</div>
            </div>
          )
        })}
      </div>

      {/* Self-Improvement Loop */}
      <div className="rounded-xl border border-white/[0.06] bg-[#12121a] overflow-hidden">
        <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Target size={14} className="text-emerald-400" />
            <div className="text-sm font-semibold text-white">Self-Improvement Loop</div>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">nightly</span>
          </div>
          <span className="text-[10px] text-slate-500">Prediction outcomes → meta-analysis → prompt injection</span>
        </div>
        <SelfImprovementPanel calibration={calibration} />
      </div>

      {/* Core engine cards */}
      <div className="grid grid-cols-3 gap-4">
        {/* Reasoning Engine */}
        <div className="rounded-xl border border-white/[0.06] bg-[#12121a] p-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center">
              <Brain size={18} className="text-indigo-400" />
            </div>
            <div>
              <div className="font-semibold text-sm text-white">Reasoning Engine</div>
              <div className="text-[10px] text-slate-500">System-2 · claude-sonnet-4-6</div>
            </div>
          </div>
          <div className="space-y-3">
            {[
              { label: 'Chain-of-Thought', value: 100, color: 'bg-indigo-500', text: 'Enabled' },
              { label: 'Self-Reflection',  value: 100, color: 'bg-indigo-500', text: 'Enabled' },
              { label: 'Tool Learning',    value: 85,  color: 'bg-purple-500', text: 'Active' },
            ].map(m => (
              <div key={m.label}>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-slate-400">{m.label}</span>
                  <span className="text-indigo-400">{m.text}</span>
                </div>
                <div className="w-full h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                  <motion.div
                    className={`h-full ${m.color} rounded-full`}
                    initial={{ width: 0 }}
                    animate={{ width: `${m.value}%` }}
                    transition={{ duration: 0.6, ease: 'easeOut' }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Memory Layer */}
        <div className="rounded-xl border border-white/[0.06] bg-[#12121a] p-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-purple-500/10 flex items-center justify-center">
              <Database size={18} className="text-purple-400" />
            </div>
            <div>
              <div className="font-semibold text-sm text-white">Memory Layer</div>
              <div className="text-[10px] text-slate-500">Graph + Vector Hybrid</div>
            </div>
          </div>
          <div className="space-y-3">
            {[
              { label: 'Graph Memory',         value: 92,  color: 'bg-purple-500',  text: `${stats?.nodes ?? 0} nodes` },
              { label: 'Prediction Log',        value: 70,  color: 'bg-purple-500',  text: 'JSONL append-only' },
              { label: 'Skill Cache',           value: 100, color: 'bg-emerald-500', text: `${stats?.libs ?? 0} loaded` },
            ].map(m => (
              <div key={m.label}>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-slate-400">{m.label}</span>
                  <span className="text-purple-400">{m.text}</span>
                </div>
                <div className="w-full h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                  <motion.div
                    className={`h-full ${m.color} rounded-full`}
                    initial={{ width: 0 }}
                    animate={{ width: `${m.value}%` }}
                    transition={{ duration: 0.6, ease: 'easeOut' }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Background Jobs */}
        <div className="rounded-xl border border-white/[0.06] bg-[#12121a] p-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-cyan-500/10 flex items-center justify-center">
              <Clock size={18} className="text-cyan-400" />
            </div>
            <div>
              <div className="font-semibold text-sm text-white">Scheduled Jobs</div>
              <div className="text-[10px] text-slate-500">{jobs.length} registered</div>
            </div>
          </div>
          <div className="space-y-1.5">
            {jobs.slice(0, 5).map(j => {
              const status = j.result?.status || 'idle'
              const dot  = { done: 'bg-emerald-400', running: 'bg-amber-400 animate-pulse', failed: 'bg-red-400', idle: 'bg-slate-700' }[status] || 'bg-slate-700'
              const text = { done: 'text-emerald-400', running: 'text-amber-400', failed: 'text-red-400', idle: 'text-slate-600' }[status] || 'text-slate-600'
              return (
                <div key={j.id} className="flex items-center gap-2 text-xs">
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dot}`} />
                  <span className="flex-1 text-slate-400 truncate">{j.name}</span>
                  <span className={`font-mono text-[10px] ${text}`}>{status}</span>
                </div>
              )
            })}
            {jobs.length > 5 && (
              <div className="text-[10px] text-slate-600 pl-3.5 pt-0.5">+{jobs.length - 5} more</div>
            )}
          </div>
        </div>
      </div>

      {/* Brain Architecture */}
      <div className="rounded-xl border border-white/[0.06] bg-[#12121a] overflow-hidden">
        <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
          <div className="text-sm font-semibold text-white">Brain Architecture</div>
          <span className="text-[10px] text-slate-500 font-mono">claude-sonnet-4-6 + Graphify Context</span>
        </div>
        <BrainArchitectureFlow />
      </div>

      {/* Complete Tool Registry */}
      <div className="rounded-xl border border-white/[0.06] bg-[#12121a] overflow-hidden">
        <button
          className="w-full flex items-center justify-between px-4 py-3 border-b border-white/[0.06] hover:bg-white/[0.02] transition-colors"
          onClick={() => setToolsOpen(o => !o)}
        >
          <div className="flex items-center gap-2">
            <Zap size={14} className="text-purple-400" />
            <div className="text-sm font-semibold text-white">Copilot Tool Registry</div>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-500/10 text-purple-400 border border-purple-500/20">{TOOLS.length} tools</span>
          </div>
          {toolsOpen ? <ChevronUp size={14} className="text-slate-500" /> : <ChevronDown size={14} className="text-slate-500" />}
        </button>
        {toolsOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            transition={{ duration: 0.2 }}
            className="divide-y divide-white/[0.04]"
          >
            {TOOLS.map(t => (
              <div key={t.name} className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.02] transition-colors">
                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: t.color, boxShadow: `0 0 6px ${t.color}60` }} />
                <code className="text-xs font-mono text-white w-40 flex-shrink-0">{t.name}</code>
                <span className={`text-[10px] flex-shrink-0 ${CATEGORY_COLOR[t.category] || 'text-slate-500'}`}>[{t.category}]</span>
                <span className="text-[10px] text-slate-400 flex-1">{t.desc}</span>
                <span className="text-[10px] text-slate-600 font-mono flex-shrink-0">{t.latency}</span>
              </div>
            ))}
          </motion.div>
        )}
        {!toolsOpen && (
          <div className="px-4 py-2.5 flex gap-2 flex-wrap">
            {TOOLS.slice(0, 8).map(t => (
              <span key={t.name} className="text-[10px] px-2 py-0.5 rounded-full border" style={{ color: t.color, borderColor: t.color + '40', background: t.color + '10' }}>
                {t.name}
              </span>
            ))}
            <span className="text-[10px] text-slate-600 px-2 py-0.5">+{TOOLS.length - 8} more ↓</span>
          </div>
        )}
      </div>

      {/* Warnings */}
      {failedJobs.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-start gap-3 p-4 rounded-xl border border-red-500/20 bg-red-500/5"
        >
          <AlertTriangle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-red-400">
            <span className="font-semibold">{failedJobs.length} job{failedJobs.length > 1 ? 's' : ''} failed:</span>{' '}
            {failedJobs.map(j => j.name).join(', ')}
          </div>
        </motion.div>
      )}
    </div>
  )
}
