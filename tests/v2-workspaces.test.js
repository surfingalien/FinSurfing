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
  expect(app).toMatch(/if \(uiVersion !== 'v2'\) return v1Layout/)
})
