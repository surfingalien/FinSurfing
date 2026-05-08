import { useState, useEffect, useCallback, useRef } from 'react'

const LS_KEY = 'finsurf_alerts'

function load() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]') } catch { return [] }
}

export function useAlerts(quotesMap = {}) {
  const [alerts, setAlerts]     = useState(load)
  const [triggered, setTriggered] = useState([])
  const prevTriggered             = useRef(new Set())

  // Persist
  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(alerts))
  }, [alerts])

  // Check every time quotes update
  useEffect(() => {
    if (!Object.keys(quotesMap).length) return
    const fired = []
    alerts.forEach(a => {
      if (!a.active) return
      const price = quotesMap[a.symbol]?.price
      if (price == null) return
      const hit = a.type === 'above' ? price >= a.threshold : price <= a.threshold
      if (hit && !prevTriggered.current.has(a.id)) {
        fired.push({ ...a, price })
        prevTriggered.current.add(a.id)
      }
    })
    if (fired.length) setTriggered(prev => [...prev, ...fired])
  }, [quotesMap, alerts])

  const addAlert = useCallback((alert) => {
    const id = Date.now()
    setAlerts(prev => {
      const dup = prev.find(a =>
        a.symbol === alert.symbol &&
        a.type === alert.type &&
        a.threshold === alert.threshold
      )
      if (dup) return prev
      return [...prev, { ...alert, id, createdAt: new Date().toISOString(), active: true }]
    })
    return id
  }, [])

  const removeAlert = useCallback((id) => {
    setAlerts(prev => prev.filter(a => a.id !== id))
    prevTriggered.current.delete(id)
  }, [])

  const toggleAlert = useCallback((id) => {
    setAlerts(prev => prev.map(a => a.id === id ? { ...a, active: !a.active } : a))
  }, [])

  const dismissTriggered = useCallback((id) => {
    setTriggered(prev => prev.filter(t => t.id !== id))
  }, [])

  const clearAllTriggered = useCallback(() => setTriggered([]), [])

  return { alerts, triggered, addAlert, removeAlert, toggleAlert, dismissTriggered, clearAllTriggered }
}
