/**
 * MacroPanel — the macro dashboard.
 * Fetches /api/macro/indicators. Left: the FRED series grouped by category.
 * Right (sticky on wide screens, first on phones): the rule-based regime and
 * its signals, a few key reads computed from the same series, the regime
 * playbook (favor / avoid / strategy bias, lib/macro-playbook.js) and the
 * data's status (source, updated, any series that did not load, refresh).
 *
 * Props:
 *   compact  — if true renders a slim inline banner instead of the full grid
 */

import { TrendingUp, TrendingDown, RefreshCw, AlertTriangle, Globe, ThumbsUp, ThumbsDown, Compass, Database, Gauge } from 'lucide-react'
import { useRef } from 'react'
import { useQuery, fetchJson } from '../../hooks/useQuery'

const CATEGORY_LABELS = {
  rates:     '📈 Rates',
  inflation: '🔥 Inflation',
  labor:     '👷 Labor',
  growth:    '📊 Growth',
  sentiment: '💭 Sentiment',
  currency:  '💱 Currency',
  risk:      '⚡ Risk',
  housing:   '🏠 Housing',
  credit:    '💳 Credit',
}

const REGIME_STYLE = {
  red:     { bg: 'bg-red-500/10',     border: 'border-red-500/30',     text: 'text-red-400' },
  amber:   { bg: 'bg-amber-500/10',   border: 'border-amber-500/30',   text: 'text-amber-400' },
  emerald: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-400' },
  slate:   { bg: 'bg-white/[0.04]',   border: 'border-white/[0.08]',   text: 'text-slate-400' },
}

const SIGNAL_STYLE = {
  warning:  'text-red-400',
  caution:  'text-amber-400',
  positive: 'text-emerald-400',
}

function fmt(value, unit) {
  if (value == null) return '—'
  const n = typeof value === 'number' ? value : parseFloat(value)
  if (isNaN(n)) return '—'
  if (unit === 'pts' || unit === 'idx') return n.toFixed(1)
  if (unit === 'K') return (n > 0 ? '+' : '') + n.toLocaleString()
  return n.toFixed(2)
}

function Delta({ delta, unit }) {
  if (delta == null) return null
  const pos = delta >= 0
  return (
    <span className={`text-[9px] font-mono ${pos ? 'text-emerald-400' : 'text-red-400'} flex items-center gap-0.5`}>
      {pos ? <TrendingUp className="w-2.5 h-2.5" /> : <TrendingDown className="w-2.5 h-2.5" />}
      {pos ? '+' : ''}{delta.toFixed(2)}
    </span>
  )
}

/* ── Compact banner (used inside BuySignalsView) ─────────────────────────── */
export function MacroBanner({ regime, signals }) {
  if (!regime) return null
  const style = REGIME_STYLE[regime.regimeColor] ?? REGIME_STYLE.slate
  return (
    <div className={`rounded-xl p-3 border ${style.bg} ${style.border} flex items-start gap-3`}>
      <Globe className={`w-4 h-4 mt-0.5 shrink-0 ${style.text}`} />
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-xs font-bold ${style.text}`}>Macro: {regime.regime}</span>
          {signals?.slice(0, 2).map((s, i) => (
            <span key={i} className={`text-[10px] ${SIGNAL_STYLE[s.type] ?? 'text-slate-500'}`}>
              · {s.text}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ── Full panel ─────────────────────────────────────────────────────────── */

const valueOf = (indicators, id) => indicators.find(i => i.id === id)?.value ?? null

/** Plain-language reads computed from the same series the cards show (no model). */
function keyReads(indicators) {
  const ff = valueOf(indicators, 'FEDFUNDS'), cpi = valueOf(indicators, 'CPIAUCSL'), curve = valueOf(indicators, 'T10Y2Y')
  const vix = valueOf(indicators, 'VIXCLS'), hy = valueOf(indicators, 'BAMLH0A0HYM2'), gdp = valueOf(indicators, 'A191RL1Q225SBEA')
  const out = []
  if (ff != null && cpi != null) {
    const real = ff - cpi
    out.push({ label: 'Real policy rate', value: `${real >= 0 ? '+' : ''}${real.toFixed(2)}%`, note: real > 1 ? 'restrictive — Fed funds well above inflation' : real < 0 ? 'below inflation — policy still loose' : 'roughly neutral', tone: real > 1 ? 'amber' : real < 0 ? 'emerald' : 'slate' })
  }
  if (curve != null) out.push({ label: 'Yield curve', value: `${curve >= 0 ? '+' : ''}${curve.toFixed(2)}%`, note: curve < 0 ? 'inverted — a classic recession warning' : curve < 0.5 ? 'flat — growth expectations muted' : 'upward sloping — normal', tone: curve < 0 ? 'red' : curve < 0.5 ? 'amber' : 'emerald' })
  if (gdp != null) out.push({ label: 'Real growth', value: `${gdp.toFixed(1)}%`, note: gdp < 0 ? 'economy shrinking last quarter' : gdp < 1.5 ? 'below-trend growth' : 'at or above trend (~2%)', tone: gdp < 0 ? 'red' : gdp < 1.5 ? 'amber' : 'emerald' })
  if (vix != null) out.push({ label: 'Market fear (VIX)', value: vix.toFixed(1), note: vix > 30 ? 'high — stressed market' : vix > 20 ? 'elevated — nervous market' : 'calm', tone: vix > 30 ? 'red' : vix > 20 ? 'amber' : 'emerald' })
  if (hy != null) out.push({ label: 'Credit stress (HY spread)', value: `${hy.toFixed(2)}%`, note: hy > 6 ? 'wide — credit stress' : hy > 4.5 ? 'widening — watch' : 'tight — credit healthy', tone: hy > 6 ? 'red' : hy > 4.5 ? 'amber' : 'emerald' })
  return out
}

const TONE_TEXT = { red: 'text-red-400', amber: 'text-amber-400', emerald: 'text-emerald-400', slate: 'text-slate-400' }

function SideCard({ icon: Icon, title, children, className = '' }) {
  return (
    <div className={`glass rounded-xl p-4 border border-white/[0.06] ${className}`}>
      <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 mb-2"><Icon className="w-3.5 h-3.5" />{title}</div>
      {children}
    </div>
  )
}

function IndicatorCard({ ind, tag = null }) {
  return (
    <div className="glass rounded-xl p-3 border border-white/[0.06]">
      {tag && <div className="text-[9px] text-slate-600 mb-0.5">{tag}</div>}
      <div className="text-[10px] text-slate-500 mb-1 truncate" title={ind.description}>{ind.label}</div>
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono font-bold text-white text-base" title={ind.error || undefined}>{fmt(ind.value, ind.unit)}</span>
        <span className="text-[10px] text-slate-600">{ind.unit}</span>
      </div>
      <div className="flex items-center justify-between mt-1">
        {ind.delta != null
          ? <Delta delta={ind.delta} unit={ind.unit} />
          : ind.changeLabel ? <span className="text-[9px] text-slate-600">{ind.changeLabel}</span> : <span />}
        <span className="text-[9px] text-slate-700">{ind.error && ind.value == null ? 'unavailable' : ind.date?.slice(0, 7)}</span>
      </div>
    </div>
  )
}

export default function MacroPanel() {
  // The refresh button asks the server to skip its cache too (?refresh=1); otherwise it re-read the same hour-old copy.
  const force = useRef(false)
  const { data, error: queryError, loading, refetch } = useQuery(
    'macro-indicators',
    () => { const url = `/api/macro/indicators${force.current ? '?refresh=1' : ''}`; force.current = false; return fetchJson(url) },
    { staleMs: 10 * 60_000 },
  )
  const load = () => { force.current = true; refetch() }
  const error = queryError?.message ?? null

  if (loading && !data) return (
    <div className="glass rounded-xl p-6 flex items-center gap-3 text-slate-400 text-sm">
      <RefreshCw className="w-4 h-4 animate-spin" /> Loading macro indicators…
    </div>
  )

  if (error && !data) return (
    <div className="glass rounded-xl p-4 border border-amber-500/20 flex items-start gap-3">
      <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
      <div>
        <p className="text-amber-400 text-sm font-medium">Macro data unavailable</p>
        <p className="text-slate-500 text-xs mt-0.5">{error}</p>
        <button onClick={load} className="text-xs text-mint-400 mt-2 hover:underline">Try again</button>
      </div>
    </div>
  )

  if (!data) return null

  const { indicators = [], regime, playbook, fetchedAt, failed = [], warning } = data
  const grouped = {}
  for (const ind of indicators) (grouped[ind.category] ||= []).push(ind)
  // Categories with a single series share one grid, each card tagged with its category — a row per card left gaps.
  const sections = Object.entries(grouped).filter(([, items]) => items.length > 1)
  const singles = Object.entries(grouped).filter(([, items]) => items.length === 1).map(([cat, [ind]]) => ({ cat, ind }))
  const regStyle = REGIME_STYLE[regime?.regimeColor] ?? REGIME_STYLE.slate
  const reads = keyReads(indicators)

  return (
    <div className="grid lg:grid-cols-3 gap-4 items-start">
      {/* ── Right: regime, key reads, playbook, data status (first on phones) ── */}
      <aside className="space-y-3 lg:col-start-3 lg:row-start-1 lg:sticky lg:top-4">
        <div className={`rounded-xl p-4 border ${regStyle.bg} ${regStyle.border}`}>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Globe className={`w-4 h-4 ${regStyle.text}`} />
              <span className={`font-bold text-sm ${regStyle.text}`}>{regime?.regime ?? 'No regime'}</span>
            </div>
            <button onClick={load} title="Fetch fresh data from FRED" className="text-slate-500 hover:text-slate-300 transition-colors">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <div className="mt-2 space-y-1">
            {(regime?.signals ?? []).length
              ? regime.signals.map((s, i) => (
                <div key={i} className={`text-xs flex items-start gap-1.5 ${SIGNAL_STYLE[s.type] ?? 'text-slate-500'}`}>
                  <span>{s.type === 'warning' ? '⚠' : s.type === 'positive' ? '✓' : '·'}</span><span>{s.text}</span>
                </div>
              ))
              : <p className="text-xs text-slate-500">No indicator is past a signal threshold.</p>}
          </div>
          <p className="text-[10px] text-slate-600 mt-2">From fixed thresholds on the series, not a model.</p>
        </div>

        {reads.length > 0 && (
          <SideCard icon={Gauge} title="Key reads">
            <div className="space-y-2">
              {reads.map(r => (
                <div key={r.label} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs text-slate-300">{r.label}</div>
                    <div className="text-[10px] text-slate-500">{r.note}</div>
                  </div>
                  <span className={`font-mono text-sm font-semibold shrink-0 ${TONE_TEXT[r.tone]}`}>{r.value}</span>
                </div>
              ))}
            </div>
          </SideCard>
        )}

        {playbook && (playbook.favor?.length > 0 || playbook.avoid?.length > 0 || playbook.strategyBias) && (
          <SideCard icon={Compass} title="Regime playbook">
            {playbook.favor?.length > 0 && (
              <div className="mb-2">
                <div className="flex items-center gap-1 text-[11px] text-emerald-400 mb-1"><ThumbsUp className="w-3 h-3" /> Favor</div>
                <ul className="space-y-0.5">{playbook.favor.map(f => <li key={f} className="text-xs text-slate-300">· {f}</li>)}</ul>
              </div>
            )}
            {playbook.avoid?.length > 0 && (
              <div className="mb-2">
                <div className="flex items-center gap-1 text-[11px] text-red-400 mb-1"><ThumbsDown className="w-3 h-3" /> Avoid</div>
                <ul className="space-y-0.5">{playbook.avoid.map(f => <li key={f} className="text-xs text-slate-300">· {f}</li>)}</ul>
              </div>
            )}
            {playbook.strategyBias && <p className="text-xs text-slate-400"><span className="text-slate-500">Strategy bias: </span>{playbook.strategyBias}</p>}
            <p className="text-[10px] text-slate-600 mt-2">Rule-written tilts the AI surfaces cite as context — not trade signals.</p>
          </SideCard>
        )}

        <SideCard icon={Database} title="Data">
          <div className="text-[11px] text-slate-500 space-y-1">
            <div>{indicators.length - failed.length} of {indicators.length} series loaded · updated {fetchedAt ? new Date(fetchedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}</div>
            <div>Source: FRED (Federal Reserve Bank of St. Louis){data.via ? ` via ${data.via}` : ''}</div>
            {(warning || failed.length > 0) && (
              <div className="text-amber-300">{warning || `Did not load: ${failed.map(f => `${f.label} (${f.error})`).join('; ')}. Press refresh to try again.`}</div>
            )}
          </div>
        </SideCard>
      </aside>

      {/* ── Left: the series by category ── */}
      <div className="lg:col-span-2 lg:row-start-1 space-y-4">
        {sections.map(([cat, items]) => (
          <section key={cat}>
            <div className="text-xs font-semibold text-slate-500 mb-2">{CATEGORY_LABELS[cat] ?? cat}</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {items.map(ind => <IndicatorCard key={ind.id} ind={ind} />)}
            </div>
          </section>
        ))}
        {singles.length > 0 && (
          <section>
            <div className="text-xs font-semibold text-slate-500 mb-2">🌐 Markets &amp; conditions</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {singles.map(({ cat, ind }) => <IndicatorCard key={ind.id} ind={ind} tag={CATEGORY_LABELS[cat] ?? cat} />)}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
