/**
 * TradingAIPanel — AI trading analysis panel that sits alongside a TradingView chart.
 * Provides signal analysis, interactive AI chat, and pattern-based alerts.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Brain,
  TrendingUp,
  TrendingDown,
  Minus,
  MessageSquare,
  Bell,
  RefreshCw,
  Send,
  Loader2,
  AlertTriangle,
  Activity,
  Zap,
  BarChart2,
  ChevronRight,
} from 'lucide-react'
import { getApiKeyHeaders } from '../../services/api'

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(date) {
  const diffMs = Date.now() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 10) return 'just now'
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  return `${diffHr}h ago`
}

function getSignalColor(signal) {
  if (!signal) return 'slate'
  const s = signal.toUpperCase()
  if (s === 'BUY' || s === 'OVERWEIGHT') return 'emerald'
  if (s === 'SELL' || s === 'UNDERWEIGHT') return 'red'
  return 'amber'
}

function getAlignmentColor(alignment) {
  if (alignment === 'Bullish alignment') return 'emerald'
  if (alignment === 'Bearish alignment') return 'red'
  if (alignment === 'Tight alignment') return 'blue'
  if (alignment === 'Wide divergence') return 'amber'
  return 'slate'
}

function getPatternColor(pattern) {
  const bullish = ['20bar_breakout_up', 'golden_cross', 'volume_spike', 'strong_uptrend', 'above_ema50', 'above_ema200']
  const bearish = ['20bar_breakout_down', 'death_cross', 'strong_downtrend', 'below_ema50', 'below_ema200']
  if (bullish.includes(pattern)) return 'emerald'
  if (bearish.includes(pattern)) return 'red'
  return 'slate'
}

function formatPatternLabel(pattern) {
  return pattern
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}

// ── Alert icon by type ────────────────────────────────────────────────────────
function AlertIcon({ type }) {
  const cls = 'w-3.5 h-3.5 shrink-0'
  switch (type) {
    case 'breakout':  return <Zap       className={`${cls} text-emerald-400`} />
    case 'breakdown': return <TrendingDown className={`${cls} text-red-400`} />
    case 'volume':    return <BarChart2  className={`${cls} text-blue-400`} />
    case 'squeeze':   return <Activity  className={`${cls} text-amber-400`} />
    default:          return <Zap       className={`${cls} text-violet-400`} />
  }
}

// ── RSI display helpers ───────────────────────────────────────────────────────
function rsiColor(val) {
  if (val == null) return 'text-slate-500'
  if (val > 70) return 'text-red-400'
  if (val < 30) return 'text-blue-400'
  if (val >= 50 && val <= 70) return 'text-emerald-400'
  return 'text-amber-400'
}

function rsiLabel(val) {
  if (val == null) return '—'
  if (val > 70) return 'Overbought'
  if (val < 30) return 'Oversold'
  if (val >= 50 && val <= 70) return 'Bullish'
  if (val >= 40 && val < 50) return 'Neutral'
  return 'Bearish'
}

// ── Compact indicator row ─────────────────────────────────────────────────────
function IndicatorRow({ label, value, colorClass, even }) {
  return (
    <div className={`flex items-center justify-between px-3 py-1.5 ${even ? 'bg-white/[0.02]' : ''}`}>
      <span className="text-slate-400 text-[11px]">{label}</span>
      <span className={`text-[11px] font-mono ${colorClass || 'text-white'}`}>{value ?? '—'}</span>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function TradingAIPanel({ symbol, interval, price }) {
  const [tab, setTab] = useState('analysis')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [chatHistory, setChatHistory] = useState([])
  const [chatInput, setChatInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [alerts, setAlerts] = useState([])
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const [thesisOpen, setThesisOpen]       = useState(true)

  const debounceRef = useRef(null)
  const chatEndRef  = useRef(null)
  const prevSymRef  = useRef(null)

  // ── analyze ────────────────────────────────────────────────────────────────
  const analyze = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/trading-analysis/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getApiKeyHeaders() },
        body: JSON.stringify({ symbol, interval, livePrice: price ?? null }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Analysis failed')
      setResult(data)

      // Generate alerts from patterns
      const newAlerts = []
      const p = data.indicators?.patterns ?? []
      if (p.includes('20bar_breakout_up'))
        newAlerts.push({ type: 'breakout', msg: `${symbol} broke out above 20-bar high`, time: new Date() })
      if (p.includes('20bar_breakout_down'))
        newAlerts.push({ type: 'breakdown', msg: `${symbol} broke below 20-bar low`, time: new Date() })
      if (p.includes('volume_spike'))
        newAlerts.push({ type: 'volume', msg: `Volume spike detected on ${symbol}`, time: new Date() })
      if (p.includes('bb_squeeze'))
        newAlerts.push({ type: 'squeeze', msg: `Bollinger Band squeeze on ${symbol} — move incoming`, time: new Date() })
      if (p.includes('golden_cross'))
        newAlerts.push({ type: 'signal', msg: `Golden cross detected on ${symbol}`, time: new Date() })
      if (p.includes('death_cross'))
        newAlerts.push({ type: 'signal', msg: `Death cross detected on ${symbol}`, time: new Date() })
      if (newAlerts.length)
        setAlerts(prev => [...newAlerts, ...prev].slice(0, 20))
    } catch (e) {
      setError(e.message)
    }
    setLoading(false)
  }, [symbol, interval])

  // ── Auto-analyze on symbol / interval change ───────────────────────────────
  useEffect(() => {
    // Clear result when symbol changes (not interval)
    if (prevSymRef.current !== null && prevSymRef.current !== symbol) {
      setResult(null)
      setError(null)
    }
    prevSymRef.current = symbol

    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      analyze()
    }, 800)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [symbol, interval]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-scroll chat ───────────────────────────────────────────────────────
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatHistory])

  // ── sendChat ───────────────────────────────────────────────────────────────
  const sendChat = async () => {
    if (!chatInput.trim() || streaming) return
    const msg = chatInput.trim()
    setChatInput('')
    const userMsg = { role: 'user', content: msg }
    setChatHistory(h => [...h, userMsg])
    setStreaming(true)
    const assistantMsg = { role: 'assistant', content: '' }
    setChatHistory(h => [...h, assistantMsg])
    try {
      const res = await fetch('/api/trading-analysis/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: msg,
          symbol,
          interval,
          price,
          analysisContext: result?.analysis ?? null,
          history: chatHistory.slice(-10),
        }),
      })
      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          try {
            const json = JSON.parse(line.slice(5).trim())
            if (json.text)
              setChatHistory(h => {
                const copy = [...h]
                copy[copy.length - 1] = {
                  ...copy[copy.length - 1],
                  content: copy[copy.length - 1].content + json.text,
                }
                return copy
              })
          } catch {}
        }
      }
    } catch (e) {
      console.error(e)
    }
    setStreaming(false)
  }

  // ── Derived display values ─────────────────────────────────────────────────
  const analysis          = result?.analysis ?? null
  const indicators        = result?.indicators ?? null
  const sentiment         = result?.sentiment ?? null
  const sentimentAlignment = result?.sentimentAlignment ?? null
  const signal            = analysis?.signal ?? null
  const color             = getSignalColor(signal)
  const patterns          = indicators?.patterns ?? []
  const ticker            = symbol.includes(':') ? symbol.split(':')[1] : symbol

  // ── Tabs bar ───────────────────────────────────────────────────────────────
  const TABS = [
    { id: 'analysis', label: 'Analysis', icon: Brain },
    { id: 'chat',     label: 'Chat',     icon: MessageSquare },
    { id: 'alerts',   label: 'Alerts',   icon: Bell, badge: alerts.length },
  ]

  return (
    <div className="flex flex-col h-full text-sm">
      {/* ── Panel header ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between p-3 border-b border-white/[0.07] shrink-0">
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-violet-400" />
          <span className="font-semibold text-white text-xs">AI Analysis</span>
          <span className="text-[10px] text-slate-500 font-mono truncate max-w-[80px]">{ticker}</span>
        </div>
        <button
          onClick={analyze}
          disabled={loading}
          className="p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-500 hover:text-white border border-white/[0.05] transition-all"
          title="Re-analyze"
        >
          {loading
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <RefreshCw className="w-3.5 h-3.5" />}
        </button>
      </div>

      {/* ── Tabs bar ──────────────────────────────────────────────────────── */}
      <div className="flex border-b border-white/[0.07] shrink-0">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 flex items-center justify-center gap-1 py-2 text-[11px] font-medium transition-all relative ${
              tab === t.id
                ? 'bg-white/[0.06] text-white'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            <t.icon className="w-3 h-3" />
            {t.label}
            {t.badge > 0 && (
              <span className="absolute top-1 right-2 min-w-[14px] h-[14px] rounded-full bg-violet-500 text-white text-[9px] font-bold flex items-center justify-center px-0.5">
                {t.badge > 9 ? '9+' : t.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Tab content ───────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">

        {/* ──────────────────── ANALYSIS TAB ────────────────────────────── */}
        {tab === 'analysis' && (
          <div className="flex-1 overflow-y-auto">
            {/* Loading */}
            {loading && (
              <div className="flex flex-col items-center justify-center h-40 gap-2 text-slate-500">
                <Loader2 className="w-6 h-6 animate-spin text-violet-400" />
                <span className="text-xs">Analyzing {ticker}…</span>
              </div>
            )}

            {/* Error */}
            {!loading && error && (
              <div className="m-3 rounded-xl border border-red-500/20 bg-red-500/5 p-3">
                <div className="flex items-center gap-2 text-red-400 mb-2 text-xs font-medium">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  Analysis failed
                </div>
                <p className="text-[11px] text-red-400/70 mb-2">{error}</p>
                <button
                  onClick={analyze}
                  className="text-[11px] text-red-400 hover:text-red-300 flex items-center gap-1 transition-colors"
                >
                  <RefreshCw className="w-3 h-3" /> Retry
                </button>
              </div>
            )}

            {/* Empty state */}
            {!loading && !error && !result && (
              <div className="flex flex-col items-center justify-center h-40 gap-2 text-slate-600">
                <Brain className="w-8 h-8 opacity-30" />
                <span className="text-xs">Click ↺ to analyze</span>
              </div>
            )}

            {/* Result */}
            {!loading && result && analysis && (
              <>
                {/* ── Signal card ──────────────────────────────────────── */}
                <div className={`m-3 rounded-xl border p-3 bg-${color}-500/5 border-${color}-500/20`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className={`flex items-center gap-1.5 text-${color}-400 font-bold text-sm`}>
                      <span className="w-2 h-2 rounded-full bg-current animate-pulse" />
                      {signal ?? '—'}
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] text-slate-500">Confidence</div>
                      <div className={`font-bold text-${color}-400 text-sm`}>
                        {analysis.confidence != null ? `${analysis.confidence}%` : '—'}
                      </div>
                    </div>
                  </div>

                  {/* Confidence bar */}
                  <div className="w-full h-1 bg-white/[0.06] rounded-full mb-2">
                    <div
                      className={`h-full rounded-full bg-${color}-500 transition-all`}
                      style={{ width: `${analysis.confidence ?? 0}%` }}
                    />
                  </div>

                  {/* Entry zone / Stop / Target grid */}
                  <div className="grid grid-cols-3 gap-1.5 text-[11px]">
                    <div className="bg-white/[0.04] rounded-lg p-1.5">
                      <div className="text-slate-500 text-[9px] mb-0.5">Entry Zone</div>
                      <div className="text-white font-mono leading-tight">
                        {analysis.entryZoneLow != null && analysis.entryZoneHigh != null
                          ? <><span className="text-[9px] opacity-70">${analysis.entryZoneLow.toFixed(2)}</span><br/><span className="text-[9px] opacity-70">– ${analysis.entryZoneHigh.toFixed(2)}</span></>
                          : analysis.entry != null ? `$${analysis.entry.toFixed(2)}` : '—'}
                      </div>
                    </div>
                    <div className="bg-red-500/10 rounded-lg p-1.5">
                      <div className="text-red-400/70 text-[9px] mb-0.5">Stop Loss</div>
                      <div className="text-white font-mono">
                        {analysis.stopLoss != null ? `$${analysis.stopLoss.toFixed(2)}` : '—'}
                      </div>
                    </div>
                    <div className="bg-emerald-500/10 rounded-lg p-1.5">
                      <div className="text-emerald-400/70 text-[9px] mb-0.5">Target 1</div>
                      <div className="text-white font-mono">
                        {analysis.takeProfit?.[0] != null ? `$${analysis.takeProfit[0].toFixed(2)}` : '—'}
                      </div>
                    </div>
                  </div>

                  {/* R/R row */}
                  <div className="flex items-center justify-between mt-2 text-[10px]">
                    <span className="text-slate-500">
                      R/R{' '}
                      <span className="text-white font-mono">
                        {analysis.riskReward != null ? `${analysis.riskReward.toFixed(1)}:1` : '—'}
                      </span>
                    </span>
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${
                      analysis.trend === 'BULLISH'
                        ? 'text-emerald-400 bg-emerald-500/10'
                        : analysis.trend === 'BEARISH'
                        ? 'text-red-400 bg-red-500/10'
                        : 'text-amber-400 bg-amber-500/10'
                    }`}>
                      {analysis.trend ?? 'NEUTRAL'}
                    </span>
                    <span className="text-slate-500">{analysis.timeHorizon ?? ''}</span>
                  </div>
                </div>

                {/* ── Probability bar ───────────────────────────────────── */}
                {(analysis.bullishProbability != null || analysis.bearishProbability != null) && (
                  <div className="px-3 mb-3">
                    <div className="text-[10px] text-slate-500 mb-1">Bull / Bear Probability</div>
                    <div className="h-2 rounded-full bg-red-500/20 overflow-hidden">
                      <div
                        className="h-full bg-emerald-500/80 rounded-full transition-all"
                        style={{ width: `${analysis.bullishProbability ?? 50}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-[10px] mt-0.5">
                      <span className="text-emerald-400">{analysis.bullishProbability ?? 50}% Bull</span>
                      <span className="text-red-400">{analysis.bearishProbability ?? 50}% Bear</span>
                    </div>
                  </div>
                )}

                {/* ── Sentiment alignment ──────────────────────────────── */}
                {(sentiment || sentimentAlignment) && sentimentAlignment !== 'No data' && (
                  <div className="px-3 mb-3">
                    <div className="text-[10px] text-slate-500 mb-1">Sentiment Alignment</div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {sentimentAlignment && (
                        <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full bg-${getAlignmentColor(sentimentAlignment)}-500/20 text-${getAlignmentColor(sentimentAlignment)}-400`}>
                          {sentimentAlignment}
                        </span>
                      )}
                      {sentiment?.bullishPct != null && (
                        <span className="text-[10px] text-slate-400">
                          StockTwits: <span className="text-emerald-400">{sentiment.bullishPct}% bull</span>
                          {' '}· {sentiment.bullish}B / {sentiment.bearish}Be ({sentiment.total} msgs)
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* ── Indicators grid ───────────────────────────────────── */}
                {indicators && (
                  <div className="mb-3">
                    <div className="text-[10px] text-slate-500 px-3 mb-1 uppercase tracking-wider">Indicators</div>

                    {/* RSI */}
                    <IndicatorRow
                      even label="RSI (14)"
                      value={indicators.rsi != null ? `${indicators.rsi.toFixed(1)} · ${rsiLabel(indicators.rsi)}` : '—'}
                      colorClass={rsiColor(indicators.rsi)}
                    />

                    {/* MACD */}
                    <IndicatorRow
                      label="MACD"
                      value={
                        indicators.macd != null
                          ? `${indicators.macd.macd?.toFixed(3) ?? '—'} · ${indicators.macd.trend ?? '—'}`
                          : '—'
                      }
                      colorClass={
                        indicators.macd?.trend === 'bullish' ? 'text-emerald-400'
                          : indicators.macd?.trend === 'bearish' ? 'text-red-400'
                          : 'text-slate-300'
                      }
                      even={false}
                    />

                    {/* EMA Trend */}
                    <IndicatorRow
                      even label="EMA Trend"
                      value={
                        patterns.includes('strong_uptrend') ? 'Strong Up'
                          : patterns.includes('above_ema50') ? 'Above EMA50'
                          : patterns.includes('strong_downtrend') ? 'Strong Down'
                          : patterns.includes('below_ema50') ? 'Below EMA50'
                          : indicators.emaTrend ?? '—'
                      }
                      colorClass={
                        patterns.includes('strong_uptrend') || patterns.includes('above_ema50')
                          ? 'text-emerald-400'
                          : patterns.includes('strong_downtrend') || patterns.includes('below_ema50')
                          ? 'text-red-400'
                          : 'text-slate-400'
                      }
                    />

                    {/* Bollinger */}
                    <IndicatorRow
                      label="Bollinger"
                      value={
                        patterns.includes('bb_squeeze')
                          ? 'Squeeze'
                          : indicators.bollinger?.position ?? '—'
                      }
                      colorClass={patterns.includes('bb_squeeze') ? 'text-amber-400' : 'text-slate-300'}
                      even={false}
                    />

                    {/* Stoch RSI */}
                    <IndicatorRow
                      even label="Stoch RSI"
                      value={
                        indicators.stochRsi != null
                          ? `${indicators.stochRsi.toFixed(1)} · ${indicators.stochRsi > 80 ? 'OB' : indicators.stochRsi < 20 ? 'OS' : 'Mid'}`
                          : '—'
                      }
                      colorClass={
                        indicators.stochRsi > 80 ? 'text-red-400'
                          : indicators.stochRsi < 20 ? 'text-blue-400'
                          : 'text-slate-300'
                      }
                    />

                    {/* VWAP */}
                    <IndicatorRow
                      label="VWAP"
                      value={
                        indicators.vwap != null
                          ? `${price != null ? (price > indicators.vwap ? 'Above' : 'Below') : '—'} $${indicators.vwap.toFixed(2)}`
                          : '—'
                      }
                      colorClass={
                        price != null && indicators.vwap != null
                          ? price > indicators.vwap ? 'text-emerald-400' : 'text-red-400'
                          : 'text-slate-400'
                      }
                      even={false}
                    />

                    {/* OBV */}
                    <IndicatorRow
                      even label="OBV"
                      value={indicators.obv?.trend ?? (patterns.includes('obv_rising') ? 'Rising' : patterns.includes('obv_falling') ? 'Falling' : '—')}
                      colorClass={
                        (indicators.obv?.trend === 'rising' || patterns.includes('obv_rising')) ? 'text-emerald-400'
                          : (indicators.obv?.trend === 'falling' || patterns.includes('obv_falling')) ? 'text-red-400'
                          : 'text-slate-400'
                      }
                    />

                    {/* ATR */}
                    <IndicatorRow
                      label="ATR (14)"
                      value={indicators.atr != null ? `$${indicators.atr.toFixed(2)}` : '—'}
                      colorClass="text-slate-300"
                      even={false}
                    />

                    {/* Volume */}
                    <IndicatorRow
                      even label="Volume"
                      value={
                        indicators.volume != null
                          ? `${indicators.volume.ratio?.toFixed(1) ?? '?'}x avg · ${indicators.volume.trend ?? '—'}`
                          : (patterns.includes('volume_spike') ? 'Spike detected' : '—')
                      }
                      colorClass={
                        patterns.includes('volume_spike') ? 'text-blue-400'
                          : indicators.volume?.trend === 'above_avg' ? 'text-emerald-400'
                          : 'text-slate-400'
                      }
                    />
                  </div>
                )}

                {/* ── Patterns detected ─────────────────────────────────── */}
                {patterns.length > 0 && (
                  <div className="px-3 mb-3">
                    <div className="text-[10px] text-slate-500 mb-1.5 uppercase tracking-wider">Patterns Detected</div>
                    <div className="flex flex-wrap gap-1">
                      {patterns.map(p => {
                        const c = getPatternColor(p)
                        return (
                          <span
                            key={p}
                            className={`px-1.5 py-0.5 rounded text-[10px] font-medium
                              ${c === 'emerald' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                              : c === 'red' ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                              : 'bg-white/[0.04] text-slate-400 border border-white/[0.06]'}`}
                          >
                            {formatPatternLabel(p)}
                          </span>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* ── Contradictions ────────────────────────────────────── */}
                {analysis.contradictions && analysis.contradictions.length > 0 && (
                  <div className="px-3 mb-3">
                    <div className="text-[10px] text-amber-500/70 mb-1.5 uppercase tracking-wider flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" /> Signal Conflicts
                    </div>
                    <div className="rounded-lg bg-amber-500/5 border border-amber-500/15 p-2.5 space-y-1">
                      {analysis.contradictions.map((c, i) => (
                        <p key={i} className="text-[11px] text-amber-400/80 leading-tight">{c}</p>
                      ))}
                    </div>
                  </div>
                )}

                {/* ── Two-Sided Thesis ──────────────────────────────────── */}
                {analysis.thesis && (
                  <div className="px-3 mb-3">
                    <button
                      onClick={() => setThesisOpen(o => !o)}
                      className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-300 transition-colors mb-1.5 uppercase tracking-wider w-full"
                    >
                      <ChevronRight className={`w-3 h-3 transition-transform ${thesisOpen ? 'rotate-90' : ''}`} />
                      Two-Sided Thesis
                      {analysis.thesis.entryType && (
                        <span className={`ml-auto text-[9px] px-1.5 py-0.5 rounded-full font-medium ${
                          analysis.thesis.entryType === 'left-entry'  ? 'bg-blue-500/20 text-blue-400' :
                          analysis.thesis.entryType === 'right-entry' ? 'bg-emerald-500/20 text-emerald-400' :
                                                                         'bg-slate-500/20 text-slate-400'
                        }`}>
                          {analysis.thesis.entryType === 'left-entry'  ? 'Left-Side Entry' :
                           analysis.thesis.entryType === 'right-entry' ? 'Right-Side Entry' : 'No Entry'}
                        </span>
                      )}
                    </button>
                    {thesisOpen && (
                      <div className="rounded-lg bg-white/[0.03] border border-white/[0.06] p-2.5 space-y-2.5">
                        {analysis.thesis.claim && (
                          <p className="text-[11px] text-slate-200 leading-tight font-medium border-b border-white/[0.06] pb-2">
                            {analysis.thesis.claim}
                          </p>
                        )}
                        {/* Left side */}
                        <div className="space-y-1">
                          <div className="text-[9px] text-blue-400/80 uppercase tracking-wider font-medium">Left — Structure</div>
                          {analysis.thesis.left && <p className="text-[10px] text-slate-400 leading-snug">{analysis.thesis.left}</p>}
                          {(analysis.thesis.leftMustBeTrue || analysis.thesis.leftBreaksIf) && (
                            <div className="flex flex-col gap-0.5 mt-1">
                              {analysis.thesis.leftMustBeTrue && (
                                <span className="text-[9px] text-slate-500">
                                  <span className="text-slate-400">Must hold:</span> {analysis.thesis.leftMustBeTrue}
                                </span>
                              )}
                              {analysis.thesis.leftBreaksIf && (
                                <span className="text-[9px] text-red-400/70">
                                  <span className="text-red-400/90">Breaks if:</span> {analysis.thesis.leftBreaksIf}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                        {/* Right side */}
                        <div className="space-y-1 border-t border-white/[0.04] pt-2">
                          <div className="text-[9px] text-emerald-400/80 uppercase tracking-wider font-medium">Right — Market Confirmation</div>
                          {analysis.thesis.right && <p className="text-[10px] text-slate-400 leading-snug">{analysis.thesis.right}</p>}
                          {(analysis.thesis.rightMustBeTrue || analysis.thesis.rightBreaksIf) && (
                            <div className="flex flex-col gap-0.5 mt-1">
                              {analysis.thesis.rightMustBeTrue && (
                                <span className="text-[9px] text-slate-500">
                                  <span className="text-slate-400">Must hold:</span> {analysis.thesis.rightMustBeTrue}
                                </span>
                              )}
                              {analysis.thesis.rightBreaksIf && (
                                <span className="text-[9px] text-red-400/70">
                                  <span className="text-red-400/90">Breaks if:</span> {analysis.thesis.rightBreaksIf}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                        {/* Priced-in */}
                        {analysis.thesis.pricedIn && (
                          <div className="border-t border-white/[0.04] pt-2">
                            <div className="text-[9px] text-amber-400/80 uppercase tracking-wider font-medium mb-0.5">Priced-In Check</div>
                            <p className="text-[10px] text-slate-400 leading-snug">{analysis.thesis.pricedIn}</p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* ── AI Reasoning ──────────────────────────────────────── */}
                {analysis.reasoning && (
                  <div className="px-3 mb-3">
                    <button
                      onClick={() => setReasoningOpen(o => !o)}
                      className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-300 transition-colors mb-1.5 uppercase tracking-wider"
                    >
                      <ChevronRight className={`w-3 h-3 transition-transform ${reasoningOpen ? 'rotate-90' : ''}`} />
                      AI Reasoning
                    </button>
                    {reasoningOpen && (
                      <div className="rounded-lg bg-white/[0.03] border border-white/[0.06] p-2.5">
                        <p className="text-xs text-slate-400 leading-relaxed">{analysis.reasoning}</p>
                      </div>
                    )}
                  </div>
                )}

                {/* ── Key Risks ─────────────────────────────────────────── */}
                {analysis.risks && analysis.risks.length > 0 && (
                  <div className="px-3 mb-3">
                    <div className="text-[10px] text-slate-500 mb-1.5 uppercase tracking-wider">Key Risks</div>
                    <div className="space-y-1">
                      {analysis.risks.map((risk, i) => (
                        <div key={i} className="flex items-start gap-1.5">
                          <AlertTriangle className="w-3 h-3 text-amber-400/80 shrink-0 mt-0.5" />
                          <span className="text-[11px] text-amber-400/80 leading-tight">{risk}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ── Disclaimer ────────────────────────────────────────── */}
                <div className="px-3 pb-4">
                  <p className="text-[9px] text-slate-600 leading-relaxed">
                    AI-generated analysis is for informational purposes only and does not constitute financial advice.
                    Past performance does not guarantee future results. Trade at your own risk.
                  </p>
                </div>
              </>
            )}
          </div>
        )}

        {/* ──────────────────── CHAT TAB ────────────────────────────────── */}
        {tab === 'chat' && (
          <div className="flex flex-col h-full min-h-0">
            {/* Message list */}
            <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
              {chatHistory.length === 0 && (
                <div className="text-center text-slate-600 text-xs mt-8">
                  <MessageSquare className="w-6 h-6 mx-auto mb-2 opacity-30" />
                  Ask anything about this chart…
                </div>
              )}
              {chatHistory.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-violet-500/20 text-violet-100 border border-violet-500/20'
                      : 'bg-white/[0.04] text-slate-300 border border-white/[0.06]'
                  }`}>
                    {msg.content
                      ? msg.content
                      : (streaming && i === chatHistory.length - 1
                        ? <span className="animate-pulse">▋</span>
                        : '…')}
                  </div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>

            {/* Chat input */}
            <div className="p-3 border-t border-white/[0.07] shrink-0">
              {/* Quick prompts */}
              <div className="flex gap-1 mb-2 flex-wrap">
                {[
                  "Should I buy?",
                  "What's the risk?",
                  "Best entry?",
                  "Where's the stop?",
                  "Explain the trend",
                  "Any red flags?",
                  "Price target?",
                ].map(q => (
                  <button
                    key={q}
                    onClick={() => setChatInput(q)}
                    className="px-2 py-0.5 rounded text-[10px] bg-white/[0.04] text-slate-500 hover:text-slate-300 border border-white/[0.05] transition-all"
                  >
                    {q}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendChat()}
                  placeholder="Ask about this chart…"
                  className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-violet-500/40"
                />
                <button
                  onClick={sendChat}
                  disabled={streaming || !chatInput.trim()}
                  className="p-2 rounded-lg bg-violet-500/20 text-violet-400 border border-violet-500/25 hover:bg-violet-500/30 transition-all disabled:opacity-40"
                >
                  {streaming
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Send className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ──────────────────── ALERTS TAB ──────────────────────────────── */}
        {tab === 'alerts' && (
          <div className="flex-1 overflow-y-auto">
            {alerts.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 gap-2 text-slate-600">
                <Bell className="w-6 h-6 opacity-30" />
                <span className="text-xs">No alerts yet</span>
                <span className="text-[10px] text-slate-700">Alerts appear when patterns are detected</span>
              </div>
            ) : (
              <div className="p-3 space-y-1.5">
                {alerts.map((alert, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 p-2.5 rounded-lg bg-white/[0.03] border border-white/[0.05] hover:bg-white/[0.05] transition-colors"
                  >
                    <AlertIcon type={alert.type} />
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] text-slate-300 leading-tight">{alert.msg}</p>
                      <p className="text-[9px] text-slate-600 mt-0.5">{relativeTime(alert.time)}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
