// ── Trade log ─────────────────────────────────────────────────────────────────

export default function TradeLog({ trades }) {
  if (!trades?.length) return null
  const sells = trades.filter(t => t.type === 'sell')
  return (
    <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-white/[0.05]">
        <span className="text-xs font-semibold text-slate-400">Trade Log</span>
        <span className="ml-2 text-[10px] text-slate-600">({sells.length} closed trades)</span>
      </div>
      <div className="max-h-64 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-[#0a0e1a] text-slate-600">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Date</th>
              <th className="px-4 py-2 text-right font-medium">Price</th>
              <th className="px-4 py-2 text-right font-medium">Shares</th>
              <th className="px-4 py-2 text-right font-medium">P&L %</th>
              <th className="px-4 py-2 text-right font-medium">Days</th>
            </tr>
          </thead>
          <tbody>
            {sells.map((t, i) => (
              <tr key={i} className="border-t border-white/[0.03] hover:bg-white/[0.02]">
                <td className="px-4 py-2 font-mono text-slate-400">
                  {t.date}
                  {t.open && <span className="ml-1 text-[9px] text-amber-400">OPEN</span>}
                </td>
                <td className="px-4 py-2 font-mono text-right text-white">${t.price}</td>
                <td className="px-4 py-2 font-mono text-right text-slate-400">{t.shares}</td>
                <td className={`px-4 py-2 font-mono text-right font-semibold ${t.pnl >= 0 ? 'text-mint-400' : 'text-red-400'}`}>
                  {t.pnl >= 0 ? '+' : ''}{t.pnl}%
                </td>
                <td className="px-4 py-2 font-mono text-right text-slate-500">{t.durationDays}d</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
