/**
 * v3 Research Desk — the Dev preview's stock page on live data.
 *
 * One symbol: price with 50/200-day averages over 1M–5Y, the measured factor
 * scores and reference levels from the evidence dossier, key numbers and
 * analyst ratings from the fundamentals feed, the last four EPS surprises,
 * and every numbered evidence item the thesis will be judged against. Then
 * v1's Research Desk for the same symbol (thesis, debate mode, track record,
 * "Is it working?"), so the paid steps stay where they were.
 *
 * Nothing here calls a model. Missing sources are named, never filled in.
 */

import { useState, useEffect, useMemo, lazy, Suspense } from 'react'
import { Search, LogIn } from 'lucide-react'
import { fetchQuotes, fetchChart } from '../../services/api'
import { useHero } from '../hero'
import { useAuthedJson, usePublicJson } from '../data'
import { Card, Badge, Empty, Bar, money, pct, signCls } from '../ui'

const ResearchDeskView = lazy(() => import('../../components/ResearchDesk/ResearchDeskView'))

const RANGES = [['1M', 21], ['6M', 126], ['1Y', 252], ['5Y', 1260]]
const SUGGEST = ['SPY', 'NVDA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'TSLA']

const sma = (a, k) => a.map((_, i) => (i < k - 1 ? null : a.slice(i - k + 1, i + 1).reduce((s, x) => s + x, 0) / k))
const fmtBig = (v) => v == null ? '—' : v >= 1e12 ? `$${(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(0)}M` : `$${v}`
const fmtVol = (v) => v == null ? '—' : v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : String(v)

function SymbolPicker({ onPick, current }) {
  const [q, setQ] = useState('')
  return (
    <form className="v3-picker" onSubmit={e => { e.preventDefault(); const s = q.trim().toUpperCase(); if (s) { onPick(s); setQ('') } }}>
      <Search className="w-4 h-4" />
      <input value={q} onChange={e => setQ(e.target.value)} placeholder={current ? `Research another symbol (now ${current})` : 'Type a ticker, e.g. NVDA'} aria-label="Symbol" />
      <div className="v3-pills">
        {SUGGEST.filter(s => s !== current).slice(0, 6).map(s => <button type="button" key={s} onClick={() => onPick(s)}>{s}</button>)}
      </div>
    </form>
  )
}

function PriceCard({ symbol, candles }) {
  const [range, setRange] = useState('1Y')
  const [show, setShow] = useState({ s50: true, s200: false })
  const all = candles ?? []
  const closes = all.map(c => c.close)
  const s50 = useMemo(() => sma(closes, 50), [candles]) // eslint-disable-line react-hooks/exhaustive-deps
  const s200 = useMemo(() => sma(closes, 200), [candles]) // eslint-disable-line react-hooks/exhaustive-deps
  const n = Math.min(all.length, RANGES.find(r => r[0] === range)[1])
  const view = all.slice(-n)
  const vc = view.map(c => c.close)
  const a50 = s50.slice(-n), a200 = s200.slice(-n)
  const lines = [vc, show.s50 ? a50 : [], show.s200 ? a200 : []]
  const vals = lines.flat().filter(v => v != null)
  const lo = Math.min(...vals), hi = Math.max(...vals)
  const W = 600, H = 220
  const X = i => (i / Math.max(1, n - 1)) * W
  const Y = v => H - 6 - ((v - lo) / (hi - lo || 1)) * (H - 12)
  const path = arr => arr.map((v, i) => v == null ? null : `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).filter(Boolean).join(' ')
  const chg = vc.length > 1 ? ((vc.at(-1) - vc[0]) / vc[0]) * 100 : null
  const avgVol = view.length ? view.reduce((s, c) => s + (c.volume || 0), 0) / view.length : null
  const up = (chg ?? 0) >= 0
  return (
    <Card className="v3-span-8"
      title={<div className="v3-seg">{RANGES.map(([r]) => <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>{r}</button>)}</div>}
      action={<div className="v3-pills">
        <button className={show.s50 ? 'on' : ''} onClick={() => setShow(s => ({ ...s, s50: !s.s50 }))}>50-day avg</button>
        <button className={show.s200 ? 'on' : ''} onClick={() => setShow(s => ({ ...s, s200: !s.s200 }))}>200-day avg</button>
      </div>}>
      {!candles ? <Empty text={`Loading ${symbol} prices…`} /> : vc.length < 2 ? <Empty text={`No price history for ${symbol}.`} /> : (
        <>
          <div className="v3-stats">
            <div><span>{range} change</span><b className={`v3-num ${signCls(chg)}`}>{pct(chg)}</b></div>
            <div><span>High</span><b className="v3-num">{money(Math.max(...view.map(c => c.high)))}</b></div>
            <div><span>Low</span><b className="v3-num">{money(Math.min(...view.map(c => c.low)))}</b></div>
            <div><span>Avg volume</span><b className="v3-num">{fmtVol(avgVol)}</b></div>
          </div>
          <div className="v3-chart">
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label={`${symbol} price, ${range}`}>
              {[0.25, 0.5, 0.75].map(f => <line key={f} className="v3-grid-line" x1="0" x2={W} y1={H * f} y2={H * f} />)}
              <polygon className="v3-area" points={`0,${H} ${path(vc)} ${W},${H}`} />
              {show.s200 && <polyline className="v3-line-s200" points={path(a200)} />}
              {show.s50 && <polyline className="v3-line-s50" points={path(a50)} />}
              <polyline className={`v3-line-main ${up ? '' : 'is-down'}`} points={path(vc)} />
            </svg>
            <div className="v3-chart-x">
              {[0, 0.25, 0.5, 0.75, 1].map(f => { const c = view[Math.round(f * (n - 1))]; return <span key={f}>{c ? new Date(c.time).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(n > 300 ? { year: '2-digit' } : {}) }) : ''}</span> })}
            </div>
          </div>
        </>
      )}
    </Card>
  )
}

function parseFactors(text) {
  const out = {}
  for (const [k, re] of [['Momentum', /momentum (\d+)/], ['Trend', /trend (\d+)/], ['Low volatility', /low-volatility (\d+)/], ['Value', /value (\d+)/], ['Composite', /composite (\d+)/]]) {
    const m = String(text).match(re)
    if (m) out[k] = +m[1]
  }
  return out
}

function VerdictCard({ ev, onSignIn }) {
  const d = ev.data
  const f = parseFactors(d?.evidence?.find(x => x.kind === 'factors')?.text ?? '')
  const comp = f.Composite
  const lv = d?.referenceLevels
  const tone = comp == null ? 'neutral' : comp >= 60 ? 'up' : comp >= 40 ? 'warn' : 'down'
  const R = 50, C = 2 * Math.PI * R
  return (
    <Card className="v3-span-4" title="Measured scores" sub="Factor scores 0–100 from price history (and P/E), computed in code"
      action={comp != null && <Badge tone={tone}>COMPOSITE {comp}</Badge>}>
      {!ev.isAuthenticated ? <Empty icon={LogIn} text="Sign in to build the evidence dossier." action={<button className="v3-btn primary" onClick={onSignIn}>Sign in</button>} /> :
        ev.loading && !d ? <Empty text="Building the evidence dossier…" /> :
          ev.error ? <Empty text={ev.error} /> : (
            <>
              <div className="v3-verdict">
                <div className="v3-ring">
                  <svg viewBox="0 0 118 118" aria-hidden="true">
                    <circle cx="59" cy="59" r={R} className="v3-ring-track" />
                    <circle cx="59" cy="59" r={R} className={`v3-ring-val ${tone}`} strokeDasharray={`${(C * (comp ?? 0)) / 100} ${C}`} transform="rotate(-90 59 59)" />
                  </svg>
                  <b className="v3-num">{comp ?? '—'}</b><span>composite</span>
                </div>
                <ul className="v3-factor">
                  {Object.entries(f).filter(([k]) => k !== 'Composite').map(([k, v]) => (
                    <li key={k}><span>{k}</span><Bar value={v} tone={v >= 60 ? 'up' : v >= 40 ? 'warn' : 'down'} /><b className="v3-num">{v}</b></li>
                  ))}
                </ul>
              </div>
              {lv && (
                <>
                  <h4 className="v3-h4">Reference levels <em className="v3-cite">from the bars · not a buy signal</em></h4>
                  <div className="v3-levels">
                    <div><span>Entry</span><b className="v3-num">{money(lv.entry.low)}–{money(lv.entry.high).replace('$', '')}</b></div>
                    <div><span>Stop</span><b className="v3-num v3-down">{money(lv.stop.price)}</b><em>−{lv.riskPct}%</em></div>
                    {lv.booking.map((b, i) => <div key={i}><span>{i ? 'T2' : 'T1'}</span><b className="v3-num v3-up">{money(b.price)}</b><em>{pct(b.pct)} · {b.r}R</em></div>)}
                  </div>
                </>
              )}
            </>
          )}
    </Card>
  )
}

function KeyNumbers({ fu }) {
  const d = fu.data
  const v = d?.valuation ?? {}
  const a = d?.analyst_dist
  const rows = [
    ['P/E', v.pe_ttm != null ? `${v.pe_ttm.toFixed(1)}×` : null], ['P/S', v.ps_ttm != null ? `${v.ps_ttm.toFixed(1)}×` : null],
    ['EV / EBITDA', v.ev_ebitda != null ? `${v.ev_ebitda.toFixed(1)}×` : null], ['PEG', v.peg_ttm != null ? v.peg_ttm.toFixed(2) : null],
    ['Revenue growth', d?.yoy_rev_growth != null ? pct(d.yoy_rev_growth) : null], ['FCF margin', d?.cashflow?.fcf_margin != null ? `${d.cashflow.fcf_margin}%` : null],
    ['FCF yield', v.fcf_yield != null ? `${v.fcf_yield}%` : null], ['ROE', v.roe != null ? `${v.roe}%` : null],
    ['ROIC', v.roic != null ? `${v.roic}%` : null], ['Debt / equity', d?.balance?.debt_to_equity ?? null],
    ['Beta', d?.company?.beta != null ? d.company.beta.toFixed(2) : null], ['Trailing revenue', d?.ttm_revenue_fmt ?? null],
  ].filter(([, x]) => x != null)
  return (
    <Card className="v3-span-6" title="Key numbers" sub="Trailing twelve months, from company filings via FMP">
      {fu.error || !d ? <Empty text={fu.error ? `Fundamentals unavailable: ${fu.error}` : 'Loading fundamentals…'} /> : (
        <>
          <div className="v3-keynum">{rows.map(([k, x]) => <div key={k}><span>{k}</span><b className="v3-num">{x}</b></div>)}</div>
          {a?.total > 0 && (
            <>
              <h4 className="v3-h4">Analyst ratings <em className="v3-cite">third-party opinion · {a.total} ratings</em></h4>
              <div className="v3-stack"><span className="up" style={{ flex: a.buy_pct }} /><span className="warn" style={{ flex: a.hold_pct }} /><span className="down" style={{ flex: a.sell_pct }} /></div>
              <div className="v3-legend v3-legend-dot"><span className="up">{a.buy_pct}% buy</span><span className="warn">{a.hold_pct}% hold</span><span className="down">{a.sell_pct}% sell</span></div>
            </>
          )}
        </>
      )}
    </Card>
  )
}

function EarningsCard({ fu }) {
  const rows = [...(fu.data?.eps_surprises ?? [])].filter(r => r.actual != null).reverse()
  const max = Math.max(0.01, ...rows.flatMap(r => [Math.abs(r.actual ?? 0), Math.abs(r.estimate ?? 0)]))
  const beats = rows.filter(r => r.estimate != null && r.actual >= r.estimate).length
  const avg = rows.filter(r => r.surprise_pct != null)
  const avgS = avg.length ? avg.reduce((s, r) => s + r.surprise_pct, 0) / avg.length : null
  return (
    <Card className="v3-span-6" title="Earnings track record" sub="EPS actual against estimate, last quarters reported">
      {rows.length === 0 ? <Empty text={fu.error ? 'Earnings history unavailable.' : fu.data ? 'No earnings history for this symbol.' : 'Loading…'} /> : (
        <>
          <div className="v3-eps">
            {rows.map(r => {
              const beat = r.estimate == null || r.actual >= r.estimate
              return (
                <div key={r.date}>
                  <div className="v3-eps-plot">
                    <i className={beat ? 'up' : 'down'} style={{ height: `${(Math.abs(r.actual) / max) * 100}%` }} />
                    {r.estimate != null && <s style={{ bottom: `${(Math.abs(r.estimate) / max) * 100}%` }} />}
                  </div>
                  <b className={`v3-num ${signCls(r.surprise_pct)}`}>{r.surprise_pct != null ? pct(r.surprise_pct) : '—'}</b>
                  <span>{new Date(r.date).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })}</span>
                </div>
              )
            })}
          </div>
          <div className="v3-stats" style={{ marginTop: 12 }}>
            <div><span>Beat rate</span><b className="v3-num">{beats} of {rows.length}</b></div>
            <div><span>Average surprise</span><b className={`v3-num ${signCls(avgS)}`}>{pct(avgS)}</b></div>
          </div>
        </>
      )}
    </Card>
  )
}

function EvidenceCard({ ev }) {
  const d = ev.data
  if (!d?.evidence?.length) return null
  return (
    <Card className="v3-span-12" title="Evidence dossier"
      sub={`${d.evidence.length} numbered items, each built in code. A thesis may only cite these, and each claim is checked against the item it cites.`}>
      <ul className="v3-evidence">
        {d.evidence.map(x => (
          <li key={x.id}>
            <b className="v3-num">{x.id}</b>
            <div><span>{x.label}{x.measured === false && <Badge tone="warn">OPINION</Badge>}{x.citable === false && <Badge tone="neutral">CONTEXT ONLY</Badge>}</span><p>{x.text}</p></div>
          </li>
        ))}
      </ul>
      {d.gaps?.length > 0 && <p className="v3-note warn">Missing: {d.gaps.join(' · ')}</p>}
    </Card>
  )
}

export default function ResearchView({ symbol: param, onSymbol, onSignIn }) {
  const [sym, setSym] = useState((param || '').toUpperCase() || null)
  useEffect(() => { if (param) setSym(param.toUpperCase()) }, [param])
  const pick = (s) => { setSym(s); onSymbol?.(s) }

  const [quote, setQuote] = useState(null)
  const [candles, setCandles] = useState(null)
  useEffect(() => {
    if (!sym) return
    let live = true
    setQuote(null); setCandles(null)
    fetchQuotes([sym]).then(q => live && setQuote(q?.[0] ?? null)).catch(() => {})
    fetchChart(sym, '1d', '5y').then(c => live && setCandles(c?.candles ?? [])).catch(() => live && setCandles([]))
    return () => { live = false }
  }, [sym])
  const fu = usePublicJson(sym ? `/api/fundamentals/${encodeURIComponent(sym)}` : null)
  const ev = useAuthedJson(sym ? `/api/research-desk/${encodeURIComponent(sym)}/evidence` : null)
  const co = fu.data?.company
  const price = quote?.price ?? candles?.at(-1)?.close ?? null

  useHero(sym ? {
    eyebrow: [co?.sector, co?.mkt_cap ? `${fmtBig(co.mkt_cap)} market cap` : null, co?.exchange].filter(Boolean).join(' · ') || 'Research Desk',
    headline: `${co?.name || ev.data?.company || sym} · ${sym}${price != null ? ` · ${money(price)}` : ''}${quote?.changePct != null ? ` (${pct(quote.changePct, 2)} today)` : ''}`,
    actions: [{ label: `Ask Copilot about ${sym}`, primary: true, onClick: () => window.dispatchEvent(new Event('finsurf:open-copilot')) }],
  } : null)

  return (
    <div className="v3-home">
      <SymbolPicker onPick={pick} current={sym} />
      {!sym ? <Card><Empty text="Pick a symbol to see its price, measured scores, key numbers and evidence." /></Card> : (
        <div className="v3-grid">
          <PriceCard symbol={sym} candles={candles} />
          <VerdictCard ev={ev} onSignIn={onSignIn} />
          <KeyNumbers fu={fu} />
          <EarningsCard fu={fu} />
          <EvidenceCard ev={ev} />
        </div>
      )}
      <div className="v3-section-h"><h2>Thesis, debate and track record</h2></div>
      <div className="v3-plain">
        <Suspense fallback={<Empty text="Loading the Research Desk…" />}>
          <ResearchDeskView key={sym || 'none'} defaultSymbol={sym} onSymbol={pick} />
        </Suspense>
      </div>
    </div>
  )
}
