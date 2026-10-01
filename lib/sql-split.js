'use strict'

/**
 * lib/sql-split.js — split a .sql file into executable statements.
 *
 * server.js used to split db/schema.sql on `;\n` and then DROP every chunk
 * that started with `--`. Nearly every table in the schema is preceded by a
 * section-header comment, so `CREATE TABLE users` and most others were never
 * run: on a fresh Postgres the users table did not exist and every login was
 * a 500. The naive split also cut the plpgsql function body (which contains
 * `;`) in half.
 *
 * This is a small scanner instead: it splits on `;` only outside single- and
 * double-quoted strings, dollar-quoted bodies ($$ … $$ or $tag$ … $tag$), and
 * comments; line (`--`) and block comments are removed rather than used to
 * decide whether a statement exists.
 *
 * Pure. Tests: tests/sql-split.test.js
 */
function splitSql(text) {
  const src = String(text || '')
  const out = []
  let cur = ''
  let i = 0
  const push = () => { const s = cur.trim(); if (s) out.push(s); cur = '' }

  while (i < src.length) {
    const c = src[i], n = src[i + 1]

    // line comment
    if (c === '-' && n === '-') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    // block comment
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? src.length : end + 2
      cur += ' '
      continue
    }
    // quoted string / identifier ('' and "" escape by doubling)
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < src.length) {
        if (src[j] === c) { if (src[j + 1] === c) { j += 2; continue } break }
        j++
      }
      cur += src.slice(i, j + 1)
      i = j + 1
      continue
    }
    // dollar-quoted body: $$ … $$ or $tag$ … $tag$
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i))
      if (m) {
        const tag = m[0]
        const end = src.indexOf(tag, i + tag.length)
        const stop = end === -1 ? src.length : end + tag.length
        cur += src.slice(i, stop)
        i = stop
        continue
      }
    }
    if (c === ';') { push(); i++; continue }
    cur += c
    i++
  }
  push()
  return out
}

module.exports = { splitSql }
