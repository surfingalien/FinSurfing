/**
 * ScanSources — lists to scan that come from the market or from you, instead
 * of from a fixed list:
 *
 *  - the symbols your own TradingView alerted on in the last days
 *    (lib/inbound-alerts.js) — only the tickers are used; the alert text is
 *    never sent to the model;
 *  - today's market screens (lib/tv-scanner.js), when the operator has
 *    switched the scanner on.
 *
 * Choosing one only FILLS the symbol box. A scan spends AI credits, so it
 * starts when the user presses the scan button, never from here.
 */
import { useCallback, useEffect, useState } from 'react'
import { Webhook, Radar, Loader2 } from 'lucide-react'
import { useAuth } from '../../../contexts/AuthContext'

const MAX = 20

export default function ScanSources({ onFill, disabled, onAlerted }) {
  const { authFetch, isAuthenticated } = useAuth()
  const [alerts, setAlerts] = useState(null)      // { symbols, days }
  const [scan, setScan] = useState(null)          // { enabled, presets }
  const [busy, setBusy] = useState(null)
  const [note, setNote] = useState(null)

  const getJson = useCallback(async (url) => {
    const res = await authFetch(url)
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body.error) throw new Error(body.error || `Request failed (${res.status})`)
    return body
  }, [authFetch])

  useEffect(() => {
    if (!isAuthenticated) return undefined
    let live = true
    getJson('/api/inbound-alerts?limit=300').then(d => {
      if (!live) return
      const since = Date.now() - (d.recentDays || 3) * 86400000
      const symbols = [...new Set((d.alerts || []).filter(a => a.symbol && new Date(a.at).getTime() >= since).map(a => a.symbol))]
      setAlerts({ symbols, days: d.recentDays || 3 })
      onAlerted?.(symbols)
    }).catch(() => {})
    getJson('/api/screener/market-scan?preset=most-active').then(d => live && setScan({ enabled: !!d.enabled, presets: d.presets || [] })).catch(() => {})
    return () => { live = false }
  }, [isAuthenticated, getJson]) // eslint-disable-line react-hooks/exhaustive-deps

  const fill = (symbols, what) => {
    const list = symbols.slice(0, MAX)
    onFill(list.join(','))
    setNote(`${list.length} ${list.length === 1 ? 'symbol' : 'symbols'} from ${what} ${list.length === 1 ? 'is' : 'are'} in the box${symbols.length > MAX ? ` (the first ${MAX} of ${symbols.length})` : ''}. Press the scan button to analyse ${list.length === 1 ? 'it' : 'them'}.`)
  }

  const fromPreset = async (p) => {
    setBusy(p.id); setNote(null)
    try {
      const d = await getJson(`/api/screener/market-scan?preset=${encodeURIComponent(p.id)}`)
      if (d.unavailable) setNote(`The market scan could not be run: ${d.unavailable}.`)
      else if (!d.rows?.length) setNote(`Nothing matches “${p.label}” right now.`)
      else fill(d.rows.map(r => r.symbol), `“${p.label}”`)
    } catch (e) { setNote(e.message) } finally { setBusy(null) }
  }

  const hasAlerts = alerts?.symbols?.length > 0
  if (!hasAlerts && !scan?.enabled) return null

  return (
    <div className="glass rounded-xl p-3 border border-white/[0.06] space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-slate-500 mr-1">Scan a list from</span>
        {hasAlerts && (
          <button type="button" disabled={disabled} onClick={() => fill(alerts.symbols, 'your TradingView alerts')}
            title={`The tickers your own TradingView alerted on in the last ${alerts.days} days: ${alerts.symbols.join(', ')}. Only the tickers are used — the alert text is never sent to the AI.`}
            className="px-2.5 py-1.5 rounded-lg text-xs border text-pink-500 border-pink-500/30 bg-pink-500/10 hover:bg-pink-500/20 disabled:opacity-50 inline-flex items-center gap-1.5">
            <Webhook className="w-3.5 h-3.5" aria-hidden="true" /> Your TradingView alerts ({alerts.symbols.length})
          </button>
        )}
        {scan?.enabled && scan.presets.map(p => (
          <button key={p.id} type="button" disabled={disabled || !!busy} onClick={() => fromPreset(p)} title={p.fact}
            className="px-2.5 py-1.5 rounded-lg text-xs border text-slate-300 border-slate-500/25 hover:text-white disabled:opacity-50 inline-flex items-center gap-1.5">
            {busy === p.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Radar className="w-3.5 h-3.5" aria-hidden="true" />} {p.label}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-slate-500">
        {note || 'This only fills the symbol box below — a scan spends AI credits, so it starts when you press the scan button. Each list is a fact about today (what you were alerted on, what is trading unusually), not a recommendation; the scan still prices and judges every name itself.'}
      </p>
    </div>
  )
}
