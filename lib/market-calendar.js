'use strict'
/**
 * lib/market-calendar.js — NYSE holidays and early closes, computed from the
 * exchange's published rules (idea from QuantConnect Lean's market-hours
 * database; written from scratch, no data file to go stale).
 *
 * Until this the app treated every weekday as a trading day: the paper broker
 * would try to fill on Thanksgiving, a scan ran (and spent AI credits) on
 * Christmas morning, and a bar was "still forming" until 16:00 on a day the
 * market closed at 13:00.
 *
 *   full holidays   New Year's Day, Martin Luther King Jr. Day, Washington's
 *                   Birthday, Good Friday, Memorial Day, Juneteenth (from 2022),
 *                   Independence Day, Labor Day, Thanksgiving, Christmas — a
 *                   Sunday holiday moves to Monday and a Saturday one to Friday,
 *                   EXCEPT New Year's Day on a Saturday (NYSE does not close the
 *                   Friday before, which is in the old year)
 *   special closes  SPECIAL_CLOSURES (national days of mourning, Sandy)
 *   early closes    13:00 ET on July 3 (Mon–Thu), the day after Thanksgiving,
 *                   and December 24 (Mon–Thu)
 *
 * Dates are 'YYYY-MM-DD' in New York. Pure. Tests: tests/market-calendar.test.js
 */

const SPECIAL_CLOSURES = {
  '2012-10-29': 'Hurricane Sandy', '2012-10-30': 'Hurricane Sandy',
  '2018-12-05': 'National Day of Mourning (George H. W. Bush)',
  '2025-01-09': 'National Day of Mourning (Jimmy Carter)',
}
const CLOSE = 16 * 60, EARLY = 13 * 60

const pad = n => String(n).padStart(2, '0')
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`
const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay()
/** The n-th weekday `wd` (0 Sun … 6 Sat) of a month; n = −1 for the last. */
function nthWeekday(y, m, wd, n) {
  if (n > 0) { const first = dow(y, m, 1); return 1 + ((wd - first + 7) % 7) + (n - 1) * 7 }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return last - ((dow(y, m, last) - wd + 7) % 7)
}
/** Easter Sunday (anonymous Gregorian algorithm). */
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1
  return [month, day]
}
function observed(y, m, d) {
  const w = dow(y, m, d)
  const t = new Date(Date.UTC(y, m - 1, d + (w === 0 ? 1 : w === 6 ? -1 : 0)))
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
}

const _cache = new Map()
/** { 'YYYY-MM-DD': name } of full closures in a year. */
function holidays(y) {
  if (_cache.has(y)) return _cache.get(y)
  const out = {}
  if (dow(y, 1, 1) !== 6) out[observed(y, 1, 1)] = "New Year's Day"
  if (y >= 1998) out[iso(y, 1, nthWeekday(y, 1, 1, 3))] = 'Martin Luther King Jr. Day'
  out[iso(y, 2, nthWeekday(y, 2, 1, 3))] = "Washington's Birthday"
  const [em, ed] = easter(y)
  const gf = new Date(Date.UTC(y, em - 1, ed - 2))
  out[iso(y, gf.getUTCMonth() + 1, gf.getUTCDate())] = 'Good Friday'
  out[iso(y, 5, nthWeekday(y, 5, 1, -1))] = 'Memorial Day'
  if (y >= 2022) out[observed(y, 6, 19)] = 'Juneteenth'
  out[observed(y, 7, 4)] = 'Independence Day'
  out[iso(y, 9, nthWeekday(y, 9, 1, 1))] = 'Labor Day'
  out[iso(y, 11, nthWeekday(y, 11, 4, 4))] = 'Thanksgiving'
  out[observed(y, 12, 25)] = 'Christmas'
  for (const [d, name] of Object.entries(SPECIAL_CLOSURES)) if (d.startsWith(`${y}-`)) out[d] = name
  _cache.set(y, out)
  return out
}

/** { 'YYYY-MM-DD': reason } of 13:00 closes in a year. */
function earlyCloses(y) {
  const out = {}
  if ([1, 2, 3, 4].includes(dow(y, 7, 3))) out[iso(y, 7, 3)] = 'day before Independence Day'
  const tg = nthWeekday(y, 11, 4, 4)
  out[iso(y, 11, tg + 1)] = 'day after Thanksgiving'
  if ([1, 2, 3, 4].includes(dow(y, 12, 24))) out[iso(y, 12, 24)] = 'Christmas Eve'
  return out
}

const yearOf = date => Number(String(date).slice(0, 4))
/** The holiday's name, or null. */
const holidayName = date => holidays(yearOf(date))[date] || null
/** A weekday that is not a holiday. */
function isTradingDay(date) {
  const [y, m, d] = String(date).split('-').map(Number)
  const w = dow(y, m, d)
  return w !== 0 && w !== 6 && !holidayName(date)
}
/** Minutes after midnight ET when the regular session closes that day; null when closed. */
function closeMinutes(date) {
  if (!isTradingDay(date)) return null
  return earlyCloses(yearOf(date))[date] ? EARLY : CLOSE
}

/** Today's date in New York for a timestamp. */
function nyDate(ms = Date.now()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms))
  const g = t => p.find(x => x.type === t)?.value
  return `${g('year')}-${g('month')}-${g('day')}`
}

/** The next trading day strictly after `date`. */
function nextTradingDay(date) {
  let t = Date.parse(`${date}T12:00:00Z`)
  for (let k = 0; k < 15; k++) { t += 86_400_000; const d = new Date(t).toISOString().slice(0, 10); if (isTradingDay(d)) return d }
  return null
}

module.exports = { SPECIAL_CLOSURES, CLOSE, EARLY, holidays, earlyCloses, holidayName, isTradingDay, closeMinutes, nyDate, nextTradingDay, easter }
