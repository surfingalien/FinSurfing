import { useState, useCallback } from 'react'
import {
  Search, TrendingUp, TrendingDown, Minus, AlertTriangle, Target,
  BarChart2, Shield, Zap, Clock, ChevronRight, RefreshCw,
} from 'lucide-react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer,
} from 'recharts'
import { fetchChart, fetchSummary, fetchQuotes, fmt, fmtPct, fmtLarge, searchSymbol } from '../../services/api'
import { generateAdvisory } from '../../services/research'

/* ── Stance badge ────────────────────────────────── */
function StanceBadge({ stance, size = 'md' }) {
  const cfg = {
    Bullish: { cls: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30', icon: TrendingUp },
    Bearish: { cls: 'bg-red-500/20 text-red-400 border-red-500/30',          icon: TrendingDown },
    Neutral: { cls: 'bg-amber-500/20 text-amber-400 border-amber-500/30',    icon: Minus },
  }
  const c   = cfg[stance] || cfg.Neutral
  const Icon = c.icon
  const sz  = size === 'lg' ? 'px-5 py-2 text-base font-bold' : 'px-3 py-1 text-sm font-semibold'
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border ${c.cls} ${sz}`}>
      <Icon className={size === 'lg' ? 'w-5 h-5' : 'w-3.5 h-3.5'} />
      {stance}
    </span>
  )
}

/* ── Signal pill ─────────────────────────────────── */
function SignalPill({ signal }) {
  const map = {
    'Strong Buy':  'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    'Buy':         'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    'Hold':        'bg-amber-500/10  text-amber-400  border-amber-500/20',
    'Sell':        'bg-red-500/10    text-red-400    border-red-500/20',
    'Strong Sell': 'bg-red-500/20    text-red-400    border-red-500/30',
  }
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-bold border ${map[signal] || map.Hold}`}>
      {signal}
    </span>
  )
}

/* ── Confidence meter ────────────────────────────── */
function ConfidenceMeter({ score }) {
  const pct  = (score / 10) * 100
  const color = score >= 7.5 ? '#10b981' : score >= 5 ? '#f59e0b' : '#ef4444'
  const label = score >= 7.5 ? 'High' : score >= 5 ? 'Moderate' : 'Low'
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-400">Confidence</span>
        <span className="font-mono font-bold" style={{ color }}>{score}/10 · {label}</span>
      </div>
      <div className="h-2 bg-white/[0.06] rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  )
}

/* ── Indicator row ───────────────────────────────── */
function IndicatorRow({ label, value, bullish, sub }) {
  const dot = bullish === true ? 'bg-emerald-400' : bullish === false ? 'bg-red-400' : 'bg-amber-400'
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-white/[0.04] last:border-0">
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
        <span className="text-xs text-slate-400">{label}</span>
      </div>
      <div className="text-right">
        <div className="text-xs font-mono text-white">{value}</div>
        {sub && <div className="text-[10px] text-slate-500">{sub}</div>}
      </div>
    </div>
  )
}

/* ── Trade card ──────────────────────────────────── */
function TradeCard({ trade, stance }) {
  const isBuy  = stance === 'Bullish'
  const isHold = stance === 'Neutral'
  const actionColor = isBuy ? 'text-emerald-400' : isHold ? 'text-amber-400' : 'text-red-400'
  const borderColor = isBuy ? 'border-emerald-500/25' : isHold ? 'border-amber-500/25' : 'border-red-500/25'

  return (
    <div className={`glass rounded-xl p-5 border ${borderColor} space-y-4`}>
      <div className="flex items-center justify-between">
        <div>
          <div className={`text-2xl font-black tracking-tight ${actionColor}`}>{trade.action}</div>
          <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-1">
            <Clock className="w-3 h-3" /> {trade.holdingPeriod}
          </div>
        </div>
        {trade.riskReward && (
          <div className="text-right">
            <div className="text-xs text-slate-400">Risk/Reward</div>
            <div className={`text-xl font-bold font-mono ${trade.riskReward >= 2 ? 'text-emerald-400' : trade.riskReward >= 1.5 ? 'text-amber-400' : 'text-red-400'}`}>
              {trade.riskReward}:1
            </div>
          </div>
        )}
      </div>

      {/* Entry / Stop / Targets grid */}
      <div className="grid grid-cols-2 gap-3">
        <div className="glass-card space-y-0.5">
          <div className="text-[10px] text-slate-500 uppercase tracking-wide">Entry Zone</div>
          <div className="font-mono font-bold text-white text-sm">${fmt(trade.entryZone.low)} – ${fmt(trade.entryZone.high)}</div>
        </div>
        <div className="glass-card space-y-0.5 border border-red-500/15">
          <div className="text-[10px] text-red-400 uppercase tracking-wide">Stop-Loss</div>
          <div className="font-mono font-bold text-red-400 text-sm">${fmt(trade.stopLoss.price)}</div>
          <div className="text-[10px] text-slate-500">{trade.stopLoss.pct}% risk · {trade.stopLoss.rationale}</div>
        </div>
        {trade.targets.map((t, i) => (
          <div key={i} className="glass-card space-y-0.5 border border-emerald-500/15">
            <div className="text-[10px] text-emerald-400 uppercase tracking-wide">{t.label}</div>
            <div className="font-mono font-bold text-emerald-400 text-sm">${fmt(t.price)}</div>
            <div className="text-[10px] text-slate-500">+{t.pct}% from entry</div>
          </div>
        ))}
      </div>

      {/* Invalidation */}
      <div className="flex items-start gap-2 bg-red-500/5 border border-red-500/15 rounded-lg p-3">
        <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
        <div>
          <div className="text-[10px] text-red-400 font-semibold uppercase tracking-wide mb-0.5">Invalidation</div>
          <p className="text-xs text-slate-400">{trade.invalidation}</p>
        </div>
      </div>
    </div>
  )
}

/* ── Mini price chart with levels ───────────────── */
function MiniChart({ candles, trade, stance }) {
  if (!candles?.length) return null
  const data = candles.slice(-90).map(c => ({
    t: new Date(c.time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    price: c.close,
  }))
  const color = stance === 'Bullish' ? '#10b981' : stance === 'Bearish' ? '#ef4444' : '#f59e0b'
  const gradId = `rg-${stance}`

  return (
    <div className="glass rounded-xl p-4">
      <div className="text-xs text-slate-400 font-semibold mb-3">90-Day Price + Key Levels</div>
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.3} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis dataKey="t" tick={{ fill: '#475569', fontSize: 9 }} tickLine={false} interval={14} />
          <YAxis domain={['auto', 'auto']} tick={{ fill: '#475569', fontSize: 9 }} tickLine={false} tickFormatter={v => `$${fmt(v)}`} width={55} />
          <Tooltip
            formatter={v => [`$${fmt(v)}`, 'Price']}
            contentStyle={{ background: 'rgba(10,15,26,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 11 }}
            labelStyle={{ color: '#fff' }}
          />
          {trade?.targets?.[0] && (
            <ReferenceLine y={trade.targets[0].price} stroke="#10b981" strokeDasharray="4 4" strokeOpacity={0.7}
              label={{ value: `TP1 $${fmt(trade.targets[0].price)}`, fill: '#10b981', fontSize: 9, position: 'right' }} />
          )}
          {trade?.stopLoss && (
            <ReferenceLine y={trade.stopLoss.price} stroke="#ef4444" strokeDasharray="4 4" strokeOpacity={0.7}
              label={{ value: `SL $${fmt(trade.stopLoss.price)}`, fill: '#ef4444', fontSize: 9, position: 'right' }} />
          )}
          {trade?.entryZone && (
            <ReferenceLine y={trade.entryZone.low} stroke="#f59e0b" strokeDasharray="2 4" strokeOpacity={0.5}
              label={{ value: `Entry $${fmt(trade.entryZone.low)}`, fill: '#f59e0b', fontSize: 9, position: 'right' }} />
          )}
          <Area type="monotone" dataKey="price" stroke={color} strokeWidth={1.5}
            fill={`url(#${gradId})`} dot={false} activeDot={{ r: 3, fill: color }} />
        </AreaChart>
      </ResponsiveContainer>
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
