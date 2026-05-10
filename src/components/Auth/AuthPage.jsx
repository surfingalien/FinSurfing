/**
 * AuthPage — login, register, verify-email, forgot-password flows.
 * No credentials are displayed to users.
 */
import { useState, useRef } from 'react'
import { Eye, EyeOff, Loader2, CheckCircle, Mail, Zap, RefreshCw } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'

// ── Helpers ──────────────────────────────────────────────────────────────────
function Field({ label, type = 'text', value, onChange, error, hint, placeholder, autoComplete }) {
  const [show, setShow] = useState(false)
  const isPassword = type === 'password'
  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-slate-400">{label}</label>
      <div className="relative">
        <input
          type={isPassword ? (show ? 'text' : 'password') : type}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          className={`w-full px-3 py-2.5 rounded-lg bg-white/[0.04] border text-sm text-white
                      placeholder-slate-600 focus:outline-none transition-all
                      ${error
                        ? 'border-red-500/40 focus:border-red-500/60'
                        : 'border-white/[0.08] focus:border-[#00ffcc]/40 focus:ring-1 focus:ring-[#00ffcc]/15'
                      }`}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setShow(s => !s)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
          >
            {show ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {hint && !error && <p className="text-xs text-slate-600">{hint}</p>}
    </div>
  )
}

function PasswordStrength({ password }) {
  const checks = [
    password.length >= 8,
    /[A-Z]/.test(password),
    /[a-z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ]
  const score  = checks.filter(Boolean).length
  const labels = ['', 'Weak', 'Fair', 'Good', 'Strong', 'Very strong']
  const colors = ['', '#ef4444', '#f59e0b', '#eab308', '#10b981', '#00ffcc']
  if (!password) return null
  return (
    <div className="space-y-1.5">
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

// ── OTP / Email Verification step ────────────────────────────────────────────
function VerifyEmailStep({ email, demoCode, onSuccess, onResend }) {
  const [code,    setCode]    = useState('')
  const [error,   setError]   = useState('')
  const [loading, setLoading] = useState(false)
  const [resent,  setResent]  = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (code.length !== 6) return setError('Enter the 6-digit code')
    setLoading(true)
    setError('')
    try {
      const res  = await fetch('/api/auth/verify-email', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Verification failed')
      onSuccess(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const resend = async () => {
    setResent(false)
    try {
      const res  = await fetch('/api/auth/resend-verification', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = await res.json()
      if (data.demoCode) {
        // New code came back — update parent (demo mode)
        onResend && onResend(data.demoCode)
      }
      setResent(true)
    } catch {}
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="text-center space-y-2">
        <div className="w-14 h-14 rounded-2xl bg-[#00ffcc]/10 flex items-center justify-center mx-auto">
          <Mail size={24} className="text-[#00ffcc]" />
        </div>
        <h3 className="text-base font-semibold text-white">Check your email</h3>
        <p className="text-xs text-slate-500">
          We sent a 6-digit code to <span className="text-slate-300">{email}</span>
        </p>
      </div>

      {/* Demo mode — show code on screen */}
      {demoCode && (
        <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20">
          <p className="text-[10px] text-amber-400 font-medium mb-1">
            ⚡ Demo mode — no SMTP configured
          </p>
          <p className="text-xs text-amber-300">Your code is shown here instead of being emailed:</p>
          <div className="mt-2 text-2xl font-black tracking-[0.3em] text-amber-300 text-center font-mono">
            {demoCode}
          </div>
        </div>
      )}

      {error && <p className="text-xs text-red-400 text-center">{error}</p>}

      {/* 6-digit input */}
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1.5">Verification code</label>
        <input
          type="text"
          inputMode="numeric"
          maxLength={6}
          value={code}
          onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="000000"
          className="w-full px-4 py-3 rounded-lg bg-white/[0.04] border border-white/[0.08]
                     text-2xl font-mono font-bold text-center text-white tracking-[0.4em]
                     focus:outline-none focus:border-[#00ffcc]/40 focus:ring-1 focus:ring-[#00ffcc]/15 transition-all"
        />
      </div>

      <button
        type="submit"
        disabled={loading || code.length !== 6}
        className="w-full py-2.5 rounded-lg font-semibold text-sm text-[#0a0e1a]
                   bg-[#00ffcc] hover:bg-[#00e6b8] disabled:opacity-40 transition-all
                   flex items-center justify-center gap-2"
      >
        {loading && <Loader2 size={15} className="animate-spin" />}
        Verify Email
      </button>

      <div className="text-center">
        {resent ? (
          <p className="text-xs text-emerald-400">New code sent!</p>
        ) : (
          <button
            type="button"
            onClick={resend}
            className="text-xs text-slate-500 hover:text-slate-300 flex items-center gap-1 mx-auto transition-colors"
          >
            <RefreshCw size={11} />
            Resend code
          </button>
        )}
      </div>
    </form>
  )
}

// ── Login form ────────────────────────────────────────────────────────────────
function LoginForm({ onNeedVerification, onForgot, onRegister }) {
  const { login } = useAuth()
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login({ email, password, rememberMe: remember })
      // AuthContext will update isAuthenticated → App re-renders
    } catch (err) {
      if (err.requiresVerification) {
        onNeedVerification(email, null)
      } else {
        setError(err.message)
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
          {error}
        </div>
      )}

      <Field label="Email" type="email" value={email} onChange={setEmail}
        placeholder="you@example.com" autoComplete="email" />
      <Field label="Password" type="password" value={password} onChange={setPassword}
        placeholder="••••••••" autoComplete="current-password" />

      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-xs text-slate-500 cursor-pointer">
          <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)}
            className="w-3.5 h-3.5 accent-[#00ffcc]" />
          Remember me
        </label>
        <button type="button" onClick={onForgot}
          className="text-xs text-slate-500 hover:text-[#00ffcc] transition-colors">
          Forgot password?
        </button>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="w-full py-2.5 rounded-lg font-semibold text-sm text-[#0a0e1a]
                   bg-[#00ffcc] hover:bg-[#00e6b8] disabled:opacity-40 transition-all
                   flex items-center justify-center gap-2"
      >
        {loading && <Loader2 size={15} className="animate-spin" />}
        Sign In
      </button>

      <p className="text-center text-xs text-slate-600">
        No account?{' '}
        <button type="button" onClick={onRegister}
          className="text-[#00ffcc] hover:text-[#00e6b8] font-medium transition-colors">
          Create one free
        </button>
      </p>
    </form>
  )
}

// ── Register form ─────────────────────────────────────────────────────────────
function RegisterForm({ onNeedVerification, onLogin }) {
  const [name,     setName]     = useState('')
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [confirm,  setConfirm]  = useState('')
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (password !== confirm) return setError('Passwords do not match')
    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/\d/.test(password))
      return setError('Password must be 8+ characters with at least one letter and one number')

    setLoading(true)
    try {
      const res  = await fetch('/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, displayName: name }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Registration failed')
      if (data.requiresVerification) {
        onNeedVerification(email, data.demoCode || null)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
          {error}
        </div>
      )}

      <Field label="Display Name" value={name} onChange={setName}
        placeholder="Your name (optional)" autoComplete="name" />
      <Field label="Email" type="email" value={email} onChange={setEmail}
        placeholder="you@example.com" autoComplete="email" />
      <div className="space-y-1.5">
        <Field label="Password" type="password" value={password} onChange={setPassword}
          placeholder="8+ chars, letter + number" autoComplete="new-password" />
        <PasswordStrength password={password} />
      </div>
      <Field label="Confirm Password" type="password" value={confirm} onChange={setConfirm}
        placeholder="Repeat password" autoComplete="new-password"
        error={confirm && password !== confirm ? 'Passwords do not match' : ''} />

      <button
        type="submit"
        disabled={loading}
        className="w-full py-2.5 rounded-lg font-semibold text-sm text-[#0a0e1a]
                   bg-[#00ffcc] hover:bg-[#00e6b8] disabled:opacity-40 transition-all
                   flex items-center justify-center gap-2"
      >
        {loading && <Loader2 size={15} className="animate-spin" />}
        Create Account
      </button>

      <p className="text-center text-xs text-slate-600">
        Already have an account?{' '}
        <button type="button" onClick={onLogin}
          className="text-[#00ffcc] hover:text-[#00e6b8] font-medium transition-colors">
          Sign in
        </button>
      </p>
    </form>
  )
}

// ── Forgot password form ──────────────────────────────────────────────────────
function ForgotForm({ onBack }) {
  const [email,   setEmail]   = useState('')
  const [sent,    setSent]    = useState(false)
  const [loading, setLoading] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setLoading(true)
    try {
      await fetch('/api/auth/forgot-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      setSent(true)
    } finally {
      setLoading(false)
    }
  }

  if (sent) {
    return (
      <div className="text-center space-y-4 py-4">
        <CheckCircle className="w-12 h-12 text-[#00ffcc] mx-auto" />
        <div>
          <h3 className="text-sm font-semibold text-white">Check your inbox</h3>
          <p className="text-xs text-slate-500 mt-1">
            If an account exists for <span className="text-slate-300">{email}</span>,
            a reset link has been sent.
          </p>
        </div>
        <button onClick={onBack} className="text-xs text-[#00ffcc] hover:underline">
          Back to sign in
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-xs text-slate-500">
        Enter your email and we'll send a password reset link.
      </p>
      <Field label="Email" type="email" value={email} onChange={setEmail}
        placeholder="you@example.com" autoComplete="email" />
      <button
        type="submit"
        disabled={loading || !email}
        className="w-full py-2.5 rounded-lg font-semibold text-sm text-[#0a0e1a]
                   bg-[#00ffcc] hover:bg-[#00e6b8] disabled:opacity-40 transition-all
                   flex items-center justify-center gap-2"
      >
        {loading && <Loader2 size={15} className="animate-spin" />}
        Send Reset Link
      </button>
      <button type="button" onClick={onBack}
        className="w-full text-xs text-slate-500 hover:text-slate-300 transition-colors">
        Back to sign in
      </button>
    </form>
  )
}

// ── Main AuthPage ─────────────────────────────────────────────────────────────
export default function AuthPage({ onContinueWithoutAccount, onBack, initialView = 'login' }) {
  const { login } = useAuth()

  // view: 'login' | 'register' | 'forgot' | 'verify'
  const [view,      setView]      = useState(initialView)
  const [verifyEmail, setVerifyEmail] = useState('')
  const [demoCode,  setDemoCode]  = useState(null)

  const TITLES = {
    login:    { h: 'Welcome back',      sub: 'Sign in to your FinSurf account'    },
    register: { h: 'Create your account', sub: 'Free forever — no credit card needed' },
    forgot:   { h: 'Reset password',    sub: 'We\'ll send a link to your email'   },
    verify:   { h: 'Verify your email', sub: 'Enter the 6-digit code we sent you' },
  }
  const { h, sub } = TITLES[view] || TITLES.login

  // Called after OTP verification succeeds — AuthContext data injected via login token
  const handleVerified = async (data) => {
    // Inject the tokens into AuthContext by calling a lightweight setter
    // We reload: AuthContext silentRefresh will pick up the cookie
    window.location.reload()
  }

  const needVerification = (email, code) => {
    setVerifyEmail(email)
    setDemoCode(code)
    setView('verify')
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8"
      style={{ background: 'linear-gradient(135deg, #060810 0%, #0a0e1a 100%)' }}>

      {/* Ambient glows */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-40 -left-40 w-80 h-80 rounded-full opacity-[0.06]"
          style={{ background: 'radial-gradient(circle, #00ffcc, transparent 70%)' }} />
        <div className="absolute -bottom-40 -right-40 w-80 h-80 rounded-full opacity-[0.05]"
          style={{ background: 'radial-gradient(circle, #6366f1, transparent 70%)' }} />
      </div>

      <div className="relative w-full max-w-md space-y-5">
        {/* Back link */}
        {onBack && view !== 'verify' && (
          <button onClick={onBack}
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors">
            <svg viewBox="0 0 16 16" fill="none" className="w-3.5 h-3.5">
              <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Back to home
          </button>
        )}

        {/* Logo + title */}
        <div className="text-center space-y-3">
          <button onClick={onBack || (() => {})} className="inline-flex items-center gap-2">
            <svg viewBox="0 0 32 32" fill="none" className="w-8 h-8">
              <path d="M4 22 L10 14 L16 18 L22 8 L28 12" stroke="#00ffcc" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M4 22 L10 14 L16 18 L22 8 L28 12" stroke="#00ffcc" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" opacity="0.12"/>
              <circle cx="16" cy="18" r="2.5" fill="#6366f1"/>
            </svg>
            <span className="font-bold text-xl tracking-tight">
              <span className="text-white">FIN</span><span style={{ color: '#00ffcc' }}>SURF</span>
            </span>
          </button>
          <div>
            <h1 className="text-xl font-bold text-white">{h}</h1>
            <p className="text-sm text-slate-500 mt-0.5">{sub}</p>
          </div>
        </div>

        {/* Tab switcher — only for login/register */}
        {(view === 'login' || view === 'register') && (
          <div className="flex bg-white/[0.04] rounded-xl p-1">
            {['login', 'register'].map(v => (
              <button key={v} onClick={() => setView(v)}
                className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${
                  view === v
                    ? 'bg-[#00ffcc]/15 text-[#00ffcc] border border-[#00ffcc]/25'
                    : 'text-slate-500 hover:text-slate-300'
                }`}>
                {v === 'login' ? 'Sign In' : 'Create Account'}
              </button>
            ))}
          </div>
        )}

        {/* Form card */}
        <div className="rounded-2xl p-6 border border-white/[0.08] shadow-2xl"
          style={{ background: 'rgba(255,255,255,0.03)', backdropFilter: 'blur(12px)' }}>

          {view === 'login' && (
            <LoginForm
              onNeedVerification={needVerification}
              onForgot={() => setView('forgot')}
              onRegister={() => setView('register')}
            />
          )}
          {view === 'register' && (
            <RegisterForm
              onNeedVerification={needVerification}
              onLogin={() => setView('login')}
            />
          )}
          {view === 'forgot' && (
            <ForgotForm onBack={() => setView('login')} />
          )}
          {view === 'verify' && (
            <VerifyEmailStep
              email={verifyEmail}
              demoCode={demoCode}
              onSuccess={handleVerified}
              onResend={(newCode) => setDemoCode(newCode)}
            />
          )}
        </div>

        {/* Guest mode */}
        {onContinueWithoutAccount && view !== 'verify' && (
          <div className="text-center">
            <button onClick={onContinueWithoutAccount}
              className="text-xs text-slate-600 hover:text-slate-400 transition-colors
                         flex items-center gap-1 mx-auto">
              <Zap className="w-3 h-3" />
              Continue without account (local data only)
            </button>
          </div>
        )}

        <p className="text-center text-[10px] text-slate-700">
          Email verified · JWT sessions · OWASP compliant · Not financial advice
        </p>
      </div>
    </div>
  )
}
