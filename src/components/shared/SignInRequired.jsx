import { Lock, LogIn } from 'lucide-react'

/**
 * Shown in place of an AI or scan view when no one is signed in (the landing
 * page's demo mode). Those features spend paid model calls and show the AI's
 * results, so they need an account; the server refuses them without one too.
 */
export default function SignInRequired({ onSignIn }) {
  return (
    <div className="max-w-md mx-auto mt-16 glass rounded-2xl border border-white/[0.08] p-8 text-center space-y-4">
      <div className="mx-auto w-12 h-12 rounded-full bg-mint-500/10 border border-mint-500/20 flex items-center justify-center">
        <Lock className="w-5 h-5 text-mint-400" />
      </div>
      <h2 className="text-lg font-semibold text-white">Sign in to use this</h2>
      <p className="text-sm text-slate-400">
        AI analysis, the AI Brain and the scans are available to signed-in users only.
        Market data, charts and your watchlist stay open in the demo.
      </p>
      {onSignIn && (
        <button onClick={onSignIn} className="btn-primary inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold">
          <LogIn className="w-4 h-4" /> Sign in
        </button>
      )}
    </div>
  )
}
