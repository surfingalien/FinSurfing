/**
 * AuthPage — full-screen login / register / forgot-password flow.
 * Shows when the user is not authenticated.
 * A "Continue without account" option falls back to the existing localStorage portfolio.
 */
import { useState } from 'react'
import { Eye, EyeOff, Zap, Lock, Mail, User, ArrowLeft, CheckCircle } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'

/* ── Password strength meter ──────────────────── */
function PasswordStrength({ password }) {
  if (!password) return null
  let score = 0
  if (password.length >= 8)  score++
  if (password.length >= 12) score++
  if (/[A-Z]/.test(password)) score++
  if (/\d/.test(password))    score++
  if (/[^A-Za-z0-9]/.test(password)) score++

  const label = ['', 'Weak', 'Fair', 'Good', 'Strong', 'Very Strong'][score]
  const color = ['', 'bg-red-500', 'bg-orange-400', 'bg-amber-400', 'bg-emerald-400', 'bg-emerald-500'][score]

  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex gap-1">
        {[1,2,3,4,5].map(i => (
          <div key={i} className={`h-1 flex-1 rounded-full transition-all duration-300 ${i <= score ? color : 'bg-white/[0.08]'}`} />
        ))}
      </div>
      {score > 0 && <p className={`text-[10px] font-semibold ${['','text-red-400','text-orange-400','text-amber-400','text-emerald-400','text-emerald-400'][score]}`}>{label}</p>}
    </div>
  )
}

/* ── OAuth button stub ────────────────────────── */
function OAuthButton({ provider, icon, onClick }) {
  return (
    <button type="button" onClick={onClick}
      className="flex items-center justify-center gap-2 w-full glass border border-white/[0.1] hover:border-white/[0.2] rounded-xl py-2.5 text-sm text-slate-300 hover:text-white transition-all">
      <span className="text-base">{icon}</span>
      <span>Continue with {provider}</span>
    </button>
  )
}

/* ── Field component ──────────────────────────── */
function Field({ label, icon: Icon, type = 'text', value, onChange, placeholder, error, hint, autoComplete }) {
  const [show, setShow] = useState(false)
  const isPassword = type === 'password'
  return (
    <div className="space-y-1">
      <label className="text-xs font-semibold text-slate-400">{label}</label>
      <div className="relative">
        {Icon && <Icon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />}
        <input
          type={isPassword && show ? 'text' : type}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          className={`w-full ${Icon ? 'pl-9' : 'pl-4'} ${isPassword ? 'pr-10' : 'pr-4'} py-2.5 rounded-xl bg-white/[0.06] border text-sm text-white placeholder-slate-600 outline-none focus:border-mint-500/60 focus:bg-white/[0.08] transition-all ${error ? 'border-red-500/60' : 'border-white/[0.10]'}`}
        />
        {isPassword && (
          <button type="button" tabIndex={-1}
            onClick={() => setShow(s => !s)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
            {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        )}
      </div>
      {hint && <p className="text-[10px] text-slate-600">{hint}</p>}
      {error && <p className="text-[10px] text-red-400">{error}</p>}
    </div>
  )
}

/* ── Login form ───────────────────────────────── */
function LoginForm({ onSwitchToRegister, onForgotPassword }) {
  const { login } = useAuth()
  const [email,      setEmail]      = useState('')
  const [password,   setPassword]   = useState('')
  const [rememberMe, setRememberMe] = useState(false)
  const [errors,     setErrors]     = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [apiError,   setApiError]   = useState('')

  const validate = () => {
    const e = {}
    if (!email.includes('@'))  e.email    = 'Enter a valid email'
    if (password.length < 1)   e.password = 'Password required'
    return e
  }

  const handleSubmit = async (ev) => {
    ev.preventDefault()
    const e = validate()
    if (Object.keys(e).length) { setErrors(e); return }
    setErrors({}); setApiError(''); setSubmitting(true)
    try {
      await login({ email, password, rememberMe })
    } catch (err) {
      setApiError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <Field label="Email" icon={Mail} type="email" value={email} onChange={setEmail}
        placeholder="you@example.com" error={errors.email} autoComplete="email" />
      <Field label="Password" icon={Lock} type="password" value={password} onChange={setPassword}
        placeholder="Your password" error={errors.password} autoComplete="current-password" />

      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-400">
          <input type="checkbox" checked={rememberMe} onChange={e => setRememberMe(e.target.checked)}
            className="w-3.5 h-3.5 accent-teal-400" />
          Remember me
        </label>
        <button type="button" onClick={onForgotPassword}
          className="text-xs text-mint-400 hover:underline">
          Forgot password?
        </button>
      </div>

      {apiError && (
        <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2.5">
          <Lock className="w-3.5 h-3.5 shrink-0" />{apiError}
        </div>
      )}

      <button type="submit" disabled={submitting}
        className="w-full btn-primary py-3 font-semibold flex items-center justify-center gap-2">
        {submitting
          ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Signing in…</>
          : 'Sign In'}
      </button>

      <div className="relative">
        <div className="border-t border-white/[0.08]" />
        <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-surface-300 px-3 text-[10px] text-slate-600">or</span>
      </div>

      <div className="space-y-2">
        <OAuthButton provider="Google"    icon="G" onClick={() => alert('Google OAuth coming soon — configure GOOGLE_CLIENT_ID in .env')} />
        <OAuthButton provider="Apple"     icon="⌘" onClick={() => alert('Apple OAuth coming soon')} />
        <OAuthButton provider="Microsoft" icon="⊞" onClick={() => alert('Microsoft OAuth coming soon')} />
      </div>

      <p className="text-center text-xs text-slate-500">
        No account?{' '}
        <button type="button" onClick={onSwitchToRegister} className="text-mint-400 hover:underline font-semibold">
          Create one free
        </button>
      </p>
    </form>
  )
}

/* ── Register form ────────────────────────────── */
function RegisterForm({ onSwitchToLogin }) {
  const { register } = useAuth()
  const [displayName, setDisplayName] = useState('')
  const [email,       setEmail]       = useState('')
  const [password,    setPassword]    = useState('')
  const [confirm,     setConfirm]     = useState('')
  const [errors,      setErrors]      = useState({})
  const [submitting,  setSubmitting]  = useState(false)
  const [apiError,    setApiError]    = useState('')

  const validate = () => {
    const e = {}
    if (!displayName.trim())          e.displayName = 'Name required'
    if (!email.includes('@'))         e.email       = 'Enter a valid email'
    if (password.length < 8)          e.password    = 'Min 8 characters'
    if (!/\d/.test(password))         e.password    = 'Must include a number'
    if (password !== confirm)         e.confirm     = 'Passwords do not match'
    return e
  }

  const handleSubmit = async (ev) => {
    ev.preventDefault()
    const e = validate()
    if (Object.keys(e).length) { setErrors(e); return }
    setErrors({}); setApiError(''); setSubmitting(true)
    try {
      await register({ email, password, displayName })
    } catch (err) {
      setApiError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3.5" noValidate>
      <Field label="Your name" icon={User} value={displayName} onChange={setDisplayName}
        placeholder="Jane Smith" error={errors.displayName} autoComplete="name" />
      <Field label="Email" icon={Mail} type="email" value={email} onChange={setEmail}
        placeholder="you@example.com" error={errors.email} autoComplete="email" />
      <div>
        <Field label="Password" icon={Lock} type="password" value={password} onChange={setPassword}
          placeholder="Create a strong password" error={errors.password}
          hint="Min 8 chars, include letters and numbers" autoComplete="new-password" />
        <PasswordStrength password={password} />
      </div>
      <Field label="Confirm password" icon={Lock} type="password" value={confirm} onChange={setConfirm}
        placeholder="Repeat your password" error={errors.confirm} autoComplete="new-password" />

      {apiError && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2.5">
          {apiError}
        </div>
      )}

      <p className="text-[10px] text-slate-600 leading-relaxed">
        By creating an account you agree to our Terms of Service and Privacy Policy.
        Your financial data is encrypted at rest and never sold.
      </p>

      <button type="submit" disabled={submitting}
        className="w-full btn-primary py-3 font-semibold flex items-center justify-center gap-2">
        {submitting
          ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Creating account…</>
          : 'Create Account'}
      </button>

      <p className="text-center text-xs text-slate-500">
        Already have an account?{' '}
        <button type="button" onClick={onSwitchToLogin} className="text-mint-400 hover:underline font-semibold">
          Sign in
        </button>
      </p>
    </form>
  )
}

/* ── Forgot password form ─────────────────────── */
function ForgotPasswordForm({ onBack }) {
  const { forgotPassword } = useAuth()
  const [email,     setEmail]     = useState('')
  const [sent,      setSent]      = useState(false)
  const [loading,   setLoading]   = useState(false)
  const [apiError,  setApiError]  = useState('')

  const handleSubmit = async (ev) => {
    ev.preventDefault()
    if (!email.includes('@')) { setApiError('Enter a valid email'); return }
    setApiError(''); setLoading(true)
    try {
      await forgotPassword(email)
      setSent(true)
    } catch (err) {
      setApiError(err.message)
    } finally {
      setLoading(false)
    }
  }

  if (sent) return (
    <div className="text-center space-y-4 py-4">
      <CheckCircle className="w-12 h-12 text-emerald-400 mx-auto" />
      <div>
        <p className="text-white font-semibold">Check your inbox</p>
        <p className="text-slate-400 text-sm mt-1">
          If <span className="text-mint-400">{email}</span> has an account, a reset link was sent.
        </p>
      </div>
      <button type="button" onClick={onBack}
        className="text-sm text-mint-400 hover:underline flex items-center gap-1 mx-auto">
        <ArrowLeft className="w-3.5 h-3.5" /> Back to sign in
      </button>
    </div>
  )

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <p className="text-sm text-slate-400">Enter your email and we'll send a secure reset link.</p>
      <Field label="Email address" icon={Mail} type="email" value={email} onChange={setEmail}
        placeholder="you@example.com" error={apiError} autoComplete="email" />
      <button type="submit" disabled={loading}
        className="w-full btn-primary py-3 font-semibold flex items-center justify-center gap-2">
        {loading
          ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Sending…</>
          : 'Send Reset Link'}
      </button>
      <button type="button" onClick={onBack}
        className="w-full text-sm text-slate-500 hover:text-slate-300 flex items-center justify-center gap-1 transition-colors">
        <ArrowLeft className="w-3.5 h-3.5" /> Back to sign in
      </button>
    </form>
  )
}

/* ── Main AuthPage ────────────────────────────── */
export default function AuthPage({ onContinueWithoutAccount }) {
  const [view, setView] = useState('login')  // 'login' | 'register' | 'forgot'

  const titles = {
    login:    { title: 'Welcome back', sub: 'Sign in to your FinSurf account' },
    register: { title: 'Get started free', sub: 'Create your secure portfolio account' },
    forgot:   { title: 'Reset password', sub: 'We\'ll send a secure link to your email' },
  }
  const { title, sub } = titles[view]

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-400 px-4 py-8">
      {/* Background decoration */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-40 -left-40 w-96 h-96 bg-mint-500/5 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-indigo-500/5 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-md space-y-6">
        {/* Logo */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center gap-2">
            <svg viewBox="0 0 32 32" fill="none" className="w-8 h-8">
              <path d="M4 22 L10 14 L16 18 L22 8 L28 12" stroke="#00ffcc" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M4 22 L10 14 L16 18 L22 8 L28 12" stroke="#00ffcc" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" opacity="0.12"/>
              <circle cx="16" cy="18" r="2.5" fill="#6366f1"/>
            </svg>
            <span className="font-bold text-xl tracking-tight">
              <span className="text-white">FIN</span><span className="text-mint-400">SURF</span>
            </span>
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">{title}</h1>
            <p className="text-sm text-slate-500 mt-0.5">{sub}</p>
          </div>
        </div>

        {/* Card */}
        <div className="glass rounded-2xl p-6 border border-white/[0.08] shadow-2xl">
          {/* Tab switcher — only for login/register */}
          {view !== 'forgot' && (
            <div className="flex bg-white/[0.04] rounded-xl p-1 mb-6">
              {['login', 'register'].map(v => (
                <button key={v} onClick={() => setView(v)}
                  className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${
                    view === v
                      ? 'bg-mint-500/20 text-mint-400 border border-mint-500/30'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}>
                  {v === 'login' ? 'Sign In' : 'Create Account'}
                </button>
              ))}
            </div>
          )}

          {view === 'login'    && <LoginForm    onSwitchToRegister={() => setView('register')} onForgotPassword={() => setView('forgot')} />}
          {view === 'register' && <RegisterForm onSwitchToLogin={() => setView('login')} />}
          {view === 'forgot'   && <ForgotPasswordForm onBack={() => setView('login')} />}
        </div>

        {/* Continue without account */}
        {onContinueWithoutAccount && (
          <div className="text-center">
            <button onClick={onContinueWithoutAccount}
              className="text-xs text-slate-600 hover:text-slate-400 transition-colors flex items-center gap-1 mx-auto">
              <Zap className="w-3 h-3" /> Continue without account (local data only)
            </button>
          </div>
        )}

        <p className="text-center text-[10px] text-slate-700">
          Data encrypted at rest · JWT sessions · OWASP compliant · Not financial advice
        </p>
      </div>
    </div>
  )
}
