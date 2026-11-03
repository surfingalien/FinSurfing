/**
 * useUiVersion.js
 *
 * Which interface is showing: 'v1' (the current layout, the default), 'v2'
 * (the workspace layout in this folder) or 'v3' (the redesign in src/v3). The choice is per browser, kept in
 * localStorage, and can be set for one link with ?ui=v2 or ?ui=v1. Nothing
 * here touches the server, the routes or any stored data, so switching back
 * and forth only changes the frame around the same pages.
 */

import { useSyncExternalStore, useCallback } from 'react'

export const UI_VERSION_KEY = 'finsurf_ui_version'
export const UI_VERSIONS = ['v1', 'v2', 'v3']
const DEFAULT_VERSION = 'v1'

const listeners = new Set()

function readStored() {
  try {
    const v = window.localStorage.getItem(UI_VERSION_KEY)
    return UI_VERSIONS.includes(v) ? v : null
  } catch {
    return null
  }
}

function write(v) {
  try { window.localStorage.setItem(UI_VERSION_KEY, v) } catch { /* private mode: keep it for this tab only */ }
}

// A ?ui=v2 link sets the version once, then is removed from the address so a
// later switch is not undone on reload.
function readQueryOnce() {
  try {
    const url = new URL(window.location.href)
    const v = url.searchParams.get('ui')
    if (!UI_VERSIONS.includes(v)) return null
    url.searchParams.delete('ui')
    window.history.replaceState(null, '', url.pathname + url.search + url.hash)
    write(v)
    return v
  } catch {
    return null
  }
}

let current = typeof window === 'undefined'
  ? DEFAULT_VERSION
  : (readQueryOnce() ?? readStored() ?? DEFAULT_VERSION)

function setUiVersion(v) {
  if (!UI_VERSIONS.includes(v) || v === current) return
  current = v
  write(v)
  listeners.forEach(fn => fn())
}

function subscribe(fn) {
  listeners.add(fn)
  // Another tab switched: follow it.
  const onStorage = (e) => {
    if (e.key !== UI_VERSION_KEY) return
    const v = readStored() ?? DEFAULT_VERSION
    if (v !== current) { current = v; fn() }
  }
  window.addEventListener('storage', onStorage)
  return () => { listeners.delete(fn); window.removeEventListener('storage', onStorage) }
}

export function useUiVersion() {
  const version = useSyncExternalStore(subscribe, () => current, () => DEFAULT_VERSION)
  const set = useCallback((v) => setUiVersion(v), [])
  return [version, set]
}
