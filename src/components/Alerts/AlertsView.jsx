import { useState } from 'react'
import { Bell, BellOff, Plus, X, Target, TrendingUp, TrendingDown, AlertTriangle, CheckCircle } from 'lucide-react'
import { WATCHLIST_ALERTS } from '../../data/portfolio'
import { fmt, fmtPct } from '../../services/api'

/* ── helpers ────────────────────────────────────── */
function priceStatus(price, zone) {
  if (!price || !zone) return null
  if (price <= zone.high) return 'in-zone'
  const pctAbove = ((price - zone.high) / zone.high) * 100
  return pctAbove
}

function EntryZoneBar({ price, zone }) {
  if (!price || !zone) return null
  const inZone = price >= zone.low && price <= zone.high
  const pctAbove = price > zone.high ? (((price - zone.high) / zone.high) * 100).toFixed(1) : null
  const pctBelow = price < zone.low  ? (((zone.low - price) / price) * 100).toFixed(1) : null
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-slate-400">Entry Zone</span>
        <span className={`font-mono font-semibold ${inZone ? 'text-emerald-400' : pctAbove ? 'text-red-400' : 'text-amber-400'}`}>
          {inZone ? '✓ In zone' : pctAbove ? `${pctAbove}% above zone` : `${pctBelow}% to zone`}
        </span>
      </div>
      <div className="relative h-2 bg-white/[0.06] rounded-full overflow-hidden">
        {/* zone band */}
        <div className="absolute h-full bg-emerald-500/30" style={{ left: '20%', width: '30%' }} />
        {/* price cursor */}
        <div
          className={`absolute w-1 h-full rounded-full transition-all ${inZone ? 'bg-emerald-400' : price > zone.high ? 'bg-red-400' : 'bg-amber-400'}`}
          style={{ left: `${Math.min(95, Math.max(5, inZone ? 35 : price > zone.high ? 70 : 12))}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-slate-600 mt-0.5">
        <span>${fmt(zone.low)}</span>
        <span className="text-slate-500">Zone</span>
        <span>${fmt(zone.high)}</span>
      </div>
    </div>
  )
}

/* ── CFP Buy-Zone Card ────────────────────────────────── */
function BuyZoneCard({ card, price, onAddAlert }) {
  const { symbol, name, thesis, holdingPeriod, currentNote, entryZone, targets, trailingStop } = card
  const inZone = price != null && price >= entryZone.low && price <= entryZone.high
  const pctFromZone = price != null && price > entryZone.high
    ? (((price - entryZone.high) / entryZone.high) * 100).toFixed(1)
    : null

  return (
    <div className={`glass rounded-xl p-5 space-y-4 border ${inZone ? 'border-emerald-500/30' : 'border-white/[0.06]'}`}>
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono font-bold text-white text-lg">{symbol}</span>
            {inZone && (
              <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-400 text-xs font-semibold rounded-full border border-emerald-500/30 animate-pulse">
                IN BUY ZONE
              </span>
            )}
          </div>
          <div className="text-xs text-slate-400 mt-0.5">{name}</div>
        </div>
        {price && (
          <div className="text-right">
            <div className="font-mono font-bold text-white">${fmt(price)}</div>
            {pctFromZone && (
              <div className="text-xs text-red-400 font-mono">+{pctFromZone}% above zone</div>
            )}
          </div>
        )}
      </div>

      {/* Thesis */}
      <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-lg p-3 text-xs text-indigo-300">
        <span className="font-semibold text-indigo-400">Thesis: </span>{thesis}
      </div>

      {/* CFP warning */}
      <div className="flex gap-2 items-start bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
        <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
        <p className="text-xs text-amber-300">{currentNote}</p>
      </div>

      {/* Entry zone */}
      <div>
        <div className="text-xs font-semibold text-slate-300 mb-2">Ideal Entry Zone</div>
        <div className="flex items-center justify-between">
          <div>
            <span className="font-mono font-bold text-emerald-400 text-base">${fmt(entryZone.low)} – ${fmt(entryZone.high)}</span>
            <p className="text-xs text-slate-500 mt-0.5">{entryZone.note}</p>
          </div>
          <div className="text-right text-xs text-slate-400">Hold {holdingPeriod}</div>
        </div>
        <EntryZoneBar price={price} zone={entryZone} />
      </div>

      {/* Profit targets */}
      <div>
        <div className="text-xs font-semibold text-slate-300 mb-2">Exit Plan</div>
        <div className="space-y-1.5">
          {targets.map((t, i) => (
            <div key={i} className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full ${i === targets.length - 1 ? 'bg-purple-400' : 'bg-mint-400'}`} />
                <span className="text-slate-300 font-semibold">{t.action}</span>
                {t.price && <span className="font-mono text-white">${t.price}</span>}
                {t.pct && <span className="text-emerald-400">{t.pct}</span>}
              </div>
              <span className="text-slate-500">{t.note}</span>
            </div>
          ))}
          <div className="flex items-center gap-2 text-xs text-amber-400 mt-1">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            Trailing stop: {trailingStop}% on remainder
          </div>
        </div>
      </div>

      {/* Quick alert buttons */}
      <div className="flex gap-2 pt-1 border-t border-white/[0.04]">
        {card.alerts.map((a, i) => (
          <button
            key={i}
            onClick={() => onAddAlert({ symbol, type: a.type, threshold: a.threshold, label: a.label })}
            className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium
              bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] hover:border-mint-500/30
              text-slate-300 hover:text-mint-400 transition-all"
          >
            <Bell className="w-3 h-3" />
            Alert {a.type === 'below' ? '↓' : '↑'} ${fmt(a.threshold)}
          </button>
        ))}
      </div>
    </div>
  )
}

/* ── Add Alert Form ────────────────────────────── */
function AddAlertForm({ symbols, onAdd, onClose }) {
  const [sym, setSym]   = useState(symbols[0] || '')
  const [type, setType] = useState('below')
  const [price, setPrice] = useState('')
  const [label, setLabel] = useState('')

  const submit = (e) => {
    e.preventDefault()
    if (!sym || !price) return
    onAdd({ symbol: sym.toUpperCase(), type, threshold: parseFloat(price), label: label || `${sym} ${type} $${price}` })
    onClose()
  }

  return (
    <div className="glass rounded-xl p-5 border border-mint-500/20 animate-slide-up">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-white flex items-center gap-2"><Bell className="w-4 h-4 text-mint-400" /> New Price Alert</h3>
        <button onClick={onClose} className="text-slate-500 hover:text-white"><X className="w-4 h-4" /></button>
      </div>
      <form onSubmit={submit} className="grid grid-cols-2 gap-3">
        <div className="col-span-2 sm:col-span-1">
          <label className="text-xs text-slate-400 mb-1 block">Symbol</label>
          <input
            value={sym} onChange={e => setSym(e.target.value.toUpperCase())}
            placeholder="e.g. AAPL"
            className="input w-full font-mono"
            list="sym-list"
          />
          <datalist id="sym-list">{symbols.map(s => <option key={s} value={s} />)}</datalist>
        </div>
        <div>
          <label className="text-xs text-slate-400 mb-1 block">Trigger</label>
          <select value={type} onChange={e => setType(e.target.value)} className="input w-full">
            <option value="below">Price drops below ↓</option>
            <option value="above">Price rises above ↑</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-slate-400 mb-1 block">Price ($)</label>
          <input
            type="number" step="0.01" min="0"
            value={price} onChange={e => setPrice(e.target.value)}
            placeholder="0.00"
            className="input w-full font-mono"
            required
          />
        </div>
        <div className="col-span-2">
          <label className="text-xs text-slate-400 mb-1 block">Label (optional)</label>
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Entry zone" className="input w-full" />
        </div>
        <div className="col-span-2">
          <button type="submit" className="btn-primary w-full flex items-center justify-center gap-2">
            <Bell className="w-3.5 h-3.5" /> Set Alert
          </button>
        </div>
      </form>
    </div>
  )
}

/* ── Main AlertsView ────────────────────────────── */
export default function AlertsView({ alerts: alertsHook, quotesMap, portfolioSymbols, watchlistSymbols }) {
  const { alerts, triggered, addAlert, removeAlert, toggleAlert, dismissTriggered, clearAllTriggered } = alertsHook
  const [showForm, setShowForm] = useState(false)
  const allSymbols = [...new Set([...portfolioSymbols, ...watchlistSymbols, ...WATCHLIST_ALERTS.map(c => c.symbol)])]

  return (
    <div className="space-y-6 animate-fade-in">

      {/* Triggered alerts banner */}
      {triggered.length > 0 && (
        <div className="glass rounded-xl p-4 border border-amber-500/30 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-amber-400 font-semibold text-sm">
              <Bell className="w-4 h-4 animate-pulse" />
              {triggered.length} Alert{triggered.length > 1 ? 's' : ''} Triggered
            </div>
            <button onClick={clearAllTriggered} className="text-xs text-slate-500 hover:text-white">Clear all</button>
          </div>
          {triggered.map(t => (
            <div key={t.id + '-' + t.price} className="flex items-center justify-between glass rounded-lg px-3 py-2">
              <div className="flex items-center gap-3">
                <span className={`w-2 h-2 rounded-full ${t.type === 'above' ? 'bg-emerald-400' : 'bg-red-400'}`} />
                <span className="font-mono font-bold text-white text-sm">{t.symbol}</span>
                <span className="text-xs text-slate-300">
                  {t.type === 'above' ? '↑ rose above' : '↓ dropped below'} ${fmt(t.threshold)}
                </span>
                <span className="text-xs text-slate-500">Now: ${fmt(t.price)}</span>
                {t.label && <span className="text-xs text-mint-400">{t.label}</span>}
              </div>
              <button onClick={() => dismissTriggered(t.id)} className="text-slate-500 hover:text-white ml-2">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Active alerts */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-white flex items-center gap-2">
            <Bell className="w-4 h-4 text-mint-400" /> Price Alerts
            {alerts.length > 0 && <span className="text-xs text-slate-500">({alerts.filter(a => a.active).length} active)</span>}
          </h2>
          <button onClick={() => setShowForm(v => !v)} className="btn-primary flex items-center gap-1.5 text-xs">
            <Plus className="w-3.5 h-3.5" /> Add Alert
          </button>
        </div>

        {showForm && (
          <div className="mb-4">
            <AddAlertForm symbols={allSymbols} onAdd={addAlert} onClose={() => setShowForm(false)} />
          </div>
        )}

        {alerts.length === 0 ? (
          <div className="glass rounded-xl p-8 text-center text-slate-500 text-sm">
            <Bell className="w-8 h-8 mx-auto mb-2 opacity-30" />
            No alerts set. Add one above or use the quick-add buttons on the buy-zone cards below.
          </div>
        ) : (
          <div className="glass rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.06] text-xs">
                  <th className="text-left px-4 py-3 text-slate-400 font-medium">Symbol</th>
                  <th className="text-left px-4 py-3 text-slate-400 font-medium">Condition</th>
                  <th className="text-right px-4 py-3 text-slate-400 font-medium">Target</th>
                  <th className="text-right px-4 py-3 text-slate-400 font-medium hidden sm:table-cell">Current</th>
                  <th className="text-left px-4 py-3 text-slate-400 font-medium hidden md:table-cell">Label</th>
                  <th className="text-center px-4 py-3 text-slate-400 font-medium">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {alerts.map(a => {
                  const price = quotesMap[a.symbol]?.price ?? null
                  const hit = price != null && (a.type === 'above' ? price >= a.threshold : price <= a.threshold)
                  const pctAway = price != null
                    ? (((a.threshold - price) / price) * 100)
                    : null
                  return (
                    <tr key={a.id} className={`border-b border-white/[0.04] transition-colors group ${hit ? 'bg-amber-500/5' : 'hover:bg-white/[0.02]'}`}>
                      <td className="px-4 py-3 font-mono font-bold text-white">{a.symbol}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border
                          ${a.type === 'above'
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                            : 'bg-red-500/10 text-red-400 border-red-500/20'
                          }`}>
                          {a.type === 'above' ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                          {a.type === 'above' ? 'Above' : 'Below'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono font-semibold text-white">${fmt(a.threshold)}</td>
                      <td className="px-4 py-3 text-right font-mono text-slate-300 hidden sm:table-cell">
                        {price != null ? (
                          <div>
                            <div>${fmt(price)}</div>
                            {pctAway != null && (
                              <div className={`text-xs ${Math.abs(pctAway) < 3 ? 'text-amber-400' : 'text-slate-500'}`}>
                                {pctAway > 0 ? '+' : ''}{pctAway.toFixed(1)}% away
                              </div>
                            )}
                          </div>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-400 hidden md:table-cell max-w-[180px] truncate">
                        {a.label || '—'}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {hit ? (
                          <span className="inline-flex items-center gap-1 text-xs text-amber-400 font-semibold">
                            <CheckCircle className="w-3.5 h-3.5" /> HIT
                          </span>
                        ) : a.active ? (
                          <button onClick={() => toggleAlert(a.id)} className="text-xs text-emerald-400 hover:text-slate-400 transition-colors">Active</button>
                        ) : (
                          <button onClick={() => toggleAlert(a.id)} className="text-xs text-slate-600 hover:text-emerald-400 transition-colors flex items-center gap-1 mx-auto">
                            <BellOff className="w-3 h-3" /> Paused
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <button onClick={() => removeAlert(a.id)} className="opacity-0 group-hover:opacity-100 p-1 text-slate-500 hover:text-red-400 transition-all">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* CFP Buy-Zone Analysis */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Target className="w-4 h-4 text-mint-400" />
          <h2 className="text-base font-semibold text-white">Watchlist Buy-Zone Analysis</h2>
          <span className="text-xs text-slate-500">CFP-style entry / exit framework</span>
        </div>
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {WATCHLIST_ALERTS.map(card => (
            <BuyZoneCard
              key={card.symbol}
              card={card}
              price={quotesMap[card.symbol]?.price ?? null}
              onAddAlert={addAlert}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
