import { createContext, useContext, useState, useEffect } from 'react'

export const THEMES = [
  { id: 'dark',   label: 'Dark',    color: '#0a0f1a' },
  { id: 'tan',    label: 'Tan',     color: '#c8a97e' },
  { id: 'ocean',  label: 'Ocean',   color: '#0d2137' },
  { id: 'forest', label: 'Forest',  color: '#0d1f14' },
  { id: 'slate',  label: 'Slate',   color: '#1e293b' },
]

const ThemeCtx = createContext({ theme: 'dark', setTheme: () => {} })

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(
    () => localStorage.getItem('finsurf_theme') || 'dark'
  )

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('finsurf_theme', theme)
  }, [theme])

  function setTheme(t) {
    setThemeState(t)
  }

  return (
    <ThemeCtx.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeCtx.Provider>
  )
}

export function useTheme() {
  return useContext(ThemeCtx)
}
