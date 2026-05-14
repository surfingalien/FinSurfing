/**
 * ApiKeysContext.jsx
 *
 * Stores user-provided API keys in localStorage and makes them available
 * throughout the app. Keys are sent as request headers so the backend can
 * use them instead of (or in addition to) its own environment variables.
 */
import { createContext, useContext, useState, useCallback } from 'react'

const STORAGE_KEY = 'finsurf_api_keys'

const DEFAULTS = {
  anthropic: '',
  aisa:      '',
  finnhub:   '',
  fmp:       '',
  td:        '',
  av:        '',
}

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') }
  } catch {
    return { ...DEFAULTS }
  }
}

const ApiKeysContext = createContext(null)

export function ApiKeysProvider({ children }) {
  const [keys, setKeys] = useState(load)

  const save = useCallback((next) => {
    const merged = { ...keys, ...next }
    setKeys(merged)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
  }, [keys])

  const clear = useCallback(() => {
    setKeys({ ...DEFAULTS })
    localStorage.removeItem(STORAGE_KEY)
  }, [])

  // Returns headers object to attach to every API request
  const getHeaders = useCallback(() => {
    const h = {}
    if (keys.anthropic) h['x-anthropic-key'] = keys.anthropic.trim()
    if (keys.aisa)      h['x-aisa-key']      = keys.aisa.trim()
    if (keys.finnhub)   h['x-finnhub-key']   = keys.finnhub.trim()
    if (keys.fmp)       h['x-fmp-key']       = keys.fmp.trim()
    if (keys.td)        h['x-td-key']        = keys.td.trim()
    if (keys.av)        h['x-av-key']        = keys.av.trim()
    return h
  }, [keys])

  // Separate flags so sidebar badge only fires for market data keys
  const hasAnyKey      = ['aisa','finnhub','fmp','td','av'].some(k => keys[k]?.trim())
  const hasAnthropicKey = !!keys.anthropic?.trim()

  return (
    <ApiKeysContext.Provider value={{ keys, save, clear, getHeaders, hasAnyKey, hasAnthropicKey }}>
      {children}
    </ApiKeysContext.Provider>
  )
}

export function useApiKeys() {
  const ctx = useContext(ApiKeysContext)
  if (!ctx) throw new Error('useApiKeys must be used within ApiKeysProvider')
  return ctx
}
