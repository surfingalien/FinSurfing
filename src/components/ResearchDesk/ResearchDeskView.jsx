/**
 * ResearchDeskView — the research flow for one symbol, end to end.
 *
 *   evidence (measured, in code) → thesis (model, must cite evidence)
 *   → judgement (code: citations, levels, expected value) → tracked outcome
 *
 * Three tabs: Research (the flow), My theses (every thesis scored against the
 * market), Track record (the system's measured record, with intervals).
 * Backend: routes/research-desk.js; pure logic: lib/research-desk.js.
 */
import { useState, useCallback, useEffect, useRef } from 'react'
import {
  Microscope, Loader2, FileSearch, PenLine, ListChecks, LineChart, AlertTriangle,
} from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { getApiKeyHeaders } from '../../services/api'
import EvidenceList from './parts/EvidenceList'
import ThesisResult from './parts/ThesisResult'
import ThesesList from './parts/ThesesList'
import TrackRecord from './parts/TrackRecord'

const TABS = [
  { id: 'research', label: 'Research',     icon: FileSearch },
  { id: 'theses',   label: 'My theses',    icon: ListChecks },
  { id: 'record',   label: 'Track record', icon: LineChart },
]

const STEPS = ['Gather measured evidence', 'Write a thesis that cites it', 'Code checks every claim, level and the expected value', 'Track the outcome against the market']

export default function ResearchDeskView({ defaultSymbol = null, onSymbol }) {
  const { authFetch, isAuthenticated } = useAuth()
  const [tab, setTab]           = useState('research')
  const [input, setInput]       = useState(defaultSymbol || '')
  const [dossier, setDossier]   = useState(null)
  const [thesis, setThesis]     = useState(null)
  const [theses, setTheses]     = useState(null)
  const [record, setRecord]     = useState(null)
  const [busy, setBusy]         = useState(null)   // 'evidence' | 'thesis' | 'list' | 'record'
  const [error, setError]       = useState(null)
  const [highlight, setHighlight] = useState(null)
  // The symbol last requested, so the deep-link effect below doesn't re-fetch
  // the dossier this view just loaded and wrote into the URL itself.
  const requested = useRef(null)

  const call = useCallback(async (url, opts = {}) => {
    const res = await authFetch(url, { ...opts, headers: { ...getApiKeyHeaders(), ...(opts.headers || {}) } })
    const json = await res.json().catch(() => ({}))
    // Thesis generation is heartbeated: once the first byte is out the status
    // is pinned to 200, so an error can only arrive in the body.
    if (!res.ok || json?.error) throw new Error(json?.error || `HTTP ${res.status}`)
    return json
  }, [authFetch])

  const gather = useCallback(async (sym) => {
    const s = String(sym || '').trim().toUpperCase()
    if (!s) return
    requested.current = s
    setBusy('evidence'); setError(null); setThesis(null); setDossier(null)
    try {
      setDossier(await call(`/api/research-desk/${encodeURIComponent(s)}/evidence`))
      onSymbol?.(s)
    } catch (e) { setError(e.message) } finally { setBusy(null) }
  }, [call, onSymbol])

  const writeThesis = useCallback(async () => {
    if (!dossier) return
    setBusy('thesis'); setError(null)
    try { setThesis(await call(`/api/research-desk/${encodeURIComponent(dossier.symbol)}/thesis`, { method: 'POST', body: {} })) }
    catch (e) { setError(e.message) } finally { setBusy(null) }
  }, [call, dossier])

  useEffect(() => {
    const s = defaultSymbol?.toUpperCase()
    if (s && isAuthenticated && s !== requested.current) { setInput(s); gather(s) }
  }, [defaultSymbol, isAuthenticated]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isAuthenticated) return
    if (tab === 'theses') {
      setBusy('list'); setError(null)
      call('/api/research-desk/theses').then(j => setTheses(j.theses)).catch(e => setError(e.message)).finally(() => setBusy(null))
    }
    if (tab === 'record') {
      setBusy('record'); setError(null)
      call('/api/research-desk/track-record').then(setRecord).catch(e => setError(e.message)).finally(() => setBusy(null))
    }
  }, [tab, isAuthenticated, call])

  const cite = id => {
    setHighlight(id)
    document.getElementById(`evidence-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-5">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Microscope className="w-6 h-6 text-mint-400" /> Research Desk
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          One flow per symbol. The AI writes the thesis; code gathers the evidence, checks every claim against the evidence it
          cites, derives the price levels, and decides whether the trade clears its costs at this system's measured win rate.
        </p>
        <ol className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-slate-500">
          {STEPS.map((s, i) => <li key={s}><span className="font-mono text-mint-400">{i + 1}.</span> {s}</li>)}
        </ol>
      </div>

      <div className="flex gap-1 border-b border-slate-500/20">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px ${tab === t.id ? 'border-mint-400 text-mint-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
            <t.icon className="w-4 h-4" /> {t.label}
          </button>
        ))}
      </div>

      {!isAuthenticated && <p className="text-sm text-slate-500">Sign in to use the Research Desk — theses are saved and tracked per account.</p>}

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {isAuthenticated && tab === 'research' && (
        <div className="space-y-4">
          <form className="flex gap-2" onSubmit={e => { e.preventDefault(); gather(input) }}>
            <input value={input} onChange={e => setInput(e.target.value.toUpperCase())} placeholder="Ticker, e.g. NVDA, SPY, BTC-USD"
              className="flex-1 bg-slate-500/10 border border-slate-500/20 rounded-xl px-3 py-2 text-sm outline-none focus:border-mint-400/50" />
            <button type="submit" disabled={!input || busy} className="btn-primary px-4 py-2 rounded-xl text-sm flex items-center gap-1.5 disabled:opacity-50">
              {busy === 'evidence' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSearch className="w-4 h-4" />} Gather evidence
            </button>
          </form>

          {dossier && (
            <div className="grid lg:grid-cols-5 gap-4 items-start">
              <div className="lg:col-span-2 space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">{dossier.symbol}{dossier.company ? ` · ${dossier.company}` : ''}</h3>
                  <span className="text-[11px] text-slate-500">${Number(dossier.lastPrice).toFixed(2)} · {dossier.asOf}</span>
                </div>
                <EvidenceList evidence={dossier.evidence} gaps={dossier.gaps} highlight={highlight} />
              </div>
              <div className="lg:col-span-3 space-y-3">
                {!thesis && (
                  <div className="glass rounded-2xl p-4 space-y-2">
                    <p className="text-[12px] text-slate-400">
                      The thesis may use only the {dossier.evidence.length} items on the left. Claims that cite nothing, cite the wrong
                      item, or state a figure the cited evidence does not contain are removed and shown to you. It is scored at a
                      calibrated win rate of <b>{Math.round(dossier.winProb.p * 100)}%</b> <span className="text-slate-500">({dossier.winProb.source})</span>.
                    </p>
                    <button onClick={writeThesis} disabled={!!busy} className="btn-primary px-4 py-2 rounded-xl text-sm flex items-center gap-1.5 disabled:opacity-50">
                      {busy === 'thesis' ? <Loader2 className="w-4 h-4 animate-spin" /> : <PenLine className="w-4 h-4" />} Write &amp; check a thesis
                    </button>
                  </div>
                )}
                {thesis && <ThesisResult data={thesis} onCite={cite} />}
              </div>
            </div>
          )}
        </div>
      )}

      {isAuthenticated && tab === 'theses' && (
        busy === 'list' ? <Loader2 className="w-5 h-5 animate-spin text-slate-500" />
          : <ThesesList theses={theses || []} onOpen={s => { setTab('research'); setInput(s); gather(s) }} />
      )}

      {isAuthenticated && tab === 'record' && (
        busy === 'record' ? <Loader2 className="w-5 h-5 animate-spin text-slate-500" /> : <TrackRecord data={record} />
      )}
    </div>
  )
}
