import { useState } from 'react'
import { AlertTriangle, Database, Loader2, Shuffle, Wallet } from 'lucide-react'

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
const VS_RANDOM = {
  'beats-random':  ['text-emerald-400', 'The picks beat random names from the same list'],
  'no-difference': ['text-slate-300',   'No measurable difference from random names on the same list'],
  'below-random':  ['text-red-400',     'The picks did WORSE than random names from the same list'],
  'insufficient':  ['text-slate-500',   'Not enough resolved picks on both sides to compare yet'],
}
const EXIT_LABEL = { stop: 'Stopped out', 'breakeven-stop': 'Exited at breakeven', t1: 'Half booked at T1', target: 'Target hit', time: 'Time limit', manual: 'Other' }

export default function TrackRecord({ data, onAdoptBrackets }) {
  const [adopting, setAdopting] = useState(false)
  const [adoptResult, setAdoptResult] = useState(null)
  if (!data) return null
  const vr = data.vsRandom
  const pp = data.paper
  const adopt = async () => {
    setAdopting(true); setAdoptResult(null)
    try { setAdoptResult(await onAdoptBrackets()) } catch (e) { setAdoptResult({ error: e.message }) } finally { setAdopting(false) }
  }
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
        <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5"><Shuffle className="w-3.5 h-3.5" /> Picks vs random picks from the same list</h3>
        {vr ? (
          <div className="space-y-2">
            <p className={`text-[12px] ${VS_RANDOM[vr.verdict]?.[0] || 'text-slate-400'}`}>
              {VS_RANDOM[vr.verdict]?.[1] || vr.verdict}{vr.p != null && vr.verdict !== 'insufficient' ? ` (p=${vr.p}, ${vr.horizon}-day, ${vr.metric === 'alphaWinRate' ? 'beat-the-benchmark rate' : 'win rate'})` : ''}
              {vr.reason ? ` — ${vr.reason}` : ''}
            </p>
            {(vr.ai?.n > 0 || vr.shadow?.n > 0) && (
              <div className="grid grid-cols-2 gap-2">
                <Rate label="AI picks" rate={vr.metric === 'alphaWinRate' ? vr.ai.alphaWinRate : vr.ai.winRate} n={vr.ai.n} />
                <Rate label="Random picks, same list" rate={vr.metric === 'alphaWinRate' ? vr.shadow.alphaWinRate : vr.shadow.winRate} n={vr.shadow.n} />
              </div>
            )}
            <p className="text-[11px] text-slate-500">Beating SPY can come from the list a scan is given (today's movers in a momentum market). Beating random names from that same list is the model's own contribution.</p>
          </div>
        ) : <p className="text-[12px] text-slate-500">No scans with a random comparison yet — every scan from now on logs one.</p>}
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
        {d?.byMethod && (
          <div className="mt-3">
            <div className="text-[11px] text-slate-400 mb-1">Research Desk method — single call vs bull/bear debate</div>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(d.byMethod).map(([m, c]) => (
                <Rate key={m} label={m === 'debate' ? 'Bull vs bear debate' : 'Single call'} rate={c.winRate} lo={c.winRateLo} hi={c.winRateHi} n={c.nScored ?? c.n} k={c.wins} />
              ))}
            </div>
          </div>
        )}
      </section>

      {pp?.enabled && (
        <section>
          <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5"><Wallet className="w-3.5 h-3.5" /> Paper book</h3>
          <p className="text-[12px] text-slate-400">
            {pp.openPositions} open · {pp.closedTrades} closed{pp.winRate != null ? ` · ${pc(pp.winRate)} of closed trades made money` : ''} · realized ${Number(pp.realizedPnl || 0).toFixed(2)}
          </p>
          {Object.keys(pp.exitsByKind || {}).length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mt-2">
              {Object.entries(pp.exitsByKind).map(([k, e]) => (
                <div key={k} className="glass rounded-xl p-3">
                  <div className="text-[10px] text-slate-500">{EXIT_LABEL[k] || k}</div>
                  <div className="text-lg font-semibold">{e.n}</div>
                  <div className={`text-[10px] ${e.realized >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{e.realized >= 0 ? '+' : ''}${e.realized.toFixed(2)}</div>
                </div>
              ))}
            </div>
          )}
          {pp.unmanaged?.length > 0 && (
            <div className="mt-2 p-3 rounded-xl border border-amber-500/30 bg-amber-500/10 text-[12px] text-amber-300 space-y-2">
              <div>{pp.unmanaged.length} position(s) were opened before exits existed and can never sell: {pp.unmanaged.join(', ')}.</div>
              {onAdoptBrackets && (
                <button onClick={adopt} disabled={adopting} className="btn-primary px-3 py-1.5 rounded-lg text-[12px] flex items-center gap-1.5 disabled:opacity-50">
                  {adopting && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Give them exits (admin)
                </button>
              )}
              <div className="text-[11px] text-amber-200/80">Sets a stop and two targets from each name's own price action (support and average daily range), then the hourly manager enforces them. The 30-day time limit starts now.</div>
            </div>
          )}
          {adoptResult && (
            <p className={`text-[12px] mt-2 ${adoptResult.error ? 'text-red-400' : 'text-emerald-400'}`}>
              {adoptResult.error ? adoptResult.error
                : `${adoptResult.adopted?.length ?? 0} position(s) now have exits${adoptResult.skipped?.length ? `; skipped ${adoptResult.skipped.map(x => `${x.symbol} (${x.reason})`).join(', ')}` : ''}. Reopen this tab to see the book.`}
            </p>
          )}
        </section>
      )}

      <section className="flex items-center gap-2 text-[12px] text-slate-400">
        <Database className="w-3.5 h-3.5" />
        Strategy library: {data.strategies?.active ?? 0} active, {data.strategies?.proven ?? 0} proven on bars after discovery{data.strategies?.deflatedAdmissions ? `, ${data.strategies.deflatedAdmissions} admitted past the deflated-Sharpe check (beat the best of the strategies tried alongside them)` : ''}.
      </section>
    </div>
  )
}
