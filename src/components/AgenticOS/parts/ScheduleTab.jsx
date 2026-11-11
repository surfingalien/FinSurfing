/**
 * Schedule — every scheduled job on one sortable-by-urgency table: what it is,
 * when it runs, what happened last, and (admins) run it or switch it off.
 *
 * Results live in the server's memory, so after a deploy every job reads
 * "Not run yet" until its next slot. The page says so instead of showing blanks.
 *
 * Running a job can call paid AI models, so "Run now" asks once, inline.
 */
import { useMemo, useState } from 'react'
import { Search, Play, Power, Check, X } from 'lucide-react'
import { Section, Chip, Empty, Note, JOB_STATE, relTime, exact, dur } from './ui'

const ico = 'inline-flex items-center justify-center w-7 h-7 rounded-lg border border-slate-500/25 text-slate-300 hover:text-white hover:bg-slate-500/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint-500/40'

const FILTERS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'failed', label: 'Failing', test: j => j.enabled && j.status === 'failed' },
  { id: 'running', label: 'Running', test: j => j.status === 'running' },
  { id: 'idle', label: 'Not run yet', test: j => j.enabled && j.status === 'idle' },
  { id: 'off', label: 'Switched off', test: j => !j.enabled },
]
const ORDER = { failed: 0, running: 1, idle: 2, done: 3 }

export default function ScheduleTab({ data, isAdmin, act, busy }) {
  const [filter, setFilter] = useState('all')
  const [q, setQ] = useState('')
  const [confirm, setConfirm] = useState(null)
  const agentOf = useMemo(() => {
    const m = new Map()
    data.agents.forEach((a, i) => a.jobIds.forEach(id => m.set(id, { label: a.label, i })))
    return m
  }, [data.agents])

  const counts = Object.fromEntries(FILTERS.map(f => [f.id, data.jobs.filter(f.test).length]))
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const f = FILTERS.find(x => x.id === filter) || FILTERS[0]
    return data.jobs
      .filter(f.test)
      .filter(j => !needle || `${j.name} ${j.description} ${agentOf.get(j.id)?.label || ''}`.toLowerCase().includes(needle))
      .sort((a, b) => (a.enabled === b.enabled ? 0 : a.enabled ? -1 : 1) || ORDER[a.status] - ORDER[b.status] || (agentOf.get(a.id)?.i ?? 99) - (agentOf.get(b.id)?.i ?? 99) || a.name.localeCompare(b.name))
  }, [data.jobs, filter, q, agentOf])

  const neverRan = data.jobs.length > 0 && data.jobs.every(j => !j.lastRunAt)

  return (
    <div className="space-y-3">
      {neverRan && <Note>No job has run since the server last restarted — run results are kept in memory, so this is normal right after a deploy. Each job reports here at its next scheduled time.</Note>}
      <Section>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div role="group" aria-label="Filter jobs" className="flex flex-wrap gap-1.5">
            {FILTERS.map(f => (
              <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint-500/40 ${filter === f.id ? 'text-mint-400 bg-mint-500/10 border-mint-500/30' : 'text-slate-400 border-slate-500/20 hover:text-white'}`}>
                {f.label} <span className="tabular-nums text-slate-500">{counts[f.id]}</span>
              </button>
            ))}
          </div>
          <div className="relative ml-auto w-full sm:w-56">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" aria-hidden="true" />
            <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search jobs…" aria-label="Search jobs" className="input !pl-8 !py-1.5 !text-xs" />
          </div>
        </div>

        {!rows.length ? <Empty>No job matches. {filter !== 'all' || q ? 'Clear the filter or search to see all jobs.' : ''}</Empty> : (
          <div className="relative overflow-x-auto -mx-1">
            <table className="w-full min-w-[720px] text-xs">
              <thead>
                <tr className="text-left text-[11px] text-slate-500">
                  <th scope="col" className="font-medium px-1 pb-2 whitespace-nowrap">Job</th>
                  <th scope="col" className="font-medium px-2 pb-2">Agent</th>
                  <th scope="col" className="font-medium px-2 pb-2 whitespace-nowrap">Schedule</th>
                  <th scope="col" className="font-medium px-2 pb-2 whitespace-nowrap">Last run</th>
                  <th scope="col" className="font-medium px-2 pb-2 text-right whitespace-nowrap">Took</th>
                  <th scope="col" className="font-medium px-2 pb-2">Status</th>
                  {isAdmin && <th scope="col" className="px-1 pb-2"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map(j => {
                  const st = JOB_STATE[j.status] || JOB_STATE.idle
                  const asking = confirm === j.id
                  return (
                    <tr key={j.id} className="border-t border-slate-500/10 align-top">
                      <td className="px-1 py-2.5 max-w-[22rem]">
                        <div className={`font-medium ${j.enabled ? 'text-white' : 'text-slate-500'}`}>{j.name}</div>
                        {j.status === 'failed' && j.error
                          ? <div className="text-red-400 mt-0.5 [overflow-wrap:anywhere]">{j.error}</div>
                          : j.description && <div className="text-slate-500 mt-0.5 line-clamp-2">{j.description}</div>}
                      </td>
                      <td className="px-2 py-2.5 text-slate-400 whitespace-nowrap">{agentOf.get(j.id)?.label || '—'}</td>
                      <td className="px-2 py-2.5 text-slate-300 min-w-[9rem]">{j.scheduleText || '—'}</td>
                      <td className="px-2 py-2.5 text-slate-300 whitespace-nowrap" title={j.lastRunAt ? exact(j.lastRunAt) : undefined}>{relTime(j.lastRunAt) || <span className="text-slate-500">—</span>}</td>
                      <td className="px-2 py-2.5 text-slate-400 text-right tabular-nums">{dur(j.durationMs)}</td>
                      <td className="px-2 py-2.5">{j.enabled ? <Chip tone={st.tone}>{st.label}</Chip> : <Chip tone="muted">Off</Chip>}</td>
                      {isAdmin && (
                        <td className="px-1 py-2 text-right whitespace-nowrap">
                          {asking ? (
                            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                              <span className="text-[11px] text-slate-400">Run now? May use AI credits.</span>
                              <button type="button" className={ico} aria-label={`Confirm: run ${j.name}`} onClick={() => { setConfirm(null); act(`job:${j.id}`, `/api/scheduler/jobs/${j.id}/trigger`) }}><Check className="w-3.5 h-3.5" aria-hidden="true" /></button>
                              <button type="button" className={ico} aria-label="Cancel" onClick={() => setConfirm(null)}><X className="w-3.5 h-3.5" aria-hidden="true" /></button>
                            </span>
                          ) : (
                            <span className="inline-flex gap-1.5">
                              <button type="button" className={ico} disabled={!!busy || j.status === 'running' || !j.enabled} onClick={() => setConfirm(j.id)} title="Run this job now" aria-label={`Run ${j.name} now`}><Play className="w-3.5 h-3.5" aria-hidden="true" /></button>
                              <button type="button" className={ico} disabled={!!busy} onClick={() => act(`toggle:${j.id}`, `/api/scheduler/jobs/${j.id}`, { enabled: !j.enabled }, 'PATCH')} title={j.enabled ? 'Switch this job off' : 'Switch this job on'} aria-label={`${j.enabled ? 'Switch off' : 'Switch on'} ${j.name}`} aria-pressed={!j.enabled}>
                                <Power className="w-3.5 h-3.5" aria-hidden="true" />
                              </button>
                            </span>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      {!isAdmin && <p className="text-[11px] text-slate-500">Running or switching off a job needs an admin account.</p>}
    </div>
  )
}
