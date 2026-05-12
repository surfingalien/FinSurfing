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
  const pollRef = useRef(null)

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

  // Poll notifications every 60 s
  useEffect(() => {
    if (!isAuthenticated) return
    pollRef.current = setInterval(loadNotifications, 60_000)
    return () => clearInterval(pollRef.current)
  }, [isAuthenticated, loadNotifications])

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
