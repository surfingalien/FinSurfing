import { createContext, useContext, useState, useEffect } from 'react'

const ProModeCtx = createContext({ proMode: false, toggleProMode: () => {} })

export function ProModeProvider({ children }) {
  const [proMode, setProMode] = useState(
    () => localStorage.getItem('finsurf_promode') === 'true'
  )

  useEffect(() => {
    if (proMode) {
      document.documentElement.classList.add('pro-mode')
    } else {
      document.documentElement.classList.remove('pro-mode')
    }
    localStorage.setItem('finsurf_promode', String(proMode))
  }, [proMode])

  const toggleProMode = () => setProMode(v => !v)

  return (
    <ProModeCtx.Provider value={{ proMode, toggleProMode }}>
      {children}
    </ProModeCtx.Provider>
  )
}

export function useProMode() {
  return useContext(ProModeCtx)
}
