/**
 * Building blocks for v3 pages, in the Dev preview's style: cards with a
 * title / subtitle / action header, status badges, sparklines, bars, and
 * number formatting that always shows the sign.
 */

export function money(v, sym = '$', digits = 2, signed = false) {
  if (v == null || !Number.isFinite(+v)) return '—'
  const n = +v
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  const sign = n < 0 ? '−' : signed ? '+' : ''
  return `${sign}${sym}${abs}`
}

export function pct(v, digits = 1) {
  if (v == null || !Number.isFinite(+v)) return '—'
  const n = +v
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(digits)}%`
}

export const signCls = (v) => (v == null || !Number.isFinite(+v) || +v === 0 ? '' : +v > 0 ? 'v3-up' : 'v3-down')

export function Card({ title, sub, action, className = '', children }) {
  return (
    <section className={`v3-card ${className}`}>
      {(title || action) && (
        <header className="v3-card-h">
          <div>
            {title && <h3>{title}</h3>}
            {sub && <p>{sub}</p>}
          </div>
          {action && <div className="v3-card-a">{action}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

export function Badge({ tone = 'neutral', children }) {
  return <span className={`v3-badge-s ${tone}`}>{children}</span>
}

export function Empty({ icon: Icon, text, action }) {
  return (
    <div className="v3-empty">
      {Icon && <Icon className="w-5 h-5" />}
      <p>{text}</p>
      {action}
    </div>
  )
}

export function Bar({ value, tone = 'up' }) {
  const v = Math.max(0, Math.min(100, value ?? 0))
  return <span className="v3-bar"><i className={tone} style={{ width: `${v}%` }} /></span>
}

export function Spark({ values = [], up = true }) {
  if (values.length < 2) return <div className="v3-spark is-empty" />
  const W = 120, H = 32
  const lo = Math.min(...values), hi = Math.max(...values)
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * W},${H - 2 - ((v - lo) / (hi - lo || 1)) * (H - 4)}`)
  return (
    <svg className={`v3-spark ${up ? 'up' : 'down'}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts.join(' ')} />
    </svg>
  )
}

// Half-circle gauge, 0–100.
export function Gauge({ value, label, tone }) {
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

// Multi-series line chart. series: [{ values: (number|null)[], cls, area? }],
// every series on one index axis; labels: up to 5 x-axis strings.
export function LineChart({ series, labels = [], height = 200, label, fmtY }) {
  const n = Math.max(0, ...series.map(s => s.values.length))
  const vals = series.flatMap(s => s.values).filter(v => v != null && Number.isFinite(v))
  if (n < 2 || !vals.length) return null
  const lo = Math.min(...vals), hi = Math.max(...vals)
  const W = 600, H = height
  const X = i => (i / Math.max(1, n - 1)) * W
  const Y = v => H - 6 - ((v - lo) / (hi - lo || 1)) * (H - 12)
  const path = arr => arr.map((v, i) => v == null ? null : `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).filter(Boolean).join(' ')
  return (
    <div className="v3-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label={label}>
        {[0.25, 0.5, 0.75].map(f => <line key={f} className="v3-grid-line" x1="0" x2={W} y1={H * f} y2={H * f} />)}
        {series.filter(s => s.area).map((s, k) => {
          const pts = s.values.map((v, i) => v == null ? null : [X(i), Y(v)]).filter(Boolean)
          return pts.length > 1 ? <polygon key={`a${k}`} className="v3-area" points={`${pts[0][0]},${H} ${pts.map(p => p.join(',')).join(' ')} ${pts.at(-1)[0]},${H}`} /> : null
        })}
        {series.map((s, k) => <polyline key={k} className={s.cls || 'v3-line-main'} points={path(s.values)} />)}
      </svg>
      {fmtY && <div className="v3-chart-y"><span>{fmtY(hi)}</span><span>{fmtY(lo)}</span></div>}
      {labels.length > 0 && <div className="v3-chart-x">{labels.map((l, i) => <span key={i}>{l}</span>)}</div>}
    </div>
  )
}
