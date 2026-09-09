/**
 * ExposureView — which LISTED stocks have disclosed exposure to a company.
 *
 * The anchor can be a ticker (NVDA, TSM, PLTR) or a private company you cannot
 * buy (SpaceX, OpenAI). For the private ones this is the only tradeable angle
 * there is.
 *
 * The design point: every supplier/customer row shows the VERBATIM sentence
 * from the SEC filing it came from, with a link to the filing. A relationship
 * claim with no quote behind it is exactly what this feature exists to avoid
 * producing, so the evidence is the primary content of a card, not a detail
 * tucked behind a disclosure triangle.
 */

import { useState, useCallback, useEffect } from 'react'
import {
  Network, RefreshCw, AlertTriangle, ExternalLink, Search,
  ArrowUpRight, ArrowDownRight, Minus, TrendingUp,
} from 'lucide-react'

const RELATION_STYLE = {
  supplier:   { label: 'Supplier',   cls: 'text-mint-400 bg-mint-500/10 border-mint-500/25' },
  customer:   { label: 'Customer',   cls: 'text-sky-400 bg-sky-500/10 border-sky-500/25' },
  partner:    { label: 'Partner',    cls: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/25' },
  holder:     { label: 'Holder',     cls: 'text-amber-400 bg-amber-500/10 border-amber-500/25' },
  peer:       { label: 'Peer',       cls: 'text-slate-400 bg-white/[0.04] border-white/10' },
  competitor: { label: 'Competitor', cls: 'text-rose-400 bg-rose-500/10 border-rose-500/25' },
}

function getApiKeyHeaders() {
  try {
    const raw = localStorage.getItem('finsurf_api_keys')
    if (!raw) return {}
    const keys = JSON.parse(raw)
    const h = {}
    if (keys.aisa)    h['x-aisa-key']    = keys.aisa
    if (keys.finnhub) h['x-finnhub-key'] = keys.finnhub
    if (keys.fmp)     h['x-fmp-key']     = keys.fmp
    return h
  } catch { return {} }
}

function authHeaders() {
  const t = localStorage.getItem('finsurf_token')
  return t ? { Authorization: `Bearer ${t}` } : {}
}

/* ── Cards ─────────────────────────────────────────────────────────────── */

function EdgeCard({ edge, onAnalyze }) {
  const style = RELATION_STYLE[edge.relation] ?? RELATION_STYLE.peer
  const scoreColor = edge.score >= 70 ? 'text-mint-400' : edge.score >= 45 ? 'text-amber-400' : 'text-slate-400'

  return (
    <div className="glass rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <button
            onClick={() => onAnalyze?.(edge.symbol)}
            className="text-base font-bold text-white hover:text-mint-400 transition-colors"
          >
            {edge.symbol}
          </button>
          {edge.company && (
            <div className="text-[11px] text-slate-500 truncate max-w-[220px]">{edge.company}</div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${style.cls}`}>
            {style.label}
          </span>
          <span className={`text-sm font-bold ${scoreColor}`}>{edge.score}</span>
        </div>
      </div>

      {edge.materialityPct != null && (
        <div className="flex items-center gap-1.5 text-xs">
          <TrendingUp className="w-3.5 h-3.5 text-mint-400" />
          <span className="text-mint-400 font-semibold">{edge.materialityPct}%</span>
          <span className="text-slate-500">of revenue disclosed as tied to this relationship</span>
        </div>
      )}

      {/* The evidence IS the product. A row without it is just an assertion. */}
      {edge.evidence?.quote && (
        <blockquote className="text-[11px] leading-relaxed text-slate-400 border-l-2 border-white/10 pl-3 italic">
          “{edge.evidence.quote}”
        </blockquote>
      )}

      <div className="flex items-center justify-between text-[10px] text-slate-500 mt-auto pt-1">
        <span>
          {edge.evidence?.form === 'peer_sic'
            ? 'Industry classification'
            : `${edge.evidence?.form ?? '—'} · ${edge.evidence?.filedAt ?? '—'}`}
          {edge.corroboratingFilings > 1 && ` · ${edge.corroboratingFilings} filings`}
        </span>
        {edge.evidence?.url && (
          <a href={edge.evidence.url} target="_blank" rel="noreferrer"
             className="flex items-center gap-1 hover:text-mint-400 transition-colors">
            Filing <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>
    </div>
  )
}

/**
 * Relationship changes since the previous run.
 *
 * `dropped` is the row worth reading: a company that stops naming the anchor
 * in its filing is usually reporting a lost relationship before the revenue
 * line shows it.
 */
function DiffPanel({ anchor, diff }) {
  if (!diff?.changed) return null
  return (
    <div className="glass rounded-xl p-4 border border-amber-500/20 bg-amber-500/[0.03]">
      <div className="text-xs font-bold text-amber-300 mb-2">
        {diff.changed} relationship change{diff.changed === 1 ? '' : 's'} since the last run
      </div>
      <ul className="space-y-1.5">
        {diff.dropped?.map((d, i) => (
          <li key={`d${i}`} className="flex items-start gap-2 text-[11px]">
            <ArrowDownRight className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
            <span className="text-slate-300">
              <b className="text-white">{d.symbol}</b> no longer names {anchor}
              {d.lastMaterialityPct != null && ` (was ${d.lastMaterialityPct}% of revenue)`}
            </span>
          </li>
        ))}
        {diff.added?.map((d, i) => (
          <li key={`a${i}`} className="flex items-start gap-2 text-[11px]">
            <ArrowUpRight className="w-3.5 h-3.5 text-mint-400 shrink-0 mt-0.5" />
            <span className="text-slate-300">
              <b className="text-white">{d.symbol}</b> newly discloses {anchor} as {d.relation}
            </span>
          </li>
        ))}
        {diff.materialityMoved?.map((d, i) => (
          <li key={`m${i}`} className="flex items-start gap-2 text-[11px]">
            <Minus className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
            <span className="text-slate-300">
              <b className="text-white">{d.symbol}</b> exposure {d.from}% → {d.to}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ── View ──────────────────────────────────────────────────────────────── */

export default function ExposureView({ onAnalyze }) {
  const [anchor, setAnchor]   = useState('')
  const [anchors, setAnchors] = useState(null)
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)
  const [filter, setFilter]   = useState('all')

  useEffect(() => {
    fetch('/api/exposure/anchors')
      .then(r => r.json()).then(setAnchors)
      .catch(() => {})
  }, [])

  const load = useCallback(async (key, refresh) => {
    const a = String(key || '').toUpperCase().replace(/[^A-Z0-9.-]/g, '')
    if (!a) return
    setLoading(true); setError(null)
    try {
      const path = refresh ? `/api/exposure/${a}` : `/api/exposure/${a}/graph`
      const r = await fetch(path, { headers: { ...authHeaders(), ...getApiKeyHeaders() } })
      const d = await r.json()
      // The build endpoint is heartbeated, so a failure arrives as 200 with an
      // `error` in the body — res.ok alone is not enough to trust the payload.
      if (!r.ok || d.error) throw new Error(d.error || `Request failed (${r.status})`)
      if (refresh || d.edges?.length) setData(d)
      else setData({ ...d, empty: true })
      setAnchor(a)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const edges = (data?.edges ?? []).filter(e => filter === 'all' || e.relation === filter)
  const counts = (data?.edges ?? []).reduce((acc, e) => {
    acc[e.relation] = (acc[e.relation] || 0) + 1
    return acc
  }, {})

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-mint-500/10 border border-mint-500/20">
            <Network className="w-5 h-5 text-mint-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Exposure Map</h1>
            <p className="text-xs text-slate-500">
              Listed stocks with SEC-disclosed exposure to a company — public or private
            </p>
          </div>
        </div>
        {data && !data.empty && (
          <button
            onClick={() => load(anchor, true)}
            disabled={loading}
            className="btn-secondary flex items-center gap-2 text-xs shrink-0 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Rebuild from filings
          </button>
        )}
      </div>

      {/* Anchor picker */}
      <div className="glass rounded-xl p-4 space-y-3">
        <form
          onSubmit={e => { e.preventDefault(); load(anchor, true) }}
          className="flex gap-2"
        >
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={anchor}
              onChange={e => setAnchor(e.target.value.toUpperCase())}
              placeholder="Ticker (NVDA, TSM, PLTR) or private company (SPACEX, OPENAI)"
              className="w-full bg-white/[0.03] border border-white/10 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-mint-500/40"
            />
          </div>
          <button type="submit" disabled={loading || !anchor} className="btn-primary text-xs px-4 disabled:opacity-50">
            {loading ? 'Mapping…' : 'Map exposure'}
          </button>
        </form>

        {anchors?.private?.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <span className="text-[10px] text-slate-500 self-center mr-1">Private:</span>
            {anchors.private.map(a => (
              <button key={a.key} onClick={() => load(a.key, false)}
                      className="text-[10px] px-2 py-1 rounded-md bg-white/[0.04] border border-white/10 text-slate-300 hover:border-mint-500/30 hover:text-mint-400 transition-colors">
                {a.label}
              </button>
            ))}
          </div>
        )}
        {anchors?.tracked?.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <span className="text-[10px] text-slate-500 self-center mr-1">Mapped:</span>
            {anchors.tracked.slice(0, 10).map(t => (
              <button key={t.anchor} onClick={() => load(t.anchor, false)}
                      className="text-[10px] px-2 py-1 rounded-md bg-mint-500/[0.07] border border-mint-500/20 text-mint-400 hover:border-mint-500/40 transition-colors">
                {t.anchor} ({t.edges})
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="glass rounded-xl p-4 flex items-start gap-3 border border-rose-500/20">
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <div className="text-xs text-slate-300">{error}</div>
        </div>
      )}

      {loading && (
        <div className="glass rounded-xl p-8 text-center text-sm text-slate-400">
          Searching SEC filings and verifying quotes… this takes a few minutes on a fresh anchor.
        </div>
      )}

      {!loading && data?.empty && (
        <div className="glass rounded-xl p-8 text-center text-sm text-slate-400">
          No stored map for <b className="text-white">{data.anchor}</b> yet.
          <button onClick={() => load(data.anchor, true)} className="text-mint-400 hover:underline ml-1">
            Build one from SEC filings
          </button>.
        </div>
      )}

      {!loading && data && !data.empty && (
        <>
          <DiffPanel anchor={data.anchor} diff={data.diff} />

          {data.notes?.length > 0 && (
            <div className="text-[11px] text-slate-500">{data.notes.join(' · ')}</div>
          )}

          <div className="flex flex-wrap gap-1.5">
            {['all', ...Object.keys(counts)].map(f => (
              <button key={f} onClick={() => setFilter(f)}
                      className={`text-[11px] px-2.5 py-1 rounded-md border transition-colors ${
                        filter === f
                          ? 'bg-mint-500/10 border-mint-500/30 text-mint-400'
                          : 'bg-white/[0.03] border-white/10 text-slate-400 hover:text-slate-200'
                      }`}>
                {f === 'all' ? `All (${data.edges.length})` : `${RELATION_STYLE[f]?.label ?? f} (${counts[f]})`}
              </button>
            ))}
          </div>

          {edges.length === 0 ? (
            <div className="glass rounded-xl p-8 text-center text-sm text-slate-500">
              No relationships match this filter.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {edges.map((e, i) => (
                <EdgeCard key={`${e.symbol}-${e.relation}-${i}`} edge={e} onAnalyze={onAnalyze} />
              ))}
            </div>
          )}

          {data.universe?.length > 0 && (
            <div className="glass rounded-xl p-4">
              <div className="text-xs font-semibold text-white mb-1">Tradeable universe</div>
              <p className="text-[11px] text-slate-500 mb-2">
                Competitors excluded — their exposure runs the other way. Analyze any name to
                run the full research stack on it.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {data.universe.map(s => (
                  <button key={s} onClick={() => onAnalyze?.(s)}
                          className="text-[11px] px-2 py-1 rounded-md bg-white/[0.04] border border-white/10 text-slate-200 hover:border-mint-500/30 hover:text-mint-400 transition-colors">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
