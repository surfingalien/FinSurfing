/**
 * Overview — answers four questions in the order a person asks them:
 *   1. Is everything OK?            → the verdict
 *   2. What needs me?               → attention list, each item with the page that fixes it
 *   3. What are they doing / costing? → the agents, spend, recent activity
 */
import { useState } from 'react'
import { CheckCircle2, Clock, AlertTriangle, OctagonAlert, Info, ArrowRight, Sparkles, Activity, Bot, CalendarClock, ClipboardCheck, Wallet } from 'lucide-react'
import { Section, Chip, Dot, Empty, AGENT_STATE, LEVEL_TONE, TONE, btnQuiet, relTime, exact, usd } from './ui'

const VERDICT = {
  waiting:   { icon: Clock, wrap: 'border-slate-500/25 bg-slate-500/[0.06]', ico: 'text-slate-400' },
  ok:        { icon: CheckCircle2, wrap: 'border-emerald-500/25 bg-emerald-500/[0.06]', ico: 'text-emerald-400' },
  attention: { icon: AlertTriangle, wrap: 'border-amber-500/25 bg-amber-500/[0.06]', ico: 'text-amber-300' },
  critical:  { icon: OctagonAlert, wrap: 'border-red-500/30 bg-red-500/[0.07]', ico: 'text-red-400' },
}
const LEVEL_ICON = { critical: OctagonAlert, warn: AlertTriangle, info: Info }
const FEED_TONE = { ok: 'ok', fail: 'bad', warn: 'warn', info: 'neutral' }

function Kpi({ icon: Icon, label, value, sub, subTone, onClick }) {
  return (
    <button type="button" onClick={onClick}
      className="group text-left rounded-xl bg-slate-500/10 hover:bg-slate-500/15 border border-slate-500/15 px-3 py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint-500/40">
      <div className="flex items-center gap-1.5 text-[11px] text-slate-500"><Icon className="w-3.5 h-3.5" aria-hidden="true" />{label}</div>
      <div className="text-xl font-semibold text-white tabular-nums mt-0.5">{value}</div>
      {sub && <div className={`text-[11px] mt-0.5 ${subTone === 'bad' ? 'text-red-400' : subTone === 'warn' ? 'text-amber-300' : 'text-slate-500'}`}>{sub}</div>}
    </button>
  )
}

function Verdict({ d, go }) {
  const v = VERDICT[d.verdict.level] || VERDICT.ok
  const Icon = v.icon
  const k = d.kpis
  const off = d.agents.filter(a => a.state === 'off').length
  const paused = d.agents.filter(a => a.state === 'paused').length
  const b = d.spend?.budget
  return (
    <section className={`rounded-2xl border p-4 sm:p-5 ${v.wrap}`} aria-label="System status">
      <div className="flex items-start gap-3">
        <Icon className={`w-7 h-7 shrink-0 mt-0.5 ${v.ico}`} aria-hidden="true" />
        <div className="min-w-0">
          <h2 className="text-lg sm:text-xl font-semibold text-white leading-tight">{d.verdict.headline}</h2>
          {d.verdict.detail && <p className="text-sm text-slate-400 mt-0.5">{d.verdict.detail}</p>}
        </div>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 mt-4">
        <Kpi icon={Bot} label="Agents on" value={`${k.agentsActive} of ${k.agentsTotal}`} sub={off || paused ? [off && `${off} off`, paused && `${paused} paused`].filter(Boolean).join(' · ') : 'all switched on'} onClick={() => go('agents')} />
        <Kpi icon={CalendarClock} label="Scheduled jobs" value={k.jobsTotal} sub={k.jobsFailing ? `${k.jobsFailing} failing` : k.jobsRunning ? `${k.jobsRunning} running now` : 'none failing'} subTone={k.jobsFailing ? 'bad' : undefined} onClick={() => go('schedule')} />
        <Kpi icon={ClipboardCheck} label="Awaiting approval" value={k.pendingApprovals} sub={k.pendingApprovals ? 'in the Agent Desk' : 'nothing waiting'} subTone={k.pendingApprovals ? 'warn' : undefined} onClick={() => go({ tab: 'agent-desk' })} />
        <Kpi icon={Wallet} label="AI spend this month" value={k.spendMonthUsd == null ? '—' : usd(k.spendMonthUsd)} sub={b ? `agents: ${usd(b.spentUsd)} of ${usd(b.capUsd, 0)}` : 'all models'} onClick={() => document.getElementById('spend')?.scrollIntoView({ behavior: 'smooth', block: 'center' })} />
      </div>
    </section>
  )
}

function Attention({ items, go }) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, 5)
  return (
    <Section id="attention" title="Needs attention" sub={items.length ? `${items.length} item${items.length === 1 ? '' : 's'}, most urgent first` : undefined}>
      {!items.length ? (
        <Empty icon={Sparkles}>Nothing needs you right now. This list fills in when a job fails, a budget runs low, or an agent has a change for you to approve.</Empty>
      ) : (
        <ul className="divide-y divide-slate-500/10 -my-1">
          {shown.map(a => {
            const Icon = LEVEL_ICON[a.level] || Info
            const tone = LEVEL_TONE[a.level]
            return (
              <li key={a.id} className="flex items-start gap-3 py-2.5">
                <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${TONE[tone].split(' ')[0]}`} aria-label={a.level} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-white [overflow-wrap:anywhere]">{a.title}</p>
                  {a.detail && <p className="text-xs text-slate-500 mt-0.5 line-clamp-2 [overflow-wrap:anywhere]">{a.detail}</p>}
                </div>
                {a.action && (
                  <button type="button" className={`${btnQuiet} shrink-0 mt-0.5`} onClick={() => go(a.action.route || a.action.tab)}>
                    {a.action.label}<ArrowRight className="w-3 h-3" aria-hidden="true" />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {items.length > 5 && (
        <button type="button" className={`${btnQuiet} mt-2`} onClick={() => setAll(v => !v)}>{all ? 'Show fewer' : `Show all ${items.length}`}</button>
      )}
    </Section>
  )
}

function Sparkline({ values }) {
  if (values.length < 2) return null
  const W = 200, H = 36
  const hi = Math.max(...values, 0.0001)
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * W},${H - 2 - (v / hi) * (H - 6)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-9 text-mint-400" role="img" aria-label={`Daily AI spend, last ${values.length} days`}>
      <polyline points={`0,${H} ${pts} ${W},${H}`} fill="currentColor" opacity="0.12" stroke="none" />
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function Spend({ s }) {
  if (!s) return <Section id="spend" title="AI spend"><Empty icon={Wallet}>Spend could not be loaded just now.</Empty></Section>
  const b = s.budget
  const max = Math.max(...s.topRoutes.map(r => r.costUsd), 0.0001)
  const tone = !b ? 'live' : b.exhausted ? 'bad' : b.usedPct >= 80 ? 'warn' : 'ok'
  const barCls = { bad: 'bg-red-400', warn: 'bg-amber-400', ok: 'bg-emerald-400', live: 'bg-mint-400' }[tone]
  return (
    <Section id="spend" title="AI spend" sub={`Calls to AI models, ${s.month}`}>
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="text-2xl font-semibold text-white tabular-nums">{usd(s.monthUsd)}</div>
          <div className="text-[11px] text-slate-500">this month · {s.calls.toLocaleString()} calls logged{s.successRate != null ? ` · ${s.successRate}% succeeded` : ''}</div>
        </div>
        <div className="w-28"><Sparkline values={s.byDay.map(d => d.costUsd)} /></div>
      </div>

      {b && (
        <div className="mt-4">
          <div className="flex justify-between text-[11px] mb-1">
            <span className="text-slate-400">Agents’ monthly budget <span className="text-slate-600">(Agent Desk + Strategy Brain)</span></span>
            <span className="text-slate-300 tabular-nums">{usd(b.spentUsd)} / {usd(b.capUsd, 0)}</span>
          </div>
          <div className="h-1.5 rounded-full bg-slate-500/15 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(b.usedPct))} aria-label="Agents’ budget used">
            <div className={`h-full rounded-full ${barCls}`} style={{ width: `${Math.min(100, b.usedPct)}%` }} />
          </div>
          {b.exhausted && <p className="text-[11px] text-red-400 mt-1">Budget reached — the agents have stopped calling the model until next month.</p>}
        </div>
      )}

      {s.topRoutes.length > 0 && (
        <div className="mt-4">
          <div className="text-[11px] text-slate-500 mb-1.5">Where it goes {s.since ? <span className="text-slate-600">(since {new Date(s.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })})</span> : null}</div>
          <ul className="space-y-1.5">
            {s.topRoutes.map(r => (
              <li key={r.route} className="grid grid-cols-[1fr_auto] items-center gap-x-3 text-xs">
                <span className="truncate text-slate-300 font-mono text-[11px]">{r.route}</span>
                <span className="text-slate-400 tabular-nums">{usd(r.costUsd)}</span>
                <span className="col-span-2 h-1 rounded-full bg-slate-500/10 overflow-hidden"><span className="block h-full rounded-full bg-mint-400/60" style={{ width: `${(r.costUsd / max) * 100}%` }} /></span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {s.cacheHitRate != null && <p className="text-[11px] text-slate-500 mt-3">Prompt cache is serving {Math.round(s.cacheHitRate * 100)}% of prompt tokens — higher is cheaper.</p>}
    </Section>
  )
}

function AgentCard({ a, go }) {
  const st = AGENT_STATE[a.state] || AGENT_STATE.waiting
  const last = relTime(a.lastRunAt)
  return (
    <li className="rounded-xl border border-slate-500/15 bg-slate-500/[0.04] p-3 flex flex-col gap-2 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-white truncate">{a.label}</h3>
        <Chip tone={st.tone}>{st.label}</Chip>
      </div>
      <p className="text-xs text-slate-500 line-clamp-2 min-h-[2rem] [overflow-wrap:anywhere]">{a.state === 'failing' || a.state === 'off' || a.state === 'paused' ? (a.detail || a.blurb) : a.blurb}</p>
      <div className="flex items-center justify-between gap-2 text-[11px] mt-auto pt-1 border-t border-slate-500/10">
        <span className="text-slate-500 truncate" title={a.lastRunAt ? exact(a.lastRunAt) : undefined}>{last ? `Last ran ${last}` : 'Not run since restart'}</span>
        {a.metric
          ? <span className={a.metric.tone === 'warn' ? 'text-amber-300' : 'text-slate-400'}>{a.metric.value} <span className="text-slate-500">{a.metric.label.toLowerCase()}</span></span>
          : a.open && <button type="button" className={btnQuiet} onClick={() => go(a.open)}>Open<ArrowRight className="w-3 h-3" aria-hidden="true" /></button>}
      </div>
    </li>
  )
}

function Feed({ feed }) {
  const [all, setAll] = useState(false)
  const shown = all ? feed : feed.slice(0, 8)
  return (
    <Section id="activity" title="Recent activity" sub="Job runs, desk cycles and proposals, newest first">
      {!feed.length ? (
        <Empty icon={Activity}>No activity yet. Scheduled jobs report here after their first run; the list resets on each deploy.</Empty>
      ) : (
        <ol className="relative border-l border-slate-500/20 ml-1.5 space-y-3">
          {shown.map((e, i) => (
            <li key={`${e.at}-${i}`} className="pl-4 relative">
              <Dot tone={FEED_TONE[e.level] || 'neutral'} className="absolute -left-[5px] top-1.5" />
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-sm text-slate-200">{e.title}</p>
                <time dateTime={e.at} title={exact(e.at)} className="text-[11px] text-slate-500 whitespace-nowrap">{relTime(e.at)}</time>
              </div>
              {e.detail && <p className="text-xs text-slate-500 mt-0.5 line-clamp-2 [overflow-wrap:anywhere]">{e.detail}</p>}
            </li>
          ))}
        </ol>
      )}
      {feed.length > 8 && <button type="button" className={`${btnQuiet} mt-3`} onClick={() => setAll(v => !v)}>{all ? 'Show fewer' : `Show all ${feed.length}`}</button>}
    </Section>
  )
}

export default function OverviewTab({ data, go }) {
  return (
    <div className="space-y-4">
      <Verdict d={data} go={go} />
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3 min-w-0"><Attention items={data.attention} go={go} /></div>
        <div className="lg:col-span-2 min-w-0"><Spend s={data.spend} /></div>
      </div>
      <Section title="Your agents" sub="The autonomous parts of FinSurfing and what each is doing"
        action={<button type="button" className={btnQuiet} onClick={() => go('agents')}>Details &amp; controls<ArrowRight className="w-3 h-3" aria-hidden="true" /></button>}>
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {data.agents.map(a => <AgentCard key={a.id} a={a} go={go} />)}
        </ul>
      </Section>
      <Feed feed={data.feed} />
    </div>
  )
}
