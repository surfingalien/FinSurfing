/**
 * registerSW.js
 *
 * Register the service worker in production. Called once from main.jsx.
 * Silently skips in dev (localhost) to avoid interfering with HMR.
 */

export function registerSW() {
  if (!('serviceWorker' in navigator)) return

  const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
  if (isLocalhost) return

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(reg => {
        // Check for updates every hour
        setInterval(() => reg.update(), 60 * 60 * 1000)

        reg.onupdatefound = () => {
          const worker = reg.installing
          if (!worker) return
          worker.onstatechange = () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              // New version available — could show an update banner here
              console.log('[SW] New version available. Reload to update.')
            }
          }
        }
      })
      .catch(err => console.warn('[SW] Registration failed:', err))
  })
}
