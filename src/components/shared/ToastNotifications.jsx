/**
 * ToastNotifications.jsx
 *
 * Bottom-right toast stack for AI-Trader heartbeat alerts.
 * Renders up to 3 toasts; each auto-dismisses after 6 s.
 * Consumed by AITraderContext when new notifications arrive.
 */

import { useState, useEffect, useCallback, createContext, useContext } from 'react'
import { X, UserPlus, Bell, Award, Zap } from 'lucide-react'

// ── Toast context (used by AITraderContext to fire toasts) ────────────────────

const ToastContext = createContext(null)

export function useToast() {
  return useContext(ToastContext)
}

// ── Icon + colour map ─────────────────────────────────────────────────────────

const TOAST_META = {
  new_follower:            { icon: UserPlus, color: 'mint',   label: 'New Follower' },
  discussion_reply:        { icon: Bell,     color: 'indigo', label: 'Signal Reply' },
  strategy_reply_accepted: { icon: Award,    color: 'amber',  label: 'Analysis Accepted' },
  default:                 { icon: Zap,      color: 'slate',  label: 'Trader Network' },
}

const COLOR = {
  mint:   { bg: 'bg-mint-500/10',   border: 'border-mint-500/25',   text: 'text-mint-400',   icon: 'text-mint-400' },
  indigo: { bg: 'bg-indigo-500/10', border: 'border-indigo-500/25', text: 'text-indigo-300', icon: 'text-indigo-400' },
  amber:  { bg: 'bg-amber-500/10',  border: 'border-amber-500/25',  text: 'text-amber-300',  icon: 'text-amber-400' },
  slate:  { bg: 'bg-slate-500/10',  border: 'border-slate-500/20',  text: 'text-slate-300',  icon: 'text-slate-400' },
}

// ── Single toast ──────────────────────────────────────────────────────────────

function Toast({ toast, onDismiss }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // Slide in
    requestAnimationFrame(() => setVisible(true))
    // Auto-dismiss after 6 s
    const t = setTimeout(() => { setVisible(false); setTimeout(() => onDismiss(toast.id), 300) }, 6000)
    return () => clearTimeout(t)
  }, [toast.id, onDismiss])

  const meta  = TOAST_META[toast.type] || TOAST_META.default
  const c     = COLOR[meta.color]
  const Icon  = meta.icon

  return (
    <div className={`
      flex items-start gap-3 w-72 px-4 py-3 rounded-xl border shadow-2xl
      backdrop-blur-md transition-all duration-300
      ${c.bg} ${c.border}
      ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'}
    `}>
      <div className={`mt-0.5 shrink-0 ${c.icon}`}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-xs font-semibold ${c.text}`}>{meta.label}</p>
        {toast.message && (
          <p className="text-xs text-slate-400 mt-0.5 line-clamp-2">{toast.message}</p>
        )}
      </div>
      <button onClick={() => { setVisible(false); setTimeout(() => onDismiss(toast.id), 300) }}
        className="shrink-0 text-slate-600 hover:text-white transition-colors mt-0.5">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

// ── Provider + stack ──────────────────────────────────────────────────────────

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const fire = useCallback((type, message) => {
    const id = `${Date.now()}-${Math.random()}`
    setToasts(prev => [...prev.slice(-2), { id, type, message }]) // max 3
  }, [])

  const dismiss = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ fire }}>
      {children}

      {/* Toast stack — bottom-right */}
      <div className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className="pointer-events-auto">
            <Toast toast={t} onDismiss={dismiss} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
