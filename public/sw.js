/**
 * FinSurf Service Worker
 *
 * Strategy:
 *  - App shell (HTML, JS, CSS): cache-first with network fallback
 *  - API requests (/api/*): network-only (always fresh data)
 *  - Static assets: stale-while-revalidate
 *
 * Activate immediately and take control of all clients.
 */

const CACHE_NAME = 'finsurf-v1'
const SHELL_URLS = ['/', '/src/main.jsx']

// ── Install: cache nothing eagerly (Vite hashes assets, no static list) ──────
self.addEventListener('install', event => {
  self.skipWaiting()
})

// ── Activate: clean old caches, take control immediately ─────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
})

// ── Fetch: routing strategy ───────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event
  const url = new URL(request.url)

  // Skip non-GET and cross-origin
  if (request.method !== 'GET' || url.origin !== self.location.origin) return

  // API calls: network-only
  if (url.pathname.startsWith('/api/')) return

  // Navigation requests: try network first, fall back to cache, then offline shell
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(resp => {
          if (resp && resp.status === 200) {
            const clone = resp.clone()
            caches.open(CACHE_NAME).then(c => c.put(request, clone))
          }
          return resp
        })
        .catch(() => caches.match(request).then(cached => cached || caches.match('/')))
    )
    return
  }

  // Static assets (JS, CSS, fonts, images): stale-while-revalidate
  event.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(request).then(cached => {
        const networkFetch = fetch(request).then(resp => {
          if (resp && resp.status === 200 && resp.type !== 'opaque') {
            cache.put(request, resp.clone())
          }
          return resp
        }).catch(() => cached)

        return cached || networkFetch
      })
    )
  )
})
