'use strict'
/** Every link in the Quant Lab reference must point at a tab or route that exists — read as text (the file is ESM). */
const fs = require('fs')
const path = require('path')
const ref = fs.readFileSync(path.join(__dirname, '../src/components/QuantLab/reference.js'), 'utf8')
const nav = fs.readFileSync(path.join(__dirname, '../src/navigation.js'), 'utf8')
const lab = fs.readFileSync(path.join(__dirname, '../src/components/QuantLab/QuantLabView.jsx'), 'utf8')

const routeIds = new Set([...nav.matchAll(/\{ id: '([a-z0-9-]+)'/g)].map(m => m[1]))
const labTabs = new Set([...ref.match(/QUANT_TABS = \[([^\]]*)\]/)[1].matchAll(/'([a-z]+)'/g)].map(m => m[1]))
const data = ref.slice(0, ref.indexOf('export const QUANT_TABS'))
const wheres = [...data.matchAll(/(?:Q\('([a-z]+)'\)|'([a-z][a-z-]+)'\])/g)]

test('Quant Lab is registered in the navigation and every lab tab is rendered by the view', () => {
  expect(routeIds.has('quant-lab')).toBe(true)
  for (const t of labTabs) expect(lab).toContain(`['${t}',`)
})
test('every reference link targets an existing Quant Lab tab or app route', () => {
  expect(wheres.length).toBeGreaterThan(150)
  for (const m of wheres) { if (m[1]) expect(labTabs.has(m[1])).toBe(true); else expect(routeIds.has(m[2])).toBe(true) }
})
test('the reference carries the full vocabulary, strategy, model and algorithm lists', () => {
  const rows = name => (ref.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\n\\]`))[1].match(/\[['"]/g) || []).length
  expect(rows('TERMS')).toBe(100); expect(rows('PLAYBOOK')).toBe(8); expect(ref.match(/, null\]/g)).toBeNull(); expect(rows('STRATEGIES')).toBe(30); expect(rows('MODELS')).toBe(20); expect(rows('ML_ALGOS')).toBe(20)
})
