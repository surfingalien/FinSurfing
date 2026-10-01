'use strict'
/**
 * The admin seed is the operator's way in when email cannot be sent. It wrote
 * a column that does not exist (`email_verified`; the schema has
 * `is_verified`), so the upsert failed silently and the admin never existed.
 */
const fs = require('fs')
const path = require('path')
const { seedAdminDB } = require('../db/adminSeed')

const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8')
const usersCols = schema.match(/CREATE TABLE IF NOT EXISTS users \(([\s\S]*?)\n\);/)[1]

test('the admin upsert uses real columns, verifies the account and applies ADMIN_PASSWORD', async () => {
  process.env.ADMIN_EMAIL = 'Owner@Example.com'
  process.env.ADMIN_PASSWORD = 'NewPass12345'
  const sql = []
  const query = jest.fn(async (text, params) => {
    sql.push({ text, params })
    if (/SELECT id FROM users/.test(text)) return { rows: [{ id: 'u1' }] }
    if (/FROM portfolios/.test(text)) return { rows: [{ id: 'p1' }] }
    return { rows: [] }
  })
  await seedAdminDB(query)
  const upsert = sql.find(s => /INSERT INTO users/.test(s.text)).text
  expect(upsert).not.toMatch(/email_verified/)
  for (const col of ['is_verified', 'password_hash', 'role']) {
    expect(upsert).toMatch(col)
    expect(usersCols).toMatch(new RegExp(`\\b${col}\\b`))
  }
  expect(upsert).toMatch(/password_hash\s*=\s*EXCLUDED\.password_hash/)
  expect(sql.find(s => /INSERT INTO users/.test(s.text)).params[0]).toBe('owner@example.com')
  delete process.env.ADMIN_EMAIL; delete process.env.ADMIN_PASSWORD
})
