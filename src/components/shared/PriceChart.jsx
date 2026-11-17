/**
 * PriceChart — the app's own interactive price chart (TradingView's open-source
 * lightweight-charts, Apache-2.0). Unlike the embedded TradingView widget, this
 * one is ours to draw on: a trade plan's levels, dated facts as markers, or
 * several symbols as percent-change lines.
 *
 * It draws what it is given and computes nothing: levels come from
 * lib/chart-events.js:planLevels, markers from snapMarkers, compare lines from
 * indexSeries. Load it with React.lazy — the library is ~50 kB gzipped and most
 * pages never need it.
 *
 * Props
 *   candles  [{time(ms), open, high, low, close, volume}]   candlestick mode
 *   lines    [{name, points:[{time:'YYYY-MM-DD', value}]}]  line mode (percent)
 *   levels   [{price, label, role:'entry'|'stop'|'target'|'price'}]
 *   markers  [{time:'YYYY-MM-DD', kind, text}]              already snapped to bars
 *   height, percent (format the scale as %), label (accessible name)
 */
import { useEffect, useRef } from 'react'
import { createChart, CandlestickSeries, HistogramSeries, LineSeries, createSeriesMarkers, LineStyle, CrosshairMode } from 'lightweight-charts'

const ROLE = { entry: '#3b82f6', stop: '#ef4444', target: '#10b981', price: '#94a3b8' }
const MARK = {
  earnings: { color: '#f59e0b', shape: 'circle', position: 'aboveBar', text: 'E' },
  filing:   { color: '#94a3b8', shape: 'square', position: 'belowBar', text: 'F' },
  thesis:   { color: '#6366f1', shape: 'arrowUp', position: 'belowBar', text: 'T' },
  alert:    { color: '#ec4899', shape: 'arrowDown', position: 'aboveBar', text: 'A' },
  buy:      { color: '#10b981', shape: 'arrowUp', position: 'belowBar', text: 'B' },
  sell:     { color: '#ef4444', shape: 'arrowDown', position: 'aboveBar', text: 'S' },
}
export const LINE_COLORS = ['#2563eb', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#64748b']

const dayOf = ms => new Date(ms).toISOString().slice(0, 10)
const isLight = () => typeof document !== 'undefined' && document.documentElement.classList.contains('light-mode')

function theme() {
  const light = isLight()
  return {
    layout: { background: { color: 'transparent' }, textColor: light ? '#475569' : '#94a3b8', fontSize: 11, attributionLogo: true },
    grid: { vertLines: { color: light ? 'rgba(148,163,184,0.18)' : 'rgba(148,163,184,0.08)' }, horzLines: { color: light ? 'rgba(148,163,184,0.25)' : 'rgba(148,163,184,0.12)' } },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, rightOffset: 4 },
    crosshair: { mode: CrosshairMode.Normal },
  }
}

export default function PriceChart({ candles = null, lines = null, levels = [], markers = [], height = 320, percent = false, label = 'Price chart' }) {
  const box = useRef(null)

  useEffect(() => {
    const el = box.current
    if (!el) return undefined
    const chart = createChart(el, { ...theme(), height, autoSize: true, localization: percent ? { priceFormatter: v => `${v > 0 ? '+' : ''}${v.toFixed(1)}%` } : undefined })

    let main = null
    if (candles?.length) {
      main = chart.addSeries(CandlestickSeries, {
        upColor: '#10b981', downColor: '#ef4444', wickUpColor: '#10b981', wickDownColor: '#ef4444', borderVisible: false,
      })
      main.setData(candles.map(c => ({ time: dayOf(c.time), open: c.open, high: c.high, low: c.low, close: c.close })))
      if (candles.some(c => c.volume > 0)) {
        const vol = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false })
        chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } })
        vol.setData(candles.map(c => ({ time: dayOf(c.time), value: c.volume || 0, color: c.close >= c.open ? 'rgba(16,185,129,0.35)' : 'rgba(239,68,68,0.35)' })))
      }
    } else if (lines?.length) {
      lines.forEach((l, i) => {
        const s = chart.addSeries(LineSeries, { color: l.color || LINE_COLORS[i % LINE_COLORS.length], lineWidth: 2, title: l.name, priceLineVisible: false })
        s.setData(l.points)
        if (i === 0) main = s
      })
      if (percent && main) main.createPriceLine({ price: 0, color: ROLE.price, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: '' })
    }

    if (main) {
      for (const lv of levels) {
        if (!Number.isFinite(lv.price)) continue
        main.createPriceLine({ price: lv.price, color: ROLE[lv.role] || ROLE.price, lineWidth: 1, lineStyle: lv.role === 'price' ? LineStyle.Dotted : LineStyle.Dashed, axisLabelVisible: true, title: lv.label })
      }
      if (markers.length) {
        createSeriesMarkers(main, markers.map(m => {
          const k = MARK[m.kind] || MARK.filing
          return { time: m.time, position: k.position, color: k.color, shape: k.shape, text: k.text }
        }))
      }
    }
    chart.timeScale().fitContent()
    return () => chart.remove()
  }, [candles, lines, levels, markers, height, percent])

  return <div ref={box} style={{ height }} className="w-full" role="img" aria-label={label} />
}

export { MARK as MARKER_STYLE, ROLE as LEVEL_COLORS }
