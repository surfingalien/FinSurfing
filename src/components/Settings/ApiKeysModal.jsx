/**
 * ApiKeysModal.jsx
 *
 * Settings panel for entering and testing market data API keys.
 * Keys are stored in localStorage and sent as request headers.
 * The backend uses them over its own env vars when present.
 */
import { useState } from 'react'
import { useApiKeys } from '../../contexts/ApiKeysContext'
import {
  X, Key, CheckCircle2, XCircle, Loader2, Eye, EyeOff,
  ExternalLink, AlertTriangle, Trash2, Save,
} from 'lucide-react'

const PROVIDERS = [
  {
    id:       'anthropic',
    label:    'Anthropic (Claude AI)',
    envVar:   'ANTHROPIC_API_KEY',
    url:      'https://console.anthropic.com/settings/keys',
    urlLabel: 'console.anthropic.com',
    desc:     'Powers AI Brain and AI Buy Signals. Without this key those features are unavailable. Get a free key at console.anthropic.com.',
    test:     '/api/ai-brain/ping',
    check:    (d) => d?.ok === true,
    badge:    'AI',
    color:    'indigo',
  },
  {
    id:       'aisa',
    label:    'AISA (Recommended)',
    envVar:   'AISA_API_KEY',
    url:      'https://aisa.one',
    urlLabel: 'aisa.one',
    desc:     'Cloud-friendly Yahoo Finance proxy. ~$0.001/request, pay-as-you-go. Best choice.',
    test:     '/api/quote?symbols=AAPL',
    check:    (d) => d?.quoteResponse?.result?.[0]?.regularMarketPrice != null,
    badge:    'Best',
    color:    'mint',
  },
  {
    id:       'finnhub',
    label:    'Finnhub',
    envVar:   'FINNHUB_API_KEY',
    url:      'https://finnhub.io',
    urlLabel: 'finnhub.io',
    desc:     'Real-time quotes + WebSocket stream. Free tier: 60 req/min.',
    test:     '/api/quote?symbols=AAPL',
    check:    (d) => d?.quoteResponse?.result?.[0]?.regularMarketPrice != null,
    badge:    'Free',
    color:    'blue',
  },
  {
    id:       'fmp',
    label:    'Financial Modeling Prep',
    envVar:   'FMP_API_KEY',
    url:      'https://financialmodelingprep.com',
    urlLabel: 'financialmodelingprep.com',
    desc:     'Historical charts + fundamentals. Free tier: 250 req/day.',
    test:     '/api/chart?symbol=AAPL&interval=1d&range=1mo',
    check:    (d) => d?.chart?.result?.[0]?.timestamp?.length > 0,
    badge:    'Free',
    color:    'amber',
  },
  {
    id:       'td',
    label:    'Twelve Data',
    envVar:   'TWELVE_DATA_API_KEY',
    url:      'https://twelvedata.com',
    urlLabel: 'twelvedata.com',
    desc:     'Historical charts + quotes. Free tier: 800 req/day, 8 req/min. Register free at twelvedata.com for full US coverage.',
    test:     '/api/chart?symbol=AAPL&interval=1d&range=1mo',
    check:    (d) => d?.chart?.result?.[0]?.timestamp?.length > 0,
    badge:    'Free',
    color:    'purple',
  },
  {
    id:       'av',
    label:    'Alpha Vantage',
    envVar:   'ALPHA_VANTAGE_API_KEY',
    url:      'https://www.alphavantage.co/support/#api-key',
    urlLabel: 'alphavantage.co',
    desc:     'Last-resort fallback. Free tier: 25 req/day, 5 req/min.',
    test:     '/api/quote?symbols=AAPL',
    check:    (d) => d?.quoteResponse?.result?.[0]?.regularMarketPrice != null,
    badge:    'Free',
    color:    'rose',
  },
]

const COLOR = {
  indigo: 'text-indigo-400 border-indigo-500/30 bg-indigo-500/10',
  mint:   'text-mint-400 border-mint-500/30 bg-mint-500/10',
  blue:   'text-blue-400 border-blue-500/30 bg-blue-500/10',
  amber:  'text-amber-400 border-amber-500/30 bg-amber-500/10',
  purple: 'text-purple-400 border-purple-500/30 bg-purple-500/10',
  rose:   'text-rose-400 border-rose-500/30 bg-rose-500/10',
}

function KeyRow({ provider, value, onChange, onTest, testState }) {
  const [show, setShow] = useState(false)
  const { color, badge } = provider

  return (
    <div className="p-4 rounded-xl bg-white/[0.03] border border-white/[0.07] space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-white">{provider.label}</span>
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md border ${COLOR[color]}`}>
            {badge}
          </span>
        </div>
        <a
          href={provider.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
        >
          Get key <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      <p className="text-[11px] text-slate-500">{provider.desc}</p>

      {/* Input */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            type={show ? 'text' : 'password'}
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder={`Paste your ${provider.envVar}…`}
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 pr-9
                       text-sm text-white placeholder-slate-600 focus:outline-none
                       focus:border-mint-500/40 focus:bg-white/[0.06] transition-all font-mono"
          />
          <button
            type="button"
            onClick={() => setShow(s => !s)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
          >
            {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </div>

        {/* Test button */}
        <button
          onClick={onTest}
          disabled={!value.trim() || testState === 'testing'}
          className="px-3 py-2 rounded-lg border border-white/[0.08] text-xs font-medium
                     text-slate-400 hover:text-white hover:border-white/20 disabled:opacity-40
                     disabled:cursor-not-allowed transition-all flex items-center gap-1.5 whitespace-nowrap"
        >
          {testState === 'testing' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {testState === 'ok'      && <CheckCircle2 className="w-3.5 h-3.5 text-mint-400" />}
          {testState === 'error'   && <XCircle className="w-3.5 h-3.5 text-red-400" />}
          {!testState              && <Key className="w-3.5 h-3.5" />}
          {testState === 'ok' ? 'Working!' : testState === 'error' ? 'Failed' : 'Test'}
        </button>
      </div>

      {/* Status feedback */}
      {testState === 'ok' && (
        <p className="text-[11px] text-mint-400 flex items-center gap-1">
          <CheckCircle2 className="w-3 h-3" /> Key is valid — live prices confirmed.
        </p>
      )}
      {testState === 'error' && (
        <p className="text-[11px] text-red-400 flex items-center gap-1">
          <XCircle className="w-3 h-3" /> Key rejected or quota exceeded. Get a new one at{' '}
          <a href={provider.url} target="_blank" rel="noopener noreferrer"
             className="underline hover:text-red-300">{provider.urlLabel}</a>.
        </p>
      )}
    </div>
  )
}

export default function ApiKeysModal({ onClose }) {
  const { keys, save, clear } = useApiKeys()
  const [draft,     setDraft]     = useState({ ...keys })
  const [testState, setTestState] = useState({})  // { aisa: 'ok'|'error'|'testing', ... }
  const [saved,     setSaved]     = useState(false)

  const update = (id, val) => {
    setDraft(d => ({ ...d, [id]: val }))
    setTestState(s => ({ ...s, [id]: null }))  // reset test state when key changes
    setSaved(false)
  }

  const testKey = async (provider) => {
    const val = draft[provider.id]?.trim()
    if (!val) return

    setTestState(s => ({ ...s, [provider.id]: 'testing' }))
    try {
      const headerMap = {
        anthropic: 'x-anthropic-key',
        aisa:      'x-aisa-key',
        finnhub:   'x-finnhub-key',
        fmp:       'x-fmp-key',
        av:        'x-av-key',
        td:        'x-td-key',
      }
      const res = await fetch(provider.test, {
        headers: { [headerMap[provider.id]]: val },
        signal:  AbortSignal.timeout(15000),
      })
      const data = await res.json()
      const ok = provider.check(data)
      setTestState(s => ({ ...s, [provider.id]: ok ? 'ok' : 'error' }))
    } catch {
      setTestState(s => ({ ...s, [provider.id]: 'error' }))
    }
  }

  const handleSave = () => {
    save(draft)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleClear = () => {
    clear()
    setDraft({ anthropic: '', aisa: '', finnhub: '', fmp: '', td: '', av: '' })
    setTestState({})
  }

  const hasAny = Object.values(draft).some(v => v.trim())

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="relative w-full max-w-lg max-h-[90vh] flex flex-col
                      bg-[#0d1424] border border-white/[0.08] rounded-2xl shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-white/[0.06]">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-mint-500/10 border border-mint-500/20">
              <Key className="w-4 h-4 text-mint-400" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">API Keys</h2>
              <p className="text-[11px] text-slate-500">Stored in your browser — never sent to our servers</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/[0.06] transition-all">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Warning if no keys */}
        {!hasAny && (
          <div className="mx-5 mt-4 flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>No API keys set. Add AISA (recommended) or FMP for full chart/quote coverage, or register a free Twelve Data key (800 req/day) at twelvedata.com.</span>
          </div>
        )}

        {/* Keys list */}
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {PROVIDERS.map(p => (
            <KeyRow
              key={p.id}
              provider={p}
              value={draft[p.id] || ''}
              onChange={val => update(p.id, val)}
              onTest={() => testKey(p)}
              testState={testState[p.id]}
            />
          ))}
        </div>

        {/* Footer */}
        <div className="p-5 border-t border-white/[0.06] flex items-center justify-between gap-3">
          <button
            onClick={handleClear}
            disabled={!hasAny}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs text-slate-500
                       hover:text-red-400 hover:bg-red-500/10 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            <Trash2 className="w-3.5 h-3.5" /> Clear all
          </button>
          <button
            onClick={handleSave}
            className={`flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-bold transition-all
              ${saved
                ? 'bg-mint-500/20 text-mint-300 border border-mint-500/30'
                : 'bg-mint-500 hover:bg-mint-400 text-[#070b14]'
              }`}
          >
            {saved
              ? <><CheckCircle2 className="w-4 h-4" /> Saved!</>
              : <><Save className="w-4 h-4" /> Save Keys</>
            }
          </button>
        </div>
      </div>
    </div>
  )
}
