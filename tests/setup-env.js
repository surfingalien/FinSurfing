'use strict'
// Runs before every test file (package.json jest.setupFiles). Points every
// learning store at a fresh temp directory so no test can append to the real
// data/ stores — see lib/data-dir.js.
const fs   = require('fs')
const os   = require('os')
const path = require('path')
process.env.FINSURF_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'finsurf-test-data-'))
