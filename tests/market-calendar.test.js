'use strict'
const mc = require('../lib/market-calendar')
const bs = require('../lib/bar-session')

// NYSE's published calendars, the source of truth these rules must reproduce.
const PUBLISHED = {
  2025: ['2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25'],
  2026: ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25'],
  2027: ['2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24'],
}

describe('NYSE holidays', () => {
  for (const [y, days] of Object.entries(PUBLISHED)) {
    it(`reproduces the published ${y} calendar`, () => {
      expect(Object.keys(mc.holidays(Number(y))).sort()).toEqual([...days].sort())
    })
  }
  it('a Saturday New Year is not observed on the Friday before (2022)', () => {
    expect(mc.holidayName('2021-12-31')).toBeNull()
    expect(mc.isTradingDay('2021-12-31')).toBe(true)
  })
  it('early closes: July 3 Mon–Thu, the day after Thanksgiving, Christmas Eve Mon–Thu', () => {
    expect(mc.earlyCloses(2025)).toEqual({ '2025-07-03': 'day before Independence Day', '2025-11-28': 'day after Thanksgiving', '2025-12-24': 'Christmas Eve' })
    expect(mc.closeMinutes('2025-11-28')).toBe(13 * 60)
    expect(mc.closeMinutes('2025-11-26')).toBe(16 * 60)
    expect(mc.closeMinutes('2025-11-27')).toBeNull()
    expect(mc.closeMinutes('2025-11-29')).toBeNull()        // Saturday
  })
  it('Easter for known years', () => {
    expect(mc.easter(2024)).toEqual([3, 31])
    expect(mc.easter(2025)).toEqual([4, 20])
  })
  it('next trading day skips weekends and holidays', () => {
    expect(mc.nextTradingDay('2026-11-25')).toBe('2026-11-27')
    expect(mc.nextTradingDay('2026-07-02')).toBe('2026-07-06')
  })
})

describe('the session clock uses it', () => {
  const at = (date, hhmm) => Date.parse(`${date}T${hhmm}:00-05:00`)       // EST dates (Nov/Dec)
  it('closed on Thanksgiving, open until 13:00 the day after', () => {
    expect(bs.usSessionOpen(at('2026-11-26', '11:00'))).toBe(false)
    expect(bs.usSessionOpen(at('2026-11-27', '12:30'))).toBe(true)
    expect(bs.usSessionOpen(at('2026-11-27', '13:30'))).toBe(false)
    expect(bs.usSessionOpen(at('2026-11-30', '13:30'))).toBe(true)
  })
  it('a bar stops forming at an early close, and never forms on a holiday', () => {
    expect(bs.isBarForming(Date.parse('2026-11-27T00:00:00Z'), { now: at('2026-11-27', '14:00') })).toBe(false)
    expect(bs.isBarForming(Date.parse('2026-11-27T00:00:00Z'), { now: at('2026-11-27', '12:00') })).toBe(true)
    expect(bs.isBarForming(Date.parse('2026-11-26T00:00:00Z'), { now: at('2026-11-26', '12:00') })).toBe(false)
  })
})

describe('the scheduler skips weekday jobs on market holidays', () => {
  it('a Mon–Fri job does not run on Thanksgiving but runs the next day', () => {
    const { isDue } = require('../lib/scheduler')
    const sched = { type: 'daily', hour: 9, minute: 30, timezone: 'America/New_York', weekdaysOnly: true }
    expect(isDue(sched, new Date('2026-11-26T14:30:00Z'))).toBe(false)
    expect(isDue(sched, new Date('2026-11-27T14:30:00Z'))).toBe(true)
  })
  it('options expiry on a Good Friday moves to Thursday', () => {
    expect(require('../lib/catalysts').marketCalendar('2025-04-01', 30)[0].date).toBe('2025-04-17')
  })
})
