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

  // Mirrors of the token state, readable from callbacks without making every
  // consumer's identity churn on each token rotation.
  const tokenRef     = useRef(null)
  const expiresAtRef = useRef(0)
  const refreshInFlight = useRef(null)

  const applySession = useCallback((data) => {
    tokenRef.current     = data.accessToken
    expiresAtRef.current = Date.now() + (data.expiresIn ?? 900) * 1000
    setUser(data.user)
    setAccessToken(data.accessToken)
  }, [])

  const clearSession = useCallback(() => {
    tokenRef.current     = null
    expiresAtRef.current = 0
    setUser(null)
    setAccessToken(null)
  }, [])

  // ── Silent refresh ─────────────────────────────
  const scheduleRefresh = useCallback((expiresIn = 900) => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    // Refresh 60s before expiry
    const delay = Math.max((expiresIn - 60) * 1000, 10000)
    refreshTimer.current = setTimeout(() => silentRefreshRef.current?.(), delay)
  }, [])

  /**
   * Exchange the refresh cookie for a new access token. Resolves to the new
   * token, or null if the session is gone.
   *
   * SINGLE-FLIGHT, and that is not an optimisation. The server treats a refresh
   * token as single-use and reads a second presentation as replay: it revokes
   * every token the user has and audits `token_reuse_detected`. Two overlapping
   * refreshes — trivially reachable now that a background job polls every 4s —
   * would therefore log the user out rather than renew them.
   */
  const silentRefresh = useCallback(() => {
    if (refreshInFlight.current) return refreshInFlight.current
    refreshInFlight.current = (async () => {
      try {
        const res = await API('/refresh', { method: 'POST' })
        if (!res.ok) { clearSession(); return null }
        const data = await res.json()
        applySession(data)
        scheduleRefresh(data.expiresIn)
        return data.accessToken
      } catch {
        // A network blip is not proof the session is dead — keep the token and
        // let the caller's 401 handling decide. Clearing here would sign the
        // user out every time the connection wobbles.
        return null
      } finally {
        refreshInFlight.current = null
      }
    })()
    return refreshInFlight.current
  }, [scheduleRefresh, applySession, clearSession])

  // scheduleRefresh is created once and fires long after render, so it reaches
  // silentRefresh through a ref rather than closing over a stale copy.
  const silentRefreshRef = useRef(silentRefresh)
  silentRefreshRef.current = silentRefresh

  // ── Restore session on mount ───────────────────
  useEffect(() => {
    silentRefresh().finally(() => setLoading(false))
    return () => { if (refreshTimer.current) clearTimeout(refreshTimer.current) }
  }, [])  // eslint-disable-line

  // ── Re-check on foreground ─────────────────────
  // Mobile browsers suspend timers in a backgrounded tab, so the 14-minute
  // refresh never fires while the phone is locked or the tab is away. Coming
  // back to the page reliably landed on an expired token and a "Token expired"
  // banner — which is exactly the state a background job is meant to survive.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (!tokenRef.current) return                        // logged out; nothing to renew
      if (Date.now() < expiresAtRef.current - 60_000) return  // still comfortably valid
      silentRefreshRef.current?.()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [])

  // ── Register ───────────────────────────────────
  const register = useCallback(async ({ email, password, displayName }) => {
    setAuthError(null)
    const res  = await API('/register', { method: 'POST', body: { email, password, displayName } })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Registration failed')
    applySession(data)
    scheduleRefresh(data.expiresIn)
    return data.user
  }, [scheduleRefresh, applySession])

  // ── Login ──────────────────────────────────────
  const login = useCallback(async ({ email, password, rememberMe = false }) => {
    setAuthError(null)
    const res  = await API('/login', { method: 'POST', body: { email, password, rememberMe } })
    const data = await res.json()
    if (!res.ok) {
      const err = new Error(data.error || 'Login failed')
      if (data.requiresVerification) err.requiresVerification = true
      if (data.email) err.email = data.email
      throw err
    }
    applySession(data)
    scheduleRefresh(data.expiresIn)
    return data.user
  }, [scheduleRefresh, applySession])

  // ── Logout ─────────────────────────────────────
  const logout = useCallback(async () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    await API('/logout', { method: 'POST' }).catch(() => {})
    clearSession()
  }, [clearSession])

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
  // Use this for any API call that needs the access token.
  //
  // Retries ONCE through a refresh on a 401. The access token lives 15 minutes
  // and the renewal timer does not run in a backgrounded mobile tab, so any
  // long-lived page — a polling background job above all — will eventually
  // present an expired token. Without this the user just saw "Token expired"
  // and had to reload.
  //
  // `requireToken: false` marks an endpoint that also serves logged-out users
  // (e.g. GET /api/market-focus): the token is attached when there is one, but
  // its absence is not an error. Without that escape hatch, routing a public
  // endpoint through here would break it for anonymous visitors.
  const authFetch = useCallback(async (url, { requireToken = true, ...opts } = {}) => {
    const send = (token) => fetch(url, {
      ...opts,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts.headers || {}),
      },
      // Callers pass either a plain object (stringified here, as they always
      // have) or an already-serialised string.
      body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
    })

    let token = tokenRef.current
    if (!token) {
      // No session and none needed — go straight out, don't burn a refresh.
      if (!requireToken) return send(null)
      token = await silentRefresh()
      if (!token) throw new Error('Not authenticated')
    }

    const res = await send(token)
    if (res.status !== 401) return res

    const fresh = await silentRefresh()
    if (!fresh) return res          // session really is gone — let the 401 surface
    return send(fresh)
  }, [silentRefresh])

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
