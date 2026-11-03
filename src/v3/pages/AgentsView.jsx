/**
 * v3 Agents — the Dev preview's Agents page on the Agent Desk's real state.
 *
 * Everything comes from GET /api/agent-desk/status: the paper book the hourly
 * manager runs (equity curve, return, open positions), the month's AI spend
 * against the operator's cap, the read-only limits, proposals waiting for an
 * admin (approve / reject go to the same endpoints as v1), what approved
 * changes did afterwards, and live operator alerts. v1's Agent Desk follows
 * underneath with the cycle log, experiments and the ledger in full.
 */

import { useState, lazy, Suspense } from 'react'
import { Check, X, Play, Pause } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useHero } from '../hero'
import { useAuthedJson } from '../data'
import { Card, Badge, Empty, Bar, LineChart, money, pct, signCls } from '../ui'

const AgentDeskView = lazy(() => import('../../components/AgentDesk/AgentDeskView'))

const TYPE = { 'strategy-version': 'Strategy', 'brain-finding': 'AI Brain', 'research-default-method': 'Research' }
const STATUS_TONE = { approved: 'up', rejected: 'down', acknowledged: 'up' }
const VERDICT_TONE = { helped: 'up', improving: 'up', resolved: 'up', hurt: 'down', worse: 'down' }
const when = (iso) => iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'
const day = (s) => s ? new Date(`${String(s).slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''

function DeskCard({ d, isAdmin, act, busy }) {
  const perf = d.paper?.performance ?? {}
  const hist = d.paper?.equityHistory ?? []
  const pts = hist.map(h => h.equity)
  const lastCycle = d.lastCycle
  const failed = lastCycle?.steps?.some(s => s.name === 'error' || s.error)
  return (
    <Card className="v3-span-8" title="Agent Desk"
      sub={d.paper?.enabled ? 'The hourly manager runs the paper book. Changes to strategies wait for your approval.' : 'Paper trading is switched off by the operator, so the book is not trading.'}
      action={<div className="v3-row-gap">
        {lastCycle ? <Badge tone={failed ? 'down' : 'up'}>Last cycle {when(lastCycle.at)}</Badge> : <Badge>No cycle yet</Badge>}
        {isAdmin && (d.paused
          ? <button className="v3-btn" disabled={!!busy} onClick={() => act('resume', '/api/agent-desk/resume')}><Play className="w-3.5 h-3.5" /> Resume</button>
          : <button className="v3-btn" disabled={!!busy} onClick={() => act('pause', '/api/agent-desk/pause')}><Pause className="w-3.5 h-3.5" /> Pause</button>)}
        {isAdmin && <button className="v3-btn primary" disabled={!!busy || !!d.stopReason || d.running} onClick={() => act('run', '/api/agent-desk/run')}><Play className="w-3.5 h-3.5" /> {d.running ? 'Running…' : 'Run now'}</button>}
      </div>}>
      <div className="v3-stats">
        <div><span>Paper equity</span><b className="v3-num">{money(perf.equity, '$', 0)}</b></div>
        <div><span>Since start</span><b className={`v3-num ${signCls(perf.totalReturnPct)}`}>{pct(perf.totalReturnPct, 2)}</b></div>
        <div><span>Open positions</span><b className="v3-num">{perf.openPositions ?? 0}</b></div>
        <div><span>Closed trades</span><b className="v3-num">{perf.closedTrades ?? 0}{perf.winRate != null ? ` · ${Math.round(perf.winRate * 100)}% won` : ''}</b></div>
        <div><span>Research default</span><b>{d.settings?.researchDefaultMethod === 'debate' ? 'Debate' : 'Single call'}</b></div>
      </div>
      {pts.length > 1
        ? <LineChart series={[{ values: pts, cls: 'v3-line-main', area: true }]} labels={[0, 0.5, 1].map(f => day(hist[Math.round(f * (hist.length - 1))]?.date))} label="Paper equity" fmtY={v => money(v, '$', 0)} />
        : <Empty text="The equity curve starts once the hourly manager has marked the book on two days." />}
      {d.stopReason && <p className="v3-note warn">The desk will not run: {d.stopReason}.</p>}
      <p className="v3-note">Paper results are a simulation, not money earned.</p>
    </Card>
  )
}

function SpendCard({ d }) {
  const b = d.budget ?? {}
  const used = b.capUsd ? (b.spentUsd / b.capUsd) * 100 : 0
  return (
    <Card className="v3-span-4" title="Spend cap" sub="Set by the operator. Agents stop on their own at the cap.">
      <div className="v3-cap"><Bar value={used} tone={b.exhausted ? 'down' : used > 75 ? 'warn' : 'up'} /><b className="v3-num">${(b.spentUsd ?? 0).toFixed(2)}</b></div>
      <p className="v3-note">of ${b.capUsd} for {b.month}, shared by the Agent Desk and the Strategy Brain.{b.exhausted ? ' Spent: model calls are skipped until next month.' : ''}</p>
      {d.ledger && (
        <div className="v3-callout"><b>Does it pay for itself?</b> {d.ledger.recommendation}</div>
      )}
    </Card>
  )
}

function LimitsCard({ d }) {
  const p = d.limits?.paper ?? {}
  const pr = d.limits?.protections ?? {}
  const ex = d.paper?.execution ?? {}
  const rows = [
    ['Max position', p.maxPositionPct != null ? `${p.maxPositionPct}% of book` : null],
    ['Max open positions', p.maxOpenPositions],
    ['Max new trades a day', p.maxTradesPerDay],
    ['Risk per trade', p.riskPerTradePct != null ? `${p.riskPerTradePct}% of equity` : null],
    ['Daily loss pause', pr.dailyLossPct != null ? `${pr.dailyLossPct}%` : null],
    ['Quote must be fresher than', ex.maxQuoteAgeMin != null ? `${ex.maxQuoteAgeMin} min` : null],
    ['Changes need approval', 'Yes'],
  ].filter(([, v]) => v != null)
  return (
    <Card className="v3-span-4" title="Limits" action={<Badge>READ ONLY</Badge>} sub="Set in the server's settings. The agents have no way to change them.">
      <ul className="v3-kv">{rows.map(([k, v]) => <li key={k}><span>{k}</span><b className="v3-num">{v}</b></li>)}</ul>
    </Card>
  )
}

function ProposalsCard({ d, isAdmin, act, busy }) {
  const pending = (d.proposals ?? []).filter(p => p.status === 'pending')
  const decided = (d.proposals ?? []).filter(p => p.status !== 'pending').slice(0, 5)
  return (
    <Card className="v3-span-8" title="Experiments waiting for you" sub="Proposed by the agents, tested on data they never saw">
      {pending.length === 0 ? <Empty text="Nothing waiting. Proposals appear after a cycle finds a change that held on held-out data." /> : (
        <ul className="v3-props">
          {pending.map(p => (
            <li key={p.id}>
              <div>
                <span className="v3-eyebrow">{TYPE[p.type] || p.type}</span>
                <b>{p.title}</b>
                <p>{p.detail}</p>
              </div>
              {isAdmin ? (
                <div className="v3-row-gap">
                  {p.type !== 'brain-finding' && <button className="v3-btn" disabled={!!busy} onClick={() => act(p.id, `/api/agent-desk/proposals/${p.id}/reject`)}><X className="w-3.5 h-3.5" /> Reject</button>}
                  <button className="v3-btn primary" disabled={!!busy} onClick={() => act(p.id, `/api/agent-desk/proposals/${p.id}/approve`)}><Check className="w-3.5 h-3.5" /> {p.type === 'brain-finding' ? 'Acknowledge' : 'Approve'}</button>
                </div>
              ) : <span className="v3-muted">An admin decides</span>}
            </li>
          ))}
        </ul>
      )}
      {decided.length > 0 && (
        <>
          <h4 className="v3-h4">Decided</h4>
          <ul className="v3-decided">
            {decided.map(p => <li key={p.id}><Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge><span>{p.title}</span><em className="v3-num">{day(p.decidedAt)}</em></li>)}
          </ul>
        </>
      )}
    </Card>
  )
}

function ImpactCard({ d }) {
  const im = d.impact
  const items = im ? [
    ...(im.strategies ?? []).map(x => ({ k: x.experimentId, title: `${x.symbol} ${x.version}`, detail: x.excessPct != null ? `${x.excessPct >= 0 ? '+' : ''}${x.excessPct}% vs the version it replaced` : (x.reason || ''), verdict: x.verdict })),
    ...(im.research ? [{ k: 'research', title: `Research default: ${im.research.method}`, detail: `Win rate ${im.research.before?.winRate != null ? Math.round(im.research.before.winRate * 100) : '—'}% before, ${im.research.after?.winRate != null ? Math.round(im.research.after.winRate * 100) : '—'}% after`, verdict: im.research.verdict }] : []),
    ...(im.brain ?? []).map((b, i) => ({ k: `b${i}`, title: b.title, detail: b.metric, verdict: b.verdict })),
  ] : []
  return (
    <Card className="v3-span-4" title="Impact" sub="Did approved changes help? Measured on data after each approval.">
      {items.length === 0 ? <Empty text={im ? 'Nothing approved yet to measure.' : 'Measured at the start of every cycle. No cycle has run yet.'} /> : (
        <ul className="v3-impact">
          {items.slice(0, 5).map(x => <li key={x.k}><div><b>{x.title}</b><span>{x.detail}</span></div><Badge tone={VERDICT_TONE[x.verdict] || 'neutral'}>{x.verdict}</Badge></li>)}
        </ul>
      )}
      {im?.measuredAt && <p className="v3-note">Measured {when(im.measuredAt)}.</p>}
    </Card>
  )
}

function AlertsCard({ d }) {
  const list = d.alerts ?? []
  return (
    <Card className="v3-span-8" title="Alerts" sub="Checked live from the paper book and the desk. Each one is emailed to the operator at most once a day.">
      {list.length === 0 ? <Empty text="No alerts." /> : (
        <ul className="v3-alerts">
          {list.map(a => <li key={a.key}><i className={a.severity === 'high' ? 'down' : 'warn'} /><div><b>{a.title}</b><span>{a.detail}</span></div></li>)}
        </ul>
      )}
    </Card>
  )
}

export default function AgentsView({ onSignIn }) {
  const { user, authFetch } = useAuth()
  const isAdmin = user?.role === 'admin'
  const st = useAuthedJson('/api/agent-desk/status')
  const [busy, setBusy] = useState(null)
  const [msg, setMsg] = useState(null)
  const d = st.data
  const act = async (key, url) => {
    setBusy(key); setMsg(null)
    try {
      const r = await authFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) setMsg(j.error || `HTTP ${r.status}`)
      await st.reload()
    } catch (e) { setMsg(e.message) } finally { setBusy(null) }
  }
  const pending = (d?.proposals ?? []).filter(p => p.status === 'pending').length
  useHero({
    eyebrow: 'Agents',
    headline: d ? `Your research team.${pending ? ` ${pending} change${pending > 1 ? 's' : ''} waiting for you.` : ' Each agent follows the Brain’s rules.'}` : 'Your research team. Each agent follows the Brain’s rules.',
  })
  return (
    <div className="v3-home">
      {!st.isAuthenticated ? <Card><Empty text="Sign in to see the Agent Desk." action={<button className="v3-btn primary" onClick={onSignIn}>Sign in</button>} /></Card> :
        !d ? <Card><Empty text={st.error || 'Loading the Agent Desk…'} /></Card> : (
          <>
            {msg && <p className="v3-note warn">{msg}</p>}
            <div className="v3-grid">
              <DeskCard d={d} isAdmin={isAdmin} act={act} busy={busy} />
              <SpendCard d={d} />
              <ProposalsCard d={d} isAdmin={isAdmin} act={act} busy={busy} />
              <LimitsCard d={d} />
              <ImpactCard d={d} />
              <AlertsCard d={d} />
            </div>
          </>
        )}
      <div className="v3-section-h"><h2>Cycle log, experiments and ledger</h2></div>
      <div className="v3-plain">
        <Suspense fallback={<Empty text="Loading the Agent Desk…" />}><AgentDeskView /></Suspense>
      </div>
    </div>
  )
}
