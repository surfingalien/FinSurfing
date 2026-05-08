import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { fmt, fmtPct, fmtLarge } from '../../services/api'

export function ChangeBadge({ pct, size = 'sm' }) {
  const up = (pct || 0) >= 0
  const zero = pct === null || pct === undefined
  if (zero) return <span className="badge-neutral">—</span>
  return (
    <span className={up ? 'badge-up' : 'badge-down'}>
      {up ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
      {fmtPct(pct)}
    </span>
  )
}

export function MiniQuoteCard({ quote, onClick }) {
  const up = (quote?.changePct || 0) >= 0
  return (
    <button
      onClick={onClick}
      className="glass-card flex items-center justify-between gap-4 w-full text-left hover:border-mint-500/20 transition-all"
    >
      <div className="min-w-0">
        <div className="font-semibold text-white text-sm font-mono">{quote.symbol}</div>
        <div className="text-xs text-slate-500 truncate">{quote.name || quote.symbol}</div>
      </div>
      <div className="text-right shrink-0">
        <div className="font-mono font-semibold text-white text-sm">${fmt(quote.price)}</div>
        <ChangeBadge pct={quote.changePct} />
      </div>
    </button>
  )
}

export function StatRow({ label, value, mono = false }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-white/[0.04] last:border-0">
      <span className="text-xs text-slate-500">{label}</span>
      <span className={`text-xs text-white ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  )
}

export function SectionCard({ title, children, className = '', action }) {
  return (
    <div className={`glass rounded-xl ${className}`}>
      {title && (
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          {action}
        </div>
      )}
      <div className="px-4 pb-4">{children}</div>
    </div>
  )
}

export function LoadingPulse({ rows = 3 }) {
  return (
    <div className="space-y-2 animate-pulse">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-12 bg-white/[0.03] rounded-lg" style={{ opacity: 1 - i * 0.2 }} />
      ))}
    </div>
  )
}

export function EmptyState({ icon, title, subtitle }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center gap-2">
      <div className="text-3xl mb-2">{icon}</div>
      <div className="text-sm font-medium text-white">{title}</div>
      {subtitle && <div className="text-xs text-slate-500">{subtitle}</div>}
    </div>
  )
}
