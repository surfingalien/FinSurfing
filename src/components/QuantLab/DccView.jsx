/**
 * DCC-GARCH result (lib/quant/dcc.js) — used by My holdings and Risk → DCC.
 * Shows today's average correlation against its long-run level, the pairs that
 * moved most, and the VaR the current correlations imply vs the static one.
 */
import { Card, Note, Stat, MiniLine, fmt, pct } from './shared'

// Correlations: always two decimals, a sign on changes, never "-0".
const c2 = v => (v == null || !Number.isFinite(v) ? '—' : (Math.abs(v) < 0.005 ? 0 : v).toFixed(2))
const sg = v => (v == null || !Number.isFinite(v) ? '—' : `${v >= 0.005 ? '+' : ''}${c2(v)}`)
const usd = v => (v == null || !Number.isFinite(v) ? '—' : `$${Math.round(v).toLocaleString()}`)

export default function DccView({ d, usdValues = null, title = 'Correlations now — DCC-GARCH' }) {
  if (!d) return null
  const port = d.portfolio
  const up = d.avgCorrNow - d.avgCorrLongRun
  const hist = (d.avgCorrHistory || []).map((v, i) => ({ i, avg: v }))
  return (
    <Card title={title}>
      <p className="text-[11px] text-slate-500 mb-2">Each holding gets its own GARCH(1,1); a DCC(1,1) then lets their correlations move day by day (fitted on {d.pairsUsed} pairs). Correlations usually jump in a sell-off — exactly when diversification is needed.</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <Stat label="Average correlation now" value={c2(d.avgCorrNow)} sub={`long-run ${c2(d.avgCorrLongRun)} (${sg(up)})`} />
        <Stat label="Range, last year" value={d.avgCorrRange ? `${c2(d.avgCorrRange.min)} – ${c2(d.avgCorrRange.max)}` : '—'} />
        <Stat label="Persistence a+b" value={fmt(d.persistence, 3)} sub={d.halfLifeDays ? `shocks halve in ${fmt(d.halfLifeDays, 0)} days` : 'no time variation'} />
        {port && <Stat label="1-day VaR 95% (DCC)" value={pct(port.var95_1d_dcc, 2)} sub={`static ${pct(port.var95_1d_static, 2)}${usdValues ? ` · ${usd(usdValues.var95_1d_dcc)} vs ${usd(usdValues.var95_1d_static)}` : ''}`} />}
      </div>
      {port && port.ratio != null && (
        <Note tone={port.ratio > 1.15 ? 'warn' : 'info'}>
          With today's volatilities and correlations the portfolio's risk is {fmt(port.ratio, 2)}× its five-year average
          (21-day VaR {pct(port.var95_21d_dcc, 1)} vs {pct(port.var95_21d_static, 1)}).
        </Note>
      )}
      {d.likelihoodGain != null && d.likelihoodGain < 2 && <div className="mt-2"><Note>Letting correlations move barely improves the fit (log-likelihood gain {fmt(d.likelihoodGain, 1)}) — constant correlations describe these holdings about as well.</Note></div>}
      {hist.length > 10 && <div className="mt-3"><MiniLine data={hist} xKey="i" lines={[{ key: 'avg', name: 'average pairwise correlation' }]} yFmt={c2} height={150} refY={d.avgCorrLongRun} /></div>}
      <div className="grid md:grid-cols-2 gap-3 mt-3 text-[11px]">
        {[['Rose most vs long-run', (d.rising || []).filter(r => r.change > 0.005)], ['Fell most vs long-run', (d.falling || []).filter(r => r.change < -0.005)]].map(([t, rows]) => (
          <div key={t}>
            <div className="text-xs font-semibold text-slate-300 mb-1">{t}</div>
            {!rows.length ? <p className="text-slate-500">None moved by more than 0.01.</p> : <table className="w-full"><tbody>{rows.map(r => (
              <tr key={`${r.a}-${r.b}`} className="border-t border-slate-500/10">
                <td className="pr-3 py-1 font-mono text-slate-200">{r.a}–{r.b}</td>
                <td className="pr-3 tabular-nums text-slate-300">{c2(r.now)}</td>
                <td className="pr-3 tabular-nums text-slate-500">was {c2(r.longRun)}</td>
                <td className={`tabular-nums ${r.change > 0 ? 'text-amber-300' : 'text-mint-400'}`}>{sg(r.change)}</td>
              </tr>
            ))}</tbody></table>}
          </div>
        ))}
      </div>
    </Card>
  )
}
