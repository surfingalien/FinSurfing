/**
 * useBackgroundJob — client half of lib/ai-job-queue.js.
 *
 * The long AI surfaces used to hold an HTTP connection open for the whole
 * generation. On mobile the connection frequently died before the answer
 * arrived, and a dead connection surfaces as a bare "Load failed" — no status,
 * no body — throwing away a run that had already been paid for.
 *
 * Now the server owns the run: POST enqueues, and this hook polls for the
 * result. The tab is no longer load-bearing. Closing the page and coming back
 * reattaches to a job still in flight, or shows the last completed one, so a
 * view is never blank after a run.
 *
 * The AI Brain and Advisory each grew their own copy of this ~70-line dance.
 * They were already drifting in their error strings; a third and fourth copy
 * would drift further. One hook, one behaviour.
 *
 * Usage:
 *   const job = useBackgroundJob({
 *     startPath: '/api/ai-brain/scan',
 *     pollPath:  '/api/ai-brain/scan',
 *     storageKey: 'finsurf_active_scan',
 *     accessToken,
 *     noun: 'scan',
 *     onResult: setAnalysis,
 *     onError:  setError,
 *   })
 *   job.start({ horizon, holdings })   // → enqueues, then polls
 *   job.running                        // → true while queued or running
 *   job.status                         // → 'queued' | 'running' | null
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { getApiKeyHeaders } from '../services/api'

const POLL_MS = 4000

export function useBackgroundJob({
  startPath,
  pollPath,
  storageKey,
  accessToken,
  noun = 'run',
  onResult,
  onError,
  onStart,
  restoreLatest = true,
}) {
  const [status, setStatus] = useState(null)   // 'starting' | 'queued' | 'running' | null
  const pollTimer = useRef(null)

  // Callers pass inline arrow functions, which change identity every render.
  // Holding them in a ref keeps the polling effects from tearing down and
  // restarting on every parent re-render.
  const cb = useRef({ onResult, onError, onStart })
  cb.current = { onResult, onError, onStart }

  const authHeaders = useCallback(() => ({
    'Content-Type': 'application/json',
    ...getApiKeyHeaders(),
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  }), [accessToken])

  const stop = useCallback(() => {
    if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null }
  }, [])

  const finish = useCallback((job) => {
    stop()
    try { localStorage.removeItem(storageKey) } catch { /* private mode */ }
    setStatus(null)
    if (job?.status === 'done' && job.result) cb.current.onResult?.(job.result)
    else if (job?.status === 'failed')        cb.current.onError?.(job.error || `The ${noun} failed`)
  }, [stop, storageKey, noun])

  const poll = useCallback(async (jobId) => {
    try {
      const res = await fetch(`${pollPath}/${encodeURIComponent(jobId)}`, { headers: authHeaders() })
      if (res.status === 404) {   // lost to a restart — stop chasing it
        finish({ status: 'failed', error: `This ${noun} is no longer available (the server may have restarted).` })
        return
      }
      const { job } = await res.json()
      if (!job) return
      if (job.status === 'done' || job.status === 'failed') finish(job)
      else setStatus(job.status)
    } catch { /* transient network blip — keep polling */ }
  }, [pollPath, authHeaders, finish, noun])

  const watch = useCallback((jobId) => {
    try { localStorage.setItem(storageKey, jobId) } catch { /* private mode */ }
    stop()
    cb.current.onStart?.()
    poll(jobId)
    pollTimer.current = setInterval(() => poll(jobId), POLL_MS)
  }, [poll, stop, storageKey])

  /** Enqueue a run. Resolves once it's queued — the result arrives via onResult. */
  const start = useCallback(async (body = {}) => {
    setStatus('starting')
    cb.current.onStart?.()
    try {
      const res = await fetch(startPath, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error || `Could not start the ${noun}`)
      setStatus(data.status ?? 'queued')
      watch(data.jobId)
      return data.jobId
    } catch (e) {
      setStatus(null)
      cb.current.onError?.(e.message)
      return null
    }
  }, [startPath, authHeaders, watch, noun])

  // Reattach on mount: resume a run started before the tab closed, else show
  // the most recent completed one so the view is never blank after a run.
  useEffect(() => {
    if (!accessToken) return undefined
    let cancelled = false
    ;(async () => {
      let saved = null
      try { saved = localStorage.getItem(storageKey) } catch { /* private mode */ }
      if (saved) {
        try {
          const res = await fetch(`${pollPath}/${encodeURIComponent(saved)}`, { headers: authHeaders() })
          const { job } = res.ok ? await res.json() : { job: null }
          if (cancelled) return
          if (job && (job.status === 'queued' || job.status === 'running')) {
            setStatus(job.status); watch(saved); return
          }
          if (job && job.status === 'done' && job.result) { finish(job); return }
        } catch { /* fall through to latest */ }
        try { localStorage.removeItem(storageKey) } catch { /* private mode */ }
      }
      if (!restoreLatest) return
      try {
        const res = await fetch(`${pollPath}/latest`, { headers: authHeaders() })
        const { job } = res.ok ? await res.json() : { job: null }
        if (!cancelled && job?.result) cb.current.onResult?.(job.result)
      } catch { /* nothing cached yet */ }
    })()
    return () => { cancelled = true }
  }, [accessToken, storageKey, pollPath, restoreLatest, authHeaders, watch, finish])

  useEffect(() => stop, [stop])

  return { status, running: status !== null, start, stop }
}

export default useBackgroundJob
