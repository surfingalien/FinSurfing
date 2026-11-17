'use strict'
/**
 * Worker-thread entry for lib/strategy-sweep.js:runSweep. Runs one grid and
 * posts the slim result, or `{ error }` — it never throws past this file, so a
 * bad sweep is one failed experiment and not a dead worker with no message.
 */
const { parentPort, workerData } = require('worker_threads')

try {
  parentPort.postMessage(require('./strategy-sweep').evaluateGrid(workerData))
} catch (e) {
  parentPort.postMessage({ error: e.message })
}
