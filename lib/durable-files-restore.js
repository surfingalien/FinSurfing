'use strict'

/**
 * lib/durable-files-restore.js
 *
 * Child-process entry for lib/durable-files.js:restoreSync(). Pulls the stored
 * snapshots out of Postgres, writes them into data/, and prints ONE line of
 * JSON (the summary) on stdout for the parent to adopt. Anything else goes to
 * stderr. Exits non-zero on failure so the parent keeps the mirror disabled.
 */

const { restoreFromDb } = require('./durable-files')

async function main() {
  const { query, getPool } = require('../db/db')
  try {
    const summary = await restoreFromDb(query)
    process.stdout.write(JSON.stringify(summary) + '\n')
  } finally {
    try { await getPool()?.end() } catch { /* exiting anyway */ }
  }
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    e  => { process.stderr.write(`[durable-files-restore] ${e.message}\n`); process.exit(1) },
  )
}

module.exports = { main }
