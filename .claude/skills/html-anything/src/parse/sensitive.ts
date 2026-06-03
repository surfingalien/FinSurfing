/**
 * Sensitive-record parser. Single dispatcher for the three
 * sensitive-domain subtypes the html-anything pack supports today:
 *
 *   - lab-results:        CSV with test/value/reference-range columns.
 *   - medical-visit:      Markdown chronological visit log.
 *   - legal-chronology:   Markdown chronological case log.
 *
 * Detection is deliberately conservative — the parser only claims a
 * file when the header pattern (CSV) or content keywords (Markdown)
 * match the subtype with high confidence. Anything else falls through
 * to the generic finance / markdown / text parsers.
 *
 * The shared aggregation produces the `DATA` shape required by the
 * `_sensitive.md` family contract: events, parties, documents,
 * missingItems, openQuestions, plus subtype-specific aggregates
 * (out-of-range rows + trends for labs; deadlines + filings for
 * legal; encounters + medications for medical visits).
 *
 * The parser does NOT classify findings. It only extracts what's in
 * the file's text. Out-of-range detection compares numeric value to
 * the row's printed reference range (no population data, no
 * guidelines). Deadline detection just lists dates the chronology
 * mentions (no statute computation). The point is to organize, not
 * to interpret.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { Parser, ParsedFile } from "../types.js"

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type SensitiveSubtype = "lab-results" | "medical-visit" | "legal-chronology"

interface SensitiveEvent {
  id: string
  kind: string             // "visit" | "lab-draw" | "filing" | "deadline" | "document" | etc.
  date: string | null      // ISO YYYY-MM-DD when extractable
  dateText: string | null  // verbatim from source
  title: string
  party: string | null
  detail: string | null
  source: { line: number | null; quote: string | null }
}

interface SensitiveParty {
  name: string
  role: string             // "Patient" | "Provider" | "Plaintiff" | etc.
  count: number            // events that reference this party
}

interface SensitiveDocument {
  id: string
  name: string
  kind: string             // "exhibit" | "form" | "scan" | "prescription" | "filing"
  date: string | null
  missing: boolean
}

interface SensitiveAggregate {
  format: SensitiveSubtype
  subtype: SensitiveSubtype
  events: SensitiveEvent[]
  parties: SensitiveParty[]
  documents: SensitiveDocument[]
  missingItems: { id: string; label: string; detail: string | null }[]
  openQuestions: { id: string; question: string; anchor: string | null }[]
  summary: {
    rowCount: number
    period: string | null
    durationLabel: string | null
    headlineCount: { label: string; value: number }[]
  }
  // Lab-only:
  rows?: LabRow[]
  outOfRange?: LabRow[]
  panels?: { name: string; count: number; outOfRangeCount: number }[]
  trends?: { test: string; unit: string; referenceLow: number | null; referenceHigh: number | null; points: { date: string | null; value: number }[] }[]
  // Medical-only:
  encounters?: Encounter[]
  medications?: Medication[]
  // Legal-only:
  caseHeader?: { caption: string | null; docket: string | null; court: string | null; matter: string | null }
  deadlines?: Deadline[]
  filings?: Filing[]
  // Drill-down:
  rawText?: string
  rawRows?: string[][]
}

interface LabRow {
  id: string
  test: string
  panel: string | null
  value: number | null
  valueText: string
  unit: string
  referenceLow: number | null
  referenceHigh: number | null
  referenceText: string
  direction: "above" | "below" | "in-range" | "no-range" | "non-numeric"
  collectedAt: string | null
  orderingProvider: string | null
  lab: string | null
  raw: Record<string, string>
}

interface Encounter {
  id: string
  date: string | null
  dateText: string | null
  encounterType: string | null
  provider: string | null
  reason: string | null
  vitals: { label: string; value: string }[]
  plan: string | null
  followUp: string | null
}

interface Medication {
  id: string
  name: string
  dose: string | null
  instructions: string | null
  prescribedDate: string | null
}

interface Deadline {
  id: string
  date: string
  daysFromToday: number | null
  source: string
  party: string | null
}

interface Filing {
  id: string
  date: string | null
  party: string | null
  title: string
  exhibits: string[]
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const LAB_TEST_HEADERS = /^(test|test name|analyte|panel test|measurement|lab test)$/i
const LAB_VALUE_HEADERS = /^(value|result|measured|measurement|level|reading)$/i
const LAB_REF_LOW_HEADERS = /^(reference low|ref low|low|range low|range_low|min)$/i
const LAB_REF_HIGH_HEADERS = /^(reference high|ref high|high|range high|range_high|max)$/i
const LAB_REF_RANGE_HEADERS = /^(reference|reference range|ref range|range|normal range|reference interval)$/i
const LAB_UNIT_HEADERS = /^(unit|units|uom)$/i

const MEDICAL_KEYWORDS = [
  "chief complaint", "hpi:", "history of present illness", "vitals",
  "blood pressure", "review of systems", "assessment and plan",
  "assessment & plan", "physical exam", "medications:", "allergies:",
  "icd-10", "icd10", "after-visit summary", "discharge summary",
  "encounter type", "office visit", "telehealth visit",
  "diabetes follow-up", "annual physical",
]

const LEGAL_KEYWORDS = [
  "plaintiff", "defendant", "petitioner", "respondent",
  "docket no", "case no", "case number", "civil action",
  "motion to ", "filed under seal", "exhibit ",
  "court of ", "u.s. district court", "superior court",
  "discovery cutoff", "motion in limine", "summary judgment",
  "deposition of ", "rule 26", "rule 12(b)",
  "in the matter of", " v. ", " vs. ",
]

interface DetectionResult {
  subtype: SensitiveSubtype
  confidence: number
}

async function detectSubtype(filepath: string): Promise<DetectionResult | null> {
  const ext = path.extname(filepath).toLowerCase()
  try {
    const raw = await fs.readFile(filepath, "utf8")
    if (ext === ".csv" || ext === ".tsv") {
      return detectLabResultsHeaders(raw, ext === ".tsv" ? "\t" : detectSep(raw))
    }
    if (ext === ".md" || ext === ".markdown" || ext === ".txt") {
      const lower = raw.toLowerCase()
      const medicalHits = MEDICAL_KEYWORDS.filter(k => lower.includes(k)).length
      const legalHits = LEGAL_KEYWORDS.filter(k => lower.includes(k)).length
      // Conservative thresholds — markdown that only happens to mention
      // "patient" or "court" without the surrounding clinical / case
      // structure should fall through to the generic markdown parser.
      if (medicalHits >= 3 && medicalHits > legalHits) {
        return { subtype: "medical-visit", confidence: medicalHits }
      }
      if (legalHits >= 3 && legalHits >= medicalHits) {
        return { subtype: "legal-chronology", confidence: legalHits }
      }
    }
  } catch {
    // Read errors fall through to other parsers.
  }
  return null
}

function detectLabResultsHeaders(raw: string, sep: string): DetectionResult | null {
  const firstLine = raw.split(/\r?\n/, 1)[0] || ""
  const headers = parseCsvRow(firstLine, sep).map(h => h.trim())
  if (headers.length < 3) return null
  const hasTest = headers.some(h => LAB_TEST_HEADERS.test(h))
  const hasValue = headers.some(h => LAB_VALUE_HEADERS.test(h))
  const hasRefLow = headers.some(h => LAB_REF_LOW_HEADERS.test(h))
  const hasRefHigh = headers.some(h => LAB_REF_HIGH_HEADERS.test(h))
  const hasRefRange = headers.some(h => LAB_REF_RANGE_HEADERS.test(h))
  const hasReference = (hasRefLow && hasRefHigh) || hasRefRange
  if (hasTest && hasValue && hasReference) {
    return { subtype: "lab-results", confidence: 5 }
  }
  return null
}

// ---------------------------------------------------------------------------
// Parser entry
// ---------------------------------------------------------------------------

export const parser: Parser = {
  name: "sensitive",
  matches: [".csv", ".tsv", ".md", ".markdown", ".txt"],
  async detect(filepath: string): Promise<boolean> {
    return (await detectSubtype(filepath)) !== null
  },
  async parse(filepath: string): Promise<ParsedFile> {
    const detection = await detectSubtype(filepath)
    if (!detection) throw new Error("sensitive: parse called on non-matching file")
    const raw = await fs.readFile(filepath, "utf8")
    const meta = {
      sourceFile: path.basename(filepath),
      sizeBytes: Buffer.byteLength(raw, "utf8"),
      subtype: detection.subtype,
    }
    let agg: SensitiveAggregate
    if (detection.subtype === "lab-results") {
      agg = aggregateLabResults(raw, path.extname(filepath).toLowerCase())
    } else if (detection.subtype === "medical-visit") {
      agg = aggregateMedicalVisit(raw)
    } else {
      agg = aggregateLegalChronology(raw)
    }
    const summary = buildSummary(agg)
    const sample = buildSample(agg)
    return {
      contentType: detection.subtype,
      summary,
      sample,
      data: agg,
      meta: {
        ...meta,
        ...agg.summary,
        format: detection.subtype,
      },
    }
  },
}

function buildSummary(agg: SensitiveAggregate): string {
  const counts = agg.summary.headlineCount.map(h => `${h.value} ${h.label}`).join(" · ")
  const period = agg.summary.period ? ` over ${agg.summary.period}` : ""
  const subtypeLabel: Record<SensitiveSubtype, string> = {
    "lab-results": "Lab-results record",
    "medical-visit": "Medical visit record",
    "legal-chronology": "Legal case chronology",
  }
  return `${subtypeLabel[agg.format]} — ${counts}${period}.`
}

function buildSample(agg: SensitiveAggregate): unknown {
  // Keep the sample tight; the full aggregate goes into `data`.
  const sample: Record<string, unknown> = {
    format: agg.format,
    subtype: agg.subtype,
    summary: agg.summary,
    parties: agg.parties.slice(0, 8),
    documentsPreview: agg.documents.slice(0, 8),
    missingItemsPreview: agg.missingItems.slice(0, 6),
    openQuestionsPreview: agg.openQuestions.slice(0, 6),
    eventsPreview: agg.events.slice(0, 12),
  }
  if (agg.format === "lab-results") {
    sample.outOfRangePreview = (agg.outOfRange || []).slice(0, 8)
    sample.panels = agg.panels
    sample.trendsPreview = (agg.trends || []).slice(0, 4)
  }
  if (agg.format === "medical-visit") {
    sample.encountersPreview = (agg.encounters || []).slice(0, 6)
    sample.medicationsPreview = (agg.medications || []).slice(0, 6)
  }
  if (agg.format === "legal-chronology") {
    sample.caseHeader = agg.caseHeader
    sample.deadlinesPreview = (agg.deadlines || []).slice(0, 8)
    sample.filingsPreview = (agg.filings || []).slice(0, 8)
  }
  return sample
}

// ---------------------------------------------------------------------------
// CSV utilities (small, no deps)
// ---------------------------------------------------------------------------

function detectSep(raw: string): string {
  const line = raw.split(/\r?\n/, 1)[0] || ""
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0, "|": 0 }
  for (const ch of line) if (ch in counts) counts[ch]++
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  return best && best[1] > 0 ? best[0] : ","
}

function parseCsvRow(line: string, sep: string): string[] {
  const out: string[] = []
  let field = ""
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += ch
    } else {
      if (ch === '"') inQuotes = true
      else if (ch === sep) { out.push(field); field = "" }
      else field += ch
    }
  }
  out.push(field)
  return out
}

function parseCsv(raw: string, sep: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let i = 0
  let inQuotes = false
  while (i < raw.length) {
    const ch = raw[i]
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false
        i++
      } else { field += ch; i++ }
    } else {
      if (ch === '"') { inQuotes = true; i++; continue }
      if (ch === sep) { row.push(field); field = ""; i++; continue }
      if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue }
      if (ch === "\r") { i++; continue }
      field += ch
      i++
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row) }
  return rows.filter(r => r.some(c => c.length > 0))
}

// ---------------------------------------------------------------------------
// Lab-results aggregation
// ---------------------------------------------------------------------------

function aggregateLabResults(raw: string, ext: string): SensitiveAggregate {
  const sep = ext === ".tsv" ? "\t" : detectSep(raw)
  const rows = parseCsv(raw, sep)
  const headers = (rows[0] || []).map(h => h.trim())
  const data = rows.slice(1)
  const idx = (re: RegExp) => headers.findIndex(h => re.test(h))

  const iTest = idx(LAB_TEST_HEADERS)
  const iValue = idx(LAB_VALUE_HEADERS)
  const iUnit = idx(LAB_UNIT_HEADERS)
  const iRefLow = idx(LAB_REF_LOW_HEADERS)
  const iRefHigh = idx(LAB_REF_HIGH_HEADERS)
  const iRefRange = idx(LAB_REF_RANGE_HEADERS)
  const iPanel = headers.findIndex(h => /^(panel|panel name|group|test group)$/i.test(h))
  const iDate = headers.findIndex(h => /^(collected|drawn|date|collection date|specimen date|test date)$/i.test(h))
  const iProvider = headers.findIndex(h => /^(provider|ordering provider|ordered by|physician)$/i.test(h))
  const iLab = headers.findIndex(h => /^(lab|laboratory|performing lab)$/i.test(h))

  const labRows: LabRow[] = data.map((r, ri): LabRow => {
    const test = (iTest >= 0 ? r[iTest] : "") || ""
    const valueText = (iValue >= 0 ? r[iValue] : "") || ""
    const unit = (iUnit >= 0 ? r[iUnit] : "") || ""
    const panel = iPanel >= 0 ? (r[iPanel] || null) : null
    const refLowRaw = iRefLow >= 0 ? r[iRefLow] : ""
    const refHighRaw = iRefHigh >= 0 ? r[iRefHigh] : ""
    const refRangeRaw = iRefRange >= 0 ? r[iRefRange] : ""
    const collectedAt = iDate >= 0 ? toIsoDate(r[iDate]) : null
    const orderingProvider = iProvider >= 0 ? (r[iProvider] || null) : null
    const lab = iLab >= 0 ? (r[iLab] || null) : null

    const value = parseNumber(valueText)
    const { low, high, label: refLabel } = resolveRange(refLowRaw, refHighRaw, refRangeRaw)
    const direction = classifyDirection(value, low, high)

    const raw: Record<string, string> = {}
    headers.forEach((h, i) => { raw[h] = (r[i] ?? "").trim() })

    return {
      id: `lab_${String(ri + 1).padStart(4, "0")}`,
      test: test.trim(),
      panel: panel ? panel.trim() : null,
      value,
      valueText: valueText.trim(),
      unit: unit.trim(),
      referenceLow: low,
      referenceHigh: high,
      referenceText: refLabel,
      direction,
      collectedAt,
      orderingProvider: orderingProvider ? orderingProvider.trim() : null,
      lab: lab ? lab.trim() : null,
      raw,
    }
  })

  const outOfRange = labRows.filter(r => r.direction === "above" || r.direction === "below")

  const panelMap = new Map<string, { count: number; outOfRangeCount: number }>()
  for (const r of labRows) {
    const key = r.panel || "Unspecified panel"
    const cur = panelMap.get(key) || { count: 0, outOfRangeCount: 0 }
    cur.count++
    if (r.direction === "above" || r.direction === "below") cur.outOfRangeCount++
    panelMap.set(key, cur)
  }
  const panels = Array.from(panelMap.entries()).map(([name, v]) => ({ name, ...v }))

  const trendMap = new Map<string, LabRow[]>()
  for (const r of labRows) {
    if (!r.test) continue
    const arr = trendMap.get(r.test) || []
    arr.push(r)
    trendMap.set(r.test, arr)
  }
  const trends = Array.from(trendMap.entries())
    .filter(([_, rs]) => rs.length >= 2 && rs.every(r => r.value !== null))
    .map(([test, rs]) => {
      const sorted = [...rs].sort((a, b) => (a.collectedAt || "").localeCompare(b.collectedAt || ""))
      return {
        test,
        unit: sorted[0].unit,
        referenceLow: sorted[0].referenceLow,
        referenceHigh: sorted[0].referenceHigh,
        points: sorted.map(s => ({ date: s.collectedAt, value: s.value as number })),
      }
    })

  // Events: one per draw-date.
  const drawDates = Array.from(new Set(labRows.map(r => r.collectedAt).filter(Boolean) as string[])).sort()
  const events: SensitiveEvent[] = drawDates.map((d, ix) => {
    const rowsOnDate = labRows.filter(r => r.collectedAt === d)
    const oo = rowsOnDate.filter(r => r.direction === "above" || r.direction === "below").length
    return {
      id: `evt_${String(ix + 1).padStart(3, "0")}`,
      kind: "lab-draw",
      date: d,
      dateText: d,
      title: `Lab draw — ${rowsOnDate.length} test${rowsOnDate.length === 1 ? "" : "s"}`,
      party: rowsOnDate[0]?.orderingProvider || null,
      detail: oo > 0 ? `${oo} value${oo === 1 ? "" : "s"} outside reference range` : "All values inside reference range",
      source: { line: null, quote: null },
    }
  })

  // Parties: ordering providers + labs.
  const partyCounts = new Map<string, { role: string; count: number }>()
  for (const r of labRows) {
    if (r.orderingProvider) {
      const key = r.orderingProvider
      const cur = partyCounts.get(key) || { role: "Ordering provider", count: 0 }
      cur.count++
      partyCounts.set(key, cur)
    }
    if (r.lab) {
      const key = r.lab
      const cur = partyCounts.get(key) || { role: "Performing lab", count: 0 }
      cur.count++
      partyCounts.set(key, cur)
    }
  }
  const parties: SensitiveParty[] = Array.from(partyCounts.entries()).map(([name, v]) => ({ name, role: v.role, count: v.count }))

  // Documents: each unique panel name as a document reference.
  const documents: SensitiveDocument[] = Array.from(panelMap.keys()).map((p, ix) => ({
    id: `doc_${String(ix + 1).padStart(3, "0")}`,
    name: p,
    kind: "lab-panel",
    date: drawDates[drawDates.length - 1] || null,
    missing: false,
  }))

  // Missing items: rows with no reference, no unit, no date, etc.
  const missingItems: { id: string; label: string; detail: string | null }[] = []
  const missingRefRows = labRows.filter(r => r.direction === "no-range")
  if (missingRefRows.length > 0) {
    missingItems.push({
      id: "missing_ref",
      label: `${missingRefRows.length} row${missingRefRows.length === 1 ? "" : "s"} have no reference range`,
      detail: missingRefRows.slice(0, 4).map(r => r.test).join(", ") + (missingRefRows.length > 4 ? "…" : ""),
    })
  }
  const missingUnitRows = labRows.filter(r => !r.unit)
  if (missingUnitRows.length > 0) {
    missingItems.push({
      id: "missing_unit",
      label: `${missingUnitRows.length} row${missingUnitRows.length === 1 ? "" : "s"} are missing the unit`,
      detail: missingUnitRows.slice(0, 4).map(r => r.test).join(", "),
    })
  }
  const missingDateRows = labRows.filter(r => !r.collectedAt)
  if (missingDateRows.length > 0) {
    missingItems.push({
      id: "missing_date",
      label: `${missingDateRows.length} row${missingDateRows.length === 1 ? "" : "s"} are missing a collection date`,
      detail: null,
    })
  }
  if (labRows.every(r => !r.orderingProvider)) {
    missingItems.push({
      id: "missing_provider",
      label: "No ordering provider listed on any row",
      detail: null,
    })
  }

  // Open questions: phrased as questions to ask.
  const openQuestions: { id: string; question: string; anchor: string | null }[] = []
  outOfRange.slice(0, 6).forEach((r, ix) => {
    const dirText = r.direction === "above" ? "above" : "below"
    const dateClause = r.collectedAt ? ` on ${r.collectedAt}` : ""
    const refClause = r.referenceText ? ` (range printed on the row: ${r.referenceText})` : ""
    openQuestions.push({
      id: `q_${String(ix + 1).padStart(3, "0")}`,
      question: `Ask the clinician whether the ${r.test} value of ${r.valueText}${r.unit ? " " + r.unit : ""}${dateClause} — outside the reference range printed on this row (${dirText} the band${refClause}) — changes the current plan.`,
      anchor: r.id,
    })
  })
  if (missingRefRows.length > 0) {
    openQuestions.push({
      id: `q_missing_ref`,
      question: `Ask whether the missing reference range on ${missingRefRows.length} row${missingRefRows.length === 1 ? "" : "s"} (${missingRefRows.slice(0, 3).map(r => r.test).join(", ")}${missingRefRows.length > 3 ? "…" : ""}) was an oversight or whether the lab uses age-specific bands not printed on the export.`,
      anchor: missingRefRows[0]?.id || null,
    })
  }

  const headlineCount = [
    { label: "lab rows", value: labRows.length },
    { label: "panels", value: panelMap.size },
    { label: "draws", value: drawDates.length },
    { label: "outside reference", value: outOfRange.length },
  ]

  const period = drawDates.length > 0
    ? (drawDates.length === 1 ? drawDates[0] : `${drawDates[0]} → ${drawDates[drawDates.length - 1]}`)
    : null
  const durationLabel = drawDates.length >= 2 ? daysBetween(drawDates[0], drawDates[drawDates.length - 1]) + " days" : null

  return {
    format: "lab-results",
    subtype: "lab-results",
    events,
    parties,
    documents,
    missingItems,
    openQuestions,
    summary: { rowCount: labRows.length, period, durationLabel, headlineCount },
    rows: labRows,
    outOfRange,
    panels,
    trends,
    rawRows: rows,
  }
}

function parseNumber(s: string): number | null {
  if (s === null || s === undefined) return null
  const cleaned = s.toString().replace(/[,\s]/g, "")
  if (!cleaned) return null
  const m = /^-?\d+(\.\d+)?$/.exec(cleaned)
  if (!m) return null
  return Number(cleaned)
}

function resolveRange(low: string, high: string, range: string): { low: number | null; high: number | null; label: string } {
  const lowN = parseNumber(low)
  const highN = parseNumber(high)
  if (lowN !== null || highN !== null) {
    const label = `${lowN ?? ""}–${highN ?? ""}`.replace(/^–/, "<").replace(/–$/, "+").trim()
    return { low: lowN, high: highN, label: label === "<+" ? "" : label }
  }
  const r = (range || "").trim()
  if (!r) return { low: null, high: null, label: "" }
  // Patterns: "0-100", "<100", ">10", "0.5-2.5", "negative"
  const dash = /^(-?\d+(?:\.\d+)?)[\s–-]+(-?\d+(?:\.\d+)?)$/
  const lt = /^<\s*(-?\d+(?:\.\d+)?)$/
  const gt = /^>\s*(-?\d+(?:\.\d+)?)$/
  let m
  if ((m = dash.exec(r))) return { low: Number(m[1]), high: Number(m[2]), label: r }
  if ((m = lt.exec(r))) return { low: null, high: Number(m[1]), label: r }
  if ((m = gt.exec(r))) return { low: Number(m[1]), high: null, label: r }
  return { low: null, high: null, label: r }
}

function classifyDirection(value: number | null, low: number | null, high: number | null): LabRow["direction"] {
  if (value === null) return "non-numeric"
  if (low === null && high === null) return "no-range"
  if (high !== null && value > high) return "above"
  if (low !== null && value < low) return "below"
  return "in-range"
}

function toIsoDate(s: string | undefined | null): string | null {
  if (!s) return null
  const t = s.trim()
  if (!t) return null
  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10)
  // mm/dd/yyyy
  const m = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/.exec(t)
  if (m) {
    const yr = m[3].length === 2 ? `20${m[3]}` : m[3]
    return `${yr}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`
  }
  // Month-name parsing — keep simple, parser doesn't need exhaustive support.
  return null
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime()
  const db = new Date(b + "T00:00:00Z").getTime()
  if (!isFinite(da) || !isFinite(db)) return 0
  return Math.round((db - da) / (24 * 3600 * 1000))
}

// ---------------------------------------------------------------------------
// Medical-visit aggregation
// ---------------------------------------------------------------------------

function aggregateMedicalVisit(raw: string): SensitiveAggregate {
  const lines = raw.split(/\r?\n/)
  const encounters: Encounter[] = []
  const medications: Medication[] = []
  let cur: Encounter | null = null
  let mode: "none" | "vitals" | "plan" | "meds" = "none"

  // Lightweight section parser: encounter blocks start at H2 / H3 headings
  // beginning with a date, "Visit", "Encounter", or "Office visit".
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed)
    if (headingMatch) {
      const level = headingMatch[1].length
      const headingText = headingMatch[2]
      // New encounter heading? Require H2/H3 (skip the H1 document title)
      // and either a date in the heading OR a strong encounter-type
      // keyword. "follow-up" alone is too noisy — it matches sub-section
      // headings — so we require it paired with "visit" / "appointment".
      const dateMatch = /(20\d{2}-\d{2}-\d{2})/.exec(headingText)
      const strongKeyword =
        /(office visit|telehealth visit|telehealth|er visit|emergency visit|hospital admission|hospital discharge|consult|specialist consult|annual physical|encounter|admission|discharge|follow-?up visit)/i.test(headingText)
      const looksLikeEncounter = level >= 2 && level <= 3 && (dateMatch !== null || strongKeyword)
      if (looksLikeEncounter) {
        if (cur) encounters.push(cur)
        cur = {
          id: `enc_${String(encounters.length + 1).padStart(3, "0")}`,
          date: dateMatch ? dateMatch[1] : null,
          dateText: dateMatch ? dateMatch[1] : null,
          encounterType: extractEncounterType(headingText),
          provider: null,
          reason: null,
          vitals: [],
          plan: null,
          followUp: null,
        }
        mode = "none"
        continue
      }
      // Sub-section heading inside an encounter.
      if (cur && /vitals?/i.test(headingText)) { mode = "vitals"; continue }
      if (cur && /(plan of care|assessment.*plan|plan)/i.test(headingText)) { mode = "plan"; continue }
      if (/medications?/i.test(headingText)) { mode = "meds"; continue }
      mode = "none"
      continue
    }
    if (cur && trimmed) {
      // Provider line.
      const provM = /^(?:Provider|Seen by|Clinician|Doctor):\s*(.+)$/i.exec(trimmed)
      if (provM) { cur.provider = provM[1]; continue }
      // Reason / Chief complaint.
      const reasonM = /^(?:Reason for visit|Chief complaint|Visit reason|CC):\s*(.+)$/i.exec(trimmed)
      if (reasonM) { cur.reason = reasonM[1]; continue }
      // Follow-up.
      const fuM = /^(?:Follow-?up|Next visit|Recall):\s*(.+)$/i.exec(trimmed)
      if (fuM) { cur.followUp = fuM[1]; continue }
      if (mode === "vitals") {
        // Lines like "BP: 138/86 mmHg" or "- HR: 78"
        const v = /^[-*\s]*([A-Z][\w\s/]*?)\s*:\s*(.+)$/.exec(trimmed)
        if (v) cur.vitals.push({ label: v[1].trim(), value: v[2].trim() })
      }
      if (mode === "plan" && !cur.plan) cur.plan = trimmed.replace(/^[-*]\s*/, "")
    }
    if (mode === "meds") {
      const m = /^[-*]\s*(.+)$/.exec(trimmed)
      if (m) {
        const text = m[1]
        const dateM = /(20\d{2}-\d{2}-\d{2})/.exec(text)
        const parts = text.split(/\s+(?:—|–|-)\s+/)
        medications.push({
          id: `med_${String(medications.length + 1).padStart(3, "0")}`,
          name: parts[0] || text,
          dose: parts[1] || null,
          instructions: parts.slice(2).join(" — ") || null,
          prescribedDate: dateM ? dateM[1] : null,
        })
      }
    }
  }
  if (cur) encounters.push(cur)

  // Events derived from encounters.
  const events: SensitiveEvent[] = encounters.map((e, ix) => ({
    id: `evt_${String(ix + 1).padStart(3, "0")}`,
    kind: "visit",
    date: e.date,
    dateText: e.dateText,
    title: e.encounterType ? `${e.encounterType}` : "Visit",
    party: e.provider,
    detail: e.reason,
    source: { line: null, quote: e.plan },
  }))

  // Parties: providers + patient (if mentioned).
  const partyCounts = new Map<string, { role: string; count: number }>()
  for (const e of encounters) {
    if (e.provider) {
      const cur = partyCounts.get(e.provider) || { role: "Provider", count: 0 }
      cur.count++
      partyCounts.set(e.provider, cur)
    }
  }
  const patientMatch = /^(?:Patient|Subject|Member):\s*(.+)$/im.exec(raw)
  if (patientMatch) {
    partyCounts.set(patientMatch[1].trim(), { role: "Patient", count: encounters.length })
  }
  const parties: SensitiveParty[] = Array.from(partyCounts.entries()).map(([name, v]) => ({ name, role: v.role, count: v.count }))

  // Documents: medications (as prescriptions), referrals, AVS handouts.
  const docMatches = Array.from(raw.matchAll(/(?:Exhibit|Form|Handout|Referral|Prescription|Order|Lab order|Imaging order)\s+([A-Z0-9-]+)/g))
  const documents: SensitiveDocument[] = docMatches.map((m, ix) => ({
    id: `doc_${String(ix + 1).padStart(3, "0")}`,
    name: m[0],
    kind: m[0].split(/\s+/)[0].toLowerCase(),
    date: null,
    missing: false,
  }))

  // Missing items.
  const missingItems: { id: string; label: string; detail: string | null }[] = []
  const noFollowUp = encounters.filter(e => !e.followUp)
  if (noFollowUp.length > 0) {
    missingItems.push({
      id: "missing_followup",
      label: `${noFollowUp.length} encounter${noFollowUp.length === 1 ? "" : "s"} have no follow-up date listed`,
      detail: noFollowUp.slice(0, 3).map(e => e.date || "(undated)").join(", "),
    })
  }
  const noProvider = encounters.filter(e => !e.provider)
  if (noProvider.length > 0) {
    missingItems.push({
      id: "missing_provider",
      label: `${noProvider.length} encounter${noProvider.length === 1 ? "" : "s"} have no named provider`,
      detail: null,
    })
  }
  const noPlan = encounters.filter(e => !e.plan)
  if (noPlan.length > 0) {
    missingItems.push({
      id: "missing_plan",
      label: `${noPlan.length} encounter${noPlan.length === 1 ? "" : "s"} have no plan-of-care line`,
      detail: null,
    })
  }
  if (medications.length === 0 && /medication/i.test(raw)) {
    missingItems.push({
      id: "missing_meds",
      label: "Medications referenced but no medication list extracted",
      detail: "The record mentions medications but the structured list was not parseable",
    })
  }

  // Open questions.
  const openQuestions: { id: string; question: string; anchor: string | null }[] = []
  encounters.forEach((e, ix) => {
    if (!e.followUp) {
      openQuestions.push({
        id: `q_followup_${ix}`,
        question: `Ask the clinic whether a follow-up date was set after the ${e.date ? `${e.date} ` : ""}${(e.encounterType || "visit").toLowerCase()} — none is recorded in this record.`,
        anchor: e.id,
      })
    }
  })
  if (medications.length >= 2) {
    openQuestions.push({
      id: "q_med_review",
      question: `Ask whether the medication list still reflects what is currently being taken — ${medications.length} medications are recorded across these visits.`,
      anchor: medications[0]?.id || null,
    })
  }
  // Vitals out of common ranges → only as an inferred prompt, never a verdict.
  for (const e of encounters) {
    for (const v of e.vitals) {
      if (/blood pressure|^bp$/i.test(v.label)) {
        const m = /(\d+)\s*\/\s*(\d+)/.exec(v.value)
        if (m && (Number(m[1]) >= 140 || Number(m[2]) >= 90)) {
          openQuestions.push({
            id: `q_bp_${e.id}`,
            question: `Ask the clinician whether the blood pressure of ${v.value} recorded${e.date ? ` on ${e.date}` : ""} — outside the reference printed in the record — changes the current plan.`,
            anchor: e.id,
          })
        }
      }
    }
  }

  // Summary.
  const dates = encounters.map(e => e.date).filter(Boolean) as string[]
  const sortedDates = [...dates].sort()
  const period = sortedDates.length > 0 ? (sortedDates.length === 1 ? sortedDates[0] : `${sortedDates[0]} → ${sortedDates[sortedDates.length - 1]}`) : null
  const durationLabel = sortedDates.length >= 2 ? daysBetween(sortedDates[0], sortedDates[sortedDates.length - 1]) + " days" : null

  const headlineCount = [
    { label: "encounters", value: encounters.length },
    { label: "providers", value: new Set(encounters.map(e => e.provider).filter(Boolean)).size },
    { label: "medications", value: medications.length },
    { label: "open questions", value: openQuestions.length },
  ]

  return {
    format: "medical-visit",
    subtype: "medical-visit",
    events,
    parties,
    documents,
    missingItems,
    openQuestions,
    summary: { rowCount: encounters.length, period, durationLabel, headlineCount },
    encounters,
    medications,
    rawText: raw,
  }
}

function extractEncounterType(heading: string): string | null {
  const m = /(Office visit|Telehealth visit|Telehealth|Consult|Specialist consult|ER visit|Emergency|Hospital admission|Hospital discharge|Annual physical|Follow-?up|Diabetes follow-?up|Annual checkup|Lab draw|Procedure)/i.exec(heading)
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
// Legal-chronology aggregation
// ---------------------------------------------------------------------------

function aggregateLegalChronology(raw: string): SensitiveAggregate {
  const lines = raw.split(/\r?\n/)
  const events: SensitiveEvent[] = []
  const filings: Filing[] = []
  const deadlines: Deadline[] = []
  const documents: SensitiveDocument[] = []
  const partyCounts = new Map<string, { role: string; count: number }>()

  // Case header — pulled from the first H1/H2 + first line that looks like a docket.
  const caption = (lines.find(l => /\sv\.\s|\svs\.\s/.test(l)) || "").replace(/^#+\s*/, "").trim() || null
  const docketM = /(Docket No\.?|Case No\.?|Case Number|Civil Action No\.?)\s*:?\s*([A-Z0-9:\-]+)/i.exec(raw)
  const docket = docketM ? docketM[2] : null
  const courtM = /(?:^|\n)\s*(?:Court|Venue):\s*(.+)/i.exec(raw)
  const court = courtM ? courtM[1].trim() : null
  const matterM = /(?:^|\n)\s*(?:Matter type|Matter|Case type):\s*(.+)/i.exec(raw)
  const matter = matterM ? matterM[1].trim() : null

  // Walk lines, picking out date-prefixed entries.
  // Patterns:
  //   - 2026-01-12: Plaintiff filed Complaint (Exhibit A)
  //   - 2026-02-04 — Discovery cutoff
  //   - * 2026-03-01: Hearing on Motion to Dismiss
  const entryRegex = /^(?:[-*\d.]+\s+)?(20\d{2}-\d{2}-\d{2})\s*[:\-—–]\s*(.+)$/

  for (let i = 0; i < lines.length; i++) {
    const m = entryRegex.exec(lines[i].trim())
    if (!m) continue
    const date = m[1]
    let text = m[2].trim()
    // Fold indented continuation lines into the same entry so wrapped
    // chronology lines don't drop their trailing "(Exhibit X)" parens.
    let j = i + 1
    while (j < lines.length && /^\s{2,}\S/.test(lines[j]) && !entryRegex.test(lines[j].trim())) {
      text += " " + lines[j].trim()
      j++
    }
    const partyMatch = /^(Plaintiff|Defendant|Petitioner|Respondent|Counsel for [\w .]+|The court|Court|Both parties|Opposing counsel)\b/i.exec(text)
    const party = partyMatch ? partyMatch[1].trim() : null
    if (party) {
      const cur = partyCounts.get(party) || { role: roleFor(party), count: 0 }
      cur.count++
      partyCounts.set(party, cur)
    }
    const isFiling = /\b(filed|files|file|filing|motion|complaint|answer|opposition|reply|brief)\b/i.test(text)
    const isDeadline = /\b(deadline|cutoff|due|by no later than|set for|hearing on|calendared for)\b/i.test(text)
    const exhibits = Array.from(text.matchAll(/Exhibit\s+([A-Z0-9]+)/g)).map(e => e[1])

    events.push({
      id: `evt_${String(events.length + 1).padStart(3, "0")}`,
      kind: isFiling ? "filing" : isDeadline ? "deadline" : "event",
      date,
      dateText: date,
      title: text,
      party,
      detail: exhibits.length > 0 ? `Exhibits: ${exhibits.join(", ")}` : null,
      source: { line: i + 1, quote: lines[i] },
    })

    if (isFiling) {
      filings.push({
        id: `fil_${String(filings.length + 1).padStart(3, "0")}`,
        date,
        party,
        title: text,
        exhibits,
      })
    }
    if (isDeadline) {
      deadlines.push({
        id: `dl_${String(deadlines.length + 1).padStart(3, "0")}`,
        date,
        daysFromToday: daysFromToday(date),
        source: text,
        party,
      })
    }
    for (const ex of exhibits) {
      if (!documents.some(d => d.name === `Exhibit ${ex}`)) {
        documents.push({
          id: `doc_${String(documents.length + 1).padStart(3, "0")}`,
          name: `Exhibit ${ex}`,
          kind: "exhibit",
          date,
          missing: !raw.includes(`Exhibit ${ex}\n`) && !new RegExp(`Exhibit ${ex}\\b.{0,80}attached`, "i").test(raw),
        })
      }
    }
  }

  // Parties from caption.
  if (caption) {
    const sides = caption.split(/\sv\.\s|\svs\.\s/)
    if (sides[0]) {
      const k = stripHeading(sides[0])
      partyCounts.set(k, { role: "Plaintiff / Petitioner", count: (partyCounts.get(k)?.count || 0) + 1 })
    }
    if (sides[1]) {
      const k = stripHeading(sides[1])
      partyCounts.set(k, { role: "Defendant / Respondent", count: (partyCounts.get(k)?.count || 0) + 1 })
    }
  }
  // Court party.
  if (court) partyCounts.set(court, { role: "Court", count: 1 })

  const parties: SensitiveParty[] = Array.from(partyCounts.entries()).map(([name, v]) => ({ name, role: v.role, count: v.count }))

  // Missing items.
  const missingItems: { id: string; label: string; detail: string | null }[] = []
  const missingExhibits = documents.filter(d => d.missing)
  if (missingExhibits.length > 0) {
    missingItems.push({
      id: "missing_exhibits",
      label: `${missingExhibits.length} exhibit${missingExhibits.length === 1 ? "" : "s"} are referenced but not present in this chronology`,
      detail: missingExhibits.map(d => d.name).join(", "),
    })
  }
  if (deadlines.some(d => !d.party)) {
    missingItems.push({
      id: "missing_deadline_party",
      label: "Some deadlines are listed without naming the responsible party",
      detail: null,
    })
  }
  if (!docket) missingItems.push({ id: "missing_docket", label: "No docket / case number found in the chronology", detail: null })
  if (!court) missingItems.push({ id: "missing_court", label: "No court / venue named in the chronology", detail: null })

  // Open questions.
  const openQuestions: { id: string; question: string; anchor: string | null }[] = []
  missingExhibits.slice(0, 4).forEach((d, ix) => {
    openQuestions.push({
      id: `q_exhibit_${ix}`,
      question: `Ask whether ${d.name} is attached to your case file — the chronology cites it but it is not present in this record.`,
      anchor: d.id,
    })
  })
  // Past deadlines without a follow-up.
  const today = new Date().toISOString().slice(0, 10)
  for (const d of deadlines) {
    if (d.date < today && !raw.includes(`responded`) && !raw.includes(`filed in response`)) {
      // Only surface a question if no responsive event after the deadline date.
      const responsiveAfter = events.some(e => e.kind === "filing" && e.date && e.date > d.date)
      if (!responsiveAfter) {
        openQuestions.push({
          id: `q_deadline_${d.id}`,
          question: `Ask counsel whether the ${d.date} deadline (${d.source}) was acknowledged in writing by the responsible party — no responsive filing is recorded after that date in the chronology.`,
          anchor: d.id,
        })
      }
    }
  }
  if (filings.length >= 2 && !filings.some(f => /granted|denied/i.test(f.title))) {
    openQuestions.push({
      id: "q_motion_status",
      question: "Ask counsel whether any of the motions listed have been ruled on — the chronology lists filings but no ruling language.",
      anchor: filings[0]?.id || null,
    })
  }

  const dates = events.map(e => e.date).filter(Boolean) as string[]
  const sortedDates = [...dates].sort()
  const period = sortedDates.length > 0 ? (sortedDates.length === 1 ? sortedDates[0] : `${sortedDates[0]} → ${sortedDates[sortedDates.length - 1]}`) : null
  const durationLabel = sortedDates.length >= 2 ? daysBetween(sortedDates[0], sortedDates[sortedDates.length - 1]) + " days" : null

  const headlineCount = [
    { label: "events", value: events.length },
    { label: "filings", value: filings.length },
    { label: "deadlines", value: deadlines.length },
    { label: "exhibits", value: documents.length },
  ]

  return {
    format: "legal-chronology",
    subtype: "legal-chronology",
    events,
    parties,
    documents,
    missingItems,
    openQuestions,
    summary: { rowCount: events.length, period, durationLabel, headlineCount },
    caseHeader: { caption, docket, court, matter },
    deadlines,
    filings,
    rawText: raw,
  }
}

function roleFor(party: string): string {
  const lower = party.toLowerCase()
  if (lower.startsWith("plaintiff")) return "Plaintiff"
  if (lower.startsWith("defendant")) return "Defendant"
  if (lower.startsWith("petitioner")) return "Petitioner"
  if (lower.startsWith("respondent")) return "Respondent"
  if (lower.startsWith("counsel")) return "Counsel"
  if (lower === "court" || lower === "the court") return "Court"
  if (lower.includes("opposing")) return "Counsel (opposing)"
  return "Party"
}

function stripHeading(s: string): string {
  return s.replace(/^#+\s*/, "").replace(/[*_`]/g, "").trim()
}

function daysFromToday(iso: string): number | null {
  const t = new Date(iso + "T00:00:00Z").getTime()
  if (!isFinite(t)) return null
  return Math.round((t - Date.now()) / (24 * 3600 * 1000))
}
