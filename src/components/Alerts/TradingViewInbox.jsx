/**
 * TradingViewInbox — alerts sent in by your own TradingView
 * (routes/inbound-alerts.js, lib/inbound-alerts.js).
 *
 * You create a private web address here and paste it into a TradingView alert
 * ("Webhook URL"). Each alert that fires is recorded and shown below, on the
 * Research Desk queue and on the symbol's chart. Nothing here places an order,
 * and the alert text is never sent to an AI model.
 */
import { useCallback, useEffect, useState } from 'react'
import { Webhook, Copy, Check, RefreshCw, Trash2, Loader2, ArrowUpRight } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'

const EXAMPLE = '{"ticker":"{{ticker}}","price":{{close}},"message":"Crossed above the 200-day average"}'
const when = iso => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export default function TradingViewInbox({ onOpen }) {
  const { authFetch, isAuthenticated } = useAuth()
  const [data, setData] = useState(null)
  const [fresh, setFresh] = useState(null)      // the address, shown once after create/rotate
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(null)

  const call = useCallback(async (url, opts) => {
    const res = await authFetch(url, opts)
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body.error) throw new Error(body.error || `Request failed (${res.status})`)
    return body
  }, [authFetch])

  const load = useCallback(async () => {
    try { setData(await call('/api/inbound-alerts')); setError(null) } catch (e) { setError(e.message) }
  }, [call])
  useEffect(() => { if (isAuthenticated) load() }, [isAuthenticated, load])

  if (!isAuthenticated) return null

  const act = async (name, fn) => {
    setBusy(name); setError(null)
    try { await fn() } catch (e) { setError(e.message) } finally { setBusy(null) }
  }
  const createKey = () => {
    if (data?.status?.exists && !window.confirm('Make a new address? The current one stops working at once, and every TradingView alert using it must be updated.')) return
    act('key', async () => { const r = await call('/api/inbound-alerts/key', { method: 'POST' }); setFresh(r.url); await load() })
  }
  const switchOff = () => {
    if (!window.confirm('Switch the address off? TradingView alerts sent to it will be refused. Alerts already received are kept.')) return
    act('off', async () => { await call('/api/inbound-alerts/key', { method: 'DELETE' }); setFresh(null); await load() })
  }
  const remove = id => act(id, async () => { await call(`/api/inbound-alerts/${id}`, { method: 'DELETE' }); await load() })
  const copy = async (what, text) => {
    try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(null), 1500) } catch { setError('Could not copy — select the text and copy it by hand.') }
  }

  const status = data?.status
  return (
    <section className="glass rounded-2xl p-5 space-y-4" aria-labelledby="tv-inbox-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="tv-inbox-title" className="text-base font-semibold text-white flex items-center gap-2"><Webhook className="w-4 h-4 text-mint-400" aria-hidden="true" /> Alerts from your TradingView</h2>
          <p className="text-xs text-slate-400 mt-1 max-w-2xl">
            Give TradingView a private address and every alert that fires there is recorded here, flagged on your Research Desk queue and marked on the symbol's chart.
            It only records: nothing places an order, and the alert text is never sent to an AI model.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={createKey} disabled={!!busy} className="btn-primary px-3 py-1.5 rounded-lg text-xs inline-flex items-center gap-1.5 disabled:opacity-50">
            {busy === 'key' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {status?.exists ? 'Make a new address' : 'Create my address'}
          </button>
          {status?.exists && <button type="button" onClick={switchOff} disabled={!!busy} className="px-3 py-1.5 rounded-lg text-xs border border-slate-500/25 text-slate-300 hover:text-white disabled:opacity-50">Switch off</button>}
        </div>
      </div>

      {error && <p className="text-sm text-red-400" role="alert">{error}</p>}

      {fresh && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
          <p className="text-xs text-amber-300 font-semibold">Copy this address now — it is shown only once.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 text-[11px] text-slate-200 break-all">{fresh}</code>
            <button type="button" onClick={() => copy('url', fresh)} className="shrink-0 px-2.5 py-1.5 rounded-lg text-xs border border-slate-500/30 text-slate-200 inline-flex items-center gap-1">
              {copied === 'url' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} {copied === 'url' ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="text-[11px] text-slate-400">Anyone who has this address can add alerts to your list, so treat it like a password. If it leaks, make a new one.</p>
        </div>
      )}

      {status && (
        <p className="text-xs text-slate-400">
          {status.exists
            ? <>Your address is on (created {when(status.createdAt)}). {status.received > 0 ? <>{status.received} alert{status.received === 1 ? '' : 's'} received, the last {when(status.lastAt)}.</> : 'No alert has arrived yet.'}{!fresh && ' The address itself cannot be shown again; make a new one if you lost it.'}</>
            : 'No address yet. Create one to start receiving alerts.'}
        </p>
      )}

      {status?.exists && (
        <details className="text-xs text-slate-400">
          <summary className="cursor-pointer text-slate-300 hover:text-white">How to set it up in TradingView</summary>
          <ol className="list-decimal pl-5 mt-2 space-y-1.5">
            <li>Create or edit an alert in TradingView and open its <b>Notifications</b> tab.</li>
            <li>Tick <b>Webhook URL</b> and paste your address. (TradingView offers webhooks on its paid plans.)</li>
            <li>
              In the alert's <b>Message</b> box paste this, and change the text to say what the alert means:
              <div className="flex items-start gap-2 mt-1">
                <code className="flex-1 min-w-0 text-[11px] text-slate-200 break-all bg-slate-500/10 rounded-lg px-2 py-1.5">{EXAMPLE}</code>
                <button type="button" onClick={() => copy('msg', EXAMPLE)} className="shrink-0 px-2 py-1.5 rounded-lg border border-slate-500/30 text-slate-200 inline-flex items-center gap-1">
                  {copied === 'msg' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} {copied === 'msg' ? 'Copied' : 'Copy'}
                </button>
              </div>
            </li>
            <li>A plain sentence works too. Start it with the ticker in capitals, for example “AAPL crossed 350”, so the alert can be matched to a stock.</li>
          </ol>
        </details>
      )}

      {data?.alerts?.length > 0 && (
        <div className="relative overflow-x-auto">
          <table className="w-full text-xs min-w-[480px]">
            <thead><tr className="text-left text-slate-500">
              <th scope="col" className="font-medium py-1.5 pr-3">Received</th>
              <th scope="col" className="font-medium py-1.5 px-2">Symbol</th>
              <th scope="col" className="font-medium py-1.5 px-2 text-right">Price sent</th>
              <th scope="col" className="font-medium py-1.5 px-2">Message</th>
              <th scope="col" className="py-1.5 pl-2"><span className="sr-only">Delete</span></th>
            </tr></thead>
            <tbody>{data.alerts.map(a => (
              <tr key={a.id} className="border-t border-slate-500/10 align-top">
                <td className="py-1.5 pr-3 text-slate-400 whitespace-nowrap">{when(a.at)}</td>
                <td className="py-1.5 px-2">
                  {a.symbol
                    ? <button type="button" onClick={() => onOpen?.(a.symbol)} title={`Open ${a.symbol} on the Research Desk`} className="inline-flex items-center gap-0.5 font-semibold text-white hover:text-mint-400">{a.symbol}<ArrowUpRight className="w-3 h-3" aria-hidden="true" /></button>
                    : <span className="text-slate-500" title="The alert did not name a ticker">—</span>}
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums text-slate-300">{a.price != null ? `$${a.price.toLocaleString(undefined, { maximumFractionDigits: 4 })}` : '—'}</td>
                <td className="py-1.5 px-2 text-slate-300 break-words">{a.message || <span className="text-slate-500">no message</span>}{a.action && <span className="text-slate-500"> · says “{a.action}” (recorded only)</span>}</td>
                <td className="py-1.5 pl-2 text-right">
                  <button type="button" onClick={() => remove(a.id)} disabled={busy === a.id} aria-label={`Delete the alert received ${when(a.at)}`} className="text-slate-500 hover:text-red-400 disabled:opacity-50"><Trash2 className="w-3.5 h-3.5" /></button>
                </td>
              </tr>
            ))}</tbody>
          </table>
          <p className="text-[11px] text-slate-500 mt-2">The newest {data.alerts.length} are shown. An alert stays on the Research Desk queue for {data.recentDays} days. “Price sent” is what TradingView put in the message, not a price this app checked.</p>
        </div>
      )}
    </section>
  )
}
