import { useState, useCallback } from 'react'
import {
  Search, Zap, RefreshCw, AlertTriangle,
  BarChart2, Clock, Cpu, Radio,
} from 'lucide-react'
import { fetchChart, fetchSummary, fetchQuotes, searchSymbol, fmt, fmtPct } from '../../services/api'
import { generateAIAdvisory, SIGNAL_TYPES } from '../../services/aiEngine'
import { generateForecast } from '../../services/forecast'
import { SignalBadge, ConfidenceRing, FactorBar, HorizonCard, FactorRadar } from './advisory/AdvisoryWidgets'
import PriceChart from './advisory/PriceChart'
import PortfolioScanTab from './advisory/PortfolioScanTab'
import ForecastPanel from './advisory/ForecastPanel'

/* ── Main AIAdvisoryView ─────────────────────────── */
export default function AIAdvisoryView({ portfolio }) {
  const [tab,       setTab]       = useState('research')
  const [query,     setQuery]     = useState('')
  const [results,   setResults]   = useState([])
  const [loading,   setLoading]   = useState(false)
  const [advisory,  setAdvisory]  = useState(null)
  const [candles,   setCandles]   = useState(null)
  const [forecast,  setForecast]  = useState(null)
  const [error,     setError]     = useState(null)
  const [activeH,   setActiveH]   = useState(1)  // default swing
  const [searching, setSearching] = useState(false)

  const portfolioSymbols = portfolio?.positions?.map(p => p.symbol) ?? []
  const allSymbols = [...new Set([...portfolioSymbols,
    'AAPL','NVDA','MSFT','TSLA','AMZN','GOOG','META','AMD','SPY','QQQ'])]

  const handleSearch = async (q) => {
    setQuery(q)
    if (!q.trim() || q.length < 2) { setResults([]); return }
    setSearching(true)
    try { setResults((await searchSymbol(q)).slice(0, 5)) } catch {}
    setSearching(false)
  }

  const analyze = useCallback(async (sym) => {
    if (!sym) return
    const s = sym.toUpperCase()
    setQuery(s); setResults([]); setLoading(true); setError(null); setAdvisory(null); setCandles(null); setForecast(null)

    try {
      const [daily, weekly, qs, fund, newsData] = await Promise.allSettled([
        fetchChart(s, '1d', '1y'),
        fetchChart(s, '1wk', '2y'),
        fetchQuotes([s]),
        fetchSummary(s),
        fetch(`/api/news?symbol=${s}`).then(r => r.json()),
      ])

      const chartD = daily.value
      if (!chartD?.candles?.length)
        throw new Error(`No price history for ${s}. None of the configured data providers carry this symbol — it may be illiquid, recently listed, delisted, or non-US. A TradingView chart can still render it, but the Advisory engine needs historical bars.`)

      setCandles(chartD.candles)
      const quote      = daily.status === 'fulfilled' ? qs.value?.[0] ?? null : null
      const weeklyC    = weekly.status === 'fulfilled' ? weekly.value?.candles : null
      const fundamentals = fund.status === 'fulfilled' ? fund.value : null
      const headlines  = newsData.status === 'fulfilled' ? (newsData.value?.news ?? []) : []
      const position   = portfolio?.positions?.find(p => p.symbol === s)

      const adv = await generateAIAdvisory({
        symbol: s, candles: chartD.candles, weeklyCandles: weeklyC,
        quote, fundamentals, headlines, position,
      })
      if (adv.error) throw new Error(adv.error)
      setAdvisory(adv)
      // Generate ML forecast in parallel (non-blocking)
      try {
        const fc = generateForecast(chartD.candles, qs.value?.[0] ?? null, adv.sentiment?.score ?? 0)
        setForecast(fc)
      } catch (_) {}
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [portfolio])

  return (
    <div className="space-y-5 animate-fade-in">
      {/* ── Tabs ── */}
      <div className="flex items-center gap-2 border-b border-white/[0.06] pb-0">
        {[
          { id: 'research', label: 'AI Research', icon: <Cpu className="w-3.5 h-3.5" /> },
          { id: 'scan',     label: 'Portfolio Scan', icon: <Radio className="w-3.5 h-3.5" /> },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-all
              ${tab === t.id ? 'border-mint-500 text-mint-400' : 'border-transparent text-slate-400 hover:text-white'}`}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {/* ── Portfolio Scan tab ── */}
      {tab === 'scan' && <PortfolioScanTab portfolio={portfolio} />}

      {/* ── Research tab ── */}
      {tab === 'research' && (
        <div className="space-y-5">
          {/* Search bar */}
          <div className="glass rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2 mb-1">
              <Cpu className="w-4 h-4 text-mint-400 animate-pulse" />
              <span className="text-sm font-semibold text-white">AI Advisory Engine</span>
              <span className="text-xs text-slate-600">5-factor ensemble · technical + fundamental + sentiment + analyst + multi-timeframe</span>
            </div>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <input value={query} onChange={e => handleSearch(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && query && analyze(query)}
                  placeholder="Ticker or company…" className="input pl-9 w-full font-mono" />
                {results.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1 z-30 glass border border-white/[0.08] rounded-xl overflow-hidden shadow-2xl">
                    {results.map(r => (
                      <button key={r.symbol} onClick={() => analyze(r.symbol)}
                        className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.06] text-left">
                        <span className="font-mono font-bold text-mint-400 w-14 text-sm">{r.symbol}</span>
                        <span className="text-sm text-slate-300 truncate flex-1">{r.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button onClick={() => query && analyze(query)} disabled={loading || !query}
                className="btn-primary flex items-center gap-1.5 shrink-0">
                {loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                Analyze
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {[...portfolioSymbols.slice(0,8),'SPY','QQQ'].map(s => (
                <button key={s} onClick={() => analyze(s)}
                  className="px-2.5 py-1 glass rounded-md text-xs font-mono text-slate-400 hover:text-mint-400 border border-white/[0.06] hover:border-mint-500/30 transition-all">
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Loading */}
          {loading && (
            <div className="glass rounded-xl p-10 flex flex-col items-center gap-4">
              <div className="grid grid-cols-5 gap-2">
                {['📊 Technical','📋 Fundamental','📰 Sentiment','🎯 Analyst','⏱ Multi-TF'].map((s, i) => (
                  <div key={i} className="text-center space-y-1.5">
                    <div className="w-8 h-8 glass rounded-full mx-auto animate-pulse flex items-center justify-center text-base">
                      {s.split(' ')[0]}
                    </div>
                    <div className="text-[9px] text-slate-600">{s.split(' ')[1]}</div>
                  </div>
                ))}
              </div>
              <p className="text-slate-400 text-sm">Running 5-factor ensemble analysis…</p>
            </div>
          )}

          {error && (
            <div className="glass rounded-xl p-6 border border-red-500/20 flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 text-red-400 shrink-0" />
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          {/* ── Advisory Report ── */}
          {advisory && !loading && (() => {
            const cfg = SIGNAL_TYPES[advisory.signal] || SIGNAL_TYPES.HOLD
            return (
              <div className="space-y-4">

                {/* ── Header card ── */}
                <div className={`glass rounded-xl p-5 border ${cfg.border}`}>
                  <div className="flex flex-col sm:flex-row gap-5 sm:items-start">
                    <div className="flex-1 space-y-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="font-mono font-black text-white text-2xl">{advisory.symbol}</span>
                        <span className="text-slate-400">{advisory.name}</span>
                        <SignalBadge type={advisory.signal} size="lg" />
                      </div>
                      <div className="flex items-center gap-4 flex-wrap">
                        <span className="font-mono font-black text-white text-2xl">${fmt(advisory.price)}</span>
                        {advisory.quote?.change != null && (
                          <span className={`font-mono font-semibold text-lg ${advisory.quote.change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {advisory.quote.change >= 0 ? '+' : ''}{fmtPct(advisory.quote.changePct)}
                          </span>
                        )}
                        {advisory.gainPct != null && (
                          <span className={`text-sm font-semibold px-2 py-0.5 rounded-md border ${advisory.gainPct >= 0 ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20'}`}>
                            Position: {advisory.gainPct >= 0 ? '+' : ''}{advisory.gainPct}%
                          </span>
                        )}
                      </div>
                      {/* Ensemble score bar */}
                      <div className="space-y-1 max-w-md">
                        <div className="flex justify-between text-xs text-slate-400">
                          <span>Ensemble Score</span>
                          <span className="font-mono font-bold" style={{ color: cfg.color }}>{advisory.ensembleScore}/10</span>
                        </div>
                        <div className="h-3 bg-white/[0.06] rounded-full overflow-hidden">
                          <div className="h-full rounded-full transition-all duration-700"
                            style={{ width: `${(advisory.ensembleScore/10)*100}%`, background: cfg.color }} />
                        </div>
                        <div className="flex justify-between text-[9px] text-slate-600">
                          <span>Strong Sell</span><span>Sell</span><span>Hold</span><span>Buy</span><span>Strong Buy</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-col items-center gap-2">
                      <ConfidenceRing pct={advisory.confidencePct} type={advisory.signal} />
                      {advisory.backtest && (
                        <div className="text-center">
                          <div className="text-xs text-slate-500">Signal backtest</div>
                          <div className={`text-sm font-bold ${advisory.backtest.hitRate > 60 ? 'text-emerald-400' : advisory.backtest.hitRate > 45 ? 'text-amber-400' : 'text-red-400'}`}>
                            {advisory.backtest.hitRate}% hit rate
                          </div>
                          <div className="text-[10px] text-slate-600">{advisory.backtest.wins}W / {advisory.backtest.losses}L</div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="grid xl:grid-cols-2 gap-4">
                  {/* Left column */}
                  <div className="space-y-4">

                    {/* ── Ensemble model breakdown ── */}
                    <div className="glass rounded-xl p-5 space-y-3">
                      <h3 className="font-semibold text-white flex items-center gap-2 text-sm">
                        <Cpu className="w-3.5 h-3.5 text-mint-400" /> 5-Factor Ensemble Model
                      </h3>
                      {advisory.factors.map((f, i) => <FactorBar key={i} factor={f} />)}
                      <FactorRadar factors={advisory.factors} />
                    </div>

                    {/* ── Patterns ── */}
                    {advisory.patterns.length > 0 && (
                      <div className="glass rounded-xl p-4 space-y-2">
                        <h3 className="font-semibold text-white text-sm flex items-center gap-2">
                          <BarChart2 className="w-3.5 h-3.5 text-mint-400" /> Detected Chart Patterns
                        </h3>
                        {advisory.patterns.map((p, i) => (
                          <div key={i} className={`flex items-start gap-3 p-3 rounded-lg border ${
                            p.type === 'bullish' ? 'bg-emerald-500/5 border-emerald-500/15' :
                            p.type === 'bearish' ? 'bg-red-500/5 border-red-500/15' :
                            'bg-amber-500/5 border-amber-500/15'
                          }`}>
                            <div className="w-5 h-5 rounded flex items-center justify-center text-xs shrink-0 mt-0.5"
                              style={{ background: p.type === 'bullish' ? '#10b98120' : '#ef444420' }}>
                              {p.type === 'bullish' ? '↑' : p.type === 'bearish' ? '↓' : '↔'}
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-bold text-white">{p.name}</span>
                                <div className="flex gap-0.5">
                                  {[...Array(Math.round(p.strength/2))].map((_,j) => (
                                    <div key={j} className="w-1.5 h-1.5 rounded-full"
                                      style={{ background: p.type === 'bullish' ? '#10b981' : '#ef4444' }} />
                                  ))}
                                </div>
                              </div>
                              <p className="text-xs text-slate-400 mt-0.5">{p.desc}</p>
                            </div>
                          </div>
                        ))}
                        {advisory.divergence && (
                          <div className={`flex items-start gap-3 p-3 rounded-lg border ${
                            advisory.divergence.type === 'Bullish Divergence' ? 'bg-emerald-500/5 border-emerald-500/15' : 'bg-red-500/5 border-red-500/15'
                          }`}>
                            <span className="text-base">🔀</span>
                            <div>
                              <div className="text-xs font-bold text-white">{advisory.divergence.type}</div>
                              <p className="text-xs text-slate-400 mt-0.5">{advisory.divergence.desc}</p>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* ── Sentiment ── */}
                    <div className="glass rounded-xl p-4 space-y-3">
                      <h3 className="font-semibold text-white text-sm flex items-center justify-between">
                        <span className="flex items-center gap-2">📰 News Sentiment</span>
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${
                          advisory.sentiment.score > 1 ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                          advisory.sentiment.score < -1 ? 'bg-red-500/10 text-red-400 border-red-500/20' :
                          'bg-amber-500/10 text-amber-400 border-amber-500/20'
                        }`}>{advisory.sentiment.label}</span>
                      </h3>
                      <div className="grid grid-cols-3 gap-2 text-center text-xs">
                        <div className="glass-card">
                          <div className="text-slate-500">Articles</div>
                          <div className="font-bold text-white">{advisory.sentiment.articles}</div>
                        </div>
                        <div className="glass-card">
                          <div className="text-emerald-400">Bullish</div>
                          <div className="font-bold text-emerald-400">{advisory.sentiment.bullCount}</div>
                        </div>
                        <div className="glass-card">
                          <div className="text-red-400">Bearish</div>
                          <div className="font-bold text-red-400">{advisory.sentiment.bearCount}</div>
                        </div>
                      </div>
                      {advisory.sentiment.headlines?.filter(h => h.sentimentScore !== 0).slice(0, 4).map((h, i) => (
                        <div key={i} className="flex items-start gap-2 text-xs">
                          <span className={h.sentimentScore > 0 ? 'text-emerald-400' : 'text-red-400'}>
                            {h.sentimentScore > 0 ? '▲' : '▼'}
                          </span>
                          <span className="text-slate-400 leading-relaxed line-clamp-2">{h.title}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Right column */}
                  <div className="space-y-4">

                    {/* ── Price chart ── */}
                    <div className="glass rounded-xl p-4">
                      <div className="text-xs text-slate-400 font-semibold mb-3 flex items-center justify-between">
                        <span>90-Day Price Chart</span>
                        <span className="text-[10px] text-slate-600">Swing TP / SL reference lines</span>
                      </div>
                      <PriceChart candles={candles} advisory={advisory} />
                    </div>

                    {/* ── Time horizon setups ── */}
                    <div className="space-y-2">
                      <h3 className="font-semibold text-white text-sm flex items-center gap-2">
                        <Clock className="w-3.5 h-3.5 text-mint-400" /> Trade Setup by Time Horizon
                      </h3>
                      <div className="grid grid-cols-3 gap-2">
                        {advisory.horizons.map((h, i) => (
                          <HorizonCard key={i} h={h} active={activeH === i} onClick={() => setActiveH(i)} />
                        ))}
                      </div>
                    </div>

                    {/* ── Key levels ── */}
                    <div className="glass rounded-xl p-4">
                      <h3 className="font-semibold text-white text-sm mb-3 flex items-center gap-2">
                        🎯 Key Price Levels
                      </h3>
                      <div className="grid grid-cols-2 gap-4 text-xs">
                        <div>
                          <div className="text-emerald-400 font-semibold mb-2">Support</div>
                          {advisory.keyLevels.support.slice(0, 4).map((s, i) => (
                            <div key={i} className="flex justify-between py-1 border-b border-white/[0.04]">
                              <span className="text-slate-500">S{i+1}</span>
                              <span className="font-mono text-emerald-400">${s.toFixed(2)}</span>
                              <span className="text-slate-600">{(((s-advisory.price)/advisory.price)*100).toFixed(1)}%</span>
                            </div>
                          ))}
                        </div>
                        <div>
                          <div className="text-red-400 font-semibold mb-2">Resistance</div>
                          {advisory.keyLevels.resistance.slice(0, 4).map((r, i) => (
                            <div key={i} className="flex justify-between py-1 border-b border-white/[0.04]">
                              <span className="text-slate-500">R{i+1}</span>
                              <span className="font-mono text-red-400">${r.toFixed(2)}</span>
                              <span className="text-slate-600">+{(((r-advisory.price)/advisory.price)*100).toFixed(1)}%</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* ── Multi-timeframe alignment ── */}
                    <div className="glass rounded-xl p-4 space-y-2">
                      <h3 className="font-semibold text-white text-sm flex items-center justify-between">
                        <span className="flex items-center gap-2">⏱ Multi-Timeframe Alignment</span>
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${
                          advisory.mtf.aligned === 'All Bullish' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                          advisory.mtf.aligned === 'All Bearish' ? 'bg-red-500/10 text-red-400 border-red-500/20' :
                          advisory.mtf.aligned === 'Conflicting' ? 'bg-red-500/10 text-red-400 border-red-500/20' :
                          'bg-amber-500/10 text-amber-400 border-amber-500/20'
                        }`}>{advisory.mtf.aligned}</span>
                      </h3>
                      {advisory.mtf.details.map((d, i) => (
                        <div key={i} className="flex items-center justify-between text-xs">
                          <span className="text-slate-400">{d.label}</span>
                          <div className="flex items-center gap-3">
                            <span className="text-slate-500">RSI {d.rsi ?? '—'}</span>
                            <span className="text-slate-500">MACD {d.macd ?? '—'}</span>
                            <span className={`font-semibold ${d.trend === 'Bullish' ? 'text-emerald-400' : d.trend === 'Bearish' ? 'text-red-400' : 'text-amber-400'}`}>
                              {d.trend}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* ── ML Forecast section ── */}
                {forecast && <ForecastPanel forecast={forecast} symbol={advisory.symbol} />}

                {/* Compliance */}
                <div className="text-center text-xs text-slate-600 border-t border-white/[0.04] pt-3">
                  Generated {advisory.generatedAt?.toLocaleString()} · Yahoo Finance data ·
                  Sentiment from keyword analysis · Backtest is historical, not forward-looking ·
                  Forecasts are statistical projections, not guarantees ·
                  <strong> Not financial advice.</strong> All analysis is inference, not certainty.
                </div>
              </div>
            )
          })()}
        </div>
      )}
    </div>
  )
}
