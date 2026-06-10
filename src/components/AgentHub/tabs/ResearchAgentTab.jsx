import { useState } from 'react'
import {
  Network, Play, CheckCircle2, XCircle,
  Loader2, AlertTriangle, ChevronDown, ChevronUp, Search,
} from 'lucide-react'
import { getApiKeyHeaders } from '../../../services/api'
import { apiFetch, saveTelemetryRun } from './shared'
import SynthesisPanel from './SynthesisPanel'

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

export default function ResearchAgentTab() {
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
