import { useState, useCallback } from 'react'
import { Brain, Shield, Target, Flame, Leaf, Search } from 'lucide-react'
import { fmt, fmtPct, fmtLarge, fetchSummary, fetchChart, calcRSI, calcSMA } from '../../services/api'
import { SectionCard, LoadingPulse } from '../shared/StockCard'
import { searchSymbol } from '../../services/api'

const PERSONAS = [
  {
    id: 'growth',
    name: 'Growth Hawk',
    icon: Flame,
    color: '#f59e0b',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/20',
    text: 'text-amber-400',
    desc: 'Aggressive growth — high-risk, high-reward momentum plays',
    style: 'Focuses on revenue growth >20%, expanding margins, and strong momentum signals.',
    weights: { revenueGrowth: 0.35, earningsGrowth: 0.25, momentum: 0.25, valuation: 0.05, stability: 0.10 },
  },
  {
    id: 'value',
    name: 'Value Seeker',
    icon: Target,
    color: '#10b981',
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/20',
    text: 'text-emerald-400',
    desc: 'Buffett-style deep value — underpriced quality businesses',
    style: 'Low P/E, strong free cash flow, durable moat, dividend track record.',
    weights: { revenueGrowth: 0.10, earningsGrowth: 0.10, momentum: 0.05, valuation: 0.50, stability: 0.25 },
  },
  {
    id: 'momentum',
    name: 'Momentum Trader',
    icon: TrendingUp2,
    color: '#6366f1',
    bg: 'bg-indigo-500/10',
    border: 'border-indigo-500/20',
    text: 'text-indigo-400',
    desc: 'Technical momentum — ride the trend until it bends',
    style: 'Looks for strong RSI (40–70), price above SMA50, and positive MACD crossover.',
    weights: { revenueGrowth: 0.10, earningsGrowth: 0.10, momentum: 0.55, valuation: 0.10, stability: 0.15 },
  },
  {
    id: 'defensive',
    name: 'Defensive Shield',
    icon: Shield,
    color: '#3b82f6',
    bg: 'bg-blue-500/10',
    border: 'border-blue-500/20',
    text: 'text-blue-400',
    desc: 'Capital preservation — low volatility, steady dividends',
    style: 'Beta < 1.0, consistent dividends, strong balance sheet, consumer staples / utilities.',
    weights: { revenueGrowth: 0.05, earningsGrowth: 0.10, momentum: 0.05, valuation: 0.20, stability: 0.60 },
  },
  {
    id: 'esg',
    name: 'ESG Conscious',
    icon: Leaf,
    color: '#00ffcc',
    bg: 'bg-mint-500/10',
    border: 'border-mint-500/20',
    text: 'text-mint-400',
    desc: 'Sustainable investing — quality companies with responsible practices',
    style: 'Balances financial performance with ESG scores, clean energy leaders, and governance quality.',
    weights: { revenueGrowth: 0.20, earningsGrowth: 0.15, momentum: 0.15, valuation: 0.20, stability: 0.30 },
  },
]

function TrendingUp2(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
      <polyline points="17 6 23 6 23 12" />
    </svg>
  )
}

// ETF/fund: no pe, no revenueGrowth, no earningsGrowth from fundamentals
function isEtfLike(summary) {
  return summary != null && summary.pe == null && summary.revenueGrowth == null && summary.earningsGrowth == null
}

function scoreForPersona(persona, summary, chartData) {
  const weights = persona.weights
  let score = 50
  const etf = isEtfLike(summary)

  if (summary && !etf) {
    // ── Stock scoring ──────────────────────────────────────────────────────
    const rg = (summary.revenueGrowth || 0) * 100
    const eg = (summary.earningsGrowth || 0) * 100
    score += rg * weights.revenueGrowth * 2
    score += eg * weights.earningsGrowth * 2

    const pe = summary.pe || 30
    const valScore = pe < 15 ? 20 : pe < 25 ? 10 : pe < 40 ? 0 : -10
    score += valScore * weights.valuation * 2

    const beta = summary.beta || 1
    const stabScore = beta < 0.7 ? 20 : beta < 1.0 ? 10 : beta < 1.5 ? 0 : -10
    score += stabScore * weights.stability * 2

    if (summary.dividendYield && weights.stability > 0.3) score += 5
  }

  if (summary && etf) {
    // ── ETF/fund scoring — use beta, yield, and 52w position ──────────────
    const beta = summary.beta ?? 1
    const dy   = (summary.dividendYield ?? 0)

    // Stability: low-beta ETFs score better for defensive/value
    const stabScore = beta < 0.6 ? 20 : beta < 0.85 ? 12 : beta < 1.1 ? 4 : beta < 1.4 ? -4 : -12
    score += stabScore * weights.stability * 2

    // Yield: dividend ETFs bonus for value/defensive personas
    if (dy > 0.03) score += 18 * weights.valuation
    else if (dy > 0.01) score += 8 * weights.valuation

    // 52-week position: proxy for trend strength (growth/momentum personas)
    if (summary.low52 != null && summary.high52 != null && chartData.length > 0) {
      const lastClose = chartData[chartData.length - 1].close
      const range52 = summary.high52 - summary.low52
      if (range52 > 0) {
        const pos = (lastClose - summary.low52) / range52   // 0 = at 52w low, 1 = at 52w high
        score += (pos * 24 - 8) * weights.momentum          // range: -8 to +16
      }
    }
  }

  // ── Technical momentum: applies to both stocks and ETFs ─────────────────
  if (chartData.length > 20) {
    const closes  = chartData.map(c => c.close)
    const rsiArr  = calcRSI(closes)
    const lastRSI = rsiArr[rsiArr.length - 1]
    const sma50   = calcSMA(closes, 50)
    const lastClose = closes[closes.length - 1]
    const lastSMA50 = sma50[sma50.length - 1]

    if (lastRSI !== null) {
      const momentumScore = lastRSI > 60 ? 15 : lastRSI > 45 ? 8 : lastRSI < 30 ? -10 : 0
      score += momentumScore * weights.momentum * 2
    }
    if (lastSMA50 && lastClose > lastSMA50) score += 10 * weights.momentum
  }

  return Math.min(100, Math.max(0, Math.round(score)))
}

function personaRecommendation(persona, score, summary) {
  const pe   = summary?.pe ?? null
  const beta = summary?.beta ?? 1
  const rg   = (summary?.revenueGrowth ?? 0) * 100
  const dy   = (summary?.dividendYield ?? 0) * 100
  const etf  = isEtfLike(summary)

  if (etf) {
    // ── ETF-specific recommendations ──────────────────────────────────────
    if (persona.id === 'growth') {
      if (score >= 68) return { action: 'Overweight', rationale: `Strong price momentum — ETF is near 52-week highs with bullish technical setup. Suitable for growth allocation.` }
      if (score >= 52) return { action: 'Buy', rationale: `Moderate upside momentum. Reasonable entry for a core growth position.` }
      if (score >= 38) return { action: 'Hold', rationale: `Sideways momentum. Wait for a technical breakout before adding.` }
      return { action: 'Underweight', rationale: `Weak momentum signals. Consider waiting for trend recovery above key moving averages.` }
    }
    if (persona.id === 'value') {
      if (dy > 3 && score >= 55) return { action: 'Buy', rationale: `High dividend yield (${dy.toFixed(1)}%) with stable trend. Good income-focused ETF position.` }
      if (dy > 1.5 && score >= 45) return { action: 'Buy', rationale: `Decent yield (${dy.toFixed(1)}%) with positive momentum. Solid all-weather ETF holding.` }
      if (score >= 48) return { action: 'Hold', rationale: `Low-yield ETF. Suitable only as a growth holding, not a value/income play.` }
      return { action: 'Underweight', rationale: `Below-average trend and minimal yield. Look for higher-conviction entry.` }
    }
    if (persona.id === 'momentum') {
      if (score >= 65) return { action: 'Buy', rationale: `Strong price momentum — RSI healthy and price above key moving averages. Ride the trend.` }
      if (score >= 48) return { action: 'Hold', rationale: `Mixed momentum. Set a price alert — enter on confirmed breakout above resistance.` }
      return { action: 'Sell', rationale: `Weak trend. ETF below key moving averages. Wait for momentum confirmation.` }
    }
    if (persona.id === 'defensive') {
      if (beta < 0.7 && score >= 55) return { action: 'Buy', rationale: `Low beta (${fmt(beta, 2)}) ETF with stable trend. Excellent defensive allocation.` }
      if (beta < 1.0) return { action: 'Hold', rationale: `Moderate defensiveness (beta ${fmt(beta, 2)}). Suitable as a partial hedge in volatile markets.` }
      return { action: 'Underweight', rationale: `High beta (${fmt(beta, 2)}) for a defensive allocation. Consider bond or utility ETFs instead.` }
    }
    if (persona.id === 'esg') {
      if (score >= 60) return { action: 'Buy', rationale: `Strong trend with reasonable yield. Check the fund's ESG screening methodology for alignment.` }
      if (score >= 45) return { action: 'Hold', rationale: `Neutral setup. Verify ESG ratings (MSCI, Sustainalytics) before increasing allocation.` }
      return { action: 'Hold', rationale: `Weak trend. Many ESG ETFs have lower volatility — this one needs more investigation.` }
    }
    return { action: 'Hold', rationale: 'Insufficient data for a strong conviction.' }
  }

  // ── Stock recommendations (existing logic) ────────────────────────────────
  if (persona.id === 'growth') {
    if (score >= 70) return { action: 'Buy', rationale: `High revenue growth (${rg.toFixed(1)}%) with strong momentum. Growth profile aligns well.` }
    if (score >= 50) return { action: 'Buy', rationale: `Moderate growth potential. Consider position sizing based on risk tolerance.` }
    if (score >= 35) return { action: 'Hold', rationale: `Growth slowing or valuation stretched. Watch for re-acceleration signals.` }
    return { action: 'Sell', rationale: `Does not meet growth criteria. Below-average revenue and earnings momentum.` }
  }
  if (persona.id === 'value') {
    if (pe != null && pe < 15 && score >= 60) return { action: 'Buy', rationale: `Low P/E (${fmt(pe)}×) with solid fundamentals. Classic value opportunity.` }
    if (pe != null && pe < 25 && score >= 50) return { action: 'Buy', rationale: `Reasonably valued at ${fmt(pe)}× earnings. Margin of safety present.` }
    if (pe != null && pe < 35) return { action: 'Hold', rationale: `Fairly valued. Wait for a better entry below ${fmt(pe * 0.85, 0)}×.` }
    if (pe == null && score >= 55) return { action: 'Hold', rationale: `No P/E data available. Use technical signals and sector context for sizing.` }
    return { action: 'Sell', rationale: pe != null ? `Expensive at ${fmt(pe)}× earnings. Value investors would require a significant pullback.` : `Insufficient fundamental data for value assessment.` }
  }
  if (persona.id === 'momentum') {
    if (score >= 65) return { action: 'Buy', rationale: `Strong technical momentum. Price above key moving averages with healthy RSI.` }
    if (score >= 45) return { action: 'Hold', rationale: `Mixed momentum signals. Set alerts for a breakout above resistance.` }
    return { action: 'Sell', rationale: `Weak momentum. Price below key moving averages — wait for trend reversal.` }
  }
  if (persona.id === 'defensive') {
    if (beta < 0.8 && score >= 55) return { action: 'Buy', rationale: `Low beta (${fmt(beta, 2)}) with stable earnings. Excellent defensive holding.` }
    if (beta < 1.1) return { action: 'Hold', rationale: `Moderate defensiveness. Suitable as a partial hedge position.` }
    return { action: 'Underweight', rationale: `Higher volatility (beta ${fmt(beta, 2)}) than ideal for defensive allocation.` }
  }
  if (persona.id === 'esg') {
    if (score >= 60) return { action: 'Buy', rationale: `Strong financial performance. Generally associated with responsible business practices.` }
    if (score >= 45) return { action: 'Hold', rationale: `Adequate profile. Research ESG ratings from MSCI or Sustainalytics for conviction.` }
    return { action: 'Hold', rationale: `Financial metrics need improvement. ESG leadership requires both financial and sustainability quality.` }
  }
  return { action: 'Hold', rationale: 'Insufficient data for strong conviction.' }
}

function taxAdvice(summary) {
  const advice = []
  const pe = summary?.pe
  const rg = (summary?.revenueGrowth || 0) * 100
  const dy = (summary?.dividendYield || 0) * 100

  if (dy > 2) {
    advice.push({ type: 'Dividend', tip: `${dy.toFixed(1)}% yield — hold in tax-advantaged accounts (IRA/401k) to defer dividend taxes.`, priority: 'high' })
  }
  advice.push({ type: 'Holding Period', tip: 'Hold > 1 year to qualify for long-term capital gains rate (0%, 15%, or 20% vs. ordinary income).', priority: 'medium' })
  if (rg > 20) {
    advice.push({ type: 'Tax-Loss Harvest', tip: 'High growth stocks can be volatile. Consider tax-loss harvesting pairs with similar ETFs during drawdowns.', priority: 'medium' })
  }
  advice.push({ type: 'Wash Sale Rule', tip: '30-day rule: avoid repurchasing same/substantially identical security within 30 days of selling at a loss.', priority: 'info' })
  if (pe && pe > 50) {
    advice.push({ type: 'Concentrated Risk', tip: 'High valuation stocks have higher drawdown risk. Consider options collars to limit downside tax exposure.', priority: 'medium' })
  }
  return advice
}

export default function AdvisoryView({ portfolio }) {
  const [symbol, setSymbol] = useState('')
  const [inputVal, setInputVal] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [showResults, setShowResults] = useState(false)
  const [summary, setSummary] = useState(null)
  const [chartData, setChartData] = useState([])
  const [scores, setScores] = useState({})
  const [recommendations, setRecommendations] = useState({})
  const [taxTips, setTaxTips] = useState([])
  const [loading, setLoading] = useState(false)
  const [activePersona, setActivePersona] = useState('growth')

  const analyze = useCallback(async (sym) => {
    setLoading(true)
    try {
      const [sum, chart] = await Promise.all([
        fetchSummary(sym),
        fetchChart(sym, '1d', '6mo').catch(() => ({ candles: [] }))
      ])
      setSummary(sum)
      setChartData(chart.candles || [])
      const sc = {}, rec = {}
      for (const p of PERSONAS) {
        sc[p.id] = scoreForPersona(p, sum, chart.candles || [])
        rec[p.id] = personaRecommendation(p, sc[p.id], sum)
      }
      setScores(sc)
      setRecommendations(rec)
      setTaxTips(taxAdvice(sum))
    } catch (e) { console.warn(e) }
    setLoading(false)
  }, [])

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
    analyze(sym)
  }

  const activeP = PERSONAS.find(p => p.id === activePersona)
  const taxColors = { high: 'text-amber-400', medium: 'text-blue-400', info: 'text-slate-400' }

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Search */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            value={inputVal}
            onChange={e => handleSearch(e.target.value)}
            onBlur={() => setTimeout(() => setShowResults(false), 200)}
            placeholder="Analyze any stock or ETF — e.g. NVDA, SPY, QQQ…"
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
        <Brain className="w-4 h-4 text-mint-400" />
        <span className="text-sm text-slate-400">5-Persona AI Advisory Engine</span>
      </div>

      {loading && <div className="glass rounded-xl p-6"><LoadingPulse rows={5} /></div>}

      {!loading && Object.keys(scores).length > 0 && (
        <div className="grid lg:grid-cols-3 gap-4">
          {/* Persona selector */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Select Advisor</h3>
            {PERSONAS.map(p => {
              const Icon = p.icon
              const s = scores[p.id] || 0
              const rec = recommendations[p.id]
              return (
                <button
                  key={p.id}
                  onClick={() => setActivePersona(p.id)}
                  className={`w-full text-left glass-card border transition-all
                    ${activePersona === p.id ? `${p.bg} ${p.border}` : 'border-transparent hover:border-white/[0.08]'}`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${p.bg}`}>
                      <Icon className={`w-4 h-4 ${p.text}`} style={{ color: p.color }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold text-white">{p.name}</span>
                        <span className={`text-xs font-semibold ${p.text}`}>{rec?.action}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <div className="flex-1 bg-white/[0.06] rounded-full h-1">
                          <div className="h-1 rounded-full transition-all" style={{ width: `${s}%`, background: p.color }} />
                        </div>
                        <span className="text-[10px] font-mono text-slate-500 w-7">{s}</span>
                      </div>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>

          {/* Active persona detail */}
          <div className="lg:col-span-2 space-y-4">
            {activeP && (
              <>
                <div className={`glass rounded-xl p-5 border ${activeP.border}`}>
                  <div className="flex items-start gap-4 mb-4">
                    <div className={`p-3 rounded-xl ${activeP.bg}`}>
                      <activeP.icon className="w-6 h-6" style={{ color: activeP.color }} />
                    </div>
                    <div>
                      <h3 className="text-base font-semibold text-white">{activeP.name}</h3>
                      <p className="text-sm text-slate-400 mt-0.5">{activeP.desc}</p>
                    </div>
                    <div className="ml-auto text-right">
                      <div className={`text-2xl font-bold font-mono ${activeP.text}`}>{scores[activeP.id]}</div>
                      <div className="text-xs text-slate-500">Score / 100</div>
                    </div>
                  </div>

                  <div className="glass rounded-lg p-4 mb-4">
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${activeP.bg} ${activeP.border} ${activeP.text}`}>
                        {recommendations[activeP.id]?.action}
                      </span>
                      <span className="text-xs text-slate-400">for {symbol}</span>
                    </div>
                    <p className="text-sm text-slate-300 leading-relaxed">{recommendations[activeP.id]?.rationale}</p>
                  </div>

                  <div className="text-xs text-slate-500 italic">Strategy: {activeP.style}</div>
                </div>

                {/* Fundamentals summary */}
                {summary && (() => {
                  const etf = isEtfLike(summary)
                  const rows = etf
                    ? [
                        { label: 'Beta', value: summary.beta ? fmt(summary.beta, 2) : '—' },
                        { label: 'Div Yield', value: summary.dividendYield ? fmtPct(summary.dividendYield * 100) : '—' },
                        { label: '52W High', value: summary.high52 ? `$${fmt(summary.high52)}` : '—' },
                        { label: '52W Low', value: summary.low52 ? `$${fmt(summary.low52)}` : '—' },
                        { label: 'Avg Volume', value: summary.avgVolume ? fmtLarge(summary.avgVolume) : '—' },
                        { label: 'Market Cap', value: summary.marketCap ? fmtLarge(summary.marketCap) : '—' },
                      ]
                    : [
                        { label: 'P/E', value: summary.pe ? fmt(summary.pe) + '×' : '—' },
                        { label: 'EPS', value: summary.eps ? `$${fmt(summary.eps)}` : '—' },
                        { label: 'Beta', value: summary.beta ? fmt(summary.beta, 2) : '—' },
                        { label: 'Rev Growth', value: summary.revenueGrowth ? fmtPct(summary.revenueGrowth * 100) : '—' },
                        { label: 'Profit Margin', value: summary.profitMargin ? fmtPct(summary.profitMargin * 100) : '—' },
                        { label: 'Div Yield', value: summary.dividendYield ? fmtPct(summary.dividendYield * 100) : '—' },
                      ]
                  return (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {rows.map(s => (
                        <div key={s.label} className="glass-card">
                          <div className="stat-label">{s.label}</div>
                          <div className="text-base font-mono font-semibold text-white mt-0.5">{s.value}</div>
                        </div>
                      ))}
                    </div>
                  )
                })()}
              </>
            )}
          </div>
        </div>
      )}

      {/* Tax-aware recommendations */}
      {taxTips.length > 0 && (
        <SectionCard title="Tax-Aware Recommendations">
          <div className="grid sm:grid-cols-2 gap-3">
            {taxTips.map((tip, i) => (
              <div key={i} className="glass rounded-lg p-3">
                <div className={`text-xs font-semibold mb-1 ${taxColors[tip.priority]}`}>{tip.type}</div>
                <div className="text-xs text-slate-400 leading-relaxed">{tip.tip}</div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {!loading && !symbol && (
        <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
          <Brain className="w-10 h-10 text-mint-400 opacity-60" />
          <div className="text-base font-semibold text-white">5-Persona Advisory Engine</div>
          <div className="text-sm text-slate-500 max-w-md">
            Search for any stock or ETF to get personalized recommendations from five distinct investment personas —
            Growth Hawk, Value Seeker, Momentum Trader, Defensive Shield, and ESG Conscious.
          </div>
          <div className="mt-2 space-y-2">
            <div className="text-[10px] text-slate-600 uppercase tracking-wider">Stocks</div>
            <div className="flex flex-wrap gap-2 justify-center">
              {['AAPL', 'MSFT', 'NVDA', 'TSLA', 'XOM', 'JPM'].map(s => (
                <button key={s} onClick={() => handleSelect(s)}
                  className="px-3 py-1.5 text-xs glass-card border border-white/[0.08] text-mint-400 font-mono hover:border-mint-500/30 transition-all">
                  {s}
                </button>
              ))}
            </div>
            <div className="text-[10px] text-slate-600 uppercase tracking-wider mt-1">ETFs</div>
            <div className="flex flex-wrap gap-2 justify-center">
              {['SPY', 'QQQ', 'VTI', 'SCHD', 'GLD', 'TLT'].map(s => (
                <button key={s} onClick={() => handleSelect(s)}
                  className="px-3 py-1.5 text-xs glass-card border border-white/[0.08] text-purple-400 font-mono hover:border-purple-500/30 transition-all">
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
