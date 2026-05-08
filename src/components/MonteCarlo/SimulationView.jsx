import { useState, useCallback } from 'react'
import { Play, RefreshCw, DollarSign, TrendingUp, Calendar, Percent } from 'lucide-react'
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend } from 'recharts'
import { fmt, fmtLarge } from '../../services/api'

const NUM_SIMULATIONS = 500
const PERCENTILES = [5, 25, 50, 75, 95]

function runMonteCarlo({ initialValue, monthlyContrib, years, annualReturn, annualVol, inflationRate }) {
  const months = years * 12
  const monthlyReturn = annualReturn / 100 / 12
  const monthlyVol = (annualVol / 100) / Math.sqrt(12)
  const monthlyInflation = inflationRate / 100 / 12

  const paths = []
  for (let sim = 0; sim < NUM_SIMULATIONS; sim++) {
    let value = initialValue
    const path = [value]
    for (let m = 1; m <= months; m++) {
      const rng = boxMullerRandom()
      const ret = monthlyReturn + monthlyVol * rng
      value = value * (1 + ret) + monthlyContrib
      if (m % 12 === 0) path.push(value)
    }
    paths.push(path)
  }

  // Calculate percentiles per year
  const yearCount = years + 1
  const result = []
  for (let y = 0; y < yearCount; y++) {
    const vals = paths.map(p => p[y]).sort((a, b) => a - b)
    const entry = { year: y }
    for (const pct of PERCENTILES) {
      const idx = Math.floor((pct / 100) * (vals.length - 1))
      entry[`p${pct}`] = Math.round(vals[idx])
    }
    // Real (inflation-adjusted)
    const deflator = Math.pow(1 + monthlyInflation * 12, y)
    entry.p50real = Math.round(entry.p50 / deflator)
    result.push(entry)
  }

  const finalVals = paths.map(p => p[years]).sort((a, b) => a - b)
  const success = finalVals.filter(v => v >= initialValue).length / NUM_SIMULATIONS * 100

  return { chartData: result, finalVals, successRate: success }
}

let spareRandom = null
function boxMullerRandom() {
  if (spareRandom !== null) { const r = spareRandom; spareRandom = null; return r }
  const u = Math.random(), v = Math.random()
  const mag = Math.sqrt(-2 * Math.log(u))
  spareRandom = mag * Math.cos(2 * Math.PI * v)
  return mag * Math.sin(2 * Math.PI * v)
}

function InputField({ label, icon: Icon, value, onChange, prefix, suffix, min, max, step }) {
  return (
    <div>
      <label className="flex items-center gap-1.5 text-xs text-slate-400 mb-1.5">
        <Icon className="w-3.5 h-3.5" />
        {label}
      </label>
      <div className="relative">
        {prefix && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">{prefix}</span>}
        <input
          type="number" value={value} min={min} max={max} step={step}
          onChange={e => onChange(parseFloat(e.target.value) || 0)}
          className={`input ${prefix ? 'pl-7' : ''} ${suffix ? 'pr-10' : ''}`}
        />
        {suffix && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">{suffix}</span>}
      </div>
    </div>
  )
}

export default function SimulationView() {
  const [params, setParams] = useState({
    initialValue:  250000,
    monthlyContrib: 2000,
    years:          25,
    annualReturn:   7.5,
    annualVol:      15,
    inflationRate:  3.0,
  })
  const [result, setResult] = useState(null)
  const [running, setRunning] = useState(false)

  const set = (key) => (val) => setParams(prev => ({ ...prev, [key]: val }))

  const run = useCallback(() => {
    setRunning(true)
    setTimeout(() => {
      const r = runMonteCarlo(params)
      setResult(r)
      setRunning(false)
    }, 50)
  }, [params])

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null
    return (
      <div className="bg-surface-400/95 border border-white/10 rounded-lg p-3 text-xs font-mono">
        <div className="text-slate-400 mb-2">Year {label}</div>
        {payload.map((p, i) => (
          <div key={i} className="flex justify-between gap-4 mb-0.5">
            <span style={{ color: p.color }}>{p.name}</span>
            <span className="text-white">{fmtLarge(p.value)}</span>
          </div>
        ))}
      </div>
    )
  }

  const finalMedian = result?.chartData[result.chartData.length - 1]?.p50
  const finalBear   = result?.chartData[result.chartData.length - 1]?.p5
  const finalBull   = result?.chartData[result.chartData.length - 1]?.p95

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-white">Monte Carlo Retirement Simulation</h2>
          <p className="text-xs text-slate-500 mt-0.5">{NUM_SIMULATIONS} simulations · Stochastic portfolio modeling</p>
        </div>
        <button
          onClick={run}
          disabled={running}
          className="btn-primary flex items-center gap-2"
        >
          {running ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          {running ? 'Running…' : 'Run Simulation'}
        </button>
      </div>

      <div className="grid lg:grid-cols-4 gap-4">
        {/* Inputs */}
        <div className="glass rounded-xl p-5 space-y-4">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Parameters</h3>
          <InputField label="Current Portfolio Value" icon={DollarSign} value={params.initialValue}
            onChange={set('initialValue')} prefix="$" min={0} step={10000} />
          <InputField label="Monthly Contribution" icon={TrendingUp} value={params.monthlyContrib}
            onChange={set('monthlyContrib')} prefix="$" min={0} step={100} />
          <InputField label="Time Horizon (Years)" icon={Calendar} value={params.years}
            onChange={set('years')} min={1} max={50} step={1} suffix="yr" />
          <InputField label="Expected Annual Return" icon={Percent} value={params.annualReturn}
            onChange={set('annualReturn')} min={0} max={30} step={0.5} suffix="%" />
          <InputField label="Annual Volatility (σ)" icon={TrendingUp} value={params.annualVol}
            onChange={set('annualVol')} min={1} max={60} step={1} suffix="%" />
          <InputField label="Inflation Rate" icon={Percent} value={params.inflationRate}
            onChange={set('inflationRate')} min={0} max={15} step={0.5} suffix="%" />
        </div>

        {/* Chart + Results */}
        <div className="lg:col-span-3 space-y-4">
          {result ? (
            <>
              {/* Summary cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="glass-card">
                  <div className="stat-label">Median Outcome</div>
                  <div className="text-base font-bold font-mono text-mint-400">{fmtLarge(finalMedian)}</div>
                  <div className="text-xs text-slate-500">50th percentile</div>
                </div>
                <div className="glass-card">
                  <div className="stat-label">Bull Case (95th)</div>
                  <div className="text-base font-bold font-mono text-emerald-400">{fmtLarge(finalBull)}</div>
                  <div className="text-xs text-slate-500">Best-case scenario</div>
                </div>
                <div className="glass-card">
                  <div className="stat-label">Bear Case (5th)</div>
                  <div className="text-base font-bold font-mono text-red-400">{fmtLarge(finalBear)}</div>
                  <div className="text-xs text-slate-500">Worst-case scenario</div>
                </div>
                <div className="glass-card">
                  <div className="stat-label">Success Rate</div>
                  <div className={`text-base font-bold font-mono ${result.successRate >= 80 ? 'text-emerald-400' : result.successRate >= 60 ? 'text-amber-400' : 'text-red-400'}`}>
                    {result.successRate.toFixed(0)}%
                  </div>
                  <div className="text-xs text-slate-500">Positive return</div>
                </div>
              </div>

              {/* Fan chart */}
              <div className="glass rounded-xl p-4">
                <h3 className="text-sm font-semibold text-white mb-3">Portfolio Value Over Time</h3>
                <ResponsiveContainer width="100%" height={320}>
                  <AreaChart data={result.chartData} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
                    <defs>
                      <linearGradient id="bull" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#10b981" stopOpacity={0.15} />
                        <stop offset="100%" stopColor="#10b981" stopOpacity={0.02} />
                      </linearGradient>
                      <linearGradient id="bear" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#ef4444" stopOpacity={0.1} />
                        <stop offset="100%" stopColor="#ef4444" stopOpacity={0.02} />
                      </linearGradient>
                      <linearGradient id="base" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#00ffcc" stopOpacity={0.15} />
                        <stop offset="100%" stopColor="#00ffcc" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                    <XAxis dataKey="year" tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false}
                      tickFormatter={v => `Yr ${v}`} />
                    <YAxis tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false}
                      tickFormatter={v => fmtLarge(v)} width={60} />
                    <Tooltip content={<CustomTooltip />} />
                    <Area type="monotone" dataKey="p95" fill="url(#bull)" stroke="#10b981" strokeWidth={1.5} dot={false} name="Bull (95th)" strokeDasharray="6 2" />
                    <Area type="monotone" dataKey="p75" fill="transparent" stroke="rgba(16,185,129,0.4)" strokeWidth={1} dot={false} name="P75" strokeDasharray="4 2" />
                    <Area type="monotone" dataKey="p50" fill="url(#base)" stroke="#00ffcc" strokeWidth={2} dot={false} name="Median (50th)" />
                    <Area type="monotone" dataKey="p25" fill="transparent" stroke="rgba(239,68,68,0.4)" strokeWidth={1} dot={false} name="P25" strokeDasharray="4 2" />
                    <Area type="monotone" dataKey="p5" fill="url(#bear)" stroke="#ef4444" strokeWidth={1.5} dot={false} name="Bear (5th)" strokeDasharray="6 2" />
                    <Area type="monotone" dataKey="p50real" fill="transparent" stroke="rgba(99,102,241,0.6)" strokeWidth={1.5} dot={false} name="Median (Inflation-Adj)" strokeDasharray="3 2" />
                    <ReferenceLine y={params.initialValue} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 2" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              {/* Distribution */}
              <div className="glass rounded-xl p-4">
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Final Value Distribution</h3>
                <div className="grid grid-cols-5 gap-2">
                  {PERCENTILES.map((pct, i) => {
                    const val = result.chartData[result.chartData.length - 1]?.[`p${pct}`]
                    const colors = ['text-red-400','text-orange-400','text-mint-400','text-emerald-400','text-emerald-300']
                    return (
                      <div key={pct} className="glass rounded-lg p-3 text-center">
                        <div className="text-xs text-slate-500 mb-1">{pct}th pct</div>
                        <div className={`text-sm font-bold font-mono ${colors[i]}`}>{fmtLarge(val)}</div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </>
          ) : (
            <div className="glass rounded-xl flex flex-col items-center justify-center py-16 text-center gap-4">
              <div className="w-14 h-14 rounded-full bg-mint-500/10 flex items-center justify-center">
                <Play className="w-6 h-6 text-mint-400 ml-0.5" />
              </div>
              <div className="text-base font-semibold text-white">Ready to Simulate</div>
              <div className="text-sm text-slate-500 max-w-md">
                Configure your portfolio parameters and click Run Simulation to model your retirement outcomes
                with {NUM_SIMULATIONS} randomized market scenarios.
              </div>
              <button onClick={run} className="btn-primary flex items-center gap-2 mt-2">
                <Play className="w-4 h-4" />
                Run Monte Carlo
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

