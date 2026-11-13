/**
 * Event study — what one stock did after its own past earnings releases, periodic filings, or dates you enter
 * (POST /api/quant/event-study, lib/event-study.js). Dates come from the SEC filing index; no model is involved.
 *
 * Two answers, kept apart: the REACTION on the event (descriptive — you could not have traded it) and the DRIFT
 * from the first open after it (tradable, after costs, against the benchmark). Under 12 usable events there is no
 * verdict.
 */
import { RunPanel, Card, Note, Stat, MiniLine } from './shared'

const signed = v => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`)
const tone = v => (v == null ? 'text-slate-600' : v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-slate-300')
const KIND_LABEL = { earnings: 'earnings releases (8-K, Item 2.02)', filings: 'periodic filings (10-K / 10-Q)', custom: 'the dates you entered' }
const VERDICT = {
  positive: ['Positive drift', 'text-emerald-400'], negative: ['Negative drift', 'text-red-400'],
  'no-clear-effect': ['No clear effect', 'text-slate-300'], insufficient: ['Not enough events', 'text-amber-300'],
}

export default function EventStudyTab() {
  return (
    <RunPanel title="Event study" endpoint="/api/quant/event-study" needsAuth runLabel="Run the study"
      blurb="What did this stock do after its own past events? Pick its earnings releases or its periodic filings (dates from the SEC, no key needed), or enter your own dates — product launches, guidance cuts, anything. Returns are after costs and against the market."
      fields={[
        { name: 'symbol', label: 'Symbol', type: 'symbol', default: 'AAPL' },
        { name: 'kind', label: 'Events', type: 'select', default: 'earnings', options: [
          { value: 'earnings', label: 'Earnings releases' }, { value: 'filings', label: 'Periodic filings (10-K / 10-Q)' }, { value: 'custom', label: 'My own dates' }] },
        { name: 'dates', label: 'Your dates', hint: 'only for "My own dates" — YYYY-MM-DD, separated by spaces or commas', type: 'textarea', rows: 2, wide: true },
      ]}
      toBody={v => ({ symbol: String(v.symbol).trim().toUpperCase(), kind: v.kind, ...(v.kind === 'custom' ? { dates: v.dates } : {}) })}
      render={d => (
        <>
          <Card title={`${d.symbol}${d.name ? ` — ${d.name}` : ''}: ${d.events} ${d.events === 1 ? 'event' : 'events'}${d.from ? `, ${d.from} to ${d.to}` : ''}`}>
            <p className="text-xs text-slate-400 mb-3">Events: {KIND_LABEL[d.kind]}. Benchmark: {d.benchmark}.</p>
            <ul className="space-y-1.5 text-sm text-slate-200">{d.summary.map((line, i) => <li key={i}>{line}</li>)}</ul>
            {d.notes?.length > 0 && <div className="mt-3 space-y-1.5">{d.notes.map((n, i) => <Note key={i}>{n}</Note>)}</div>}
          </Card>

          {d.reaction && (
            <Card title="The reaction on the event — descriptive, not tradable">
              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <Stat label="Typical move" value={`±${d.reaction.medianAbs}%`} sub={`median, either direction, vs ${d.benchmark}`} />
                <Stat label="Rose on the event" value={`${Math.round(d.reaction.up * 100)}%`} sub={`95% range ${Math.round(d.reaction.upLo * 100)}–${Math.round(d.reaction.upHi * 100)}% over ${d.reaction.n}`} />
                <Stat label="Best" value={signed(d.reaction.best.move)} sub={d.reaction.best.date} />
                <Stat label="Worst" value={signed(d.reaction.worst.move)} sub={d.reaction.worst.date} />
              </div>
              <div className="mt-3"><Note>From the last close before the event date to the first close after it, minus {d.benchmark}. The filing date does not say whether the news came before the open or after the close, so this window covers both. It shows how much the stock usually moves — it is not a return anyone could have captured.</Note></div>
            </Card>
          )}

          <Card title="The drift after the first tradable open">
            <div className="relative overflow-x-auto">
              <table className="w-full text-xs min-w-[560px]">
                <thead><tr className="text-left text-slate-500">
                  <th scope="col" className="font-medium py-1.5 pr-3">Held</th>
                  <th scope="col" className="font-medium py-1.5 px-2 text-right">Events</th>
                  <th scope="col" className="font-medium py-1.5 px-2 text-right">Mean vs {d.benchmark}</th>
                  <th scope="col" className="font-medium py-1.5 px-2 text-right">Median</th>
                  <th scope="col" className="font-medium py-1.5 px-2 text-right">Beat {d.benchmark}</th>
                  <th scope="col" className="font-medium py-1.5 px-2 text-right">t (needs ±)</th>
                  <th scope="col" className="font-medium py-1.5 pl-2">Verdict</th>
                </tr></thead>
                <tbody>{d.horizons.map(h => {
                  const [label, cls] = VERDICT[h.verdict] || VERDICT.insufficient
                  return (
                    <tr key={h.horizon} className="border-t border-slate-500/10 tabular-nums">
                      <th scope="row" className="text-left font-normal text-slate-300 py-1.5 pr-3">{h.horizon} {h.horizon === 1 ? 'session' : 'sessions'}</th>
                      <td className="text-right px-2 text-slate-300">{h.n}{h.overlapped > 0 && <span className="text-slate-500"> (+{h.overlapped} overlapping, dropped)</span>}</td>
                      <td className={`text-right px-2 ${tone(h.meanAbn)}`}>{signed(h.meanAbn)}</td>
                      <td className={`text-right px-2 ${tone(h.medianAbn)}`}>{signed(h.medianAbn)}</td>
                      <td className="text-right px-2 text-slate-300">{h.beat != null ? `${Math.round(h.beat * 100)}% (${Math.round(h.beatLo * 100)}–${Math.round(h.beatHi * 100)})` : '—'}</td>
                      <td className="text-right px-2 text-slate-300">{h.t != null ? `${h.t.toFixed(2)} (${h.tBar.toFixed(2)})` : '—'}</td>
                      <td className={`pl-2 font-medium ${cls}`}>{label}</td>
                    </tr>
                  )
                })}</tbody>
              </table>
            </div>
            <div className="mt-3 space-y-1.5">
              <Note>{d.method}</Note>
              {d.horizons.some(h => h.verdict === 'insufficient') && <Note tone="warn">A horizon with fewer than {d.minEvents} usable events gets no verdict, whatever its average — a handful of events can average to anything.</Note>}
              <Note>One stock's own history is a small sample. “No clear effect” is the usual and honest result; a verdict here describes the past of this stock, and is not a forecast.</Note>
            </div>
          </Card>

          {d.path && (
            <Card title={`Average path after the event, vs ${d.benchmark} (before costs)`}>
              <MiniLine data={d.path} xKey="day" refY={0} yFmt={v => `${v}%`} lines={[{ key: 'mean', name: 'mean' }, { key: 'median', name: 'median', color: '#64748b' }]} />
              <div className="mt-2"><Note>Day 1 is the close of the first session after the event, measured from that session's open. A line that keeps rising after day 1 is drift; one that jumps and goes flat is a reaction that was already over.</Note></div>
            </Card>
          )}

          {d.table?.length > 0 && (
            <Card title={`Each event${d.events > d.table.length ? ` — the latest ${d.table.length}` : ''}`}>
              <div className="relative overflow-x-auto">
                <table className="w-full text-xs min-w-[520px]">
                  <thead><tr className="text-left text-slate-500">
                    <th scope="col" className="font-medium py-1 pr-3">Event date</th>
                    <th scope="col" className="font-medium py-1 px-2">Form</th>
                    <th scope="col" className="font-medium py-1 px-2 text-right">Reaction</th>
                    <th scope="col" className="font-medium py-1 px-2 text-right">+1</th>
                    <th scope="col" className="font-medium py-1 px-2 text-right">+5</th>
                    <th scope="col" className="font-medium py-1 pl-2 text-right">+20 sessions</th>
                  </tr></thead>
                  <tbody>{d.table.map(r => (
                    <tr key={r.date} className="border-t border-slate-500/10 tabular-nums">
                      <th scope="row" className="text-left font-normal text-slate-300 py-1 pr-3">{r.date}</th>
                      <td className="px-2 text-slate-500">{r.form || '—'}</td>
                      <td className={`text-right px-2 ${tone(r.reactionAbn)}`}>{signed(r.reactionAbn)}</td>
                      <td className={`text-right px-2 ${tone(r.abn1)}`}>{signed(r.abn1)}</td>
                      <td className={`text-right px-2 ${tone(r.abn5)}`}>{signed(r.abn5)}</td>
                      <td className={`text-right pl-2 ${tone(r.abn20)}`}>{signed(r.abn20)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              <p className="text-[11px] text-slate-500 mt-2">All columns are against {d.benchmark}. “—” means the window is not complete yet. The +1 / +5 / +20 columns start at the first open after the event and are after costs.</p>
            </Card>
          )}
        </>
      )} />
  )
}
