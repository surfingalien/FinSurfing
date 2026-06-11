/**
 * StockAgentView.jsx
 *
 * Real-time Claude-powered stock analyst agent with:
 * - SSE streaming from POST /api/agent/analyze
 * - Tool call visibility (shows when get_stock_data is fetching)
 * - Markdown-rendered research briefings
 * - Quick-prompt buttons for common analysis types
 * - Conversation history (up to 10 turns)
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import {
  Send, RefreshCw, Sparkles, BarChart2,
  AlertTriangle, X, Search,
} from 'lucide-react'
import AIAdvisoryView from './AIAdvisoryView'
import { MessageBubble } from './agent/MessageBubble'
import { NoKeyBanner } from './agent/NoKeyBanner'

// ── Quick prompts ─────────────────────────────────────────────────────────────

const QUICK_PROMPTS = [
  { icon: '📊', label: 'Full Analysis',         prompt: 'Give me a complete multi-specialist analysis for {sym}: technical, fundamental, sentiment, and a trade hypothesis with entry/target/stop.' },
  { icon: '📈', label: 'Trade Setup',           prompt: 'What is the current trade setup for {sym}? Include entry zone, target price, stop loss, and ATR-based risk/reward.' },
  { icon: '💼', label: 'Fundamental Deep Dive', prompt: 'Run a fundamental analysis on {sym}: valuation vs peers, margin trends, earnings quality, and DCF fair value vs current price.' },
  { icon: '📰', label: 'News & Sentiment',      prompt: 'What is the current news sentiment and insider activity for {sym}? Are there any catalysts or red flags?' },
  { icon: '⚡', label: 'Quick Signal',          prompt: 'Quick signal for {sym}: overall bias (bullish/bearish/neutral), key RSI and MACD readings, and the most important level to watch.' },
  { icon: '📉', label: 'Support & Resistance',  prompt: 'Identify and explain the key support and resistance levels for {sym} using the technical analysis tool.' },
  { icon: '⚖️', label: 'Compare vs Sector',    prompt: 'Compare {sym} vs SPY and QQQ on relative strength, trend alignment, and RSI momentum.' },
  { icon: '⚠️', label: 'Risk Assessment',      prompt: 'Assess the key risks for a long position in {sym} right now — technical, fundamental, and macro.' },
]

// ── Main StockAgentView ───────────────────────────────────────────────────────

const MODELS = [
  { id: 'claude-opus-4-5',   label: 'Claude Opus 4',   provider: 'claude' },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4', provider: 'claude' },
  { id: 'claude-haiku-4-5',  label: 'Claude Haiku 4',  provider: 'claude' },
  { id: 'gemini-2.0-flash',  label: 'Gemini Flash',    provider: 'gemini' },
  { id: 'gemini-1.5-pro',    label: 'Gemini 1.5 Pro',  provider: 'gemini' },
]

export default function StockAgentView({ portfolio }) {
  const [tab,         setTab]        = useState('agent')   // 'agent' | 'classic'
  const [messages,    setMessages]  = useState([])
  const [input,       setInput]     = useState('')
  const [symbol,      setSymbol]    = useState('')
  const [model,       setModel]     = useState('claude-opus-4-5')
  const [streaming,   setStreaming] = useState(false)
  const [hasKey,      setHasKey]    = useState(null)      // null = unknown, true/false
  const [agentCaps,   setAgentCaps] = useState({})        // { hasFMP, hasAV, hasGemini }
  const [error,       setError]     = useState(null)

  const bottomRef  = useRef(null)
  const inputRef   = useRef(null)

  // Check API key + data-source availability on mount
  useEffect(() => {
    fetch('/api/agent/health')
      .then(r => r.json())
      .then(d => { setHasKey(d.hasKey); setAgentCaps({ hasFMP: d.hasFMP, hasAV: d.hasAV, hasFinnhub: d.hasFinnhub, hasGemini: d.hasGemini }) })
      .catch(() => setHasKey(false))
  }, [])

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Welcome message
  useEffect(() => {
    if (hasKey === true && messages.length === 0) {
      setMessages([{
        id:   'welcome',
        role: 'assistant',
        content: `**Welcome to FinSurf AI Agent** 👋

I'm your real-time stock analyst powered by Claude. I can:

- **Fetch live data** and compute technical indicators (RSI, MACD, Bollinger Bands, SMA50/200, ATR)
- **Identify** support/resistance levels and chart patterns
- **Build** trade hypotheses with entry, target, and stop-loss levels
- **Compare** stocks and analyze relative strength
- **Screen** for momentum, value, or technical setups

**How to start:** Enter a ticker in the symbol box, then ask me anything — or pick a quick prompt below.`,
      }])
    }
  }, [hasKey])

  // ── Build history for API ──
  const buildHistory = useCallback(() => {
    return messages
      .filter(m => m.role === 'user' || (m.role === 'assistant' && m.content && !m.streaming))
      .slice(-8)
      .map(m => ({ role: m.role, content: m.content }))
  }, [messages])

  // ── Send message ──
  const sendMessage = useCallback(async (promptText) => {
    const text = (promptText || input).trim()
    if (!text || streaming) return

    const sym = symbol.trim().toUpperCase() || null

    setInput('')
    setError(null)
    setStreaming(true)

    // Add user message
    const userMsg = { id: Date.now() + '-u', role: 'user', content: text }
    const assistantId = Date.now() + '-a'
    const assistantMsg = {
      id:        assistantId,
      role:      'assistant',
      content:   '',
      toolCalls: [],
      streaming: true,
    }

    setMessages(prev => [...prev, userMsg, assistantMsg])

    try {
      const history = buildHistory()

      const res = await fetch('/api/agent/analyze', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ prompt: text, symbol: sym, history, model }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        if (err.code === 'NO_API_KEY') setHasKey(false)
        throw new Error(err.error || `Server error ${res.status}`)
      }

      // Stream SSE events
      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer    = ''

      const updateAssistant = (updater) => {
        setMessages(prev => prev.map(m => m.id === assistantId ? updater(m) : m))
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() // keep incomplete line

        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          try {
            const evt = JSON.parse(line.slice(5).trim())

            switch (evt.event) {
              case 'delta':
                updateAssistant(m => ({ ...m, content: m.content + (evt.text || '') }))
                break

              case 'tool_start':
                updateAssistant(m => ({
                  ...m,
                  toolCalls: [...m.toolCalls, { name: evt.name, input: evt.input, done: false }],
                }))
                break

              case 'tool_end':
                updateAssistant(m => ({
                  ...m,
                  toolCalls: m.toolCalls.map(tc =>
                    tc.input?.symbol === evt.symbol ? { ...tc, done: true } : tc
                  ),
                }))
                break

              case 'tool_error':
                updateAssistant(m => ({
                  ...m,
                  toolCalls: m.toolCalls.map(tc =>
                    tc.name === evt.name ? { ...tc, done: true, error: evt.error } : tc
                  ),
                }))
                break

              case 'done':
                updateAssistant(m => ({
                  ...m,
                  streaming: false,
                  usage:     evt.usage,
                }))
                break

              case 'error':
                setError(evt.message)
                updateAssistant(m => ({ ...m, streaming: false }))
                break
            }
          } catch {
            // skip malformed line
          }
        }
      }
    } catch (err) {
      setError(err.message)
      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, streaming: false, content: m.content || '⚠️ ' + err.message } : m
      ))
    } finally {
      setStreaming(false)
      inputRef.current?.focus()
    }
  }, [input, symbol, streaming, buildHistory])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const clearChat = () => {
    setMessages([])
    setError(null)
    setTimeout(() => setHasKey(h => h), 50) // re-trigger welcome
  }

  const portfolioSymbols = portfolio?.positions?.map(p => p.symbol) ?? []

  return (
    <div className="space-y-0 animate-fade-in flex flex-col" style={{ height: 'calc(100vh - 112px)', minHeight: 400 }}>

      {/* ── Tabs ── */}
      <div className="flex items-center gap-2 border-b border-white/[0.06] pb-0 shrink-0">
        {[
          { id: 'agent',   label: 'AI Agent',       icon: <Sparkles className="w-3.5 h-3.5" /> },
          { id: 'classic', label: 'Classic Research', icon: <BarChart2 className="w-3.5 h-3.5" /> },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-all
              ${tab === t.id
                ? 'border-mint-500 text-mint-400'
                : 'border-transparent text-slate-400 hover:text-white'}`}>
            {t.icon}{t.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 pr-1 pb-0.5">
          {/* Data source badges */}
          <span className="text-[10px] text-slate-600 font-mono">Yahoo ✓</span>
          <span className={`text-[10px] font-mono ${agentCaps.hasFMP ? 'text-emerald-500' : 'text-slate-700'}`}>
            FMP {agentCaps.hasFMP ? '✓' : '○'}
          </span>
          <span className={`text-[10px] font-mono ${agentCaps.hasAV ? 'text-emerald-500' : 'text-slate-700'}`}>
            AV {agentCaps.hasAV ? '✓' : '○'}
          </span>
          <span className={`text-[10px] font-mono ${agentCaps.hasFinnhub ? 'text-emerald-500' : 'text-slate-700'}`}>
            Finnhub {agentCaps.hasFinnhub ? '✓' : '○'}
          </span>
          {/* Model selector */}
          <div className="border-l border-white/[0.06] pl-2">
            <select
              value={model}
              onChange={e => setModel(e.target.value)}
              disabled={streaming}
              className="bg-white/[0.04] border border-white/[0.08] rounded-md px-2 py-0.5 text-[10px]
                         text-slate-300 font-mono focus:outline-none focus:border-mint-500/40
                         disabled:opacity-50 cursor-pointer"
            >
              {MODELS.filter(m => m.provider === 'claude' || agentCaps.hasGemini).map(m => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* ── Classic tab ── */}
      {tab === 'classic' && (
        <div className="flex-1 overflow-auto py-5">
          <AIAdvisoryView portfolio={portfolio} />
        </div>
      )}

      {/* ── Agent tab ── */}
      {tab === 'agent' && (
        <div className="flex flex-col flex-1 min-h-0">

          {/* No API key banner */}
          {hasKey === false && (
            <div className="shrink-0 py-4">
              <NoKeyBanner />
            </div>
          )}

          {/* ── Symbol + controls bar ── */}
          <div className="shrink-0 flex items-center gap-2 py-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
              <input
                value={symbol}
                onChange={e => setSymbol(e.target.value.toUpperCase())}
                placeholder="TICKER"
                className="input pl-8 w-28 font-mono text-sm uppercase"
                maxLength={6}
              />
            </div>

            {/* Portfolio shortcuts */}
            <div className="flex items-center gap-1.5 overflow-x-auto flex-1">
              {[...portfolioSymbols.slice(0, 6), 'SPY', 'QQQ', 'NVDA', 'AAPL'].map(s => (
                <button key={s} onClick={() => setSymbol(s)}
                  className={`px-2.5 py-1 glass rounded-md text-xs font-mono shrink-0 border transition-all
                    ${symbol === s
                      ? 'text-mint-400 border-mint-500/40 bg-mint-500/5'
                      : 'text-slate-400 border-white/[0.06] hover:text-mint-400 hover:border-mint-500/30'}`}>
                  {s}
                </button>
              ))}
            </div>

            {messages.length > 1 && (
              <>
                <button onClick={clearChat}
                  className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 glass rounded-lg text-xs text-slate-400 hover:text-white border border-white/[0.06] hover:border-white/[0.15] transition-all">
                  <X className="w-3 h-3" /> Clear
                </button>
              </>
            )}
          </div>

          {/* ── Quick prompts ── */}
          {messages.length <= 1 && (
            <div className="shrink-0 grid grid-cols-2 sm:grid-cols-4 gap-2 pb-3">
              {QUICK_PROMPTS.map((qp, i) => (
                <button key={i}
                  onClick={() => {
                    const prompt = qp.prompt.replace('{sym}', symbol || 'AAPL')
                    sendMessage(prompt)
                  }}
                  disabled={streaming || hasKey === false}
                  className="glass rounded-xl p-3 text-left border border-white/[0.06] hover:border-mint-500/30 transition-all group disabled:opacity-40">
                  <div className="text-base mb-1">{qp.icon}</div>
                  <div className="text-xs font-medium text-slate-300 group-hover:text-white transition-colors">{qp.label}</div>
                </button>
              ))}
            </div>
          )}

          {/* ── Messages ── */}
          <div className="flex-1 overflow-y-auto space-y-4 py-2 pr-1">
            {messages.map(msg => (
              <MessageBubble key={msg.id} msg={msg} />
            ))}

            {/* Error */}
            {error && (
              <div className="flex items-start gap-3 glass rounded-xl p-4 border border-red-500/20">
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm text-red-400">{error}</p>
                  <button onClick={() => setError(null)} className="text-xs text-slate-500 hover:text-white mt-1">Dismiss</button>
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* ── Input bar ── */}
          <div className="shrink-0 pt-3 border-t border-white/[0.06]">
            <div className="flex gap-2 items-end">
              <div className="flex-1 relative">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={streaming || hasKey === false}
                  placeholder={
                    hasKey === false
                      ? 'API key required…'
                      : symbol
                        ? `Ask about ${symbol}… (Enter to send)`
                        : 'Ask about any stock… (set ticker above, or just ask)'
                  }
                  rows={1}
                  className="input w-full resize-none py-2.5 pr-10 text-sm leading-relaxed disabled:opacity-50"
                  style={{ minHeight: 44, maxHeight: 120 }}
                  onInput={e => {
                    e.target.style.height = 'auto'
                    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
                  }}
                />
              </div>
              <button
                onClick={() => sendMessage()}
                disabled={streaming || !input.trim() || hasKey === false}
                className="btn-primary h-11 px-4 flex items-center gap-1.5 shrink-0 disabled:opacity-50">
                {streaming
                  ? <RefreshCw className="w-4 h-4 animate-spin" />
                  : <Send className="w-4 h-4" />}
                {streaming ? 'Thinking…' : 'Send'}
              </button>
            </div>
            <p className="text-[10px] text-slate-700 mt-1.5 px-1">
              Not financial advice · Real-time data via Yahoo Finance · Model: {model}
            </p>
          </div>
        </div>
      )}


    </div>
  )
}
