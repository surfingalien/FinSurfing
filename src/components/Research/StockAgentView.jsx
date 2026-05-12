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
  Send, Cpu, RefreshCw, Sparkles, TrendingUp, BarChart2,
  AlertTriangle, ChevronRight, Zap, X, Info, Search, Share2,
} from 'lucide-react'
import AIAdvisoryView from './AIAdvisoryView'
import PublishSignalModal from '../Trading/PublishSignalModal'

// ── Markdown-lite renderer ────────────────────────────────────────────────────
// Renders the structured sections Claude outputs without a full MD library

function renderMarkdown(text) {
  if (!text) return null

  const lines = text.split('\n')
  const elements = []
  let key = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Bold header **Executive Summary** etc.
    if (/^\*\*(.+)\*\*$/.test(line.trim())) {
      elements.push(
        <h3 key={key++} className="text-sm font-bold text-mint-400 mt-4 mb-1 flex items-center gap-1.5">
          <ChevronRight className="w-3 h-3" />
          {line.trim().replace(/\*\*/g, '')}
        </h3>
      )
      continue
    }

    // Bullet points
    if (/^[-•*]\s/.test(line.trim())) {
      const content = line.trim().replace(/^[-•*]\s/, '')
      elements.push(
        <div key={key++} className="flex items-start gap-2 text-sm text-slate-300 my-0.5 ml-3">
          <span className="text-mint-500 mt-1.5 shrink-0">·</span>
          <span dangerouslySetInnerHTML={{ __html: formatInline(content) }} />
        </div>
      )
      continue
    }

    // Numbered list
    if (/^\d+\.\s/.test(line.trim())) {
      const content = line.trim().replace(/^\d+\.\s/, '')
      const num = line.trim().match(/^(\d+)\./)[1]
      elements.push(
        <div key={key++} className="flex items-start gap-2 text-sm text-slate-300 my-0.5 ml-3">
          <span className="text-mint-500 shrink-0 font-mono text-xs mt-0.5">{num}.</span>
          <span dangerouslySetInnerHTML={{ __html: formatInline(content) }} />
        </div>
      )
      continue
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      elements.push(<hr key={key++} className="border-white/[0.06] my-3" />)
      continue
    }

    // Empty line
    if (!line.trim()) {
      elements.push(<div key={key++} className="h-1" />)
      continue
    }

    // Normal paragraph
    elements.push(
      <p key={key++} className="text-sm text-slate-300 leading-relaxed my-0.5"
        dangerouslySetInnerHTML={{ __html: formatInline(line) }} />
    )
  }

  return elements
}

function formatInline(text) {
  return text
    // **bold**
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-white font-semibold">$1</strong>')
    // *italic*
    .replace(/\*(.+?)\*/g, '<em class="text-slate-200">$1</em>')
    // `code`
    .replace(/`([^`]+)`/g, '<code class="font-mono text-xs bg-white/10 px-1.5 py-0.5 rounded text-mint-300">$1</code>')
    // $price highlights
    .replace(/\$(\d[\d,.]+)/g, '<span class="font-mono text-emerald-300">$$1</span>')
}

// ── Tool call indicator ───────────────────────────────────────────────────────

const TOOL_META = {
  get_technical_analysis: { icon: '📊', label: 'Technical Analysis', color: 'mint' },
  get_fundamentals:       { icon: '📋', label: 'Fundamentals + Sentiment', color: 'indigo' },
  compare_stocks:         { icon: '⚖️', label: 'Stock Comparison', color: 'amber' },
}

function ToolCallBadge({ name, input, done }) {
  const meta = TOOL_META[name] || { icon: '🔧', label: name, color: 'mint' }
  const sym  = input?.symbol || (input?.symbols ? input.symbols.join(', ') : '')

  const colorDone = meta.color === 'indigo' ? 'bg-indigo-500/5 border-indigo-500/20 text-indigo-300'
    : meta.color === 'amber' ? 'bg-amber-500/5 border-amber-500/20 text-amber-300'
    : 'bg-emerald-500/5 border-emerald-500/20 text-emerald-400'
  const colorPending = meta.color === 'indigo' ? 'bg-indigo-500/5 border-indigo-500/20 text-indigo-400'
    : meta.color === 'amber' ? 'bg-amber-500/5 border-amber-500/20 text-amber-400'
    : 'bg-mint-500/5 border-mint-500/20 text-mint-400'

  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-mono border
      ${done ? colorDone : colorPending}`}>
      {done
        ? <><BarChart2 className="w-3 h-3 shrink-0" /> {meta.icon} {meta.label}{sym ? `: ${sym}` : ''} ✓</>
        : <><RefreshCw className="w-3 h-3 animate-spin shrink-0" /> {meta.icon} Running {meta.label}{sym ? ` for ${sym}` : ''}…</>
      }
    </div>
  )
}

// ── Message bubble ────────────────────────────────────────────────────────────

function MessageBubble({ msg }) {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] bg-mint-500/10 border border-mint-500/20 rounded-2xl rounded-tr-sm px-4 py-2.5">
          <p className="text-sm text-white">{msg.content}</p>
        </div>
      </div>
    )
  }

  // Assistant message
  return (
    <div className="flex gap-3 max-w-[95%]">
      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-mint-400/20 to-indigo-500/20 border border-mint-500/30 flex items-center justify-center shrink-0 mt-0.5">
        <Cpu className="w-3.5 h-3.5 text-mint-400" />
      </div>
      <div className="flex-1 space-y-2">
        {/* Tool calls */}
        {msg.toolCalls?.map((tc, i) => (
          <ToolCallBadge key={i} name={tc.name} input={tc.input} done={tc.done} />
        ))}

        {/* Text content */}
        {msg.content && (
          <div className="glass rounded-2xl rounded-tl-sm px-4 py-3 border border-white/[0.06]">
            {renderMarkdown(msg.content)}
          </div>
        )}

        {/* Streaming cursor */}
        {msg.streaming && (
          <div className="flex items-center gap-1.5 px-2">
            <div className="w-1.5 h-1.5 rounded-full bg-mint-400 animate-bounce" style={{ animationDelay: '0ms' }} />
            <div className="w-1.5 h-1.5 rounded-full bg-mint-400 animate-bounce" style={{ animationDelay: '150ms' }} />
            <div className="w-1.5 h-1.5 rounded-full bg-mint-400 animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
        )}

        {/* Usage */}
        {msg.usage && (
          <div className="text-[10px] text-slate-700 px-1">
            {msg.usage.input_tokens}↑ {msg.usage.output_tokens}↓ tokens
          </div>
        )}
      </div>
    </div>
  )
}

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

// ── No API key banner ─────────────────────────────────────────────────────────

function NoKeyBanner() {
  return (
    <div className="glass rounded-xl p-6 border border-amber-500/20 flex items-start gap-4">
      <Info className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
      <div>
        <p className="text-sm font-semibold text-white mb-1">Anthropic API Key Required</p>
        <p className="text-xs text-slate-400 leading-relaxed">
          The AI Agent requires an <code className="font-mono text-mint-300 bg-white/5 px-1 rounded">ANTHROPIC_API_KEY</code> environment variable.
          Add it to your Railway service variables, then redeploy.
        </p>
        <p className="text-xs text-slate-500 mt-2">
          Get your key at <span className="text-mint-400">console.anthropic.com</span>
        </p>
      </div>
    </div>
  )
}

// ── Main StockAgentView ───────────────────────────────────────────────────────

export default function StockAgentView({ portfolio }) {
  const [tab,         setTab]        = useState('agent')   // 'agent' | 'classic'
  const [messages,    setMessages]  = useState([])
  const [input,       setInput]     = useState('')
  const [symbol,      setSymbol]    = useState('')
  const [streaming,   setStreaming] = useState(false)
  const [hasKey,      setHasKey]    = useState(null)      // null = unknown, true/false
  const [agentCaps,   setAgentCaps] = useState({})        // { hasFMP, hasAV }
  const [error,       setError]     = useState(null)
  const [showPublish, setShowPublish] = useState(false)

  const bottomRef  = useRef(null)
  const inputRef   = useRef(null)

  // Check API key + data-source availability on mount
  useEffect(() => {
    fetch('/api/agent/health')
      .then(r => r.json())
      .then(d => { setHasKey(d.hasKey); setAgentCaps({ hasFMP: d.hasFMP, hasAV: d.hasAV, hasFinnhub: d.hasFinnhub }) })
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
        body:    JSON.stringify({ prompt: text, symbol: sym, history }),
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
          <span className="text-[10px] text-slate-700 font-mono border-l border-white/[0.06] pl-2">claude-opus-4-7</span>
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
                <button onClick={() => setShowPublish(true)} disabled={streaming}
                  className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 glass rounded-lg text-xs text-mint-400 hover:text-mint-300 border border-mint-500/20 hover:border-mint-500/40 transition-all disabled:opacity-50">
                  <Share2 className="w-3 h-3" /> Publish Signal
                </button>
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
              Not financial advice · Real-time data via Yahoo Finance · Powered by Anthropic Claude
            </p>
          </div>
        </div>
      )}

      {/* Publish Signal modal — pre-filled with last assistant message */}
      {showPublish && (
        <PublishSignalModal
          symbol={symbol}
          analysis={(() => {
            const last = [...messages].reverse().find(m => m.role === 'assistant' && m.content && !m.streaming)
            return last?.content?.slice(0, 1000) || ''
          })()}
          onClose={() => setShowPublish(false)}
        />
      )}
    </div>
  )
}
