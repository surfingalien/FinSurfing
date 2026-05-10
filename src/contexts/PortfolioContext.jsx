/**
 * PortfolioContext — manages the list of portfolios and the active selection.
 * When authenticated: portfolios come from the API.
 * When not authenticated: falls back to a single "local" virtual portfolio.
 */
import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useAuth } from './AuthContext'

const PortfolioContext = createContext(null)

export const PORTFOLIO_TYPE_LABELS = {
  brokerage:      'Brokerage',
  roth_ira:       'Roth IRA',
  traditional_ira:'Traditional IRA',
  '401k':         '401(k)',
  '403b':         '403(b)',
  mutual_fund:    'Mutual Fund',
  crypto:         'Crypto',
  hsa:            'HSA',
  paper:          'Paper Trading',
  cash:           'Cash',
  other:          'Other',
}

export const PORTFOLIO_TYPE_ICONS = {
  brokerage:      '📈',
  roth_ira:       '🌱',
  traditional_ira:'🏦',
  '401k':         '🏛',
  '403b':         '🏛',
  mutual_fund:    '💼',
  crypto:         '₿',
  hsa:            '🏥',
  paper:          '📄',
  cash:           '💵',
  other:          '◉',
}

export function PortfolioProvider({ children }) {
  const { isAuthenticated, authFetch } = useAuth()

  const [portfolios,        setPortfolios]        = useState([])
  const [activePortfolioId, setActivePortfolioId] = useState(null)
  const [loadingPortfolios, setLoadingPortfolios] = useState(false)
  const [portfolioError,    setPortfolioError]    = useState(null)

  // ── Fetch portfolio list from API ──────────────
  const fetchPortfolios = useCallback(async () => {
    if (!isAuthenticated) { setPortfolios([]); setActivePortfolioId(null); return }
    setLoadingPortfolios(true)
    setPortfolioError(null)
    try {
      const res  = await authFetch('/api/portfolios')
      if (!res.ok) throw new Error('Failed to load portfolios')
      const data = await res.json()
      setPortfolios(data)
      // Set default portfolio as active if none is selected, or if current is gone
      setActivePortfolioId(prev => {
        if (prev && data.find(p => p.id === prev)) return prev
        return data.find(p => p.is_default)?.id ?? data[0]?.id ?? null
      })
    } catch (err) {
      setPortfolioError(err.message)
    } finally {
      setLoadingPortfolios(false)
    }
  }, [isAuthenticated, authFetch])

  useEffect(() => { fetchPortfolios() }, [fetchPortfolios])

  // ── Create portfolio ───────────────────────────
  const createPortfolio = useCallback(async (data) => {
    const res  = await authFetch('/api/portfolios', { method: 'POST', body: data })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error || 'Create failed')
    await fetchPortfolios()
    setActivePortfolioId(json.id)
    return json
  }, [authFetch, fetchPortfolios])

  // ── Update portfolio ───────────────────────────
  const updatePortfolio = useCallback(async (id, data) => {
    const res  = await authFetch(`/api/portfolios/${id}`, { method: 'PATCH', body: data })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error || 'Update failed')
    await fetchPortfolios()
    return json
  }, [authFetch, fetchPortfolios])

  // ── Delete (archive) portfolio ─────────────────
  const deletePortfolio = useCallback(async (id) => {
    const res  = await authFetch(`/api/portfolios/${id}`, { method: 'DELETE' })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error || 'Delete failed')
    await fetchPortfolios()
  }, [authFetch, fetchPortfolios])

  // ── Set default portfolio ──────────────────────
  const setDefaultPortfolio = useCallback(async (id) => {
    const res  = await authFetch(`/api/portfolios/${id}/set-default`, { method: 'POST' })
    if (!res.ok) throw new Error('Failed to set default')
    await fetchPortfolios()
  }, [authFetch, fetchPortfolios])

  // ── Import localStorage holdings into portfolio ─
  const importLocalHoldings = useCallback(async (portfolioId, holdings) => {
    const res  = await authFetch(`/api/portfolios/${portfolioId}/import`, {
      method: 'POST', body: { holdings },
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error || 'Import failed')
    return json
  }, [authFetch])

  const activePortfolio = portfolios.find(p => p.id === activePortfolioId) ?? null

  return (
    <PortfolioContext.Provider value={{
      portfolios, activePortfolio, activePortfolioId,
      loadingPortfolios, portfolioError,
      setActivePortfolioId,
      fetchPortfolios,
      createPortfolio, updatePortfolio, deletePortfolio,
      setDefaultPortfolio, importLocalHoldings,
    }}>
      {children}
    </PortfolioContext.Provider>
  )
}

export function usePortfolioContext() {
  const ctx = useContext(PortfolioContext)
  if (!ctx) throw new Error('usePortfolioContext must be used within <PortfolioProvider>')
  return ctx
}
