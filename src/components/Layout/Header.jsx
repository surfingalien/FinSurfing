import { useState, useEffect } from 'react'
import { RefreshCw, TrendingUp, Activity } from 'lucide-react'
import { fetchQuotes } from '../../services/api'
import { TICKER_SYMBOLS } from '../../data/portfolio'
import { fmt, fmtPct } from '../../services/api'

export default function Header({ activeTab, onTabChange }) {
  const [tickerData, setTickerData] = useState([])
  const [time, setTime] = useState(new Date())
  const [marketOpen, setMarketOpen] = useState(false)

  const tabs = [
    { id: 'portfolio',       label: 'Portfolio',    icon: '◈' },
    { id: 'watchlist',       label: 'Watchlist',    icon: '◉' },
    { id: 'analyze',         label: 'Analyze',      icon: '◆' },
    { id: 'recommendations', label: 'Advisory',     icon: '◇' },
    { id: 'montecarlo',      label: 'Retirement',   icon: '◎' },
    { id: 'screener',        label: 'Screener',     icon: '◈' },
    { id: 'strategies',      label: 'Strategies',   icon: '▣' },
  ]

  useEffect(() => {
    const t = setInterval(() => {
      const now = new Date()
      setTime(now)
      const day = now.getDay()
      const h = now.getHours(), m = now.getMinutes()
      const mins = h * 60 + m
      setMarketOpen(day >= 1 && day <= 5 && mins >= 570 && mins < 960)
    }, 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const load = async () => {
      try {
        const data = await fetchQuotes(TICKER_SYMBOLS)
        setTickerData(data)
      } catch {}
    }
    load()
    const t = setInterval(load, 60000)
    return () => clearInterval(t)
  }, [])

  const tickerContent = [...tickerData, ...tickerData].map((q, i) => (
    <span key={i} className="inline-flex items-center gap-2 mr-8 shrink-0">
      <span className="font-semibold text-white font-mono text-xs">{q.symbol}</span>
      <span className="font-mono text-xs text-slate-300">${fmt(q.price)}</span>
      <span className={`text-xs font-mono ${(q.changePct || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
        {fmtPct(q.changePct)}
      </span>
    </span>
  ))

  return (
    <header className="sticky top-0 z-50">
      {/* Ticker bar */}
      <div className="bg-surface-300/80 backdrop-blur border-b border-white/[0.06] overflow-hidden h-8 flex items-center">
        <div className="shrink-0 px-3 text-[10px] font-semibold text-mint-500 border-r border-white/[0.06] h-full flex items-center bg-surface-400/60">
          LIVE
        </div>
        <div className="flex-1 overflow-hidden">
          <div className="ticker-track text-slate-400">
            {tickerContent.length > 0 ? tickerContent : (
              <span className="text-xs text-slate-500 px-4">Loading market data…</span>
            )}
          </div>
        </div>
        <div className="shrink-0 px-3 border-l border-white/[0.06] h-full flex items-center gap-2">
          <span className={`w-1.5 h-1.5 rounded-full ${marketOpen ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
          <span className="text-[10px] text-slate-400 hidden sm:block">{marketOpen ? 'Market Open' : 'Closed'}</span>
        </div>
      </div>

      {/* Nav bar */}
      <div className="bg-surface-300/90 backdrop-blur-md border-b border-white/[0.06]">
        <div className="max-w-screen-2xl mx-auto px-4 flex items-center gap-6 h-14">
          {/* Logo */}
          <button onClick={() => onTabChange('portfolio')} className="flex items-center gap-2 shrink-0">
            <svg viewBox="0 0 32 32" fill="none" className="w-7 h-7">
              <path d="M4 22 L10 14 L16 18 L22 8 L28 12" stroke="#00ffcc" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M4 22 L10 14 L16 18 L22 8 L28 12" stroke="#00ffcc" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" opacity="0.12"/>
              <circle cx="16" cy="18" r="2.5" fill="#6366f1"/>
            </svg>
            <span className="font-bold tracking-tight text-base">
              <span className="text-white">FIN</span><span className="text-mint-400">SURF</span>
            </span>
          </button>

          {/* Tabs */}
          <nav className="flex items-center gap-1 flex-1 overflow-x-auto scrollbar-hide">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => onTabChange(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-all duration-150
                  ${activeTab === tab.id
                    ? 'bg-mint-500/15 text-mint-400 border border-mint-500/25'
                    : 'text-slate-400 hover:text-white hover:bg-white/[0.05]'
                  }`}
              >
                <span className="text-[10px] opacity-60">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </nav>

          {/* Time */}
          <div className="hidden md:flex items-center gap-2 shrink-0">
            <Activity className="w-3.5 h-3.5 text-slate-500" />
            <span className="text-xs font-mono text-slate-400">
              {time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          </div>
        </div>
      </div>
    </header>
  )
}
