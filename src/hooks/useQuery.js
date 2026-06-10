/**
 * useQuery.js — lightweight shared data-fetching layer (zero dependencies).
 *
 * What it gives every view for free:
 *   - module-level cache: navigating away and back renders instantly
 *   - request deduplication: two components asking for the same key share one fetch
 *   - stale-while-revalidate: cached data shows immediately, refresh happens behind it
 *   - optional polling via refetchMs
 *
 * Usage:
 *   const { data, error, loading, refetch } = useQuery(
 *     'macro-indicators',
 *     () => fetch('/api/macro/indicators').then(r => r.json()),
 *     { staleMs: 60_000 },
 *   )
 *
 * Keys are global — use a unique string per endpoint (+ params).
 */

import { useState, useEffect, useRef, useCallback } from 'react'

// key → { data, error, updatedAt, promise, subscribers: Set<fn> }
const cache = new Map()

function getEntry(key) {
  let entry = cache.get(key)
  if (!entry) {
    entry = { data: undefined, error: null, updatedAt: 0, promise: null, subscribers: new Set() }
    cache.set(key, entry)
  }
  return entry
}

function notify(entry) {
  for (const fn of entry.subscribers) fn()
}

function fetchEntry(key, fetcher) {
  const entry = getEntry(key)
  if (entry.promise) return entry.promise // dedupe in-flight

  entry.promise = Promise.resolve()
    .then(fetcher)
    .then(data => {
      entry.data      = data
      entry.error     = null
      entry.updatedAt = Date.now()
    })
    .catch(err => {
      entry.error = err instanceof Error ? err : new Error(String(err))
    })
    .finally(() => {
      entry.promise = null
      notify(entry)
    })

  notify(entry) // loading-state change
  return entry.promise
}

/** Drop cached data for a key (or every key) so the next mount refetches. */
export function invalidateQuery(key) {
  if (key === undefined) { cache.clear(); return }
  const entry = cache.get(key)
  if (entry) { entry.updatedAt = 0; entry.data = undefined }
}

export function useQuery(key, fetcher, { staleMs = 30_000, refetchMs = 0, enabled = true } = {}) {
  const [, bump] = useState(0)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  // Subscribe this component to the cache entry
  useEffect(() => {
    if (!enabled) return undefined
    const entry = getEntry(key)
    const onChange = () => bump(n => n + 1)
    entry.subscribers.add(onChange)

    const isStale = Date.now() - entry.updatedAt > staleMs
    if ((entry.data === undefined || isStale) && !entry.promise) {
      fetchEntry(key, () => fetcherRef.current())
    } else {
      onChange() // sync to whatever is already cached
    }

    let timer = null
    if (refetchMs > 0) {
      timer = setInterval(() => fetchEntry(key, () => fetcherRef.current()), refetchMs)
    }

    return () => {
      entry.subscribers.delete(onChange)
      if (timer) clearInterval(timer)
    }
  }, [key, enabled, staleMs, refetchMs])

  const refetch = useCallback(() => fetchEntry(key, () => fetcherRef.current()), [key])

  const entry = getEntry(key)
  return {
    data:    entry.data,
    error:   entry.error,
    loading: !!entry.promise && entry.data === undefined, // first load only
    fetching: !!entry.promise,                            // any in-flight refresh
    refetch,
  }
}

/** Fetch JSON with non-2xx → thrown Error(message from body when present). */
export async function fetchJson(url, options) {
  const res  = await fetch(url, options)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`)
  return body
}
