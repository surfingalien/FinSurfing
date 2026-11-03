// Small fetch hooks shared by v3 pages. Signed-in endpoints go through
// authFetch (token + refresh); public ones send the browser's saved API keys.
import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { getApiKeyHeaders } from '../services/api'

export function useAuthedJson(url, deps = []) {
  const { isAuthenticated, authFetch } = useAuth()
  const [state, setState] = useState({ data: null, error: null, loading: false })
  const load = useCallback(async (opts) => {
    if (!isAuthenticated || !url) return
    setState(s => ({ ...s, loading: true }))
    try {
      const r = await authFetch(url, opts)
      const j = await r.json()
      setState({ data: j, error: j?.error && Object.keys(j).length <= 2 ? j.error : (r.ok ? null : (j?.error || `HTTP ${r.status}`)), loading: false })
    } catch (e) {
      setState({ data: null, error: e.message, loading: false })
    }
  }, [isAuthenticated, url, authFetch]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [load, ...deps]) // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, reload: load, isAuthenticated }
}

export function usePublicJson(url) {
  const [state, setState] = useState({ data: null, error: null })
  useEffect(() => {
    let live = true
    fetch(url, { headers: getApiKeyHeaders() }).then(r => r.json()).then(j => { if (live) setState({ data: j, error: j?.error ?? null }) })
      .catch(e => { if (live) setState({ data: null, error: e.message }) })
    return () => { live = false }
  }, [url])
  return state
}

