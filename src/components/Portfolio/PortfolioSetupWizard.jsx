/**
 * PortfolioSetupWizard — shown after first login when the user has no portfolios.
 * Steps:
 *   1. Create first portfolio (name, type, custodian)
 *   2. Add holdings (manual entry OR CSV upload)
 *   3. Done / go to dashboard
 */
import { useState, useRef } from 'react'
import {
  Plus, Upload, Trash2, Loader2, CheckCircle, ArrowRight,
  ChevronLeft, FileText, AlertTriangle,
} from 'lucide-react'
import { usePortfolioContext, PORTFOLIO_TYPE_LABELS, PORTFOLIO_TYPE_ICONS } from '../../contexts/PortfolioContext'
import { useAuth } from '../../contexts/AuthContext'

// Popular account types to feature prominently
const FEATURED_TYPES = ['brokerage', 'roth_ira', 'traditional_ira', '401k', 'crypto', 'other']

// CSV template download
const CSV_TEMPLATE = `Symbol,Shares,AvgCost,Sector
AAPL,10,150.00,Technology
MSFT,5,290.00,Technology
SPY,20,440.00,Index`

function downloadCSV(content, filename) {
  const blob = new URL(URL.createObjectURL(new Blob([content], { type: 'text/csv' })))
  const a    = document.createElement('a')
  a.href  = blob.href
  a.download = filename
  a.click()
  URL.revokeObjectURL(blob.href)
}

// ── Step 1: Portfolio details ────────────────────────────────────────────────
function StepCreatePortfolio({ onNext }) {
  const { createPortfolio } = usePortfolioContext()
  const [name,      setName]      = useState('')
  const [type,      setType]      = useState('brokerage')
  const [custodian, setCustodian] = useState('')
  const [cash,      setCash]      = useState('')
  const [error,     setError]     = useState('')
  const [loading,   setLoading]   = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (!name.trim()) return setError('Portfolio name is required')
    setLoading(true)
    setError('')
    try {
      const portfolio = await createPortfolio({
        name: name.trim(), type, custodian: custodian.trim(),
        cashBalance: parseFloat(cash) || 0,
        color: '#00ffcc', taxStatus: 'taxable',
      })
      onNext(portfolio)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <h2 className="text-lg font-bold text-white mb-1">Create your first portfolio</h2>
        <p className="text-sm text-slate-500">Give it a name and choose the account type.</p>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
          <AlertTriangle size={13} />
          {error}
        </div>
      )}

      {/* Name */}
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1.5">Portfolio Name *</label>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Main Brokerage, My Roth IRA"
          maxLength={100}
          className="w-full px-3 py-2.5 rounded-lg bg-white/[0.04] border border-white/[0.08]
                     text-sm text-white placeholder-slate-600 focus:outline-none
                     focus:border-[#00ffcc]/40 focus:ring-1 focus:ring-[#00ffcc]/15 transition-all"
        />
      </div>

      {/* Account type */}
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-2">Account Type</label>
        <div className="grid grid-cols-3 gap-2">
          {FEATURED_TYPES.map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={`flex flex-col items-center gap-1 px-2 py-3 rounded-xl border text-center transition-all
                ${type === t
                  ? 'border-[#00ffcc]/50 bg-[#00ffcc]/10 text-[#00ffcc]'
                  : 'border-white/[0.06] bg-white/[0.02] text-slate-400 hover:border-white/20'
                }`}
            >
              <span className="text-xl">{PORTFOLIO_TYPE_ICONS[t]}</span>
              <span className="text-[10px] leading-tight">{PORTFOLIO_TYPE_LABELS[t]}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Custodian */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5">Broker (optional)</label>
          <input
            value={custodian}
            onChange={e => setCustodian(e.target.value)}
            placeholder="Fidelity, Schwab…"
            className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08]
                       text-sm text-white placeholder-slate-600 focus:outline-none
                       focus:border-[#00ffcc]/40 transition-all"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5">Cash Balance ($)</label>
          <input
            type="number"
            value={cash}
            onChange={e => setCash(e.target.value)}
            placeholder="0.00"
            min={0}
            step="0.01"
            className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08]
                       text-sm text-white placeholder-slate-600 focus:outline-none
                       focus:border-[#00ffcc]/40 transition-all"
          />
        </div>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="w-full flex items-center justify-center gap-2 py-3 rounded-xl
                   font-semibold text-[#0a0e1a] bg-[#00ffcc] hover:bg-[#00e6b8]
                   disabled:opacity-40 transition-all"
      >
        {loading && <Loader2 size={15} className="animate-spin" />}
        Continue
        <ArrowRight size={16} />
      </button>
    </form>
  )
}

// ── Step 2: Add holdings ─────────────────────────────────────────────────────
function StepAddHoldings({ portfolio, onNext, onSkip }) {
  const { authFetch } = useAuth()
  const fileRef = useRef(null)

  const [rows,    setRows]    = useState([{ symbol: '', shares: '', avgCost: '' }])
  const [csvErr,  setCsvErr]  = useState('')
  const [loading, setLoading] = useState(false)
  const [mode,    setMode]    = useState('manual') // 'manual' | 'csv'

  const addRow    = () => setRows(r => [...r, { symbol: '', shares: '', avgCost: '' }])
  const removeRow = (i) => setRows(r => r.filter((_, j) => j !== i))
  const setCell   = (i, k, v) => setRows(r => r.map((row, j) => j === i ? { ...row, [k]: v } : row))

  const parseCSV = (text) => {
    const lines = text.trim().split('\n').filter(Boolean)
    const header = lines[0].toLowerCase()
    // Detect columns
    const cols = header.split(',').map(c => c.trim().replace(/"/g, ''))
    const si = cols.findIndex(c => c.includes('symbol') || c.includes('ticker'))
    const qi = cols.findIndex(c => c.includes('share') || c.includes('qty') || c.includes('quantity'))
    const pi = cols.findIndex(c => c.includes('cost') || c.includes('price') || c.includes('avg'))
    const ni = cols.findIndex(c => c.includes('name'))

    if (si < 0) return null

    return lines.slice(1).map(line => {
      const cells = line.split(',').map(c => c.trim().replace(/"/g, ''))
      return {
        symbol:  (cells[si] || '').toUpperCase(),
        shares:  parseFloat(cells[qi] || '0') || 0,
        avgCost: parseFloat(cells[pi] || '0') || 0,
        name:    ni >= 0 ? cells[ni] : null,
      }
    }).filter(r => r.symbol && r.shares > 0)
  }

  const handleFile = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setCsvErr('')
    const reader = new FileReader()
    reader.onload = (ev) => {
      const parsed = parseCSV(ev.target.result)
      if (!parsed || !parsed.length) {
        setCsvErr('Could not parse CSV. Make sure it has Symbol, Shares, and AvgCost columns.')
        return
      }
      setRows(parsed.map(r => ({ symbol: r.symbol, shares: String(r.shares), avgCost: String(r.avgCost) })))
      setMode('manual') // switch to manual so user can review
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const save = async () => {
    const valid = rows.filter(r => r.symbol.trim() && parseFloat(r.shares) > 0)
    if (!valid.length) return onSkip()

    setLoading(true)
    try {
      // Bulk upsert one by one
      for (const row of valid) {
        await authFetch(`/api/portfolios/${portfolio.id}/holdings`, {
          method: 'POST',
          body: {
            symbol: row.symbol.toUpperCase().trim(),
            shares: parseFloat(row.shares),
            avgCost: parseFloat(row.avgCost) || 0,
          },
        })
      }
      onNext()
    } catch (err) {
      setCsvErr(err.message || 'Failed to save holdings')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-bold text-white mb-1">Add your holdings</h2>
        <p className="text-sm text-slate-500">
          Enter your positions manually or upload a CSV file.
        </p>
      </div>

      {/* Mode toggle */}
      <div className="flex gap-2">
        <button
          onClick={() => setMode('manual')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all
            ${mode === 'manual' ? 'bg-[#00ffcc]/15 text-[#00ffcc] border border-[#00ffcc]/25' : 'text-slate-500 hover:text-slate-300 border border-transparent'}`}
        >
          <Plus size={12} /> Manual Entry
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-500
                     hover:text-slate-300 border border-transparent transition-all"
        >
          <Upload size={12} /> Upload CSV
        </button>
        <input ref={fileRef} type="file" accept=".csv,.txt" className="hidden" onChange={handleFile} />
        <button
          onClick={() => {
            const blob = new Blob([CSV_TEMPLATE], { type: 'text/csv' })
            const a = document.createElement('a')
            a.href = URL.createObjectURL(blob)
            a.download = 'finsurf-template.csv'
            a.click()
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600
                     hover:text-slate-400 transition-all ml-auto"
        >
          <FileText size={12} /> CSV Template
        </button>
      </div>

      {csvErr && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
          <AlertTriangle size={13} />
          {csvErr}
        </div>
      )}

      {/* Holdings table */}
      <div className="space-y-2">
        {/* Header */}
        <div className="grid grid-cols-[1fr_100px_100px_32px] gap-2 px-1">
          <span className="text-[10px] text-slate-600 uppercase">Symbol</span>
          <span className="text-[10px] text-slate-600 uppercase">Shares</span>
          <span className="text-[10px] text-slate-600 uppercase">Avg Cost</span>
          <span />
        </div>

        {rows.map((row, i) => (
          <div key={i} className="grid grid-cols-[1fr_100px_100px_32px] gap-2 items-center">
            <input
              value={row.symbol}
              onChange={e => setCell(i, 'symbol', e.target.value.toUpperCase())}
              placeholder="AAPL"
              maxLength={10}
              className="px-2.5 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08]
                         text-sm text-white font-mono placeholder-slate-600 uppercase
                         focus:outline-none focus:border-[#00ffcc]/40 transition-all"
            />
            <input
              type="number"
              value={row.shares}
              onChange={e => setCell(i, 'shares', e.target.value)}
              placeholder="0"
              min={0}
              className="px-2.5 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08]
                         text-sm text-white placeholder-slate-600
                         focus:outline-none focus:border-[#00ffcc]/40 transition-all"
            />
            <input
              type="number"
              value={row.avgCost}
              onChange={e => setCell(i, 'avgCost', e.target.value)}
              placeholder="0.00"
              min={0}
              step="0.01"
              className="px-2.5 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08]
                         text-sm text-white placeholder-slate-600
                         focus:outline-none focus:border-[#00ffcc]/40 transition-all"
            />
            <button
              type="button"
              onClick={() => removeRow(i)}
              disabled={rows.length === 1}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-600
                         hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-30"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}

        <button
          type="button"
          onClick={addRow}
          className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-[#00ffcc] transition-colors"
        >
          <Plus size={13} /> Add row
        </button>
      </div>

      <div className="flex gap-3 pt-2">
        <button
          onClick={onSkip}
          className="flex-1 py-2.5 rounded-xl text-sm text-slate-500 hover:text-slate-300
                     hover:bg-white/5 transition-colors"
        >
          Skip for now
        </button>
        <button
          onClick={save}
          disabled={loading}
          className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl
                     font-semibold text-sm text-[#0a0e1a] bg-[#00ffcc] hover:bg-[#00e6b8]
                     disabled:opacity-40 transition-all"
        >
          {loading && <Loader2 size={15} className="animate-spin" />}
          Save Holdings
          <ArrowRight size={15} />
        </button>
      </div>
    </div>
  )
}

// ── Step 3: Done ─────────────────────────────────────────────────────────────
function StepDone({ portfolioName, onFinish }) {
  return (
    <div className="text-center space-y-6 py-4">
      <div className="w-16 h-16 rounded-2xl bg-[#00ffcc]/10 flex items-center justify-center mx-auto">
        <CheckCircle size={32} className="text-[#00ffcc]" />
      </div>
      <div>
        <h2 className="text-lg font-bold text-white">You're all set!</h2>
        <p className="text-sm text-slate-500 mt-2">
          <span className="text-slate-300">{portfolioName}</span> is ready.
          Head to the Dashboard to see your portfolio in action.
        </p>
      </div>
      <button
        onClick={onFinish}
        className="w-full py-3 rounded-xl font-semibold text-[#0a0e1a] bg-[#00ffcc]
                   hover:bg-[#00e6b8] transition-all flex items-center justify-center gap-2"
      >
        Go to Dashboard
        <ArrowRight size={16} />
      </button>
    </div>
  )
}

// ── Wizard shell ─────────────────────────────────────────────────────────────
export default function PortfolioSetupWizard({ onComplete }) {
  const [step,      setStep]      = useState(1) // 1 | 2 | 3
  const [portfolio, setPortfolio] = useState(null)

  const steps = [
    { n: 1, label: 'Create Portfolio' },
    { n: 2, label: 'Add Holdings'     },
    { n: 3, label: 'Done'             },
  ]

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10"
      style={{ background: 'linear-gradient(135deg, #060810 0%, #0a0e1a 100%)' }}>

      <div className="w-full max-w-lg space-y-6">
        {/* Progress */}
        <div className="flex items-center gap-2 justify-center">
          {steps.map(({ n, label }) => (
            <div key={n} className="flex items-center gap-2">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all
                ${step >= n ? 'bg-[#00ffcc] text-[#0a0e1a]' : 'bg-white/[0.06] text-slate-500'}`}>
                {step > n ? <CheckCircle size={14} /> : n}
              </div>
              <span className={`text-xs transition-colors ${step >= n ? 'text-slate-300' : 'text-slate-600'}`}>
                {label}
              </span>
              {n < steps.length && (
                <div className={`w-8 h-px mx-1 transition-all ${step > n ? 'bg-[#00ffcc]/60' : 'bg-white/[0.08]'}`} />
              )}
            </div>
          ))}
        </div>

        {/* Card */}
        <div className="rounded-2xl p-6 sm:p-8 border border-white/[0.08] shadow-2xl"
          style={{ background: 'rgba(255,255,255,0.03)', backdropFilter: 'blur(12px)' }}>

          {step === 1 && (
            <StepCreatePortfolio
              onNext={(p) => { setPortfolio(p); setStep(2) }}
            />
          )}
          {step === 2 && (
            <StepAddHoldings
              portfolio={portfolio}
              onNext={() => setStep(3)}
              onSkip={() => setStep(3)}
            />
          )}
          {step === 3 && (
            <StepDone
              portfolioName={portfolio?.name || 'Your Portfolio'}
              onFinish={onComplete}
            />
          )}
        </div>

        {step < 3 && (
          <p className="text-center text-xs text-slate-700">
            You can add more portfolios and holdings later in the Portfolio Manager
          </p>
        )}
      </div>
    </div>
  )
}
