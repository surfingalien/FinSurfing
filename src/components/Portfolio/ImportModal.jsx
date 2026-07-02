import { useState, useRef, useCallback } from 'react'
import { Upload, FileText, CheckCircle, AlertCircle, X } from 'lucide-react'
import { Dialog, DialogHeader, DialogBody } from '../shared/Dialog'
import * as portfolioPnl from '../../../lib/portfolio-pnl.js'

// Column aliases — matched case-insensitively
const SYMBOL_KEYS  = ['symbol', 'ticker', 'stock', 'security', 'sym']
const SHARES_KEYS  = ['shares', 'quantity', 'qty', 'units', 'amount', 'position']
const COST_KEYS    = ['avgcost', 'avg_cost', 'averagecost', 'average_cost', 'costbasis',
                      'cost_basis', 'avgprice', 'avg_price', 'averageprice', 'price',
                      'cost', 'buyprice', 'purchase_price', 'purchaseprice']
const NAME_KEYS    = ['name', 'company', 'description', 'security_name', 'securityname']
const SECTOR_KEYS  = ['sector', 'industry', 'category']

function findCol(headers, aliases) {
  const lc = headers.map(h => h.toLowerCase().replace(/[\s\-_]/g, ''))
  for (const alias of aliases) {
    const idx = lc.indexOf(alias.replace(/[\s\-_]/g, ''))
    if (idx >= 0) return idx
  }
  return -1
}

// Minimal RFC4180 CSV parser — handles quoted fields, embedded commas/quotes,
// CRLF/LF. No dependency needed for a format this simple.
function parseCsv(text) {
  const rows = []
  let row = [], field = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else field += c
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field); field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      rows.push(row); row = []
    } else {
      field += c
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows.filter(r => r.length > 1 || r[0] !== '')
}

// Flatten an exceljs cell value (string | number | Date | formula | rich text) to a string.
function cellToString(v) {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('')
    if ('result' in v) return v.result == null ? '' : String(v.result)
    if ('text' in v) return v.text
  }
  return v
}

async function parseXlsx(file) {
  const ExcelJS = (await import('exceljs')).default
  const buf = await file.arrayBuffer()
  const wb  = new ExcelJS.Workbook()
  await wb.xlsx.load(buf)
  const ws = wb.worksheets[0]
  if (!ws) throw new Error('No worksheet found in file')
  const rows = []
  ws.eachRow({ includeEmpty: false }, sheetRow => {
    rows.push(sheetRow.values.slice(1).map(cellToString))
  })
  return rows
}

async function parseFile(file) {
  const ext = file.name.split('.').pop().toLowerCase()
  const rows = ext === 'csv'
    ? parseCsv(await file.text())
    : await parseXlsx(file)
  if (rows.length < 2) throw new Error('File is empty or has no data rows')

  const headers = rows[0].map(h => String(h).trim())
  const symIdx    = findCol(headers, SYMBOL_KEYS)
  const sharesIdx = findCol(headers, SHARES_KEYS)
  const costIdx   = findCol(headers, COST_KEYS)
  const nameIdx   = findCol(headers, NAME_KEYS)
  const sectorIdx = findCol(headers, SECTOR_KEYS)

  if (symIdx < 0)    throw new Error('Could not find a Symbol/Ticker column')
  if (sharesIdx < 0) throw new Error('Could not find a Shares/Quantity column')
  if (costIdx < 0)   throw new Error('Could not find a Cost/Price column (tried: avgCost, price, cost…)')

  const holdings = []
  for (const row of rows.slice(1)) {
    const sym    = String(row[symIdx] ?? '').trim().toUpperCase()
    const shares = parseFloat(String(row[sharesIdx] ?? '').replace(/[,$]/g, ''))
    const cost   = parseFloat(String(row[costIdx]   ?? '').replace(/[,$]/g, ''))
    if (!sym || isNaN(shares) || shares <= 0 || isNaN(cost) || cost < 0) continue
    holdings.push({
      symbol:  sym,
      name:    nameIdx >= 0 ? String(row[nameIdx] ?? sym).trim() || sym : sym,
      shares,
      avgCost: cost,
      sector:  sectorIdx >= 0 ? String(row[sectorIdx] ?? '').trim() || null : null,
    })
  }
  if (!holdings.length) throw new Error('No valid rows found — check Symbol, Shares, and Cost columns')
  return { holdings, headers, symIdx, sharesIdx, costIdx, nameIdx, sectorIdx }
}

export default function ImportModal({ portfolioId, authFetch, onImported, onClose }) {
  const inputRef  = useRef()
  const [step,    setStep]    = useState('upload')   // upload | preview | done
  const [parsed,  setParsed]  = useState(null)
  const [error,   setError]   = useState(null)
  const [loading, setLoading] = useState(false)
  const [dragging,setDragging]= useState(false)
  const [result,  setResult]  = useState(null)

  const processFile = useCallback(async (file) => {
    if (!file) return
    const ext = file.name.split('.').pop().toLowerCase()
    if (!['csv', 'xlsx'].includes(ext)) {
      setError(ext === 'xls'
        ? 'Legacy .xls files are no longer supported — re-save as .xlsx or .csv and re-upload'
        : 'Only .csv and .xlsx files are supported')
      return
    }
    setError(null)
    setLoading(true)
    try {
      const data = await parseFile(file)
      setParsed(data)
      setStep('preview')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    setDragging(false)
    processFile(e.dataTransfer.files[0])
  }, [processFile])

  const handleImport = async () => {
    if (!parsed) return
    setLoading(true)
    setError(null)
    try {
      const res = await authFetch(`/api/portfolios/${portfolioId}/import`, {
        method: 'POST',
        body:   { holdings: parsed.holdings },
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || 'Import failed')
      setResult(d)
      setStep('done')
      onImported?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const fmt = (n) => isNaN(n) ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })

  return (
    <Dialog open onClose={onClose}>
      <DialogHeader title="Import Portfolio" onClose={onClose} />
      <DialogBody className="space-y-4">

        {step === 'upload' && (
          <>
            <div
              onDragOver={e => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              onClick={() => inputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all
                ${dragging ? 'border-[#00ffcc]/60 bg-[#00ffcc]/5' : 'border-white/[0.12] hover:border-white/25 hover:bg-white/[0.02]'}`}
            >
              <Upload className="w-8 h-8 mx-auto text-slate-500 mb-3" />
              <p className="text-sm text-slate-300 font-medium">Drop a file here or click to browse</p>
              <p className="text-xs text-slate-500 mt-1">CSV · XLSX — exported from any brokerage</p>
              <input ref={inputRef} type="file" accept=".csv,.xlsx" className="hidden"
                onChange={e => processFile(e.target.files[0])} />
            </div>

            <div className="glass rounded-lg px-4 py-3 text-xs text-slate-500 space-y-1">
              <p className="font-semibold text-slate-400 mb-1.5 flex items-center gap-1.5"><FileText className="w-3.5 h-3.5" /> Expected columns (flexible names)</p>
              <p><span className="text-mint-400 font-mono">Symbol</span> — ticker (required)</p>
              <p><span className="text-mint-400 font-mono">Shares</span> — quantity held (required)</p>
              <p><span className="text-mint-400 font-mono">AvgCost / Price</span> — average cost basis per share (required)</p>
              <p><span className="text-slate-600 font-mono">Name, Sector</span> — optional</p>
            </div>
          </>
        )}

        {step === 'preview' && parsed && (
          <>
            <div className="flex items-center gap-2 text-xs text-slate-400 px-1">
              <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
              <span><strong className="text-white">{parsed.holdings.length}</strong> positions detected</span>
            </div>

            <div className="max-h-64 overflow-y-auto rounded-xl border border-white/[0.08]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-[#0d1421]">
                  <tr className="text-slate-500 border-b border-white/[0.06]">
                    <th className="text-left px-3 py-2">Symbol</th>
                    <th className="text-left px-3 py-2 hidden sm:table-cell">Name</th>
                    <th className="text-right px-3 py-2">Shares</th>
                    <th className="text-right px-3 py-2">Avg Cost</th>
                    <th className="text-right px-3 py-2 hidden sm:table-cell">Total Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.holdings.map((h, i) => (
                    <tr key={i} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                      <td className="px-3 py-2 font-mono font-semibold text-mint-400">{h.symbol}</td>
                      <td className="px-3 py-2 text-slate-400 truncate max-w-[140px] hidden sm:table-cell">{h.name}</td>
                      <td className="px-3 py-2 text-right font-mono text-white">{h.shares}</td>
                      <td className="px-3 py-2 text-right font-mono text-white">${fmt(h.avgCost)}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-400 hidden sm:table-cell">
                        ${portfolioPnl.costBasis(h).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="text-[10px] text-amber-400/70 px-1">
              Existing positions for the same symbol will be overwritten with the imported values.
            </div>
          </>
        )}

        {step === 'done' && (
          <div className="text-center py-4 space-y-2">
            <CheckCircle className="w-10 h-10 mx-auto text-emerald-400" />
            <p className="text-white font-semibold">Import complete</p>
            <p className="text-sm text-slate-400">{result?.imported ?? parsed?.holdings.length} positions imported successfully.</p>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2.5 text-xs text-red-400">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {loading && (
          <div className="text-center text-xs text-slate-500 py-2">Processing…</div>
        )}

        <div className="flex gap-3 pt-1">
          {step === 'upload' && (
            <button onClick={onClose} className="btn-ghost flex-1">Cancel</button>
          )}
          {step === 'preview' && (
            <>
              <button onClick={() => { setStep('upload'); setParsed(null) }} className="btn-ghost flex-1">
                ← Back
              </button>
              <button onClick={handleImport} disabled={loading}
                className="btn-primary flex-1 disabled:opacity-40 disabled:cursor-not-allowed">
                {loading ? 'Importing…' : `Import ${parsed.holdings.length} Positions`}
              </button>
            </>
          )}
          {step === 'done' && (
            <button onClick={onClose} className="btn-primary flex-1">Done</button>
          )}
        </div>

      </DialogBody>
    </Dialog>
  )
}
