/**
 * v3 Quant Lab — the Dev preview's Quant Lab page on the app's own maths.
 *
 * The volatility card runs the real walk-forward contest (POST
 * /api/quant/volatility: the GARCH family fitted on five years of daily
 * returns, refit every 63 days, scored by QLIKE, Diebold–Mariano t against
 * GARCH) for one symbol, defaulting to the largest holding. The chart is the
 * 21-day rolling volatility over the last year and the lowest-loss model's
 * 21-day forecast path. A model is called the winner only when the contest
 * says it beat GARCH by more than chance. Beside it, the Strategy Brain's
 * research arms and the strategy library. v1's Quant Lab, every tab, follows.
 */

import { useState, useEffect, lazy, Suspense } from 'react'
import { LogIn, Play, Search } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { getApiKeyHeaders } from '../../services/api'
import { useHero } from '../hero'
import { useAuthedJson } from '../data'
import { Card, Badge, Empty, Bar, LineChart } from '../ui'

const QuantLabView = lazy(() => import('../../components/QuantLab/QuantLabView'))

const SUGGEST = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'BTC-USD']
const volPct = v => v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`

export default function QuantView({ section, positions, onNavigate, onSignIn }) {
  const held = (positions ?? []).filter(p => p.shares > 0 && !/^(CASH|\$)/i.test(p.symbol) && !/\s/.test(p.symbol))
  const largest = [...held].sort((a, b) => (b.mktValue ?? 0) - (a.mktValue ?? 0))[0]?.symbol
  useHero({ eyebrow: 'Quant Lab', headline: 'Institutional maths, every model tested on data it never saw.' })
  return (
    <div className="v3-home">
      <QuantTop initial={largest || 'SPY'} onNavigate={onNavigate} onSignIn={onSignIn} />
      <div className="v3-section-h"><h2>Every Quant Lab tool</h2></div>
      <div className="v3-plain">
        <Suspense fallback={<Empty text="Loading the Quant Lab…" />}><QuantLabView section={section} positions={positions} /></Suspense>
      </div>
    </div>
  )
}

// The volatility card and the contest table share one run, so they live together.
function QuantTop({ initial, onNavigate, onSignIn }) {
  return (
    <div className="v3-grid">
      <VolContest initial={initial} onSignIn={onSignIn} />
      <BrainArmsCard onNavigate={onNavigate} />
      <LibraryCard onNavigate={onNavigate} />
    </div>
  )
}

function VolContest({ initial, onSignIn }) {
  const { isAuthenticated, authFetch } = useAuth()
  const [sym, setSym] = useState(initial)
  const [q, setQ] = useState('')
  const [run, setRun] = useState({ loading: false, data: null, error: null })
  useEffect(() => { setSym(initial) }, [initial])

  const go = async (s) => {
    setRun({ loading: true, data: null, error: null })
    try {
      const r = await authFetch('/api/quant/volatility', { method: 'POST', headers: { 'Content-Type': 'application/json', ...getApiKeyHeaders() }, body: JSON.stringify({ symbol: s, range: '2y' }) })
      const j = await r.json()
      // Heartbeated: a failure can arrive as 200 with an error body.
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`)
      setRun({ loading: false, data: j, error: null })
    } catch (e) { setRun({ loading: false, data: null, error: e.message }) }
  }
  const pick = (s) => { setSym(s); if (isAuthenticated) go(s) }

  const d = run.data
  const cmp = d?.comparison
  const fam = d?.family?.models ?? {}
  const best = cmp?.best
  const bestRow = cmp?.ranking?.find(r => r.model === best)
  const beatGarch = best === 'garch' || !!bestRow?.vsGarch?.better
  const chosen = d ? (beatGarch && fam[best] ? best : 'garch') : null
  const realized = (d?.rolling?.series ?? []).slice(-252)
  const path = chosen ? fam[chosen]?.forecastPath ?? [] : []
  const series = realized.length > 1 ? [
    { values: [...realized, ...path.map(() => null)], cls: 'v3-line-main', area: true },
    ...(path.length ? [{ values: [...realized.map((v, i) => (i === realized.length - 1 ? v : null)), ...path], cls: 'v3-line-fc' }] : []),
  ] : null

  return (
    <>
      <Card className="v3-span-7" title={d ? `${d.symbol} volatility, annualized` : 'Volatility'}
        sub={d ? `21-day realized over the last year, then the next 21 days from ${fam[chosen]?.label || chosen}` : 'Five volatility models fitted on five years of daily returns, compared walk-forward'}
        action={d && <div className="v3-legend"><span className="is-main">Realized</span><span className="is-fc">Forecast</span></div>}>
        <form className="v3-picker v3-picker-in" onSubmit={e => { e.preventDefault(); const s = q.trim().toUpperCase(); if (s) { setQ(''); pick(s) } }}>
          <Search className="w-4 h-4" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={`Symbol (now ${sym})`} aria-label="Symbol" />
          <div className="v3-pills">{SUGGEST.filter(s => s !== sym).slice(0, 4).map(s => <button type="button" key={s} onClick={() => pick(s)}>{s}</button>)}</div>
          {isAuthenticated
            ? <button type="button" className="v3-btn primary" disabled={run.loading} onClick={() => go(sym)}><Play className="w-3.5 h-3.5" /> {run.loading ? 'Fitting…' : `Run ${sym}`}</button>
            : <button type="button" className="v3-btn" onClick={onSignIn}><LogIn className="w-3.5 h-3.5" /> Sign in to run</button>}
        </form>
        {run.loading ? <Empty text={`Fitting five models to ${sym} and testing them walk-forward. This takes up to a minute.`} /> :
          run.error ? <Empty text={run.error} /> :
            !d ? <Empty text="Pick a symbol and run the contest. Nothing is precomputed or stored." /> : (
              <>
                <div className="v3-stats">
                  <div><span>Realized, 21 days</span><b className="v3-num">{volPct(d.rolling?.current)}</b></div>
                  <div><span>Forecast, next 21 days</span><b className="v3-num">{volPct(fam[chosen]?.forecastVol21)}</b></div>
                  <div><span>Long-run level</span><b className="v3-num">{volPct(fam[chosen]?.longRunVol)}</b></div>
                  <div><span>Yang–Zhang, 2 years</span><b className="v3-num">{volPct(d.yangZhang)}</b></div>
                </div>
                {series && <LineChart series={series} labels={['1 year ago', '6 months ago', 'Today', '+21 days']} label={`${d.symbol} volatility`} fmtY={volPct} />}
              </>
            )}
      </Card>
      <Card className="v3-span-5" title="Model contest"
        sub={cmp ? `Walk-forward over the last ${cmp.testDays} days, refit every ${cmp.refitEvery}. Lower loss wins.` : 'Walk-forward, refit every 63 days. Lower loss wins.'}>
        {!d ? <Empty text={run.loading ? 'Waiting for the fit…' : 'Run a symbol to see how the models compare.'} /> :
          !cmp ? <Empty text={d.comparisonError || d.familyError || 'The contest could not run on this history.'} /> : (
            <>
              <div className="v3-scroll-x">
                <table className="v3-table">
                  <thead><tr><th>Model</th><th className="r">Log-lik</th><th className="r">QLIKE</th><th className="r">vs GARCH t</th></tr></thead>
                  <tbody>
                    {cmp.ranking.map(r => {
                      const broken = !Number.isFinite(r.qlike) || Math.abs(r.qlike) > 1e3
                      return (
                        <tr key={r.model}>
                          <td>{r.label} {r.model === chosen && <Badge tone="up">used</Badge>}{r.model === 'garch' && r.model !== chosen && <span>reference</span>}</td>
                          <td className="r v3-num">{fam[r.model]?.logLik != null ? fam[r.model].logLik.toFixed(1) : '—'}</td>
                          <td className="r v3-num">{broken ? 'diverged' : r.qlike.toFixed(3)}</td>
                          <td className="r v3-num">{r.vsGarch && !broken ? r.vsGarch.t.toFixed(2) : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="v3-callout">{cmp.verdict} A challenger replaces GARCH only below t = −{cmp.tBar.toFixed(2)}.</div>
              {d.forecastStudy && <p className="v3-note">{d.forecastStudy.ran === false ? d.forecastStudy.note : d.forecastStudy.adopted ? `The weekly study adopted ${d.forecastStudy.adopted} for the 21-day forecast used across the app.` : 'The weekly study kept the default median forecast across the app.'}</p>}
            </>
          )}
      </Card>
    </>
  )
}

function BrainArmsCard({ onNavigate }) {
  const st = useAuthedJson('/api/strategy-brain/status')
  const d = st.data
  const arms = [...(d?.arms ?? [])].sort((a, b) => (b.pBest ?? 0) - (a.pBest ?? 0)).slice(0, 7)
  const tries = (d?.arms ?? []).reduce((s, a) => s + (a.tries || 0), 0)
  return (
    <Card className="v3-span-7" title="Strategy Brain" sub="Research arms. Each run tries more of what has been admitted and survived forward testing."
      action={d && <Badge tone={d.enabled && !d.paused ? 'up' : 'neutral'}>{d.paused ? 'PAUSED' : d.enabled ? 'ON' : 'OFF'}</Badge>}>
      {!st.isAuthenticated ? <Empty text="Sign in to see the Strategy Brain." /> : !d ? <Empty text={st.error || 'Loading…'} /> : (
        <>
          <ul className="v3-arms">
            {arms.map(a => (
              <li key={a.id}>
                <span>{a.label}</span>
                <Bar value={(a.pBest ?? 0) * 100} tone="up" />
                <b className="v3-num">{Math.round((a.pBest ?? 0) * 100)}%</b>
                <em className="v3-num">{a.tries ? `${a.hits}/${a.tries} admitted` : 'untried'}</em>
              </li>
            ))}
          </ul>
          <p className="v3-note">{tries === 0 ? 'No run yet, so every arm has the same chance.' : `${tries} experiments so far.`} The share is how often each arm is tried next. {!d.enabled && d.stopReason ? `Off: ${d.stopReason}.` : ''} Budget ${d.budget?.spentUsd?.toFixed(2)} of ${d.budget?.capUsd} this month.</p>
          <button className="v3-btn" onClick={() => onNavigate('quant-lab', 'brain')}>Open the Strategy Brain</button>
        </>
      )}
    </Card>
  )
}

function LibraryCard({ onNavigate }) {
  const lib = useAuthedJson('/api/evolution/strategies?limit=5')
  const s = lib.data?.stats
  const rows = lib.data?.strategies ?? []
  return (
    <Card className="v3-span-5" title="Strategy library" sub="Admitted only after two disjoint windows, a deflated-Sharpe test and an overfitting check"
      action={<button className="v3-btn" onClick={() => onNavigate('strategies')}>All strategies</button>}>
      {!lib.isAuthenticated ? <Empty text="Sign in to see the library." /> : !lib.data ? <Empty text={lib.error || 'Loading…'} /> : (
        <>
          <div className="v3-stats">
            <div><span>Active</span><b className="v3-num">{s?.active ?? 0}</b></div>
            <div><span>Proven forward</span><b className="v3-num">{s?.proven ?? 0}</b></div>
            <div><span>Retired</span><b className="v3-num">{s?.retired ?? 0}</b></div>
          </div>
          {rows.length === 0 ? <Empty text="Empty so far. The nightly evolution job fills it." /> : (
            <ul className="v3-kv">
              {rows.map(r => <li key={r.id}><span>{r.name} · {r.symbol}</span><b className="v3-num">{Math.round(r.fitness ?? 0)}</b></li>)}
            </ul>
          )}
        </>
      )}
    </Card>
  )
}
