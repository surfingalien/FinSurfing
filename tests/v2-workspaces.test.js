// v2 workspace layout (src/v2): every page the app can route to must be
// reachable from a v2 workspace, exactly once, so switching to v2 never hides
// a feature. Read as text because the front end is ESM and Jest runs Node.
const fs = require('fs')
const path = require('path')

const src = (f) => fs.readFileSync(path.join(__dirname, '../src', f), 'utf8')
const workspaces = JSON.parse(src('v2/workspaces.json'))

function allTabs() {
  const nav = src('navigation.js')
  const groups = nav.slice(nav.indexOf('export const NAV_GROUPS'), nav.indexOf('export const ADMIN_GROUP'))
  const ids = [...groups.matchAll(/\{\s*id:\s*'([^']+)'/g)].map(m => m[1])
  const extra = nav.match(/const EXTRA_TABS = \[([^\]]*)\]/)[1]
  ids.push(...[...extra.matchAll(/'([^']+)'/g)].map(m => m[1]))
  return new Set(ids)
}

test('every routable page sits in exactly one v2 workspace', () => {
  const tabs = allTabs()
  expect(tabs.size).toBeGreaterThan(40)
  const seen = new Map()
  for (const w of workspaces) for (const t of w.tabs) {
    expect(seen.has(t) ? `${t} in ${seen.get(t)} and ${w.id}` : null).toBeNull()
    seen.set(t, w.id)
  }
  const missing = [...tabs].filter(t => !seen.has(t))
  const unknown = [...seen.keys()].filter(t => !tabs.has(t))
  expect(missing).toEqual([])
  expect(unknown).toEqual([])
})

test('only the admin workspace is admin-only, and it holds only the admin page', () => {
  const admin = workspaces.filter(w => w.admin)
  expect(admin.map(w => w.id)).toEqual(['admin'])
  expect(admin[0].tabs).toEqual(['admin'])
})

test('v1 stays the default and v2 is loaded lazily', () => {
  expect(src('v2/useUiVersion.js')).toMatch(/const DEFAULT_VERSION = 'v1'/)
  const app = src('App.jsx')
  expect(app).toMatch(/const V2Shell\s*=\s*lazy\(\(\) => import\('\.\/v2\/V2Shell'\)\)/)
  expect(app).toMatch(/if \(uiVersion !== 'v2' && uiVersion !== 'v3'\) return v1Layout/)
})

// Everything v1 offers outside the pages themselves (sidebar + header) must
// have a home in v2 as well.
test('v2 carries every control v1 has around the pages', () => {
  const shell = src('v2/V2Shell.jsx') + src('v2/V2Ticker.jsx')
  const needs = {
    'portfolio account switcher': /<AccountSwitcher/,
    'create portfolio': /<CreatePortfolioModal/,
    'manage portfolios': /onNavigate\('portfolios'\)/,
    'API keys': /<ApiKeysModal/,
    'API keys required warning': /hasAnyKey/,
    'change password': /<ChangePasswordModal/,
    'sign out': /onLogout=\{logout\}/,
    'sign in': /onClick=\{onSignIn\}/,
    'command palette': /onClick=\{onOpenPalette\}/,
    'light/dark theme': /toggleLightMode\(\)/,
    'pro mode': /toggleProMode\(\)/,
    'version switch': /<VersionSwitch/,
    'alerts badge': /triggeredCount/,
    'live ticker': /subscribeQuotes\(TICKER_SYMBOLS/,
    'market status + clock': /etMarketOpen/,
    'locked pages for guests': /p\.auth && !isAuthenticated/,
    'admin only for admins': /user\?\.role === 'admin'/,
    'NEW / LIVE tags': /p\.tag/,
  }
  const missing = Object.entries(needs).filter(([, re]) => !re.test(shell)).map(([k]) => k)
  expect(missing).toEqual([])
})

// v3 (src/v3, the redesign from the Dev preview) — the same guarantees.
describe('v3 redesign', () => {
  const v3 = JSON.parse(src('v3/workspaces.json'))

  test('every routable page sits in exactly one v3 workspace', () => {
    const tabs = allTabs()
    const seen = new Map()
    for (const w of v3) for (const t of w.tabs) {
      expect(seen.has(t) ? `${t} in ${seen.get(t)} and ${w.id}` : null).toBeNull()
      seen.set(t, w.id)
    }
    expect([...tabs].filter(t => !seen.has(t))).toEqual([])
    expect([...seen.keys()].filter(t => !tabs.has(t))).toEqual([])
    for (const w of v3) {
      expect(typeof w.group).toBe('string')
      expect(w.headline.length).toBeGreaterThan(5)
    }
  })

  test('v3 carries every control v1 has around the pages', () => {
    const shell = src('v3/V3Shell.jsx') + src('v2/V2Ticker.jsx')
    const needs = {
      'portfolio account switcher': /<AccountSwitcher/,
      'create portfolio': /<CreatePortfolioModal/,
      'manage portfolios': /onNavigate\('portfolios'\)/,
      'API keys': /<ApiKeysModal/,
      'API keys required warning': /hasAnyKey/,
      'change password': /<ChangePasswordModal/,
      'sign out': /onLogout=\{logout\}/,
      'sign in': /onClick=\{onSignIn\}/,
      'command palette': /onClick=\{onOpenPalette\}/,
      'theme toggle': /toggleTheme/,
      'version switch': /<VersionSwitch/,
      'alerts badge': /triggeredCount/,
      'live ticker': /<Ticker prefix="v3"/,
      'locked pages for guests': /p\.auth && !isAuthenticated/,
      'admin only for admins': /user\?\.role === 'admin'/,
      'NEW / LIVE tags': /p\.tag/,
      'Ask Copilot': /finsurf:open-copilot/,
    }
    const missing = Object.entries(needs).filter(([, re]) => !re.test(shell)).map(([k]) => k)
    expect(missing).toEqual([])
    expect(src('components/Copilot/FinSurfCopilot.jsx')).toMatch(/addEventListener\('finsurf:open-copilot'/)
  })

  test('v3 is lazy, and its styles only apply while v3 is showing', () => {
    expect(src('App.jsx')).toMatch(/const V3Shell\s*=\s*lazy\(\(\) => import\('\.\/v3\/V3Shell'\)\)/)
    const css = src('v3/v3.css').replace(/\/\*[\s\S]*?\*\//g, '')
    const selectors = css.split('}').map(r => r.split('{')[0].trim()).filter(Boolean)
      .filter(s => !s.startsWith('@media') && !s.startsWith('@'))
    const loose = selectors.flatMap(s => s.split(',').map(x => x.trim()))
      .filter(x => x && !/^(html\.v3|\.v3-)/.test(x))
    expect(loose).toEqual([])
  })
})
