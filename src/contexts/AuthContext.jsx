/**
 * AuthContext — global authentication state for FinSurf
 *
 * Token strategy:
 *   Access token  → in-memory React state (never in localStorage/cookie)
 *   Refresh token → HTTP-only Secure cookie (handled transparently by browser)
 *
 * On mount: attempt silent refresh via /api/auth/refresh to restore session.
 * Silent re-fresh runs every 14 minutes (access token TTL = 15 min).
 */
import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react'

const AuthContext = createContext(null)

const API = (path, opts = {}) =>
  fetch(`/api/auth${path}`, {
    ...opts,
    credentials: 'include',   // send/receive cookies
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })

export function AuthProvider({ children }) {
  const [user,        setUser]        = useState(null)   // { id, email, displayName }
  const [accessToken, setAccessToken] = useState(null)   // 15-min JWT, in memory only
  const [loading,     setLoading]     = useState(true)   // true during initial session restore
  const [authError,   setAuthError]   = useState(null)
  const refreshTimer = useRef(null)

  // ── Silent refresh ─────────────────────────────
  const scheduleRefresh = useCallback((expiresIn = 900) => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    // Refresh 60s before expiry
    const delay = Math.max((expiresIn - 60) * 1000, 10000)
    refreshTimer.current = setTimeout(() => silentRefresh(), delay)
  }, [])

  const silentRefresh = useCallback(async () => {
    try {
      const res  = await API('/refresh', { method: 'POST' })
      if (!res.ok) { setUser(null); setAccessToken(null); return }
      const data = await res.json()
      setUser(data.user)
      setAccessToken(data.accessToken)
      scheduleRefresh(data.expiresIn)
    } catch {
      setUser(null); setAccessToken(null)
    }
  }, [scheduleRefresh])

  // ── Restore session on mount ───────────────────
  useEffect(() => {
    silentRefresh().finally(() => setLoading(false))
    return () => { if (refreshTimer.current) clearTimeout(refreshTimer.current) }
  }, [])  // eslint-disable-line

  // ── Register ───────────────────────────────────
  const register = useCallback(async ({ email, password, displayName }) => {
    setAuthError(null)
    const res  = await API('/register', { method: 'POST', body: { email, password, displayName } })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Registration failed')
    setUser(data.user)
    setAccessToken(data.accessToken)
    scheduleRefresh(data.expiresIn)
    return data.user
  }, [scheduleRefresh])

  // ── Login ──────────────────────────────────────
  const login = useCallback(async ({ email, password, rememberMe = false }) => {
    setAuthError(null)
    const res  = await API('/login', { method: 'POST', body: { email, password, rememberMe } })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Login failed')
    setUser(data.user)
    setAccessToken(data.accessToken)
    scheduleRefresh(data.expiresIn)
    return data.user
  }, [scheduleRefresh])

  // ── Logout ─────────────────────────────────────
  const logout = useCallback(async () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    await API('/logout', { method: 'POST' }).catch(() => {})
    setUser(null)
    setAccessToken(null)
  }, [])

  // ── Forgot password ────────────────────────────
  const forgotPassword = useCallback(async (email) => {
    const res  = await API('/forgot-password', { method: 'POST', body: { email } })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Request failed')
    return data
  }, [])

  // ── Reset password ─────────────────────────────
  const resetPassword = useCallback(async (token, password) => {
    const res  = await API('/reset-password', { method: 'POST', body: { token, password } })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Reset failed')
    return data
  }, [])

  // ── Authorised fetch helper ────────────────────
  // Use this for any API call that needs the access token
  const authFetch = useCallback((url, opts = {}) => {
    if (!accessToken) return Promise.reject(new Error('Not authenticated'))
    return fetch(url, {
      ...opts,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${accessToken}`,
        ...(opts.headers || {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    })
  }, [accessToken])

  const isAuthenticated = !!user && !!accessToken

  return (
    <AuthContext.Provider value={{
      user, accessToken, loading, authError, isAuthenticated,
      register, login, logout, forgotPassword, resetPassword, authFetch,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}
