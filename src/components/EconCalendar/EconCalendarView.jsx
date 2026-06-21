import { useState } from 'react'
import { useQuery, fetchJson } from '../../hooks/useQuery'

const IMP_COLOR = { high: '#ef4444', medium: '#f59e0b', low: '#64748b' }
const IMP_LABEL = { high: 'HIGH', medium: 'MED', low: 'LOW' }

const COUNTRY_FLAG = {
  US: '🇺🇸', EU: '🇪🇺', UK: '🇬🇧', JP: '🇯🇵', CN: '🇨🇳',
  DE: '🇩🇪', CA: '🇨🇦', AU: '🇦🇺', NZ: '🇳🇿', CH: '🇨🇭',
}

function formatDate(dateStr) {
  if (!dateStr) return '—'
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function groupByDate(events) {
  const map = {}
  for (const e of events) {
    const k = e.date || 'Unknown'
    if (!map[k]) map[k] = []
    map[k].push(e)
  }
  return Object.entries(map).sort(([a], [b]) => a.localeCompare(b))
}

function EventRow({ event }) {
  const imp  = event.importance || 'low'
  const flag = COUNTRY_FLAG[event.country] || '🌐'
  const hasActual = event.actual != null
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-white/[0.04] last:border-0">
      <div className="text-lg flex-shrink-0 w-6 text-center">{flag}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className="text-[10px] font-bold px-1.5 py-0.5 rounded"
            style={{ background: IMP_COLOR[imp] + '22', color: IMP_COLOR[imp] }}
          >
            {IMP_LABEL[imp]}
          </span>
          <span className="text-xs text-white font-medium">{event.name}</span>
          {event.country && <span className="text-[10px] text-slate-600">{event.country}</span>}
        </div>
        <div className="flex gap-4 mt-1 text-[10px] font-mono">
          {event.time && <span className="text-slate-500">{event.time}</span>}
          {event.forecast != null && (
            <span className="text-slate-500">Fcst: <span className="text-slate-300">{event.forecast}</span></span>
          )}
          {event.previous != null && (
            <span className="text-slate-500">Prev: <span className="text-slate-400">{event.previous}</span></span>
          )}
          {hasActual && (
            <span className="text-slate-500">Act: <span className="text-emerald-400 font-bold">{event.actual}</span></span>
          )}
        </div>
        {event.affectedAssets?.length > 0 && (
          <div className="flex gap-1 mt-1 flex-wrap">
            {event.affectedAssets.map(a => (
              <span key={a} className="text-[9px] px-1 py-0.5 rounded bg-white/5 text-slate-500 font-mono">{a}</span>
            ))}
          </div>
        )}
      </div>
      {event.impactScore != null && (
        <div className="flex-shrink-0 flex flex-col items-center">
          <div
            className="text-xs font-black"
            style={{ color: event.impactScore >= 70 ? '#ef4444' : event.impactScore >= 40 ? '#f59e0b' : '#64748b' }}
          >
            {event.impactScore}
          </div>
          <div className="text-[9px] text-slate-600">impact</div>
        </div>
      )}
    </div>
  )
}

export default function EconCalendarView() {
  const [filter, setFilter] = useState('all')

  const { data, loading, error } = useQuery(
    'econ-calendar',
    () => fetchJson('/api/calendar/events'),
    { staleMs: 60 * 60_000 }
  )

  const events = (data?.events ?? []).filter(e =>
    filter === 'all' || e.importance === filter
  )

  const grouped = groupByDate(events)
  const highCount = (data?.events ?? []).filter(e => e.importance === 'high').length

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">Economic Calendar</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Next 14 days · {highCount} high-impact events
          </p>
        </div>
        <div className="flex gap-2">
          {['all', 'high', 'medium'].map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold capitalize transition-colors ${filter === f ? 'bg-[#00ffcc] text-black' : 'bg-white/5 text-slate-400 hover:bg-white/10'}`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="glass rounded-xl p-4 animate-pulse">
              <div className="h-3 bg-white/5 rounded w-24 mb-3" />
              <div className="space-y-2">
                {[1, 2].map(j => <div key={j} className="h-8 bg-white/5 rounded" />)}
              </div>
            </div>
          ))}
        </div>
      )}

      {error && !loading && (
        <div className="glass rounded-xl p-6 text-center text-slate-500 text-sm">
          Failed to load calendar — {error}
        </div>
      )}

      {!loading && !error && grouped.length === 0 && (
        <div className="glass rounded-xl p-6 text-center text-slate-500 text-sm">
          No events for the selected filter
        </div>
      )}

      {!loading && !error && grouped.map(([date, evts]) => (
        <div key={date} className="glass rounded-xl p-4 mb-3">
          <div className="text-xs font-semibold text-slate-400 mb-2 pb-2 border-b border-white/[0.06]">
            {formatDate(date)}
          </div>
          {evts.map((e, i) => <EventRow key={i} event={e} />)}
        </div>
      ))}

      {data?.generatedAt && (
        <p className="text-[10px] text-slate-600 mt-3 text-right">
          Updated {new Date(data.generatedAt).toLocaleTimeString()} · {data.cached ? 'cached' : 'live'} · via {data.source}
        </p>
      )}
    </div>
  )
}
