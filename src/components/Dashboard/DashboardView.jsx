/**
 * FinSurf Dashboard — Modern trading command center
 * Portfolio heatmap · Fear & Greed · Sector performance · AI scan · Risk analysis
 */
import { useState, useEffect, useMemo, useCallback } from 'react'
import { motion } from 'motion/react'
import {
  TrendingUp, Activity, Shield, BarChart2,
  Zap, RefreshCw, Layers, Newspaper,
} from 'lucide-react'
import { fetchQuotes } from '../../services/api'
import { calcFearGreed, calcSectorPerformance } from '../../services/forecast'
import { scanPortfolio } from '../../services/aiEngine'
import SentimentPulseWidget from '../Sentiment/SentimentPulseWidget'
import FearGreedGauge from './widgets/FearGreedGauge'
import PortfolioHeatmap from './widgets/PortfolioHeatmap'
import SectorBars from './widgets/SectorBars'
import MarketMovers from './widgets/MarketMovers'
import PortfolioRisk from './widgets/PortfolioRisk'
import QuickSignals from './widgets/QuickSignals'
import MarketOverview from './widgets/MarketOverview'
import MarketNewsFeed from './widgets/MarketNewsFeed'

/* ── Main DashboardView ──────────────────────── */
export default function DashboardView({ portfolio, onAnalyze }) {
  const [scan,           setScan]           = useState(null)
  const [scanning,       setScanning]       = useState(false)
  const [vixPrice,       setVixPrice]       = useState(null)
  const [refreshing,     setRefreshing]     = useState(false)
  const [newsRefreshKey, setNewsRefreshKey] = useState(0)

  const positions = portfolio?.positions ?? []
  const quotes    = portfolio?.quotes    ?? {}
  const quotesArr = useMemo(() => Object.values(quotes), [quotes])

  /* Fetch VIX on mount */
  useEffect(() => {
    fetchQuotes(['^VIX']).then(data => {
      if (data?.[0]?.price) setVixPrice(data[0].price)
    }).catch(() => {})
  }, [])

  /* Manual refresh — reloads quotes, VIX, and AI scan */
  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    setScan(null)
    try {
      await Promise.all([
        portfolio?.refresh?.(),
        fetchQuotes(['^VIX'], { force: true }).then(data => {
          if (data?.[0]?.price) setVixPrice(data[0].price)
        }).catch(() => {}),
      ])
      setNewsRefreshKey(k => k + 1)
    } finally {
      setRefreshing(false)
    }
  }, [portfolio])

  /* Derived data */
  const fg         = useMemo(() => calcFearGreed(quotesArr, vixPrice), [quotesArr, vixPrice])
  const sectorPerf = useMemo(() => calcSectorPerformance(quotes, positions), [quotes, positions])

  /* Portfolio totals */
  const totals = useMemo(() => {
    let totalCost = 0, totalValue = 0, todayGL = 0, upCount = 0, dnCount = 0
    positions.forEach(p => {
      const q     = quotes[p.symbol]
      const price = q?.price ?? p.avgCost
      totalCost  += p.avgCost * p.shares
      totalValue += price * p.shares
      // Only count today's move when the quote timestamp is from today's date
      const prevClose  = q?.prevClose ?? null
      const marketTime = q?.marketTime ?? null
      // No timestamp → treat as stale so daily P&L resets at midnight
      const isToday    = marketTime
        ? new Date(marketTime * 1000).toDateString() === new Date().toDateString()
        : false
      const dayMove = isToday
        ? (price !== null && prevClose !== null ? price - prevClose : q?.change ?? null)
        : 0   // reset to zero between sessions
      if (dayMove != null) {
        todayGL += dayMove * p.shares
        if (dayMove > 0) upCount++
        else if (dayMove < 0) dnCount++
      }
    })
    return {
      totalValue, totalCost, todayGL,
      totalGL:    totalValue - totalCost,
      totalGLPct: totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0,
      upCount, dnCount,
    }
  }, [positions, quotes])

  /* Auto-scan when data loads */
  const runScan = useCallback(async () => {
    if (!positions.length) return
    setScanning(true)
    try {
      const results = await scanPortfolio({ positions, quotes })
      setScan(results)
    } finally { setScanning(false) }
  }, [positions, quotes])

  useEffect(() => {
    if (positions.length > 0 && quotesArr.length > 0 && !scan && !scanning) {
      runScan()
    }
  }, [positions.length, quotesArr.length])  // eslint-disable-line

  const glColor   = totals.totalGL  >= 0 ? 'text-emerald-400' : 'text-red-400'
  const todayColor= totals.todayGL  >= 0 ? 'text-emerald-400' : 'text-red-400'

  return (
    <div className="space-y-5 animate-fade-in">

      {/* ── Header row with refresh ── */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-white">Dashboard</h2>
        <button
          onClick={handleRefresh}
          disabled={refreshing || portfolio?.loading}
          className="btn-ghost flex items-center gap-1.5 text-xs py-1.5 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing || portfolio?.loading ? 'animate-spin' : ''}`} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* ── Summary stats ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <motion.div className="glass-card"
          initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0, ease: 'easeOut' }}>
          <div className="text-xs text-slate-500 mb-1">Portfolio Value</div>
          <div className="text-2xl font-black font-mono text-white">
            ${totals.totalValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}
          </div>
          <div className={`text-xs font-mono font-semibold mt-0.5 ${glColor}`}>
            {totals.totalGL >= 0 ? '+' : ''}${Math.abs(totals.totalGL).toFixed(0)}{' '}
            ({totals.totalGLPct >= 0 ? '+' : ''}{totals.totalGLPct.toFixed(2)}%) all-time
          </div>
        </motion.div>

        <motion.div className="glass-card"
          initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.07, ease: 'easeOut' }}>
          <div className="text-xs text-slate-500 mb-1">Today's P/L</div>
          <div className={`text-2xl font-black font-mono ${todayColor}`}>
            {totals.todayGL >= 0 ? '+' : ''}${Math.abs(totals.todayGL).toFixed(0)}
          </div>
          <div className="text-[10px] text-slate-600 mt-0.5">
            {totals.upCount}↑ {totals.dnCount}↓ vs. prior close
          </div>
        </motion.div>

        <motion.div className="glass-card"
          initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.14, ease: 'easeOut' }}>
          <div className="text-xs text-slate-500 mb-1">Fear & Greed</div>
          <div className="flex items-center gap-2 mt-1">
            <div className="text-2xl font-black font-mono text-white">{fg?.score ?? '—'}</div>
            {fg && (
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full border"
                style={{ color: fg.color, borderColor: fg.color + '50', background: fg.color + '18' }}>
                {fg.label}
              </span>
            )}
          </div>
        </motion.div>

        <motion.div className="glass-card"
          initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.21, ease: 'easeOut' }}>
          <div className="text-xs text-slate-500 mb-1">Market Breadth</div>
          <div className="text-2xl font-black font-mono text-white">{totals.upCount}/{positions.length}</div>
          <div className="text-[10px] text-slate-600 mt-0.5">holdings advancing today</div>
        </motion.div>
      </div>

      {/* ── Market Overview strip ── */}
      <MarketOverview />

      {/* ── Heatmap + Fear & Greed ── */}
      <div className="grid xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2 glass rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Layers className="w-3.5 h-3.5 text-mint-400" /> Portfolio Heatmap
            </h3>
            <div className="flex items-center gap-3">
              {portfolio?.lastUpdated && (
                <span className="text-[10px] text-slate-600 hidden sm:inline">
                  Updated {portfolio.lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              )}
              <button
                onClick={handleRefresh}
                disabled={refreshing || portfolio?.loading}
                className="btn-ghost flex items-center gap-1 text-xs py-1 px-2 disabled:opacity-50"
                title="Refresh prices"
              >
                <RefreshCw className={`w-3 h-3 ${refreshing || portfolio?.loading ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">Refresh</span>
              </button>
              <span className="text-[10px] text-slate-600 hidden md:inline">Click tile to analyze · Color = day %</span>
            </div>
          </div>
          <PortfolioHeatmap positions={positions} quotes={quotes} onAnalyze={onAnalyze} />
        </div>

        <div className="glass rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2 mb-3">
            <Activity className="w-3.5 h-3.5 text-mint-400" /> Fear & Greed Index
          </h3>
          <FearGreedGauge fg={fg} />
          {vixPrice && (
            <div className="text-center text-[10px] text-slate-600 mt-2">
              VIX: {vixPrice.toFixed(2)} · {vixPrice < 15 ? 'Low volatility' : vixPrice < 25 ? 'Normal range' : 'Elevated fear'}
            </div>
          )}
        </div>
      </div>

      {/* ── Sector Performance + Market Movers ── */}
      <div className="grid xl:grid-cols-2 gap-4">
        <div className="glass rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2 mb-4">
            <BarChart2 className="w-3.5 h-3.5 text-mint-400" /> Sector Performance
          </h3>
          <SectorBars data={sectorPerf} />
        </div>

        <div className="glass rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2 mb-4">
            <TrendingUp className="w-3.5 h-3.5 text-mint-400" /> Market Movers
          </h3>
          <MarketMovers positions={positions} quotes={quotes} />
        </div>
      </div>

      {/* ── AI Signals + Risk Analysis ── */}
      <div className="grid xl:grid-cols-2 gap-4">
        <div className="glass rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2 mb-4">
            <Zap className="w-3.5 h-3.5 text-mint-400" /> AI Signal Scan
            <span className="ml-auto text-[10px] text-slate-600 font-normal">from live quote data</span>
          </h3>
          <QuickSignals scan={scan} loading={scanning} onScan={runScan} />
        </div>

        <div className="glass rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2 mb-4">
            <Shield className="w-3.5 h-3.5 text-mint-400" /> Portfolio Risk Analysis
          </h3>
          <PortfolioRisk positions={positions} quotes={quotes} />
        </div>
      </div>

      {/* ── Market News ── */}
      <div className="glass rounded-xl p-4">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2 mb-3">
          <Newspaper className="w-3.5 h-3.5 text-mint-400" /> Latest Market News
          <span className="ml-auto text-[10px] text-slate-600 font-normal">via Finnhub</span>
        </h3>
        <MarketNewsFeed refreshKey={newsRefreshKey} />
      </div>

      {/* ── News Sentiment Pulse ── */}
      {positions.length > 0 && (
        <SentimentPulseWidget symbols={positions.map(p => p.symbol)} />
      )}

      {/* Disclaimer */}
      <div className="text-center text-[11px] text-slate-600 border-t border-white/[0.04] pt-3">
        Beta values are sector proxies. Fear & Greed derived from portfolio breadth + VIX. ·
        <strong> Not financial advice.</strong>
      </div>
    </div>
  )
}
