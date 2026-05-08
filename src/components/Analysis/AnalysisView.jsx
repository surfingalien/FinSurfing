import { useState, useEffect } from 'react'
import { Search, TrendingUp, BarChart2, Activity } from 'lucide-react'
import {
  ComposedChart, Line, Bar, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Legend
} from 'recharts'
import {
  fetchChart, fetchSummary, searchSymbol,
  calcSMA, calcEMA, calcRSI, calcMACD, calcBollinger,
  fmt, fmtPct, fmtLarge, fmtVol
} from '../../services/api'
import { StatRow, SectionCard, LoadingPulse } from '../shared/StockCard'

const RANGES = ['1mo','3mo','6mo','1y','2y','5y']
const INDICATORS = ['SMA20','SMA50','EMA12','EMA26','BB','RSI','MACD']

function SignalBadge({ signal }) {
  const cfg = {
    'Strong Buy':  { cls: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30', dot: 'bg-emerald-400' },
    'Buy':         { cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20', dot: 'bg-emerald-400' },
    'Hold':        { cls: 'bg-amber-500/10 text-amber-400 border-amber-500/20', dot: 'bg-amber-400' },
    'Sell':        { cls: 'bg-red-500/10 text-red-400 border-red-500/20', dot: 'bg-red-400' },
    'Strong Sell': { cls: 'bg-red-500/20 text-red-400 border-red-500/30', dot: 'bg-red-400' },
  }
  const c = cfg[signal] || cfg['Hold']
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-semibold border ${c.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
      {signal}
    </span>
  )
}

function deriveSignals(candles, indicators) {
  if (!candles.length) return []
  const closes = candles.map(c => c.close)
  const last = closes[closes.length - 1]
  const rsi = calcRSI(closes)
  const lastRSI = rsi[rsi.length - 1]
  const sma20 = calcSMA(closes, 20)
  const sma50 = calcSMA(closes, 50)
  const macd = calcMACD(closes)
  const lastMACD = macd[macd.length - 1]
  const bb = calcBollinger(closes)
  const lastBB = bb[bb.length - 1]

  const signals = []
  if (lastRSI !== null) {
    if (lastRSI < 30) signals.push({ name: 'RSI Oversold', signal: 'Buy', value: lastRSI.toFixed(1), desc: 'RSI below 30 — potential oversold reversal' })
    else if (lastRSI > 70) signals.push({ name: 'RSI Overbought', signal: 'Sell', value: lastRSI.toFixed(1), desc: 'RSI above 70 — potential overbought reversal' })
    else signals.push({ name: 'RSI Neutral', signal: 'Hold', value: lastRSI.toFixed(1), desc: 'RSI in neutral zone (30–70)' })
  }
  if (sma20[sma20.length - 1] && sma50[sma50.length - 1]) {
    const s20 = sma20[sma20.length - 1], s50 = sma50[sma50.length - 1]
    if (last > s20 && last > s50) signals.push({ name: 'SMA Trend', signal: 'Buy', value: `${fmt(s20)} / ${fmt(s50)}`, desc: 'Price above both SMA20 and SMA50' })
    else if (last < s20 && last < s50) signals.push({ name: 'SMA Trend', signal: 'Sell', value: `${fmt(s20)} / ${fmt(s50)}`, desc: 'Price below both SMA20 and SMA50' })
    else signals.push({ name: 'SMA Trend', signal: 'Hold', value: `${fmt(s20)} / ${fmt(s50)}`, desc: 'Price between moving averages' })
    if (s20 > s50) signals.push({ name: 'Golden Cross', signal: 'Buy', value: '—', desc: 'SMA20 above SMA50 — bullish crossover' })
    else signals.push({ name: 'Death Cross', signal: 'Sell', value: '—', desc: 'SMA20 below SMA50 — bearish crossover' })
  }
  if (lastMACD.macd !== null && lastMACD.signal !== null) {
    if (lastMACD.macd > lastMACD.signal) signals.push({ name: 'MACD', signal: 'Buy', value: lastMACD.hist?.toFixed(3), desc: 'MACD line above signal — bullish momentum' })
    else signals.push({ name: 'MACD', signal: 'Sell', value: lastMACD.hist?.toFixed(3), desc: 'MACD line below signal — bearish momentum' })
  }
  if (lastBB.lower && lastBB.upper) {
    if (last < lastBB.lower) signals.push({ name: 'Bollinger', signal: 'Buy', value: `$${fmt(lastBB.lower)}`, desc: 'Price at lower band — potential bounce' })
    else if (last > lastBB.upper) signals.push({ name: 'Bollinger', signal: 'Sell', value: `$${fmt(lastBB.upper)}`, desc: 'Price at upper band — potential reversal' })
    else signals.push({ name: 'Bollinger', signal: 'Hold', value: `$${fmt(lastBB.middle)}`, desc: 'Price inside Bollinger Bands' })
  }
  return signals
}

function aggregateSignal(signals) {
  const scores = { 'Strong Buy': 2, 'Buy': 1, 'Hold': 0, 'Sell': -1, 'Strong Sell': -2 }
  const avg = signals.reduce((s, sg) => s + (scores[sg.signal] || 0), 0) / (signals.length || 1)
  if (avg >= 1.5) return 'Strong Buy'
  if (avg >= 0.5) return 'Buy'
  if (avg <= -1.5) return 'Strong Sell'
  if (avg <= -0.5) return 'Sell'
  return 'Hold'
}

export default function AnalysisView({ defaultSymbol }) {
  const [symbol, setSymbol] = useState(defaultSymbol || 'AAPL')
  const [inputVal, setInputVal] = useState(defaultSymbol || 'AAPL')
  const [range, setRange] = useState('1y')
  const [activeIndicators, setActiveIndicators] = useState(['SMA20','SMA50','BB'])
  const [chartData, setChartData] = useState([])
  const [summary, setSummary] = useState(null)
  const [signals, setSignals] = useState([])
  const [overallSignal, setOverallSignal] = useState('Hold')
  const [loading, setLoading] = useState(false)
  const [searchResults, setSearchResults] = useState([])
  const [showResults, setShowResults] = useState(false)

  useEffect(() => {
    if (!symbol) return
    setLoading(true)
    Promise.all([
      fetchChart(symbol, '1d', range),
      fetchSummary(symbol)
    ]).then(([chartRes, sumRes]) => {
      const candles = chartRes.candles
      const closes = candles.map(c => c.close)
      const sma20 = calcSMA(closes, 20)
      const sma50 = calcSMA(closes, 50)
      const ema12 = calcEMA(closes, 12)
      const ema26 = calcEMA(closes, 26)
      const rsi   = calcRSI(closes)
      const macd  = calcMACD(closes)
      const bb    = calcBollinger(closes)

      const enriched = candles.map((c, i) => ({
        date:   new Date(c.time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        close:  c.close,
        volume: c.volume,
        sma20:  sma20[i],
        sma50:  sma50[i],
        ema12:  ema12[i],
        ema26:  ema26[i],
        rsi:    rsi[i],
        macd:   macd[i]?.macd,
        macdSig:macd[i]?.signal,
        macdHist:macd[i]?.hist,
        bbUpper:bb[i]?.upper,
        bbMid:  bb[i]?.middle,
        bbLower:bb[i]?.lower,
      }))

      setChartData(enriched)
      setSummary(sumRes)
      const sigs = deriveSignals(candles, activeIndicators)
      setSignals(sigs)
      setOverallSignal(aggregateSignal(sigs))
    }).catch(e => console.warn('Analysis load failed:', e))
    .finally(() => setLoading(false))
  }, [symbol, range])

  const handleSearch = async (q) => {
    setInputVal(q)
    if (!q.trim()) { setSearchResults([]); return }
    const r = await searchSymbol(q).catch(() => [])
    setSearchResults(r)
    setShowResults(true)
  }

  const handleSelect = (sym) => {
    setSymbol(sym)
    setInputVal(sym)
    setSearchResults([])
    setShowResults(false)
  }

  const toggleIndicator = (ind) => {
    setActiveIndicators(prev => prev.includes(ind) ? prev.filter(x => x !== ind) : [...prev, ind])
  }

  const showRSI  = activeIndicators.includes('RSI')
  const showMACD = activeIndicators.includes('MACD')
  const showBB   = activeIndicators.includes('BB')

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null
    return (
      <div className="bg-surface-400/95 border border-white/10 rounded-lg p-3 text-xs font-mono">
        <div className="text-slate-400 mb-1">{label}</div>
        {payload.map((p, i) => (
          <div key={i} style={{ color: p.color }} className="flex justify-between gap-4">
            <span>{p.name}</span>
            <span>{typeof p.value === 'number' ? fmt(p.value) : p.value}</span>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Search bar + controls */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-48 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            value={inputVal}
            onChange={e => handleSearch(e.target.value)}
            onBlur={() => setTimeout(() => setShowResults(false), 200)}
            placeholder="Symbol or company…"
            className="input pl-9 uppercase"
          />
          {showResults && searchResults.length > 0 && (
            <div className="absolute top-full mt-1 w-full z-20 glass rounded-lg border border-white/[0.08] overflow-hidden">
              {searchResults.map(r => (
                <button key={r.symbol} onMouseDown={() => handleSelect(r.symbol)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-white/[0.06] text-left text-sm transition-colors">
                  <span className="font-mono text-mint-400 font-semibold w-12 shrink-0">{r.symbol}</span>
                  <span className="text-slate-300 truncate">{r.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex gap-1">
          {RANGES.map(r => (
            <button key={r} onClick={() => setRange(r)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all
                ${range === r ? 'bg-mint-500/20 text-mint-400 border border-mint-500/30' : 'text-slate-400 hover:text-white hover:bg-white/[0.06]'}`}>
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* Indicator toggles */}
      <div className="flex flex-wrap gap-1.5">
        {INDICATORS.map(ind => (
          <button key={ind} onClick={() => toggleIndicator(ind)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-all border
              ${activeIndicators.includes(ind)
                ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40'
                : 'text-slate-500 border-white/[0.06] hover:border-white/[0.12] hover:text-slate-300'}`}>
            {ind}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="glass rounded-xl p-6"><LoadingPulse rows={4} /></div>
      ) : (
        <div className="grid lg:grid-cols-3 gap-4">
          {/* Main chart */}
          <div className="lg:col-span-2 space-y-3">
            <div className="glass rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-white font-mono">{symbol} — Price</h3>
                <span className="text-xs text-slate-500">{range} daily</span>
              </div>
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                  <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} interval="preserveStartEnd" />
                  <YAxis domain={['auto','auto']} tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} tickFormatter={v => `$${fmt(v)}`} width={60} />
                  <Tooltip content={<CustomTooltip />} />
                  {showBB && <Area dataKey="bbUpper" fill="rgba(99,102,241,0.06)" stroke="rgba(99,102,241,0.3)" strokeWidth={1} dot={false} name="BB Upper" strokeDasharray="4 2" />}
                  {showBB && <Area dataKey="bbLower" fill="rgba(99,102,241,0.06)" stroke="rgba(99,102,241,0.3)" strokeWidth={1} dot={false} name="BB Lower" strokeDasharray="4 2" />}
                  <Line type="monotone" dataKey="close" stroke="#00ffcc" strokeWidth={2} dot={false} name="Close" />
                  {activeIndicators.includes('SMA20') && <Line dataKey="sma20" stroke="#f59e0b" strokeWidth={1.5} dot={false} name="SMA20" />}
                  {activeIndicators.includes('SMA50') && <Line dataKey="sma50" stroke="#3b82f6" strokeWidth={1.5} dot={false} name="SMA50" />}
                  {activeIndicators.includes('EMA12') && <Line dataKey="ema12" stroke="#ec4899" strokeWidth={1} dot={false} strokeDasharray="4 2" name="EMA12" />}
                  {activeIndicators.includes('EMA26') && <Line dataKey="ema26" stroke="#8b5cf6" strokeWidth={1} dot={false} strokeDasharray="4 2" name="EMA26" />}
                  {showBB && <Line dataKey="bbMid" stroke="rgba(99,102,241,0.5)" strokeWidth={1} dot={false} name="BB Mid" strokeDasharray="2 2" />}
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Volume */}
            <div className="glass rounded-xl p-4">
              <h3 className="text-xs font-semibold text-slate-400 mb-2">Volume</h3>
              <ResponsiveContainer width="100%" height={80}>
                <ComposedChart data={chartData}>
                  <XAxis dataKey="date" hide />
                  <YAxis hide />
                  <Bar dataKey="volume" fill="rgba(99,102,241,0.4)" name="Volume" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* RSI */}
            {showRSI && (
              <div className="glass rounded-xl p-4">
                <h3 className="text-xs font-semibold text-slate-400 mb-2">RSI (14)</h3>
                <ResponsiveContainer width="100%" height={100}>
                  <ComposedChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                    <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} interval="preserveStartEnd" />
                    <YAxis domain={[0, 100]} tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} ticks={[30, 50, 70]} width={30} />
                    <Tooltip content={<CustomTooltip />} />
                    <ReferenceLine y={70} stroke="rgba(239,68,68,0.4)" strokeDasharray="4 2" />
                    <ReferenceLine y={30} stroke="rgba(16,185,129,0.4)" strokeDasharray="4 2" />
                    <Line type="monotone" dataKey="rsi" stroke="#6366f1" strokeWidth={1.5} dot={false} name="RSI" />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* MACD */}
            {showMACD && (
              <div className="glass rounded-xl p-4">
                <h3 className="text-xs font-semibold text-slate-400 mb-2">MACD (12/26/9)</h3>
                <ResponsiveContainer width="100%" height={100}>
                  <ComposedChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                    <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} width={40} />
                    <Tooltip content={<CustomTooltip />} />
                    <ReferenceLine y={0} stroke="rgba(255,255,255,0.1)" />
                    <Bar dataKey="macdHist" fill="#6366f1" fillOpacity={0.6} name="Histogram" />
                    <Line dataKey="macd" stroke="#00ffcc" strokeWidth={1.5} dot={false} name="MACD" />
                    <Line dataKey="macdSig" stroke="#f97316" strokeWidth={1.5} dot={false} name="Signal" />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* Side panel */}
          <div className="space-y-3">
            {/* Signal summary */}
            <SectionCard title="Technical Signal">
              <div className="flex justify-center py-3">
                <SignalBadge signal={overallSignal} />
              </div>
              <div className="space-y-2">
                {signals.map((sg, i) => (
                  <div key={i} className="flex items-start gap-2 py-1.5 border-b border-white/[0.04] last:border-0">
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded mt-0.5 shrink-0
                      ${sg.signal === 'Buy' ? 'bg-emerald-500/20 text-emerald-400' :
                        sg.signal === 'Sell' ? 'bg-red-500/20 text-red-400' :
                        'bg-amber-500/10 text-amber-400'}`}>
                      {sg.signal}
                    </span>
                    <div>
                      <div className="text-xs text-white">{sg.name}</div>
                      <div className="text-[10px] text-slate-500">{sg.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>

            {/* Fundamentals */}
            {summary && (
              <SectionCard title="Fundamentals">
                <StatRow label="P/E Ratio"       value={summary.pe     ? fmt(summary.pe)     : '—'} mono />
                <StatRow label="Forward P/E"     value={summary.forwardPE ? fmt(summary.forwardPE) : '—'} mono />
                <StatRow label="EPS"             value={summary.eps    ? `$${fmt(summary.eps)}` : '—'} mono />
                <StatRow label="Market Cap"      value={fmtLarge(summary.marketCap)} mono />
                <StatRow label="Dividend Yield"  value={summary.dividendYield ? fmtPct(summary.dividendYield * 100) : '—'} mono />
                <StatRow label="Beta"            value={summary.beta   ? fmt(summary.beta, 2) : '—'} mono />
                <StatRow label="52W High"        value={`$${fmt(summary.high52)}`} mono />
                <StatRow label="52W Low"         value={`$${fmt(summary.low52)}`} mono />
                <StatRow label="ROE"             value={summary.returnOnEquity ? fmtPct(summary.returnOnEquity * 100) : '—'} mono />
                <StatRow label="Profit Margin"   value={summary.profitMargin   ? fmtPct(summary.profitMargin   * 100) : '—'} mono />
                <StatRow label="Analyst Rating"  value={summary.recommendationKey || '—'} />
              </SectionCard>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
