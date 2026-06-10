import { useState } from 'react'
import { Globe, RefreshCw, Save, X } from 'lucide-react'
import { useAuth }    from '../../../contexts/AuthContext'
import { useApiKeys } from '../../../contexts/ApiKeysContext'
import { TypeBadge }  from './noteHelpers'

// ── URL Scout modal ───────────────────────────────────────────────────────────
export default function ScoutModal({ onClose, onSave }) {
  const { authFetch }  = useAuth()
  const { getHeaders } = useApiKeys()
  const [url,        setUrl]        = useState('')
  const [symbol,     setSymbol]     = useState('')
  const [processing, setProcessing] = useState(false)
  const [result,     setResult]     = useState(null)
  const [error,      setError]      = useState(null)

  const scout = async () => {
    if (!url.trim()) return
    setProcessing(true); setError(null)
    try {
      const res  = await authFetch('/api/research-notes/scout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getHeaders() },
        body: JSON.stringify({ url: url.trim(), symbol: symbol.trim() || null }),
      })
      let data
      try { data = await res.json() } catch { throw new Error('Server returned an invalid response — please try again.') }
      if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`)
      setResult(data.note)
    } catch (e) { setError(e.message) }
    setProcessing(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="glass rounded-2xl w-full max-w-2xl border border-blue-500/25 shadow-2xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
          <Globe className="w-4 h-4 text-blue-400" />
          <span className="text-sm font-semibold text-white">URL Scout</span>
          <span className="text-[11px] text-slate-500 ml-1">— AI evaluates any article or research page</span>
          <button onClick={onClose} className="ml-auto text-slate-500 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          {!result ? (
            <>
              <div className="flex gap-2">
                <input value={url} onChange={e => setUrl(e.target.value)} autoFocus
                  placeholder="https://example.com/article-about-nvda"
                  className="input flex-1 text-xs" />
                <input value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())}
                  placeholder="SYMBOL" className="input w-24 text-xs font-mono text-mint-400 text-center" />
              </div>
              {error && <p className="text-xs text-red-400">{error}</p>}
              <div className="flex justify-end gap-2">
                <button onClick={onClose} className="btn-ghost text-xs py-1.5 px-3">Cancel</button>
                <button onClick={scout} disabled={!url.trim() || processing}
                  className="btn-primary flex items-center gap-1.5 text-xs py-1.5 disabled:opacity-50">
                  {processing ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Scouting…</> : <><Globe className="w-3.5 h-3.5" /> Scout URL</>}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2"><Globe className="w-3.5 h-3.5 text-blue-400" /><span className="text-xs font-semibold text-blue-400">Scouted result</span><TypeBadge type="url" /></div>
              <div className="bg-white/[0.03] rounded-xl p-3 border border-white/[0.07]">
                <div className="text-xs font-semibold text-white mb-2">{result.title}</div>
                <pre className="text-[11px] text-slate-300 whitespace-pre-wrap font-mono leading-relaxed max-h-64 overflow-y-auto">{result.content}</pre>
              </div>
              <div className="flex justify-between items-center">
                <button onClick={() => setResult(null)} className="text-xs text-slate-500 hover:text-white">← Edit URL</button>
                <div className="flex gap-2">
                  <button onClick={onClose} className="btn-ghost text-xs py-1.5 px-3">Discard</button>
                  <button
                    onClick={() => { onSave({ title: result.title, content: result.content, tags: result.tags || [], note_type: 'url', symbol: result.symbol || null, source_url: url }); onClose() }}
                    className="btn-primary flex items-center gap-1.5 text-xs py-1.5">
                    <Save className="w-3.5 h-3.5" /> Save Note
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
