import { useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Bot, X, Send, ChevronDown, Loader2, Zap, TrendingUp, BarChart2, Globe } from 'lucide-react'
import { useApiKeys } from '../../contexts/ApiKeysContext'
import { useAuth } from '../../contexts/AuthContext'

const WELCOME = `Hi! I'm **FinSurf Copilot** — your AI analyst with live market access.

I can:
- 📊 **Scan the market** — rank top picks across stocks, ETFs, crypto
- 🎯 **Get buy signals** — channeling Buffett, Dalio, Lynch, and more
- 🔍 **Analyze any ticker** — technical + AI signal with entry/stop/target
- 📣 **Check social sentiment** — live Reddit/X buzz on any symbol
- 🌐 **Read the macro** — rates, inflation, VIX, growth regime

What would you like to explore?`

const QUICK_PROMPTS = [
  { label: 'Top picks today', icon: TrendingUp, prompt: 'Run a broad market scan and give me the top 5 picks right now' },
  { label: 'Analyze NVDA', icon: BarChart2, prompt: 'Analyze NVDA — give me the full technical and AI signal' },
  { label: 'Macro regime', icon: Globe, prompt: 'What is the current macro regime and how should I position?' },
  { label: 'Buffett ideas', icon: Zap, prompt: 'Give me buy recommendations using Warren Buffett\'s philosophy' },
]

function MessageBubble({ msg }) {
  const isUser = msg.role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      {!isUser && (
        <div className="w-7 h-7 rounded-full bg-[#00ffcc]/20 border border-[#00ffcc]/30 flex items-center justify-center flex-shrink-0 mr-2 mt-0.5">
          <Bot size={14} className="text-[#00ffcc]" />
        </div>
      )}
      <div
        className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
          isUser
            ? 'bg-[#003d33] border border-[#00ffcc]/30 text-white ml-auto'
            : 'bg-[#111827] border border-white/[0.08] text-slate-200'
        }`}
      >
        <FormattedText text={msg.content} />
      </div>
    </div>
  )
}

function ToolBadge({ name }) {
  const labels = {
    scan_market: '🔭 Scanning market...',
    get_recommendations: '🎯 Fetching recommendations...',
    analyze_symbol: '📈 Analyzing symbol...',
    get_social_sentiment: '📣 Checking social sentiment...',
    get_macro: '🌐 Reading macro indicators...',
    get_earnings_catalyst: '📅 Fetching earnings catalyst...',
    get_options_flow: '📊 Reading options flow...',
  }
  return (
    <div className="flex items-center gap-2 text-xs text-[#00ffcc]/70 mb-2 pl-9">
      <Loader2 size={11} className="animate-spin" />
      <span>{labels[name] || `Running ${name}...`}</span>
    </div>
  )
}

// Lightweight markdown-like renderer (bold, newlines, lists)
function FormattedText({ text }) {
  if (!text) return null
  const parts = text.split('\n').map((line, i) => {
    // Bold: **text**
    const formatted = line.split(/(\*\*[^*]+\*\*)/).map((part, j) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={j} className="text-[#00ffcc] font-semibold">{part.slice(2, -2)}</strong>
      }
      return part
    })
    return <span key={i}>{formatted}{i < text.split('\n').length - 1 && <br />}</span>
  })
  return <>{parts}</>
}

// Available providers — claudian-style providerId + providerState
const PROVIDERS = [
  { id: 'claude', label: 'Claude',  color: '#00ffcc', description: 'claude-sonnet-4-6' },
  { id: 'groq',   label: 'Groq',    color: '#f472b6', description: 'llama-3.3-70b' },
  { id: 'codex',  label: 'Codex',   color: '#60a5fa', description: 'gpt-4o' },
  { id: 'zai',    label: 'GLM',     color: '#a78bfa', description: 'Z.ai glm-4.6' },
  { id: 'qwen',   label: 'Qwen',    color: '#fbbf24', description: 'qwen-plus' },
]

export default function FinSurfCopilot({ portfolio = [], watchlist = [] }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([{ role: 'assistant', content: WELCOME }])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [activeTools, setActiveTools] = useState([])
  const [providerId, setProviderId] = useState('claude')
  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)
  const abortRef = useRef(null)
  const { keys } = useApiKeys?.() ?? { keys: {} }
  const { accessToken } = useAuth?.() ?? {}
  const activeProvider = PROVIDERS.find(p => p.id === providerId) || PROVIDERS[0]

  useEffect(() => {
    if (open) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
      inputRef.current?.focus()
    }
  }, [open, messages])

  const sendMessage = useCallback(async (text) => {
    const userText = text?.trim() || input.trim()
    if (!userText || streaming) return

    setInput('')
    const userMsg = { role: 'user', content: userText }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setStreaming(true)
    setActiveTools([])

    // Optimistic assistant placeholder
    setMessages(m => [...m, { role: 'assistant', content: '' }])

    abortRef.current = new AbortController()

    try {
      const apiMessages = newMessages
        .filter(m => m.content)
        .map(m => ({ role: m.role, content: m.content }))

      const extraHeaders = {}
      for (const [k, v] of Object.entries(keys || {})) {
        if (v) extraHeaders[`x-${k.toLowerCase()}-key`] = v
      }
      if (accessToken) extraHeaders['Authorization'] = `Bearer ${accessToken}`

      const r = await fetch('/api/copilot/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body: JSON.stringify({
          messages: apiMessages,
          portfolio: portfolio.map?.(p => p.symbol || p).filter(Boolean),
          watchlist: watchlist.map?.(w => w.symbol || w).filter(Boolean),
          providerId,
        }),
        signal: abortRef.current.signal,
      })

      if (!r.ok) throw new Error(`HTTP ${r.status}`)

      const reader = r.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const event = JSON.parse(line.slice(6))
            if (event.type === 'text') {
              setMessages(m => {
                const copy = [...m]
                copy[copy.length - 1] = {
                  ...copy[copy.length - 1],
                  content: (copy[copy.length - 1].content || '') + event.delta,
                }
                return copy
              })
            } else if (event.type === 'tool_start') {
              setActiveTools(event.tools.map(t => t.name))
            } else if (event.type === 'tool_results') {
              setActiveTools([])
            } else if (event.type === 'done') {
              setActiveTools([])
            } else if (event.type === 'error') {
              setMessages(m => {
                const copy = [...m]
                copy[copy.length - 1] = { role: 'assistant', content: `❌ Error: ${event.message}` }
                return copy
              })
            }
          } catch {}
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setMessages(m => {
          const copy = [...m]
          copy[copy.length - 1] = { role: 'assistant', content: `❌ ${err.message || 'Connection failed'}` }
          return copy
        })
      }
    } finally {
      setStreaming(false)
      setActiveTools([])
    }
  }, [input, messages, streaming, portfolio, watchlist, keys, accessToken])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  }

  return (
    <>
      {/* Floating trigger button */}
      <AnimatePresence>
        {!open && (
          <motion.button
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            onClick={() => setOpen(true)}
            className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-gradient-to-br from-[#00ffcc]/90 to-[#00b4ff]/90 shadow-lg shadow-[#00ffcc]/20 flex items-center justify-center hover:scale-105 transition-transform"
            title="Open FinSurf Copilot"
          >
            <Bot size={24} className="text-[#060810]" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* Chat panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.96 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="fixed bottom-6 right-6 z-50 w-[420px] max-w-[calc(100vw-2rem)] h-[600px] max-h-[calc(100vh-5rem)] flex flex-col bg-[#0a0f1a] rounded-2xl border border-white/[0.08] shadow-2xl shadow-black/60 overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06] flex-shrink-0">
              <div className="flex items-center gap-2">
                <div
                  className="w-7 h-7 rounded-full border flex items-center justify-center transition-colors"
                  style={{ background: activeProvider.color + '20', borderColor: activeProvider.color + '50' }}
                >
                  <Bot size={15} style={{ color: activeProvider.color }} />
                </div>
                <div>
                  <div className="text-sm font-semibold text-white">FinSurf Copilot</div>
                  <div className="text-[10px] text-slate-500">
                    {activeProvider.description} · multi-provider
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {streaming && <Loader2 size={14} className="animate-spin mr-1" style={{ color: activeProvider.color }} />}
                {/* Provider switcher */}
                <div className="flex rounded-lg overflow-hidden border border-white/[0.08]">
                  {PROVIDERS.map(p => (
                    <button
                      key={p.id}
                      onClick={() => setProviderId(p.id)}
                      disabled={streaming}
                      title={p.description}
                      className={`px-2 py-1 text-[10px] font-medium transition-all disabled:opacity-40 ${
                        providerId === p.id
                          ? 'text-[#060810]'
                          : 'text-slate-500 hover:text-white bg-transparent'
                      }`}
                      style={providerId === p.id ? { background: p.color } : {}}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <button onClick={() => setOpen(false)} className="p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-500 hover:text-white transition-colors">
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1 min-h-0">
              {messages.map((msg, i) => (
                <MessageBubble key={i} msg={msg} />
              ))}
              {activeTools.map(tool => <ToolBadge key={tool} name={tool} />)}
              <div ref={messagesEndRef} />
            </div>

            {/* Quick prompts (only when no user messages yet) */}
            {messages.length === 1 && (
              <div className="px-3 pb-2 grid grid-cols-2 gap-1.5 flex-shrink-0">
                {QUICK_PROMPTS.map(({ label, icon: Icon, prompt }) => (
                  <button
                    key={label}
                    onClick={() => sendMessage(prompt)}
                    disabled={streaming}
                    className="flex items-center gap-1.5 px-2.5 py-2 rounded-xl bg-[#111827] border border-white/[0.08] text-xs text-slate-400 hover:text-white hover:bg-[#1e2a3a] transition-all text-left disabled:opacity-40"
                  >
                    <Icon size={12} className="text-[#00ffcc] flex-shrink-0" />
                    {label}
                  </button>
                ))}
              </div>
            )}

            {/* Input */}
            <div className="px-3 pb-3 flex-shrink-0">
              <div className="flex items-end gap-2 bg-[#111827] border border-white/[0.10] rounded-xl px-3 py-2">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask anything — scan market, analyze TSLA, check NVDA sentiment…"
                  rows={1}
                  disabled={streaming}
                  className="flex-1 bg-transparent text-sm text-white placeholder-slate-600 resize-none outline-none min-h-[1.25rem] max-h-24 leading-5 disabled:opacity-60"
                  style={{ scrollbarWidth: 'none' }}
                />
                <button
                  onClick={() => sendMessage()}
                  disabled={!input.trim() || streaming}
                  className="flex-shrink-0 w-7 h-7 rounded-lg bg-[#00ffcc]/20 border border-[#00ffcc]/30 flex items-center justify-center hover:bg-[#00ffcc]/30 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                >
                  <Send size={13} className="text-[#00ffcc]" />
                </button>
              </div>
              <p className="text-[10px] text-slate-600 text-center mt-1.5">Not financial advice · Powered by Claude</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
