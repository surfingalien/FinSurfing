import { AlertTriangle, Database } from 'lucide-react'

const pc = v => (v == null ? '—' : `${Math.round(v * 100)}%`)
const ci = (lo, hi) => (lo == null || hi == null ? '' : ` [${pc(lo)}–${pc(hi)}]`)

function Rate({ label, rate, lo, hi, n, k }) {
  return (
    <div className="glass rounded-xl p-3">
      <div className="text-[10px] text-slate-500">{label}</div>
      <div className="text-lg font-semibold">{pc(rate)}<span className="text-[11px] text-slate-500 font-normal">{ci(lo, hi)}</span></div>
      <div className="text-[10px] text-slate-500">{k != null ? `${k} of ${n}` : `n=${n ?? 0}`}</div>
    </div>
  )
}

/**
 * The system's measured record in one place: every rate with its sample and a
 * 95% interval, the edge report after multiple-comparison correction, and —
 * first — whether any of it survives the next deploy.
 */
export default function TrackRecord({ data }) {
  if (!data) return null
  const b = data.brain
  const h = b ? (b.segmentHorizon === 30 ? b.h30 : b.h7) : null
  const d = data.decisions

  return (
    <div className="space-y-4">
      {!data.persistence?.enabled && (
        <div className="flex items-start gap-2 p-3 rounded-xl border border-amber-500/30 bg-amber-500/10 text-[12px] text-amber-300">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
          <span>Learning stores are not being persisted ({data.persistence?.reason}). Everything below resets at the next deploy.</span>
        </div>
      )}

      <section>
        <h3 className="text-sm font-semibold mb-2">AI Brain picks — {b?.segmentHorizon ?? '—'}-day outcomes</h3>
        {h ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Rate label="Up after the horizon" rate={h.winRate} lo={h.winRateLo} hi={h.winRateHi} n={h.nTradeable} k={h.wins} />
            <Rate label="Beat the benchmark" rate={h.alphaWinRate} lo={h.alphaWinRateLo} hi={h.alphaWinRateHi} n={h.nBench} k={h.alphaWins} />
            <div className="glass rounded-xl p-3">
              <div className="text-[10px] text-slate-500">Target touched first</div>
              <div className="text-lg font-semibold">{pc(b.barriers?.targetFirst)}</div>
              <div className="text-[10px] text-slate-500">stop first {pc(b.barriers?.stopFirst)} · n={b.barriers?.n ?? 0}</div>
            </div>
            <div className="glass rounded-xl p-3">
              <div className="text-[10px] text-slate-500">Score cutoff</div>
              <div className="text-sm font-semibold">{b.autoTune?.validated ? `≥ ${b.autoTune.threshold}` : 'None applied'}</div>
              <div className="text-[10px] text-slate-500">{b.autoTune?.reason}</div>
            </div>
          </div>
        ) : <p className="text-[12px] text-slate-500">No resolved picks yet. Outcomes resolve 7 and 30 days after each scan.</p>}
      </section>

      <section>
        <h3 className="text-sm font-semibold mb-2">Where is the edge?</h3>
        {data.edges?.tested ? (
          data.edges.topEdges.length || data.edges.topDrags.length ? (
            <ul className="text-[12px] space-y-1">
              {[...data.edges.topEdges, ...data.edges.topDrags].map(s => (
                <li key={`${s.dimension}-${s.segment}`}>
                  <span className={s.edge > 0 ? 'text-emerald-400' : 'text-red-400'}>{s.edge > 0 ? '+' : ''}{Math.round(s.edge * 100)}pt</span>{' '}
                  {s.dimension}: {s.segment} — {pc(s.alphaWinRate)}{ci(s.lo, s.hi)} (n={s.n})
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-slate-400">None of {data.edges.tested} segments differs from the overall {pc(data.edges.overall)} beyond chance, after correcting for how many were tested. That is the honest answer, not a missing feature.</p>
          )
        ) : <p className="text-[12px] text-slate-500">Not enough resolved picks per segment to test yet.</p>}
      </section>

      <section>
        <h3 className="text-sm font-semibold mb-2">Every AI surface, one ledger</h3>
        {d?.bySurface ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {Object.entries(d.bySurface).map(([s, c]) => (
              <Rate key={s} label={s} rate={c.winRate} lo={c.winRateLo} hi={c.winRateHi} n={c.nScored ?? c.n} k={c.wins} />
            ))}
          </div>
        ) : <p className="text-[12px] text-slate-500">{d?.totalDecisions ? `${d.totalDecisions} decisions recorded, ${d.totalResolved} resolved — rates appear once a surface has enough.` : 'No decisions recorded yet.'}</p>}
      </section>

      <section className="flex items-center gap-2 text-[12px] text-slate-400">
        <Database className="w-3.5 h-3.5" />
        Strategy library: {data.strategies?.active ?? 0} active, {data.strategies?.proven ?? 0} proven on bars after discovery.
      </section>
    </div>
  )
}
