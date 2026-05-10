/**
 * ChangePasswordModal — lets the logged-in user change their password.
 * Uses POST /api/auth/change-password (Bearer token).
 */
import { useState } from 'react'
import { X, Loader2, Eye, EyeOff, CheckCircle } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'

function PasswordField({ label, value, onChange, placeholder, autoComplete }) {
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
          className="w-full px-3 py-2.5 pr-10 rounded-lg bg-white/[0.04] border border-white/[0.08]
                     text-sm text-white placeholder-slate-600 focus:outline-none
                     focus:border-[#00ffcc]/40 focus:ring-1 focus:ring-[#00ffcc]/15 transition-all"
        />
        <button
          type="button"
          onClick={() => setShow(s => !s)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
        >
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </div>
  )
}

function PasswordStrengthBar({ password }) {
  const checks = [
    password.length >= 8,
    /[A-Z]/.test(password),
    /[a-z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ]
  const score = checks.filter(Boolean).length
  const colors = ['', '#ef4444', '#f59e0b', '#eab308', '#10b981', '#00ffcc']
  const labels = ['', 'Weak', 'Fair', 'Good', 'Strong', 'Very strong']
  if (!password) return null
  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex gap-1">
        {checks.map((ok, i) => (
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
  const [current, setCurrent] = useState('')
  const [next,    setNext]    = useState('')
  const [confirm, setConfirm] = useState('')
  const [error,   setError]   = useState('')
  const [loading, setLoading] = useState(false)
  const [done,    setDone]    = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (next !== confirm)  return setError('New passwords do not match')
    if (next.length < 8 || !/[a-zA-Z]/.test(next) || !/\d/.test(next))
      return setError('Password must be 8+ characters with a letter and a number')
    if (next === current)  return setError('New password must be different from current')

    setLoading(true)
    try {
      const res  = await authFetch('/api/auth/change-password', {
        method: 'POST',
        body: { currentPassword: current, newPassword: next },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Change failed')
      setDone(true)
      // Wait 2 seconds then log out (server revoked all sessions)
      setTimeout(() => {
        logout()
        onClose()
      }, 2000)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-sm rounded-2xl bg-[#0f1117] border border-white/10 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <h2 className="text-sm font-semibold text-white">Change Password</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5">
          {done ? (
            <div className="text-center space-y-3 py-4">
              <CheckCircle size={40} className="text-[#00ffcc] mx-auto" />
              <p className="text-sm font-semibold text-white">Password changed!</p>
              <p className="text-xs text-slate-500">Signing you out of all devices…</p>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              {error && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
                  {error}
                </div>
              )}

              <PasswordField
                label="Current Password"
                value={current}
                onChange={setCurrent}
                autoComplete="current-password"
              />
              <div>
                <PasswordField
                  label="New Password"
                  value={next}
                  onChange={setNext}
                  placeholder="8+ chars, letter + number"
                  autoComplete="new-password"
                />
                <PasswordStrengthBar password={next} />
              </div>
              <PasswordField
                label="Confirm New Password"
                value={confirm}
                onChange={setConfirm}
                autoComplete="new-password"
              />

              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 py-2.5 rounded-lg text-sm text-slate-400 hover:text-slate-200
                             hover:bg-white/5 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading || !current || !next || !confirm}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg
                             text-sm font-semibold text-[#0a0e1a] bg-[#00ffcc] hover:bg-[#00e6b8]
                             disabled:opacity-40 transition-all"
                >
                  {loading && <Loader2 size={14} className="animate-spin" />}
                  Update Password
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
