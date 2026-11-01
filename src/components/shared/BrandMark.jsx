import { useId } from 'react'

/**
 * FinSurfing logo mark — "Saffron Flame": a trishul (third eye, namam, damru)
 * on a saffron-to-crimson badge with a faint rising trend line.
 * Source art: brand/logo-options/v2/4b-saffron-flame.svg and public/favicon.svg.
 * Gradient ids are per-instance so several marks on one page never collide.
 */
export default function BrandMark({ className = 'w-8 h-8', title = 'FinSurfing' }) {
  const uid = useId().replace(/:/g, '')
  const bg = `bm-bg-${uid}`, glow = `bm-g-${uid}`, horn = `bm-h-${uid}`
  return (
    <svg viewBox="0 0 120 120" className={className} role="img" aria-label={title}>
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FBBF24" /><stop offset="0.5" stopColor="#F97316" /><stop offset="1" stopColor="#BE123C" />
        </linearGradient>
        <linearGradient id={horn} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" /><stop offset="1" stopColor="#FEF3C7" />
        </linearGradient>
        <radialGradient id={glow} cx=".5" cy=".42" r=".55">
          <stop offset="0" stopColor="#FDE68A" stopOpacity=".45" /><stop offset="1" stopColor="#FDE68A" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="120" height="120" rx="28" fill={`url(#${bg})`} />
      <rect width="120" height="120" rx="28" fill={`url(#${glow})`} />
      <path d="M12 104 L34 92 L50 98 L76 80 L108 70" fill="none" stroke="#FFFFFF" strokeOpacity=".35" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <g transform="translate(15 9) scale(.75)">
        <path d="M26 16 C14 44 30 66 60 68 C44 56 36 40 26 16Z" fill={`url(#${horn})`} />
        <path d="M94 16 C106 44 90 66 60 68 C76 56 84 40 94 16Z" fill={`url(#${horn})`} />
        <path fillRule="evenodd" fill="#FFFFFF" d="M60 4 L68 36 L60 46 L52 36Z M60 25 a3.2 3.2 0 1 0 .01 0Z" />
        <circle cx="60" cy="25" r="1.4" fill="#0B1020" />
        <path d="M57.5 48 L60 80 L62.5 48Z" fill="#1E1B4B" />
        <path d="M45 84 L60 92 L45 100Z M75 84 L60 92 L75 100Z" fill="#FFFFFF" />
        <circle cx="60" cy="92" r="2.4" fill="#FFFFFF" />
      </g>
    </svg>
  )
}
