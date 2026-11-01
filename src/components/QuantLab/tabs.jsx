/**
 * Quant Lab tools. Each tab is a RunPanel (fields → API → render). All maths is server-side in
 * lib/quant/*; nothing is computed here except layout. Results always show what was ASSUMED or
 * which sample the number comes from, because a quant number without its sample is not a result.
 */
import { useState } from 'react'
import { RunPanel, Card, Note, Stat, ResultView, MiniLine, MiniScatter, fmt, pct } from './shared'
import { SubTabs, HedgingLab, CalibrationTab, ExoticsTab, VrpTab, WalkForwardTab, VarBacktestPanel, RiskPremiumPanel, MlWalkForwardPanel } from './advanced'

const sel = (name, label, options, def) => ({ name, label, type: 'select', options, default: def })
const num = (name, label, def, hint) => ({ name, label, type: 'number', default: def, hint })
const txt = (name, label, def, hint, wide) => ({ name, label, type: 'text', default: def, hint, wide })

/* ── Options ───────────────────────────────────────────────────────────────── */
function OptionsPricer() {
  return (
    <div className="space-y-8">
      <RunPanel title="Price an option four ways" endpoint="/api/quant/options/price"
        blurb="Black–Scholes (European only), binomial lattice, Crank–Nicolson finite differences and Longstaff–Schwartz Monte Carlo. For an American put the three numerical methods should agree to a few cents; the gap between them is the model error you are living with."
        fields={[num('S', 'Spot', 100), num('K', 'Strike', 100), num('r', 'Rate (decimal)', 0.05), num('sigma', 'Volatility (decimal)', 0.2), num('T', 'Years to expiry', 1), num('q', 'Dividend yield', 0), sel('type', 'Type', ['put', 'call'], 'put'), { name: 'american', label: 'American exercise', type: 'checkbox', default: true }]}
        render={d => (
          <>
            <Card title="Prices">
              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <Stat label="Black–Scholes" value={fmt(d.blackScholes.price, 4)} sub="European" />
                <Stat label={`Binomial (n=${d.binomial.n})`} value={fmt(d.binomial.price, 4)} sub={`Richardson ${fmt(d.binomialRichardson.price, 4)}`} />
                <Stat label={`Finite difference (${d.finiteDiff.grid}²)`} value={fmt(d.finiteDiff.price, 4)} />
                <Stat label="Monte Carlo (LSM)" value={fmt(d.monteCarloLSM.price, 3)} sub={`± ${fmt(d.monteCarloLSM.se, 3)} s.e., biased low`} />
              </div>
            </Card>
            <Card title="Greeks"><ResultView data={d.greeks} /></Card>
          </>
        )} />
      <RunPanel title="Implied volatility" endpoint="/api/quant/options/iv" runLabel="Solve"
        blurb="Find the volatility that reproduces a market option price. Returns nothing when the price is outside the no-arbitrage bounds."
        fields={[num('price', 'Option price', 5.5735), num('S', 'Spot', 100), num('K', 'Strike', 100), num('r', 'Rate', 0.05), num('T', 'Years', 1), sel('type', 'Type', ['put', 'call'], 'put')]}
        render={d => d.impliedVol == null ? <Note tone="warn">{d.note}</Note> : <Card><div className="grid sm:grid-cols-3 gap-3"><Stat label="Implied volatility" value={pct(d.impliedVol, 2)} /><Stat label="Delta" value={fmt(d.greeks.delta, 3)} /><Stat label="Vega / 1 vol pt" value={fmt(d.greeks.vega1pct, 3)} /></div></Card>} />
      <RunPanel title="Gamma scalping simulator" endpoint="/api/quant/options/gamma-scalp" runLabel="Simulate"
        blurb="Own a delta-hedged option marked at the implied volatility while the stock moves at the realised one. If realised² beats implied², gamma earned more than theta cost. P&L ≈ ½ΓS²[(ΔS/S)² − σᵢ²Δt], summed."
        fields={[num('sigmaImplied', 'Implied vol', 0.2), num('sigmaRealized', 'Realised vol', 0.28), num('days', 'Days', 60), num('rehedgesPerDay', 'Re-hedges per day', 1), num('costBps', 'Hedge cost (bps)', 0), num('seed', 'Random seed', 3)]}
        render={d => (
          <>
            <Card title="Result">
              <div className="grid sm:grid-cols-4 gap-3 mb-3"><Stat label="Total P&L" value={fmt(d.pnl, 2)} /><Stat label="Gamma P&L" value={fmt(d.gammaPnl, 2)} /><Stat label="Theta P&L" value={fmt(d.thetaPnl, 2)} /><Stat label="Residual" value={fmt(d.residual, 2)} sub="discrete hedging error" /></div>
              <Note>{d.verdict}</Note>
            </Card>
            <Card title="P&L path"><MiniLine data={d.path} xKey="day" lines={[{ key: 'pnl', name: 'P&L' }]} refY={0} /></Card>
          </>
        )} />
    </div>
  )
}

export function OptionsTab() {
  const [w, setW] = useState('pricer')
  return (<div className="space-y-4"><SubTabs tabs={[['pricer', 'Pricer & Greeks'], ['hedging', 'Hedging lab'], ['calibration', 'Calibration'], ['exotics', 'Exotics']]} value={w} onChange={setW} />
    {w === 'pricer' && <OptionsPricer />}{w === 'hedging' && <HedgingLab />}{w === 'calibration' && <CalibrationTab />}{w === 'exotics' && <ExoticsTab />}</div>)
}

/* ── Portfolio ─────────────────────────────────────────────────────────────── */
function PortfolioSplit() {
  return (
    <RunPanel title="Portfolio optimisers, scored out of sample" endpoint="/api/quant/optimize" needsAuth
      blurb="Builds equal-weight, inverse-vol, minimum-variance, max-Sharpe, risk-parity and HRP portfolios from the first 70% of history (Ledoit–Wolf shrunk covariance, expected returns shrunk halfway to the mean) and scores each on the final 30% it never saw."
      fields={[{ name: 'symbols', label: 'Symbols (2–12)', type: 'symbols', default: 'AAPL, MSFT, JNJ, XOM, GLD, TLT', wide: true }, num('cap', 'Max weight per asset', 0.6)]}
      render={d => (
        <>
          <Card title={`Methods — train ${d.trainObs} days, test ${d.testObs} days`}>
            <div className="overflow-x-auto"><table className="text-[11px] w-full"><thead><tr className="text-slate-500 text-left"><th className="pb-1">Method</th><th>In-sample Sharpe</th><th>Out-of-sample Sharpe</th><th>OOS return</th><th>OOS vol</th><th>OOS max DD</th></tr></thead><tbody>
              {d.methods.map(m => <tr key={m.method} className={`border-t border-slate-500/10 ${m.method === d.bestOutOfSample ? 'text-mint-400' : 'text-slate-300'}`}><td className="py-1">{m.method}{m.method === d.bestOutOfSample && ' ★'}</td><td>{fmt(m.inSample.sharpe, 2)}</td><td>{fmt(m.outOfSample.sharpe, 2)}</td><td>{pct(m.outOfSample.ret)}</td><td>{pct(m.outOfSample.vol)}</td><td>{pct(m.outOfSample.maxDrawdown)}</td></tr>)}
            </tbody></table></div>
            <div className="mt-3"><Note>{d.note} Covariance shrinkage intensity: {pct(d.shrinkage, 1)}.</Note></div>
          </Card>
          <Card title="Weights"><div className="overflow-x-auto"><table className="text-[11px] w-full"><thead><tr className="text-slate-500 text-left"><th className="pb-1">Method</th>{d.symbols.map(s => <th key={s}>{s}</th>)}</tr></thead><tbody>
            {d.methods.map(m => <tr key={m.method} className="border-t border-slate-500/10 text-slate-300"><td className="py-1">{m.method}</td>{d.symbols.map(s => <td key={s}>{pct(m.weights[s], 0)}</td>)}</tr>)}
          </tbody></table></div></Card>
          {d.frontier && <Card title="Efficient frontier (historical, long-only)"><MiniScatter data={d.frontier.points.map(p => ({ x: p.vol, y: p.ret }))} extra={[{ point: { x: d.frontier.maxSharpe.vol, y: d.frontier.maxSharpe.ret }, color: '#f59e0b', name: 'Max Sharpe' }]} /><div className="mt-2"><Note>{d.frontier.note}</Note></div></Card>}
          {d.skipped?.length > 0 && <Note tone="warn">Skipped: {d.skipped.join('; ')}</Note>}
        </>
      )} />
  )
}

export function PortfolioTab() {
  const [w, setW] = useState('split')
  return (<div className="space-y-4"><SubTabs tabs={[['split', 'Train / test split'], ['walk', 'Walk-forward backtest']]} value={w} onChange={setW} />{w === 'split' ? <PortfolioSplit /> : <WalkForwardTab />}</div>)
}

/* ── Volatility ────────────────────────────────────────────────────────────── */
function VolEstimators() {
  return (
    <RunPanel title="Volatility models" endpoint="/api/quant/volatility" needsAuth
      blurb="Rolling (O(1) Welford update), EWMA, GARCH(1,1), range-based estimators and a HAR forecast — then how much to hold to target 15% volatility."
      fields={[{ name: 'symbol', label: 'Symbol', type: 'symbol', default: 'SPY' }, num('window', 'Rolling window (days)', 21)]}
      render={d => {
        const n = Math.min(d.rolling.series.length, d.ewma.series.length)
        const rows = Array.from({ length: n }, (_, i) => ({ i, rolling: d.rolling.series[d.rolling.series.length - n + i], ewma: d.ewma.series[d.ewma.series.length - n + i] }))
        return (
          <>
            <Card title={`${d.symbol} — annualised volatility`}>
              <div className="grid sm:grid-cols-3 lg:grid-cols-6 gap-3">
                <Stat label="Close-to-close" value={pct(d.close2close)} /><Stat label={`Rolling ${d.rolling.window}d`} value={pct(d.rolling.current)} /><Stat label="EWMA 0.94" value={pct(d.ewma.current)} />
                <Stat label="Parkinson" value={pct(d.parkinson)} /><Stat label="Garman–Klass" value={pct(d.garmanKlass)} /><Stat label="Yang–Zhang" value={pct(d.yangZhang)} />
              </div>
              <div className="mt-3"><MiniLine data={rows} xKey="i" lines={[{ key: 'rolling' }, { key: 'ewma' }]} yFmt={v => pct(v, 0)} /></div>
            </Card>
            {d.garch && <Card title="GARCH(1,1)"><div className="grid sm:grid-cols-4 gap-3 mb-3"><Stat label="Persistence α+β" value={fmt(d.garch.persistence, 3)} sub={`half-life ${fmt(d.garch.halfLifeDays, 1)}d`} /><Stat label="Long-run vol" value={pct(d.garch.longRunVol)} /><Stat label="Today" value={pct(d.garch.currentVol)} /><Stat label="Tomorrow" value={pct(d.garch.nextDayVol)} /></div><MiniLine data={d.garch.forecast.map((v, i) => ({ day: i + 1, vol: v }))} xKey="day" lines={[{ key: 'vol', name: 'forecast vol' }]} yFmt={v => pct(v, 0)} height={160} />{d.garch.note && <div className="mt-2"><Note tone="warn">{d.garch.note}</Note></div>}</Card>}
            {d.har && <Card title="HAR (daily squared returns)"><ResultView data={{ nextDayVol: d.har.nextDayVol, r2: d.har.r2, coefficients: d.har.coef, note: d.har.note }} /></Card>}
            <Card title="Volatility targeting"><Stat label="Position scale for a 15% target (max 1×)" value={`${fmt(d.volTarget15, 2)}×`} /></Card>
          </>
        )
      }} />
  )
}

export function VolatilityTab() {
  const [w, setW] = useState('est')
  return (<div className="space-y-4"><SubTabs tabs={[['est', 'Estimators & forecasts'], ['vrp', 'Variance risk premium']]} value={w} onChange={setW} />{w === 'est' ? <VolEstimators /> : <VrpTab />}</div>)
}

/* ── Time series ───────────────────────────────────────────────────────────── */
export function SeriesTab() {
  return (
    <RunPanel title="Time-series diagnostics" endpoint="/api/quant/timeseries" needsAuth
      blurb="Is the price stationary? Trending or mean-reverting? Autocorrelated? Which cycles dominate? ARIMA forecast and a calm/stressed regime model."
      fields={[{ name: 'symbol', label: 'Symbol', type: 'symbol', default: 'SPY' }]}
      render={d => (
        <>
          <Card title={`${d.symbol} — ${d.observations} daily closes`}>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {d.adfPrice && <Stat label="ADF on log price" value={fmt(d.adfPrice.stat, 2)} sub={d.adfPrice.stationary5pct ? 'stationary (5%)' : 'unit root not rejected'} />}
              {d.adfReturns && <Stat label="ADF on returns" value={fmt(d.adfReturns.stat, 2)} sub={d.adfReturns.stationary5pct ? 'stationary' : 'not stationary'} />}
              {d.hurst && <Stat label="Hurst exponent" value={fmt(d.hurst.hurst, 2)} sub={d.hurst.regime} />}
              {d.autocorrelation && <Stat label="Ljung–Box p (10 lags)" value={fmt(d.autocorrelation.ljungBox.pValue, 3)} sub={d.autocorrelation.ljungBox.pValue < 0.05 ? 'returns are autocorrelated' : 'consistent with white noise'} />}
            </div>
            <div className="mt-3"><Note>Critical values are asymptotic (MacKinnon) approximations; treat borderline results as borderline.</Note></div>
          </Card>
          {d.arima && <Card title={`ARIMA(${d.arima.p},${d.arima.d},${d.arima.q}) forecast`}><MiniLine data={d.arima.forecast} xKey="step" lines={[{ key: 'mean', name: 'forecast' }, { key: 'lo', name: '95% low', color: '#64748b' }, { key: 'hi', name: '95% high', color: '#64748b' }]} /><div className="mt-2"><Note>{d.arima.note}. A price forecast this near a random walk is mostly a band; read the width, not the middle line.</Note></div></Card>}
          {d.regimes && <Card title="Regimes (2-state hidden Markov model)"><div className="grid sm:grid-cols-3 gap-3 mb-3"><Stat label="Now" value={d.regimes.currentState} sub={`P(stressed) ${pct(d.regimes.currentProbStressed, 0)}`} />{d.regimes.states.map(s => <Stat key={s.name} label={`${s.name} state`} value={pct(s.annualVol, 1)} sub={`avg stay ${fmt(s.expectedDurationDays, 0)} days`} />)}</div></Card>}
          {d.varianceRatio && <Card title="Random-walk (martingale) test — Lo–MacKinlay variance ratios"><ResultView data={d.varianceRatio.map(v => ({ horizonDays: v.q, varianceRatio: v.vr, robustZ: v.zRobust, pValue: v.pValueRobust, verdict: v.verdict }))} /><div className="mt-2"><Note>VR = 1 for a random walk; above 1 means returns trend, below 1 that they revert. The robust z allows for volatility clustering.</Note></div></Card>}
          {d.kalmanLevel && <Card title={`Kalman-filtered level (last 250 days, gain ${fmt(d.kalmanLevel.gain, 3)})`}><MiniLine data={d.kalmanLevel.series} xKey="i" lines={[{ key: 'price', color: '#64748b' }, { key: 'level', name: 'filtered level', color: '#00ffcc' }]} /></Card>}
          {d.cycles && <Card title="Dominant cycles (FFT)"><ResultView data={d.cycles} /><div className="mt-2"><Note>Spectral peaks of noise are common. A cycle explaining only a few percent of power is not a signal.</Note></div></Card>}
        </>
      )} />
  )
}

/* ── Strategies ────────────────────────────────────────────────────────────── */
export function StrategiesTab() {
  const [which, setWhich] = useState('pairs')
  const tabs = [['pairs', 'Pairs trading'], ['screen', 'Pair screen'], ['statarb', 'PCA stat-arb'], ['reversal', 'Short-term reversal']]
  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">{tabs.map(([k, l]) => <button key={k} onClick={() => setWhich(k)} className={`px-3 py-1.5 rounded-lg text-xs ${which === k ? 'bg-mint-400/15 text-mint-400 border border-mint-400/30' : 'text-slate-400 border border-slate-500/20'}`}>{l}</button>)}</div>
      {which === 'pairs' && <RunPanel key="p" title="Pairs trading (cointegration, walk-forward)" endpoint="/api/quant/pairs" needsAuth
        blurb="The hedge ratio and cointegration test use only the first half of history; trades after that use past data only. 'Tradeable' needs a cointegrated pair with a 1–90 day half-life."
        fields={[{ name: 'y', label: 'Symbol Y', type: 'symbol', default: 'KO' }, { name: 'x', label: 'Symbol X', type: 'symbol', default: 'PEP' }, num('entryZ', 'Entry z-score', 2), num('costBps', 'Cost (bps/leg)', 10), { name: 'kalman', label: 'Kalman time-varying hedge ratio', type: 'checkbox', default: false }]}
        render={d => <><Card title={`${d.y} vs ${d.x}`}><ResultView data={{ tradeable: d.tradeable, formation: d.formation, outOfSample: d.trading, currentZScore: d.currentZ, note: d.note }} /></Card>{d.signals?.length > 0 && <Card title="Recent signals"><ResultView data={d.signals} /></Card>}</>} />}
      {which === 'screen' && <RunPanel key="s" title="Screen a basket for pairs" endpoint="/api/quant/pairs/screen" needsAuth
        blurb="Tests every pair. With many pairs some look cointegrated by luck — the screen reports how many false positives to expect. Trust the out-of-sample Sharpe, not the ADF statistic."
        fields={[{ name: 'symbols', label: 'Symbols (3–10)', type: 'symbols', default: 'KO, PEP, XOM, CVX, JPM, BAC', wide: true }]}
        render={d => <Card title={`${d.pairsTested} pairs tested — expect about ${d.expectedFalsePositives} false positives`}><ResultView data={d.pairs} hide={['tradeable']} /><div className="mt-2"><Note>{d.note}</Note></div></Card>} />}
      {which === 'statarb' && <RunPanel key="a" title="PCA-residual statistical arbitrage signals" endpoint="/api/quant/statarb" needsAuth
        blurb="Which names sit furthest from what the common factors imply? Signals only — test the rule before trading it."
        fields={[{ name: 'symbols', label: 'Symbols (4–20)', type: 'symbols', default: 'AAPL, MSFT, GOOGL, AMZN, META, NVDA, AMD, INTC', wide: true }, num('k', 'Factors', 3)]}
        render={d => <Card title={`${d.factors} factors explain ${pct(d.explained, 0)} of variance`}><ResultView data={d.signals} /><div className="mt-2"><Note>{d.note}</Note></div></Card>} />}
      {which === 'reversal' && <RunPanel key="r" title="Short-term reversal backtest" endpoint="/api/quant/reversal" needsAuth
        blurb="Buy after a one-day drop beyond k·σ and hold a few days. A daily-bar proxy for intraday reversal; costs included."
        fields={[{ name: 'symbol', label: 'Symbol', type: 'symbol', default: 'SPY' }, num('k', 'Drop threshold (σ)', 1.5), num('hold', 'Hold (days)', 1)]}
        render={d => <Card title={d.symbol}><ResultView data={d} hide={['symbol']} /></Card>} />}
    </div>
  )
}

/* ── Risk ──────────────────────────────────────────────────────────────────── */
export function RiskTab() {
  const [which, setWhich] = useState('stress')
  const tabs = [['stress', 'Stress test'], ['varbt', 'VaR backtest'], ['capm', 'CAPM & ratios'], ['premium', 'Risk premium'], ['mc', 'Monte Carlo VaR'], ['copula', 'Copula'], ['pca', 'PCA'], ['impact', 'Market impact'], ['bayes', 'Bayesian win rate']]
  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">{tabs.map(([k, l]) => <button key={k} onClick={() => setWhich(k)} className={`px-3 py-1.5 rounded-lg text-xs ${which === k ? 'bg-mint-400/15 text-mint-400 border border-mint-400/30' : 'text-slate-400 border border-slate-500/20'}`}>{l}</button>)}</div>
      {which === 'varbt' && <VarBacktestPanel key="vb" />}
      {which === 'premium' && <RiskPremiumPanel key="rp" />}
      {which === 'stress' && <RunPanel key="a" title="Stress test" endpoint="/api/quant/risk/stress"
        blurb="Each scenario shocks the market and every position moves by its beta (unknown beta is assumed 1 and listed). Add a per-position shock to override."
        fields={[{ name: 'positions', label: 'Positions (JSON)', type: 'textarea', rows: 6, wide: true, default: '[\n {"symbol":"NVDA","value":30000,"beta":1.8},\n {"symbol":"JNJ","value":20000,"beta":0.6},\n {"symbol":"GLD","value":10000,"beta":0.1}\n]' }]}
        toBody={v => ({ positions: JSON.parse(v.positions) })}
        render={d => <Card title={`Portfolio $${fmt(d.portfolioValue, 0)}`}><ResultView data={d.scenarios.map(s => ({ scenario: s.name, pnl: s.pnl, pnlPct: s.pnlPct, worst: s.worstPosition.symbol }))} />{d.assumedBeta1.length > 0 && <div className="mt-2"><Note tone="warn">Beta assumed 1: {d.assumedBeta1.join(', ')}</Note></div>}</Card>} />}
      {which === 'capm' && <RunPanel key="b" title="CAPM, Jensen's alpha, Treynor, information ratio" endpoint="/api/quant/risk/capm" needsAuth
        fields={[{ name: 'symbol', label: 'Symbol', type: 'symbol', default: 'NVDA' }, { name: 'benchmark', label: 'Benchmark', type: 'symbol', default: 'SPY' }, num('rf', 'Risk-free', 0.04)]}
        render={d => <><Card title={`${d.symbol} vs ${d.benchmark}`}><ResultView data={{ beta: d.beta, jensenAlpha: d.jensenAlpha, alphaTStat: d.alphaTStat, r2: d.r2, treynor: d.treynor, informationRatio: d.informationRatio, trackingError: d.trackingError, upCapture: d.upCapture, downCapture: d.downCapture, sharpe: d.sharpe }} /></Card><Card title="Sharpe ratio, bootstrap 95% interval"><ResultView data={d.bootstrapSharpe} hide={['draws']} /></Card></>} />}
      {which === 'mc' && <RunPanel key="c" title="Monte Carlo VaR (correlated draws)" endpoint="/api/quant/risk/montecarlo"
        blurb="Daily mean, volatility and correlations → Cholesky-correlated normal draws → VaR and expected shortfall. Normal tails understate real crashes."
        fields={[txt('weights', 'Weights', '0.5, 0.3, 0.2', 'comma separated'), txt('mu', 'Daily mean returns', '0.0004, 0.0002, 0.0001'), txt('vols', 'Daily volatilities', '0.02, 0.012, 0.008'), { name: 'corr', label: 'Correlation matrix (JSON)', type: 'textarea', rows: 3, default: '[[1,0.5,0.1],[0.5,1,0.2],[0.1,0.2,1]]' }, num('horizon', 'Horizon (days)', 10), num('value', 'Portfolio value', 100000)]}
        toBody={v => { const a = s => s.split(/[,\s]+/).filter(Boolean).map(Number); return { weights: a(v.weights), mu: a(v.mu), vols: a(v.vols), corr: JSON.parse(v.corr), horizon: Number(v.horizon), value: Number(v.value) } }}
        render={d => <Card><div className="grid sm:grid-cols-4 gap-3"><Stat label={`VaR ${pct(d.level, 0)}`} value={pct(d.var, 2)} sub={`$${fmt(d.varValue, 0)}`} /><Stat label="Expected shortfall" value={pct(d.expectedShortfall, 2)} sub={`$${fmt(d.esValue, 0)}`} /><Stat label="Horizon" value={`${d.horizon}d`} /><Stat label="Paths" value={fmt(d.paths, 0)} /></div></Card>} />}
      {which === 'copula' && <RunPanel key="d" title="Gaussian copula tail check" endpoint="/api/quant/risk/copula" needsAuth
        blurb="Do two assets crash together more than a Gaussian dependence model implies?"
        fields={[{ name: 'a', label: 'Symbol A', type: 'symbol', default: 'AAPL' }, { name: 'b', label: 'Symbol B', type: 'symbol', default: 'MSFT' }]}
        render={d => <Card title={`${d.a} / ${d.b}`}><ResultView data={d} hide={['a', 'b']} /></Card>} />}
      {which === 'pca' && <RunPanel key="e" title="Principal components" endpoint="/api/quant/risk/pca" needsAuth
        fields={[{ name: 'symbols', label: 'Symbols (3–20)', type: 'symbols', default: 'AAPL, MSFT, JPM, XOM, JNJ, KO', wide: true }]}
        render={d => <><Card title="Variance explained"><ResultView data={{ explained: d.explained, cumulative: d.cumulative }} /></Card><Card title="Loadings"><ResultView data={d.loadings} /></Card></>} />}
      {which === 'impact' && <RunPanel key="f" title="Market impact (square-root law)" endpoint="/api/quant/risk/impact"
        fields={[num('shares', 'Shares', 50000), num('price', 'Price', 50), num('adv', 'Average daily volume', 1000000), num('dailyVol', 'Daily volatility (decimal)', 0.02), num('spreadBps', 'Quoted spread (bps)', 5)]}
        render={d => <Card><ResultView data={d} /></Card>} />}
      {which === 'bayes' && <RunPanel key="g" title="Is this win rate real? (Beta–Binomial)" endpoint="/api/quant/risk/bayes"
        blurb="Update a flat prior with your wins out of trades. Shows the credible interval and the probability the true rate exceeds the threshold."
        fields={[num('wins', 'Wins', 6), num('n', 'Trades', 10), num('threshold', 'Threshold', 0.5)]}
        render={d => <Card><div className="grid sm:grid-cols-4 gap-3"><Stat label="Posterior mean" value={pct(d.posteriorMean)} /><Stat label="95% interval" value={`${pct(d.lo, 0)}–${pct(d.hi, 0)}`} /><Stat label={`P(rate > ${pct(d.threshold, 0)})`} value={pct(d.probAbove, 0)} /><Stat label="Trades" value={d.n} /></div></Card>} />}
    </div>
  )
}

/* ── ML models ─────────────────────────────────────────────────────────────── */
export function ModelsTab() {
  const [which, setWhich] = useState('compare')
  const tabs = [['compare', 'Model comparison'], ['walk', 'Walk-forward CV'], ['cluster', 'Clustering'], ['rl', 'Reinforcement learning']]
  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">{tabs.map(([k, l]) => <button key={k} onClick={() => setWhich(k)} className={`px-3 py-1.5 rounded-lg text-xs ${which === k ? 'bg-mint-400/15 text-mint-400 border border-mint-400/30' : 'text-slate-400 border border-slate-500/20'}`}>{l}</button>)}</div>
      {which === 'compare' && <RunPanel key="a" title="Thirteen models, one honest test" endpoint="/api/quant/ml/compare" needsAuth runLabel="Train & test"
        blurb="Logistic, KNN, naive Bayes, tree, random forest, gradient boosting, linear and RBF-kernel SVM, LDA, QDA, MLP, 1-D CNN and LSTM predict whether the stock is higher N days later. Trained on the first 65%, a purge gap, then scored on data they never saw — against the do-nothing baseline, with the interval widened for having tried thirteen models. This takes up to a minute."
        fields={[{ name: 'symbol', label: 'Symbol', type: 'symbol', default: 'SPY' }, num('horizon', 'Horizon (days)', 5)]}
        render={d => (
          <>
            <Card title={`${d.symbol} — ${d.testRows} test days (≈${d.effectiveTestObservations} independent)`}>
              <div className="mb-3"><Note tone={d.winners.length ? 'info' : 'warn'}>{d.verdict}</Note></div>
              <div className="overflow-x-auto"><table className="text-[11px] w-full"><thead><tr className="text-slate-500 text-left"><th className="pb-1">Model</th><th>Accuracy</th><th>vs baseline</th><th>Corrected 95% low</th><th>AUC</th><th>Log loss</th><th /></tr></thead><tbody>
                {d.results.map(m => m.error ? <tr key={m.model} className="text-red-400"><td>{m.model}</td><td colSpan={6}>{m.error}</td></tr> : <tr key={m.model} className={`border-t border-slate-500/10 ${m.beatsBaseline ? 'text-mint-400' : 'text-slate-300'}`}><td className="py-1">{m.model}</td><td>{pct(m.accuracy)}</td><td>{m.edgeVsBaseline >= 0 ? '+' : ''}{(m.edgeVsBaseline * 100).toFixed(1)} pts</td><td>{pct(m.accuracyLoCorrected)}</td><td>{fmt(m.auc, 3)}</td><td>{fmt(m.logLoss, 3)}</td><td>{m.beatsBaseline ? '✔ beats baseline' : ''}</td></tr>)}
              </tbody></table></div>
              <div className="mt-3 text-[11px] text-slate-500">Baseline: {d.baseline.rule} ({pct(d.baseline.accuracy)}). {d.confidenceLevel}. Purged {d.purgedRows} rows between train and test.</div>
            </Card>
          </>
        )} />}
      {which === 'walk' && <MlWalkForwardPanel key="w" />}
      {which === 'cluster' && <RunPanel key="b" title="Cluster symbols by risk fingerprint" endpoint="/api/quant/ml/cluster" needsAuth
        blurb="k-means, hierarchical and DBSCAN on return, volatility, downside volatility, 6-month return and drawdown; t-SNE for a 2-D map. DBSCAN's −1 marks outliers."
        fields={[{ name: 'symbols', label: 'Symbols (4–30)', type: 'symbols', default: 'AAPL, MSFT, NVDA, TSLA, JNJ, KO, PG, XOM, CVX, JPM, GLD, TLT', wide: true }, num('k', 'Clusters', 3)]}
        render={d => <><Card title="Clusters"><ResultView data={d.symbols.map(s => ({ symbol: s.symbol, kmeans: s.kmeans, hierarchical: s.hierarchical, dbscan: s.dbscan, outlier: s.outlier }))} /></Card>{d.symbols[0]?.x != null && <Card title="t-SNE map"><TsneMap rows={d.symbols} /></Card>}</>} />}
      {which === 'rl' && <RunPanel key="c" title="Q-learning trader" endpoint="/api/quant/ml/rl" needsAuth runLabel="Train agent"
        blurb="A tabular agent learns when to hold the stock from (momentum, volatility, position). Trained on the first 60%, evaluated greedily on the rest, against buy-and-hold."
        fields={[{ name: 'symbol', label: 'Symbol', type: 'symbol', default: 'SPY' }]}
        render={d => <><Card title={`${d.symbol} — out-of-sample`}><div className="grid sm:grid-cols-4 gap-3"><Stat label="Agent Sharpe" value={fmt(d.sharpe, 2)} sub={`return ${pct(d.totalReturn)}`} /><Stat label="Buy & hold Sharpe" value={fmt(d.buyHoldSharpe, 2)} sub={`return ${pct(d.buyHoldReturn)}`} /><Stat label="Trades" value={d.trades} /><Stat label="Time invested" value={pct(d.exposure, 0)} /></div><div className="mt-3"><Note>{d.note}</Note></div></Card><Card title="Learned policy"><ResultView data={d.policy} /></Card></>} />}
    </div>
  )
}
function TsneMap({ rows }) {
  const xs = rows.map(r => r.x), ys = rows.map(r => r.y), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
  const colors = ['#00ffcc', '#6366f1', '#f59e0b', '#ef4444', '#a78bfa', '#38bdf8']
  return (
    <svg viewBox="0 0 400 260" className="w-full max-w-xl" role="img" aria-label="t-SNE map of symbols">
      {rows.map(r => <g key={r.symbol}><circle cx={20 + (r.x - x0) / (x1 - x0 || 1) * 360} cy={20 + (r.y - y0) / (y1 - y0 || 1) * 220} r="5" fill={colors[r.kmeans % colors.length]} opacity=".85" /><text x={26 + (r.x - x0) / (x1 - x0 || 1) * 360} y={24 + (r.y - y0) / (y1 - y0 || 1) * 220} fontSize="9" fill="#94a3b8">{r.symbol}</text></g>)}
    </svg>
  )
}

/* ── Calculators ───────────────────────────────────────────────────────────── */
const J = (s) => s.trim()
const CALCS = [
  ['parity', 'Put–call parity arbitrage', [num('call', 'Call price', 10.45), num('put', 'Put price', 5.57), num('S', 'Spot', 100), num('K', 'Strike', 100), num('r', 'Rate', 0.05), num('T', 'Years', 1), num('costPerShare', 'Round-trip cost per share', 0.02)]],
  ['theta-gamma', 'Theta–gamma & rule of 16', [num('S', 'Spot', 100), num('K', 'Strike', 100), num('sigma', 'Implied vol', 0.16), num('T', 'Years', 0.25)]],
  ['capacity', 'Strategy capacity', [num('edgeBps', 'Gross edge per trade (bps)', 25), num('adv', 'Average daily volume (shares)', 2000000), num('price', 'Price', 50), num('dailyVol', 'Daily volatility', 0.02), num('positionWeight', 'Position weight in the portfolio', 0.05), num('maxEdgeShare', 'Share of edge impact may consume', 0.5)]],
  ['leverage', 'Leverage & margin call', [num('equity', 'Your equity', 100000), num('leverage', 'Leverage (×)', 2), num('maintenance', 'Maintenance margin', 0.25), sel('side', 'Side', ['long', 'short'], 'long'), num('annualBorrowRate', 'Borrow rate', 0.06), num('days', 'Holding days', 30)]],
  ['short-sale', 'Short selling cost', [num('price', 'Price', 50), num('shares', 'Shares', 1000), num('days', 'Holding days', 90), num('borrowFeeAnnual', 'Borrow fee / yr', 0.01), num('dividendYield', 'Dividend yield', 0.02), num('targetPrice', 'Your target price', 42)]],
  ['order-book', 'Order book walk (market order fill)', [sel('side', 'Side', ['buy', 'sell'], 'buy'), num('quantity', 'Quantity', 1500), { name: 'bids', label: 'Bids (JSON)', type: 'textarea', rows: 3, default: '[{"price":99.98,"size":500},{"price":99.95,"size":800},{"price":99.9,"size":2000}]' }, { name: 'asks', label: 'Asks (JSON)', type: 'textarea', rows: 3, default: '[{"price":100.02,"size":400},{"price":100.05,"size":700},{"price":100.12,"size":1500}]' }]],
  ['latency', 'Cost of latency', [num('dailyVol', 'Daily volatility', 0.02), num('latencyMs', 'Latency (ms)', 50), num('notional', 'Order size ($)', 100000), num('tradesPerDay', 'Trades per day', 100)]],
  ['ito', "Itô's lemma — volatility drag", [num('mu', 'Drift μ', 0.08), num('sigma', 'Volatility σ', 0.3), num('T', 'Years', 10), num('paths', 'Paths', 20000)]],
  ['turnover', 'Turnover & cost drag', [{ name: 'from', label: 'Current weights (JSON)', type: 'textarea', rows: 2, default: '{"SPY":0.6,"TLT":0.4}' }, { name: 'to', label: 'Target weights (JSON)', type: 'textarea', rows: 2, default: '{"SPY":0.5,"TLT":0.3,"GLD":0.2}' }, num('costBps', 'Cost (bps per side)', 10), num('rebalancesPerYear', 'Rebalances per year', 12)]],
  ['carry', 'Carry trade (FX)', [num('rateLong', 'Rate of currency you hold', 0.05), num('rateShort', 'Rate of currency you fund in', 0.01), num('fxVol', 'FX volatility', 0.08)]],
  ['basis', 'Basis trade / cash-and-carry', [num('spot', 'Spot', 100), num('futures', 'Futures price', 104), num('days', 'Days to expiry', 365), num('rate', 'Financing rate', 0.04), num('yieldOrConvenience', 'Yield / convenience', 0), num('costPerUnit', 'Round-trip cost per unit', 0.2)]],
  ['roll-yield', 'Roll yield', [num('near', 'Near contract', 100), num('far', 'Far contract', 102), num('daysBetween', 'Days between', 30)]],
  ['merger-arb', 'Merger arbitrage', [num('targetPrice', 'Target price now', 47), num('cash', 'Cash per share offered', 50), num('stockRatio', 'Stock ratio', 0), num('acquirerPrice', 'Acquirer price', 0), num('daysToClose', 'Days to close', 120), num('breakPrice', 'Price if the deal breaks', 35), num('probabilityOfClose', 'Your probability of closing', 0.9)]],
  ['convertible', 'Convertible arbitrage', [num('bondPrice', 'Convertible price', 1100), num('stockPrice', 'Stock price', 50), num('conversionRatio', 'Conversion ratio', 20), num('bondFloor', 'Bond floor', 950), num('delta', 'Option delta', 0.6)]],
  ['merton', 'Capital structure (Merton credit)', [num('equityValue', 'Equity market value', 40), num('equityVol', 'Equity volatility', 0.6), num('debtFace', 'Debt face value', 100), num('rate', 'Risk-free rate', 0.04), num('years', 'Horizon (years)', 1), num('marketSpread', 'Market credit spread (decimal)', 0.06)]],
  ['vasicek', 'Vasicek interest-rate model', [num('r0', 'Short rate now', 0.04), num('kappa', 'Mean-reversion speed', 0.5), num('theta', 'Long-run rate', 0.05), num('sigma', 'Rate volatility', 0.01)]],
  ['yield-curve', 'Yield curve arbitrage', [{ name: 'rates', label: 'Yields in % (JSON)', type: 'textarea', rows: 3, wide: true, default: '{"3m":5.3,"2y":4.8,"5y":4.3,"10y":4.2,"30y":4.4}' }]],
  ['dispersion', 'Dispersion (index vs components)', [num('indexVol', 'Index implied vol', 0.2), { name: 'weights', label: 'Weights (JSON)', type: 'text', default: '[0.4,0.3,0.3]' }, { name: 'vols', label: 'Component vols (JSON)', type: 'text', default: '[0.3,0.28,0.25]' }, num('realizedCorr', 'Realised correlation', 0.3)]],
  ['vol-term-structure', 'Volatility term structure', [{ name: 'points', label: 'Expiries (JSON)', type: 'textarea', rows: 3, wide: true, default: '[{"days":30,"iv":0.32},{"days":90,"iv":0.28},{"days":180,"iv":0.27},{"days":365,"iv":0.26}]' }]],
  ['skew', 'Volatility skew trading', [num('S', 'Spot', 100), num('T', 'Years', 0.25), num('r', 'Rate', 0.02), { name: 'strikes', label: 'Strikes (JSON)', type: 'textarea', rows: 3, wide: true, default: '[{"strike":80,"iv":0.28},{"strike":90,"iv":0.24},{"strike":95,"iv":0.22},{"strike":100,"iv":0.2},{"strike":105,"iv":0.19},{"strike":110,"iv":0.185},{"strike":120,"iv":0.18}]' }]],
  ['skew-delta', 'Skew-aware delta', [num('S', 'Spot', 100), num('K', 'Strike', 100), num('sigma', 'Implied vol', 0.2), num('T', 'Years', 0.25), num('dSigmaDK', '∂σ/∂K (per $)', -0.004), sel('regime', 'Smile regime', ['sticky-delta', 'sticky-strike'], 'sticky-delta')]],
  ['heston', 'Heston stochastic volatility', [num('S', 'Spot', 100), num('K', 'Strike', 100), num('r', 'Rate', 0.03), num('T', 'Years', 1), num('v0', 'Current variance σ²', 0.04), num('theta', 'Long-run variance', 0.04), num('kappa', 'Mean-reversion speed', 2), num('xi', 'Vol of vol', 0.5), num('rho', 'Correlation ρ', -0.7), sel('type', 'Type', ['call', 'put'], 'call')]],
  ['sabr', 'SABR volatility smile', [num('F', 'Forward', 100), num('T', 'Years', 1), num('alpha', 'α (vol level)', 0.2), num('beta', 'β (0–1)', 1), num('rho', 'ρ (skew)', -0.4), num('nu', 'ν (vol of vol)', 0.5)]],
  ['market-making', 'Market making (Avellaneda–Stoikov)', [num('mid', 'Mid price', 100), num('inventory', 'Inventory (+long)', 5), num('gamma', 'Risk aversion γ', 0.1), num('sigma', 'Volatility (price units / √t)', 0.5), num('k', 'Order-arrival decay k', 1.5), num('tau', 'Time left', 1)]],
  ['execution', 'Execution schedule (VWAP / TWAP)', [num('shares', 'Shares', 100000), num('slices', 'Slices', 13), sel('type', 'Type', ['vwap', 'twap'], 'vwap')]],
  ['shortfall', 'Implementation shortfall', [sel('side', 'Side', ['buy', 'sell'], 'buy'), num('arrival', 'Arrival price', 100), num('avgFill', 'Average fill', 100.12)]],
]
const parseJsonish = (v, f) => (f.type === 'textarea' || ['weights', 'vols'].includes(f.name) ? JSON.parse(v) : v)
const CALC_INTRO = 'Calculators over numbers you enter — for the strategies that need data this app has no feed for (futures curves, deal terms, CDS spreads, convertible quotes, option chains, order books) and for the trading-mechanics concepts (margin, borrow, latency, capacity, turnover).'
export function CalculatorsTab() {
  const [name, setName] = useState('merger-arb')
  const def = CALCS.find(c => c[0] === name)
  return (
    <div className="space-y-4">
      <Note>{CALC_INTRO}</Note>
      <div className="flex gap-2 flex-wrap">{CALCS.map(([k, l]) => <button key={k} onClick={() => setName(k)} className={`px-3 py-1.5 rounded-lg text-xs ${name === k ? 'bg-mint-400/15 text-mint-400 border border-mint-400/30' : 'text-slate-400 border border-slate-500/20'}`}>{l}</button>)}</div>
      <RunPanel key={name} title={def[1]} endpoint={`/api/quant/calc/${name}`} runLabel="Calculate" fields={def[2]}
        toBody={v => Object.fromEntries(def[2].map(f => [f.name, f.type === 'number' ? (v[f.name] === '' ? undefined : Number(v[f.name])) : parseJsonish(String(v[f.name]), f)]))}
        render={d => <Card><ResultView data={d} /></Card>} />
    </div>
  )
}
