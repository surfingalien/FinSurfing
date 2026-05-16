/**
 * TradingViewView — Embedded TradingView Advanced Chart.
 * Provides live charting for stocks, ETFs, crypto, forex, and futures
 * with full indicator support, drawing tools, and session overlays.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { Monitor, Search, Clock, RefreshCw, ExternalLink } from 'lucide-react'

// ── Timeframe options ─────────────────────────────────────────────────────────
const TIMEFRAMES = [
  { value: '1',   label: '1m'  },
  { value: '5',   label: '5m'  },
  { value: '15',  label: '15m' },
  { value: '30',  label: '30m' },
  { value: '60',  label: '1H'  },
  { value: '240', label: '4H'  },
  { value: 'D',   label: '1D'  },
  { value: 'W',   label: '1W'  },
]

// ── Quick-access symbols (mirrors AI Brain + user's watchlist focus) ──────────
const QUICK_SYMBOLS = [
  { sym: 'SPY',      label: 'SPY',     group: 'ETF'    },
  { sym: 'QQQ',      label: 'QQQ',     group: 'ETF'    },
  { sym: 'NVDA',     label: 'NVDA',    group: 'Stock'  },
  { sym: 'AAPL',     label: 'AAPL',    group: 'Stock'  },
  { sym: 'MSFT',     label: 'MSFT',    group: 'Stock'  },
  { sym: 'TSLA',     label: 'TSLA',    group: 'Stock'  },
  { sym: 'BTCUSD',   label: 'BTC',     group: 'Crypto' },
  { sym: 'ETHUSD',   label: 'ETH',     group: 'Crypto' },
  { sym: 'EURUSD',   label: 'EUR/USD', group: 'Forex'  },
  { sym: 'ES1!',     label: 'ES',      group: 'Futures'},
  { sym: 'NQ1!',     label: 'NQ',      group: 'Futures'},
  { sym: 'GC1!',     label: 'Gold',    group: 'Futures'},
]

const GROUP_COLORS = {
  ETF:     'text-purple-400 bg-purple-500/10 border-purple-500/20',
  Stock:   'text-blue-400   bg-blue-500/10   border-blue-400/20',
  Crypto:  'text-amber-400  bg-amber-500/10  border-amber-500/20',
  Forex:   'text-teal-400   bg-teal-500/10   border-teal-500/20',
  Futures: 'text-orange-400 bg-orange-500/10 border-orange-500/20',
}

// ── Convert FinSurfing-style symbol to TradingView format ─────────────────────
function toTVSymbol(sym) {
  // Yahoo Finance style: BTC-USD → BTCUSD (TradingView resolves exchange)
  return sym.replace('-USD', 'USD').replace('-', '').toUpperCase()
}

// ── The actual TradingView chart widget ───────────────────────────────────────
function TVWidget({ symbol, interval }) {
  const containerRef = useRef(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.innerHTML = ''

    // Inner widget div (required by embed-umd.js)
    const widgetDiv = document.createElement('div')
    widgetDiv.className = 'tradingview-widget-container__widget'
    widgetDiv.style.cssText = 'height:calc(100% - 32px);width:100%'
    el.appendChild(widgetDiv)

    // Config script — embed-umd.js reads this as its initialisation config
    const script = document.createElement('script')
    script.type = 'text/javascript'
    script.src = 'https://s3.tradingview.com/external-embedding/embed-umd.js'
    script.async = true
    script.innerHTML = JSON.stringify({
      autosize:            true,
      symbol:              toTVSymbol(symbol),
      interval,
      timezone:            'America/New_York',
      theme:               'dark',
      style:               '1',         // Candlestick
      locale:              'en',
      toolbar_bg:          '#070b14',
      backgroundColor:     'rgba(7,11,20,1)',
      gridColor:           'rgba(255,255,255,0.04)',
      allow_symbol_change: true,
      withdateranges:      true,
      hide_top_toolbar:    false,
      hide_side_toolbar:   false,
      details:             false,
      hotlist:             false,
      calendar:            false,
      save_image:          true,
      studies:             ['STD;RSI', 'STD;Volume'],
      support_host:        'https://www.tradingview.com',
    })
    el.appendChild(script)

    return () => { if (el) el.innerHTML = '' }
  }, [symbol, interval])

  return (
    <div
      ref={containerRef}
      className="tradingview-widget-container"
      style={{ height: '100%', width: '100%' }}
    />
  )
}

// ── Session info banner ───────────────────────────────────────────────────────
function SessionBanner() {
  const now  = new Date()
  const utc  = now.getUTCHours() * 60 + now.getUTCMinutes()

  const sessions = [
    { name: 'Tokyo',    open: 23 * 60, close: 8 * 60,  color: 'text-rose-400',    bg: 'bg-rose-500/10'    },
    { name: 'London',   open:  7 * 60, close: 16 * 60, color: 'text-blue-400',    bg: 'bg-blue-500/10'    },
    { name: 'New York', open: 13 * 60, close: 21 * 60, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  ]

  const active = sessions.filter(s => {
    if (s.name === 'Tokyo') return utc >= s.open || utc < s.close
    return utc >= s.open && utc < s.close
  })

  return (
    <div className="flex items-center gap-2 text-[10px] flex-wrap">
      <Clock className="w-3 h-3 text-slate-600" />
      {sessions.map(s => {
        const on = active.some(a => a.name === s.name)
        return (
          <span key={s.name} className={`flex items-center gap-1 px-1.5 py-0.5 rounded border ${
            on ? `${s.color} ${s.bg} border-current/30` : 'text-slate-600 bg-white/[0.02] border-white/[0.05]'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-current animate-pulse' : 'bg-slate-700'}`} />
            {s.name}
          </span>
        )
      })}
      <span className="text-slate-700 ml-1">
        UTC {now.getUTCHours().toString().padStart(2,'0')}:{now.getUTCMinutes().toString().padStart(2,'0')}
      </span>
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────
export default function TradingViewView() {
  const [symbol,    setSymbol]    = useState('SPY')
  const [inputVal,  setInputVal]  = useState('SPY')
  const [interval,  setInterval]  = useState('60')
  const [chartKey,  setChartKey]  = useState(0)

  const apply = useCallback(() => {
    const s = inputVal.trim().toUpperCase().replace(/[^A-Z0-9.!-]/g, '')
    if (s) setSymbol(s)
  }, [inputVal])

  const pickSymbol = (sym) => {
    setSymbol(sym)
    setInputVal(sym)
  }

  return (
    <div className="flex flex-col h-full gap-4 animate-fade-in">

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-blue-500/10 border border-blue-500/20">
            <Monitor className="w-5 h-5 text-blue-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">TradingView</h1>
            <p className="text-xs text-slate-500">
              Live advanced charts · Full indicator suite · Drawing tools
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          {/* Session clocks */}
          <SessionBanner />

          {/* Symbol input */}
          <div className="flex items-center gap-1.5">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.08]">
              <Search className="w-3.5 h-3.5 text-slate-500 shrink-0" />
              <input
                value={inputVal}
                onChange={e => setInputVal(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === 'Enter' && apply()}
                placeholder="AAPL, BTC-USD, ES1!"
                className="w-32 bg-transparent text-sm text-white placeholder-slate-600 focus:outline-none font-mono"
              />
            </div>
            <button
              onClick={apply}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-500/15 text-blue-400 border border-blue-500/25 hover:bg-blue-500/25 transition-all"
            >
              Go
            </button>
          </div>

          {/* Timeframes */}
          <div className="flex gap-1">
            {TIMEFRAMES.map(tf => (
              <button
                key={tf.value}
                onClick={() => setInterval(tf.value)}
                className={`px-2 py-1 rounded text-[11px] font-mono font-medium transition-all ${
                  interval === tf.value
                    ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                    : 'bg-white/[0.03] text-slate-400 border border-white/[0.05] hover:text-white'
                }`}
              >
                {tf.label}
              </button>
            ))}
          </div>

          {/* Refresh */}
          <button
            onClick={() => setChartKey(k => k + 1)}
            title="Reload chart"
            className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/[0.06] border border-white/[0.06] transition-all"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ── Quick symbol chips ── */}
      <div className="flex gap-1.5 flex-wrap shrink-0">
        {QUICK_SYMBOLS.map(({ sym, label, group }) => (
          <button
            key={sym}
            onClick={() => pickSymbol(sym)}
            className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-all ${
              symbol === sym
                ? GROUP_COLORS[group]
                : 'bg-white/[0.02] text-slate-500 border-white/[0.05] hover:text-slate-300'
            }`}
          >
            {label}
          </button>
        ))}

        <a
          href="https://www.tradingview.com/chart/"
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-slate-600 border border-white/[0.04] hover:text-slate-400 transition-all"
        >
          <ExternalLink className="w-2.5 h-2.5" /> Full TradingView
        </a>
      </div>

      {/* ── Chart ── */}
      <div
        className="flex-1 rounded-2xl overflow-hidden border border-white/[0.07]"
        style={{ minHeight: 520 }}
      >
        <TVWidget key={`${chartKey}-${symbol}-${interval}`} symbol={symbol} interval={interval} />
      </div>

      {/* ── Footer ── */}
      <p className="text-center text-[10px] text-slate-700 shrink-0 pb-1">
        Charts provided by{' '}
        <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer"
          className="underline hover:text-slate-500 transition-colors">
          TradingView
        </a>
        {' '}— not affiliated with TradingView Inc.
      </p>
    </div>
  )
}
