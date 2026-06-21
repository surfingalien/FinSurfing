import { useState, useCallback } from 'react'
import {
  Search, TrendingUp, AlertTriangle, Target,
  BarChart2, Shield, Zap, ChevronRight, RefreshCw, Brain,
} from 'lucide-react'
import { fetchChart, fetchSummary, fetchQuotes, fmt, fmtPct, fmtLarge, searchSymbol } from '../../services/api'
import { generateAdvisory } from '../../services/research'
import { StanceBadge, SignalPill, ConfidenceMeter, IndicatorRow } from './trade/TradeWidgets'
import TradeCard from './trade/TradeCard'
import MiniChart from './trade/MiniChart'

/* ── TimesFM Forecast Card ───────────────────────── */
function TimesFMCard({ forecast, loading }) {
  if (!loading && !forecast) return null

  if (loading) {
    return (
      <div className="glass rounded-xl p-4 border border-[#6366f1]/15 animate-pulse">
        <div className="flex items-center gap-2 mb-3">
          <Brain className="w-3.5 h-3.5 text-[#6366f1]" />
          <span className="text-xs font-semibold text-slate-400">ML Price Forecast</span>
          <span className="text-[10px] text-slate-600 ml-1">Loading TimesFM…</span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {['7D', '30D', '90D'].map(h => (
            <div key={h} className="rounded-lg bg-white/[0.03] p-3 text-center space-y-1.5">
              <div className="text-[10px] text-slate-600">{h}</div>
              <div className="h-4 bg-white/[0.06] rounded mx-auto w-16" />
              <div className="h-3 bg-white/[0.04] rounded mx-auto w-10" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  const horizons = [
    { key: '7d',  label: '7-Day' },
    { key: '30d', label: '30-Day' },
    { key: '90d', label: '90-Day' },
  ]

  return (
    <div className="glass rounded-xl p-4 border border-[#6366f1]/20 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="w-3.5 h-3.5 text-[#6366f1]" />
          <span className="text-xs font-semibold text-slate-300">ML Price Forecast</span>
        </div>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#6366f1]/15 text-[#6366f1] border border-[#6366f1]/25">
          Google TimesFM 2.5
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {horizons.map(({ key, label }) => {
          const f  = forecast.forecasts?.[key]
          if (!f) return null
          const up = f.upside >= 0
          return (
            <div key={key} className={`rounded-lg p-3 text-center border ${
              up ? 'bg-emerald-500/[0.04] border-emerald-500/15'
                 : 'bg-red-500/[0.04] border-red-500/15'
            }`}>
              <div className="text-[10px] text-slate-500 mb-1.5">{label}</div>
              <div className="font-mono font-bold text-white text-sm">
                ${f.point?.toFixed(2)}
              </div>
              <div className={`text-xs font-semibold mt-0.5 ${up ? 'text-emerald-400' : 'text-red-400'}`}>
                {up ? '+' : ''}{f.upside?.toFixed(1)}%
              </div>
              <div className="text-[10px] text-slate-600 mt-1">
                ±{f.range?.toFixed(1)}% range
              </div>
            </div>
          )
        })}
      </div>

      {/* p10–p90 confidence bands */}
      <div className="grid grid-cols-3 gap-2 pt-1 border-t border-white/[0.04]">
        {horizons.map(({ key, label }) => {
          const f = forecast.forecasts?.[key]
          if (!f) return null
          return (
            <div key={key} className="text-center">
              <div className="text-[9px] text-slate-600 mb-0.5">{label} range</div>
              <div className="text-[10px] font-mono text-slate-500">
                <span className="text-red-400/70">${f.p10?.toFixed(2)}</span>
                <span className="text-slate-700 mx-0.5">–</span>
                <span className="text-emerald-400/70">${f.p90?.toFixed(2)}</span>
              </div>
            </div>
          )
        })}
      </div>

      <p className="text-[10px] text-slate-700 text-center">
        Transformer model · {forecast.inputBars} daily bars · Not financial advice
      </p>
    </div>
  )
}

/* ── Main ResearchView ───────────────────────────── */
export default function ResearchView({ portfolioSymbols = [], watchlistSymbols = [] }) {
  const [query,     setQuery]     = useState('')
  const [results,   setResults]   = useState([])
  const [timeframe, setTimeframe] = useState('Swing')
  const [risk,      setRisk]      = useState('Moderate')
  const [loading,   setLoading]   = useState(false)
  const [advisory,  setAdvisory]  = useState(null)
  const [error,     setError]     = useState(null)
  const [candles,   setCandles]   = useState(null)
  const [searching, setSearching] = useState(false)
  const [forecast,  setForecast]  = useState(null)
  const [fcLoading, setFcLoading] = useState(false)

  const allSymbols = [...new Set([...portfolioSymbols, ...watchlistSymbols,
    'AAPL','NVDA','MSFT','TSLA','AMZN','GOOG','META','AVGO','AMD','COIN','TSM','SPY','QQQ'])]

  const handleSearch = async (q) => {
    setQuery(q)
    if (!q.trim() || q.length < 2) { setResults([]); return }
    setSearching(true)
    try {
      const r = await searchSymbol(q)
      setResults(r.slice(0, 6))
    } catch {}
    setSearching(false)
  }

  const analyze = useCallback(async (sym) => {
    if (!sym) return
    setQuery(sym)
    setResults([])
    setLoading(true)
    setError(null)
    setAdvisory(null)
    setCandles(null)
    setForecast(null)

    try {
      const [chartData, quotes, fund] = await Promise.all([
        fetchChart(sym, '1d', '1y').catch(() => null),
        fetchQuotes([sym]).catch(() => []),
        fetchSummary(sym).catch(() => null),
      ])

      if (!chartData?.candles?.length) throw new Error('No price data available for ' + sym)
      setCandles(chartData.candles)

      const quote = quotes[0] ?? null
      const adv   = generateAdvisory({
        symbol: sym, timeframe, riskTolerance: risk,
        candles: chartData.candles, quote, fundamentals: fund,
      })
      if (adv.error) throw new Error(adv.error)
      setAdvisory(adv)

      // Fire TimesFM forecast in background — non-blocking
      if (process.env.NODE_ENV !== 'test') {
        setFcLoading(true)
        fetch(`/api/forecast/${encodeURIComponent(sym)}`)
          .then(r => r.json())
          .then(d => { if (!d.error) setForecast(d) })
          .catch(() => {})
          .finally(() => setFcLoading(false))
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [timeframe, risk])

  const { stance, thesis, technical, fundamental, trade, risk: riskSection, confidence, watchlist } = advisory || {}

  return (
    <div className="space-y-6 animate-fade-in">
      {/* ── Search & config ── */}
      <div className="glass rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <BarChart2 className="w-4 h-4 text-mint-400" />
          <h2 className="text-base font-semibold text-white">Quantitative Advisory Engine</h2>
          <span className="text-xs text-slate-500">Multi-timeframe · Technical + Fundamental synthesis</span>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              value={query}
              onChange={e => handleSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && query && analyze(query.toUpperCase())}
              placeholder="Enter ticker or company name…"
              className="input pl-9 w-full font-mono"
              list="sym-research"
            />
            <datalist id="sym-research">{allSymbols.map(s => <option key={s} value={s} />)}</datalist>
            {results.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 z-30 glass border border-white/[0.08] rounded-xl overflow-hidden shadow-2xl">
                {results.map(r => (
                  <button key={r.symbol} onClick={() => analyze(r.symbol)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.06] text-left transition-colors">
                    <span className="font-mono font-bold text-mint-400 text-sm w-14 shrink-0">{r.symbol}</span>
                    <span className="text-sm text-slate-300 truncate flex-1">{r.name}</span>
                    <span className="text-xs text-slate-500">{r.exchange}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <select value={timeframe} onChange={e => setTimeframe(e.target.value)} className="input text-sm">
              <option>Day Trade</option>
              <option>Swing</option>
              <option>Position</option>
            </select>
            <select value={risk} onChange={e => setRisk(e.target.value)} className="input text-sm">
              <option>Conservative</option>
              <option>Moderate</option>
              <option>Aggressive</option>
            </select>
            <button
              onClick={() => query && analyze(query.toUpperCase())}
              disabled={loading || !query}
              className="btn-primary flex items-center gap-1.5 shrink-0"
            >
              {loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
              Analyze
            </button>
          </div>
        </div>

        {/* Quick symbols */}
        <div className="flex flex-wrap gap-1.5">
          {[...portfolioSymbols.slice(0, 8), 'SPY', 'QQQ'].map(s => (
            <button key={s} onClick={() => analyze(s)}
              className="px-2.5 py-1 glass rounded-md text-xs font-mono text-slate-400 hover:text-mint-400 hover:border-mint-500/30 border border-white/[0.06] transition-all">
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* ── Loading ── */}
      {loading && (
        <div className="glass rounded-xl p-12 flex flex-col items-center gap-4">
          <RefreshCw className="w-8 h-8 text-mint-400 animate-spin" />
          <div className="text-slate-400 text-sm">Fetching 1-year price history · computing 8 indicators · scoring fundamentals…</div>
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="glass rounded-xl p-6 border border-red-500/20 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-400 shrink-0" />
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {/* ── Advisory Report ── */}
      {advisory && !loading && (
        <div className="space-y-4">

          {/* ── 1. Executive Summary ── */}
          <div className="glass rounded-xl p-5 border border-white/[0.06]">
            <div className="flex flex-col sm:flex-row sm:items-start gap-4 justify-between">
              <div className="space-y-2 flex-1">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="font-mono font-black text-white text-2xl">{advisory.symbol}</span>
                  <span className="text-slate-400 text-sm">{advisory.name}</span>
                  {fundamental?.sector && (
                    <span className="text-xs text-slate-500 bg-white/[0.04] px-2 py-0.5 rounded-md">{fundamental.sector}</span>
                  )}
                  <StanceBadge stance={stance} size="md" />
                  <SignalPill signal={technical.signal} />
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <span className="font-mono font-bold text-white text-xl">${fmt(advisory.price)}</span>
                  {advisory.quote?.change != null && (
                    <span className={`font-mono font-semibold ${advisory.quote.change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {advisory.quote.change >= 0 ? '+' : ''}{fmtPct(advisory.quote.changePct)}
                    </span>
                  )}
                  <span className="text-xs text-slate-500">{timeframe} · {risk}</span>
                </div>
                <p className="text-sm text-slate-300 leading-relaxed max-w-2xl italic">"{thesis}"</p>
              </div>
              <div className="flex flex-col items-end gap-2 sm:shrink-0">
                <ConfidenceMeter score={confidence.score} />
                <p className="text-xs text-slate-500 text-right max-w-[280px] leading-relaxed">{confidence.rationale}</p>
              </div>
            </div>
          </div>

          <div className="grid xl:grid-cols-2 gap-4">
            {/* ── 2. Technical Breakdown ── */}
            <div className="space-y-4">
              <div className="glass rounded-xl p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-white flex items-center gap-2">
                    <BarChart2 className="w-4 h-4 text-mint-400" /> Technical Breakdown
                  </h3>
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <span className={`w-2 h-2 rounded-full ${
                      technical.trend.direction === 'uptrend'   ? 'bg-emerald-400' :
                      technical.trend.direction === 'downtrend' ? 'bg-red-400' : 'bg-amber-400'
                    }`} />
                    {technical.trend.strength} {technical.trend.direction}
                  </div>
                </div>

                {/* Pattern */}
                <div className={`flex items-start gap-2 rounded-lg p-3 border ${
                  technical.pattern.bullish === true  ? 'bg-emerald-500/5 border-emerald-500/15' :
                  technical.pattern.bullish === false ? 'bg-red-500/5 border-red-500/15' :
                  'bg-amber-500/5 border-amber-500/15'
                }`}>
                  <span className="text-base">{technical.pattern.bullish === true ? '📈' : technical.pattern.bullish === false ? '📉' : '📊'}</span>
                  <div>
                    <div className="text-xs font-semibold text-white">{technical.pattern.name}</div>
                    <div className="text-xs text-slate-400">{technical.pattern.desc}</div>
                  </div>
                </div>

                {/* Divergence */}
                {technical.divergence && (
                  <div className={`flex items-start gap-2 rounded-lg p-3 border ${
                    technical.divergence.type === 'Bullish Divergence'
                      ? 'bg-emerald-500/5 border-emerald-500/15' : 'bg-red-500/5 border-red-500/15'
                  }`}>
                    <span className="text-base">{technical.divergence.type === 'Bullish Divergence' ? '🔀' : '⚡'}</span>
                    <div>
                      <div className="text-xs font-semibold text-white">{technical.divergence.type}</div>
                      <div className="text-xs text-slate-400">{technical.divergence.desc}</div>
                    </div>
                  </div>
                )}

                {/* Indicators grid */}
                <div className="grid grid-cols-2 gap-x-4">
                  <div>
                    <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Oscillators</div>
                    <IndicatorRow label="RSI(14)" value={technical.indicators.rsi ?? '—'}
                      bullish={technical.indicators.rsi < 40 ? true : technical.indicators.rsi > 65 ? false : null}
                      sub={technical.indicators.rsi < 30 ? 'Oversold' : technical.indicators.rsi > 70 ? 'Overbought' : 'Neutral'} />
                    <IndicatorRow label="MACD" value={technical.indicators.macdVal ?? '—'}
                      bullish={technical.indicators.macdHist > 0 ? true : technical.indicators.macdHist < 0 ? false : null}
                      sub={`Sig: ${technical.indicators.macdSig ?? '—'} · Hist: ${technical.indicators.macdHist ?? '—'}`} />
                    <IndicatorRow label="ATR(14)" value={`$${technical.indicators.atr}`}
                      bullish={null} sub={`${technical.indicators.atrPct}% of price`} />
                  </div>
                  <div>
                    <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Moving Averages</div>
                    <IndicatorRow label="SMA20" value={`$${technical.indicators.sma20 ?? '—'}`}
                      bullish={advisory.price > technical.indicators.sma20 ? true : advisory.price < technical.indicators.sma20 ? false : null} />
                    <IndicatorRow label="SMA50" value={`$${technical.indicators.sma50 ?? '—'}`}
                      bullish={advisory.price > technical.indicators.sma50 ? true : advisory.price < technical.indicators.sma50 ? false : null} />
                    <IndicatorRow label="SMA200" value={technical.indicators.sma200 ? `$${technical.indicators.sma200}` : 'N/A'}
                      bullish={technical.indicators.sma200 ? advisory.price > technical.indicators.sma200 : null} />
                  </div>
                </div>

                {/* Bollinger */}
                <div>
                  <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Bollinger Bands (20,2)</div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-red-400 font-mono">${technical.indicators.bbLower}</span>
                    <div className="flex-1 relative h-2 bg-white/[0.06] rounded-full">
                      <div className="absolute h-full bg-indigo-500/30 rounded-full" style={{ left: '10%', width: '80%' }} />
                      {technical.indicators.bbLower && technical.indicators.bbUpper && (
                        <div className="absolute w-2 h-2 rounded-full bg-mint-400 -translate-y-0 top-0"
                          style={{ left: `${Math.min(95, Math.max(5, ((advisory.price - technical.indicators.bbLower) / (technical.indicators.bbUpper - technical.indicators.bbLower)) * 100))}%` }} />
                      )}
                    </div>
                    <span className="text-xs text-emerald-400 font-mono">${technical.indicators.bbUpper}</span>
                  </div>
                  <div className="text-center text-[10px] text-slate-500 mt-1">Mid: ${technical.indicators.bbMiddle}</div>
                </div>

                {/* Signal table */}
                <div>
                  <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-2">Signal Alignment</div>
                  <div className="space-y-1">
                    {technical.signals.map((s, i) => (
                      <div key={i} className="flex items-center justify-between text-xs">
                        <span className="text-slate-500 w-20">{s.name}</span>
                        <div className="flex items-center gap-1.5">
                          <span className={`w-1.5 h-1.5 rounded-full ${s.bullish === true ? 'bg-emerald-400' : s.bullish === false ? 'bg-red-400' : 'bg-amber-400'}`} />
                          <span className={s.bullish === true ? 'text-emerald-400' : s.bullish === false ? 'text-red-400' : 'text-slate-400'}>
                            {s.verdict}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Key Levels */}
              <div className="glass rounded-xl p-4">
                <h3 className="font-semibold text-white text-sm mb-3 flex items-center gap-2">
                  <Target className="w-3.5 h-3.5 text-mint-400" /> Key Price Levels
                </h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-[10px] text-emerald-400 font-semibold uppercase tracking-wide mb-1.5">Support</div>
                    {technical.keyLevels.support.slice(0, 4).map((s, i) => (
                      <div key={i} className="flex items-center justify-between py-1">
                        <span className="text-xs text-slate-400">S{i+1}</span>
                        <span className="font-mono text-xs text-emerald-400">${s.toFixed(2)}</span>
                        <span className="text-[10px] text-slate-600">{(((s - advisory.price) / advisory.price) * 100).toFixed(1)}%</span>
                      </div>
                    ))}
                    {technical.keyLevels.support.length === 0 && <div className="text-xs text-slate-600">None identified</div>}
                  </div>
                  <div>
                    <div className="text-[10px] text-red-400 font-semibold uppercase tracking-wide mb-1.5">Resistance</div>
                    {technical.keyLevels.resistance.slice(0, 4).map((r, i) => (
                      <div key={i} className="flex items-center justify-between py-1">
                        <span className="text-xs text-slate-400">R{i+1}</span>
                        <span className="font-mono text-xs text-red-400">${r.toFixed(2)}</span>
                        <span className="text-[10px] text-slate-600">+{(((r - advisory.price) / advisory.price) * 100).toFixed(1)}%</span>
                      </div>
                    ))}
                    {technical.keyLevels.resistance.length === 0 && <div className="text-xs text-slate-600">None identified</div>}
                  </div>
                </div>
                <div className="border-t border-white/[0.06] mt-3 pt-3 grid grid-cols-2 gap-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-slate-500">52W High</span>
                    <span className="font-mono text-red-400">${fmt(fundamental.pctFrom52High < -2 ? advisory.quote?.high52 : advisory.price)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">52W Position</span>
                    <span className="font-mono text-slate-300">{fundamental.rangePct52}%</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Right column */}
            <div className="space-y-4">
              {/* ── 3. Trade Setup ── */}
              <TradeCard trade={trade} stance={stance} />

              {/* ── Mini Chart ── */}
              <MiniChart candles={candles} trade={trade} stance={stance} />

              {/* ── TimesFM ML Forecast ── */}
              <TimesFMCard forecast={forecast} loading={fcLoading} />

              {/* ── 4. Fundamentals ── */}
              <div className="glass rounded-xl p-4 space-y-3">
                <h3 className="font-semibold text-white text-sm flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <TrendingUp className="w-3.5 h-3.5 text-mint-400" /> Fundamental Context
                  </span>
                  <span className={`text-sm font-bold px-2 py-0.5 rounded ${
                    fundamental.grade === 'A' ? 'bg-emerald-500/15 text-emerald-400' :
                    fundamental.grade === 'B' ? 'bg-blue-500/15 text-blue-400' :
                    fundamental.grade === 'C' ? 'bg-amber-500/15 text-amber-400' : 'bg-red-500/15 text-red-400'
                  }`}>Grade: {fundamental.grade}</span>
                </h3>
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                  <IndicatorRow label="P/E (TTM)"       value={fundamental.pe    ? fundamental.pe.toFixed(1)    : '—'} bullish={fundamental.pe ? fundamental.pe < 30 : null} />
                  <IndicatorRow label="Fwd P/E"         value={fundamental.forwardPE ? fundamental.forwardPE.toFixed(1) : '—'} bullish={null} />
                  <IndicatorRow label="Rev Growth"      value={fundamental.revenueGrowth  ? fmtPct(fundamental.revenueGrowth)  : '—'} bullish={fundamental.revenueGrowth > 0.1 ? true : fundamental.revenueGrowth < 0 ? false : null} />
                  <IndicatorRow label="EPS Growth"      value={fundamental.earningsGrowth ? fmtPct(fundamental.earningsGrowth) : '—'} bullish={fundamental.earningsGrowth > 0 ? true : fundamental.earningsGrowth < -0.1 ? false : null} />
                  <IndicatorRow label="Net Margin"      value={fundamental.profitMargin   ? fmtPct(fundamental.profitMargin)   : '—'} bullish={fundamental.profitMargin > 0.1 ? true : fundamental.profitMargin < 0 ? false : null} />
                  <IndicatorRow label="D/E Ratio"       value={fundamental.debtToEquity   ? fundamental.debtToEquity.toFixed(2) : '—'} bullish={fundamental.debtToEquity < 1 ? true : fundamental.debtToEquity > 2.5 ? false : null} />
                  <IndicatorRow label="Beta"            value={fundamental.beta           ? fundamental.beta.toFixed(2)        : '—'} bullish={null} />
                  <IndicatorRow label="Mkt Cap"         value={fundamental.marketCap      ? fmtLarge(fundamental.marketCap)    : '—'} bullish={null} />
                </div>
                {fundamental.analystUpside !== null && (
                  <div className={`flex items-center justify-between rounded-lg px-3 py-2 text-xs border ${
                    parseFloat(fundamental.analystUpside) > 0 ? 'bg-emerald-500/5 border-emerald-500/15' : 'bg-red-500/5 border-red-500/15'
                  }`}>
                    <span className="text-slate-400">Analyst Consensus Target</span>
                    <div className="text-right">
                      <span className="font-mono font-bold text-white">${fmt(fundamental.targetMeanPrice)}</span>
                      <span className={`ml-2 font-semibold ${parseFloat(fundamental.analystUpside) > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        ({fundamental.analystUpside}%)
                      </span>
                    </div>
                  </div>
                )}
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {fundamental.flags?.map((f, i) => (
                    <span key={i} className={`text-[10px] px-2 py-0.5 rounded-md border ${f.positive ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20'}`}>
                      {f.text}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* ── 5. Risk Management ── */}
          <div className="glass rounded-xl p-5 space-y-4">
            <h3 className="font-semibold text-white flex items-center gap-2">
              <Shield className="w-4 h-4 text-mint-400" /> Risk Management & Position Guidance
            </h3>
            <div className="grid sm:grid-cols-3 gap-4">
              {['conservative', 'moderate', 'aggressive'].map(level => (
                <div key={level} className={`glass-card border ${level === risk.toLowerCase() ? 'border-mint-500/30 bg-mint-500/5' : 'border-white/[0.06]'}`}>
                  <div className="text-[10px] text-slate-500 uppercase tracking-wide mb-1 capitalize">{level}</div>
                  <div className="font-mono font-bold text-white text-lg">
                    {riskSection.positionSizes[level]?.toLocaleString() ?? '—'} <span className="text-xs text-slate-500">shares</span>
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {level === 'conservative' ? '0.5%' : level === 'moderate' ? '1%' : '2%'} portfolio risk
                  </div>
                  {level === risk.toLowerCase() && (
                    <div className="text-[10px] text-mint-400 mt-1">← your setting</div>
                  )}
                </div>
              ))}
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-400">Volatility Regime</div>
                <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-semibold border ${
                  riskSection.volRegime === 'Extreme' ? 'bg-red-500/15 text-red-400 border-red-500/30' :
                  riskSection.volRegime === 'High'    ? 'bg-amber-500/15 text-amber-400 border-amber-500/30' :
                  riskSection.volRegime === 'Low'     ? 'bg-blue-500/15 text-blue-400 border-blue-500/30' :
                  'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                }`}>
                  {riskSection.volRegime} Volatility · ATR {technical.indicators.atrPct}%/day
                </div>
                <p className="text-xs text-slate-500">{riskSection.portfolioFit}</p>
              </div>
              <div className="space-y-1.5">
                <div className="text-xs font-semibold text-slate-400">Hedges & Contingency</div>
                {riskSection.hedges.map((h, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-xs text-slate-400">
                    <ChevronRight className="w-3 h-3 text-mint-400 shrink-0 mt-0.5" />
                    {h}
                  </div>
                ))}
              </div>
            </div>

            {riskSection.warnings.length > 0 && (
              <div className="space-y-1.5">
                {riskSection.warnings.map((w, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs text-amber-300 bg-amber-500/5 border border-amber-500/15 rounded-lg px-3 py-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    {w}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── 6. Watchlist Triggers ── */}
          <div className="glass rounded-xl p-5">
            <h3 className="font-semibold text-white mb-4 flex items-center gap-2">
              <Zap className="w-4 h-4 text-mint-400" /> Setup Change Triggers
            </h3>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <div className="text-xs font-semibold text-emerald-400 mb-2">🟢 Bullish Triggers</div>
                {watchlist.bullishTriggers.map((t, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-slate-300 mb-1.5">
                    <ChevronRight className="w-3 h-3 text-emerald-400 shrink-0 mt-0.5" />{t}
                  </div>
                ))}
              </div>
              <div>
                <div className="text-xs font-semibold text-red-400 mb-2">🔴 Bearish Triggers</div>
                {watchlist.bearishTriggers.map((t, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-slate-300 mb-1.5">
                    <ChevronRight className="w-3 h-3 text-red-400 shrink-0 mt-0.5" />{t}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Compliance footer */}
          <div className="text-center text-xs text-slate-600 py-2 border-t border-white/[0.04]">
            Advisory generated {advisory.generatedAt?.toLocaleString()} · Based on Yahoo Finance data ·
            Technical analysis uses observed price/volume data only · <strong>Not financial advice.</strong>
            All probabilistic analysis is inference, not certainty. Verify with licensed financial advisor before trading.
          </div>
        </div>
      )}
    </div>
  )
}
