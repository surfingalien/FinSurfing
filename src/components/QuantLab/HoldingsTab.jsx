/**
 * My holdings — the Quant Lab run across the active portfolio at once
 * (POST /api/quant/holdings-scan, lib/holdings-scan.js): portfolio risk
 * (volatility, each holding's share of the risk, VaR/ES, beta, stress tests,
 * correlation, effective bets, risk-parity comparison), each holding's quant
 * snapshot, the catalog strategies judged on two disjoint windows, and an
 * opt-in walk-forward ML check. Heartbeated: check data.error as well as res.ok.
 */
import { useState } from 'react'
import { Play, Loader2, Lock } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { Card, Note, Stat, fmt, pct } from './shared'
import DccView from './DccView'

const usd = v => (v == null || !Number.isFinite(v) ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`)
const p1 = v => pct(v, 1)
const deskLink = sym => `#/research-desk/${encodeURIComponent(sym)}`
const VERDICT_TONE = { validated: 'text-mint-400', mixed: 'text-amber-300', rejected: 'text-slate-500', insufficient_trades: 'text-slate-500', fragile: 'text-amber-300' }

export default function HoldingsTab({ positions = [] }) {
  const { authFetch, isAuthenticated } = useAuth()
  const [includeMl, setIncludeMl] = useState(false)
  const [state, setState] = useState({ loading: false, error: null, data: null })
  const scannable = (positions || []).filter(p => p?.symbol && Number(p.shares) > 0 && !['cash', 'option'].includes(String(p.assetClass || '').toLowerCase()))

  const run = async () => {
    setState({ loading: true, error: null, data: null })
    try {
      const r = await authFetch('/api/quant/holdings-scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ positions: scannable.map(p => ({ symbol: p.symbol, shares: Number(p.shares) })), includeMl }) })
      const d = await r.json()
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`)
      setState({ loading: false, error: null, data: d })
    } catch (e) { setState({ loading: false, error: e.message, data: null }) }
  }

  if (!isAuthenticated) return <Note><Lock className="inline w-3 h-3 mr-1" />Sign in to scan your holdings — it needs your portfolio and market data.</Note>
  if (!scannable.length) return <Note>Your active portfolio has no holdings to scan. Add positions on the Portfolio page (cash and option lines are skipped).</Note>

  const d = state.data
  return (
    <div className="space-y-4">
      <Card title={`Scan my holdings (${scannable.length} in the active portfolio)`}>
        <p className="text-xs text-slate-400 mb-3">
          Runs the Quant Lab across every holding at once: portfolio risk (how much each holding contributes to it, VaR, stress tests, what moves together), each holding's volatility and character,
          the next dated events for each holding, whether its reported earnings are backed by cash, and whether the catalog strategies held up on that holding in both an older and a recent window, net of costs. Shares come from your active portfolio; prices are the last daily close.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={run} disabled={state.loading} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-mint-400/15 border border-mint-400/30 text-mint-400 disabled:opacity-50">
            {state.loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} {state.loading ? 'Scanning…' : 'Scan holdings'}
          </button>
          <label className="flex items-center gap-1.5 text-xs text-slate-400">
            <input type="checkbox" checked={includeMl} onChange={e => setIncludeMl(e.target.checked)} /> Include ML models (8 models, walk-forward, slower)
          </label>
          {d?.cached && <span className="text-[11px] text-slate-500">from a scan in the last 30 minutes</span>}
        </div>
        {state.error && <p className="text-xs text-red-400 mt-2">{state.error}</p>}
      </Card>

      {d && <PortfolioRisk p={d.portfolio} />}
      {d && <Calendar c={d.calendar} />}
      {d && <Quality q={d.quality} holdings={d.holdings} />}
      {d && <HoldingsTable holdings={d.holdings} showMl={!!d.ml} />}
      {d && <Summary d={d} />}
      {d?.skipped?.length > 0 && <Note tone="warn">Not scanned (no price history): {d.skipped.join('; ')}</Note>}
      {d?.truncated > 0 && <Note tone="warn">{d.truncated} more holding(s) beyond the first 40 were not scanned.</Note>}
      {d && <Note>Measurements of the past, not forecasts or trade instructions. Risk parity is shown for comparison only.</Note>}
    </div>
  )
}

function PortfolioRisk({ p }) {
  if (!p || p.error) return <Note tone="warn">Portfolio risk: {p?.error || 'unavailable'}</Note>
  return (
    <>
    <Card title="Portfolio risk">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <Stat label="Value" value={usd(p.totalValue)} sub={`${p.weights.length} holdings`} />
        <Stat label="Volatility" value={p1(p.annualVol)} sub="annualised" />
        <Stat label="1-day VaR 95%" value={p1(p.var95)} sub={`${usd(p.var95Usd)} · ES ${p1(p.es95)}`} />
        <Stat label="Beta to SPY" value={p.beta == null ? '—' : fmt(p.beta, 2)} sub={`max drawdown ${p1(p.maxDrawdown)}`} />
        <Stat label="Independent bets" value={p.effectiveBets ?? '—'} sub={`of ${p.weights.length} holdings`} />
        <Stat label="One-factor share" value={p.pca ? p1(p.pca.firstComponentShare) : '—'} sub="variance in the first component" />
        {(p.worstWindows || []).slice(0, 2).map(w => <Stat key={w.days} label={`Worst ${w.days}-day`} value={p1(w.worstReturn)} sub={`${usd(w.dollarLoss)} at today's weights`} />)}
      </div>
      {p.concentration?.length > 0 && <Note tone="warn">Risk is concentrated in {p.concentration.join(', ')} — their share of the risk is well above their share of the money.</Note>}
      {p.movesTogether?.length > 0 && <p className="text-xs text-slate-400 mt-2">Move together (correlation ≥ 0.8, close to one position): {p.movesTogether.map(x => `${x.a}–${x.b} ${x.rho}`).join(', ')}</p>}
      <div className="grid md:grid-cols-2 gap-3 mt-3">
        <div className="overflow-x-auto">
          <div className="text-xs font-semibold text-slate-300 mb-1">Share of money vs share of risk</div>
          <table className="text-[11px] w-full">
            <thead><tr className="text-slate-500 text-left"><th className="font-medium pr-3">Holding</th><th className="font-medium pr-3">Weight</th><th className="font-medium pr-3">Risk share</th><th className="font-medium">Risk parity</th></tr></thead>
            <tbody>{(p.riskContributions || []).map(r => {
              const rp = p.riskParity?.find(x => x.symbol === r.symbol)
              return (
                <tr key={r.symbol} className="border-t border-slate-500/10">
                  <td className="pr-3 py-1"><a href={deskLink(r.symbol)} className="font-mono text-mint-400 hover:underline">{r.symbol}</a></td>
                  <td className="pr-3 tabular-nums text-slate-300">{p1(r.weight)}</td>
                  <td className={`pr-3 tabular-nums ${r.riskShare > r.weight * 1.5 ? 'text-amber-300' : 'text-slate-300'}`}>{p1(r.riskShare)}</td>
                  <td className="tabular-nums text-slate-400">{rp ? p1(rp.riskParity) : '—'}</td>
                </tr>
              )
            })}</tbody>
          </table>
        </div>
        <div className="overflow-x-auto">
          <div className="text-xs font-semibold text-slate-300 mb-1">Stress scenarios (each holding's own beta)</div>
          <table className="text-[11px] w-full">
            <tbody>{(p.stress || []).map(s => (
              <tr key={s.id} className="border-t border-slate-500/10">
                <td className="pr-3 py-1 text-slate-300">{s.name}</td>
                <td className={`pr-3 tabular-nums ${s.pnl < 0 ? 'text-red-400' : 'text-mint-400'}`}>{usd(s.pnl)}</td>
                <td className="tabular-nums text-slate-400">{p1(s.pnlPct)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
      {p.excluded?.length > 0 && <p className="text-[11px] text-slate-500 mt-2">Left out of portfolio risk (under 120 days of history): {p.excluded.join(', ')}</p>}
      {p.observations && <p className="text-[11px] text-slate-500 mt-1">{p.observations} common trading days; covariance shrunk (Ledoit–Wolf).</p>}
    </Card>
    {p.dcc ? <DccView d={p.dcc} usdValues={p.dcc.portfolioUsd} /> : p.dccError ? <Note>Time-varying correlations (DCC-GARCH): {p.dccError}.</Note> : null}
    </>
  )
}

function HoldingsTable({ holdings, showMl }) {
  return (
    <Card title="Each holding">
      <div className="overflow-x-auto">
        <table className="text-[11px] w-full">
          <thead><tr className="text-slate-500 text-left">{['Holding', 'Vol (21d fcst)', 'Character', 'VaR 95%', 'Beta', 'State', 'vs holdings', 'Strategies (older / recent window)', ...(showMl ? ['ML (walk-forward)'] : [])].map(h => <th key={h} className="font-medium pr-3 pb-1 whitespace-nowrap">{h}</th>)}</tr></thead>
          <tbody>{holdings.map(h => {
            const q = h.quant || {}
            return (
              <tr key={h.symbol} className="border-t border-slate-500/10 align-top">
                <td className="pr-3 py-1.5"><a href={deskLink(h.symbol)} className="font-mono font-semibold text-mint-400 hover:underline">{h.symbol}</a>{h.error && <div className="text-red-400">{h.error}</div>}</td>
                <td className="pr-3 tabular-nums text-slate-300">{q.insufficient ? 'short history' : p1(q.vol?.forecast21)}</td>
                <td className="pr-3 text-slate-300">{q.character?.label || '—'}</td>
                <td className="pr-3 tabular-nums text-slate-300">{q.tail ? p1(q.tail.var95) : '—'}</td>
                <td className="pr-3 tabular-nums text-slate-300">{q.beta ? fmt(q.beta.beta, 2) : '—'}</td>
                <td className="pr-3 text-slate-300">{q.state ? `${q.state.label} (${p1(q.state.probStressed)} stressed)` : '—'}</td>
                <td className="pr-3 tabular-nums text-slate-300">{h.vsHoldings ? `${fmt(h.vsHoldings.residualZ, 1)}σ` : '—'}</td>
                <td className="pr-3">
                  {(h.strategies?.rows || []).map(r => (
                    <div key={r.strategy} className="whitespace-nowrap"><span className="text-slate-400">{r.strategy}</span> <span className={VERDICT_TONE[r.verdict] || 'text-slate-400'}>{r.verdict}</span>{r.older && r.recent ? <span className="text-slate-500"> · α {fmt(r.older.alpha, 1)}% / {fmt(r.recent.alpha, 1)}%</span> : null}</div>
                  ))}
                  {!h.strategies?.rows?.length && <span className="text-slate-500">{h.strategies?.summary}</span>}
                  {h.strategies?.library?.length > 0 && <div className="text-mint-400">library: {h.strategies.library.map(l => `${l.name} ${l.version}`).join(', ')}</div>}
                </td>
                {showMl && <td className="pr-3">
                  {h.ml?.error ? <span className="text-slate-500">{h.ml.error}</span> : h.ml ? (h.ml.passed.length ? <span className="text-amber-300">{h.ml.passed.join(', ')} beat the baseline in every fold</span> : <span className="text-slate-400">no model beat the baseline in every fold</span>) : '—'}
                  {h.ml?.asStrategy && <div className="whitespace-nowrap"><span className="text-slate-500">as a rule ({h.ml.asStrategy.model}):</span> <span className={VERDICT_TONE[h.ml.asStrategy.verdict] || 'text-slate-400'}>{h.ml.asStrategy.verdict}</span>{h.ml.asStrategy.older && h.ml.asStrategy.recent ? <span className="text-slate-500"> · α {fmt(h.ml.asStrategy.older.alpha, 1)}% / {fmt(h.ml.asStrategy.recent.alpha, 1)}%</span> : null}</div>}
                </td>}
              </tr>
            )
          })}</tbody>
        </table>
      </div>
      <p className="text-[11px] text-slate-500 mt-2">Strategy verdicts use the library's bar: "validated" only if the rule beat buy &amp; hold after costs in BOTH the older 70% and the newest 30% of five years. α = alpha vs buy &amp; hold in each window.</p>
    </Card>
  )
}

const KIND_LABEL = { earnings: 'Earnings', 'ex-dividend': 'Ex-dividend', lockup: 'Lock-up', 'options-expiry': 'Options expiry', 'index-rebalance': 'Index rebalance' }

/** Every holding's dated events in the next few weeks (lib/catalysts.js). */
function Calendar({ c }) {
  if (!c) return null
  return (
    <Card title={`Next ${c.days} days`}>
      {!c.events.length ? <p className="text-xs text-slate-500">No dated events found for {c.checked} holding(s) in the next {c.days} days.</p> : (
        <div className="overflow-x-auto">
          <table className="text-[11px] w-full">
            <thead><tr className="text-slate-500 text-left">{['Date', 'In', 'Holding', 'Event', ''].map(h => <th key={h} className="font-medium pr-3 pb-1">{h}</th>)}</tr></thead>
            <tbody>{c.events.map((e, i) => (
              <tr key={`${e.date}-${e.kind}-${e.symbol || 'mkt'}-${i}`} className="border-t border-slate-500/10">
                <td className="pr-3 py-1 tabular-nums text-slate-300 whitespace-nowrap">{e.date}</td>
                <td className="pr-3 tabular-nums text-slate-400">{e.daysAway}d</td>
                <td className="pr-3">{e.symbol ? <a className="font-mono text-mint-400 hover:underline" href={deskLink(e.symbol)}>{e.symbol}</a> : <span className="text-slate-500">market</span>}</td>
                <td className="pr-3 text-slate-300">{e.label}</td>
                <td className="text-slate-500">{e.scheduled ? '' : 'estimate'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-slate-500 mt-2">Earnings dates come from the earnings calendar, else are estimated from the last SEC filing; ex-dividend dates from FMP (or estimated from the payment cycle); lock-ups are IPO + 180 days. Options expiry and the S&P rebalance follow the exchange's calendar rules, without holiday adjustment.</p>
    </Card>
  )
}

/** Holdings whose reported earnings are not well backed by cash (lib/earnings-quality.js). */
function Quality({ q, holdings }) {
  if (!q) return null
  const rows = holdings.filter(h => h.quality?.checked)
  return (
    <Card title="Earnings quality (SEC filings)">
      <p className="text-[11px] text-slate-500 mb-2">Is reported profit backed by cash? Operating cash flow ÷ net income (cash conversion), accruals as a share of assets, and whether receivables or inventory are growing faster than sales. Flags are things to read, not verdicts — the weekly factor mining tests whether they predict returns.</p>
      <div className="overflow-x-auto">
        <table className="text-[11px] w-full">
          <thead><tr className="text-slate-500 text-left">{['Holding', 'Quarters to', 'Cash conversion', 'Accruals', 'Receivables vs sales', 'Flags'].map(h => <th key={h} className="font-medium pr-3 pb-1 whitespace-nowrap">{h}</th>)}</tr></thead>
          <tbody>{rows.map(h => (
            <tr key={h.symbol} className="border-t border-slate-500/10 align-top">
              <td className="pr-3 py-1"><a className="font-mono text-mint-400 hover:underline" href={deskLink(h.symbol)}>{h.symbol}</a></td>
              <td className="pr-3 tabular-nums text-slate-400">{h.quality.periodEnd}</td>
              <td className="pr-3 tabular-nums text-slate-300">{h.quality.cashConversion != null ? `${h.quality.cashConversion}×` : '—'}</td>
              <td className="pr-3 tabular-nums text-slate-300">{h.quality.accruals != null ? `${h.quality.accruals}%` : '—'}</td>
              <td className="pr-3 tabular-nums text-slate-300">{h.quality.receivablesGap != null ? `${h.quality.receivablesGap > 0 ? '+' : ''}${h.quality.receivablesGap} pts` : '—'}</td>
              <td className={h.quality.flags.length ? 'text-amber-300' : 'text-slate-500'}>{h.quality.flags.length ? h.quality.flags.map(f => f.text).join('; ') : 'none'}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </Card>
  )
}

function Summary({ d }) {
  return (
    <Card title="What the scan found">
      <ul className="text-xs text-slate-300 space-y-1 list-disc pl-4">
        <li>Strategies: {d.strategies.withValidatedRule.length ? d.strategies.withValidatedRule.map(x => `${x.symbol} (${x.rules.join(', ')})`).join('; ') : 'no catalog rule held up in both windows on any holding'} — {d.strategies.tested} holding(s) tested.</li>
        {d.ml && <li>ML: {d.ml.passed.length} holding(s) where a model beat the baseline in all {d.ml.folds} folds{d.ml.passed.length ? ` (${d.ml.passed.map(x => x.symbol).join(', ')})` : ''}; about {d.ml.expectedByLuck} would pass by luck alone with {d.ml.holdingsTested} holdings × {d.ml.modelsPerHolding} models.</li>}
        {d.ml && <li>ML as a trading rule (the best model per holding, next-day fills, costs, both windows): {d.ml.asStrategyValidated?.length ? d.ml.asStrategyValidated.map(x => `${x.symbol} (${x.model})`).join(', ') : 'none held up'}. The Strategy Brain tests these properly across many symbols every night.</li>}
        {d.quality && <li>Earnings quality: {d.quality.flagged.length ? `${d.quality.flagged.map(x => x.symbol).join(', ')} raised flags` : 'no flags'} across {d.quality.checked} holding(s) with SEC filings.</li>}
        {d.calendar?.events?.some(e => e.kind === 'earnings') && <li>Earnings in the next {d.calendar.days} days: {d.calendar.events.filter(e => e.kind === 'earnings').map(e => `${e.symbol} ${e.date}`).join(', ')}.</li>}
        {d.portfolio?.effectiveBets != null && <li>Diversification: about {d.portfolio.effectiveBets} independent bet(s) across {d.portfolio.weights.length} holdings.</li>}
      </ul>
    </Card>
  )
}
