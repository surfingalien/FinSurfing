'use strict'
/**
 * db/schema.sql is applied at boot by splitting it into statements. The old
 * split dropped every chunk that began with a comment — nearly every table,
 * users included — and cut the plpgsql function body at its inner `;`. On a
 * fresh Postgres every login was a 500 ("relation users does not exist").
 */
const fs = require('fs')
const path = require('path')
const { splitSql } = require('../lib/sql-split')

const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8')
const stmts = splitSql(schema)

test('a statement preceded by a comment is kept, not dropped', () => {
  expect(splitSql('-- header\nCREATE TABLE a (x int);\n-- next\nCREATE TABLE b (y int);'))
    .toEqual(['CREATE TABLE a (x int)', 'CREATE TABLE b (y int)'])
})

test('semicolons inside $$ bodies, quotes and comments do not split', () => {
  const sql = `CREATE FUNCTION f() RETURNS TRIGGER AS $$ BEGIN x := 1; RETURN NEW; END; $$ LANGUAGE plpgsql;
DO $tag$ BEGIN PERFORM 1; END $tag$;
INSERT INTO t VALUES ('a;b', 'it''s; fine'); -- trailing; comment
/* block; comment */ SELECT 1;`
  expect(splitSql(sql)).toEqual([
    'CREATE FUNCTION f() RETURNS TRIGGER AS $$ BEGIN x := 1; RETURN NEW; END; $$ LANGUAGE plpgsql',
    'DO $tag$ BEGIN PERFORM 1; END $tag$',
    "INSERT INTO t VALUES ('a;b', 'it''s; fine')",
    'SELECT 1',
  ])
})

test('every CREATE TABLE in the schema survives the split', () => {
  const declared = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m => m[1])
  const kept = stmts.map(s => /^CREATE TABLE IF NOT EXISTS (\w+)/.exec(s)?.[1]).filter(Boolean)
  expect(declared.length).toBeGreaterThan(10)
  expect(kept).toEqual(declared)
  expect(kept).toContain('users')
})

test('the trigger function survives whole', () => {
  const fn = stmts.find(s => s.startsWith('CREATE OR REPLACE FUNCTION set_updated_at'))
  expect(fn).toMatch(/RETURN NEW;\s*END;\s*\$\$ LANGUAGE plpgsql$/)
})

test('a view never comes before a table it reads', () => {
  const created = new Set()
  for (const s of stmts) {
    const t = /^CREATE TABLE IF NOT EXISTS (\w+)/.exec(s)?.[1]
    if (t) created.add(t)
    if (/^CREATE OR REPLACE VIEW/.test(s)) {
      for (const [, ref] of s.matchAll(/\b(?:FROM|JOIN)\s+(\w+)/gi)) expect(created.has(ref)).toBe(true)
    }
  }
})

// Code and schema were never run together against a real database: the auth
// routes wrote email_verifications.code_hash (the column is token_hash) and
// the admin seed wrote users.email_verified and holdings.avg_cost. Every
// INSERT column list in the auth paths must name columns the schema declares.
test('auth and seed INSERTs only name columns that exist in the schema', () => {
  const cols = {}
  for (const s of stmts) {
    const m = /^CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*)\)$/.exec(s)
    if (!m) continue
    cols[m[1]] = new Set(m[2].split('\n').map(l => /^\s*(\w+)\s+\w/.exec(l)?.[1]).filter(Boolean))
  }
  const sources = ['routes/auth.js', 'db/adminSeed.js'].map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8'))
  let checked = 0
  for (const src of sources) {
    for (const [, table, list] of src.matchAll(/INSERT INTO (\w+)\s*\(([^)]*)\)/g)) {
      if (!cols[table]) continue
      for (const c of list.split(',').map(x => x.trim()).filter(Boolean)) {
        expect(`${table}.${c}`).toBe(cols[table].has(c) ? `${table}.${c}` : `${table}.${c} (missing from schema)`)
        checked++
      }
    }
  }
  expect(checked).toBeGreaterThan(15)
})
