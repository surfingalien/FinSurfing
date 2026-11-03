// A v3 page can replace its workspace's eyebrow + headline (the Dev preview's
// Home opens on the day's market brief, not a fixed title). The shell clears
// the override whenever the page changes.
import { createContext, useContext, useEffect } from 'react'

export const HeroContext = createContext({ setHero: () => {} })

export function useHero(hero) {
  const { setHero } = useContext(HeroContext)
  const key = hero ? `${hero.eyebrow}|${hero.headline}` : ''
  useEffect(() => {
    setHero(hero)
    return () => setHero(null)
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
}
