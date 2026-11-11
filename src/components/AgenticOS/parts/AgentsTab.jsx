/**
 * Agents — each autonomous part in full: what it does, why it is in its current
 * state, the jobs behind it, and (for admins) the controls that exist for it.
 *
 * Only the Agent Desk and Strategy Brain have run / pause / resume endpoints; the
 * rest are scheduled jobs, which are run from the Schedule tab. The page does not
 * invent controls that do not exist.
 */
import { Play, Pause, RotateCcw, ArrowRight, Lock } from 'lucide-react'
import { Section, Chip, Dot, Note, AGENT_STATE, JOB_STATE, btn, btnQuiet, relTime, exact } from './ui'

function JobPill({ j }) {
  const st = JOB_STATE[j.status] || JOB_STATE.idle
  return (
    <li className="inline-flex items-center gap-1.5 text-[11px] text-slate-300 rounded-full border border-slate-500/20 bg-slate-500/[0.06] pl-2 pr-2.5 py-0.5"
      title={`${j.name} — ${st.label}${j.lastRunAt ? `, last ran ${exact(j.lastRunAt)}` : ''}${j.enabled ? '' : ' (switched off)'}`}>
      <Dot tone={j.enabled ? st.tone : 'muted'} className="!w-1.5 !h-1.5" />
      <span className={j.enabled ? '' : 'line-through text-slate-500'}>{j.name}</span>
    </li>
  )
}

function Controls({ a, isAdmin, act, busy }) {
  if (!a.controls) return null
  if (!isAdmin) return <span className="inline-flex items-center gap-1 text-[11px] text-slate-500"><Lock className="w-3 h-3" aria-hidden="true" />Admins can run and pause this</span>
  const locked = !!busy
  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" className={btn} disabled={locked || a.state === 'running' || a.state === 'off' || a.state === 'paused'} onClick={() => act(`run:${a.id}`, `${a.controls}/run`)}>
        <Play className="w-3.5 h-3.5" aria-hidden="true" />{busy === `run:${a.id}` ? 'Starting…' : 'Run now'}
      </button>
      {a.state === 'paused'
        ? <button type="button" className={btn} disabled={locked} onClick={() => act(`resume:${a.id}`, `${a.controls}/resume`)}><RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />Resume</button>
        : <button type="button" className={btn} disabled={locked || a.state === 'off'} onClick={() => act(`pause:${a.id}`, `${a.controls}/pause`, { reason: 'paused from Agentic OS' })}><Pause className="w-3.5 h-3.5" aria-hidden="true" />Pause</button>}
    </div>
  )
}

export default function AgentsTab({ data, isAdmin, act, busy, go }) {
  const jobsById = new Map(data.jobs.map(j => [j.id, j]))
  const neverRan = data.jobs.length > 0 && data.jobs.every(j => !j.lastRunAt)
  return (
    <div className="space-y-3">
      {neverRan && <Note>No job has run since the server last restarted. Run results are kept in memory, so this is normal right after a deploy — agents show “Waiting” until their next scheduled run.</Note>}
      <Note>
        {isAdmin
          ? 'You are an admin: the Agent Desk and Strategy Brain can be run or paused here. Everything else is a scheduled job — run those from the Schedule tab.'
          : 'Agents run on their own schedule. Admins can run or pause the Agent Desk and Strategy Brain from here.'}
        {' '}Switches such as AGENT_DESK_ENABLED and the spend cap belong to the operator and cannot be changed from the app.
      </Note>
      {data.agents.map(a => {
        const st = AGENT_STATE[a.state] || AGENT_STATE.waiting
        const jobs = a.jobIds.map(id => jobsById.get(id)).filter(Boolean)
        const last = relTime(a.lastRunAt)
        return (
          <Section key={a.id} id={`agent-${a.id}`}
            title={<span className="inline-flex items-center gap-2">{a.label}<Chip tone={st.tone}>{st.label}</Chip></span>}
            sub={a.blurb}
            action={a.open && <button type="button" className={btnQuiet} onClick={() => go(a.open)}>Open page<ArrowRight className="w-3 h-3" aria-hidden="true" /></button>}>
            {a.detail && a.state !== 'healthy' && (
              <p className={`text-xs mb-3 [overflow-wrap:anywhere] ${a.state === 'failing' ? 'text-red-400' : a.state === 'paused' ? 'text-amber-300' : 'text-slate-400'}`}>{a.detail}</p>
            )}
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div><dt className="text-slate-500">Last ran</dt><dd className="text-slate-200 mt-0.5" title={a.lastRunAt ? exact(a.lastRunAt) : undefined}>{last || 'Not since restart'}</dd></div>
              <div><dt className="text-slate-500">Next</dt><dd className="text-slate-200 mt-0.5">{a.nextText || '—'}</dd></div>
              <div><dt className="text-slate-500">Jobs</dt><dd className="text-slate-200 mt-0.5 tabular-nums">{a.jobs.total ? `${a.jobs.ok} ok${a.jobs.failed ? ` · ${a.jobs.failed} failed` : ''}${a.jobs.idle ? ` · ${a.jobs.idle} not run` : ''}` : '—'}</dd></div>
              {a.metric && <div><dt className="text-slate-500">{a.metric.label}</dt><dd className={`mt-0.5 font-medium tabular-nums ${a.metric.tone === 'warn' ? 'text-amber-300' : 'text-slate-200'}`}>{a.metric.value}</dd></div>}
            </dl>
            {jobs.length > 0 && <ul className="flex flex-wrap gap-1.5 mt-3" aria-label={`${a.label} jobs`}>{jobs.map(j => <JobPill key={j.id} j={j} />)}</ul>}
            {a.controls && <div className="mt-3 pt-3 border-t border-slate-500/10"><Controls a={a} isAdmin={isAdmin} act={act} busy={busy} /></div>}
          </Section>
        )
      })}
    </div>
  )
}
