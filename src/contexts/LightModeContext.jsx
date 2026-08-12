import { createContext, useContext, useState, useEffect } from 'react'

/**
 * Light mode — the product's DEFAULT theme.
 *
 * Toggles the `light-mode` class on <html>; the CSS overlay lives in
 * index.css. Dark is now the opt-out rather than the baseline, so an
 * unset preference resolves to light (previously the reverse).
 *
 * The stored value is read as an explicit string so only a deliberate
 * 'false' turns light off — a missing or corrupted key falls back to the
 * default rather than silently landing a first-time visitor in dark.
 */
const LightModeCtx = createContext({ lightMode: true, toggleLightMode: () => {} })

const STORAGE_KEY = 'finsurf_lightmode'
// Legacy key from when this theme was opt-in and named "apple mode". Honour a
// user's existing choice instead of resetting everyone's preference.
const LEGACY_KEY  = 'finsurf_applemode'

function initialLightMode() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored !== null) return stored === 'true'
    // Migrate: someone who had explicitly turned the old theme ON stays on it;
    // anyone else now gets the new default (light) rather than their old dark.
    if (localStorage.getItem(LEGACY_KEY) === 'true') return true
    return true   // default
  } catch {
    return true   // storage blocked (private mode) — still render the default
  }
}

export function LightModeProvider({ children }) {
  const [lightMode, setLightMode] = useState(initialLightMode)

  useEffect(() => {
    document.documentElement.classList.toggle('light-mode', lightMode)
    try { localStorage.setItem(STORAGE_KEY, String(lightMode)) } catch { /* non-fatal */ }
  }, [lightMode])

  const toggleLightMode = () => setLightMode(v => !v)

  return (
    <LightModeCtx.Provider value={{ lightMode, toggleLightMode }}>
      {children}
    </LightModeCtx.Provider>
  )
}

export function useLightMode() {
  return useContext(LightModeCtx)
}
