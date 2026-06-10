import { useState, useEffect, useCallback } from 'react'
import {
  Calendar, Play, RefreshCw, CheckCircle2, XCircle,
  Clock, Loader2, ToggleLeft, ToggleRight, AlertTriangle, ChevronDown, ChevronUp,
} from 'lucide-react'
import { apiFetch, timeAgo } from './shared'

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

export default function SchedulerTab() {
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
