/**
 * PublishSignalModal.jsx
 *
 * Modal for publishing a trading signal to the AI-Trader network.
 * Pre-filled with symbol + analysis text extracted from the AI Agent's last response.
 */

import { useState, useEffect, useRef } from 'react'
import { X, Send, TrendingUp, TrendingDown, Minus, AlertTriangle, CheckCircle, Newspaper, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react'
import { useAITrader } from '../../contexts/AITraderContext'
import { getMarketContext } from '../../services/aiTraderService'

const ACTION_OPTIONS = [
  { value: 'buy',   label: 'BUY',   icon: TrendingUp,   cls: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' },
  { value: 'sell',  label: 'SELL',  icon: TrendingDown,  cls: 'text-red-400 border-red-500/30 bg-red-500/10' },
  { value: 'short', label: 'SHORT', icon: TrendingDown,  cls: 'text-orange-400 border-orange-500/30 bg-orange-500/10' },
  { value: 'cover', label: 'COVER', icon: Minus,         cls: 'text-slate-400 border-slate-500/30 bg-slate-500/10' },
]

// ── Market context mini-panel (E) ─────────────────────────────────────────────

function MarketContextPanel({ symbol }) {
  const [ctx,      setCtx]      = useState(null)
  const [loading,  setLoading]  = useState(false)
  const [expanded, setExpanded] = useState(true)
  const debounce = useRef(null)

  useEffect(() => {
    if (!symbol || symbol.length < 1) return
    setLoading(true)
    clearTimeout(debounce.current)
    debounce.current = setTimeout(async () => {
      try {
        const data = await getMarketContext(symbol)
        setCtx(data)
      } catch {
        setCtx(null)
      } finally {
        setLoading(false)
      }
    }, 600)
    return () => clearTimeout(debounce.current)
  }, [symbol])

  const news = ctx?.news?.items || ctx?.news?.news || ctx?.news || []
  const newsArray = Array.isArray(news) ? news.slice(0, 4) : []

  if (!symbol) return null

  return (
    <div className="rounded-xl border border-white/[0.06] overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-2 px-4 py-2.5 bg-white/[0.02] hover:bg-white/[0.04] transition-colors text-left"
      >
        <Newspaper className="w-3.5 h-3.5 text-slate-500" />
        <span className="text-xs font-medium text-slate-400 flex-1">Market Context — {symbol}</span>
        {loading && <div className="w-3 h-3 border border-slate-600 border-t-slate-400 rounded-full animate-spin" />}
        {expanded ? <ChevronUp className="w-3.5 h-3.5 text-slate-600" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-600" />}
      </button>

      {expanded && (
        <div className="px-4 pb-3 pt-1 space-y-1.5">
          {loading && !newsArray.length ? (
            <p className="text-xs text-slate-600 py-2">Fetching news…</p>
          ) : newsArray.length === 0 ? (
            <p className="text-xs text-slate-600 py-2">No recent news found.</p>
          ) : (
            newsArray.map((item, i) => {
              const title     = item.title || item.headline || item.summary || ''
              const publisher = item.publisher || item.source || ''
              const url       = item.link || item.url || null
              return (
                <div key={i} className="flex items-start gap-2 py-1 border-b border-white/[0.04] last:border-0">
                  <span className="text-slate-600 text-xs mt-0.5 shrink-0">·</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-slate-300 leading-snug line-clamp-2">{title}</p>
                    {publisher && <p className="text-[10px] text-slate-600 mt-0.5">{publisher}</p>}
                  </div>
                  {url && (
                    <a href={url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
                      className="shrink-0 text-slate-700 hover:text-mint-400 transition-colors mt-0.5">
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

// ── Main modal ────────────────────────────────────────────────────────────────

export default function PublishSignalModal({ symbol = '', analysis = '', onClose }) {
  const { publishSignal, publishing, status } = useAITrader()

  const [form, setForm]   = useState({
    symbol:   symbol.toUpperCase(),
    action:   'buy',
    price:    '',
    quantity: '',
    analysis: analysis.slice(0, 1000),
  })
  const [success, setSuccess] = useState(false)
  const [error,   setError]   = useState(null)

  const field = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }))

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    try {
      await publishSignal({
        symbol:   form.symbol.toUpperCase(),
        action:   form.action,
        price:    form.price    ? parseFloat(form.price)    : undefined,
        quantity: form.quantity ? parseInt(form.quantity)   : undefined,
        analysis: form.analysis,
      })
      setSuccess(true)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(6,8,16,0.85)', backdropFilter: 'blur(6px)' }}>

      <div className="w-full max-w-lg glass rounded-2xl border border-white/[0.08] shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
          <div>
            <h2 className="text-sm font-semibold text-white">Publish Signal</h2>
            <p className="text-xs text-slate-500 mt-0.5">Share to FinSurf Trader Network</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-400 hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {success ? (
          <div className="px-6 py-12 text-center">
            <CheckCircle className="w-12 h-12 text-emerald-400 mx-auto mb-4" />
            <h3 className="text-base font-semibold text-white mb-1">Signal Published!</h3>
            <p className="text-sm text-slate-400 mb-6">Your signal is live on the AI-Trader network.</p>
            {status && (
              <p className="text-xs text-slate-500">
                Total signals published: <span className="text-mint-400 font-mono">{(status.signalCount || 0) + 1}</span>
              </p>
            )}
            <button onClick={onClose}
              className="mt-6 px-6 py-2 rounded-xl text-sm font-medium bg-mint-500/10 border border-mint-500/20 text-mint-400 hover:bg-mint-500/20 transition-colors">
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">

            {/* Symbol */}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Symbol</label>
              <input
                value={form.symbol}
                onChange={field('symbol')}
                placeholder="AAPL"
                required
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5
                           text-sm text-white placeholder-slate-600
                           focus:outline-none focus:border-mint-500/40 focus:bg-white/[0.06] transition-colors"
              />
            </div>

            {/* Action selector */}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Signal</label>
              <div className="grid grid-cols-4 gap-2">
                {ACTION_OPTIONS.map(opt => {
                  const Icon = opt.icon
                  const active = form.action === opt.value
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setForm(f => ({ ...f, action: opt.value }))}
                      className={`flex flex-col items-center gap-1 py-2.5 rounded-xl border text-xs font-bold transition-all
                        ${active ? opt.cls : 'border-white/[0.06] text-slate-500 hover:border-white/10 hover:text-slate-300'}`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      {opt.label}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Price + Quantity */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">Entry Price (optional)</label>
                <input
                  type="number" step="0.01" min="0"
                  value={form.price}
                  onChange={field('price')}
                  placeholder="e.g. 182.50"
                  className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5
                             text-sm text-white placeholder-slate-600
                             focus:outline-none focus:border-mint-500/40 transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">Quantity (optional)</label>
                <input
                  type="number" step="1" min="1"
                  value={form.quantity}
                  onChange={field('quantity')}
                  placeholder="e.g. 100"
                  className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5
                             text-sm text-white placeholder-slate-600
                             focus:outline-none focus:border-mint-500/40 transition-colors"
                />
              </div>
            </div>

            {/* Market context (E) */}
            <MarketContextPanel symbol={form.symbol} />

            {/* Analysis text */}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                Analysis
                <span className="text-slate-600 font-normal ml-2">{form.analysis.length}/1000</span>
              </label>
              <textarea
                value={form.analysis}
                onChange={field('analysis')}
                rows={5}
                maxLength={1000}
                placeholder="Paste or type your trading thesis here…"
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3
                           text-sm text-white placeholder-slate-600 resize-none
                           focus:outline-none focus:border-mint-500/40 transition-colors"
              />
            </div>

            {error && (
              <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-red-500/5 border border-red-500/20 text-xs text-red-400">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                {error}
              </div>
            )}

            {/* Footer actions */}
            <div className="flex items-center gap-3 pt-1">
              <button type="button" onClick={onClose}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium border border-white/[0.08] text-slate-400 hover:text-white hover:border-white/15 transition-colors">
                Cancel
              </button>
              <button type="submit" disabled={publishing || !form.symbol || !form.analysis}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold
                           bg-mint-500/15 border border-mint-500/30 text-mint-400
                           hover:bg-mint-500/25 disabled:opacity-50 disabled:cursor-not-allowed transition-all">
                {publishing
                  ? <><div className="w-3.5 h-3.5 border-2 border-mint-400/30 border-t-mint-400 rounded-full animate-spin" /> Publishing…</>
                  : <><Send className="w-3.5 h-3.5" /> Publish Signal</>
                }
              </button>
            </div>

            <p className="text-[10px] text-slate-600 text-center">
              Signals are shared publicly on the AI-Trader network · Not financial advice
            </p>
          </form>
        )}
      </div>
    </div>
  )
}
