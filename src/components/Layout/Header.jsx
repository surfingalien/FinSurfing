/**
 * Header.jsx  — now a slim top-bar only.
 *
 * Contains:
 *  - Mobile hamburger (opens the Sidebar drawer)
 *  - Live ticker tape
 *  - Market open/closed indicator + clock
 *
 * Navigation tabs and user menu have moved to Sidebar.jsx.
 */

import { useState, useEffect } from 'react'
import { Menu, Terminal } from 'lucide-react'
import { fetchQuotes } from '../../services/api'
import { TICKER_SYMBOLS } from '../../data/portfolio'
import { fmt, fmtPct } from '../../services/api'
import { useProMode } from '../../contexts/ProModeContext'

export default function Header({ onMobileMenuOpen }) {
  const [tickerData, setTickerData] = useState([])
  const [time,       setTime]       = useState(new Date())
  const [marketOpen, setMarketOpen] = useState(false)
  const { proMode, toggleProMode } = useProMode()

  useEffect(() => {
    const t = setInterval(() => {
      const now = new Date()
      setTime(now)
      // Use Eastern Time for market hours check (NYSE/NASDAQ are ET-based)
      const et    = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
      const day   = et.getDay()
      const mins  = et.getHours() * 60 + et.getMinutes()
      setMarketOpen(day >= 1 && day <= 5 && mins >= 570 && mins < 960)
    }, 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const load = async () => {
      try { setTickerData(await fetchQuotes(TICKER_SYMBOLS)) } catch {}
    }
    load()
    const t = setInterval(load, 60000)
    return () => clearInterval(t)
  }, [])

  const gainColor = proMode ? 'text-[#4af626]' : 'text-emerald-400'
  const liveColor = proMode ? 'bg-[#4af626]'  : 'bg-emerald-400'

  const tickerContent = [...tickerData, ...tickerData].map((q, i) => (
    <span key={i} className="inline-flex items-center gap-2 mr-8 shrink-0">
      <span className="font-semibold text-white font-mono text-xs">{q.symbol}</span>
      <span className="font-mono text-xs text-slate-300">${fmt(q.price)}</span>
      <span className={`text-xs font-mono ${(q.changePct || 0) >= 0 ? gainColor : 'text-red-400'}`}>
        {fmtPct(q.changePct)}
      </span>
    </span>
  ))

  return (
    <header className="sticky top-0 z-30 flex items-center h-10
                       bg-surface-300/80 backdrop-blur border-b border-white/[0.06]">
      {/* Mobile hamburger */}
      <button
        onClick={onMobileMenuOpen}
        className="lg:hidden shrink-0 px-3 h-full flex items-center text-slate-400
                   hover:text-white hover:bg-white/[0.05] transition-colors border-r border-white/[0.06]"
      >
        <Menu className="w-4 h-4" />
      </button>

      {/* LIVE badge */}
      <div className="shrink-0 px-3 text-[10px] font-semibold text-mint-500
                      border-r border-white/[0.06] h-full flex items-center bg-surface-400/60">
        LIVE
      </div>

      {/* Ticker tape */}
      <div className="flex-1 overflow-hidden">
        <div className="ticker-track text-slate-400">
          {tickerContent.length > 0 ? tickerContent : (
            <span className="text-xs text-slate-500 px-4">Loading market data…</span>
          )}
        </div>
      </div>

      {/* Market status + clock */}
      <div className="shrink-0 flex items-center gap-2 px-3 h-full border-l border-white/[0.06]">
        <span className={`w-1.5 h-1.5 rounded-full ${marketOpen ? `${liveColor} animate-pulse` : 'bg-slate-600'}`} />
        <span className="text-[10px] text-slate-400 hidden sm:block">
          {marketOpen ? 'Open' : 'Closed'}
        </span>
        <span className="hidden md:block text-[10px] font-mono text-slate-500 border-l border-white/[0.06] pl-2 ml-1">
          {time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
      </div>

      {/* Pro Mode toggle */}
      <button
        onClick={toggleProMode}
        title={proMode ? 'Exit Pro Mode' : 'Enter Pro Mode (terminal aesthetic)'}
        className={`shrink-0 px-3 h-full flex items-center gap-1.5 text-[10px] font-mono font-semibold border-l border-white/[0.06] transition-colors ${
          proMode
            ? 'text-[#4af626] bg-[#4af626]/[0.06] hover:bg-[#4af626]/[0.10]'
            : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.04]'
        }`}
      >
        <Terminal className="w-3 h-3" />
        <span className="hidden sm:block">PRO</span>
      </button>
    </header>
  )
}
