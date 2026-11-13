/**
 * ScanChanges — what changed against the previous scan of the same list
 * (GET /api/ai-brain/scan/changes, lib/scan-diff.js). No model is called.
 *
 * A discovery scan looks at a new list each time, so a name that is gone was
 * usually not looked at again. Each dropped name therefore carries its reason,
 * and only "analysed again and left out" is presented as a change of view.
 */
import { useState } from 'react'
import { ChevronDown, GitCompareArrows } from 'lucide-react'
import { useQuery, fetchJson } from '../../../hooks/useQuery'
import { useAuth } from '../../../contexts/AuthContext'

function ago(iso) {
  const h = (Date.now() - new Date(iso).getTime()) / 3600000
  if (!(h >= 0)) return ''
  if (h < 1) return 'under an hour earlier'
  if (h < 36) return `${Math.round(h)} hour${Math.round(h) === 1 ? '' : 's'} earlier`
  return `${Math.round(h / 24)} days earlier`
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
const score = v => (v == null ? '—' : Math.round(v))

function Sym({ symbol, onOpen }) {
  if (!onOpen) return <span className="font-semibold text-white">{symbol}</span>
  return <button type="button" onClick={() => onOpen(symbol)} title={`Analyze ${symbol}`} className="font-semibold text-white hover:text-mint-400">{symbol}</button>
}

function Group({ title, note, children }) {
  return (
    <div>
      <h4 className="text-[11px] font-semibold text-slate-300">{title}{note && <span className="font-normal text-slate-500"> · {note}</span>}</h4>
      <ul className="mt-1 space-y-0.5 text-xs text-slate-400">{children}</ul>
    </div>
  )
}

export default function ScanChanges({ processedAt, onOpen }) {
  const { authFetch, user } = useAuth()
  const [open, setOpen] = useState(false)
  const { data } = useQuery(
    `ai-brain-scan-changes:${user?.id ?? user?.userId ?? ''}:${processedAt}`,
    () => fetchJson(`/api/ai-brain/scan/changes?at=${encodeURIComponent(processedAt)}`, undefined, authFetch),
    { staleMs: 10 * 60_000, enabled: !!processedAt },
  )
  if (!data) return null
  if (!data.available) {
    if (data.reason !== 'no-earlier-scan') return null
    return <p className="text-[11px] text-slate-500 px-1">No earlier scan of this list is stored, so there is nothing to compare with yet. The next scan of the same list and horizon will show what changed.</p>
  }

  const views = data.dropped.filter(d => d.reason === 'not-picked')
  const rotated = data.dropped.filter(d => d.reason !== 'not-picked')
  const parts = [
    data.changed.length && plural(data.changed.length, 'verdict changed', 'verdicts changed'),
    data.rescored.length && plural(data.rescored.length, 'score moved', 'scores moved'),
    data.added.length && `${data.added.length} new`,
    views.length && `${views.length} analysed again and left out`,
    rotated.length && `${rotated.length} not looked at this time`,
  ].filter(Boolean)
  const flipped = data.changed.some(c => c.severity === 'high')

  return (
    <div className={`glass rounded-xl border ${flipped ? 'border-amber-500/30' : 'border-white/[0.06]'}`}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="w-full flex items-start gap-3 p-3 text-left">
        <GitCompareArrows className={`w-4 h-4 mt-0.5 shrink-0 ${flipped ? 'text-amber-400' : 'text-indigo-400'}`} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold text-white">
            Since your previous scan of this list <span className="font-normal text-slate-500">· {ago(data.prevAt)}</span>
          </span>
          <span className="block text-[12px] text-slate-400 mt-0.5">
            {data.nothingChanged ? `Nothing changed — the same ${plural(data.unchanged, 'pick', 'picks')}, same verdicts.` : `${parts.join(' · ')}${data.unchanged ? ` · ${data.unchanged} unchanged` : ''}`}
          </span>
        </span>
        {!data.nothingChanged && <ChevronDown className={`w-4 h-4 text-slate-500 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />}
      </button>

      {open && !data.nothingChanged && (
        <div className="px-3 pb-3 pl-10 grid gap-3 sm:grid-cols-2">
          {data.changed.length > 0 && (
            <Group title="Verdict changed" note="picked in both scans">
              {data.changed.map(c => (
                <li key={c.symbol}>
                  <Sym symbol={c.symbol} onOpen={onOpen} /> {c.from} → <span className={c.severity === 'high' ? 'text-amber-300 font-medium' : 'text-slate-200'}>{c.to}</span>
                  <span className="text-slate-500"> · score {score(c.scoreFrom)} → {score(c.scoreTo)}</span>
                </li>
              ))}
            </Group>
          )}
          {data.rescored.length > 0 && (
            <Group title="Score moved" note={`same verdict, ${data.scoreMove}+ points`}>
              {data.rescored.map(r => (
                <li key={r.symbol}><Sym symbol={r.symbol} onOpen={onOpen} /> {score(r.scoreFrom)} → <span className="text-slate-200">{score(r.scoreTo)}</span> <span className="text-slate-500">({r.move > 0 ? '+' : '−'}{Math.abs(Math.round(r.move))})</span></li>
              ))}
            </Group>
          )}
          {data.added.length > 0 && (
            <Group title="New this scan">
              {data.added.map(a => (
                <li key={a.symbol}><Sym symbol={a.symbol} onOpen={onOpen} /> {a.verdict || '—'} <span className="text-slate-500">· score {score(a.score)} · {a.seenBefore ? 'analysed last time, not picked then' : 'not in the previous list'}</span></li>
              ))}
            </Group>
          )}
          {views.length > 0 && (
            <Group title="Analysed again and left out" note="a change of view">
              {views.map(d => (
                <li key={d.symbol}><Sym symbol={d.symbol} onOpen={onOpen} /> <span className="text-slate-500">was {d.verdict || 'picked'}, score {score(d.score)}</span></li>
              ))}
            </Group>
          )}
          {rotated.length > 0 && (
            <Group title="Not looked at this time" note="not a change of view">
              <li className="text-slate-500">
                {rotated.map((d, i) => <span key={d.symbol}>{i > 0 && ', '}<Sym symbol={d.symbol} onOpen={onOpen} />{d.reason === 'unpriced' ? ' (no price)' : ''}</span>)}
                . Each scan builds a new list, so these were not analysed again.
              </li>
            </Group>
          )}
          {data.regime && (
            <p className="text-[11px] text-slate-500 sm:col-span-2">The scan's market regime wording went from “{data.regime.from}” to “{data.regime.to}”.</p>
          )}
          <p className="text-[11px] text-slate-500 sm:col-span-2">
            Compared with the stored result of {new Date(data.prevAt).toLocaleString()}; nothing is re-run. A score is the model's own number and moves between runs, so read a score move as weaker evidence than a verdict change.
          </p>
        </div>
      )}
    </div>
  )
}
