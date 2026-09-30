import { CheckCircle2, AlertTriangle, XCircle, RefreshCw } from 'lucide-react'

const TONE = {
  ok:   { icon: CheckCircle2,  cls: 'text-emerald-400', label: 'Working' },
  warn: { icon: AlertTriangle, cls: 'text-amber-400',   label: 'Working, with gaps' },
  fail: { icon: XCircle,       cls: 'text-red-400',     label: 'Something is broken' },
}

/**
 * "Is it working?" — each part of the research pipeline checked live on the
 * server (routes/research-desk.js /system-status, lib/system-status.js), with
 * the reason and the fix when it is not.
 */
export default function SystemStatus({ data, onRefresh, busy }) {
  if (!data) return null
  const overall = TONE[data.overall] || TONE.warn
  const Overall = overall.icon
  return (
    <div className="space-y-3">
      <div className="glass rounded-2xl p-4 flex items-center gap-3">
        <Overall className={`w-6 h-6 ${overall.cls}`} />
        <div>
          <div className="font-semibold">{overall.label}</div>
          <div className="text-[11px] text-slate-500">Checked {new Date(data.checkedAt).toLocaleString()}</div>
        </div>
        <button onClick={onRefresh} disabled={busy} className="ml-auto btn-ghost text-sm flex items-center gap-1.5 disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} /> Re-check
        </button>
      </div>
      <div className="space-y-1.5">
        {data.checks.map(c => {
          const t = TONE[c.status] || TONE.warn
          const Icon = t.icon
          return (
            <div key={c.id} className="glass rounded-xl p-3 flex items-start gap-2.5">
              <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${t.cls}`} />
              <div className="min-w-0">
                <div className="text-sm font-medium">{c.label}</div>
                <div className="text-[12px] text-slate-400">{c.detail}</div>
                {c.fix && <div className="text-[11px] text-amber-400 mt-0.5">Fix: {c.fix}</div>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
