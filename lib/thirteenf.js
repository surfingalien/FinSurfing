'use strict'

/**
 * lib/thirteenf.js — what notable fund managers bought and sold last quarter,
 * from their SEC 13F-HR filings (keyless).
 *
 * The copilot used to say 13F holdings were "not available". They are: every
 * manager with $100M+ in US equities files a 13F within 45 days of quarter end,
 * and the information table lists each position by CUSIP. This reads the two
 * latest 13F-HR filings for a fixed list of DISCRETIONARY managers (quant and
 * market-making books — Citadel, Two Sigma, Renaissance — are left out: their
 * thousands of positions turn over mechanically and "they bought X" means
 * little), diffs them by CUSIP, and maps CUSIPs to tickers with OpenFIGI
 * (keyless, paced; `OPENFIGI_API_KEY` raises the limits). The map is kept, so
 * later runs only look up CUSIPs they have not seen.
 *
 * Limits stated with every result: holdings are as of quarter END, filed up
 * to 45 days later; only long US-listed positions are reported (no shorts,
 * no non-US holdings); options rows are excluded here.
 *
 * Pure: `parseInfoTable`, `aggregate`, `diffHoldings`, `bySymbolFrom`.
 * Tests: tests/thirteenf.test.js
 */

const path = require('path')

// Discretionary managers, CIKs verified against SEC submissions (2026-10-24).
// Greenlight and Scion stopped filing 13Fs and are not listed.
const MANAGERS = [
  [1067983, 'Berkshire Hathaway'], [1336528, 'Pershing Square'], [1350694, 'Bridgewater Associates'],
  [1656456, 'Appaloosa'], [1061768, 'Baupost Group'], [1040273, 'Third Point'], [1167483, 'Tiger Global'],
  [1135730, 'Coatue'], [1536411, 'Duquesne Family Office'], [1061165, 'Lone Pine Capital'],
  [1103804, 'Viking Global'], [1029160, 'Soros Fund Management'], [921669, 'Icahn'],
  [1541617, 'Altimeter Capital'], [1418814, 'ValueAct'], [1138995, 'Glenview Capital'],
  [1747057, 'D1 Capital'], [934639, 'Maverick Capital'], [1112520, 'Akre Capital'],
  [1791786, 'Elliott Investment Management'], [1166559, 'Gates Foundation Trust'], [1569205, 'Fundsmith'],
  [200217, 'Dodge & Cox'],
].map(([cik, name]) => ({ cik, name }))

const STALE_DAYS = 200          // a manager whose latest 13F is older than this has stopped filing
const CHANGE_PCT = 10           // a smaller share-count change is "held", not added/trimmed

// ── Pure ─────────────────────────────────────────────────────────────────────

const tag = (xml, name) => {
  const m = new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i').exec(xml)
  return m ? m[1].trim() : null
}

/** Rows of a 13F information table XML (namespace prefixes tolerated). */
function parseInfoTable(xml) {
  const rows = []
  const re = /<(?:\w+:)?infoTable>([\s\S]*?)<\/(?:\w+:)?infoTable>/gi
  let m
  while ((m = re.exec(String(xml || '')))) {
    const b = m[1]
    rows.push({
      issuer: tag(b, 'nameOfIssuer'), cusip: (tag(b, 'cusip') || '').toUpperCase(),
      value: Number(tag(b, 'value')) || 0, shares: Number(tag(b, 'sshPrnamt')) || 0,
      type: tag(b, 'sshPrnamtType'), putCall: tag(b, 'putCall'),
    })
  }
  return rows
}

/** Share positions by CUSIP (rows split across sub-managers are summed; options and principal amounts dropped). */
function aggregate(rows) {
  const m = new Map()
  for (const r of rows) {
    if (!r.cusip || r.putCall || (r.type && r.type !== 'SH')) continue
    const cur = m.get(r.cusip) || { cusip: r.cusip, issuer: r.issuer, shares: 0, value: 0 }
    cur.shares += r.shares; cur.value += r.value
    m.set(r.cusip, cur)
  }
  return m
}

/** new / exited / added / trimmed / held for every CUSIP in either quarter. */
function diffHoldings(prev, cur, { changePct = CHANGE_PCT } = {}) {
  const out = []
  for (const cusip of new Set([...prev.keys(), ...cur.keys()])) {
    const a = prev.get(cusip), b = cur.get(cusip)
    const before = a?.shares || 0, after = b?.shares || 0
    const pct = before > 0 ? ((after - before) / before) * 100 : null
    const action = !before && after ? 'new' : before && !after ? 'exited'
      : pct >= changePct ? 'added' : pct <= -changePct ? 'trimmed' : 'held'
    out.push({ cusip, issuer: (b || a).issuer, action, shares: after, prevShares: before, changePct: pct == null ? null : +pct.toFixed(1), value: b?.value ?? 0 })
  }
  return out
}

/** Reshape per-manager diffs into { SYMBOL: [ {manager, action, …} ] } using a CUSIP→ticker map. */
function bySymbolFrom(managerDiffs, cusipMap) {
  const out = {}
  let unmapped = 0
  for (const md of managerDiffs) {
    for (const d of md.changes) {
      const sym = cusipMap[d.cusip]
      if (!sym) { unmapped++; continue }
      ;(out[sym] ||= []).push({ manager: md.name, period: md.period, filed: md.filed, action: d.action, shares: d.shares, prevShares: d.prevShares, changePct: d.changePct, value: d.value })
    }
  }
  return { bySymbol: out, unmapped }
}

/** One readable sentence for the dossier (null when the symbol is not held). Pure. */
function describeFor(symbol, store) {
  const rows = store?.bySymbol?.[symbol]
  const tracked = store?.managers?.length || 0
  const period = store?.managers?.map(m => m.period).sort().at(-1)
  if (!rows?.length) return tracked ? `None of the ${tracked} tracked fund managers held ${symbol} in their latest 13F filings (quarter ended ${period}).` : null
  const word = { new: 'opened a position', exited: 'sold out', added: 'added', trimmed: 'trimmed', held: 'held steady' }
  const moved = rows.filter(r => r.action !== 'held').sort((a, b) => (b.value || 0) - (a.value || 0))
  const held = rows.filter(r => r.action === 'held')
  const parts = moved.slice(0, 6).map(r => `${r.manager} ${word[r.action]}${r.changePct != null && (r.action === 'added' || r.action === 'trimmed') ? ` (${r.changePct > 0 ? '+' : ''}${r.changePct}% shares)` : ''}`)
  return `13F filings (quarter ended ${period}, filed up to 45 days later; long US positions only): of ${tracked} tracked fund managers, ${rows.filter(r => r.action !== 'exited').length} held ${symbol}` +
    (parts.length ? `; ${parts.join(', ')}` : '') + (held.length ? `; ${held.length} unchanged` : '') + '.'
}

// ── Network ──────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function secJson(url, fetchImpl) {
  const { EDGAR_UA } = require('./filings')
  const r = await fetchImpl(url, { headers: { 'User-Agent': EDGAR_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
  if (!r.ok) throw new Error(`SEC HTTP ${r.status}`)
  return r.json()
}

async function secText(url, fetchImpl) {
  const { EDGAR_UA } = require('./filings')
  const r = await fetchImpl(url, { headers: { 'User-Agent': EDGAR_UA }, signal: AbortSignal.timeout(30_000) })
  if (!r.ok) throw new Error(`SEC HTTP ${r.status}`)
  return r.text()
}

/** The latest two original 13F-HR filings for different quarters. */
function latestTwo(submissions) {
  const r = submissions?.filings?.recent || {}
  const out = []
  for (let i = 0; i < (r.form || []).length && out.length < 2; i++) {
    if (r.form[i] !== '13F-HR') continue
    if (out.some(x => x.period === r.reportDate[i])) continue
    out.push({ accession: r.accessionNumber[i], period: r.reportDate[i], filed: r.filingDate[i] })
  }
  return out
}

async function holdingsOf(cik, filing, fetchImpl) {
  const acc = filing.accession.replace(/-/g, '')
  const idx = await secJson(`https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/index.json`, fetchImpl)
  const xmlName = (idx?.directory?.item || []).map(i => i.name).find(n => /\.xml$/i.test(n) && !/primary_doc/i.test(n))
  if (!xmlName) throw new Error('no information table in the filing')
  return aggregate(parseInfoTable(await secText(`https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/${xmlName}`, fetchImpl)))
}

/** CUSIP → US ticker via OpenFIGI, for the CUSIPs not already mapped. */
async function mapCusips(cusips, known = {}, { fetchImpl = fetch, apiKey = process.env.OPENFIGI_API_KEY || null } = {}) {
  const map = { ...known }
  const todo = [...new Set(cusips)].filter(c => !(c in map))
  const batch = apiKey ? 100 : 10
  const pause = apiKey ? 260 : 2600            // keyless: 25 requests a minute
  for (let i = 0; i < todo.length; i += batch) {
    const chunk = todo.slice(i, i + batch)
    try {
      const r = await fetchImpl('https://api.openfigi.com/v3/mapping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'X-OPENFIGI-APIKEY': apiKey } : {}) },
        body: JSON.stringify(chunk.map(c => ({ idType: 'ID_CUSIP', idValue: c }))),
        signal: AbortSignal.timeout(20_000),
      })
      if (r.status === 429) { await sleep(60_000); i -= batch; continue }
      const data = r.ok ? await r.json() : []
      chunk.forEach((c, k) => {
        const rows = data?.[k]?.data || []
        const us = rows.find(x => x.exchCode === 'US' && x.marketSector === 'Equity') || rows.find(x => x.exchCode === 'US')
        map[c] = us?.ticker ? String(us.ticker).toUpperCase().replace('/', '.') : null   // null = looked up, no US ticker
      })
    } catch { /* leave unmapped; retried next run */ }
    if (i + batch < todo.length) await sleep(pause)
  }
  return map
}

// ── Store + job ──────────────────────────────────────────────────────────────
const STORE_FILE = path.join(require('./data-dir').DATA_DIR, 'thirteenf.json')

function readStore(file = STORE_FILE) {
  try { return JSON.parse(require('fs').readFileSync(file, 'utf8')) } catch { return null }
}

function saveStore(s, file = STORE_FILE) {
  require('fs').mkdirSync(path.dirname(file), { recursive: true })
  require('./atomic-write').writeJsonAtomic(file, s)
}

/** Read every manager's last two 13Fs, diff, map, persist. Keeps the stored copy when too few managers load. */
async function refresh({ fetchImpl = fetch, managers = MANAGERS, now = new Date(), save = true, minManagers = 10 } = {}) {
  const prior = readStore()
  const diffs = [], skipped = []
  for (const m of managers) {
    try {
      const subs = await secJson(`https://data.sec.gov/submissions/CIK${String(m.cik).padStart(10, '0')}.json`, fetchImpl)
      const [cur, prev] = latestTwo(subs)
      if (!cur || !prev) { skipped.push({ manager: m.name, reason: 'fewer than two 13F filings' }); continue }
      if ((now - Date.parse(cur.filed)) / 86_400_000 > STALE_DAYS) { skipped.push({ manager: m.name, reason: `latest 13F filed ${cur.filed}` }); continue }
      await sleep(150)
      const a = await holdingsOf(m.cik, prev, fetchImpl); await sleep(150)
      const b = await holdingsOf(m.cik, cur, fetchImpl); await sleep(150)
      diffs.push({ cik: m.cik, name: m.name, period: cur.period, prevPeriod: prev.period, filed: cur.filed, positions: b.size, changes: diffHoldings(a, b) })
    } catch (e) { skipped.push({ manager: m.name, reason: e.message }) }
  }
  if (diffs.length < Math.min(minManagers, managers.length)) {
    throw new Error(`only ${diffs.length} of ${managers.length} managers' 13Fs could be read — the stored copy is kept`)
  }
  const cusipMap = await mapCusips(diffs.flatMap(d => d.changes.map(c => c.cusip)), prior?.cusipMap || {}, { fetchImpl })
  const { bySymbol, unmapped } = bySymbolFrom(diffs, cusipMap)
  const store = {
    ranAt: now.toISOString(),
    managers: diffs.map(({ changes, ...m }) => m), skipped, unmapped, cusipMap, bySymbol,
    caveats: ['Holdings are as of quarter end and filed up to 45 days later.', 'Only long US-listed positions are reported: no shorts, no non-US holdings; options are excluded here.', 'Share classes are separate lines (GOOGL and GOOG), so switching classes reads as a trim of one and an add to the other.'],
  }
  if (save) saveStore(store)
  return store
}

module.exports = {
  MANAGERS, STALE_DAYS, CHANGE_PCT, STORE_FILE,
  parseInfoTable, aggregate, diffHoldings, bySymbolFrom, describeFor, latestTwo, mapCusips,
  readStore, saveStore, refresh,
}
