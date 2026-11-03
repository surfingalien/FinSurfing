/**
 * v3 Markets — the Dev preview's Markets page on live data.
 *
 * FRED macro indicators and the rule-written regime playbook (both from
 * /api/macro/indicators), the price regime of SPY and BTC with what followed
 * each state over the last five years (from the track record, signed in),
 * a fear & greed reading built from the VIX and the eleven S&P sector funds,
 * the busiest Polymarket questions and the economic calendar. v1's full Macro
 * page follows underneath, so nothing it showed is lost.
 */

import { useState, useEffect, useMemo, lazy, Suspense } from 'react'
import { fetchQuotes } from '../../services/api'
import { calcFearGreed } from '../../services/forecast'
import { useHero } from '../hero'
import { useAuthedJson, usePublicJson } from '../data'
import { Card, Badge, Empty, Bar, Gauge, pct, signCls } from '../ui'

const MacroView = lazy(() => import('../../components/Macro/MacroView'))

const SECTOR_FUNDS = ['XLK', 'XLF', 'XLV', 'XLE', 'XLY', 'XLP', 'XLI', 'XLB', 'XLU', 'XLRE', 'XLC']
const REGIME_ORDER = ['up-calm', 'up-stressed', 'range-calm', 'range-stressed', 'down-calm', 'down-stressed']

function fmtIndicator(x) {
  if (x.value == null) return '—'
  const v = +x.value
  if (x.unit === '%') return `${v.toFixed(2)}%`
  if (x.unit === 'K') return `${v > 0 ? '+' : ''}${Math.round(v)}k`
  return v.toFixed(1)
}

function IndicatorsCard({ macro }) {
  const list = (macro.data?.indicators ?? []).filter(x => x.value != null)
  return (
    <Card className="v3-span-8" title="Macro indicators"
      sub={macro.data?.fetchedAt ? `${list.length} FRED series · fetched ${new Date(macro.data.fetchedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'FRED series, refreshed hourly'}>
      {list.length === 0 ? <Empty text={macro.error ? 'Macro data unavailable (the server needs a FRED key).' : 'Loading FRED series…'} /> : (
        <div className="v3-ind">
          {list.map(x => (
            <div key={x.id} className="v3-ind-tile" title={`${x.description}${x.date ? ` · as of ${x.date}` : ''}`}>
              <span>{x.label}</span>
              <b className="v3-num">{fmtIndicator(x)}</b>
              <em className={`v3-num ${x.delta != null ? signCls(x.delta) : ''}`}>
                {x.delta != null ? `${x.delta > 0 ? '+' : x.delta < 0 ? '−' : ''}${Math.abs(x.delta).toFixed(2)} vs prior` : (x.changeLabel || '')}
              </em>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

function PlaybookCard({ macro }) {
  const reg = macro.data?.regime
  const pb = macro.data?.playbook
  const tone = { emerald: 'up', amber: 'warn', red: 'down' }[reg?.regimeColor] ?? 'neutral'
  return (
    <Card className="v3-span-4" title="Regime playbook" sub="Rules written in code from the indicators, not by a model"
      action={reg && <Badge tone={tone}>{reg.regime.split(' / ')[0].toUpperCase()}</Badge>}>
      {!pb ? <Empty text={macro.error ? 'Needs FRED data.' : 'Loading…'} /> : (
        <>
          {pb.favor?.length > 0 && <><h4 className="v3-h4 v3-up first">Favor</h4><div className="v3-chips">{pb.favor.map(f => <span key={f} className="up">{f}</span>)}</div></>}
          {pb.avoid?.length > 0 && <><h4 className="v3-h4 v3-down">Avoid</h4><div className="v3-chips">{pb.avoid.map(f => <span key={f} className="down">{f}</span>)}</div></>}
          {!pb.favor?.length && !pb.avoid?.length && <p className="v3-note">No tilt triggered: every indicator sits in its neutral band.</p>}
          <div className="v3-callout"><b>Strategy bias:</b> {pb.strategyBias}</div>
          {reg?.signals?.length > 0 && (
            <ul className="v3-signals">
              {reg.signals.slice(0, 5).map((s, i) => <li key={i}><i className={{ positive: 'up', caution: 'warn', warning: 'down' }[s.type]} />{s.text}</li>)}
            </ul>
          )}
        </>
      )}
    </Card>
  )
}

function PriceRegimeCard({ onNavigate }) {
  const t = useAuthedJson('/api/research-desk/track-record')
  const eq = t.data?.priceRegime?.equity
  const cr = t.data?.priceRegime?.crypto
  const prof = eq?.profile ?? {}
  return (
    <Card className="v3-span-7" title="Price regime"
      sub={eq ? `${eq.symbol} trend × volatility. Average next-20-day return in each state, non-overlapping windows, last 5 years` : 'S&P 500 trend × volatility, from five years of daily bars'}>
      {!t.isAuthenticated ? <Empty text="Sign in to see the price regime." /> : !eq ? (
        <Empty text={t.loading ? 'Loading…' : 'Not measured since the server started. It is read by the next AI Brain scan or Research Desk dossier.'}
          action={<button className="v3-btn" onClick={() => onNavigate('research-desk')}>Open the Research Desk</button>} />
      ) : (
        <>
          <div className="v3-regimes">
            {REGIME_ORDER.map(k => {
              const p = prof[k]
              return (
                <div key={k} className={k === eq.label ? 'on' : ''}>
                  <span>{k}{k === eq.label ? ' · now' : ''}</span>
                  <b className={`v3-num ${signCls(p?.meanFwdRet)}`}>{p ? pct(p.meanFwdRet) : '—'}</b>
                  <em>{p ? `n=${p.n}` : 'not seen'}</em>
                </div>
              )
            })}
          </div>
          {cr?.label && <p className="v3-note">Crypto ({cr.symbol}) is in <b>{cr.label}</b>.</p>}
        </>
      )}
    </Card>
  )
}

function SentimentCard({ onNavigate }) {
  const [quotes, setQuotes] = useState(null)
  useEffect(() => { fetchQuotes([...SECTOR_FUNDS, '^VIX']).then(setQuotes).catch(() => setQuotes([])) }, [])
  const fg = useMemo(() => {
    if (!quotes) return null
    const vix = quotes.find(q => q.symbol === '^VIX')?.price
    const funds = quotes.filter(q => q.symbol !== '^VIX' && q.price != null)
    if (!vix && !funds.length) return null
    return calcFearGreed(funds, vix)
  }, [quotes])
  const score = fg ? Math.round(fg.score) : null
  const tone = score == null ? 'neutral' : score >= 55 ? 'up' : score <= 45 ? 'down' : 'warn'
  return (
    <Card className="v3-span-5" title="Fear & greed" sub="VIX and how the 11 S&P sector funds are moving today"
      action={<button className="v3-btn" onClick={() => onNavigate('sentiment')}>News sentiment</button>}>
      {!quotes ? <Empty text="Loading quotes…" /> : !fg ? <Empty text="No quotes available right now." /> : (
        <div className="v3-fg">
          <Gauge value={score} label={fg.label} tone={tone} />
          <ul className="v3-kv">
            {(fg.components || []).map(c => <li key={c.name}><span>{c.name}</span><b className="v3-num">{c.value}</b></li>)}
          </ul>
        </div>
      )}
    </Card>
  )
}

function PredictionCard({ onNavigate }) {
  const { data, error } = usePublicJson('/api/polymarket/markets?limit=6')
  const list = (data?.markets ?? []).filter(m => m.yesPct != null).slice(0, 6)
  return (
    <Card className="v3-span-6" title="Prediction markets" sub="Busiest open Polymarket questions, by volume"
      action={<button className="v3-btn" onClick={() => onNavigate('polymarket')}>All markets</button>}>
      {list.length === 0 ? <Empty text={error ? 'Polymarket is unavailable right now.' : data ? 'No open markets returned.' : 'Loading…'} /> : (
        <ul className="v3-odds">
          {list.map(m => (
            <li key={m.id}>
              <span>{m.question}</span>
              <Bar value={m.yesPct} tone="up" />
              <b className="v3-num">{m.yesPct}%</b>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function CalendarCard({ onNavigate }) {
  const { data, error } = usePublicJson('/api/calendar/events')
  const today = new Date().toISOString().slice(0, 10)
  const events = (data?.events ?? []).filter(e => e.date >= today && e.importance !== 'low')
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''))).slice(0, 6)
  return (
    <Card className="v3-span-6" title="Economic calendar" sub="High and medium impact events ahead"
      action={<button className="v3-btn" onClick={() => onNavigate('calendar')}>Full calendar</button>}>
      {events.length === 0 ? <Empty text={error ? 'Economic calendar unavailable.' : data ? 'No events in the next two weeks.' : 'Loading…'} /> : (
        <ul className="v3-events">
          {events.map((e, i) => {
            const d = new Date(`${e.date}T12:00:00`)
            return (
              <li key={i}>
                <div className="v3-date"><span>{d.toLocaleDateString('en-US', { weekday: 'short' })}</span><b>{d.getDate()}</b></div>
                <div>
                  <b>{e.name} {e.importance === 'high' && <Badge tone="warn">HIGH</Badge>}</b>
                  <span>{[e.country, e.time, e.forecast ? `forecast ${e.forecast}` : null, e.previous ? `prior ${e.previous}` : null].filter(Boolean).join(' · ')}</span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

export default function MarketsView({ onNavigate }) {
  const macro = usePublicJson('/api/macro/indicators')
  const reg = macro.data?.regime
  const pb = macro.data?.playbook
  useHero(reg ? {
    eyebrow: `Markets · ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
    headline: `${reg.regime.replace(' / ', ', ')}.${pb?.strategyBias ? ` ${pb.strategyBias.split(' (')[0].replace(/^./, c => c.toUpperCase())}.` : ''}`,
  } : null)
  return (
    <div className="v3-home">
      <div className="v3-grid">
        <IndicatorsCard macro={macro} />
        <PlaybookCard macro={macro} />
        <PriceRegimeCard onNavigate={onNavigate} />
        <SentimentCard onNavigate={onNavigate} />
        <PredictionCard onNavigate={onNavigate} />
        <CalendarCard onNavigate={onNavigate} />
      </div>
      <div className="v3-section-h"><h2>Every macro series in detail</h2></div>
      <div className="v3-plain">
        <Suspense fallback={<Empty text="Loading the macro page…" />}><MacroView /></Suspense>
      </div>
    </div>
  )
}
