/**
 * v3 Discover — the Dev preview's Discover page on the app's real tools.
 *
 * The preview opened on a "scenario library": ready-made starting points you
 * pick and refine. Here each starting point is a real Fundamental Screener
 * run (sector, market-cap floor, dividend floor and the yield/profitability
 * weighting are the screener's own parameters), ranked by the same code as
 * the screener page. No backtest figure is shown for a starting point because
 * none has been measured. Above it, one card per discovery tool with what its
 * last run produced; below it, v1's full screener with every control.
 */

import { useState, lazy, Suspense } from 'react'
import { LogIn, Play } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { getApiKeyHeaders } from '../../services/api'
import { useAuthedJson, usePublicJson } from '../data'
import { Card, Badge, Empty, Bar } from '../ui'

const ScreenerView = lazy(() => import('../../components/Screener/ScreenerView'))

const STYLES = [
  { id: 'quality', cat: 'Quality', title: 'Profitable businesses', desc: 'Ranked on margins and returns on capital only; dividends ignored.', params: { weights: { yield: 0, profitability: 1 } } },
  { id: 'income', cat: 'Income', title: 'Covered dividends, 3% or more', desc: 'Yield that earnings and free cash flow actually fund; uncovered yields are flagged.', params: { minYield: 3, weights: { yield: 0.7, profitability: 0.3 } } },
  { id: 'balanced', cat: 'Balanced', title: 'Quality income', desc: 'Half yield quality, half profitability: the screener default.', params: { weights: { yield: 0.5, profitability: 0.5 } } },
  { id: 'megacap', cat: 'Size', title: 'Large caps only', desc: 'Companies above $50B, ranked on profitability and yield quality.', params: { minMarketCap: 50e9 } },
]

const ago = (iso) => {
  if (!iso) return null
  const m = Math.round((Date.now() - new Date(iso)) / 60000)
  return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`
}

function ToolCards({ onNavigate }) {
  const scan = useAuthedJson('/api/ai-brain/scan/latest')
  const adv = useAuthedJson('/api/recommendations/job/latest')
  const sj = scan.data?.job
  const aj = adv.data?.job
  const picks = sj?.result?.rankedStocks ?? []
  const recs = aj?.result?.recommendations ?? []
  const tools = [
    { tab: 'screener', name: 'Fundamental screener', what: 'The whole market, ranked on yield quality and profitability', last: 'Starting points below' },
    { tab: 'ai-brain', name: 'AI Brain scan', what: 'Stocks by sector, ETFs, crypto and funds; 3/6/12-month horizons', last: sj ? `${picks.filter(p => p.actionable !== false).length} picks, ${picks.filter(p => p.actionable === false).length} declined · ${ago(sj.finishedAt || sj.completedAt)}` : 'No scan yet' },
    { tab: 'recommendations', name: 'Advisory', what: '10 investor personas, expected-value gate, Kelly sizing', last: aj ? (aj.result?.abstained ? `Abstained: nothing cleared the gate · ${ago(aj.finishedAt || aj.completedAt)}` : `${recs.length} picks cleared the gate · ${ago(aj.finishedAt || aj.completedAt)}`) : 'No run yet' },
    { tab: 'buy-signals', name: 'AI Buy Signals', what: 'Entry, stop and target on every signal, with plan odds', last: 'Open to generate' },
    { tab: 'dividend-screen', name: 'Dividend screen', what: 'Income names with payout and coverage checks', last: 'Open to run' },
    { tab: 'ai-watchlist', name: 'AI Watchlist', what: 'Names the AI keeps an eye on for you', last: 'Open to review' },
  ]
  return (
    <div className="v3-tools">
      {tools.map(t => (
        <button key={t.tab} type="button" className="v3-mini" onClick={() => onNavigate(t.tab)}>
          <div className="v3-mini-h"><b>{t.name}</b></div>
          <p>{t.what}</p>
          <div className="v3-mini-f"><span>{t.last}</span></div>
        </button>
      ))}
    </div>
  )
}

function StartingPoints({ onNavigate }) {
  const { isAuthenticated, authFetch } = useAuth()
  const sectors = usePublicJson('/api/screener/sectors')
  const [style, setStyle] = useState(STYLES[0].id)
  const [sector, setSector] = useState('')
  const [run, setRun] = useState({ loading: false, data: null, error: null, key: null })
  const st = STYLES.find(s => s.id === style)
  const list = (sectors.data?.sectors ?? []).slice(0, 11)

  const go = async () => {
    const body = { ...st.params, sector: sector || undefined, limit: 20, explain: false }
    const key = JSON.stringify(body)
    setRun({ loading: true, data: null, error: null, key })
    try {
      const r = await authFetch('/api/screener/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...getApiKeyHeaders() }, body: JSON.stringify(body),
      })
      const j = await r.json()
      // Heartbeated route: a failure can arrive as 200 with an error body.
      if (!r.ok || (j.error && !j.ranked?.length)) throw new Error(j.error || `HTTP ${r.status}`)
      setRun({ loading: false, data: j, error: null, key })
    } catch (e) { setRun({ loading: false, data: null, error: e.message, key }) }
  }

  const rows = run.data?.ranked ?? []
  return (
    <>
      <div className="v3-section-h"><h2>Starting points</h2></div>
      <p className="v3-note" style={{ marginTop: -6 }}>Pick a style and, if you like, a sector. Each one is a real screener run, ranked in code. Open any result in the Research Desk.</p>
      <div className="v3-presets">
        {STYLES.map(s => (
          <button key={s.id} type="button" className={`v3-preset ${style === s.id ? 'on' : ''}`} onClick={() => setStyle(s.id)}>
            <span className="v3-eyebrow">{s.cat}</span>
            <b>{s.title}</b>
            <span>{s.desc}</span>
          </button>
        ))}
      </div>
      <Card>
        <div className="v3-filter-row">
          <span className="v3-muted">Sector</span>
          <div className="v3-pills">
            <button className={sector === '' ? 'on' : ''} onClick={() => setSector('')}>All sectors</button>
            {list.map(s => <button key={s.sector} className={sector === s.sector ? 'on' : ''} onClick={() => setSector(s.sector)}>{s.sector}</button>)}
          </div>
          {isAuthenticated
            ? <button className="v3-btn primary" onClick={go} disabled={run.loading}><Play className="w-3.5 h-3.5" /> {run.loading ? 'Running…' : 'Run'}</button>
            : <span className="v3-muted"><LogIn className="w-3.5 h-3.5 inline" /> Sign in to run</span>}
        </div>
      </Card>
      {(run.loading || run.data || run.error) && (
        <Card title={rows.length ? `${rows.length} companies ranked` : 'Results'}
          sub={run.data ? `${st.title}${sector ? ` · ${sector}` : ''} · ${run.data.candidatesScanned ?? '?'} scanned, ${run.data.enriched ?? '?'} with full fundamentals${run.data.excluded?.length ? ` · ${run.data.excluded.length} left out for missing data` : ''}` : undefined}>
          {run.loading ? <Empty text="Screening the market. The first run takes up to a minute." /> :
            run.error ? <Empty text={run.error} /> :
              rows.length === 0 ? <Empty text="Nothing matched." /> : (
                <div className="v3-scroll-x">
                  <table className="v3-table">
                    <thead><tr><th>Company</th><th>Score</th><th className="r">Yield quality</th><th className="r">Profitability</th><th>Flags</th></tr></thead>
                    <tbody>
                      {rows.map(r => (
                        <tr key={r.symbol} onClick={() => onNavigate('research-desk', r.symbol)}>
                          <td><b className="v3-num">{r.symbol}</b>{r.pillars === 1 && <span>scored on one pillar</span>}</td>
                          <td><div className="v3-score"><Bar value={r.composite} tone={r.composite >= 60 ? 'up' : r.composite >= 40 ? 'warn' : 'down'} /><b className="v3-num">{r.composite}</b></div></td>
                          <td className="r v3-num">{r.yieldScore ?? '—'}</td>
                          <td className="r v3-num">{r.profitScore ?? '—'}</td>
                          <td>{(r.flags || []).length ? r.flags.slice(0, 2).map(f => <Badge key={f.code} tone="warn">{f.code.replace(/-/g, ' ')}</Badge>) : <span>none</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          {run.data?.notes?.length > 0 && <p className="v3-note">{run.data.notes.join(' · ')}</p>}
        </Card>
      )}
    </>
  )
}

export default function DiscoverView({ onNavigate, onAnalyze }) {
  return (
    <div className="v3-home">
      <ToolCards onNavigate={onNavigate} />
      <StartingPoints onNavigate={onNavigate} />
      <div className="v3-section-h"><h2>Full screener</h2></div>
      <div className="v3-plain">
        <Suspense fallback={<Empty text="Loading the screener…" />}><ScreenerView onAnalyze={onAnalyze} /></Suspense>
      </div>
    </div>
  )
}
