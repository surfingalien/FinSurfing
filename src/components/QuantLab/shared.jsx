/**
 * Shared pieces for the Quant Lab: one declarative RunPanel (fields → POST → result), a recursive
 * result viewer, and small chart helpers. Every tool is a field list plus a render function.
 *
 * Heartbeated endpoints answer 200 even on failure — check `data.error` as well as `res.ok`.
 */
import { useState, useCallback } from 'react'
import { Loader2, Play, Lock, Info } from 'lucide-react'
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ScatterChart, Scatter, ReferenceLine, Legend,
} from 'recharts'
import { useAuth } from '../../contexts/AuthContext'

export const fmt = (v, dp = 4) => {
  if (v == null) return '—'
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (typeof v !== 'number') return String(v)
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  return a !== 0 && (a < 0.0001 || a >= 1e9) ? v.toExponential(2) : v.toLocaleString(undefined, { maximumFractionDigits: a >= 1000 ? 1 : dp })
}
export const pct = (v, dp = 1) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(dp)}%`)
const label = k => k.replace(/([A-Z])/g, ' $1').replace(/[-_]/g, ' ').replace(/^./, c => c.toUpperCase())
const PCT_EXACT = new Set(['annualisedSpread', 'impliedSpread', 'marketSpread', 'spreadGap', 'annualisedBasis', 'rollYield', 'annualCarry', 'breakevenAdverseMove', 'conversionPremiumPct', 'investmentPremiumPct'])
const isPctKey = k => PCT_EXACT.has(k) || (/(vol|return|rate|yield|share|probability|prob|drawdown|capture|alpha|weight|shrink|accuracy|winRate|explained|cumulative|exposure|tracking|vrp|implied|realized|cagr|turnover|costDrag|averageVar|edgeVs|Pct$)/i.test(k) && !/(logLoss|brier|ratio|stat|hurst|beta|r2|sharpe|lags|days|halfLife|vega|rho|upside|vrpVariance|rebalances)/i.test(k))

export function Card({ title, children, className = '' }) {
  return (
    <div className={`glass rounded-2xl p-4 ${className}`}>
      {title && <h3 className="text-sm font-semibold text-white mb-3">{title}</h3>}
      {children}
    </div>
  )
}
export const Note = ({ children, tone = 'info' }) => (
  <div className={`flex items-start gap-2 text-[11px] rounded-xl px-3 py-2 border ${tone === 'warn' ? 'text-amber-300 bg-amber-500/10 border-amber-500/25' : 'text-slate-400 bg-slate-500/10 border-slate-500/20'}`}>
    <Info className="w-3.5 h-3.5 shrink-0 mt-px" /><span>{children}</span>
  </div>
)
export const Stat = ({ label: l, value, sub }) => (
  <div className="rounded-xl bg-slate-500/10 border border-slate-500/15 px-3 py-2">
    <div className="text-[10px] text-slate-500 uppercase tracking-wide">{l}</div>
    <div className="text-base font-semibold text-white tabular-nums">{value}</div>
    {sub && <div className="text-[10px] text-slate-500">{sub}</div>}
  </div>
)

/** Recursive viewer: objects → key/value, arrays of objects → table, arrays of numbers → inline, notes highlighted. */
export function ResultView({ data, depth = 0, hide = [] }) {
  if (data == null) return <span className="text-slate-500">—</span>
  if (Array.isArray(data)) {
    if (!data.length) return <span className="text-slate-500">none</span>
    if (typeof data[0] !== 'object') return <span className="text-slate-300 tabular-nums break-words">{data.slice(0, 30).map(v => fmt(v)).join(', ')}{data.length > 30 ? ` … (${data.length})` : ''}</span>
    const cols = [...new Set(data.slice(0, 40).flatMap(r => Object.keys(r)))].filter(c => typeof data[0][c] !== 'object' && !hide.includes(c))
    return (
      <div className="overflow-x-auto">
        <table className="text-[11px] w-full">
          <thead><tr>{cols.map(c => <th key={c} className="text-left font-medium text-slate-500 pr-3 pb-1 whitespace-nowrap">{label(c)}</th>)}</tr></thead>
          <tbody>{data.slice(0, 60).map((r, i) => (
            <tr key={i} className="border-t border-slate-500/10">{cols.map(c => <td key={c} className="pr-3 py-1 text-slate-300 tabular-nums whitespace-nowrap">{typeof r[c] === 'number' && isPctKey(c) && Math.abs(r[c]) < 5 ? pct(r[c]) : fmt(r[c], 3)}</td>)}</tr>
          ))}</tbody>
        </table>
        {data.length > 60 && <div className="text-[10px] text-slate-500 mt-1">showing 60 of {data.length}</div>}
      </div>
    )
  }
  if (typeof data === 'object') {
    const entries = Object.entries(data).filter(([k]) => !hide.includes(k))
    return (
      <dl className={`space-y-1.5 ${depth ? 'pl-3 border-l border-slate-500/20' : ''}`}>
        {entries.map(([k, v]) => {
          if (k === 'note' || k === 'warning' || k === 'verdict' || k === 'read') return <Note key={k} tone={k === 'warning' ? 'warn' : 'info'}>{String(v)}</Note>
          const nested = v && typeof v === 'object'
          return (
            <div key={k} className={nested ? '' : 'flex justify-between gap-4 text-[12px]'}>
              <dt className={`text-slate-500 ${nested ? 'text-[11px] font-medium mb-1' : ''}`}>{label(k)}</dt>
              <dd className={nested ? '' : 'text-slate-200 tabular-nums text-right break-words'}>
                {nested ? <ResultView data={v} depth={depth + 1} hide={hide} /> : typeof v === 'number' && isPctKey(k) && Math.abs(v) < 5 ? <>{pct(v, 2)} <span className="text-slate-600">({fmt(v)})</span></> : fmt(v)}
              </dd>
            </div>
          )
        })}
      </dl>
    )
  }
  return <span className="text-slate-200">{fmt(data)}</span>
}

export function MiniLine({ data, xKey = 'x', lines, height = 200, yFmt, refY }) {
  const colors = ['#00ffcc', '#6366f1', '#f59e0b', '#ef4444']
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="rgba(148,163,184,0.15)" vertical={false} />
          <XAxis dataKey={xKey} tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} minTickGap={30} />
          <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} width={46} tickFormatter={yFmt} domain={['auto', 'auto']} />
          <Tooltip contentStyle={{ background: '#0b1020', border: '1px solid rgba(148,163,184,.25)', fontSize: 11 }} formatter={(v) => (yFmt ? yFmt(v) : fmt(v))} />
          {lines.length > 1 && <Legend wrapperStyle={{ fontSize: 10 }} />}
          {refY != null && <ReferenceLine y={refY} stroke="rgba(148,163,184,.5)" strokeDasharray="4 4" />}
          {lines.map((l, i) => <Line key={l.key} type="monotone" dataKey={l.key} name={l.name || l.key} stroke={l.color || colors[i % colors.length]} dot={false} strokeWidth={1.8} isAnimationActive={false} />)}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
export function MiniScatter({ data, height = 240, xName = 'Volatility', yName = 'Return', extra = [] }) {
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer>
        <ScatterChart margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="rgba(148,163,184,0.15)" />
          <XAxis type="number" dataKey="x" name={xName} tick={{ fontSize: 10, fill: '#94a3b8' }} tickFormatter={v => pct(v, 0)} domain={['auto', 'auto']} />
          <YAxis type="number" dataKey="y" name={yName} tick={{ fontSize: 10, fill: '#94a3b8' }} tickFormatter={v => pct(v, 0)} width={44} domain={['auto', 'auto']} />
          <Tooltip contentStyle={{ background: '#0b1020', border: '1px solid rgba(148,163,184,.25)', fontSize: 11 }} formatter={v => pct(v, 2)} />
          <Scatter data={data} fill="#00ffcc" line={{ stroke: '#00ffcc', strokeWidth: 1.5 }} isAnimationActive={false} />
          {extra.map((e, i) => <Scatter key={i} data={[e.point]} fill={e.color} name={e.name} shape="diamond" isAnimationActive={false} />)}
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  )
}

const inputCls = 'w-full px-3 py-2 rounded-xl bg-slate-500/10 border border-slate-500/20 text-sm text-white focus:outline-none focus:border-mint-400/60'

function Field({ f, value, onChange }) {
  const common = { id: f.name, value: value ?? '', onChange: e => onChange(f.type === 'checkbox' ? e.target.checked : e.target.value), className: inputCls }
  return (
    <label htmlFor={f.name} className={`block ${f.wide ? 'sm:col-span-2 lg:col-span-3' : ''}`}>
      <span className="text-[11px] text-slate-500 block mb-1">{f.label}{f.hint && <span className="text-slate-600"> · {f.hint}</span>}</span>
      {f.type === 'select' ? <select {...common}>{f.options.map(o => <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>)}</select>
        : f.type === 'checkbox' ? <input id={f.name} type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} className="w-4 h-4" />
        : f.type === 'textarea' ? <textarea {...common} rows={f.rows || 4} className={`${inputCls} font-mono text-xs`} />
        : <input {...common} type={f.type === 'number' ? 'number' : 'text'} step="any" />}
    </label>
  )
}

/**
 * Props: title, blurb, endpoint ('/api/quant/…'), needsAuth, fields[{name,label,type,default,hint,options}],
 * toBody(values) optional, render(data, values) → JSX, autoRun.
 */
export function RunPanel({ title, blurb, endpoint, needsAuth = false, fields, toBody, render, runLabel = 'Run' }) {
  const { authFetch, isAuthenticated } = useAuth()
  const [values, setValues] = useState(() => Object.fromEntries(fields.map(f => [f.name, f.default ?? (f.type === 'checkbox' ? false : '')])))
  const [state, setState] = useState({ loading: false, error: null, data: null, ran: null })
  const locked = needsAuth && !isAuthenticated

  const run = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }))
    try {
      const body = toBody ? toBody(values) : Object.fromEntries(fields.map(f => {
        const v = values[f.name]
        if (f.type === 'number') return [f.name, v === '' ? undefined : Number(v)]
        if (f.type === 'symbols') return [f.name, String(v).split(/[\s,]+/).filter(Boolean).map(s => s.toUpperCase())]
        if (f.type === 'json') return [f.name, JSON.parse(v)]
        if (f.type === 'checkbox') return [f.name, !!v]
        return [f.name, f.type === 'symbol' ? String(v).trim().toUpperCase() : v]
      }))
      const doFetch = needsAuth ? authFetch : fetch
      const res = await doFetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const text = await res.text()
      let data; try { data = JSON.parse(text) } catch { throw new Error(res.ok ? 'The server answered with something that is not JSON' : `Request failed (HTTP ${res.status})`) }
      if (!res.ok || data.error) throw new Error(data.error || `Request failed (HTTP ${res.status})`)
      setState({ loading: false, error: null, data, ran: { ...values } })
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: e.message === 'Load failed' ? 'The connection dropped before the result arrived — try again.' : e.message }))
    }
  }, [values, fields, toBody, endpoint, needsAuth, authFetch])

  return (
    <div className="space-y-4">
      <Card title={title}>
        {blurb && <p className="text-xs text-slate-400 mb-3">{blurb}</p>}
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {fields.map(f => <Field key={f.name} f={f} value={values[f.name]} onChange={v => setValues(s => ({ ...s, [f.name]: v }))} />)}
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button onClick={run} disabled={state.loading || locked} className="btn-primary inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-50">
            {state.loading ? <Loader2 className="w-4 h-4 animate-spin" /> : locked ? <Lock className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            {state.loading ? 'Working…' : locked ? 'Sign in to run' : runLabel}
          </button>
          {needsAuth && <span className="text-[11px] text-slate-500">uses live market data{locked ? ' — sign-in required' : ''}</span>}
        </div>
      </Card>
      {state.error && <div className="text-sm text-red-300 bg-red-500/10 border border-red-500/25 rounded-xl px-4 py-3" role="alert">{state.error}</div>}
      {state.data && <div className="space-y-4">{render(state.data, state.ran)}</div>}
    </div>
  )
}
