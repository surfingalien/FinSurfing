import { useCallback } from 'react'
import { Code2, Package, Layers, FileCode } from 'lucide-react'
import { useAuth } from '../../../contexts/AuthContext'

/** GET → JSON with the signed-in user's token (every Agentic OS route needs one). */
export function useApiFetch() {
  const { authFetch } = useAuth()
  return useCallback(async (path) => {
    const r = await authFetch(path)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  }, [authFetch])
}

export const NODE_COLOR = {
  route:     '#6366f1',
  lib:       '#06b6d4',
  component: '#8b5cf6',
  jsx:       '#a78bfa',
}

export const NODE_ICON = {
  route:     Code2,
  lib:       Package,
  component: Layers,
  jsx:       FileCode,
}
