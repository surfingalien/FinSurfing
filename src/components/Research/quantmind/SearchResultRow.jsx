import { Loader2, ExternalLink, Plus } from 'lucide-react'

// ── Search result row (compact) ───────────────────────────────────────────────
export default function SearchResultRow({ result, onLoad, loading }) {
  return (
    <div className="flex items-start gap-3 py-3 border-b border-slate-700/40 last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-slate-200 leading-snug mb-0.5 line-clamp-2">{result.title}</p>
        <p className="text-xs text-slate-500">
          {(result.authors || []).slice(0, 2).join(', ')}
          {result.authors?.length > 2 ? ' et al.' : ''}
          {' · '}{result.published?.slice(0, 10)}
          {' · '}<span className="text-slate-600">{(result.categories || []).slice(0, 2).join(', ')}</span>
        </p>
        {result.abstract && (
          <p className="text-xs text-slate-500 mt-1 line-clamp-2">{result.abstract}</p>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <a
          href={result.source_url} target="_blank" rel="noreferrer"
          className="text-slate-600 hover:text-violet-400 transition-colors"
          title="Open abstract"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
        {result.loaded ? (
          <span className="text-xs text-emerald-500 font-medium">Loaded</span>
        ) : (
          <button
            onClick={() => onLoad(result.arxiv_id)}
            disabled={loading}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-violet-600/80 hover:bg-violet-500 disabled:opacity-40 text-white text-xs font-medium transition-colors"
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
            Load
          </button>
        )}
      </div>
    </div>
  )
}
