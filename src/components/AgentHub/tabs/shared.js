import { getApiKeyHeaders } from '../../../services/api'

export const TELEMETRY_KEY = 'finsurf_agent_runs'
const MAX_RUNS = 50

export function apiFetch(url, opts = {}) {
  return fetch(url, { headers: getApiKeyHeaders(), ...opts })
}

export function timeAgo(ts) {
  if (!ts) return 'Never'
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000)
  if (s < 60)   return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

export function saveTelemetryRun(run) {
  try {
    const existing = JSON.parse(localStorage.getItem(TELEMETRY_KEY) || '[]')
    const updated  = [run, ...existing].slice(0, MAX_RUNS)
    localStorage.setItem(TELEMETRY_KEY, JSON.stringify(updated))
  } catch {}
}

export function loadTelemetry() {
  try { return JSON.parse(localStorage.getItem(TELEMETRY_KEY) || '[]') } catch { return [] }
}
