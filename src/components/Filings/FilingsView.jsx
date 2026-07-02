/**
 * FilingsView — SEC filing-narrative research.
 * Route id: 'filings'
 *
 * Fetches /api/filings/:symbol (SEC EDGAR 10-K/10-Q/8-K narrative, AI-summarised)
 * and renders the structured research card. Uses the shared useQuery cache so
 * re-visiting a symbol renders instantly.
 */

import { useState } from 'react'
import {
  FileText, Search, RefreshCw, AlertTriangle, Flag,
  ShieldAlert, Lightbulb, ExternalLink,
} from 'lucide-react'
import { useQuery, fetchJson } from '../../hooks/useQuery'
import { useAuth } from '../../contexts/AuthContext'

const FORMS = ['Latest', '10-K', '10-Q', '8-K']

const TONE_STYLE = {
  optimistic: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400',
  cautious:   'bg-amber-500/10 border-amber-500/30 text-amber-400',
  neutral:    'bg-white/[0.04] border-white/[0.08] text-slate-400',
  defensive:  'bg-red-500/10 border-red-500/30 text-red-400',
}

function Card({ symbol, form }) {
  const { accessToken } = useAuth()
  const formQs = form && form !== 'Latest' ? `?form=${encodeURIComponent(form)}` : ''
  const key = `filings:${symbol}:${form || 'Latest'}`
  const { data, error, loading, refetch } = useQuery(
    key,
    () => fetchJson(`/api/filings/${encodeURIComponent(symbol)}${formQs}`, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    }),
    { staleMs: 6 * 60 * 60_000 },   // matches the route's 6h server cache
  )

  if (loading && !data) {
    return (
      <div className="glass rounded-2xl p-8 flex items-center justify-center gap-3 text-slate-400">
        <RefreshCw className="w-4 h-4 animate-spin" />
        <span className="text-sm">Pulling {symbol}'s latest SEC filing from EDGAR…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="glass rounded-2xl p-6 border border-red-500/20 flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm text-red-300">{error.message}</p>
          <p className="text-xs text-slate-500 mt-1">EDGAR covers US-listed companies. Crypto and most ETFs aren't available.</p>
          <button onClick={refetch} className="mt-3 text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1">
            <RefreshCw className="w-3 h-3" /> Retry
          </button>
        </div>
      </div>
    )
  }

  if (!data) return null

  const tone = (data.managementTone || '').toLowerCase()
  const toneStyle = TONE_STYLE[tone] || TONE_STYLE.neutral

  return (
    <div className="glass rounded-2xl p-6 space-y-5 animate-fade-in">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-white">{data.company || symbol}</h2>
          <p className="text-xs text-slate-500">
            {symbol} · SEC {data.form}{data.filingDate ? ` · filed ${data.filingDate}` : ''}
            {data.llmUsed ? ` · ${data.llmUsed}` : ''}{data.cached ? ' · cached' : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data.managementTone && (
            <span className={`text-[11px] px-2.5 py-1 rounded-lg border font-medium ${toneStyle}`}>
              Tone: {data.managementTone}
            </span>
          )}
          <button onClick={refetch} className="text-slate-400 hover:text-cyan-400 p-1.5 rounded-lg hover:bg-white/[0.04]" title="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {data.summary && <p className="text-sm text-slate-300 leading-relaxed">{data.summary}</p>}

      {Array.isArray(data.keyChanges) && data.keyChanges.length > 0 && (
        <Section icon={FileText} color="text-cyan-400" title="Notable changes" items={data.keyChanges} />
      )}
      {Array.isArray(data.riskFactors) && data.riskFactors.length > 0 && (
        <Section icon={ShieldAlert} color="text-amber-400" title="Material risk factors" items={data.riskFactors} />
      )}
      {Array.isArray(data.redFlags) && data.redFlags.length > 0 && (
        <Section icon={Flag} color="text-red-400" title="Red flags" items={data.redFlags} />
      )}

      {data.analystTakeaway && (
        <div className="rounded-xl p-4 bg-cyan-500/[0.06] border border-cyan-500/20 flex items-start gap-3">
          <Lightbulb className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-[11px] uppercase tracking-wide text-cyan-400/80 font-semibold mb-1">Analyst takeaway</p>
            <p className="text-sm text-slate-300 leading-relaxed">{data.analystTakeaway}</p>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between pt-1 border-t border-white/[0.06]">
        {data.source && (
          <a href={data.source} target="_blank" rel="noopener noreferrer"
             className="text-[11px] text-slate-500 hover:text-cyan-400 flex items-center gap-1">
            <ExternalLink className="w-3 h-3" /> View filing on SEC EDGAR
          </a>
        )}
        <span className="text-[10px] text-slate-600">Not financial advice</span>
      </div>
    </div>
  )
}

function Section({ icon: Icon, color, title, items }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Icon className={`w-3.5 h-3.5 ${color}`} />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</h3>
      </div>
      <ul className="space-y-1.5">
        {items.map((it, i) => (
          <li key={i} className="text-sm text-slate-300 flex items-start gap-2">
            <span className={`mt-1.5 w-1 h-1 rounded-full shrink-0 ${color.replace('text-', 'bg-')}`} />
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function FilingsView({ defaultSymbol = '' }) {
  const [input, setInput]   = useState(defaultSymbol)
  const [query, setQuery]   = useState(
    defaultSymbol ? { symbol: defaultSymbol.toUpperCase(), form: 'Latest' } : null
  )
  const [form, setForm]     = useState('Latest')

  const submit = () => {
    const sym = input.trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '')
    if (sym) setQuery({ symbol: sym, form })
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center gap-3">
        <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/20">
          <FileText className="w-5 h-5 text-cyan-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Filing Research</h1>
          <p className="text-xs text-slate-500">AI summary of the latest 10-K / 10-Q / 8-K narrative from SEC EDGAR — MD&A, risk factors, red flags</p>
        </div>
      </div>

      <div className="glass rounded-2xl p-4 flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()}
            placeholder="US ticker (e.g. AAPL, NVDA, MSFT)"
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl pl-9 pr-3 py-2.5 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/40"
          />
        </div>
        <div className="flex items-center gap-1 bg-white/[0.04] border border-white/[0.08] rounded-xl p-1">
          {FORMS.map(f => (
            <button
              key={f}
              onClick={() => setForm(f)}
              className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
                form === f ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-400 hover:text-white'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <button
          onClick={submit}
          className="text-sm font-medium px-4 py-2.5 rounded-xl bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/30 transition-colors"
        >
          Analyze
        </button>
      </div>

      {query
        ? <Card key={`${query.symbol}:${query.form}`} symbol={query.symbol} form={query.form} />
        : (
          <div className="glass rounded-2xl p-10 text-center text-slate-500">
            <FileText className="w-8 h-8 mx-auto mb-3 text-slate-600" />
            <p className="text-sm">Enter a US stock ticker to read its latest SEC filing narrative.</p>
          </div>
        )}
    </div>
  )
}
