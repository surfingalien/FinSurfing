import { useState } from 'react'
import { ListChecks, ChevronDown, ChevronUp } from 'lucide-react'

// The research routine the Second Brain tools are built around. The weekly and
// monthly steps are also done for the user by the Sunday "Second Brain
// Weekly" email (lib/scheduled-jobs.js); the per-idea steps are theirs.
const STEPS = [
  { when: 'New idea',      what: 'Dump it (Braindump), then Partner to stress-test it, then save.' },
  { when: 'Before buying', what: 'Deep or Research (Auto Research), then the Research Desk for the checked verdict.', link: '#/research-desk' },
  { when: 'Weekly',        what: 'Weekly (Synthesis), then Lint, so no holding goes without a current thesis. Emailed to you on Sundays.' },
  { when: 'Monthly',       what: 'Open a holding\'s note and press Synthesize to merge its notes into one up-to-date thesis. The first Sunday email of the month lists which ones.' },
]

const KEY = 'finsurf_routine_open'

export default function RoutineCard() {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(KEY) !== '0' } catch { return true }
  })
  const toggle = () => {
    setOpen(o => {
      try { localStorage.setItem(KEY, o ? '0' : '1') } catch { /* private mode */ }
      return !o
    })
  }

  return (
    <div className="rounded-xl bg-white/[0.02] border border-white/[0.07]">
      <button onClick={toggle} className="w-full flex items-center gap-1.5 px-2.5 py-2 text-[11px] font-semibold text-slate-300 hover:text-white">
        <ListChecks className="w-3.5 h-3.5 text-emerald-400" /> Research routine
        {open ? <ChevronUp className="w-3 h-3 ml-auto" /> : <ChevronDown className="w-3 h-3 ml-auto" />}
      </button>
      {open && (
        <ol className="px-2.5 pb-2.5 space-y-1.5">
          {STEPS.map((s, i) => (
            <li key={s.when} className="text-[10px] leading-snug text-slate-400">
              <span className="font-semibold text-slate-200">{i + 1}. {s.when}:</span> {s.what}
              {s.link && <a href={s.link} className="ml-1 text-indigo-400 hover:text-indigo-300">Open →</a>}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
