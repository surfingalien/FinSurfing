'use strict'

const t = require('../lib/thirteenf')

const row = (issuer, cusip, shares, value, extra = '') => `<ns1:infoTable><ns1:nameOfIssuer>${issuer}</ns1:nameOfIssuer><ns1:titleOfClass>COM</ns1:titleOfClass><ns1:cusip>${cusip}</ns1:cusip><ns1:value>${value}</ns1:value><ns1:shrsOrPrnAmt><ns1:sshPrnamt>${shares}</ns1:sshPrnamt><ns1:sshPrnamtType>SH</ns1:sshPrnamtType></ns1:shrsOrPrnAmt>${extra}</ns1:infoTable>`
const table = rows => `<ns1:informationTable xmlns:ns1="x">${rows.join('')}</ns1:informationTable>`

test('parses prefixed info tables; sums sub-manager rows; drops options', () => {
  const rows = t.parseInfoTable(table([row('APPLE INC', '037833100', 100, 20000), row('APPLE INC', '037833100', 50, 10000), row('APPLE INC', '037833100', 10, 500, '<ns1:putCall>Call</ns1:putCall>')]))
  expect(rows).toHaveLength(3)
  expect(t.aggregate(rows).get('037833100')).toMatchObject({ shares: 150, value: 30000 })
})

test('the diff names each move; small changes count as held', () => {
  const prev = t.aggregate(t.parseInfoTable(table([row('A', 'AAA000001', 100, 1), row('B', 'BBB000001', 100, 1), row('C', 'CCC000001', 100, 1), row('D', 'DDD000001', 100, 1)])))
  const cur = t.aggregate(t.parseInfoTable(table([row('A', 'AAA000001', 150, 1), row('B', 'BBB000001', 60, 1), row('C', 'CCC000001', 105, 1), row('E', 'EEE000001', 10, 1)])))
  const by = Object.fromEntries(t.diffHoldings(prev, cur).map(d => [d.issuer, d.action]))
  expect(by).toEqual({ A: 'added', B: 'trimmed', C: 'held', D: 'exited', E: 'new' })
})

test('the two latest ORIGINAL 13F-HRs for different quarters are used; amendments are skipped', () => {
  const subs = { filings: { recent: {
    form: ['13F-HR/A', '13F-HR', '13F-HR', '13F-HR'], reportDate: ['2026-06-30', '2026-06-30', '2026-06-30', '2026-03-31'],
    filingDate: ['2026-09-02', '2026-08-14', '2026-08-13', '2026-05-15'], accessionNumber: ['a', 'b', 'c', 'd'],
  } } }
  expect(t.latestTwo(subs).map(f => f.accession)).toEqual(['b', 'd'])
})

test('CUSIPs map to US tickers through OpenFIGI, paced in batches, and known ones are not looked up again', async () => {
  const fetchImpl = jest.fn(async (url, init) => ({ ok: true, status: 200, json: async () => JSON.parse(init.body).map(j => ({ data: [{ ticker: j.idValue === '037833100' ? 'AAPL' : 'BRK/B', exchCode: 'US', marketSector: 'Equity' }] })) }))
  const map = await t.mapCusips(['037833100', '084670702', '037833100'], { '594918104': 'MSFT' }, { fetchImpl, apiKey: 'k' })
  expect(map).toEqual({ '594918104': 'MSFT', '037833100': 'AAPL', '084670702': 'BRK.B' })
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toHaveLength(2)
})

test('the dossier sentence names the moves, and says plainly when nobody holds it', () => {
  const store = { managers: [{ period: '2026-06-30' }, { period: '2026-06-30' }, { period: '2026-03-31' }],
    bySymbol: { GOOGL: [
      { manager: 'Berkshire Hathaway', action: 'added', changePct: 45.2, value: 28e9 },
      { manager: 'Pershing Square', action: 'exited', changePct: -100, value: 0 },
      { manager: 'Akre Capital', action: 'held', changePct: 0, value: 1e8 },
    ] } }
  expect(t.describeFor('GOOGL', store)).toBe('13F filings (quarter ended 2026-06-30, filed up to 45 days later; long US positions only): of 3 tracked fund managers, 2 held GOOGL; Berkshire Hathaway added (+45.2% shares), Pershing Square sold out; 1 unchanged.')
  expect(t.describeFor('NVDA', store)).toMatch(/None of the 3 tracked fund managers held NVDA/)
  expect(t.describeFor('NVDA', null)).toBeNull()
})

test('a refresh that reads too few managers keeps the stored copy', async () => {
  t.saveStore({ ranAt: 'last-week', managers: [], bySymbol: {}, caveats: [] })
  const fetchImpl = async () => ({ ok: false, status: 503 })
  await expect(t.refresh({ fetchImpl, managers: t.MANAGERS.slice(0, 3), minManagers: 2 })).rejects.toThrow(/only 0 of 3 managers/)
  expect(t.readStore().ranAt).toBe('last-week')
})
