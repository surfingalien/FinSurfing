import { useState, useEffect } from 'react'
import { ExternalLink } from 'lucide-react'
import { fetchMarketNews } from '../../../services/api'

/* ── Market news feed ────────────────────────── */
export default function MarketNewsFeed({ refreshKey }) {
  const [news,    setNews]    = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetchMarketNews().then(items => {
      setNews(items.slice(0, 8))
    }).catch(() => {}).finally(() => setLoading(false))
  }, [refreshKey])

  const relTime = (d) => {
    if (!d) return ''
    const diff = Math.floor((Date.now() - d.getTime()) / 60000)
    if (diff < 60)  return `${diff}m ago`
    if (diff < 1440) return `${Math.floor(diff / 60)}h ago`
    return `${Math.floor(diff / 1440)}d ago`
  }

  if (loading) return (
    <div className="space-y-2">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="h-10 bg-white/[0.04] rounded-lg animate-pulse" />
      ))}
    </div>
  )

  if (!news.length) return (
    <p className="text-slate-600 text-xs text-center py-4">No market news available</p>
  )

  return (
    <div className="space-y-1.5">
      {news.map((n, i) => (
        <a key={i} href={n.link} target="_blank" rel="noopener noreferrer"
          className="flex items-start gap-3 p-2.5 rounded-lg hover:bg-white/[0.04] transition-colors group">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-slate-300 leading-snug group-hover:text-white transition-colors line-clamp-2">{n.title}</p>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[10px] text-slate-500">{n.publisher}</span>
              {n.time && <span className="text-[10px] text-slate-600">{relTime(n.time)}</span>}
            </div>
          </div>
          <ExternalLink className="w-3 h-3 text-slate-600 group-hover:text-mint-400 shrink-0 mt-0.5 transition-colors" />
        </a>
      ))}
    </div>
  )
}
