import { useState } from 'react'
import {
  CheckCircle2, Clock, Loader2, AlertTriangle, ChevronDown, ChevronUp,
  Search, GitBranch,
} from 'lucide-react'
import { getApiKeyHeaders } from '../../../services/api'
import { apiFetch, saveTelemetryRun } from './shared'
import SynthesisPanel from './SynthesisPanel'

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

export default function PipelineTab() {
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
