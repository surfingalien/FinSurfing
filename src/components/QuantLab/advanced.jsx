/**
 * Quant Lab — advanced tools: hedging lab, model calibration, Monte Carlo exotics, variance risk premium,
 * walk-forward portfolio backtest, VaR backtesting, risk premium, purged walk-forward ML. Maths in lib/quant/*.
 */
import { useState } from 'react'
import { RunPanel, Card, Note, Stat, ResultView, MiniLine, fmt, pct } from './shared'

const num = (name, label, def, hint) => ({ name, label, type: 'number', default: def, hint })
const sel = (name, label, options, def) => ({ name, label, type: 'select', options, default: def })
const COLORS = ['#00ffcc', '#6366f1', '#f59e0b', '#ef4444', '#a78bfa', '#38bdf8']

export function SubTabs({ tabs, value, onChange }) {
  return (
    <div className="flex gap-2 flex-wrap" role="tablist">
      {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={value === k} onClick={() => onChange(k)} className={`px-3 py-1.5 rounded-lg text-xs ${value === k ? 'bg-mint-400/15 text-mint-400 border border-mint-400/30' : 'text-slate-400 border border-slate-500/20'}`}>{l}</button>)}
    </div>
  )
}

/* ── Hedging lab ───────────────────────────────────────────────────────────── */
export function HedgingLab() {
  return (
    <RunPanel title="Hedging lab — which vol to hedge at, how often, and the no-trade band" endpoint="/api/quant/options/hedging" runLabel="Simulate"
      blurb="Own an option bought at the implied vol while the stock moves at the realised vol, delta-hedge it to expiry over many simulated paths. Compares hedging at implied vs realised vol (Ahmad–Wilmott), daily vs hourly re-hedging, and the Whalley–Wilmott no-trade band under transaction costs; then shows how hedging noise falls with the number of re-hedges (Derman–Kamal)."
      fields={[num('sigmaImplied', 'Implied vol (paid)', 0.2), num('sigmaRealized', 'Realised vol', 0.28), num('T', 'Years to expiry', 0.25), num('costBps', 'Cost per trade (bps)', 5), num('riskAversion', 'Band risk aversion γ', 1), num('paths', 'Paths', 1000), sel('type', 'Option', ['call', 'put'], 'call')]}
      render={d => (
        <>
          <Card title={`Edge you are trying to capture: V(σr) − V(σi) = ${fmt(d.lockedEdge, 3)} per option`}>
            <div className="overflow-x-auto"><table className="text-[11px] w-full"><thead><tr className="text-slate-500 text-left"><th className="pb-1">Strategy</th><th>Mean P&L</th><th>Std</th><th>5% worst</th><th>P(loss)</th><th>Trades</th><th>Costs</th></tr></thead><tbody>
              {d.rows.map(r => <tr key={r.label} className={`border-t border-slate-500/10 ${r.label === d.bestRiskAdjusted ? 'text-mint-400' : 'text-slate-300'}`}><td className="py-1">{r.label}{r.label === d.bestRiskAdjusted && ' ★'}</td><td>{fmt(r.meanPnl, 3)}</td><td>{fmt(r.stdPnl, 3)}</td><td>{fmt(r.p5, 3)}</td><td>{pct(r.probLoss, 0)}</td><td>{fmt(r.avgTrades, 0)}</td><td>{fmt(r.avgCost, 3)}</td></tr>)}
            </tbody></table></div>
            <div className="mt-3"><Note>{d.note}</Note></div>
          </Card>
          <Card title="One simulated path, hedged three ways (P&L marked at implied vol)">
            <MiniLine data={mergePaths(d.samplePaths)} xKey="t" lines={Object.keys(d.samplePaths).map((k, i) => ({ key: k, color: COLORS[i] }))} refY={0} />
          </Card>
          <Card title="Discrete hedging: noise vs number of re-hedges">
            <ResultView data={d.discrete.points.map(p => ({ rehedges: p.rehedges, simulatedStd: p.stdPnl, dermanKamal: p.theory }))} />
            <div className="mt-2"><Note>{d.discrete.note}</Note></div>
          </Card>
        </>
      )} />
  )
}
function mergePaths(paths) {
  const keys = Object.keys(paths), len = Math.max(...keys.map(k => paths[k].length)), out = []
  for (let i = 0; i < len; i++) { const row = { t: paths[keys[0]][i]?.t ?? i }; for (const k of keys) if (paths[k][i]) row[k] = paths[k][i].pnl; out.push(row) }
  return out
}

/* ── Calibration ───────────────────────────────────────────────────────────── */
const SABR_QUOTES = '[{"strike":80,"iv":0.31},{"strike":90,"iv":0.255},{"strike":95,"iv":0.232},{"strike":100,"iv":0.215},{"strike":105,"iv":0.203},{"strike":110,"iv":0.197},{"strike":120,"iv":0.198}]'
const HESTON_QUOTES = '[{"strike":85,"T":0.25,"iv":0.29},{"strike":95,"T":0.25,"iv":0.235},{"strike":100,"T":0.25,"iv":0.215},{"strike":105,"T":0.25,"iv":0.2},{"strike":115,"T":0.25,"iv":0.19},{"strike":85,"T":1,"iv":0.26},{"strike":100,"T":1,"iv":0.225},{"strike":115,"T":1,"iv":0.205}]'
export function CalibrationTab() {
  const [which, setWhich] = useState('sabr')
  const fitCard = d => (
    <>
      <Card title={`Fitted — RMSE ${fmt(d.rmseVolPts, 3)} vol points`}>
        <MiniLine data={d.fitted.map(f => ({ x: f.T ? `${f.strike}/${f.T}y` : f.strike, market: f.market, model: f.model }))} xKey="x" lines={[{ key: 'market', color: '#f59e0b' }, { key: 'model', color: '#00ffcc' }]} yFmt={v => pct(v, 0)} />
        <div className="mt-3"><ResultView data={Object.fromEntries(Object.entries(d).filter(([k]) => !['fitted', 'note', 'iterations', 'rmseVolPts'].includes(k)))} /></div>
        <div className="mt-2"><Note>{d.note}</Note></div>
      </Card>
    </>
  )
  return (
    <div className="space-y-4">
      <SubTabs tabs={[['sabr', 'SABR smile fit'], ['heston', 'Heston surface fit']]} value={which} onChange={setWhich} />
      {which === 'sabr' && <RunPanel key="s" title="Calibrate SABR to a volatility smile" endpoint="/api/quant/options/calibrate-sabr" runLabel="Calibrate"
        blurb="Paste implied vols by strike for one expiry. Fits α (level), ρ (skew) and ν (curvature) with β fixed, by least squares in volatility."
        fields={[num('F', 'Forward', 100), num('T', 'Years to expiry', 1), num('beta', 'β (0–1)', 1), { name: 'quotes', label: 'Quotes (JSON: strike, iv)', type: 'textarea', rows: 4, wide: true, default: SABR_QUOTES }]}
        toBody={v => ({ F: Number(v.F), T: Number(v.T), beta: Number(v.beta), quotes: JSON.parse(v.quotes) })} render={fitCard} />}
      {which === 'heston' && <RunPanel key="h" title="Calibrate Heston to an implied-vol surface" endpoint="/api/quant/options/calibrate-heston" runLabel="Calibrate (≈10–30 s)"
        blurb="Paste implied vols by strike and expiry. Fits v0, κ, θ, ξ, ρ — every loss evaluation prices each quote by Fourier inversion, so this takes a while."
        fields={[num('S', 'Spot', 100), num('r', 'Rate', 0.03), { name: 'quotes', label: 'Quotes (JSON: strike, T, iv)', type: 'textarea', rows: 5, wide: true, default: HESTON_QUOTES }]}
        toBody={v => ({ S: Number(v.S), r: Number(v.r), quotes: JSON.parse(v.quotes) })} render={fitCard} />}
    </div>
  )
}

/* ── Exotics ───────────────────────────────────────────────────────────────── */
export function ExoticsTab() {
  const [kind, setKind] = useState('asian')
  const common = [num('S', 'Spot', 100), num('r', 'Rate', 0.04), num('sigma', 'Volatility', 0.25), num('T', 'Years', 1), sel('type', 'Type', ['call', 'put'], 'call'), num('paths', 'Paths', 20000)]
  const card = d => (
    <Card title={`${d.kind[0].toUpperCase() + d.kind.slice(1)} option`}>
      <div className="grid sm:grid-cols-3 gap-3 mb-3">
        <Stat label="Monte Carlo price" value={fmt(d.price, 4)} sub={`± ${fmt(d.se, 4)} s.e.`} />
        {d.analytic != null && <Stat label="Closed form" value={fmt(d.analytic, 4)} sub={d.kind === 'barrier' ? 'continuous monitoring (Reiner–Rubinstein)' : 'Goldman–Sosin–Gatto'} />}
        {d.geometricClosedForm != null && <Stat label="Variance reduction" value={`${fmt(d.varianceReduction, 0)}×`} sub={`plain MC ${fmt(d.plainMcPrice, 4)} ± ${fmt(d.plainMcSe, 4)}`} />}
      </div>
      <Note>{d.kind === 'asian' ? 'The geometric-average option has a closed form; using it as a control variate makes the arithmetic price far more precise for the same paths.' : d.kind === 'barrier' ? 'Each step uses the Brownian-bridge probability of crossing between steps, so the simulation prices the continuously monitored contract.' : 'The discretely sampled extreme is shifted by Broadie–Glasserman–Kou to approximate continuous monitoring.'}</Note>
    </Card>
  )
  return (
    <div className="space-y-4">
      <SubTabs tabs={[['asian', 'Asian'], ['barrier', 'Barrier'], ['lookback', 'Lookback']]} value={kind} onChange={setKind} />
      {kind === 'asian' && <RunPanel key="a" title="Arithmetic Asian option" endpoint="/api/quant/options/exotic" fields={[...common, num('K', 'Strike', 100), num('fixings', 'Averaging fixings', 52)]} toBody={v => ({ kind: 'asian', ...nums(v) })} render={card} />}
      {kind === 'barrier' && <RunPanel key="b" title="Barrier option" endpoint="/api/quant/options/exotic" fields={[...common, num('K', 'Strike', 100), num('H', 'Barrier', 85), sel('barrier', 'Barrier type', ['down-and-out', 'down-and-in', 'up-and-out', 'up-and-in'], 'down-and-out'), num('steps', 'Monitoring steps', 100)]} toBody={v => ({ kind: 'barrier', ...nums(v), barrier: v.barrier })} render={card} />}
      {kind === 'lookback' && <RunPanel key="l" title="Floating-strike lookback option" endpoint="/api/quant/options/exotic" fields={[...common, num('steps', 'Monitoring steps', 100)]} toBody={v => ({ kind: 'lookback', ...nums(v) })} render={card} />}
    </div>
  )
}
const nums = v => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'type' || k === 'barrier' ? x : Number(x)]))

/* ── Variance risk premium ─────────────────────────────────────────────────── */
export function VrpTab() {
  return (
    <RunPanel title="Variance risk premium — implied vs the volatility that followed" endpoint="/api/quant/vrp" needsAuth
      blurb="For SPY (and VOO/IVV) the implied vol is the VIX, from FRED, and the full history is measured: VIX on day t against SPY's realised vol over the next 21 sessions. For other symbols, enter the implied vol (e.g. the ATM IV from your broker) to compare with forecasts of realised vol."
      fields={[{ name: 'symbol', label: 'Symbol', type: 'symbol', default: 'SPY' }, { name: 'impliedVol', label: 'Implied vol (decimal, optional for SPY)', type: 'number', default: '' }, num('horizon', 'Horizon (sessions)', 21)]}
      render={d => (
        <>
          <Card title={`${d.symbol} — today (implied from ${d.impliedSource})`}>
            <div className="grid sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-3">
              <Stat label="Implied" value={pct(d.snapshot.impliedVol)} /><Stat label="Consensus realised" value={pct(d.snapshot.consensusRealized)} /><Stat label="Premium" value={`${(d.snapshot.vrp * 100).toFixed(1)} pts`} />
              {['garch', 'har', 'ewma', 'yangZhang'].filter(k => d.snapshot.forecasts[k] != null).slice(0, 3).map(k => <Stat key={k} label={`${k} forecast`} value={pct(d.snapshot.forecasts[k])} />)}
            </div>
            <Note>{d.snapshot.verdict}</Note>
          </Card>
          {d.history && <Card title={`History ${d.history.from} → ${d.history.to}: implied above realised on ${pct(d.history.shareImpliedAbove, 0)} of days, average premium ${(d.history.meanVrp * 100).toFixed(1)} pts`}>
            <MiniLine data={d.history.series.map(r => ({ date: r.date, implied: r.implied, realized: r.realized }))} xKey="date" lines={[{ key: 'implied', name: 'VIX (implied)', color: '#6366f1' }, { key: 'realized', name: 'realised next 21d', color: '#f59e0b' }]} yFmt={v => pct(v, 0)} height={240} />
            <div className="mt-3 grid sm:grid-cols-2 gap-4">
              <ResultView data={d.history.byRegime} />
              <ResultView data={{ worstDay: d.history.worst.date, impliedThen: d.history.worst.implied, realizedAfter: d.history.worst.realized }} />
            </div>
            <div className="mt-2"><Note>{d.history.note}</Note></div>
          </Card>}
          {d.historyError && <Note tone="warn">History unavailable: {d.historyError}</Note>}
        </>
      )} />
  )
}

/* ── Walk-forward portfolio backtest ───────────────────────────────────────── */
export function WalkForwardTab() {
  return (
    <RunPanel title="Walk-forward portfolio backtest" endpoint="/api/quant/optimize/walk-forward" needsAuth
      blurb="Every rebalance re-estimates each method on the trailing window only, holds the weights as prices drift, and pays costs on what it trades. This is what a method actually delivers."
      fields={[{ name: 'symbols', label: 'Symbols (2–10)', type: 'symbols', default: 'SPY, TLT, GLD, EFA, VNQ, DBC', wide: true }, num('lookback', 'Lookback (days)', 252), num('rebalance', 'Rebalance every (days)', 21), num('costBps', 'Cost (bps per unit traded)', 10)]}
      render={d => {
        const len = Math.min(...d.methods.map(m => m.curve.length)), rows = Array.from({ length: len }, (_, i) => Object.fromEntries([['i', i * 5], ...d.methods.map(m => [m.method, m.curve[i]])]))
        return (
          <>
            <Card title={`${d.days} days, rebalanced every ${d.rebalance} days, ${d.costBps} bps costs`}>
              <MiniLine data={rows} xKey="i" lines={d.methods.map((m, i) => ({ key: m.method, color: COLORS[i % COLORS.length] }))} height={260} />
            </Card>
            <Card title="Results (ranked by Sharpe)"><ResultView data={d.methods.map(({ curve, ...m }) => m)} /><div className="mt-2"><Note>{d.note}</Note></div></Card>
          </>
        )
      }} />
  )
}

/* ── Risk: VaR backtest and risk premium ───────────────────────────────────── */
export function VarBacktestPanel() {
  return (
    <RunPanel title="VaR backtest — five methods, scored on the days that followed" endpoint="/api/quant/risk/var-backtest" needsAuth
      blurb="Historical, normal, Cornish–Fisher, EWMA and filtered historical simulation are rolled through five years. Kupiec checks the breach count; Christoffersen checks whether breaches cluster."
      fields={[{ name: 'symbol', label: 'Symbol', type: 'symbol', default: 'SPY' }, num('level', 'Confidence', 0.99), num('window', 'Window (days)', 250)]}
      render={d => (
        <>
          <Card title={`${d.symbol} — ${d.days} test days, ${fmt(d.expectedBreaches, 1)} breaches expected at ${pct(d.level, 1)}`}>
            <div className="overflow-x-auto"><table className="text-[11px] w-full"><thead><tr className="text-slate-500 text-left"><th className="pb-1">Method</th><th>Breaches</th><th>Avg VaR</th><th>Kupiec p</th><th>Independence p</th><th>Verdict</th></tr></thead><tbody>
              {d.methods.map(m => <tr key={m.method} className={`border-t border-slate-500/10 ${m.verdict === 'passes' ? 'text-mint-400' : 'text-slate-300'}`}><td className="py-1">{m.method}</td><td>{m.breaches}</td><td>{pct(m.averageVar, 2)}</td><td>{fmt(m.kupiecP, 3)}</td><td>{fmt(m.independenceP, 3)}</td><td>{m.verdict}</td></tr>)}
            </tbody></table></div>
            <div className="mt-3"><MiniLine data={d.series.map(r => ({ t: r.t, loss: -r.ret, historical: r.historical, 'Filtered HS': r['Filtered HS'] }))} xKey="t" lines={[{ key: 'loss', color: '#64748b' }, { key: 'historical', color: '#f59e0b' }, { key: 'Filtered HS', color: '#00ffcc' }]} yFmt={v => pct(v, 1)} height={200} /></div>
            <div className="mt-2"><Note>{d.note}</Note></div>
          </Card>
        </>
      )} />
  )
}
export function RiskPremiumPanel() {
  return (
    <RunPanel title="Risk premium — and how long it takes to prove it" endpoint="/api/quant/risk/premium" needsAuth
      fields={[{ name: 'symbol', label: 'Symbol', type: 'symbol', default: 'SPY' }, num('rf', 'Risk-free rate', 0.04)]}
      render={d => <Card title={d.symbol}><div className="grid sm:grid-cols-4 gap-3 mb-3"><Stat label="Excess return / yr" value={pct(d.annualExcessReturn)} sub={`95%: ${pct(d.lo, 0)} to ${pct(d.hi, 0)}`} /><Stat label="Volatility" value={pct(d.annualVol)} /><Stat label="Sample" value={`${fmt(d.years, 1)} yrs`} /><Stat label="Years to t = 2" value={fmt(d.yearsNeededForSignificance, 0)} /></div><Note>{d.verdict}</Note></Card>} />
  )
}

/* ── ML walk-forward ───────────────────────────────────────────────────────── */
export function MlWalkForwardPanel() {
  return (
    <RunPanel title="Purged walk-forward cross-validation" endpoint="/api/quant/ml/walk-forward" needsAuth runLabel="Run folds"
      blurb="History is split into consecutive folds; each model trains on everything before a fold (purged so no label peeks ahead), skips an embargo, and is tested on the fold. A real edge beats the baseline fold after fold. Permutation importance shows what the best model actually used."
      fields={[{ name: 'symbol', label: 'Symbol', type: 'symbol', default: 'SPY' }, num('horizon', 'Horizon (days)', 5), num('folds', 'Folds', 5)]}
      render={d => (
        <>
          <Card title={`${d.symbol} — ${d.folds} folds of ${d.rowsPerFold} days, baseline ${pct(d.meanBaselineAccuracy)}`}>
            <div className="mb-3"><Note tone={/beat the baseline in every fold\./.test(d.verdict) && !/^No/.test(d.verdict) ? 'info' : 'warn'}>{d.verdict}</Note></div>
            <ResultView data={d.results} />
          </Card>
          {d.importance && <Card title={`What ${d.importance.model} relied on`}><ResultView data={d.importance.features} /><div className="mt-2"><Note>{d.importance.note}</Note></div></Card>}
        </>
      )} />
  )
}
