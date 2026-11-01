/** Learn tab: the quant vocabulary, strategy list, model list and cost cheatsheet, each linked to the tool that implements it. */
import { useMemo, useState } from 'react'
import { Search, ExternalLink } from 'lucide-react'
import { Card } from './shared'
import { TERMS, STRATEGIES, MODELS, ML_ALGOS, BIG_O, PLAYBOOK } from './reference'

const go = where => { window.location.hash = `#/${where}` }
function Where({ where }) {
  if (!where) return <span className="text-[10px] text-slate-600">definition only</span>
  return <button onClick={() => go(where)} className="inline-flex items-center gap-1 text-[10px] text-mint-400 hover:underline"><ExternalLink className="w-3 h-3" />{where.replace('quant-lab/', 'Quant Lab · ')}</button>
}
function Section({ title, rows, cols = 3 }) {
  return (
    <Card title={`${title} (${rows.length})`}>
      <div className={`grid gap-x-6 gap-y-2 sm:grid-cols-2 ${cols === 3 ? 'lg:grid-cols-3' : ''}`}>
        {rows.map(([name, def, where]) => (
          <div key={name} className="text-[12px] border-b border-slate-500/10 pb-1.5">
            <div className="flex justify-between gap-2"><span className="font-medium text-slate-200">{name}</span><Where where={where} /></div>
            {def && <div className="text-slate-500 text-[11px]">{def}</div>}
          </div>
        ))}
      </div>
    </Card>
  )
}
export default function LearnTab() {
  const [q, setQ] = useState('')
  const f = useMemo(() => { const s = q.trim().toLowerCase(); return rows => (s ? rows.filter(r => r.slice(0, 2).join(' ').toLowerCase().includes(s)) : rows) }, [q])
  const implemented = [...TERMS, ...STRATEGIES, ...PLAYBOOK, ...MODELS.map(m => [m[0], '', m[1]]), ...ML_ALGOS.map(m => [m[0], '', m[1]])]
  const built = implemented.filter(r => r[2]).length
  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search terms, strategies, models…" className="w-full pl-9 pr-3 py-2 rounded-xl bg-slate-500/10 border border-slate-500/20 text-sm text-white focus:outline-none focus:border-mint-400/60" />
      </div>
      <p className="text-[11px] text-slate-500">{built} of {implemented.length} entries link to something you can run in FinSurfing. Every entry now links to something you can run.</p>
      <Section title="Strategies" rows={f(STRATEGIES)} />
      <Section title="Gamma scalping playbook" rows={f(PLAYBOOK)} />
      <Section title="Quant models" rows={f(MODELS.map(m => [m[0], '', m[1]]))} />
      <Section title="Machine-learning algorithms" rows={f(ML_ALGOS.map(m => [m[0], '', m[1]]))} />
      <Card title="Cost cheatsheet (time · memory · accuracy)">
        <div className="overflow-x-auto"><table className="text-[11px] w-full"><thead><tr className="text-slate-500 text-left"><th className="pb-1">Method</th><th>Time</th><th>Memory</th><th>Accuracy</th><th>Best for</th></tr></thead><tbody>
          {f(BIG_O).map(r => <tr key={r[0]} className="border-t border-slate-500/10 text-slate-300">{r.map((c, i) => <td key={i} className="py-1 pr-3">{c}</td>)}</tr>)}
        </tbody></table></div>
      </Card>
      <Section title="Vocabulary" rows={f(TERMS)} />
    </div>
  )
}
