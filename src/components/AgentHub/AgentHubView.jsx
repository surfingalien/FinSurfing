/**
 * AgentHubView.jsx
 *
 * 4-tab view:
 *   Research Agent  — fan-out parallel sub-agents → Claude synthesis
 *   Pipeline        — 3-phase sequential research (Analyst→Quant→Strategist) [open-team pattern]
 *   Task Scheduler  — view / trigger / toggle background jobs
 *   Telemetry       — run history with timing + model info [open-team pattern]
 */

import { useState, useEffect, useCallback } from 'react'
import {
  Network, Calendar, Play, RefreshCw, CheckCircle2, XCircle,
  Clock, Loader2, ToggleLeft, ToggleRight, AlertTriangle, ChevronDown, ChevronUp,
  Zap, Search, GitBranch, BarChart2, Layers, Timer,
} from 'lucide-react'
import { getApiKeyHeaders } from '../../services/api'

const TELEMETRY_KEY = 'finsurf_agent_runs'
const MAX_RUNS = 50

function apiFetch(url, opts = {}) {
  return fetch(url, { headers: getApiKeyHeaders(), ...opts })
}

function timeAgo(ts) {
  if (!ts) return 'Never'
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000)
  if (s < 60)   return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

function saveTelemetryRun(run) {
  try {
    const existing = JSON.parse(localStorage.getItem(TELEMETRY_KEY) || '[]')
    const updated  = [run, ...existing].slice(0, MAX_RUNS)
    localStorage.setItem(TELEMETRY_KEY, JSON.stringify(updated))
  } catch {}
}

function loadTelemetry() {
  try { return JSON.parse(localStorage.getItem(TELEMETRY_KEY) || '[]') } catch { return [] }
}

// ── ─────────────────────────────────────────────────────────────────────────────
//    TAB 1 — Research Agent (parallel fan-out)
// ── ─────────────────────────────────────────────────────────────────────────────

const AGENT_META = {
  'market-data': { icon: '📊', color: 'border-sky-500/30    bg-sky-500/8'    },
  'technical':   { icon: '📈', color: 'border-indigo-500/30 bg-indigo-500/8' },
  'insider':     { icon: '👥', color: 'border-emerald-500/30 bg-emerald-500/8'},
  'analyst':     { icon: '⭐', color: 'border-amber-500/30  bg-amber-500/8'  },
  'macro':       { icon: '🌍', color: 'border-violet-500/30 bg-violet-500/8' },
}

function AgentCard({ agent }) {
  const [expanded, setExpanded] = useState(false)
  const meta = AGENT_META[agent.id] ?? { icon: '🤖', color: 'border-slate-500/30 bg-slate-500/8' }

  const statusNode = {
    idle:    <span className="text-slate-500 text-xs">Waiting</span>,
    running: <Loader2 className="w-3.5 h-3.5 text-sky-400 animate-spin" />,
    done:    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />,
    error:   <XCircle className="w-3.5 h-3.5 text-red-400" />,
    skipped: <span className="text-slate-600 text-xs">Skipped</span>,
  }[agent.status] ?? null

  const hasData = agent.status === 'done' && agent.data

  return (
    <div className={`rounded-xl border p-3 transition-all ${meta.color}`}>
      <div className="flex items-center gap-2">
        <span className="text-lg">{meta.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-white truncate">{agent.name}</div>
          {agent.durationMs > 0 && <div className="text-[10px] text-slate-600">{agent.durationMs}ms</div>}
        </div>
        <div className="flex items-center gap-1.5">
          {statusNode}
          {hasData && (
            <button onClick={() => setExpanded(e => !e)} className="text-slate-600 hover:text-white transition-colors">
              {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </div>
      {agent.status === 'error' && <div className="mt-2 text-[11px] text-red-400 truncate">{agent.error}</div>}
      {expanded && hasData && (
        <pre className="mt-2 text-[10px] text-slate-400 overflow-auto max-h-40 bg-black/20 rounded-lg p-2">
          {JSON.stringify(agent.data, null, 2)}
        </pre>
      )}
    </div>
  )
}

function SynthesisPanel({ text, llmUsed, error }) {
  if (error) return (
    <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
      <AlertTriangle className="w-4 h-4 inline mr-2" />Synthesis error: {error}
    </div>
  )
  if (!text) return null

  const html = text
    .replace(/^##\s+(.+)$/gm, '<div class="text-sm font-bold text-white mt-3 mb-1">$1</div>')
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-white">$1</strong>')
    .replace(/\n/g, '<br />')

  return (
    <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-5">
      <div className="flex items-center gap-2 mb-3">
        <Zap className="w-4 h-4 text-mint-400" />
        <span className="text-sm font-semibold text-white">AI Synthesis</span>
        {llmUsed && <span className="ml-auto text-[10px] text-slate-600 px-2 py-0.5 bg-white/[0.04] rounded-full">via {llmUsed}</span>}
      </div>
      <div className="text-sm text-slate-300 leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}

function ResearchAgentTab() {
  const [input,   setInput]   = useState('')
  const [result,  setResult]  = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)
  const [opts,    setOpts]    = useState({ includeInsider: true, includeAnalyst: true, includeMacro: true })

  const launch = async () => {
    const sym = input.trim().toUpperCase()
    if (!sym) return
    setLoading(true); setError(null); setResult(null)
    const t0 = Date.now()

    setResult({
      symbol: sym,
      agents: [
        { id: 'market-data', name: 'Market Data',        icon: '📊', status: 'running', durationMs: 0 },
        { id: 'technical',   name: 'Technical Analysis', icon: '📈', status: 'running', durationMs: 0 },
        { id: 'insider',     name: 'Insider Activity',   icon: '👥', status: opts.includeInsider ? 'running' : 'skipped', durationMs: 0 },
        { id: 'analyst',     name: 'Analyst Ratings',    icon: '⭐', status: opts.includeAnalyst ? 'running' : 'skipped', durationMs: 0 },
        { id: 'macro',       name: 'Macro Context',      icon: '🌍', status: opts.includeMacro   ? 'running' : 'skipped', durationMs: 0 },
      ],
      synthesis: null,
    })

    try {
      const r    = await apiFetch('/api/agents/research', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...getApiKeyHeaders() },
        body:    JSON.stringify({ symbol: sym, ...opts }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'Research failed')
      setResult(data)
      saveTelemetryRun({
        id: crypto.randomUUID(),
        mode: 'parallel',
        symbol: sym,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - t0,
        agentCount: data.agents?.filter(a => a.status !== 'skipped').length ?? 0,
        status: data.synthError ? 'partial' : 'done',
        llmUsed: data.llmUsed,
      })
    } catch (e) {
      setError(e.message); setResult(null)
      saveTelemetryRun({ id: crypto.randomUUID(), mode: 'parallel', symbol: sym, timestamp: new Date().toISOString(), durationMs: Date.now() - t0, agentCount: 0, status: 'failed', llmUsed: null })
    }
    setLoading(false)
  }

  const Toggle = ({ id, label }) => (
    <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-400 select-none"
      onClick={() => setOpts(o => ({ ...o, [id]: !o[id] }))}>
      <div className={`w-8 h-4 rounded-full border relative transition-all ${opts[id] ? 'bg-mint-500/40 border-mint-500/50' : 'bg-white/[0.05] border-white/[0.08]'}`}>
        <div className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${opts[id] ? 'left-4 bg-mint-400' : 'left-0.5 bg-slate-500'}`} />
      </div>
      {label}
    </label>
  )

  return (
    <div className="space-y-5">
      <div className="bg-white/[0.02] border border-white/[0.06] rounded-2xl p-5 space-y-4">
        <div className="flex gap-3">
          <div className="flex items-center gap-2 bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2 flex-1">
            <Search className="w-4 h-4 text-slate-500 shrink-0" />
            <input value={input} onChange={e => setInput(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && !loading && launch()}
              placeholder="Enter symbol — AAPL, BTC, SPY…"
              className="bg-transparent text-sm text-white placeholder-slate-600 focus:outline-none flex-1 font-mono" />
          </div>
          <button onClick={launch} disabled={loading || !input.trim()}
            className="flex items-center gap-2 px-5 py-2 bg-mint-500/80 hover:bg-mint-400 disabled:opacity-40 text-[#060810] text-sm font-bold rounded-xl transition-colors">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {loading ? 'Running…' : 'Launch'}
          </button>
        </div>
        <div className="flex flex-wrap gap-4">
          <Toggle id="includeInsider" label="Insider trades" />
          <Toggle id="includeAnalyst" label="Analyst ratings" />
          <Toggle id="includeMacro"   label="Macro context" />
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {result && (
        <>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Network className="w-3.5 h-3.5 text-mint-400" />
            <span>
              {result.agents.filter(a => a.status === 'done').length}/{result.agents.filter(a => a.status !== 'skipped').length} agents completed
              {result.timestamp && <span className="ml-2 text-slate-600">· {new Date(result.timestamp).toLocaleTimeString()}</span>}
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
            {result.agents.map(a => <AgentCard key={a.id} agent={a} />)}
          </div>
          <SynthesisPanel text={result.synthesis} llmUsed={result.llmUsed} error={result.synthError} />
        </>
      )}

      {!result && !loading && (
        <div className="text-center py-16 text-slate-600 text-sm space-y-2">
          <Network className="w-8 h-8 mx-auto opacity-20" />
          <p>Enter a symbol and launch to fan out across all 5 agents simultaneously.</p>
        </div>
      )}
    </div>
  )
}

// ── ─────────────────────────────────────────────────────────────────────────────
//    TAB 2 — Pipeline (3-phase sequential)
// ── ─────────────────────────────────────────────────────────────────────────────

const PHASE_META = {
  analyst:    { icon: '🔍', color: 'border-sky-500/30    bg-sky-500/8',    label: 'Analyst' },
  quant:      { icon: '📐', color: 'border-violet-500/30 bg-violet-500/8', label: 'Quant'   },
  strategist: { icon: '🎯', color: 'border-amber-500/30  bg-amber-500/8',  label: 'Strategist' },
}

function PhaseCard({ phase, active }) {
  const [expanded, setExpanded] = useState(false)
  const meta = PHASE_META[phase.id] ?? { icon: '🤖', color: 'border-slate-500/30 bg-slate-500/8', label: phase.name }

  return (
    <div className={`rounded-xl border p-4 transition-all ${active ? meta.color : 'border-white/[0.04] bg-white/[0.01] opacity-40'}`}>
      <div className="flex items-center gap-3">
        <span className="text-2xl">{meta.icon}</span>
        <div className="flex-1">
          <div className="text-sm font-bold text-white">{meta.label}</div>
          {phase.model && <div className="text-[10px] text-slate-500">{phase.model}</div>}
          {phase.durationMs > 0 && <div className="text-[10px] text-slate-600">{phase.durationMs}ms</div>}
        </div>
        <div className="flex items-center gap-1.5">
          {phase.status === 'running' && <Loader2 className="w-4 h-4 text-sky-400 animate-spin" />}
          {phase.status === 'done'    && <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
          {phase.status === 'idle'    && <Clock className="w-4 h-4 text-slate-600" />}
          {phase.data && (
            <button onClick={() => setExpanded(e => !e)} className="text-slate-600 hover:text-white">
              {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </div>
      {expanded && phase.data && (
        <pre className="mt-3 text-[10px] text-slate-400 overflow-auto max-h-36 bg-black/20 rounded-lg p-2">
          {JSON.stringify(phase.data, null, 2)}
        </pre>
      )}
    </div>
  )
}

function PipelineTab() {
  const [input,   setInput]   = useState('')
  const [result,  setResult]  = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)

  const launch = async () => {
    const sym = input.trim().toUpperCase()
    if (!sym) return
    setLoading(true); setError(null)
    const t0 = Date.now()

    setResult({
      symbol: sym,
      phases: [
        { id: 'analyst',    name: 'Analyst',    icon: '🔍', status: 'running', durationMs: 0, model: null, data: null },
        { id: 'quant',      name: 'Quant',      icon: '📐', status: 'idle',    durationMs: 0, model: null, data: null },
        { id: 'strategist', name: 'Strategist', icon: '🎯', status: 'idle',    durationMs: 0, model: null, data: null },
      ],
      synthesis: null,
    })

    try {
      const r    = await apiFetch('/api/agents/pipeline', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...getApiKeyHeaders() },
        body:    JSON.stringify({ symbol: sym }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'Pipeline failed')
      setResult(data)
      saveTelemetryRun({
        id: crypto.randomUUID(),
        mode: 'pipeline',
        symbol: sym,
        timestamp: new Date().toISOString(),
        durationMs: data.totalMs ?? Date.now() - t0,
        agentCount: 3,
        status: 'done',
        llmUsed: data.llmUsed,
      })
    } catch (e) {
      setError(e.message); setResult(null)
      saveTelemetryRun({ id: crypto.randomUUID(), mode: 'pipeline', symbol: sym, timestamp: new Date().toISOString(), durationMs: Date.now() - t0, agentCount: 0, status: 'failed', llmUsed: null })
    }
    setLoading(false)
  }

  return (
    <div className="space-y-5">
      <div className="bg-white/[0.02] border border-white/[0.06] rounded-2xl p-5 space-y-3">
        <div className="flex items-start gap-3 mb-1">
          <GitBranch className="w-4 h-4 text-violet-400 mt-0.5 shrink-0" />
          <div>
            <div className="text-sm font-semibold text-white">3-Phase Sequential Pipeline</div>
            <p className="text-xs text-slate-500 mt-0.5">Analyst gathers data → Quant computes risk/reward → Strategist synthesises final recommendation. Each phase feeds the next.</p>
          </div>
        </div>
        <div className="flex gap-3">
          <div className="flex items-center gap-2 bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2 flex-1">
            <Search className="w-4 h-4 text-slate-500 shrink-0" />
            <input value={input} onChange={e => setInput(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && !loading && launch()}
              placeholder="Enter symbol — AAPL, TSLA, SPY…"
              className="bg-transparent text-sm text-white placeholder-slate-600 focus:outline-none flex-1 font-mono" />
          </div>
          <button onClick={launch} disabled={loading || !input.trim()}
            className="flex items-center gap-2 px-5 py-2 bg-violet-500/70 hover:bg-violet-500/90 disabled:opacity-40 text-white text-sm font-bold rounded-xl transition-colors">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitBranch className="w-4 h-4" />}
            {loading ? 'Running…' : 'Run Pipeline'}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {result && (
        <>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <GitBranch className="w-3.5 h-3.5 text-violet-400" />
            <span>
              {result.phases?.filter(p => p.status === 'done').length ?? 0}/3 phases completed
              {result.totalMs && <span className="ml-2 text-slate-600">· {result.totalMs}ms total</span>}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-3">
            {(result.phases || []).map(p => (
              <PhaseCard key={p.id} phase={p} active={p.status !== 'idle'} />
            ))}
          </div>
          {result.synthesis && (
            <SynthesisPanel text={result.synthesis} llmUsed={result.llmUsed} />
          )}
        </>
      )}

      {!result && !loading && (
        <div className="text-center py-16 text-slate-600 text-sm space-y-2">
          <GitBranch className="w-8 h-8 mx-auto opacity-20" />
          <p>Each phase builds on the previous for deeper, more actionable analysis.</p>
          <div className="flex items-center justify-center gap-2 text-xs text-slate-700">
            <span>🔍 Analyst</span><span>→</span><span>📐 Quant</span><span>→</span><span>🎯 Strategist</span>
          </div>
        </div>
      )}
    </div>
  )
}

// ── ─────────────────────────────────────────────────────────────────────────────
//    TAB 3 — Task Scheduler
// ── ─────────────────────────────────────────────────────────────────────────────

const STATUS_STYLES = {
  idle:    { color: 'text-slate-500',   bg: 'bg-slate-500/10   border-slate-500/20',   icon: Clock         },
  running: { color: 'text-sky-400',     bg: 'bg-sky-500/10     border-sky-500/20',     icon: Loader2       },
  done:    { color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20', icon: CheckCircle2  },
  failed:  { color: 'text-red-400',     bg: 'bg-red-500/10     border-red-500/20',     icon: XCircle       },
}

function JobResultPreview({ job }) {
  const [open, setOpen] = useState(false)
  const d = job.result.data
  if (!d) return null

  const preview = (() => {
    if (d.skipped)        return `⚠ Skipped — ${d.reason}`
    if (d.signals?.length) return `${d.signals.length} signals · top: ${d.signals[0]?.symbol} ${d.signals[0]?.signal}`
    if (d.events?.length)  return `${d.events.length} earnings events · next: ${d.events[0]?.symbol} on ${d.events[0]?.date}`
    if (d.regime)          return `Regime: ${d.regime} · ${d.signals?.length ?? 0} macro signals`
    return null
  })()

  return (
    <div className="mt-2">
      {preview && (
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-slate-400">{preview}</span>
          <button onClick={() => setOpen(o => !o)} className="text-slate-600 hover:text-white ml-2 shrink-0">
            {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>
      )}
      {open && (
        <pre className="mt-2 text-[10px] text-slate-400 overflow-auto max-h-48 bg-black/20 rounded-lg p-2">
          {JSON.stringify(d, null, 2)}
        </pre>
      )}
    </div>
  )
}

function JobCard({ job, onTrigger, onToggle }) {
  const [triggering, setTriggering] = useState(false)
  const s    = STATUS_STYLES[job.result.status] ?? STATUS_STYLES.idle
  const Icon = s.icon

  const handleTrigger = async () => {
    setTriggering(true)
    await onTrigger(job.id)
    setTriggering(false)
  }

  return (
    <div className={`bg-white/[0.02] border rounded-2xl p-5 space-y-3 ${job.enabled ? 'border-white/[0.06]' : 'border-white/[0.03] opacity-60'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-white">{job.name}</span>
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${s.bg} ${s.color}`}>
              <Icon className={`w-2.5 h-2.5 ${job.result.status === 'running' ? 'animate-spin' : ''}`} />
              {job.result.status}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">{job.description}</p>
        </div>
        <button onClick={() => onToggle(job.id, !job.enabled)} className="shrink-0 text-slate-500 hover:text-white transition-colors">
          {job.enabled ? <ToggleRight className="w-5 h-5 text-mint-400" /> : <ToggleLeft className="w-5 h-5" />}
        </button>
      </div>

      <div className="flex items-center gap-4 text-xs text-slate-500 flex-wrap">
        <div className="flex items-center gap-1.5"><Calendar className="w-3 h-3" /><span>{job.scheduleText}</span></div>
        <div className="flex items-center gap-1.5"><Clock className="w-3 h-3" /><span>Last run: {timeAgo(job.result.lastRun)}</span></div>
      </div>

      {job.result.error && <div className="text-xs text-red-400 truncate">{job.result.error}</div>}
      <JobResultPreview job={job} />

      <button onClick={handleTrigger} disabled={triggering || job.result.status === 'running'}
        className="flex items-center gap-2 px-4 py-1.5 bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] disabled:opacity-40 text-white text-xs font-medium rounded-lg transition-colors">
        {triggering || job.result.status === 'running'
          ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Running…</>
          : <><Play className="w-3.5 h-3.5" /> Run Now</>
        }
      </button>
    </div>
  )
}

function SchedulerTab() {
  const [jobs,    setJobs]    = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  const load = useCallback(async () => {
    try {
      const r    = await apiFetch('/api/scheduler/jobs')
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'Failed to load jobs')
      setJobs(data)
    } catch (e) { setError(e.message) }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const handleTrigger = async (id) => {
    setJobs(prev => prev.map(j => j.id === id ? { ...j, result: { ...j.result, status: 'running' } } : j))
    try {
      const r    = await apiFetch(`/api/scheduler/jobs/${id}/trigger`, { method: 'POST' })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error)
      await load()
    } catch (e) {
      setJobs(prev => prev.map(j => j.id === id ? { ...j, result: { ...j.result, status: 'failed', error: e.message } } : j))
    }
  }

  const handleToggle = async (id, enabled) => {
    setJobs(prev => prev.map(j => j.id === id ? { ...j, enabled } : j))
    await apiFetch(`/api/scheduler/jobs/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) })
  }

  if (loading) return <div className="flex items-center justify-center py-16"><div className="w-6 h-6 border-2 border-mint-400/30 border-t-mint-400 rounded-full animate-spin" /></div>
  if (error)   return <div className="flex items-center gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-sm"><AlertTriangle className="w-4 h-4 shrink-0" /> {error}</div>

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>{jobs.length} scheduled jobs</span>
        <button onClick={load} className="flex items-center gap-1 hover:text-white transition-colors">
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>
      {jobs.map(job => <JobCard key={job.id} job={job} onTrigger={handleTrigger} onToggle={handleToggle} />)}
      <div className="text-[10px] text-slate-600 text-center pt-2">
        Jobs run in the background on the server · Times are server-local · Results cached in-memory
      </div>
    </div>
  )
}

// ── ─────────────────────────────────────────────────────────────────────────────
//    TAB 4 — Telemetry (run history)
// ── ─────────────────────────────────────────────────────────────────────────────

const STATUS_DOT = { done: 'bg-emerald-400', partial: 'bg-amber-400', failed: 'bg-red-400' }
const MODE_BADGE = {
  parallel: { label: 'Parallel', color: 'text-mint-400 border-mint-500/25 bg-mint-500/8' },
  pipeline: { label: 'Pipeline', color: 'text-violet-400 border-violet-500/25 bg-violet-500/8' },
}

function TelemetryTab() {
  const [runs, setRuns] = useState(loadTelemetry)

  const clearAll = () => {
    localStorage.removeItem(TELEMETRY_KEY)
    setRuns([])
  }

  if (runs.length === 0) return (
    <div className="text-center py-16 text-slate-600 text-sm space-y-2">
      <BarChart2 className="w-8 h-8 mx-auto opacity-20" />
      <p>No runs recorded yet — launch research or pipeline agents to see telemetry.</p>
    </div>
  )

  const totalRuns = runs.length
  const avgDuration = runs.length ? Math.round(runs.reduce((s,r) => s + (r.durationMs||0), 0) / runs.length) : 0
  const successRate = runs.length ? Math.round(runs.filter(r => r.status === 'done' || r.status === 'partial').length / runs.length * 100) : 0

  return (
    <div className="space-y-4">
      {/* Summary row */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Total Runs',   value: totalRuns,        unit: '' },
          { label: 'Avg Duration', value: avgDuration,      unit: 'ms' },
          { label: 'Success Rate', value: `${successRate}`, unit: '%' },
        ].map(({ label, value, unit }) => (
          <div key={label} className="glass rounded-xl p-3 border border-white/[0.06] text-center">
            <div className="text-lg font-bold text-white">{value}<span className="text-xs text-slate-500 ml-0.5">{unit}</span></div>
            <div className="text-[10px] text-slate-500 mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>Last {runs.length} runs</span>
        <button onClick={clearAll} className="text-xs text-red-500/60 hover:text-red-400 transition-colors">Clear history</button>
      </div>

      <div className="space-y-1.5">
        {runs.map(run => {
          const mode = MODE_BADGE[run.mode] ?? MODE_BADGE.parallel
          const dot  = STATUS_DOT[run.status] ?? 'bg-slate-500'
          return (
            <div key={run.id} className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-white/[0.02] border border-white/[0.05] hover:bg-white/[0.03] transition-colors">
              <div className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
              <span className="text-xs font-mono font-bold text-white w-16 shrink-0">{run.symbol || '—'}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${mode.color} shrink-0`}>{mode.label}</span>
              <span className="text-[11px] text-slate-400 flex-1">{run.agentCount} agent{run.agentCount !== 1 ? 's' : ''}</span>
              {run.llmUsed && <span className="text-[10px] text-slate-600 shrink-0">{run.llmUsed}</span>}
              <span className="text-[10px] text-slate-600 shrink-0 flex items-center gap-1">
                <Timer className="w-2.5 h-2.5" />{run.durationMs ? `${(run.durationMs/1000).toFixed(1)}s` : '—'}
              </span>
              <span className="text-[10px] text-slate-600 shrink-0 w-16 text-right">{timeAgo(run.timestamp)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Root view ─────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'research',  label: 'Research Agent',   icon: Network   },
  { id: 'pipeline',  label: 'Pipeline',         icon: GitBranch },
  { id: 'scheduler', label: 'Task Scheduler',   icon: Calendar  },
  { id: 'telemetry', label: 'Telemetry',        icon: BarChart2 },
]

export default function AgentHubView() {
  const [tab, setTab] = useState('research')

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-2.5 rounded-xl bg-mint-500/10 border border-mint-500/20">
          <Network className="w-5 h-5 text-mint-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Agent Hub</h1>
          <p className="text-xs text-slate-500">Multi-agent research · 3-phase pipeline · Scheduled tasks · Run telemetry</p>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-white/[0.06] pb-0 overflow-x-auto">
        {TABS.map(t => {
          const Icon = t.icon
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-all whitespace-nowrap ${
                tab === t.id ? 'border-mint-500 text-mint-400' : 'border-transparent text-slate-400 hover:text-white'
              }`}>
              <Icon className="w-3.5 h-3.5" />
              {t.label}
            </button>
          )
        })}
      </div>

      {tab === 'research'  && <ResearchAgentTab />}
      {tab === 'pipeline'  && <PipelineTab />}
      {tab === 'scheduler' && <SchedulerTab />}
      {tab === 'telemetry' && <TelemetryTab />}
    </div>
  )
}
