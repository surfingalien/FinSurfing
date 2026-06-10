import { Code2, Package, Layers, FileCode } from 'lucide-react'

export async function apiFetch(path) {
  const r = await fetch(path)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
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
