/**
 * TradingViewView — TradingView Advanced Chart using tv.js widget API.
 * Uses new window.TradingView.widget() — the correct approach for React
 * (embed-umd.js fails because document.currentScript is null for dynamic scripts).
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { Monitor, Search, RefreshCw, ExternalLink, Clock } from 'lucide-react'

// ── Timeframes ────────────────────────────────────────────────────────────────
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

// ── Quick symbols with proper TradingView exchange prefixes ───────────────────
const QUICK_SYMBOLS = [
  { sym: 'AMEX:SPY',        label: 'SPY',     group: 'ETF'     },
  { sym: 'NASDAQ:QQQ',      label: 'QQQ',     group: 'ETF'     },
  { sym: 'NASDAQ:NVDA',     label: 'NVDA',    group: 'Stock'   },
  { sym: 'NASDAQ:AAPL',     label: 'AAPL',    group: 'Stock'   },
  { sym: 'NASDAQ:MSFT',     label: 'MSFT',    group: 'Stock'   },
  { sym: 'NASDAQ:TSLA',     label: 'TSLA',    group: 'Stock'   },
  { sym: 'BITSTAMP:BTCUSD', label: 'BTC',     group: 'Crypto'  },
  { sym: 'BITSTAMP:ETHUSD', label: 'ETH',     group: 'Crypto'  },
  { sym: 'FX_IDC:EURUSD',   label: 'EUR/USD', group: 'Forex'   },
  { sym: 'CME_MINI:ES1!',   label: 'ES',      group: 'Futures' },
  { sym: 'CME_MINI:NQ1!',   label: 'NQ',      group: 'Futures' },
  { sym: 'COMEX:GC1!',      label: 'Gold',    group: 'Futures' },
]

const GROUP_COLORS = {
  ETF:     'text-purple-400 bg-purple-500/10 border-purple-500/20',
  Stock:   'text-blue-400   bg-blue-500/10   border-blue-400/20',
  Crypto:  'text-amber-400  bg-amber-500/10  border-amber-500/20',
  Forex:   'text-teal-400   bg-teal-500/10   border-teal-500/20',
  Futures: 'text-orange-400 bg-orange-500/10 border-orange-500/20',
}

// ── Simple symbol normaliser ──────────────────────────────────────────────────
// Converts user input ("SPY", "BTC-USD", "EURUSD") to a TV-resolvable string.
// TradingView auto-resolves bare tickers to their primary exchange.
function normalise(raw) {
  if (!raw) return 'AMEX:SPY'
  const s = raw.trim().toUpperCase()
  // Already has exchange prefix
  if (s.includes(':')) return s
  // Crypto Yahoo-style: BTC-USD → BITSTAMP:BTCUSD
  const cryptoMap = {
    'BTC-USD': 'BITSTAMP:BTCUSD', 'ETH-USD': 'BITSTAMP:ETHUSD',
    'SOL-USD': 'BINANCE:SOLUSDT', 'BNB-USD': 'BINANCE:BNBUSDT',
    'ADA-USD': 'BINANCE:ADAUSDT', 'DOGE-USD':'BINANCE:DOGEUSDT',
    'XRP-USD': 'BITSTAMP:XRPUSD', 'AVAX-USD':'BINANCE:AVAXUSDT',
  }
  if (cryptoMap[s]) return cryptoMap[s]
  // Strip -USD suffix
  if (s.endsWith('-USD')) return 'BINANCE:' + s.replace('-USD', 'USDT')
  return s  // bare ticker — TradingView resolves to primary exchange
}

// ── Load tv.js once, then resolve the promise on subsequent calls ─────────────
let tvReady = null
function loadTVScript() {
  if (tvReady) return tvReady
  tvReady = new Promise((resolve) => {
    if (window.TradingView) { resolve(); return }
    const s = document.createElement('script')
    s.src = 'https://s3.tradingview.com/tv.js'
    s.onload  = resolve
    s.onerror = resolve  // resolve anyway so we don't hang forever
    document.head.appendChild(s)
  })
  return tvReady
}

// ── TradingView widget component ──────────────────────────────────────────────
function TVChart({ symbol, interval, uid }) {
  const idRef = useRef(`tv_${uid}`)

  useEffect(() => {
    const id = idRef.current
    let destroyed = false

    loadTVScript().then(() => {
      if (destroyed || !window.TradingView) return
      const el = document.getElementById(id)
      if (!el) return

      // Clear any previous widget
      el.innerHTML = ''

      new window.TradingView.widget({
        container_id:        id,
        autosize:            true,
        symbol:              symbol,
        interval:            interval,
        timezone:            'America/New_York',
        theme:               'dark',
        style:               '1',       // Candlestick
        locale:              'en',
        toolbar_bg:          '#0a0e1a',
        allow_symbol_change: true,
        withdateranges:      true,
        hide_top_toolbar:    false,
        hide_side_toolbar:   false,
        details:             false,
        hotlist:             false,
        calendar:            false,
        save_image:          true,
        studies: [
          'RSI@tv-basicstudies',
          'Volume@tv-basicstudies',
        ],
      })
    })

    return () => {
      destroyed = true
      const el = document.getElementById(id)
      if (el) el.innerHTML = ''
    }
  }, [symbol, interval, uid])

  return <div id={idRef.current} style={{ height: '100%', width: '100%' }} />
}

// ── Session banner ────────────────────────────────────────────────────────────
function SessionBanner() {
  const now = new Date()
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes()
  const sessions = [
    { name: 'Tokyo',    open: 23 * 60, close:  8 * 60, color: 'text-rose-400'   , bg: 'bg-rose-500/10'    },
    { name: 'London',   open:  7 * 60, close: 16 * 60, color: 'text-blue-400'   , bg: 'bg-blue-500/10'    },
    { name: 'New York', open: 13 * 60, close: 21 * 60, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  ]
  const isOpen = (s) =>
    s.name === 'Tokyo' ? (utcMin >= s.open || utcMin < s.close) : (utcMin >= s.open && utcMin < s.close)

  return (
    <div className="flex items-center gap-2 text-[10px] flex-wrap">
      <Clock className="w-3 h-3 text-slate-600 shrink-0" />
      {sessions.map(s => {
        const on = isOpen(s)
        return (
          <span key={s.name} className={`flex items-center gap-1 px-1.5 py-0.5 rounded border ${
            on ? `${s.color} ${s.bg} border-current/30` : 'text-slate-600 bg-white/[0.02] border-white/[0.05]'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-current animate-pulse' : 'bg-slate-700'}`} />
            {s.name}
          </span>
        )
      })}
      <span className="text-slate-700">
        UTC {now.getUTCHours().toString().padStart(2,'0')}:{now.getUTCMinutes().toString().padStart(2,'0')}
      </span>
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────
export default function TradingViewView() {
  const [symbol,   setSymbol]   = useState('AMEX:SPY')
  const [inputVal, setInputVal] = useState('SPY')
  const [interval, setInterval] = useState('60')
  const [uid,      setUid]      = useState(0)

  const apply = useCallback(() => {
    const s = normalise(inputVal)
    setSymbol(s)
    setUid(u => u + 1)  // force widget remount on every Go/Enter
  }, [inputVal])

  const pickSymbol = (sym) => {
    setSymbol(sym)
    setInputVal(sym.includes(':') ? sym.split(':')[1] : sym)
    setUid(u => u + 1)
  }

  const changeInterval = (tf) => {
    setInterval(tf)
    setUid(u => u + 1)
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
          <SessionBanner />

          {/* Symbol search */}
          <div className="flex items-center gap-1.5">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.08]">
              <Search className="w-3.5 h-3.5 text-slate-500 shrink-0" />
              <input
                value={inputVal}
                onChange={e => setInputVal(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === 'Enter' && apply()}
                placeholder="SPY, NVDA, BTC-USD…"
                className="w-36 bg-transparent text-sm text-white placeholder-slate-600 focus:outline-none font-mono"
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
                onClick={() => changeInterval(tf.value)}
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

          {/* Reload */}
          <button
            onClick={() => setUid(u => u + 1)}
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
          <ExternalLink className="w-2.5 h-2.5" /> Open in TradingView
        </a>
      </div>

      {/* ── Chart ── */}
      <div
        className="flex-1 rounded-2xl overflow-hidden border border-white/[0.07]"
        style={{ minHeight: 540 }}
      >
        <TVChart symbol={symbol} interval={interval} uid={uid} />
      </div>

      <p className="text-center text-[10px] text-slate-700 shrink-0 pb-1">
        Charts by{' '}
        <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer"
          className="underline hover:text-slate-500 transition-colors">TradingView</a>
        {' '}— not affiliated with TradingView Inc.
      </p>
    </div>
  )
}
