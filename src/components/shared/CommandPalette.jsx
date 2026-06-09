/**
 * CommandPalette.jsx
 *
 * ⌘K / Ctrl+K quick navigation — zero dependencies.
 *  - Fuzzy-ish (substring) search over every nav destination
 *  - Type a ticker (e.g. "NVDA") to jump straight to Analyze
 *  - Full keyboard support: ↑/↓ to move, Enter to go, Esc to close
 */

import { useState, useEffect, useRef, useMemo } from 'react'
import { Search, LineChart, CornerDownLeft } from 'lucide-react'
import { NAV_COMMANDS } from '../../navigation'

const TICKER_RE = /^[A-Za-z][A-Za-z.\-]{0,5}$/

export default function CommandPalette({ open, onClose, onNavigate }) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  // Reset on open, focus the input
  useEffect(() => {
    if (open) {
      setQuery('')
      setIndex(0)
      // Focus after the element mounts
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matches = q
      ? NAV_COMMANDS.filter(c =>
          c.label.toLowerCase().includes(q) ||
          c.id.includes(q) ||
          c.group.toLowerCase().includes(q)
        )
      : NAV_COMMANDS

    const items = matches.map(c => ({
      key: `nav:${c.id}`,
      icon: c.icon,
      label: c.label,
      hint: c.group,
      run: () => onNavigate(c.id),
    }))

    // Ticker-shaped query → offer direct symbol analysis first
    const t = query.trim()
    if (t && TICKER_RE.test(t)) {
      items.unshift({
        key: `analyze:${t}`,
        icon: LineChart,
        label: `Analyze ${t.toUpperCase()}`,
        hint: 'Symbol',
        run: () => onNavigate('analyze', t.toUpperCase()),
      })
    }
    return items
  }, [query, onNavigate])

  // Clamp selection when results shrink
  useEffect(() => {
    setIndex(i => Math.min(i, Math.max(0, results.length - 1)))
  }, [results])

  // Keep the selected row in view
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [index])

  if (!open) return null

  const select = (item) => {
    item.run()
    onClose()
  }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex(i => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (results[index]) select(results[index])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-label="Command palette">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="relative mx-auto mt-[12vh] w-[92vw] max-w-lg rounded-2xl overflow-hidden
                      bg-[#0c101b] border border-white/[0.1] shadow-2xl shadow-black/70
                      animate-in fade-in slide-in-from-top-2 duration-150">
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 h-12 border-b border-white/[0.06]">
          <Search className="w-4 h-4 text-mint-400 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to a view or type a ticker…"
            className="flex-1 bg-transparent text-sm text-white placeholder-slate-500 outline-none"
          />
          <kbd className="text-[9px] font-mono text-slate-600 border border-white/[0.08] rounded px-1.5 py-0.5">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1.5">
          {results.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-slate-500">No matches</div>
          )}
          {results.map((item, i) => {
            const Icon = item.icon
            const selected = i === index
            return (
              <button
                key={item.key}
                data-selected={selected}
                onMouseEnter={() => setIndex(i)}
                onClick={() => select(item)}
                className={`flex items-center gap-3 w-full px-4 py-2.5 text-sm text-left transition-colors
                            ${selected ? 'bg-mint-500/10 text-mint-300' : 'text-slate-300'}`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${selected ? 'text-mint-400' : 'text-slate-500'}`} />
                <span className="flex-1 truncate">{item.label}</span>
                <span className="text-[9px] uppercase tracking-widest text-slate-600">{item.hint}</span>
                {selected && <CornerDownLeft className="w-3 h-3 text-slate-600" />}
              </button>
            )
          })}
        </div>

        {/* Footer hints */}
        <div className="flex items-center gap-4 px-4 h-8 border-t border-white/[0.06] text-[9px] text-slate-600">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span className="ml-auto font-mono text-mint-500/60">FINSURF</span>
        </div>
      </div>
    </div>
  )
}
