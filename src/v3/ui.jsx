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
