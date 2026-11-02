/**
 * Agent Desk — the supervised self-improvement loop (lib/agent-desk.js,
 * GET /api/agent-desk/status). It diagnoses and tests one fix at a time for
 * the trading strategies, turns measured AI Brain problems into findings and
 * compares the research methods — and only PROPOSES: every change waits here
 * for an admin. Also the paper book's equity curve, daily P&L and risk limits.
 */
import { useCallback, useEffect, useState } from 'react'
import { Play, Pause, RotateCcw, Check, X, ShieldCheck, Loader2, AlertTriangle, GitBranch } from 'lucide-react'
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, BarChart, Bar, Cell } from 'recharts'
import { useAuth } from '../../contexts/AuthContext'
import { Card, Note, Stat } from '../QuantLab/shared'

const usd = v => (v == null ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`)
const when = t => (t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')
const STATUS_TONE = { promoted: 'text-mint-400', approved: 'text-mint-400', reverted: 'text-slate-400', rejected: 'text-slate-500', pending: 'text-amber-300', 'no-diagnosis': 'text-slate-500', 'insufficient-data': 'text-slate-500' }

export default function AgentDeskView() {
  const { authFetch, isAuthenticated, user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [state, setState] = useState({ loading: true, error: null, data: null })
  const [busy, setBusy] = useState(null)
  const [actionError, setActionError] = useState(null)

  const load = useCallback(async () => {
    if (!isAuthenticated) { setState({ loading: false, error: null, data: null }); return }
    try {
      const r = await authFetch('/api/agent-desk/status')
      const d = await r.json()
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`)
      setState({ loading: false, error: null, data: d })
    } catch (e) { setState(s => ({ ...s, loading: false, error: e.message })) }
  }, [authFetch, isAuthenticated])
  useEffect(() => { load() }, [load])
  // Poll while a cycle runs.
  useEffect(() => {
    if (!state.data?.running && busy !== 'run') return undefined
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [state.data?.running, busy, load])

  const act = async (key, url, body = {}) => {
    setBusy(key); setActionError(null)
    try {
      const r = await authFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`)
    } catch (e) { setActionError(e.message) }
    if (key !== 'run') setBusy(null)
    else setTimeout(() => setBusy(null), 6000)
    load()
  }

  if (!isAuthenticated) return <div className="p-4"><Note>Sign in to see the Agent Desk.</Note></div>
  if (state.loading) return <div className="p-4"><Card><p className="text-xs text-slate-400">Loading the Agent Desk…</p></Card></div>
  if (state.error) return <div className="p-4"><Note tone="warn">Could not load the Agent Desk: {state.error}</Note></div>

  const d = state.data
  const pending = d.proposals.filter(p => p.status === 'pending')
  const decided = d.proposals.filter(p => p.status !== 'pending')
  const statusLabel = !d.enabled ? 'Off' : d.paused ? 'Paused' : d.running ? 'Running' : 'On'
  const statusTone = !d.enabled || d.paused ? 'text-amber-300 border-amber-500/30 bg-amber-500/10' : 'text-mint-400 border-mint-500/30 bg-mint-500/10'

  return (
    <div className="p-4 space-y-4 max-w-6xl">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold text-white">Agent Desk</h1>
        <span className={`text-xs px-2 py-0.5 rounded-full border ${statusTone}`}>{statusLabel}</span>
        {d.running && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
        <div className="flex-1" />
        {isAdmin && (
          <div className="flex gap-2">
            <button type="button" disabled={!!busy || !!d.stopReason || d.running} onClick={() => act('run', '/api/agent-desk/run')}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-slate-500/25 text-slate-200 hover:text-white disabled:opacity-40">
              <Play className="w-3.5 h-3.5" /> Run a cycle now
            </button>
            {d.paused
              ? <button type="button" disabled={!!busy} onClick={() => act('resume', '/api/agent-desk/resume')} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-slate-500/25 text-slate-200 hover:text-white disabled:opacity-40"><RotateCcw className="w-3.5 h-3.5" /> Resume</button>
              : <button type="button" disabled={!!busy} onClick={() => act('pause', '/api/agent-desk/pause', { reason: 'paused from the page' })} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-amber-500/30 text-amber-300 hover:text-amber-200 disabled:opacity-40"><Pause className="w-3.5 h-3.5" /> Pause (stops at the next step)</button>}
          </div>
        )}
      </div>

      <Card>
        <div className="flex items-start gap-2 text-xs text-slate-400">
          <ShieldCheck className="w-4 h-4 text-mint-400 shrink-0 mt-px" />
          <p>
            A supervised loop over the <b>trading strategies</b>, the <b>AI Brain</b> and the <b>research engine</b>: observe → diagnose → test one fix on data it has not seen → keep or revert.
            It only <b>proposes</b>: every change waits below for an admin. It places no orders, moves no money, cannot change its own limits, prompts or code, and has no goal of staying switched on —
            when it does not pay for itself it says so. {d.stopReason ? <span className="text-amber-300">Not running: {d.stopReason}.</span> : null}
          </p>
        </div>
        {actionError && <p className="text-xs text-red-400 mt-2">{actionError}</p>}
      </Card>

      {(d.alerts || []).length > 0 && (
        <Card title="Alerts">
          <ul className="space-y-1.5">
            {d.alerts.map(a => (
              <li key={a.key} className="flex items-start gap-2 text-xs">
                <AlertTriangle className={`w-3.5 h-3.5 shrink-0 mt-px ${a.severity === 'high' ? 'text-red-400' : a.severity === 'medium' ? 'text-amber-300' : 'text-slate-400'}`} />
                <span><b className="text-slate-200">{a.title}</b> <span className="text-slate-400">— {a.detail}</span></span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        <Card title="Ledger — what it costs vs what the paper book made (this month)">
          <div className="grid grid-cols-2 gap-2">
            <Stat label="AI spend (whole app)" value={usd(d.ledger.costs.aiUsd)} sub={`desk's own: ${usd(d.ledger.costs.agentUsd)}`} />
            <Stat label="Hosting" value={d.ledger.costs.infraEntered ? usd(d.ledger.costs.infraUsd) : 'not entered'} sub={d.ledger.costs.infraEntered ? 'AGENT_INFRA_USD_MONTH' : 'set AGENT_INFRA_USD_MONTH'} />
            <Stat label="Paper P&L" value={usd(d.ledger.value.atNotional)} sub={d.ledger.value.basis} />
            <Stat label="Verdict" value={{ 'too-early': 'Too early', 'covers-costs': 'Covers costs', 'does-not-cover': 'Does not cover' }[d.ledger.verdict]} sub={`${d.ledger.days} day(s) of results`} />
          </div>
          <p className="text-xs text-slate-400 mt-3">{d.ledger.recommendation}</p>
        </Card>
        <Card title="Spend cap">
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Cap" value={usd(d.budget.capUsd)} sub="AGENT_MONTHLY_BUDGET_USD" />
            <Stat label="Spent" value={usd(d.budget.spentUsd)} sub={d.budget.month} />
            <Stat label="Left" value={usd(d.budget.leftUsd)} sub={d.budget.exhausted ? 'model calls stopped' : 'model calls allowed'} />
          </div>
          <div className="h-2 rounded-full bg-slate-500/15 mt-3 overflow-hidden">
            <div className={`h-full ${d.budget.exhausted ? 'bg-amber-400' : 'bg-mint-400'}`} style={{ width: `${Math.min(100, d.budget.capUsd > 0 ? (d.budget.spentUsd / d.budget.capUsd) * 100 : 100)}%` }} />
          </div>
          <p className="text-[11px] text-slate-500 mt-2">Only the operator can raise the cap (an env var). At the cap the desk still runs its code-only checks; it just stops asking a model.</p>
        </Card>
      </div>

      <Card title={`Waiting for approval (${pending.length})`}>
        {!pending.length ? <p className="text-xs text-slate-500">Nothing waiting. Proposals appear here after a cycle finds something that passed its tests.</p> : (
          <ul className="space-y-3">
            {pending.map(p => (
              <li key={p.id} className="rounded-xl border border-slate-500/20 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">{{ 'strategy-version': 'Strategy', 'brain-finding': 'AI Brain', 'research-default-method': 'Research' }[p.type] || p.type}</span>
                  <span className="text-sm text-white font-medium">{p.title}</span>
                </div>
                <p className="text-xs text-slate-400 mt-1">{p.detail}</p>
                <p className="text-xs text-slate-300 mt-1"><b>If approved:</b> {p.effect}</p>
                {isAdmin && (
                  <div className="flex gap-2 mt-2">
                    <button type="button" disabled={!!busy} onClick={() => act(p.id, `/api/agent-desk/proposals/${p.id}/approve`)} className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-mint-500/30 text-mint-400 disabled:opacity-40"><Check className="w-3.5 h-3.5" /> {p.type === 'brain-finding' ? 'Acknowledge' : 'Approve'}</button>
                    <button type="button" disabled={!!busy} onClick={() => act(p.id, `/api/agent-desk/proposals/${p.id}/reject`)} className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-slate-500/25 text-slate-300 disabled:opacity-40"><X className="w-3.5 h-3.5" /> Reject</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {decided.length > 0 && (
          <details className="mt-3">
            <summary className="text-xs text-slate-400 cursor-pointer">Decided ({decided.length})</summary>
            <ul className="mt-2 space-y-1">
              {decided.map(p => <li key={p.id} className="text-xs text-slate-400"><span className={STATUS_TONE[p.status]}>{p.status}</span> · {p.title} · {p.decidedBy} · {when(p.decidedAt)}</li>)}
            </ul>
          </details>
        )}
      </Card>

      <ImpactCard impact={d.impact} />

      <Card title="Strategy experiments — one targeted fix, tested against its parent">
        <p className="text-[11px] text-slate-500 mb-2">Development 60% (diagnosis, thresholds) · validation 20% (choose) · final test 20% (one look). Kept only if it beats the parent on validation and the final test, net of costs, in both trend regimes, and still trades.</p>
        {!d.experiments.length ? <p className="text-xs text-slate-500">No experiments yet.</p> : (
          <div className="overflow-x-auto">
            <table className="text-[11px] w-full">
              <thead><tr className="text-slate-500 text-left">{['When', 'Strategy', 'Version', 'Change tried', 'Validation', 'Final test', 'Result'].map(h => <th key={h} className="font-medium pr-3 pb-1 whitespace-nowrap">{h}</th>)}</tr></thead>
              <tbody>
                {d.experiments.map(x => (
                  <tr key={x.id} className="border-t border-slate-500/10 align-top">
                    <td className="pr-3 py-1 text-slate-400 whitespace-nowrap">{when(x.at)}</td>
                    <td className="pr-3 py-1 text-slate-300">{x.name || x.symbol}</td>
                    <td className="pr-3 py-1 text-slate-300 whitespace-nowrap"><GitBranch className="inline w-3 h-3 mr-0.5" />{x.parentVersion}{x.version ? ` → ${x.version}` : ''}</td>
                    <td className="pr-3 py-1 text-slate-300">{x.change || '—'}</td>
                    <td className="pr-3 py-1 tabular-nums text-slate-300 whitespace-nowrap">{x.candidate ? `${x.candidate.val.totalReturn}% vs ${x.parent.val.totalReturn}%` : '—'}</td>
                    <td className="pr-3 py-1 tabular-nums text-slate-300 whitespace-nowrap">{x.candidate ? `${x.candidate.test.totalReturn}% vs ${x.parent.test.totalReturn}%` : '—'}</td>
                    <td className="pr-3 py-1"><span className={STATUS_TONE[x.status] || 'text-slate-300'}>{x.status}</span><div className="text-slate-500">{x.reason}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Last cycle">
        {!d.lastCycle ? <p className="text-xs text-slate-500">No cycle has run yet. The desk runs daily at 4:10 AM ET when switched on{isAdmin ? ', or run one now above' : ''}.</p> : (
          <>
            <p className="text-[11px] text-slate-500 mb-2">{when(d.lastCycle.at)} · {d.lastCycle.trigger}</p>
            <ul className="space-y-1">
              {d.lastCycle.steps.map((s, i) => <li key={i} className="text-xs text-slate-300"><b className="text-slate-200">{s.name}</b>{s.symbol ? ` ${s.symbol}` : ''}: {s.result}{s.detail ? <span className="text-slate-500"> — {s.detail}</span> : null}</li>)}
            </ul>
          </>
        )}
      </Card>

      <PaperBook paper={d.paper} />

      <Card title="Limits (set by the operator — read only)">
        <p className="text-[11px] text-slate-500 mb-2">{d.limits.note}</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat label="Agent Desk" value={d.limits.AGENT_DESK_ENABLED ? 'on' : 'off'} sub="AGENT_DESK_ENABLED" />
          <Stat label="Paper trading" value={d.limits.PAPER_TRADING_ENABLED ? 'on' : 'off'} sub="PAPER_TRADING_ENABLED" />
          <Stat label="Daily loss limit" value={`${d.limits.protections.dailyLossPct}%`} sub="pauses buys to next ET day" />
          <Stat label="Drawdown limit" value={`${d.limits.protections.maxDrawdownPct}%`} sub={`over ${d.limits.protections.drawdownLookbackDays} days`} />
          <Stat label="Risk per trade" value={`${d.limits.paper.riskPerTradePct}%`} sub="of equity at the stop" />
          <Stat label="Max position" value={`${d.limits.paper.maxPositionPct}%`} sub={`${d.limits.paper.maxOpenPositions} positions max`} />
          <Stat label="Slippage" value={`${d.paper.execution.slippageBpsStock} bps`} sub={`crypto ${d.paper.execution.slippageBpsCrypto} bps, per side`} />
          <Stat label="Quote age limit" value={`${d.paper.execution.maxQuoteAgeMin} min`} sub="stocks: market hours only" />
        </div>
      </Card>
    </div>
  )
}

const IMPACT_TONE = { helped: 'text-mint-400', improving: 'text-mint-400', resolved: 'text-mint-400', hurt: 'text-red-400', worse: 'text-red-400' }

/** Did what was approved help? Each approved change re-measured on data after its approval. */
function ImpactCard({ impact }) {
  const pctv = v => (v == null ? '—' : `${Math.round(v * 100)}%`)
  return (
    <Card title="Impact — did approved changes help?">
      <p className="text-[11px] text-slate-500 mb-2">
        Each change you approved is re-measured every cycle on data that arrived AFTER the approval — nothing it was chosen on. A strategy version is traded forward next to the version it replaced, on the same bars, net of costs.
        Research and Brain changes are judged on resolved outcomes. Until there is enough new data each says "too early" rather than a number.
      </p>
      {!impact ? <p className="text-xs text-slate-500">No measurement yet — it runs at the start of every cycle.</p> : (
        <div className="space-y-3">
          <p className="text-xs text-slate-300">
            {impact.summary.versionsMeasured
              ? <>{impact.summary.helped} of {impact.summary.versionsMeasured} approved strategy versions beat what they replaced (mean {impact.summary.meanExcessPct >= 0 ? '+' : ''}{impact.summary.meanExcessPct}% since approval){impact.summary.hurt ? `; ${impact.summary.hurt} did worse` : ''}.</>
              : 'No approved strategy version has enough trading since approval to judge yet.'}
            {impact.summary.tooEarly ? ` ${impact.summary.tooEarly} still too early.` : ''} <span className="text-slate-500">Measured {when(impact.measuredAt)}.</span>
          </p>
          {impact.strategies.length > 0 && (
            <div className="overflow-x-auto">
              <table className="text-[11px] w-full">
                <thead><tr className="text-slate-500 text-left">{['Strategy', 'Change', 'Since', 'New version', 'Replaced', 'Difference', 'Verdict'].map(h => <th key={h} className="font-medium pr-3 pb-1 whitespace-nowrap">{h}</th>)}</tr></thead>
                <tbody>{impact.strategies.map(x => (
                  <tr key={x.experimentId} className="border-t border-slate-500/10">
                    <td className="pr-3 py-1 text-slate-300 whitespace-nowrap">{x.symbol} {x.parentVersion ? `${x.parentVersion} → ` : ''}{x.version}</td>
                    <td className="pr-3 text-slate-400">{x.change || '—'}</td>
                    <td className="pr-3 text-slate-400 whitespace-nowrap">{x.since || '—'}</td>
                    <td className="pr-3 tabular-nums text-slate-300">{x.versionResult ? `${x.versionResult.totalReturn}% (${x.versionResult.trades} trades)` : '—'}</td>
                    <td className="pr-3 tabular-nums text-slate-300">{x.parent ? `${x.parent.totalReturn}% (${x.parent.trades} trades)` : '—'}</td>
                    <td className="pr-3 tabular-nums text-slate-300">{x.excessPct != null ? `${x.excessPct >= 0 ? '+' : ''}${x.excessPct}%` : '—'}</td>
                    <td className={`pr-3 ${IMPACT_TONE[x.verdict] || 'text-slate-400'}`}>{x.verdict}{x.reason ? <span className="text-slate-500"> — {x.reason}</span> : null}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {impact.research && (
            <p className="text-xs text-slate-300">Research default <b>{impact.research.method}</b> (approved {String(impact.research.approvedAt).slice(0, 10)}): win rate before {pctv(impact.research.before.winRate)} (n={impact.research.before.n}) vs after {pctv(impact.research.after.winRate)} (n={impact.research.after.n}) — <span className={IMPACT_TONE[impact.research.verdict] || 'text-slate-400'}>{impact.research.verdict}</span>.</p>
          )}
          {impact.brain.length > 0 && (
            <ul className="text-xs text-slate-300 space-y-0.5">
              {impact.brain.map((b, i) => <li key={i}>{b.title}: {b.metric} was {pctv(b.then)}, now {b.now == null ? 'below the threshold' : pctv(b.now)} — <span className={IMPACT_TONE[b.verdict] || 'text-slate-400'}>{b.verdict}</span></li>)}
            </ul>
          )}
        </div>
      )}
    </Card>
  )
}

function PaperBook({ paper }) {
  const perf = paper.performance
  const daily = (perf.daily || []).slice(-60)
  return (
    <Card title={`Paper book${paper.enabled ? '' : ' (paper trading is off)'}`}>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3">
        <Stat label="Equity" value={usd(perf.equity)} sub={`started ${usd(perf.startingCash)}`} />
        <Stat label="Return" value={perf.totalReturnPct == null ? '—' : `${perf.totalReturnPct}%`} />
        <Stat label="Today" value={daily.length ? usd(daily.at(-1).pnl) : '—'} sub={paper.dayMark ? `vs day open ${usd(paper.dayMark.equity)}` : 'no day mark yet'} />
        <Stat label="Win rate" value={perf.winRate == null ? '—' : `${Math.round(perf.winRate * 100)}%`} sub={`${perf.closedTrades} closed`} />
        <Stat label="Slippage paid" value={usd(perf.slippagePaid)} sub={`${perf.rejectedOrders} refused orders`} />
      </div>
      {paper.protections?.global && <Note tone="warn">Buys paused ({paper.protections.global.kind}): {paper.protections.global.reason}, until {String(paper.protections.global.until).slice(0, 16)}Z. Exits still run.</Note>}
      {paper.equityHistory.length < 2 ? <p className="text-xs text-slate-500 mt-2">The equity curve starts once the hourly manager has recorded two days.</p> : (
        <div className="grid md:grid-cols-2 gap-3 mt-2">
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={paper.equityHistory}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.15)" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={24} />
                <YAxis tick={{ fontSize: 10 }} domain={['auto', 'auto']} width={60} />
                <Tooltip formatter={v => usd(v)} />
                <Line type="monotone" dataKey="equity" stroke="#00ffcc" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={daily}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.15)" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={24} />
                <YAxis tick={{ fontSize: 10 }} width={50} />
                <Tooltip formatter={v => usd(v)} />
                <Bar dataKey="pnl">{daily.map((r, i) => <Cell key={i} fill={r.pnl >= 0 ? '#34d399' : '#f87171'} />)}</Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </Card>
  )
}
