/**
 * useHashRoute.js
 *
 * Minimal hash-based router (zero dependencies).
 *  - URL shape: #/<tab> or #/<tab>/<param>  e.g. #/analyze/NVDA
 *  - Deep links work on first load, browser back/forward work via hashchange
 *  - Unknown tabs fall back to the dashboard
 */

import { useState, useEffect, useCallback } from 'react'
import { ALL_TABS } from '../navigation'

const DEFAULT_TAB = 'dashboard'

function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '')
  const [tab, ...rest] = raw.split('/')
  if (!tab || !ALL_TABS.has(tab)) return { tab: DEFAULT_TAB, param: null }
  const param = rest.length ? decodeURIComponent(rest.join('/')) : null
  return { tab, param }
}

export function useHashRoute() {
  const [route, setRoute] = useState(parseHash)

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const navigate = useCallback((tab, param) => {
    const next = param ? `#/${tab}/${encodeURIComponent(param)}` : `#/${tab}`
    if (window.location.hash === next) {
      // Same hash — no hashchange event will fire, sync state directly
      setRoute(parseHash())
    } else {
      window.location.hash = next
    }
  }, [])

  return [route, navigate]
}
