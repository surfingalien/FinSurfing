/**
 * Data flow — how information gets from a provider to a screen, in four columns:
 * sources → API & logic → caches → screens.
 *
 * Select any box and the whole chain that feeds it (everything upstream) and
 * everything it feeds (downstream) lights up; the rest dims. That is the point of
 * the page: "if Finnhub is down, which screens are affected?" and "where does the
 * AI Brain's input come from?" are one click, not a diagram to decode.
 *
 * Source status is CONFIGURATION (key set / not set / no key needed), the same
 * wording as the Connections tab.
 */
import { useMemo, useState } from 'react'
import { Loader2, MousePointerClick } from 'lucide-react'
import { useAuth } from '../../../contexts/AuthContext'
import { useQuery, fetchJson } from '../../../hooks/useQuery'
import { Section, Dot, Note, Empty } from './ui'

const TIERS = [
  { id: 0, label: 'Sources', sub: 'Providers the app calls' },
  { id: 1, label: 'API & logic', sub: 'Server routes and shared maths' },
  { id: 2, label: 'Caches & storage', sub: 'What is remembered' },
  { id: 3, label: 'Screens', sub: 'Where it shows up' },
]
const CATEGORY = { market: 'Market data', crypto: 'Crypto', ai: 'AI models', macro: 'Macro', alt: 'Alternative data', db: 'Database' }
const SRC = { set: { tone: 'ok', text: 'Key set' }, keyless: { tone: 'neutral', text: 'No key needed' }, missing: { tone: 'muted', text: 'No key set' } }

/** Every node reachable from `id` following edges forward (down) or backward (up). */
function reach(id, edges, dir) {
  const [from, to] = dir === 'down' ? ['source', 'target'] : ['target', 'source']
  const seen = new Set([id])
  const queue = [id]
  while (queue.length) {
    const cur = queue.shift()
    for (const e of edges) if (e[from] === cur && !seen.has(e[to])) { seen.add(e[to]); queue.push(e[to]) }
  }
  seen.delete(id)
  return seen
}

export default function DataFlowTab() {
  const { authFetch, user } = useAuth()
  const { data, error, loading } = useQuery(`agentic-os:flow:${user?.id || 'me'}`, () => fetchJson('/api/agentic-os/data-flow', undefined, authFetch), { staleMs: 60_000 })
  const [sel, setSel] = useState(null)

  const model = useMemo(() => {
    if (!data) return null
    const byId = new Map(data.nodes.map(n => [n.id, n]))
    const up = sel ? reach(sel, data.edges, 'up') : null
    const down = sel ? reach(sel, data.edges, 'down') : null
    return { byId, up, down }
  }, [data, sel])

  if (loading) return <div className="flex items-center gap-2 text-xs text-slate-500 p-4"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />Loading the data flow…</div>
  if (error || !data) return <Note>Could not load the data flow: {error?.message || 'no data'}.</Note>

  const { byId, up, down } = model
  const lit = (id) => !sel || id === sel || up.has(id) || down.has(id)
  const inEdges = sel ? data.edges.filter(e => e.target === sel) : []
  const outEdges = sel ? data.edges.filter(e => e.source === sel) : []
  const selected = sel ? byId.get(sel) : null

  // A render helper, not a component: a component defined here would remount every box on each
  // selection and drop keyboard focus.
  const box = (n) => {
    const on = sel === n.id
    const dim = !lit(n.id)
    const src = n.tier === 0 ? SRC[n.status] : null
    return (
      <li key={n.id}>
        <button type="button" onClick={() => setSel(on ? null : n.id)} aria-pressed={on}
          className={`w-full text-left rounded-lg border px-2.5 py-1.5 text-xs transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint-500/40 ${
            on ? 'border-mint-500/50 bg-mint-500/10 text-white' : dim ? 'border-slate-500/10 text-slate-600 opacity-50' : 'border-slate-500/20 bg-slate-500/[0.05] text-slate-200 hover:border-slate-500/40'
          }`}>
          <span className="flex items-center gap-1.5">
            {src && <Dot tone={src.tone} className="!w-1.5 !h-1.5" />}
            <span className="truncate">{n.label}</span>
          </span>
        </button>
      </li>
    )
  }

  return (
    <div className="space-y-3">
      <Note>Select a box to light up everything that feeds it and everything it feeds. A source’s dot shows whether its key is configured — not whether the provider is answering.</Note>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500 px-1" aria-label="Legend">
        {Object.values(SRC).map(s => <li key={s.text} className="inline-flex items-center gap-1.5"><Dot tone={s.tone} className="!w-1.5 !h-1.5" />{s.text}</li>)}
      </ul>
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 content-start">
          {TIERS.map(t => {
            const nodes = data.nodes.filter(n => n.tier === t.id)
            const groups = t.id === 0 ? [...new Set(nodes.map(n => n.category))] : [null]
            return (
              <section key={t.id} className="min-w-0" aria-label={t.label}>
                <header className="mb-2 px-0.5">
                  <h3 className="text-xs font-semibold text-white">{t.label}</h3>
                  <p className="text-[11px] text-slate-500">{t.sub}</p>
                </header>
                <div className="space-y-2.5">
                  {groups.map(g => (
                    <div key={g || 'all'}>
                      {g && <div className="text-[10px] uppercase tracking-wide text-slate-600 mb-1 px-0.5">{CATEGORY[g] || g}</div>}
                      <ul className="space-y-1">{nodes.filter(n => g == null || n.category === g).map(box)}</ul>
                    </div>
                  ))}
                </div>
              </section>
            )
          })}
        </div>

        <aside aria-live="polite" className="lg:sticky lg:top-2 self-start">
          <Section title={selected ? selected.label : 'Details'}>
            {!selected ? (
              <Empty icon={MousePointerClick}>Select a box to see what flows in and out of it.</Empty>
            ) : (
              <div className="space-y-3 text-xs">
                {selected.description && <p className="text-slate-400">{selected.description}</p>}
                {selected.tier === 0 && <p className="text-slate-400">{SRC[selected.status]?.text}{selected.transport ? ` · ${selected.transport}` : ''}{selected.dataTypes?.length ? ` · ${selected.dataTypes.join(', ')}` : ''}</p>}
                <Flow title="Receives from" edges={inEdges} pick="source" byId={byId} onPick={setSel} />
                <Flow title="Sends to" edges={outEdges} pick="target" byId={byId} onPick={setSel} />
                <p className="text-[11px] text-slate-500">{up.size} upstream · {down.size} downstream, counting every step.</p>
              </div>
            )}
          </Section>
        </aside>
      </div>
    </div>
  )
}

function Flow({ title, edges, pick, byId, onPick }) {
  return (
    <div>
      <div className="text-[11px] font-medium text-slate-500 mb-1">{title}</div>
      {!edges.length ? <p className="text-slate-600">Nothing — this is an end of the chain.</p> : (
        <ul className="space-y-1">
          {edges.map((e, i) => (
            <li key={i}>
              <button type="button" onClick={() => onPick(e[pick])} className="w-full flex items-baseline justify-between gap-2 text-left hover:text-white text-slate-300 focus-visible:outline-none focus-visible:underline">
                <span className="truncate">{byId.get(e[pick])?.label || e[pick]}</span>
                <span className="text-[11px] text-slate-500 shrink-0">{e.dataType}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
