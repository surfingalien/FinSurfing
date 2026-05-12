/**
 * AITraderContext.jsx
 *
 * Global state for AI-Trader integration:
 * - Registration status + unread notification count
 * - Polls notifications every 60 s when user is authenticated
 * - Provides publishSignal() with optimistic local state
 */

import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from './AuthContext'
import { useToast } from '../components/shared/ToastNotifications'
import {
  getTradingStatus,
  getNotifications,
  markNotificationsRead,
  publishSignal as apiPublishSignal,
  registerAgent as apiRegisterAgent,
} from '../services/aiTraderService'

const AITraderContext = createContext(null)

export function AITraderProvider({ children }) {
  const { isAuthenticated } = useAuth()
  const toast = useToast()

  const [status,        setStatus]        = useState(null)   // { registered, agentId, signalCount, unreadCount }
  const [notifications, setNotifications] = useState([])
  const [loading,       setLoading]       = useState(false)
  const [publishing,    setPublishing]    = useState(false)
  const prevNotifsRef = useRef(null)
  const pollRef  = useRef(null)
  const wsRef    = useRef(null)
  const wsRetry  = useRef(0)

  const loadStatus = useCallback(async () => {
    if (!isAuthenticated) return
    try {
      const s = await getTradingStatus()
      setStatus(s)
    } catch {}
  }, [isAuthenticated])

  const loadNotifications = useCallback(async () => {
    if (!isAuthenticated) return
    try {
      const { notifications: notifs } = await getNotifications()
      const incoming = notifs || []

      // Fire toasts for genuinely new unread notifications
      if (prevNotifsRef.current !== null) {
        const existingIds = new Set(prevNotifsRef.current.map(n => n.id))
        incoming
          .filter(n => !n.is_read && !existingIds.has(n.id))
          .slice(0, 3)
          .forEach(n => {
            const data = typeof n.data === 'string' ? JSON.parse(n.data) : n.data
            const message = data?.follower_name
              ? `${data.follower_name} started following your signal`
              : data?.content || null
            toast?.fire(n.type, message)
          })
      }
      prevNotifsRef.current = incoming

      setNotifications(incoming)
      setStatus(prev => prev ? { ...prev, unreadCount: incoming.filter(n => !n.is_read).length } : prev)
    } catch {}
  }, [isAuthenticated, toast])

  // Load on auth change
  useEffect(() => {
    if (!isAuthenticated) { setStatus(null); setNotifications([]); return }
    loadStatus()
    loadNotifications()
  }, [isAuthenticated, loadStatus, loadNotifications])

  // WebSocket connection — real-time heartbeat (D)
  // Falls back to 60 s polling if WebSocket is unavailable or fails.
  const connectWS = useCallback((token, agentId) => {
    if (!token) return
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const wsUrl = `wss://ai4trade.ai/ws/notify/${token}`
    let ws
    try {
      ws = new WebSocket(wsUrl)
    } catch {
      return  // environment doesn't support WebSocket — polling handles it
    }

    wsRef.current = ws

    ws.onopen = () => {
      wsRetry.current = 0
      clearInterval(pollRef.current)  // WS active — stop polling
    }

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data)
        if (!msg?.type) return
        const data     = msg.data || msg
        const message  = data?.follower_name
          ? `${data.follower_name} started following your signal`
          : data?.content || null
        toast?.fire(msg.type, message)
        setNotifications(prev => {
          const next = [{ id: `ws-${Date.now()}`, type: msg.type, data, is_read: false, created_at: new Date().toISOString() }, ...prev].slice(0, 50)
          setStatus(s => s ? { ...s, unreadCount: next.filter(n => !n.is_read).length } : s)
          return next
        })
      } catch {}
    }

    ws.onerror = () => {}

    ws.onclose = () => {
      if (!isAuthenticated) return
      // Exponential backoff: 5 s, 10 s, 20 s … cap 120 s, then fall back to polling
      const delay = Math.min(5000 * 2 ** wsRetry.current, 120_000)
      wsRetry.current += 1
      if (wsRetry.current > 6) {
        // Too many failures — use polling as permanent fallback
        if (!pollRef.current) {
          pollRef.current = setInterval(loadNotifications, 60_000)
        }
        return
      }
      setTimeout(() => connectWS(token, agentId), delay)
    }
  }, [isAuthenticated, toast, loadNotifications])

  // Polling + WS lifecycle — one effect owns both (D)
  useEffect(() => {
    if (!isAuthenticated) {
      wsRef.current?.close()
      clearInterval(pollRef.current)
      return
    }

    // Start polling immediately as the safety net
    clearInterval(pollRef.current)
    pollRef.current = setInterval(loadNotifications, 60_000)

    // Attempt WS if user has a registered agent; WS onopen pauses the poll
    if (status?.registered) {
      // Token is persisted server-side; we pass agentId to WS URL as proxy
      // connectWS is a no-op if WS already open
      const token = localStorage.getItem('at_token') || ''
      connectWS(token, status.agentId)
    }

    return () => {
      clearInterval(pollRef.current)
      wsRef.current?.close()
    }
  }, [isAuthenticated, status?.registered, connectWS, loadNotifications])

  const registerAgent = useCallback(async () => {
    setLoading(true)
    try {
      await apiRegisterAgent()
      await loadStatus()
    } finally {
      setLoading(false)
    }
  }, [loadStatus])

  const publishSignal = useCallback(async (payload) => {
    setPublishing(true)
    try {
      const result = await apiPublishSignal(payload)
      await loadStatus()
      return result
    } finally {
      setPublishing(false)
    }
  }, [loadStatus])

  const markRead = useCallback(async (ids) => {
    await markNotificationsRead(ids)
    setNotifications(prev => prev.map(n =>
      !ids || ids.includes(n.id) ? { ...n, is_read: true } : n
    ))
    setStatus(prev => prev ? { ...prev, unreadCount: 0 } : prev)
  }, [])

  const unreadCount = notifications.filter(n => !n.is_read).length

  return (
    <AITraderContext.Provider value={{
      status, notifications, loading, publishing,
      unreadCount,
      registerAgent, publishSignal, markRead,
      refreshNotifications: loadNotifications,
      refreshStatus: loadStatus,
    }}>
      {children}
    </AITraderContext.Provider>
  )
}

export function useAITrader() {
  const ctx = useContext(AITraderContext)
  if (!ctx) throw new Error('useAITrader must be used inside AITraderProvider')
  return ctx
}
