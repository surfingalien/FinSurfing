/**
 * RunHistory — what changed since the previous run, and the earlier runs
 * themselves (GET /api/recommendations/journal, lib/rec-journal.js).
 *
 * The server has stored every run and its diff since the journal was added;
 * this is the page that shows them. A run is compared only with the previous
 * run of the same persona and focus list. A reworded thesis or a moved entry
 * price is not listed as a change — only added, dropped, and picks whose
 * target or stop percent moved.
 *
 * Opening an earlier run prices its picks now and shows each against the
 * run's own entry price. That is a plain price change, not a scored outcome:
 * no stop or target is applied and nothing is compared with the market.
 */
import { useState } from 'react'
import { ChevronDown, History, Loader2 } from 'lucide-react'
import { useQuery, fetchJson } from '../../../hooks/useQuery'
import { useAuth } from '../../../contexts/AuthContext'
import { getApiKeyHeaders } from '../../../services/api'

const day = iso => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
const dayTime = iso => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const pct = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%`
const money = v => `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: v < 10 ? 4 : 2 })}`

function summary(c) {
  if (!c) return null
  const parts = [
    c.added.length && `${c.added.length} new`,
    c.removed.length && `${c.removed.length} dropped`,
    c.moved.length && `${c.moved.length} target or stop moved`,
  ].filter(Boolean)
  if (!parts.length) return `same ${c.kept} ${c.kept === 1 ? 'pick' : 'picks'}, same targets and stops`
  return `${parts.join(' · ')}${c.unchanged > 0 ? ` · ${c.unchanged} unchanged` : ''}`
}

function Sym({ symbol, onOpen }) {
  if (!onOpen) return <span className="font-semibold text-white">{symbol}</span>
  return <button type="button" onClick={() => onOpen(symbol)} title={`Analyze ${symbol}`} className="font-semibold text-white hover:text-mint-400">{symbol}</button>
}

function ChangeDetail({ changes, onOpen }) {
  const move = (label, f, down) => f && <span> {label} {f.from ?? '—'}% → <span className="text-slate-200">{f.to ?? '—'}%</span>{down}</span>
  return (
    <div className="grid gap-3 sm:grid-cols-3 text-xs text-slate-400">
      {changes.added.length > 0 && (
        <div><h4 className="text-[11px] font-semibold text-slate-300">New</h4>
          <p className="mt-1">{changes.added.map((s, i) => <span key={s}>{i > 0 && ', '}<Sym symbol={s} onOpen={onOpen} /></span>)}</p></div>
      )}
      {changes.removed.length > 0 && (
        <div><h4 className="text-[11px] font-semibold text-slate-300">Dropped</h4>
          <p className="mt-1">{changes.removed.map((s, i) => <span key={s}>{i > 0 && ', '}<Sym symbol={s} onOpen={onOpen} /></span>)}</p>
          <p className="mt-1 text-[11px] text-slate-500">Not in this run. It may have failed the edge screen or simply not been proposed again.</p></div>
      )}
      {changes.moved.length > 0 && (
        <div><h4 className="text-[11px] font-semibold text-slate-300">Target or stop moved</h4>
          <ul className="mt-1 space-y-0.5">{changes.moved.map(m => (
            <li key={m.symbol}><Sym symbol={m.symbol} onOpen={onOpen} />{move('target', m.targetReturn)}{m.targetReturn && m.stopLoss ? ',' : ''}{move('stop', m.stopLoss)}</li>
          ))}</ul></div>
      )}
    </div>
  )
}

/** One earlier run, priced now against its own entry prices. */
function RunPicks({ entry, onOpen }) {
  const symbols = entry.picks.map(p => p.symbol).filter(Boolean)
  const { data, loading, error } = useQuery(
    `rec-journal-quotes:${symbols.join(',')}`,
    () => fetchJson(`/api/quote?symbols=${encodeURIComponent(symbols.join(','))}`, { headers: getApiKeyHeaders() }),
    { staleMs: 5 * 60_000, enabled: symbols.length > 0 },
  )
  if (!symbols.length) return <p className="text-xs text-slate-500">This run made no picks — every candidate was screened out.</p>
  const now = Object.fromEntries((data?.quoteResponse?.result ?? []).filter(q => q.regularMarketPrice != null).map(q => [q.symbol, q.regularMarketPrice]))
  const rows = entry.picks.map(p => {
    const price = now[p.symbol]
    const since = price != null && p.entryPrice > 0 ? (price / p.entryPrice - 1) * 100 : null
    return { ...p, price, since }
  })
  const priced = rows.filter(r => r.since != null).map(r => r.since).sort((a, b) => a - b)
  const median = priced.length ? (priced.length % 2 ? priced[(priced.length - 1) / 2] : (priced[priced.length / 2 - 1] + priced[priced.length / 2]) / 2) : null

  return (
    <div className="space-y-2">
      {loading && !data && <p className="text-xs text-slate-500 flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Pricing these picks…</p>}
      {error && <p className="text-xs text-amber-300">Current prices could not be loaded, so only the run's own levels are shown.</p>}
      {median != null && (
        <p className="text-xs text-slate-300">
          {priced.filter(v => v > 0).length} of {priced.length} are above the run's entry price; the median is <span className={median > 0 ? 'text-emerald-400' : median < 0 ? 'text-red-400' : ''}>{pct(median)}</span>.
          {priced.length < rows.length && <span className="text-slate-500"> {rows.length - priced.length} could not be priced.</span>}
        </p>
      )}
      <div className="relative overflow-x-auto">
        <table className="w-full text-xs min-w-[420px]">
          <thead><tr className="text-slate-500 text-left">
            <th scope="col" className="font-medium py-1 pr-2">Pick</th>
            <th scope="col" className="font-medium py-1 px-2 text-right">Entry then</th>
            <th scope="col" className="font-medium py-1 px-2 text-right">Now</th>
            <th scope="col" className="font-medium py-1 px-2 text-right">Since</th>
            <th scope="col" className="font-medium py-1 px-2 text-right">Target</th>
            <th scope="col" className="font-medium py-1 pl-2 text-right">Stop</th>
          </tr></thead>
          <tbody>{rows.map(r => (
            <tr key={r.symbol} className="border-t border-slate-500/10 tabular-nums">
              <th scope="row" className="text-left font-normal py-1 pr-2"><Sym symbol={r.symbol} onOpen={onOpen} /> <span className="text-slate-500">{r.type || ''}</span></th>
              <td className="text-right px-2 text-slate-300">{r.entryPrice != null ? money(r.entryPrice) : '—'}</td>
              <td className="text-right px-2 text-slate-300">{r.price != null ? money(r.price) : '—'}</td>
              <td className={`text-right px-2 ${r.since == null ? 'text-slate-600' : r.since > 0 ? 'text-emerald-400' : r.since < 0 ? 'text-red-400' : 'text-slate-300'}`}>{r.since != null ? pct(r.since) : '—'}</td>
              <td className="text-right px-2 text-slate-400">{r.targetReturn != null ? `+${r.targetReturn}%` : '—'}</td>
              <td className="text-right pl-2 text-slate-400">{r.stopLoss != null ? `−${r.stopLoss}%` : '—'}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <p className="text-[11px] text-slate-500">
        Price now against the entry price recorded in the run. This is not a scored result: no stop or target is applied and it is not compared with the market. The scored record is on the Research Desk's Track record tab.
      </p>
    </div>
  )
}

export default function RunHistory({ journalId, generatedAt, personas = [], onOpen }) {
  const { authFetch, user } = useAuth()
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState(false)
  const [openRun, setOpenRun] = useState(null)
  const { data } = useQuery(
    `rec-journal:${user?.id ?? ''}:${journalId ?? generatedAt ?? ''}`,
    () => fetchJson('/api/recommendations/journal?limit=20', undefined, authFetch),
    { staleMs: 60_000, enabled: !!user },
  )
  const entries = data?.entries ?? []
  if (!entries.length) return null

  const current = journalId ? entries.find(e => e.id === journalId) : null
  const earlier = entries.filter(e => e !== current)
  const personaName = id => personas.find(p => p.id === id)?.name || (id === 'default' ? 'Default' : id)
  const runKey = e => `${e.id}:${e.at}`

  return (
    <div className="glass rounded-xl border border-white/[0.06]">
      {current && (
        <div className="p-3 flex items-start gap-3">
          <History className="w-4 h-4 mt-0.5 shrink-0 text-indigo-400" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            {current.changes ? (
              <>
                <div className="text-xs font-semibold text-white">
                  Since your previous {personaName(current.persona)} run <span className="font-normal text-slate-500">· {dayTime(current.prevAt)}</span>
                </div>
                <div className="text-[12px] text-slate-400 mt-0.5">{summary(current.changes)}</div>
                {(current.changes.added.length > 0 || current.changes.removed.length > 0 || current.changes.moved.length > 0) && (
                  <>
                    <button type="button" onClick={() => setDetail(d => !d)} aria-expanded={detail}
                      className="text-[11px] text-slate-400 hover:text-slate-200 mt-1 underline underline-offset-2">{detail ? 'Hide the changes' : 'Show the changes'}</button>
                    {detail && <div className="mt-2"><ChangeDetail changes={current.changes} onOpen={onOpen} /></div>}
                  </>
                )}
              </>
            ) : (
              <div className="text-[12px] text-slate-400">
                This is your first {personaName(current.persona)} run{current.params?.focus ? ' with this focus list' : ''}, so there is no earlier run to compare it with.
              </div>
            )}
          </div>
        </div>
      )}

      {earlier.length > 0 && (
        <div className={current ? 'border-t border-white/[0.06]' : ''}>
          <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
            className="w-full flex items-center gap-3 p-3 text-left text-xs text-slate-300 hover:text-white">
            {!current && <History className="w-4 h-4 shrink-0 text-indigo-400" aria-hidden="true" />}
            <span className={`flex-1 ${current ? 'pl-7' : ''}`}>Earlier runs <span className="text-slate-500">· {earlier.length}{entries.length >= 20 ? ' most recent' : ''}</span></span>
            <ChevronDown className={`w-4 h-4 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
          {open && (
            <ul className="px-3 pb-3 space-y-1">
              {earlier.map(e => {
                const isOpen = openRun === runKey(e)
                return (
                  <li key={runKey(e)} className="rounded-lg border border-slate-500/15">
                    <button type="button" onClick={() => setOpenRun(isOpen ? null : runKey(e))} aria-expanded={isOpen}
                      className="w-full flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-left text-xs">
                      <span className="text-white font-medium tabular-nums">{dayTime(e.at)}</span>
                      <span className="text-slate-400">{personaName(e.persona)}{e.params?.focus ? ` · focus ${e.params.focus}` : ''}</span>
                      <span className="text-slate-500">{e.count} {e.count === 1 ? 'pick' : 'picks'}</span>
                      <span className="text-slate-500 flex-1 min-w-[10rem]">{e.changes ? `vs ${day(e.prevAt)}: ${summary(e.changes)}` : 'first run of its kind'}</span>
                      <ChevronDown className={`w-3.5 h-3.5 text-slate-500 self-center transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                    </button>
                    {isOpen && (
                      <div className="px-3 pb-3 space-y-3">
                        {e.rationale && <p className="text-xs text-slate-400">{e.rationale}</p>}
                        <RunPicks entry={e} onOpen={onOpen} />
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
