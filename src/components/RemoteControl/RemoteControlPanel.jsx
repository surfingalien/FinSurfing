import { useState } from 'react'
import { Terminal, Send, CheckCircle, XCircle, Lock } from 'lucide-react'

export default function RemoteControlPanel() {
  const [secret, setSecret] = useState(() => localStorage.getItem('rc_secret') || '')
  const [cmd, setCmd] = useState('')
  const [status, setStatus] = useState(null) // null | 'ok' | 'error'
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  const saveSecret = (v) => {
    setSecret(v)
    localStorage.setItem('rc_secret', v)
  }

  const send = async () => {
    if (!cmd.trim() || !secret.trim() || loading) return
    setLoading(true)
    setStatus(null)
    try {
      const r = await fetch('/api/rc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ cmd: cmd.trim() }),
      })
      const data = await r.json()
      if (r.ok) {
        setStatus('ok')
        setMessage(`Queued: "${data.queued?.slice(0, 60)}"`)
        setCmd('')
      } else {
        setStatus('error')
        setMessage(data.error || 'Failed')
      }
    } catch (err) {
      setStatus('error')
      setMessage(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Terminal size={20} className="text-[#00ffcc]" />
        <h2 className="text-lg font-semibold text-white">Remote Control</h2>
      </div>

      <div className="glass rounded-xl border border-white/[0.08] p-5 space-y-4">
        <p className="text-sm text-slate-400">
          Send instructions to the active Claude Code session. Commands are queued via <code className="text-[#00ffcc] text-xs">/api/rc</code> and processed in real-time.
        </p>

        {/* Secret */}
        <div>
          <label className="block text-xs text-slate-500 mb-1.5">
            <Lock size={10} className="inline mr-1" />RC Secret (stored locally)
          </label>
          <input
            type="password"
            value={secret}
            onChange={e => saveSecret(e.target.value)}
            placeholder="Set RC_SECRET env var on server, paste here"
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 outline-none focus:border-[#00ffcc]/30"
          />
        </div>

        {/* Command */}
        <div>
          <label className="block text-xs text-slate-500 mb-1.5">Command</label>
          <textarea
            value={cmd}
            onChange={e => setCmd(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send() }}
            placeholder="E.g. Add a price alert feature to the watchlist"
            rows={3}
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 outline-none focus:border-[#00ffcc]/30 resize-none"
          />
          <p className="text-[10px] text-slate-600 mt-1">Ctrl/Cmd+Enter to send</p>
        </div>

        <button
          onClick={send}
          disabled={!cmd.trim() || !secret.trim() || loading}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#00ffcc]/15 border border-[#00ffcc]/25 text-[#00ffcc] text-sm hover:bg-[#00ffcc]/25 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <Send size={14} />
          {loading ? 'Sending…' : 'Send Command'}
        </button>

        {status && (
          <div className={`flex items-center gap-2 text-sm ${status === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}>
            {status === 'ok' ? <CheckCircle size={14} /> : <XCircle size={14} />}
            {message}
          </div>
        )}
      </div>

      <div className="glass rounded-xl border border-white/[0.08] p-5 space-y-3">
        <h3 className="text-sm font-medium text-white">Direct access (mobile / other devices)</h3>
        <p className="text-xs text-slate-400">
          Open <span className="text-[#00ffcc]">claude.ai/code</span> on any device and navigate to this session — full remote control without the API endpoint.
        </p>
        <div className="text-xs text-slate-500 space-y-1">
          <div>Session: <code className="text-slate-400">cse_01Qdh8xfJ82Wgmrgiden4nzw</code></div>
          <div>GitHub Issues: create issue with label <code className="text-slate-400">claude-cmd</code> for async commands</div>
        </div>
      </div>
    </div>
  )
}
