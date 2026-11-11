/**
 * Agentic OS — mission control for the autonomous parts of FinSurfing.
 *
 * One request (GET /api/agentic-os/overview, built by lib/agentic-overview.js)
 * feeds Overview, Agents, Schedule and Connections; Data flow loads its own map.
 * The page answers, in order: is everything OK, what needs me, what are the
 * agents doing and costing — and never invents a status it cannot see (a source
 * that failed to load is listed as unavailable, not shown as healthy).
 *
 *   #/agentic-os              Overview
 *   #/agentic-os/agents       Agents (details + admin controls)
 *   #/agentic-os/schedule     every scheduled job
 *   #/agentic-os/connections  configured providers + AI circuit breakers
 *   #/agentic-os/flow         data flow, provider → screen
 */
import { useCallback, useRef, useState } from 'react'
import { LayoutGrid, Bot, CalendarClock, Plug, Workflow, RefreshCw, Loader2, CheckCircle2, OctagonAlert } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useQuery, fetchJson } from '../../hooks/useQuery'
import { Note, btn, TONE } from './parts/ui'
import OverviewTab from './parts/OverviewTab'
import AgentsTab from './parts/AgentsTab'
import ScheduleTab from './parts/ScheduleTab'
import ConnectionsTab from './parts/ConnectionsTab'
import DataFlowTab from './parts/DataFlowTab'

const TABS = [
  { id: 'overview',    label: 'Overview',    icon: LayoutGrid },
  { id: 'agents',      label: 'Agents',      icon: Bot },
  { id: 'schedule',    label: 'Schedule',    icon: CalendarClock },
  { id: 'connections', label: 'Connections', icon: Plug },
  { id: 'flow',        label: 'Data flow',   icon: Workflow },
]
const DONE = { run: 'Started. It runs in the background and this page updates as it goes.', job: 'Started. It runs in the background and this page updates as it goes.', toggle: 'Saved.', pause: 'Paused — it stops at its next step.', resume: 'Resumed.', breaker: 'Circuit breaker reset.' }

function Skeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading Agentic OS">
      <div className="h-36 rounded-2xl bg-slate-500/10" />
      <div className="grid gap-4 lg:grid-cols-5"><div className="h-52 rounded-2xl bg-slate-500/10 lg:col-span-3" /><div className="h-52 rounded-2xl bg-slate-500/10 lg:col-span-2" /></div>
      <div className="h-64 rounded-2xl bg-slate-500/10" />
    </div>
  )
}

export default function AgenticOSView({ section, onSection, onNavigate }) {
  const { authFetch, isAuthenticated, user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const tab = TABS.some(t => t.id === section) ? section : 'overview'
  const fresh = useRef(false)
  const [busy, setBusy] = useState(null)
  const [notice, setNotice] = useState(null)

  // Poll quickly only while something is running; otherwise every 30s.
  const [fast, setFast] = useState(false)
  const key = `agentic-os:overview:${user?.id || 'me'}`
  const q = useQuery(key, async () => {
    const url = fresh.current ? '/api/agentic-os/overview?fresh=1' : '/api/agentic-os/overview'
    fresh.current = false
    const d = await fetchJson(url, undefined, authFetch)
    setFast(d.agents?.some(a => a.state === 'running') || d.kpis?.jobsRunning > 0)
    return d
  }, { staleMs: 15_000, refetchMs: fast ? 5_000 : 30_000, enabled: isAuthenticated })

  const { refetch } = q
  const refresh = useCallback(() => { fresh.current = true; return refetch() }, [refetch])

  /** Every write on this page goes through here: one busy flag, one notice, then a fresh read. */
  const act = useCallback(async (actKey, url, body, method = 'POST') => {
    setBusy(actKey); setNotice(null)
    try {
      const r = await authFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`)
      setNotice({ tone: 'ok', text: DONE[actKey.split(':')[0]] || 'Done.' })
    } catch (e) {
      setNotice({ tone: 'bad', text: e.message })
    } finally {
      setBusy(null)
      refresh()
    }
  }, [authFetch, refresh])

  /** A string is a tab on this page; an object { tab, param } is another page of the app. */
  const go = useCallback((target) => {
    if (typeof target === 'string') { onSection?.(target === 'overview' ? undefined : target); return }
    if (target?.tab) onNavigate?.(target.tab, target.param)
  }, [onSection, onNavigate])

  const onTabKey = (e) => {
    const i = TABS.findIndex(t => t.id === tab)
    const next = e.key === 'ArrowRight' ? TABS[(i + 1) % TABS.length] : e.key === 'ArrowLeft' ? TABS[(i - 1 + TABS.length) % TABS.length] : e.key === 'Home' ? TABS[0] : e.key === 'End' ? TABS.at(-1) : null
    if (!next) return
    e.preventDefault()
    go(next.id)
    requestAnimationFrame(() => document.getElementById(`ao-tab-${next.id}`)?.focus())
  }

  if (!isAuthenticated) return <div className="p-4 max-w-6xl"><Note>Sign in to see Agentic OS.</Note></div>

  const d = q.data
  const counts = d ? { agents: d.agents.length, schedule: d.jobs.length } : {}
  const badge = (id) => (id === 'schedule' && d?.kpis.jobsFailing ? { n: d.kpis.jobsFailing, bad: true } : counts[id] != null ? { n: counts[id] } : null)

  return (
    <div className="p-4 max-w-6xl w-full min-w-0 space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-white">Agentic OS</h1>
          <p className="text-sm text-slate-400 mt-0.5">The autonomous agents that run FinSurfing — what they’re doing, what they cost, and what needs you.</p>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-slate-500">
          {d && <span aria-live="off">Updated {new Date(d.generatedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span>}
          <button type="button" className={btn} onClick={refresh} disabled={q.fetching} aria-label="Refresh now">
            {q.fetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />}Refresh
          </button>
        </div>
      </header>

      <div role="tablist" aria-label="Agentic OS sections" onKeyDown={onTabKey} className="flex gap-1 overflow-x-auto border-b border-slate-500/15 -mb-px">
        {TABS.map(t => {
          const on = t.id === tab
          const b = badge(t.id)
          const Icon = t.icon
          return (
            <button key={t.id} id={`ao-tab-${t.id}`} role="tab" type="button" aria-selected={on} aria-controls="ao-panel" tabIndex={on ? 0 : -1} onClick={() => go(t.id)}
              className={`shrink-0 inline-flex items-center gap-2 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint-500/40 rounded-t-md ${on ? 'text-white border-mint-500' : 'text-slate-400 border-transparent hover:text-white'}`}>
              <Icon className="w-4 h-4" aria-hidden="true" />{t.label}
              {b && <span className={`text-[10px] tabular-nums px-1.5 py-px rounded-full border ${b.bad ? TONE.bad : 'text-slate-400 border-slate-500/20'}`}>{b.n}{b.bad ? ' failing' : ''}</span>}
            </button>
          )
        })}
      </div>

      {notice && (
        <div role="status" className={`flex items-start gap-2 text-xs rounded-xl px-3 py-2 border ${notice.tone === 'ok' ? TONE.ok : TONE.bad}`}>
          {notice.tone === 'ok' ? <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" /> : <OctagonAlert className="w-4 h-4 shrink-0" aria-hidden="true" />}
          <span className="flex-1">{notice.text}</span>
          <button type="button" className="underline opacity-80 hover:opacity-100" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <div id="ao-panel" className="min-w-0" role="tabpanel" aria-labelledby={`ao-tab-${tab}`}>
        {q.loading ? <Skeleton /> : q.error && !d ? (
          <div className="space-y-3">
            <Note>Could not load Agentic OS: {q.error.message}.</Note>
            <button type="button" className={btn} onClick={refresh}><RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />Try again</button>
          </div>
        ) : d && (
          <>
            {q.error && <div className="mb-3"><Note>Showing the last good data — the latest refresh failed: {q.error.message}.</Note></div>}
            {tab === 'overview'    && <OverviewTab data={d} go={go} />}
            {tab === 'agents'      && <AgentsTab data={d} isAdmin={isAdmin} act={act} busy={busy} go={go} />}
            {tab === 'schedule'    && <ScheduleTab data={d} isAdmin={isAdmin} act={act} busy={busy} />}
            {tab === 'connections' && <ConnectionsTab data={d} isAdmin={isAdmin} act={act} busy={busy} go={go} />}
            {tab === 'flow'        && <DataFlowTab />}
          </>
        )}
      </div>
    </div>
  )
}
