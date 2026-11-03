/**
 * v3 Home — the Dev preview's Home, rebuilt on live data.
 *
 * Market brief (from the live Market Focus run), index tiles with 3-month
 * sparklines, Market Focus picks, your portfolio against the S&P 500 over six
 * months (rebuilt from each holding's daily closes), the macro regime from
 * FRED, the latest AI Brain scan's top picks, upcoming high-impact events,
 * sector moves and your watchlist — then every widget v1's dashboard has
 * (heatmap, movers, AI signal scan, risk, news, sentiment), so nothing is lost.
 *
 * No sample numbers: a card with no data says what it is waiting for.
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import { ArrowRight, RefreshCw, LogIn } from 'lucide-react'
import { fetchQuotes, fetchChart, getApiKeyHeaders } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { calcFearGreed } from '../../services/forecast'
import { scanPortfolio } from '../../services/aiEngine'
import { useHero } from '../hero'
import PortfolioHeatmap from '../../components/Dashboard/widgets/PortfolioHeatmap'
import MarketMovers from '../../components/Dashboard/widgets/MarketMovers'
import QuickSignals from '../../components/Dashboard/widgets/QuickSignals'
import PortfolioRisk from '../../components/Dashboard/widgets/PortfolioRisk'
import MarketNewsFeed from '../../components/Dashboard/widgets/MarketNewsFeed'
import FearGreedGauge from '../../components/Dashboard/widgets/FearGreedGauge'
import SentimentPulseWidget from '../../components/Sentiment/SentimentPulseWidget'
import { Card, Badge, Spark, Empty, money, pct, signCls, Bar } from '../ui'

const INDEXES = [
  { symbol: 'SPY',  label: 'S&P 500',      note: 'SPY' },
  { symbol: 'QQQ',  label: 'Nasdaq 100',   note: 'QQQ' },
  { symbol: 'DIA',  label: 'Dow Jones',    note: 'DIA' },
  { symbol: 'IWM',  label: 'Russell 2000', note: 'IWM' },
  { symbol: '^VIX', label: 'VIX',          note: 'index' },
  { symbol: 'TLT',  label: 'Long bonds',   note: 'TLT' },
]
const MAX_CHART_HOLDINGS = 20

const closesOf = (c) => (c?.candles ?? []).map(k => k.close).filter(Number.isFinite)
const dayKey = (t) => new Date(t).toISOString().slice(0, 10)

function useAuthedJson(url, deps = []) {
  const { isAuthenticated, authFetch } = useAuth()
  const [state, setState] = useState({ data: null, error: null, loading: false })
  const load = useCallback(async (opts) => {
    if (!isAuthenticated || !url) return
    setState(s => ({ ...s, loading: true }))
    try {
      const r = await authFetch(url, opts)
      const j = await r.json()
      setState({ data: j, error: j?.error && !j.focusItems ? j.error : null, loading: false })
    } catch (e) {
      setState({ data: null, error: e.message, loading: false })
    }
  }, [isAuthenticated, url, authFetch]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [load, ...deps]) // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, reload: load, isAuthenticated }
}

function usePublicJson(url) {
  const [state, setState] = useState({ data: null, error: null })
  useEffect(() => {
    let live = true
    fetch(url, { headers: getApiKeyHeaders() }).then(r => r.json()).then(j => { if (live) setState({ data: j, error: j?.error ?? null }) })
      .catch(e => { if (live) setState({ data: null, error: e.message }) })
    return () => { live = false }
  }, [url])
  return state
}

/* ── Index tiles ─────────────────────────────────────────────────────────── */
function IndexTiles() {
  const [quotes, setQuotes] = useState({})
  const [series, setSeries] = useState({})
  useEffect(() => {
    const syms = INDEXES.map(i => i.symbol)
    fetchQuotes(syms).then(rs => setQuotes(Object.fromEntries(rs.map(q => [q.symbol, q])))).catch(() => {})
    syms.forEach(s => fetchChart(s, '1d', '3mo')
      .then(c => setSeries(prev => ({ ...prev, [s]: closesOf(c) })))
      .catch(() => {}))
  }, [])
  return (
    <div className="v3-idx">
      {INDEXES.map(i => {
        const q = quotes[i.symbol]
        const s = series[i.symbol] || []
        const chg = q?.changePct
        return (
          <div key={i.symbol} className="v3-card v3-idx-tile">
            <div className="v3-idx-top">
              <span>{i.label} <em>{i.note}</em></span>
              <span className={signCls(chg)}>{pct(chg)}</span>
            </div>
            <div className="v3-num v3-idx-px">{q?.price != null ? money(q.price, i.symbol === '^VIX' ? '' : '$') : '—'}</div>
            <Spark values={s} up={s.length > 1 ? s[s.length - 1] >= s[0] : (chg ?? 0) >= 0} />
          </div>
        )
      })}
    </div>
  )
}

/* ── Market Focus ────────────────────────────────────────────────────────── */
const ACTION_TONE = { buy: 'up', 'buy dip': 'up', hold: 'neutral', watch: 'warn', trim: 'down', cut: 'down', sell: 'down', skip: 'neutral' }

function FocusCard({ focus, onNavigate, onSignIn }) {
  if (!focus.isAuthenticated) {
    return (
      <Card className="v3-focus" title="Market Focus" sub="What to watch this session, from your holdings, watchlist and macro.">
        <Empty icon={LogIn} text="Sign in to see the AI's focus list for this session." action={<button className="v3-btn primary" onClick={onSignIn}>Sign in</button>} />
      </Card>
    )
  }
  const d = focus.data
  const items = (d?.focusItems ?? []).filter(x => x.priority !== 'skip').slice(0, 4)
  const mins = d?.updatedAt ? Math.max(0, Math.round((Date.now() - new Date(d.updatedAt)) / 60000)) : null
  return (
    <Card
      className="v3-focus"
      title={<>Market Focus <Badge tone="up">Live</Badge></>}
      sub={`What to watch this session, from your holdings, watchlist and macro.${mins != null ? ` Updated ${mins} minute${mins === 1 ? '' : 's'} ago.` : ''}`}
      action={<button className="v3-btn" onClick={() => onNavigate('market-focus')}>Open Market Focus</button>}
    >
      {focus.loading && !d ? <Empty text="Reading today's session…" /> :
        items.length === 0 ? <Empty text={focus.error || 'No focus items yet for this session.'} /> : (
          <div className="v3-grid-4">
            {items.map(x => (
              <button key={x.symbol} type="button" className="v3-mini" onClick={() => onNavigate('research-desk', x.symbol)}>
                <div className="v3-mini-h">
                  <b className="v3-num">{x.symbol}</b>
                  <Badge tone={ACTION_TONE[String(x.action || '').toLowerCase()] ?? 'neutral'}>{(x.action || x.priority || '').toUpperCase()}</Badge>
                </div>
                <p>{x.prediction || x.signal}</p>
                {(x.priceTarget != null || x.stopWatch != null) && (
                  <div className="v3-mini-f v3-num">
                    {x.priceTarget != null && <span>Target {money(x.priceTarget)}</span>}
                    {x.stopWatch != null && <span>Stop {money(x.stopWatch)}</span>}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
    </Card>
  )
}

/* ── Portfolio vs S&P 500 ────────────────────────────────────────────────── */
function usePortfolioHistory(positions) {
  const [hist, setHist] = useState(null)
  const key = positions.map(p => `${p.symbol}:${p.shares}`).sort().join(',')
  useEffect(() => {
    const held = positions
      .filter(p => p.shares > 0 && !/^(CASH|\$)/i.test(p.symbol))
      .sort((a, b) => (b.mktValue ?? 0) - (a.mktValue ?? 0))
    if (!held.length) { setHist({ points: [], used: 0, total: 0 }); return }
    const use = held.slice(0, MAX_CHART_HOLDINGS)
    let live = true
    Promise.all([
      fetchChart('SPY', '1d', '6mo').catch(() => null),
      ...use.map(p => fetchChart(p.symbol, '1d', '6mo').catch(() => null)),
    ]).then(([spy, ...charts]) => {
      if (!live) return
      const spyBy = new Map((spy?.candles ?? []).map(k => [dayKey(k.time), k.close]))
      const days = [...spyBy.keys()].sort()
      const byHolding = charts.map(c => new Map((c?.candles ?? []).map(k => [dayKey(k.time), k.close])))
      const last = byHolding.map(() => null)
      const points = []
      for (const d of days) {
        let v = 0
        byHolding.forEach((m, i) => { if (m.has(d)) last[i] = m.get(d); if (last[i] != null) v += last[i] * use[i].shares })
        if (v > 0) points.push({ d, v, spy: spyBy.get(d) })
      }
      // Start once every charted holding has a price, so a late listing does
      // not show up as a jump in value.
      const starts = byHolding.map(m => [...m.keys()].sort()[0]).filter(Boolean)
      const start = starts.length ? starts.sort().at(-1) : null
      setHist({ points: start ? points.filter(p => p.d >= start) : points, used: use.length, total: held.length })
    })
    return () => { live = false }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return hist
}

function LineChart({ points }) {
  if (!points || points.length < 2) return <Empty text="Not enough price history yet to draw the chart." />
  const W = 640, H = 220, P = 6
  const v0 = points[0].v, s0 = points[0].spy
  const a = points.map(p => p.v / v0)
  const b = points.map(p => (p.spy && s0 ? p.spy / s0 : null))
  const all = [...a, ...b.filter(x => x != null)]
  const lo = Math.min(...all), hi = Math.max(...all)
  const x = i => P + (i / (points.length - 1)) * (W - 2 * P)
  const y = v => P + (1 - (v - lo) / (hi - lo || 1)) * (H - 2 * P)
  const path = arr => arr.map((v, i) => (v == null ? '' : `${i && arr[i - 1] != null ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join('')
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(f * (points.length - 1)))
  return (
    <div className="v3-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Portfolio value against the S&P 500, both indexed to the first day">
        {[0.25, 0.5, 0.75].map(f => <line key={f} x1={P} x2={W - P} y1={P + f * (H - 2 * P)} y2={P + f * (H - 2 * P)} className="v3-grid-line" />)}
        <path d={path(a) + `L${x(a.length - 1)},${H - P}L${x(0)},${H - P}Z`} className="v3-area" />
        <path d={path(b)} className="v3-line-bench" />
        <path d={path(a)} className="v3-line-main" />
      </svg>
      <div className="v3-chart-x">
        {ticks.map(i => <span key={i}>{new Date(points[i].d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>)}
      </div>
    </div>
  )
}

function PortfolioCard({ portfolio, onNavigate }) {
  const positions = portfolio?.positions ?? []
  const s = portfolio?.summary
  const hist = usePortfolioHistory(positions)
  const pts = hist?.points ?? []
  const ret = pts.length > 1 ? (pts[pts.length - 1].v / pts[0].v - 1) * 100 : null
  const spyRet = pts.length > 1 && pts[0].spy ? (pts[pts.length - 1].spy / pts[0].spy - 1) * 100 : null
  // With no holding priced the totals would read $0 / 0.0%, which looks like a
  // real number — show a dash instead.
  const noneMarked = !s || (positions.length > 0 && (s.unpricedCount ?? 0) >= positions.length)
  return (
    <Card
      className="v3-span-8"
      title="Your portfolio"
      sub={`${positions.length} holding${positions.length === 1 ? '' : 's'} · last 6 months${hist && hist.used < hist.total ? ` · chart uses your ${hist.used} largest` : ''}`}
      action={<div className="v3-legend"><span className="is-main">Portfolio</span><span className="is-bench">S&P 500 (SPY)</span></div>}
    >
      {positions.length === 0 ? (
        <Empty text="No holdings yet." action={<button className="v3-btn primary" onClick={() => onNavigate('portfolio')}>Add holdings</button>} />
      ) : (
        <>
          <div className="v3-stats">
            <div><span>Value</span><b className="v3-num">{noneMarked ? '—' : money(s?.totalValue ?? 0, '$', 0)}</b></div>
            <div><span>Today</span><b className={`v3-num ${signCls(s?.todayTotal)}`}>{noneMarked ? '—' : money(s?.todayTotal ?? 0, '$', 0, true)}</b></div>
            <div><span>All-time</span><b className={`v3-num ${signCls(s?.totalGLPct)}`}>{noneMarked ? '—' : pct(s?.totalGLPct)}</b></div>
            <div><span>6M (held today)</span><b className={`v3-num ${signCls(ret)}`}>{pct(ret)}</b></div>
            <div><span>vs S&P 500</span><b className={`v3-num ${signCls(ret != null && spyRet != null ? ret - spyRet : null)}`}>
              {ret != null && spyRet != null ? `${ret - spyRet >= 0 ? '+' : ''}${(ret - spyRet).toFixed(1)} pts` : '—'}</b></div>
          </div>
          {hist == null ? <Empty text="Loading six months of prices…" /> : <LineChart points={pts} />}
          {s?.unpricedCount > 0 && <p className="v3-note warn">{s.unpricedCount} holding{s.unpricedCount > 1 ? 's' : ''} could not be priced, so totals are incomplete.</p>}
        </>
      )}
    </Card>
  )
}

/* ── Macro regime ────────────────────────────────────────────────────────── */
function Gauge({ value, label, tone }) {
  const r = 80, c = Math.PI * r
  const v = Math.max(0, Math.min(100, value ?? 0))
  return (
    <div className="v3-gauge">
      <svg viewBox="0 0 200 116">
        <path d="M20 100 A80 80 0 0 1 180 100" className="v3-gauge-track" />
        <path d="M20 100 A80 80 0 0 1 180 100" className={`v3-gauge-val ${tone}`} strokeDasharray={`${(v / 100) * c} ${c}`} />
      </svg>
      <div className="v3-gauge-num v3-num">{value == null ? '—' : Math.round(v)}</div>
      <div className={`v3-gauge-label ${tone}`}>{label}</div>
    </div>
  )
}

function RegimeCard({ onNavigate }) {
  const { data, error } = usePublicJson('/api/macro/indicators')
  const reg = data?.regime
  const sig = reg?.signals ?? []
  const pos = sig.filter(s => s.type === 'positive').length
  const share = sig.length ? (pos / sig.length) * 100 : null
  const tone = { emerald: 'up', amber: 'warn', red: 'down' }[reg?.regimeColor] ?? 'neutral'
  return (
    <Card className="v3-span-4" title="Market regime" sub="From FRED macro series: rates, inflation, jobs, volatility, credit"
      action={reg && <Badge tone={tone}>{reg.regime.split(' / ')[0].toUpperCase()}</Badge>}>
      {!reg ? <Empty text={error ? 'Macro data unavailable (needs a FRED key on the server).' : 'Loading macro data…'} /> : (
        <>
          <Gauge value={share} label={`${pos} of ${sig.length} signals positive`} tone={tone} />
          <ul className="v3-signals">
            {sig.slice(0, 6).map((s, i) => (
              <li key={i}><i className={{ positive: 'up', caution: 'warn', warning: 'down' }[s.type]} />{s.text}</li>
            ))}
          </ul>
          <button className="v3-link" onClick={() => onNavigate('macro')}>All macro indicators <ArrowRight className="w-3.5 h-3.5" /></button>
        </>
      )}
    </Card>
  )
}

/* ── Ideas from the latest AI Brain scan ─────────────────────────────────── */
function IdeasCard({ onNavigate, onSignIn }) {
  const scan = useAuthedJson('/api/ai-brain/scan/latest')
  const result = scan.data?.job?.result
  const picks = (result?.rankedStocks ?? [])
    .filter(s => s.actionable !== false)
    .sort((a, b) => (b.compositeScore ?? 0) - (a.compositeScore ?? 0))
    .slice(0, 3)
  const when = scan.data?.job?.finishedAt || scan.data?.job?.completedAt
  return (
    <Card className="v3-span-8" title="Highest-conviction ideas"
      sub={result ? `From your latest AI Brain scan${when ? ` · ${new Date(when).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''} · ranked by composite score` : 'From your latest AI Brain scan'}
      action={<button className="v3-btn" onClick={() => onNavigate('ai-brain')}>{result ? 'Open the scan' : 'Run a scan'}</button>}>
      {!scan.isAuthenticated ? (
        <Empty icon={LogIn} text="Sign in to run the AI Brain and see its picks here." action={<button className="v3-btn primary" onClick={onSignIn}>Sign in</button>} />
      ) : picks.length === 0 ? (
        <Empty text={scan.loading ? 'Loading your last scan…' : result ? 'Your last scan had no actionable picks.' : 'No scan yet. Run one from Discover → AI Brain Scan.'} />
      ) : (
        <div className="v3-grid-3">
          {picks.map(p => (
            <button key={p.symbol} type="button" className="v3-mini" onClick={() => onNavigate('research-desk', p.symbol)}>
              <div className="v3-mini-h">
                <b className="v3-num">{p.symbol}</b>
                <Badge tone={/sell|avoid/i.test(p.agentVerdict) ? 'down' : 'up'}>{(p.agentVerdict || 'Buy').toUpperCase()}</Badge>
              </div>
              <div className="v3-mini-px">
                <span className="v3-num">{p.currentPrice != null ? money(p.currentPrice) : '—'}</span>
                {p.targetReturn != null && <span className={`v3-num ${signCls(p.targetReturn)}`}>target {pct(p.targetReturn)}</span>}
              </div>
              <p>{p.catalyst || p.supervisorSynthesis || (p.keyDrivers || []).slice(0, 2).join(' · ')}</p>
              {p.compositeScore != null && (
                <div className="v3-mini-bar"><span>Composite</span><Bar value={p.compositeScore} tone={p.compositeScore >= 60 ? 'up' : p.compositeScore >= 40 ? 'warn' : 'down'} /><b className="v3-num">{Math.round(p.compositeScore)}</b></div>
              )}
            </button>
          ))}
        </div>
      )}
    </Card>
  )
}

/* ── Catalysts ───────────────────────────────────────────────────────────── */
function CatalystsCard({ onNavigate }) {
  const { data, error } = usePublicJson('/api/calendar/events')
  const today = new Date().toISOString().slice(0, 10)
  const events = (data?.events ?? []).filter(e => e.importance === 'high' && e.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date)).slice(0, 5)
  return (
    <Card className="v3-span-4" title="Catalysts ahead" sub="High-impact economic events"
      action={<button className="v3-btn" onClick={() => onNavigate('calendar')}>Calendar</button>}>
      {events.length === 0 ? <Empty text={error ? 'Economic calendar unavailable.' : data ? 'No high-impact events in the next two weeks.' : 'Loading the calendar…'} /> : (
        <ul className="v3-events">
          {events.map((e, i) => {
            const d = new Date(`${e.date}T12:00:00`)
            return (
              <li key={i}>
                <div className="v3-date"><span>{d.toLocaleDateString('en-US', { month: 'short' })}</span><b>{d.getDate()}</b></div>
                <div><b>{e.name}</b><span>{[e.country, e.time, e.forecast ? `forecast ${e.forecast}` : null].filter(Boolean).join(' · ')}</span></div>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

/* ── Sector heatmap ──────────────────────────────────────────────────────── */
function SectorCard({ onNavigate }) {
  const { data, error } = usePublicJson('/api/heatmap/sectors')
  const cells = [...(data?.cells ?? [])].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
  const max = Math.max(1, ...cells.map(c => Math.abs(c.value ?? 0)))
  return (
    <Card className="v3-span-7" title="Sector heatmap" sub="Today's move, S&P 500 sectors"
      action={<button className="v3-btn" onClick={() => onNavigate('heatmap')}>Full heatmap</button>}>
      {cells.length === 0 ? <Empty text={error ? 'Sector data unavailable.' : 'Loading sectors…'} /> : (
        <div className="v3-heat">
          {cells.map((c, i) => {
            const v = c.value ?? 0
            const a = 0.18 + 0.62 * Math.min(1, Math.abs(v) / max)
            return (
              <div key={c.name} className={`v3-heat-cell ${i < 2 ? 'is-big' : ''}`}
                style={{ background: `color-mix(in srgb, var(${v >= 0 ? '--up' : '--down'}) ${Math.round(a * 100)}%, var(--panel))` }}>
                <span>{c.fullName || c.name}</span>
                <b className="v3-num">{pct(v)}</b>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

/* ── Watchlist ───────────────────────────────────────────────────────────── */
function WatchlistCard({ watchlist, onNavigate }) {
  const rows = (watchlist?.quotes ?? []).filter(q => q.symbol).slice(0, 8)
  return (
    <Card className="v3-span-5" title="Watchlist" sub="Tap a row for the full research"
      action={<button className="v3-btn" onClick={() => onNavigate('watchlist')}>Edit</button>}>
      {rows.length === 0 ? <Empty text="Your watchlist is empty." /> : (
        <table className="v3-table">
          <thead><tr><th>Ticker</th><th className="r">Price</th><th className="r">Day</th></tr></thead>
          <tbody>
            {rows.map(q => (
              <tr key={q.symbol} onClick={() => onNavigate('research-desk', q.symbol)}>
                <td><b className="v3-num">{q.symbol}</b><span>{q.name}</span></td>
                <td className="r v3-num">{q.price != null ? money(q.price) : '—'}</td>
                <td className={`r v3-num ${signCls(q.changePct)}`}>{pct(q.changePct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

/* ── Page ────────────────────────────────────────────────────────────────── */
export default function HomeView({ portfolio, watchlist, onNavigate, onAnalyze, onSignIn }) {
  const focus = useAuthedJson('/api/market-focus')
  const positions = portfolio?.positions ?? []
  const quotes = portfolio?.quotes ?? {}
  const quotesArr = useMemo(() => Object.values(quotes), [quotes])

  const theme = focus.data?.sessionTheme
  const day = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  useHero({
    eyebrow: `Market brief · ${focus.data?.sessionLabel || day}`,
    headline: theme ? `${theme.replace(/\.$/, '')}.` : 'Your day at a glance.',
    actions: [
      { label: 'Run a scan', onClick: () => onNavigate('ai-brain') },
      { label: 'View signals', onClick: () => onNavigate('buy-signals'), primary: true },
    ],
  })

  // v1 dashboard widgets, kept so nothing is lost.
  const [vix, setVix] = useState(null)
  const [scan, setScan] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [newsKey, setNewsKey] = useState(0)
  useEffect(() => { fetchQuotes(['^VIX']).then(d => setVix(d?.[0]?.price ?? null)).catch(() => {}) }, [])
  const fg = useMemo(() => calcFearGreed(quotesArr, vix), [quotesArr, vix])
  const runScan = useCallback(async () => {
    if (!positions.length) return
    setScanning(true)
    try { setScan(await scanPortfolio({ positions, quotes })) } finally { setScanning(false) }
  }, [positions, quotes])
  useEffect(() => {
    if (positions.length && quotesArr.length && !scan && !scanning) runScan()
  }, [positions.length, quotesArr.length]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="v3-home">
      <IndexTiles />
      <FocusCard focus={focus} onNavigate={onNavigate} onSignIn={onSignIn} />

      <div className="v3-grid">
        <PortfolioCard portfolio={portfolio} onNavigate={onNavigate} />
        <RegimeCard onNavigate={onNavigate} />
        <IdeasCard onNavigate={onNavigate} onSignIn={onSignIn} />
        <CatalystsCard onNavigate={onNavigate} />
        <SectorCard onNavigate={onNavigate} />
        <WatchlistCard watchlist={watchlist} onNavigate={onNavigate} />
      </div>

      <div className="v3-section-h">
        <h2>More on your portfolio</h2>
        <button className="v3-btn" onClick={() => { portfolio?.refresh?.(); setNewsKey(k => k + 1) }}>
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>
      <div className="v3-grid">
        <Card className="v3-span-8" title="Portfolio heatmap" sub="Click a tile to analyze · colour is today's move">
          <PortfolioHeatmap positions={positions} quotes={quotes} onAnalyze={onAnalyze} />
        </Card>
        <Card className="v3-span-4" title="Fear & Greed" sub="From your holdings' breadth and the VIX">
          <FearGreedGauge fg={fg} />
        </Card>
        <Card className="v3-span-6" title="Market movers" sub="Top gainers and losers among your holdings">
          <MarketMovers positions={positions} quotes={quotes} />
        </Card>
        <Card className="v3-span-6" title="AI signal scan" sub="Quick status of every holding from live quotes">
          <QuickSignals scan={scan} loading={scanning} onScan={runScan} />
        </Card>
        <Card className="v3-span-6" title="Portfolio risk" sub="Beta, concentration and exposure">
          <PortfolioRisk positions={positions} quotes={quotes} />
        </Card>
        <Card className="v3-span-6" title="Latest market news" sub="via Finnhub">
          <MarketNewsFeed refreshKey={newsKey} />
        </Card>
      </div>
      {positions.length > 0 && (
        <div className="v3-plain"><SentimentPulseWidget symbols={positions.map(p => p.symbol)} /></div>
      )}
    </div>
  )
}
