'use strict'

/**
 * lib/scheduler.js
 *
 * Lightweight in-process task scheduler — no external deps.
 *
 * Each job has a { type, hour, minute, dayOfWeek? } schedule evaluated
 * every minute via setInterval. Duplicate-run protection: a job that
 * already ran in the current clock-minute is skipped.
 *
 * Usage:
 *   scheduler.register('my-job', { name, description, schedule, handler })
 *   scheduler.start()
 */

const EventEmitter = require('events')

const JOBS    = new Map()   // id → JobDef
const RESULTS = new Map()   // id → ResultEntry
const emitter = new EventEmitter()
emitter.setMaxListeners(50)

let tickTimer = null

// ── Schedule types ────────────────────────────────────────────────────────────
// { type: 'hourly' }                                      → runs at :00 of every hour
// { type: 'daily',  hour, minute, timezone?, weekdaysOnly? } → HH:MM in given timezone (defaults to server local)
// { type: 'weekly', dayOfWeek, hour, minute, timezone? }  → dayOfWeek: 0=Sun … 6=Sat

function getTimeInZone(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: 'numeric', minute: 'numeric', weekday: 'short', hour12: false,
  }).formatToParts(now)
  const get = t => parts.find(p => p.type === t)?.value ?? ''
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return { h: parseInt(get('hour')), m: parseInt(get('minute')), dow: DOW.indexOf(get('weekday')) }
}

function isDue(schedule, now = new Date()) {
  let h, m, dow
  if (schedule.timezone) {
    const t = getTimeInZone(now, schedule.timezone)
    h = t.h; m = t.m; dow = t.dow === -1 ? now.getDay() : t.dow
  } else {
    h = now.getHours(); m = now.getMinutes(); dow = now.getDay()
  }
  if (schedule.weekdaysOnly && (dow === 0 || dow === 6)) return false
  switch (schedule.type) {
    case 'hourly':
      return m === (schedule.minute ?? 0)
    case 'daily':
      return h === schedule.hour && m === (schedule.minute ?? 0)
    case 'weekly':
      return dow === schedule.dayOfWeek && h === schedule.hour && m === (schedule.minute ?? 0)
    default:
      return false
  }
}

function nextRunText(schedule) {
  const tz = schedule.timezone ? ` ${schedule.timezone}` : ''
  const wd = schedule.weekdaysOnly ? ', Mon–Fri' : ''
  switch (schedule.type) {
    case 'hourly':  return `Every hour at :${String(schedule.minute ?? 0).padStart(2,'0')}${wd}`
    case 'daily':   return `Daily at ${String(schedule.hour).padStart(2,'0')}:${String(schedule.minute ?? 0).padStart(2,'0')}${tz}${wd}`
    case 'weekly':  {
      const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
      return `${days[schedule.dayOfWeek]} at ${String(schedule.hour).padStart(2,'0')}:${String(schedule.minute ?? 0).padStart(2,'0')}${tz}`
    }
    default: return 'Manual only'
  }
}

// ── Core operations ────────────────────────────────────────────────────────────

function register(id, { name, description, schedule, handler, enabled = true }) {
  JOBS.set(id, { id, name, description, schedule, handler, enabled })
  if (!RESULTS.has(id)) RESULTS.set(id, { status: 'idle', lastRun: null, data: null, error: null })
}

async function trigger(id) {
  const job = JOBS.get(id)
  if (!job) throw new Error(`Unknown job: ${id}`)

  RESULTS.set(id, { ...RESULTS.get(id), status: 'running', lastRun: Date.now(), error: null })
  emitter.emit('status', { id, status: 'running' })

  try {
    const data = await job.handler()
    RESULTS.set(id, { status: 'done', lastRun: Date.now(), data, error: null })
    emitter.emit('status', { id, status: 'done', data })
    return data
  } catch (e) {
    RESULTS.set(id, { status: 'failed', lastRun: Date.now(), data: null, error: e.message })
    emitter.emit('status', { id, status: 'failed', error: e.message })
    throw e
  }
}

function setEnabled(id, enabled) {
  const job = JOBS.get(id)
  if (job) JOBS.set(id, { ...job, enabled })
}

function getStatus() {
  return [...JOBS.values()].map(job => ({
    id:          job.id,
    name:        job.name,
    description: job.description,
    scheduleText: nextRunText(job.schedule),
    enabled:     job.enabled,
    result:      RESULTS.get(job.id) ?? { status: 'idle', lastRun: null, data: null, error: null },
  }))
}

// ── Tick: check all jobs every 60 seconds ──────────────────────────────────────

function start() {
  if (tickTimer) return
  const tick = () => {
    const now = new Date()
    for (const [id, job] of JOBS) {
      if (!job.enabled || !isDue(job.schedule, now)) continue
      const result = RESULTS.get(id)
      // Skip if already ran in this minute
      if (result?.lastRun) {
        const sameMinute =
          Math.floor(result.lastRun / 60_000) === Math.floor(now.getTime() / 60_000)
        if (sameMinute) continue
      }
      console.log(`[scheduler] triggering job: ${id}`)
      trigger(id).catch(e => console.error(`[scheduler] ${id} error:`, e.message))
    }
  }
  tickTimer = setInterval(tick, 60_000)
  tick()  // also run once immediately on start to check for overdue jobs
  console.log('[scheduler] started')
}

function stop() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
}

module.exports = { register, trigger, setEnabled, getStatus, start, stop, emitter }
