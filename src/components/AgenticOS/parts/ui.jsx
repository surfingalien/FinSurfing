/**
 * Small building blocks for Agentic OS. Colour comes only from the utility
 * classes the theme layer already translates (see index.css), never hex, so the
 * page is right in light, dark and pro mode without knowing which is on.
 *
 * Status is never colour alone: every dot sits beside a word.
 */
import { Info } from 'lucide-react'

export const TONE = {
  ok:      'text-emerald-400 bg-emerald-500/10 border-emerald-500/25',
  live:    'text-mint-400 bg-mint-500/10 border-mint-500/30',
  warn:    'text-amber-300 bg-amber-500/10 border-amber-500/25',
  bad:     'text-red-400 bg-red-500/10 border-red-500/25',
  neutral: 'text-slate-300 bg-slate-500/10 border-slate-500/25',
  muted:   'text-slate-500 bg-slate-500/5 border-slate-500/15',
}
const DOT = { ok: 'bg-emerald-400', live: 'bg-mint-400 animate-pulse', warn: 'bg-amber-400', bad: 'bg-red-400', neutral: 'bg-slate-400', muted: 'bg-slate-600' }

/** The six states an agent can be in (lib/agentic-overview.js:agentState) → wording + tone. */
export const AGENT_STATE = {
  healthy: { label: 'Healthy', tone: 'ok' },
  running: { label: 'Running', tone: 'live' },
  waiting: { label: 'Waiting', tone: 'neutral' },
  failing: { label: 'Failing', tone: 'bad' },
  paused:  { label: 'Paused',  tone: 'warn' },
  off:     { label: 'Off',     tone: 'muted' },
}
export const JOB_STATE = {
  done:    { label: 'OK',          tone: 'ok' },
  running: { label: 'Running',     tone: 'live' },
  failed:  { label: 'Failed',      tone: 'bad' },
  idle:    { label: 'Not run yet', tone: 'neutral' },
}
export const LEVEL_TONE = { critical: 'bad', warn: 'warn', info: 'neutral' }

export const Dot = ({ tone = 'neutral', className = '' }) => <span aria-hidden="true" className={`inline-block w-2 h-2 rounded-full shrink-0 ${DOT[tone] || DOT.neutral} ${className}`} />

export function Chip({ tone = 'neutral', dot = true, children, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full border whitespace-nowrap ${TONE[tone] || TONE.neutral} ${className}`}>
      {dot && <Dot tone={tone} className="!w-1.5 !h-1.5" />}{children}
    </span>
  )
}

/** A titled card. `action` sits top-right; `sub` is the one-line "what is this". */
export function Section({ title, sub, action, children, className = '', id }) {
  return (
    <section id={id} className={`glass rounded-2xl p-4 ${className}`} aria-labelledby={id ? `${id}-h` : undefined}>
      {(title || action) && (
        <header className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            {title && <h2 id={id ? `${id}-h` : undefined} className="text-sm font-semibold text-white">{title}</h2>}
            {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

export function Empty({ icon: Icon, children }) {
  return (
    <div className="flex flex-col items-center text-center gap-2 py-6 text-xs text-slate-500">
      {Icon && <Icon className="w-5 h-5 text-slate-500" aria-hidden="true" />}
      <p className="max-w-sm">{children}</p>
    </div>
  )
}

export const Note = ({ children }) => (
  <div className="flex items-start gap-2 text-[11px] rounded-xl px-3 py-2 border text-slate-400 bg-slate-500/10 border-slate-500/20">
    <Info className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" /><span>{children}</span>
  </div>
)

export const btn = 'inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-slate-500/25 text-slate-200 hover:text-white hover:bg-slate-500/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint-500/40'
export const btnQuiet = 'inline-flex items-center gap-1 text-xs text-mint-400 hover:text-mint-300 focus-visible:outline-none focus-visible:underline'

// ── formatting ───────────────────────────────────────────────────────────────
export function relTime(iso, now = Date.now()) {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return null
  const s = Math.round((now - t) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 172800) return 'yesterday'
  if (s < 604800) return `${Math.round(s / 86400)}d ago`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
export const exact = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
export const usd = (v, dp = 2) => (v == null || !Number.isFinite(+v) ? '—' : `$${(+v).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`)
export const dur = (ms) => (ms == null ? '—' : ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s` : `${Math.round(ms / 60_000)}m`)
