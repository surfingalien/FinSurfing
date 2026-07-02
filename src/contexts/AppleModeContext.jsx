import { createContext, useContext, useState, useEffect } from 'react'

// Light, Apple-inspired theme — mirrors ProModeContext: toggles the
// `apple-mode` class on <html>, persisted in localStorage. CSS overrides
// live in index.css under `html.apple-mode`.
const AppleModeCtx = createContext({ appleMode: false, toggleAppleMode: () => {} })

export function AppleModeProvider({ children }) {
  const [appleMode, setAppleMode] = useState(
    () => localStorage.getItem('finsurf_applemode') === 'true'
  )

  useEffect(() => {
    if (appleMode) {
      document.documentElement.classList.add('apple-mode')
    } else {
      document.documentElement.classList.remove('apple-mode')
    }
    localStorage.setItem('finsurf_applemode', String(appleMode))
  }, [appleMode])

  const toggleAppleMode = () => setAppleMode(v => !v)

  return (
    <AppleModeCtx.Provider value={{ appleMode, toggleAppleMode }}>
      {children}
    </AppleModeCtx.Provider>
  )
}

export function useAppleMode() {
  return useContext(AppleModeCtx)
}
