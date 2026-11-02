/**
 * Discovery — the after-close lists the AI Brain scans draw from
 * (lib/discovery-sources.js, job discovery-refresh, GET /api/evolution/discovery).
 * Per sector: names lagging what their sector's common factors explain (PCA
 * residual), and the cheap leg of cointegrated pairs whose spread has stretched.
 * Before this tab the lists could only be seen when a scan happened to pick one
 * of their names. Read-only; an admin can rebuild them now.
 */
import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { Card, Note, Stat } from './shared'

const deskLink = sym => `#/research-desk/${encodeURIComponent(sym)}`

export default function DiscoveryTab() {
  const { authFetch, isAuthenticated, user } = useAuth()
  const [state, setState] = useState({ loading: true, error: null, data: null })
  const [running, setRunning] = useState(false)

  const load = useCallback(async () => {
    if (!isAuthenticated) { setState({ loading: false, error: null, data: null }); return }
    setState(s => ({ ...s, loading: true, error: null }))
    try {
      const r = await authFetch('/api/evolution/discovery')
      const d = await r.json()
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`)
      setState({ loading: false, error: null, data: d })
    } catch (e) { setState({ loading: false, error: e.message, data: null }) }
  }, [authFetch, isAuthenticated])
  useEffect(() => { load() }, [load])

  const rebuild = async () => {
    setRunning(true)
    try { await authFetch('/api/evolution/discovery/run', { method: 'POST' }) } catch { /* the reload below shows the state */ }
    setTimeout(() => { setRunning(false); load() }, 4000)
  }

  if (!isAuthenticated) return <Note>Sign in to see the discovery lists — they are built from market data for signed-in users.</Note>
  if (state.loading) return <Card><p className="text-xs text-slate-400">Loading the discovery lists…</p></Card>
  if (state.error) return <Note tone="warn">Could not load the discovery lists: {state.error}</Note>

  const { store, zMin, poolCap, ageHours, usedByScans } = state.data
  const allSectors = Object.entries(store?.sectors || {})
  // A sector where no name had a year of bars has nothing to show; name them once instead of a card each.
  const sectors = allSectors.filter(([, v]) => v.names > 0)
  const unchecked = allSectors.filter(([, v]) => !(v.names > 0)).map(([name]) => name)
  const lagging = sectors.reduce((a, [, v]) => a + (v.dislocations?.length || 0), 0)
  const pairs = sectors.reduce((a, [, v]) => a + (v.pairs?.length || 0), 0)

  return (
    <div className="space-y-4">
      <Card title="Discovery — names the scans look at because of how they moved against their peers">
        <p className="text-xs text-slate-400 mb-3">
          After each close, the {poolCap} most-traded names in every sector are checked two ways. <b>Lagging peers</b>: the last five sessions fell at least {zMin}σ
          below what the sector's own common factors explain (PCA residual). <b>Stretched pair</b>: two names that tracked each other (cointegrated in a formation
          window, and the spread rule made money afterwards out of sample) have drifted at least {zMin}σ apart — the cheaper one is listed. Long side only.
          Up to four of these join each AI Brain sector scan, labelled with the reason, and face every check a mover does.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat label="Built" value={store?.at ? String(store.at).slice(0, 10) : 'not yet'} sub={ageHours != null ? `${ageHours} h ago` : 'weekdays 5:40 PM ET'} />
          <Stat label="Used by scans" value={store ? (usedByScans ? 'yes' : 'no — stale') : '—'} sub="lists older than 4 days are ignored" />
          <Stat label="Lagging peers" value={lagging} />
          <Stat label="Stretched pairs" value={pairs} />
        </div>
        {user?.role === 'admin' && (
          <button type="button" onClick={rebuild} disabled={running}
            className="mt-3 inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-slate-500/25 text-slate-300 hover:text-white disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${running ? 'animate-spin' : ''}`} /> {running ? 'Rebuilding — takes a few minutes' : 'Rebuild now (admin)'}
          </button>
        )}
      </Card>

      {unchecked.length > 0 && (
        <Note tone="warn">No names could be checked in: {unchecked.join(', ')} — the sector list or its price history was unavailable when the lists were built.</Note>
      )}

      {!store && <Note>No lists yet. The job runs on weekdays at 5:40 PM ET after the close{user?.role === 'admin' ? ', or rebuild now above' : ''}.</Note>}

      {sectors.map(([sector, v]) => (
        <Card key={sector} title={sector}>
          <div className="text-[11px] text-slate-500 mb-2">
            {v.names} names checked · {v.pairsTested} pairs tested, {v.pairsCointegrated} cointegrated, about {v.expectedFalsePositives} would pass by chance alone
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <div className="text-xs font-semibold text-slate-300 mb-1">Lagging their peers</div>
              {v.dislocations?.length ? (
                <ul className="space-y-1 text-xs">
                  {v.dislocations.map(d => (
                    <li key={d.symbol} className="flex justify-between gap-2">
                      <a href={deskLink(d.symbol)} className="font-mono font-semibold text-mint-400 hover:underline">{d.symbol}</a>
                      <span className="text-slate-400 tabular-nums">{d.residualZ}σ vs peers · factors explain {Math.round((d.factorR2 ?? 0) * 100)}%</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-xs text-slate-500">None past {zMin}σ.</p>}
            </div>
            <div>
              <div className="text-xs font-semibold text-slate-300 mb-1">Cheap leg of a stretched pair</div>
              {v.pairs?.length ? (
                <ul className="space-y-1 text-xs">
                  {v.pairs.map(p => (
                    <li key={`${p.cheap}-${p.rich}`} className="flex justify-between gap-2">
                      <span><a href={deskLink(p.cheap)} className="font-mono font-semibold text-mint-400 hover:underline">{p.cheap}</a> <span className="text-slate-500">vs {p.rich}</span></span>
                      <span className="text-slate-400 tabular-nums">{p.z}σ · half-life {p.halfLifeDays ?? '—'} d · OOS Sharpe {p.oosSharpe}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-xs text-slate-500">None past {zMin}σ.</p>}
            </div>
          </div>
          {v.richVsPeers?.length > 0 && (
            <p className="text-[11px] text-slate-500 mt-2">Ahead of peers (context only, never scanned — the app does not short): {v.richVsPeers.map(r => `${r.symbol} +${r.residualZ}σ`).join(', ')}</p>
          )}
        </Card>
      ))}

      <Note>Candidates, not signals: a name here is only somewhere the scan looks. Click a symbol to open its Research Desk dossier.</Note>
    </div>
  )
}
