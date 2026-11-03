/**
 * v3 Portfolio — the Dev preview's Portfolio page on the user's real book.
 *
 * Totals and the holdings table come from the active portfolio (the same
 * shared P&L code as v1). Weights are market value over the priced total.
 * Sectors come from each holding's stored sector, else the local symbol index;
 * a holding neither knows is shown as "Unclassified", never guessed. The risk
 * profile and per-holding betas come from /api/analytics/portfolio (a year of
 * daily returns, SPY as benchmark), and the stress test is the Quant Lab's
 * beta-scaled scenario engine (POST /api/quant/risk/stress). The heatmap,
 * signals and news are the dashboard widgets. v1's full Portfolio page
 * (add, edit, import, delete) follows underneath.
 */

import { useState, useEffect, useMemo, lazy, Suspense } from 'react'
import { Upload, Scale } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { getApiKeyHeaders } from '../../services/api'
import { scanPortfolio } from '../../services/aiEngine'
import { useHero } from '../hero'
import { Card, Badge, Empty, money, pct, signCls } from '../ui'
import PortfolioHeatmap from '../../components/Dashboard/widgets/PortfolioHeatmap'
import MarketMovers from '../../components/Dashboard/widgets/MarketMovers'
import MarketNewsFeed from '../../components/Dashboard/widgets/MarketNewsFeed'

const PortfolioView = lazy(() => import('../../components/Portfolio/PortfolioView'))

const COLORS = ['var(--accent)', '#8b7cf6', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#84cc16', '#64748b', '#a855f7', '#14b8a6']
const SIGNAL_TONE = { PROFIT_BOOK: 'warn', STOP_TRIGGER: 'down', WATCHLIST: 'neutral', HOLD: 'neutral' }
const SIGNAL_LABEL = { PROFIT_BOOK: 'BOOK GAIN', STOP_TRIGGER: 'REVIEW', WATCHLIST: 'LOOK', HOLD: 'HOLD' }
const isCash = s => /^(CASH|\$)/i.test(s) || /\s/.test(s)

function useSectors(positions) {
  const [map, setMap] = useState({})
  const key = positions.map(p => p.symbol).sort().join(',')
  useEffect(() => {
    let live = true
    const need = positions.filter(p => !p.sector && !isCash(p.symbol)).map(p => p.symbol)
    Promise.all(need.map(s => fetch(`/api/symbols/classify/${encodeURIComponent(s)}`).then(r => r.ok ? r.json() : null).catch(() => null)))
      .then(rs => { if (live) setMap(Object.fromEntries(need.map((s, i) => [s, rs[i]?.sector || null]))) })
    return () => { live = false }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return (p) => isCash(p.symbol) ? 'Cash' : (p.sector || map[p.symbol] || 'Unclassified')
}

function useAnalytics(symbols) {
  const { isAuthenticated, authFetch } = useAuth()
  const [state, setState] = useState({ data: null, error: null })
  const key = symbols.join(',')
  useEffect(() => {
    if (!symbols.length) { setState({ data: null, error: null }); return }
    let live = true
    const url = `/api/analytics/portfolio?symbols=${encodeURIComponent(key)}`
    const f = isAuthenticated ? authFetch(url) : fetch(url, { headers: getApiKeyHeaders() })
    f.then(r => r.json()).then(j => { if (live) setState({ data: j, error: j?.error ?? null }) }).catch(e => { if (live) setState({ data: null, error: e.message }) })
    return () => { live = false }
  }, [key, isAuthenticated]) // eslint-disable-line react-hooks/exhaustive-deps
  return state
}

function Kpis({ s, positions, spyBench, port }) {
  const priced = positions.filter(p => p.mktValue != null)
  const none = !s || priced.length === 0
  return (
    <div className="v3-kpis">
      <div className="v3-kpi"><span>Total value</span><b className="v3-num">{none ? '—' : money(s.totalValue, '$', 0)}</b><em>{priced.length} of {positions.length} priced</em></div>
      <div className="v3-kpi"><span>Today</span><b className={`v3-num ${signCls(s?.todayTotal)}`}>{none ? '—' : money(s.todayTotal, '$', 0, true)}</b><em className="v3-num">{none || !s.totalValue ? '' : pct((s.todayTotal / (s.totalValue - s.todayTotal)) * 100, 2)}</em></div>
      <div className="v3-kpi"><span>Unrealized gain</span><b className={`v3-num ${signCls(s?.totalGL)}`}>{none ? '—' : money(s.totalGL, '$', 0, true)}</b><em className="v3-num">{none ? '' : pct(s.totalGLPct)}</em></div>
      <div className="v3-kpi"><span>1Y vs S&P 500</span>
        <b className={`v3-num ${signCls(port != null && spyBench != null ? port - spyBench : null)}`}>{port != null && spyBench != null ? `${port - spyBench >= 0 ? '+' : ''}${(port - spyBench).toFixed(1)} pts` : '—'}</b>
        <em className="v3-num">{port != null && spyBench != null ? `${pct(port)} vs ${pct(spyBench)}, equal-weighted` : 'Needs a year of prices'}</em></div>
    </div>
  )
}

function Donut({ slices }) {
  const total = slices.reduce((t, x) => t + x.value, 0) || 1
  let acc = 0
  const r = 42, c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 120 120" className="v3-donut" aria-hidden="true">
      {slices.map((x, i) => {
        const len = (x.value / total) * c
        const el = <circle key={x.name} cx="60" cy="60" r={r} fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth="14" strokeDasharray={`${Math.max(0, len - 1.5)} ${c}`} strokeDashoffset={-acc} transform="rotate(-90 60 60)" />
        acc += len
        return el
      })}
      <text x="60" y="58" textAnchor="middle" className="v3-donut-n">{slices.length}</text>
      <text x="60" y="74" textAnchor="middle" className="v3-donut-l">sectors</text>
    </svg>
  )
}

function AllocationCard({ positions, sectorOf, total }) {
  const slices = useMemo(() => {
    const m = {}
    for (const p of positions) if (p.mktValue > 0) { const k = sectorOf(p); m[k] = (m[k] || 0) + p.mktValue }
    return Object.entries(m).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value)
  }, [positions, sectorOf])
  const top = slices[0]
  const topPct = top && total ? (top.value / total) * 100 : null
  return (
    <Card className="v3-span-5" title="Allocation" sub="By sector, market value">
      {!slices.length ? <Empty text="No priced holdings." /> : (
        <>
          <div className="v3-alloc">
            <Donut slices={slices} />
            <ul className="v3-legend-list">
              {slices.slice(0, 8).map((x, i) => <li key={x.name}><i style={{ background: COLORS[i % COLORS.length] }} /><span>{x.name}</span><b className="v3-num">{((x.value / total) * 100).toFixed(1)}%</b></li>)}
            </ul>
          </div>
          {topPct > 35 && top.name !== 'Unclassified' && top.name !== 'Cash' && <p className="v3-note warn">{top.name} is {topPct.toFixed(0)}% of the book.</p>}
        </>
      )}
    </Card>
  )
}

function HoldingsCard({ positions, total, betas, signals, onAnalyze }) {
  const rows = [...positions].sort((a, b) => (b.mktValue ?? -1) - (a.mktValue ?? -1))
  return (
    <Card className="v3-span-12" title="Holdings" sub="Signals are the Advisory Engine's portfolio rules: a reason to look, not an order">
      {rows.length === 0 ? <Empty text="No holdings yet. Add them in the full portfolio below." /> : (
        <div className="v3-scroll-x">
          <table className="v3-table">
            <thead><tr><th>Holding</th><th className="r">Shares</th><th className="r">Avg cost</th><th className="r">Price</th><th className="r">Value</th><th className="r">Weight</th><th className="r">Gain</th><th className="r">Beta</th><th>Signal</th></tr></thead>
            <tbody>
              {rows.map(p => {
                const sig = signals?.[p.symbol]
                return (
                  <tr key={p.id ?? p.symbol} onClick={() => !isCash(p.symbol) && onAnalyze(p.symbol)}>
                    <td><b className="v3-num">{p.symbol}</b>{p.name && p.name !== p.symbol && <span>{p.name}</span>}</td>
                    <td className="r v3-num">{p.shares}</td>
                    <td className="r v3-num">{p.avgCost ? money(p.avgCost) : '—'}</td>
                    <td className="r v3-num">{p.price != null ? money(p.price) : '—'}</td>
                    <td className="r v3-num">{p.mktValue != null ? money(p.mktValue, '$', 0) : '—'}</td>
                    <td className="r v3-num">{p.mktValue != null && total ? `${((p.mktValue / total) * 100).toFixed(1)}%` : '—'}</td>
                    <td className={`r v3-num ${signCls(p.gainLossPct)}`}>{p.gainLossPct != null && p.avgCost ? pct(p.gainLossPct, 0) : '—'}</td>
                    <td className="r v3-num">{betas?.[p.symbol] != null ? betas[p.symbol].toFixed(2) : '—'}</td>
                    <td>{sig ? <span title={sig.reason}><Badge tone={SIGNAL_TONE[sig.signal] || 'neutral'}>{SIGNAL_LABEL[sig.signal] || sig.signal}</Badge></span> : <span>—</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

const SCEN_SHORT = { 'mkt-10': 'Market −10%', 'mkt-20': 'Bear −20%', 'gfc-2008': '2008-style', 'covid-2020': 'March 2020', 'black-monday': 'Black Monday', 'rally-10': 'Rally +10%' }

function StressCard({ positions, betas }) {
  const held = positions.filter(p => p.mktValue > 0 && !isCash(p.symbol))
  const key = held.map(p => `${p.symbol}:${Math.round(p.mktValue)}:${betas?.[p.symbol] ?? ''}`).join(',')
  const [res, setRes] = useState({ data: null, error: null })
  const [sel, setSel] = useState('mkt-20')
  useEffect(() => {
    if (!held.length) return
    let live = true
    fetch('/api/quant/risk/stress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ positions: held.slice(0, 100).map(p => ({ symbol: p.symbol, value: +p.mktValue.toFixed(2), beta: betas?.[p.symbol] ?? undefined })) }) })
      .then(r => r.json()).then(j => { if (live) setRes({ data: j.error ? null : j, error: j.error ?? null }) }).catch(e => { if (live) setRes({ data: null, error: e.message }) })
    return () => { live = false }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const sc = res.data?.scenarios?.find(s => s.id === sel)
  // Per-holding moves use the same rule as the engine: beta × market move (beta 1 when unknown).
  const per = sc ? held.map(p => ({ symbol: p.symbol, pct: (betas?.[p.symbol] ?? 1) * sc.marketShock * 100 })).sort((a, b) => a.pct - b.pct) : []
  const max = Math.max(1, ...per.map(x => Math.abs(x.pct)))
  return (
    <Card className="v3-span-7" title="Stress test" sub="Each holding moves by its beta times the market move. A model, not a forecast.">
      {!held.length ? <Empty text="No priced holdings." /> : !res.data ? <Empty text={res.error || 'Running scenarios…'} /> : (
        <>
          <div className="v3-pills v3-pills-wrap">{res.data.scenarios.map(s => <button key={s.id} className={sel === s.id ? 'on' : ''} onClick={() => setSel(s.id)}>{SCEN_SHORT[s.id] || s.name}</button>)}</div>
          {sc && (
            <>
              <div className="v3-stats">
                <div><span>Portfolio impact</span><b className={`v3-num ${signCls(sc.pnlPct)}`}>{pct(sc.pnlPct * 100)}</b></div>
                <div><span>In dollars</span><b className={`v3-num ${signCls(sc.pnl)}`}>{money(sc.pnl, '$', 0, true)}</b></div>
                <div><span>Market move</span><b className="v3-num">{pct(sc.marketShock * 100, 0)}</b></div>
              </div>
              <ul className="v3-hbars">
                {per.slice(0, 10).map(x => (
                  <li key={x.symbol}><span className="v3-num">{x.symbol}</span>
                    <div className="v3-hbar"><i className={x.pct < 0 ? 'down' : 'up'} style={{ width: `${(Math.abs(x.pct) / max) * 50}%`, [x.pct < 0 ? 'right' : 'left']: '50%' }} /></div>
                    <b className={`v3-num ${signCls(x.pct)}`}>{pct(x.pct, 0)}</b></li>
                ))}
              </ul>
              {res.data.assumedBeta1?.length > 0 && <p className="v3-note">Beta 1 assumed for {res.data.assumedBeta1.join(', ')} (no year of prices).</p>}
            </>
          )}
        </>
      )}
    </Card>
  )
}

function RiskCard({ an, positions, total }) {
  const d = an.data
  const p = d?.riskMetrics?.portfolio, b = d?.riskMetrics?.benchmark
  const largest = [...positions].sort((a, c) => (c.mktValue ?? 0) - (a.mktValue ?? 0))[0]
  const fmt = (v, suf = '') => v == null ? '—' : `${v}${suf}`
  const rows = [
    ['Beta', d?.portfolioBeta != null ? d.portfolioBeta.toFixed(2) : '—', '1.00'],
    ['Sharpe ratio, 1Y', fmt(p?.sharpe), fmt(b?.sharpe)],
    ['Max drawdown, 1Y', fmt(p?.maxDrawdown != null ? -Math.abs(p.maxDrawdown) : null, '%'), fmt(b?.maxDrawdown != null ? -Math.abs(b.maxDrawdown) : null, '%')],
    ['Volatility, annualized', fmt(p?.volatility, '%'), fmt(b?.volatility, '%')],
    ['1-day value at risk (95%)', p?.var95 != null && total ? money(Math.abs(p.var95) / 100 * total, '$', 0) : '—', fmt(b?.var95 != null ? Math.abs(b.var95) : null, '%')],
    ['Largest position', largest?.mktValue && total ? `${largest.symbol} ${((largest.mktValue / total) * 100).toFixed(1)}%` : '—', '—'],
  ]
  return (
    <Card className="v3-span-5" title="Risk profile" action={<span className="v3-muted">you / S&P 500</span>}
      sub={p ? `A year of daily returns, ${p.weighting === 'value' ? 'value' : 'equally'} weighted` : 'A year of daily returns against SPY'}>
      {!d ? <Empty text={an.error || 'Measuring a year of returns…'} /> : !p ? <Empty text="Not enough price history to measure." /> : (
        <>
          <ul className="v3-kv">{rows.map(([k, a, c]) => <li key={k}><span>{k}</span><b className="v3-num">{a} <em>/ {c}</em></b></li>)}</ul>
          {d.portfolioBeta != null && <p className="v3-note">Your holdings move about {Math.abs(Math.round((d.portfolioBeta - 1) * 100))}% {d.portfolioBeta >= 1 ? 'more' : 'less'} than the market.{d.symbols?.length < positions.filter(x => !isCash(x.symbol)).length ? ` Measured on your ${d.symbols.length} holdings with the most value.` : ''}</p>}
        </>
      )}
    </Card>
  )
}

export default function PortfolioV3View({ portfolio, portfolioId, authFetch, portfolioName, onNavigate, onAnalyze }) {
  const positions = portfolio?.positions ?? []
  const s = portfolio?.summary
  const total = positions.reduce((t, p) => t + (p.mktValue > 0 ? p.mktValue : 0), 0)
  const sectorOf = useSectors(positions)
  const topSyms = [...positions].filter(p => !isCash(p.symbol)).sort((a, b) => (b.mktValue ?? 0) - (a.mktValue ?? 0)).slice(0, 20).map(p => p.symbol)
  // Betas and the risk profile for the 20 largest holdings (equal-weighted
  // when symbols are passed; the card says so).
  const an = useAnalytics(topSyms)
  const betas = an.data?.betas
  const [signals, setSignals] = useState(null)
  const sigKey = positions.map(p => `${p.symbol}:${p.price}`).join(',')
  useEffect(() => {
    if (!positions.length) return
    let live = true
    scanPortfolio({ positions, quotes: portfolio?.quotes ?? {} }).then(rs => { if (live) setSignals(Object.fromEntries((rs || []).map(r => [r.symbol, r]))) }).catch(() => {})
    return () => { live = false }
  }, [sigKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const sectorTop = useMemo(() => {
    const m = {}
    for (const p of positions) if (p.mktValue > 0) { const k = sectorOf(p); m[k] = (m[k] || 0) + p.mktValue }
    const e = Object.entries(m).filter(([k]) => k !== 'Unclassified' && k !== 'Cash').sort((a, b) => b[1] - a[1])[0]
    return e && total ? { name: e[0], pct: (e[1] / total) * 100 } : null
  }, [positions, sectorOf, total])

  const pr = an.data?.riskMetrics
  const port1y = pr?.portfolio?.annualReturn ?? null
  const spy1y = pr?.benchmark?.annualReturn ?? null
  const priced = positions.some(p => p.mktValue != null)
  useHero({
    eyebrow: `Portfolio${portfolioName ? ` · ${portfolioName}` : ''}`,
    headline: !positions.length ? 'Add your holdings to see how the book is built.'
      : !priced ? `${positions.length} holdings. Prices are loading.`
        : `${s?.totalGLPct >= 0 ? 'Up' : 'Down'} ${Math.abs(s?.totalGLPct ?? 0).toFixed(1)}% on cost${sectorTop && sectorTop.pct >= 30 ? `, and ${sectorTop.pct.toFixed(0)}% rides on ${sectorTop.name.toLowerCase()}.` : '.'}`,
    actions: (
      <>
        <button className="v3-btn" onClick={() => document.getElementById('v3-full-portfolio')?.scrollIntoView({ behavior: 'smooth' })}><Upload className="w-4 h-4" /> Import holdings</button>
        <button className="v3-btn primary" onClick={() => onNavigate('rebalancer')}><Scale className="w-4 h-4" /> Suggest rebalance</button>
      </>
    ),
  })

  return (
    <div className="v3-home">
      {positions.length > 0 && <Kpis s={s} positions={positions} port={port1y} spyBench={spy1y} />}
      {positions.length > 0 && (
        <div className="v3-grid">
          <Card className="v3-span-7" title="Holdings heatmap" sub="Size is position weight, colour is today's move. Click a tile to analyze.">
            <PortfolioHeatmap positions={positions} quotes={portfolio?.quotes ?? {}} onAnalyze={onAnalyze} />
          </Card>
          <Card className="v3-span-5" title="Market movers" sub="Top gainers and losers among your holdings">
            <MarketMovers positions={positions} quotes={portfolio?.quotes ?? {}} />
          </Card>
          <HoldingsCard positions={positions} total={total} betas={betas} signals={signals} onAnalyze={onAnalyze} />
          <StressCard positions={positions} betas={betas} />
          <RiskCard an={an} positions={positions} total={total} />
          <AllocationCard positions={positions} sectorOf={sectorOf} total={total} />
          <Card className="v3-span-7" title="Latest market news" sub="via Finnhub"><MarketNewsFeed /></Card>
        </div>
      )}
      <div className="v3-section-h" id="v3-full-portfolio"><h2>Manage holdings</h2></div>
      <div className="v3-plain">
        <Suspense fallback={<Empty text="Loading the portfolio…" />}><PortfolioView portfolio={portfolio} portfolioId={portfolioId} authFetch={authFetch} /></Suspense>
      </div>
    </div>
  )
}
