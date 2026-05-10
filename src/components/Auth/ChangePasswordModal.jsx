/**
 * ChangePasswordModal — lets the logged-in user change their password.
 * Fixed: after successful change, just calls logout() which unmounts the modal
 * naturally via auth state change — no onClose() race condition.
 */
import { useState, useEffect, useRef } from 'react'
import { X, Loader2, Eye, EyeOff, CheckCircle, ShieldCheck } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'

function PasswordField({ label, value, onChange, placeholder, autoComplete, error }) {
  const [show, setShow] = useState(false)
  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-slate-400">{label}</label>
      <div className="relative">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder || '••••••••'}
          autoComplete={autoComplete}
          className={`w-full px-3 py-2.5 pr-10 rounded-lg bg-white/[0.04] border text-sm text-white
                      placeholder-slate-600 focus:outline-none transition-all
                      ${error
                        ? 'border-red-500/40 focus:border-red-500/60'
                        : 'border-white/[0.08] focus:border-[#00ffcc]/40 focus:ring-1 focus:ring-[#00ffcc]/15'
                      }`}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setShow(s => !s)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
        >
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
      {error && <p className="text-[11px] text-red-400">{error}</p>}
    </div>
  )
}

function StrengthBar({ password }) {
  if (!password) return null
  const checks = [
    password.length >= 8,
    /[A-Z]/.test(password),
    /[a-z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ]
  const score  = checks.filter(Boolean).length
  const colors = ['', '#ef4444', '#f59e0b', '#eab308', '#10b981', '#00ffcc']
  const labels = ['', 'Weak', 'Fair', 'Good', 'Strong', 'Very strong']
  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex gap-1">
        {checks.map((_, i) => (
          <div key={i} className="h-1 flex-1 rounded-full transition-all duration-300"
            style={{ background: i < score ? colors[score] : 'rgba(255,255,255,0.08)' }} />
        ))}
      </div>
      <p className="text-[10px]" style={{ color: colors[score] }}>{labels[score]}</p>
    </div>
  )
}

export default function ChangePasswordModal({ onClose }) {
  const { authFetch, logout } = useAuth()
  const mounted = useRef(true)

  const [current, setCurrent] = useState('')
  const [next,    setNext]    = useState('')
  const [confirm, setConfirm] = useState('')
  const [error,   setError]   = useState('')
  const [fieldErr, setFieldErr] = useState({})
  const [loading, setLoading] = useState(false)
  const [done,    setDone]    = useState(false)

  useEffect(() => {
    mounted.current = true
    // Trap Escape
    const h = (e) => { if (e.key === 'Escape' && !done) onClose() }
    document.addEventListener('keydown', h)
    return () => {
      mounted.current = false
      document.removeEventListener('keydown', h)
    }
  }, [done, onClose])

  const validate = () => {
    const errs = {}
    if (!current)          errs.current = 'Required'
    if (!next)             errs.next    = 'Required'
    else if (next.length < 8 || !/[a-zA-Z]/.test(next) || !/\d/.test(next))
      errs.next = 'Must be 8+ chars with a letter and a number'
    else if (next === current)
      errs.next = 'New password must differ from current'
    if (!confirm)          errs.confirm = 'Required'
    else if (next !== confirm)
      errs.confirm = 'Passwords do not match'
    return errs
  }

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    const errs = validate()
    setFieldErr(errs)
    if (Object.keys(errs).length) return

    setLoading(true)
    try {
      const res  = await authFetch('/api/auth/change-password', {
        method: 'POST',
        body: { currentPassword: current, newPassword: next },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Change failed')

      if (mounted.current) setDone(true)
      // After 2s, logout — this changes isAuthenticated → App unmounts modal naturally
      setTimeout(() => { if (mounted.current) logout() }, 2000)
    } catch (err) {
      if (mounted.current) setError(err.message)
    } finally {
      if (mounted.current) setLoading(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Change Password"
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(6px)' }}
      onClick={(e) => { if (e.target === e.currentTarget && !done) onClose() }}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-white/10 shadow-2xl shadow-black/70 overflow-hidden"
        style={{ background: '#0f1117' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-2">
            <ShieldCheck size={16} className="text-[#00ffcc]" />
            <h2 className="text-sm font-semibold text-white">Change Password</h2>
          </div>
          {!done && (
            <button
              onClick={onClose}
              className="text-slate-500 hover:text-slate-300 transition-colors p-1 rounded-lg hover:bg-white/5"
            >
              <X size={15} />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="p-5">
          {done ? (
            <div className="text-center space-y-4 py-6">
              <div className="w-14 h-14 rounded-2xl bg-[#00ffcc]/10 flex items-center justify-center mx-auto">
                <CheckCircle size={28} className="text-[#00ffcc]" />
              </div>
              <div>
                <p className="text-sm font-semibold text-white">Password updated!</p>
                <p className="text-xs text-slate-500 mt-1.5">
                  All sessions have been revoked. Signing you out…
                </p>
              </div>
              <div className="flex justify-center gap-1">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="w-1.5 h-1.5 rounded-full bg-[#00ffcc]/40 animate-bounce"
                    style={{ animationDelay: `${i * 150}ms` }} />
                ))}
              </div>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4" noValidate>
              {error && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                  <span className="text-red-400 text-xs leading-relaxed">{error}</span>
                </div>
              )}

              <PasswordField
                label="Current Password"
                value={current}
                onChange={v => { setCurrent(v); setFieldErr(f => ({ ...f, current: '' })) }}
                autoComplete="current-password"
                error={fieldErr.current}
              />

              <div>
                <PasswordField
                  label="New Password"
                  value={next}
                  onChange={v => { setNext(v); setFieldErr(f => ({ ...f, next: '' })) }}
                  placeholder="8+ chars, letter + number"
                  autoComplete="new-password"
                  error={fieldErr.next}
                />
                <StrengthBar password={next} />
              </div>

              <PasswordField
                label="Confirm New Password"
                value={confirm}
                onChange={v => { setConfirm(v); setFieldErr(f => ({ ...f, confirm: '' })) }}
                autoComplete="new-password"
                error={fieldErr.confirm}
              />

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 py-2.5 rounded-xl text-sm text-slate-400 hover:text-slate-200
                             hover:bg-white/5 border border-transparent hover:border-white/[0.06] transition-all"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl
                             text-sm font-semibold text-[#0a0e1a] bg-[#00ffcc] hover:bg-[#00e6b8]
                             disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                >
                  {loading && <Loader2 size={14} className="animate-spin" />}
                  {loading ? 'Updating…' : 'Update Password'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
