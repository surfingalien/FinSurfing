/**
 * V2Ticker.jsx — the live ticker strip, market status and clock for the v2
 * layout. Same data path as the v1 header (REST seed, quote stream, 60s
 * refresh), kept separate so v1's header is not touched.
 */

import { useState, useEffect, useRef } from 'react'
import { fetchQuotes, subscribeQuotes, fmt, fmtPct } from '../services/api'
import { TICKER_SYMBOLS } from '../data/portfolio'

function etMarketOpen(now) {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const day = et.getDay()
  const mins = et.getHours() * 60 + et.getMinutes()
  return day >= 1 && day <= 5 && mins >= 570 && mins < 960
}

export default function V2Ticker() {
  const [rows, setRows] = useState([])
  const [now, setNow] = useState(new Date())
  const mapRef = useRef({})

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const load = () => fetchQuotes(TICKER_SYMBOLS, { force: true }).then(results => {
      results.forEach(q => { mapRef.current[q.symbol] = { ...mapRef.current[q.symbol], ...q } })
      setRows(TICKER_SYMBOLS.map(s => mapRef.current[s]).filter(Boolean))
    }).catch(() => {})
    load()
    const unsub = subscribeQuotes(TICKER_SYMBOLS, ({ symbol, price, change, changePct }) => {
      const prev = mapRef.current[symbol] || {}
      mapRef.current[symbol] = {
        ...prev, symbol, price,
        change: change ?? prev.change,
        changePct: changePct ?? prev.changePct,
      }
      setRows(TICKER_SYMBOLS.map(s => mapRef.current[s]).filter(Boolean))
    })
    const t = setInterval(load, 60_000)
    return () => { unsub(); clearInterval(t) }
  }, [])

  const open = etMarketOpen(now)

  return (
    <div className="v2-ticker">
      <span className="v2-ticker-live">LIVE</span>
      <div className="v2-ticker-track-wrap">
        <div className="ticker-track">
          {rows.length === 0 ? (
            <span className="v2-ticker-empty">Loading market data…</span>
          ) : [...rows, ...rows].map((q, i) => (
            <span key={i} className="v2-ticker-item">
              <b>{q.symbol}</b>
              <span>${fmt(q.price)}</span>
              <span className={(q.changePct || 0) >= 0 ? 'v2-up' : 'v2-down'}>{fmtPct(q.changePct)}</span>
            </span>
          ))}
        </div>
      </div>
      <span className="v2-ticker-status">
        <i className={open ? 'is-open' : ''} />
        {open ? 'Market open' : 'Market closed'}
        <span className="v2-ticker-clock">
          {now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
      </span>
    </div>
  )
}
