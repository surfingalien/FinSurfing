/**
 * GoalsView — Investment Goals & Accountability
 *
 * 5-level goal cascade (obsidian-claude-pkm pattern):
 *   3-Year Vision → Yearly Goals → Active Projects → Monthly Focus → This Week
 *
 * AI tools: Daily Checklist, Goal Aligner (audits notes vs goals)
 * Storage: localStorage finsurf_goals (no backend needed for the hierarchy)
 */

import { useState, useCallback } from 'react'
import {
  Target, Plus, Trash2, CheckCircle2, Circle,
  Edit3, Save, X, Sparkles,
  Flag, FolderOpen, Calendar, Sun, AlignLeft,
  TrendingUp,
} from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { Section } from './parts/Section'
import { DailyChecklistModal } from './parts/DailyChecklistModal'
import { GoalAlignerModal } from './parts/GoalAlignerModal'

const GOALS_KEY = 'finsurf_goals'

function newId() { return crypto.randomUUID() }

const DEFAULT_GOALS = {
  vision:   { text: '', updatedAt: null },
  yearly:   [],
  projects: [],
  monthly:  { focus: '', targets: [] },
  weekly:   { priority: '', tasks: [] },
}

function loadGoals() {
  try { return JSON.parse(localStorage.getItem(GOALS_KEY)) || DEFAULT_GOALS } catch { return DEFAULT_GOALS }
}

function saveGoals(g) {
  try { localStorage.setItem(GOALS_KEY, JSON.stringify(g)) } catch {}
}

// ── Main view ──────────────────────────────────────────────────────────────────
export default function GoalsView({ portfolio }) {
  const { authFetch } = useAuth()

  const [goals, setGoals] = useState(loadGoals)

  const [editingVision,  setEditingVision]  = useState(false)
  const [editingMonthly, setEditingMonthly] = useState(false)
  const [editingWeekly,  setEditingWeekly]  = useState(false)

  const [visionDraft,  setVisionDraft]  = useState('')
  const [monthlyDraft, setMonthlyDraft] = useState('')
  const [weeklyDraft,  setWeeklyDraft]  = useState('')

  const [newYearly,  setNewYearly]  = useState({ text: '', target: '' })
  const [newProject, setNewProject] = useState({ name: '', linkedGoal: '', notes: '' })
  const [newTarget,  setNewTarget]  = useState('')
  const [newTask,    setNewTask]    = useState('')

  const [showAddYearly,  setShowAddYearly]  = useState(false)
  const [showAddProject, setShowAddProject] = useState(false)

  const [showChecklist,  setShowChecklist]  = useState(false)
  const [showAligner,    setShowAligner]    = useState(false)

  const persistGoals = useCallback((updater) => {
    setGoals(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      saveGoals(next)
      return next
    })
  }, [])

  // Vision
  const saveVision = () => {
    persistGoals(g => ({ ...g, vision: { text: visionDraft, updatedAt: new Date().toISOString() } }))
    setEditingVision(false)
  }

  // Yearly goals
  const addYearly = () => {
    if (!newYearly.text.trim()) return
    persistGoals(g => ({ ...g, yearly: [...g.yearly, { id: newId(), text: newYearly.text.trim(), target: newYearly.target.trim(), milestones: [] }] }))
    setNewYearly({ text: '', target: '' })
    setShowAddYearly(false)
  }
  const removeYearly = (id) => persistGoals(g => ({ ...g, yearly: g.yearly.filter(y => y.id !== id) }))

  // Projects
  const addProject = () => {
    if (!newProject.name.trim()) return
    persistGoals(g => ({ ...g, projects: [...g.projects, { id: newId(), name: newProject.name.trim(), linkedGoal: newProject.linkedGoal, status: 'active', notes: newProject.notes }] }))
    setNewProject({ name: '', linkedGoal: '', notes: '' })
    setShowAddProject(false)
  }
  const removeProject = (id) => persistGoals(g => ({ ...g, projects: g.projects.filter(p => p.id !== id) }))
  const toggleProject = (id) => persistGoals(g => ({ ...g, projects: g.projects.map(p => p.id === id ? { ...p, status: p.status === 'done' ? 'active' : 'done' } : p) }))

  // Monthly
  const saveMonthly = () => {
    persistGoals(g => ({ ...g, monthly: { ...g.monthly, focus: monthlyDraft } }))
    setEditingMonthly(false)
  }
  const addTarget = () => {
    if (!newTarget.trim()) return
    persistGoals(g => ({ ...g, monthly: { ...g.monthly, targets: [...(g.monthly.targets||[]), newTarget.trim()] } }))
    setNewTarget('')
  }
  const removeTarget = (i) => persistGoals(g => ({ ...g, monthly: { ...g.monthly, targets: g.monthly.targets.filter((_,j)=>j!==i) } }))

  // Weekly
  const saveWeekly = () => {
    persistGoals(g => ({ ...g, weekly: { ...g.weekly, priority: weeklyDraft } }))
    setEditingWeekly(false)
  }
  const addTask = () => {
    if (!newTask.trim()) return
    persistGoals(g => ({ ...g, weekly: { ...g.weekly, tasks: [...(g.weekly.tasks||[]), { id: newId(), text: newTask.trim(), done: false }] } }))
    setNewTask('')
  }
  const toggleTask = (id) => persistGoals(g => ({ ...g, weekly: { ...g.weekly, tasks: g.weekly.tasks.map(t => t.id === id ? { ...t, done: !t.done } : t) } }))
  const removeTask = (id) => persistGoals(g => ({ ...g, weekly: { ...g.weekly, tasks: g.weekly.tasks.filter(t => t.id !== id) } }))

  const handleSaveNote = useCallback(async (noteData) => {
    try {
      await authFetch('/api/research-notes', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(noteData),
      })
    } catch {}
  }, [authFetch])

  const yearStr = new Date().getFullYear()
  const monthStr = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
            <Target className="w-5 h-5 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Goals & Accountability</h1>
            <p className="text-xs text-slate-500">Vision → Yearly → Projects → Monthly → Weekly</p>
          </div>
        </div>

        {/* Quick actions */}
        <div className="flex items-center gap-2">
          <button onClick={() => setShowChecklist(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-all">
            <Sun className="w-3.5 h-3.5" /> Daily Checklist
          </button>
          <button onClick={() => setShowAligner(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-violet-500/10 border border-violet-500/20 text-violet-400 hover:bg-violet-500/20 transition-all">
            <Sparkles className="w-3.5 h-3.5" /> Goal Aligner
          </button>
        </div>
      </div>

      {/* ── 1. 3-Year Vision ── */}
      <Section title="3-Year Vision" icon={Flag} color="text-emerald-400" defaultOpen>
        {!editingVision ? (
          <div className="space-y-2">
            {goals.vision.text ? (
              <p className="text-sm text-slate-300 leading-relaxed">{goals.vision.text}</p>
            ) : (
              <p className="text-xs text-slate-600 italic">No vision set yet. What does financial success look like in 3 years?</p>
            )}
            <button onClick={() => { setVisionDraft(goals.vision.text); setEditingVision(true) }}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-white transition-colors">
              <Edit3 className="w-3 h-3" /> {goals.vision.text ? 'Edit' : 'Set vision'}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <textarea
              value={visionDraft} onChange={e => setVisionDraft(e.target.value)} autoFocus
              placeholder="e.g. Achieve financial independence by 2027 with $2M invested, 20% annual returns, and a dividend income stream of $3k/month…"
              className="input w-full h-28 resize-none text-sm"
            />
            <div className="flex gap-2">
              <button onClick={saveVision} className="btn-primary flex items-center gap-1.5 text-xs py-1.5">
                <Save className="w-3.5 h-3.5" /> Save
              </button>
              <button onClick={() => setEditingVision(false)} className="btn-ghost text-xs py-1.5 px-3">Cancel</button>
            </div>
          </div>
        )}
      </Section>

      {/* ── 2. Yearly Goals ── */}
      <Section title={`Yearly Goals ${yearStr}`} icon={TrendingUp} color="text-sky-400" count={goals.yearly.length}>
        <div className="space-y-2">
          {goals.yearly.length === 0 && (
            <p className="text-xs text-slate-600 italic">No yearly goals set. Add measurable targets for {yearStr}.</p>
          )}
          {goals.yearly.map(g => (
            <div key={g.id} className="flex items-center gap-2 p-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06]">
              <CheckCircle2 className="w-3.5 h-3.5 text-sky-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="text-xs text-slate-200">{g.text}</span>
                {g.target && <span className="text-[10px] text-slate-500 ml-2">→ {g.target}</span>}
              </div>
              <button onClick={() => removeYearly(g.id)} className="text-slate-600 hover:text-red-400 transition-colors shrink-0">
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}

          {showAddYearly ? (
            <div className="space-y-2 p-3 rounded-xl bg-sky-500/8 border border-sky-500/20">
              <input value={newYearly.text} onChange={e => setNewYearly(p => ({...p, text: e.target.value}))}
                autoFocus placeholder="e.g. Achieve 20% annual return" className="input w-full text-xs" />
              <input value={newYearly.target} onChange={e => setNewYearly(p => ({...p, target: e.target.value}))}
                placeholder="Target / metric (optional)" className="input w-full text-xs" />
              <div className="flex gap-2">
                <button onClick={addYearly} className="btn-primary text-xs py-1.5">Add</button>
                <button onClick={() => setShowAddYearly(false)} className="btn-ghost text-xs py-1.5 px-3">Cancel</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setShowAddYearly(true)}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-sky-400 transition-colors">
              <Plus className="w-3 h-3" /> Add yearly goal
            </button>
          )}
        </div>
      </Section>

      {/* ── 3. Active Projects ── */}
      <Section title="Active Investment Projects" icon={FolderOpen} color="text-indigo-400" count={goals.projects.filter(p=>p.status==='active').length}>
        <div className="space-y-2">
          {goals.projects.length === 0 && (
            <p className="text-xs text-slate-600 italic">No projects yet. Add active investment theses or initiatives.</p>
          )}
          {goals.projects.map(p => (
            <div key={p.id} className={`flex items-center gap-2 p-2.5 rounded-lg border transition-all ${
              p.status === 'done' ? 'bg-white/[0.01] border-white/[0.04] opacity-50' : 'bg-white/[0.03] border-white/[0.06]'
            }`}>
              <button onClick={() => toggleProject(p.id)} className="shrink-0">
                {p.status === 'done'
                  ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  : <Circle className="w-3.5 h-3.5 text-indigo-400" />
                }
              </button>
              <div className="flex-1 min-w-0">
                <span className={`text-xs ${p.status === 'done' ? 'line-through text-slate-500' : 'text-slate-200'}`}>{p.name}</span>
                {p.linkedGoal && <span className="text-[10px] text-slate-600 ml-2">↗ {p.linkedGoal}</span>}
              </div>
              <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${p.status === 'done' ? 'text-emerald-600 border-emerald-600/30' : 'text-indigo-400 border-indigo-500/30'}`}>
                {p.status}
              </span>
              <button onClick={() => removeProject(p.id)} className="text-slate-600 hover:text-red-400 transition-colors shrink-0">
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}

          {showAddProject ? (
            <div className="space-y-2 p-3 rounded-xl bg-indigo-500/8 border border-indigo-500/20">
              <input value={newProject.name} onChange={e => setNewProject(p => ({...p, name: e.target.value}))}
                autoFocus placeholder="Project name (e.g. NVDA AI thesis 2025)" className="input w-full text-xs" />
              <input value={newProject.linkedGoal} onChange={e => setNewProject(p => ({...p, linkedGoal: e.target.value}))}
                placeholder="Linked yearly goal (optional)" className="input w-full text-xs" />
              <div className="flex gap-2">
                <button onClick={addProject} className="btn-primary text-xs py-1.5">Add</button>
                <button onClick={() => setShowAddProject(false)} className="btn-ghost text-xs py-1.5 px-3">Cancel</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setShowAddProject(true)}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-indigo-400 transition-colors">
              <Plus className="w-3 h-3" /> Add project
            </button>
          )}
        </div>
      </Section>

      {/* ── 4. Monthly Focus ── */}
      <Section title={`Monthly Focus — ${monthStr}`} icon={Calendar} color="text-rose-400" defaultOpen>
        <div className="space-y-3">
          {!editingMonthly ? (
            <div>
              {goals.monthly.focus ? (
                <p className="text-sm text-slate-300 mb-2">{goals.monthly.focus}</p>
              ) : (
                <p className="text-xs text-slate-600 italic mb-2">No monthly focus set.</p>
              )}
              <button onClick={() => { setMonthlyDraft(goals.monthly.focus); setEditingMonthly(true) }}
                className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-rose-400 transition-colors">
                <Edit3 className="w-3 h-3" /> {goals.monthly.focus ? 'Edit' : 'Set focus'}
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <textarea value={monthlyDraft} onChange={e => setMonthlyDraft(e.target.value)} autoFocus
                placeholder="This month's main investing focus..." className="input w-full h-20 resize-none text-sm" />
              <div className="flex gap-2">
                <button onClick={saveMonthly} className="btn-primary flex items-center gap-1.5 text-xs py-1.5">
                  <Save className="w-3.5 h-3.5" /> Save
                </button>
                <button onClick={() => setEditingMonthly(false)} className="btn-ghost text-xs py-1.5 px-3">Cancel</button>
              </div>
            </div>
          )}

          {/* Monthly targets */}
          <div className="space-y-1.5">
            <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Monthly Targets</div>
            {(goals.monthly.targets || []).map((t, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-[10px] text-rose-400 shrink-0">→</span>
                <span className="text-xs text-slate-300 flex-1">{t}</span>
                <button onClick={() => removeTarget(i)} className="text-slate-600 hover:text-red-400 transition-colors">
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            <div className="flex gap-2">
              <input value={newTarget} onChange={e => setNewTarget(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addTarget()}
                placeholder="Add monthly target…" className="input flex-1 text-xs py-1.5" />
              <button onClick={addTarget} disabled={!newTarget.trim()}
                className="p-1.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 hover:bg-rose-500/20 disabled:opacity-40 transition-all">
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </Section>

      {/* ── 5. This Week ── */}
      <Section title="This Week" icon={AlignLeft} color="text-amber-400" defaultOpen>
        <div className="space-y-3">
          <div>
            <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Single Priority</div>
            {!editingWeekly ? (
              <div>
                {goals.weekly.priority ? (
                  <p className="text-sm text-slate-200 font-medium mb-1">{goals.weekly.priority}</p>
                ) : (
                  <p className="text-xs text-slate-600 italic mb-1">No weekly priority set.</p>
                )}
                <button onClick={() => { setWeeklyDraft(goals.weekly.priority); setEditingWeekly(true) }}
                  className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-amber-400 transition-colors">
                  <Edit3 className="w-3 h-3" /> {goals.weekly.priority ? 'Edit' : 'Set priority'}
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <input value={weeklyDraft} onChange={e => setWeeklyDraft(e.target.value)} autoFocus
                  placeholder="This week's single most important investing action…" className="input w-full text-sm" />
                <div className="flex gap-2">
                  <button onClick={saveWeekly} className="btn-primary flex items-center gap-1.5 text-xs py-1.5">
                    <Save className="w-3.5 h-3.5" /> Save
                  </button>
                  <button onClick={() => setEditingWeekly(false)} className="btn-ghost text-xs py-1.5 px-3">Cancel</button>
                </div>
              </div>
            )}
          </div>

          {/* Weekly tasks */}
          <div className="space-y-1.5">
            <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Tasks</div>
            {(goals.weekly.tasks || []).map(t => (
              <div key={t.id} className="flex items-center gap-2">
                <button onClick={() => toggleTask(t.id)} className="shrink-0">
                  {t.done
                    ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    : <Circle className="w-3.5 h-3.5 text-slate-500" />
                  }
                </button>
                <span className={`text-xs flex-1 ${t.done ? 'line-through text-slate-600' : 'text-slate-300'}`}>{t.text}</span>
                <button onClick={() => removeTask(t.id)} className="text-slate-600 hover:text-red-400 transition-colors">
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            <div className="flex gap-2">
              <input value={newTask} onChange={e => setNewTask(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addTask()}
                placeholder="Add weekly task…" className="input flex-1 text-xs py-1.5" />
              <button onClick={addTask} disabled={!newTask.trim()}
                className="p-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 disabled:opacity-40 transition-all">
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </Section>

      {/* ── Modals ── */}
      {showChecklist && (
        <DailyChecklistModal
          goals={goals} portfolio={portfolio}
          onClose={() => setShowChecklist(false)}
          onSave={handleSaveNote}
        />
      )}
      {showAligner && (
        <GoalAlignerModal
          goals={goals}
          onClose={() => setShowAligner(false)}
          onSave={handleSaveNote}
        />
      )}
    </div>
  )
}
