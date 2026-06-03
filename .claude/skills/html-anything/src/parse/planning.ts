/**
 * Planning / project parser. Handles three formats with one shared
 * dispatcher + sub-parser model:
 *
 *   - ics-calendar   — RFC-5545 `.ics` calendar exports (Google Calendar,
 *                      Outlook, Apple Calendar, Fastmail) with VEVENT
 *                      blocks
 *   - trello-board   — Trello board JSON export (`{ id, name, lists,
 *                      cards, members, labels, ... }`)
 *   - issue-tracker  — issue / task CSV from Linear, Jira, GitHub
 *                      Issues, Asana, ClickUp, or a generic project
 *                      tracker — detected by header columns
 *                      (status / state, title / summary, plus one
 *                      tracker-shaped column)
 *
 * The parser normalizes all three into a unified "items" array plus
 * format-specific aggregations (`calendar` for ICS; `tasks` for Trello +
 * issue CSVs). The LLM picks the right framing from `contentType` and
 * the `_planning.md` family prompt.
 *
 * The parser only normalizes — it doesn't pick which item is "stale" in
 * a nuanced way or score bottlenecks beyond simple heuristics. The
 * narrative judgment is the LLM's job in the planning prompts.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { Parser, ParsedFile } from "../types.js"

// ---------------------------------------------------------------------------
// Public parser
// ---------------------------------------------------------------------------

type Kind = "ics-calendar" | "trello-board" | "issue-tracker"

interface Item {
  id: string
  title: string
  kind: "event" | "card" | "issue"
  start?: string
  end?: string
  startEpoch?: number
  endEpoch?: number
  durationMinutes?: number
  allDay?: boolean
  status?: string
  statusBucket?: "open" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled" | "unknown"
  priority?: string
  priorityRank?: number
  assignees?: string[]
  owner?: string
  labels?: string[]
  list?: string
  project?: string
  url?: string
  description?: string
  organizer?: string
  location?: string
  rrule?: string
  due?: string
  dueEpoch?: number
  createdEpoch?: number
  updatedEpoch?: number
  ageDays?: number
  staleDays?: number
  isStale?: boolean
  isOverdue?: boolean
  isCompleted?: boolean
  raw?: Record<string, unknown>
}

const ICS_HEAD = /^\s*BEGIN:VCALENDAR/i

export const parser: Parser = {
  name: "planning",
  matches: [".ics", ".ical", ".ifb", ".vcs", ".json", ".csv"],
  async detect(filepath: string): Promise<boolean> {
    const ext = path.extname(filepath).toLowerCase()
    if (ext === ".ics" || ext === ".ical" || ext === ".ifb" || ext === ".vcs") {
      try {
        const head = await readHead(filepath, 4096)
        return ICS_HEAD.test(head.replace(/^﻿/, ""))
      } catch { return false }
    }
    if (ext === ".json") {
      try {
        const raw = await fs.readFile(filepath, "utf8")
        const obj = JSON.parse(raw)
        return looksLikeTrelloBoard(obj)
      } catch { return false }
    }
    if (ext === ".csv") {
      try {
        const head = await readHead(filepath, 4096)
        const firstLine = head.split(/\r?\n/, 1)[0] || ""
        return looksLikeIssueCsvHeader(firstLine)
      } catch { return false }
    }
    return false
  },
  async parse(filepath: string): Promise<ParsedFile> {
    const ext = path.extname(filepath).toLowerCase()
    const raw = await fs.readFile(filepath, "utf8")
    const meta: Record<string, unknown> & { sourceFile: string; sizeBytes: number } = {
      sourceFile: path.basename(filepath),
      sizeBytes: Buffer.byteLength(raw, "utf8"),
    }
    if (ext === ".ics" || ext === ".ical" || ext === ".ifb" || ext === ".vcs") {
      return parseIcs(raw, meta)
    }
    if (ext === ".json") {
      return parseTrello(raw, meta)
    }
    return parseIssueCsv(raw, meta)
  },
}

async function readHead(filepath: string, n: number): Promise<string> {
  const fd = await fs.open(filepath, "r")
  const buf = Buffer.alloc(n)
  const { bytesRead } = await fd.read(buf, 0, buf.length, 0)
  await fd.close()
  return buf.subarray(0, bytesRead).toString("utf8")
}

// ===========================================================================
// ICS calendar parser
// ===========================================================================

interface IcsEvent {
  uid?: string
  summary?: string
  description?: string
  location?: string
  organizer?: string
  attendees: string[]
  start?: string
  end?: string
  startEpoch?: number
  endEpoch?: number
  allDay?: boolean
  status?: string
  rrule?: string
  categories: string[]
}

function parseIcs(raw: string, meta: Record<string, unknown> & { sourceFile: string; sizeBytes: number }): ParsedFile {
  const lines = unfoldIcs(raw.replace(/^﻿/, "").replace(/\r\n/g, "\n").split("\n"))
  const events: IcsEvent[] = []
  let calName: string | undefined
  let prodId: string | undefined
  let cur: IcsEvent | null = null

  for (const line of lines) {
    const m = line.match(/^([A-Z][A-Z0-9-]*)((?:;[^:]*)?):(.*)$/)
    if (!m) continue
    const [, key, paramsBlob, value] = m
    const upper = key.toUpperCase()
    if (upper === "BEGIN" && value === "VEVENT") {
      cur = { attendees: [], categories: [] }
      continue
    }
    if (upper === "END" && value === "VEVENT") {
      if (cur) events.push(cur)
      cur = null
      continue
    }
    if (!cur) {
      if (upper === "X-WR-CALNAME") calName = decodeIcsValue(value)
      else if (upper === "PRODID") prodId = decodeIcsValue(value)
      continue
    }
    const params = parseIcsParams(paramsBlob)
    switch (upper) {
      case "UID": cur.uid = decodeIcsValue(value); break
      case "SUMMARY": cur.summary = decodeIcsValue(value); break
      case "DESCRIPTION": cur.description = decodeIcsValue(value); break
      case "LOCATION": cur.location = decodeIcsValue(value); break
      case "STATUS": cur.status = decodeIcsValue(value).toLowerCase(); break
      case "RRULE": cur.rrule = decodeIcsValue(value); break
      case "ORGANIZER": {
        const cn = params.get("CN")
        cur.organizer = cn || decodeIcsValue(value).replace(/^mailto:/i, "")
        break
      }
      case "ATTENDEE": {
        const cn = params.get("CN")
        const who = cn || decodeIcsValue(value).replace(/^mailto:/i, "")
        if (who) cur.attendees.push(who)
        break
      }
      case "CATEGORIES": {
        for (const c of decodeIcsValue(value).split(",")) {
          const t = c.trim()
          if (t) cur.categories.push(t)
        }
        break
      }
      case "DTSTART":
      case "DTEND": {
        const isAllDay = params.get("VALUE") === "DATE" || /^\d{8}$/.test(value)
        const epoch = parseIcsTime(value, params.get("TZID"))
        const iso = epoch != null ? toIso(epoch, isAllDay) : value
        if (upper === "DTSTART") {
          cur.start = iso
          cur.startEpoch = epoch ?? undefined
        } else {
          cur.end = iso
          cur.endEpoch = epoch ?? undefined
        }
        if (isAllDay) cur.allDay = true
        break
      }
    }
  }

  // Drop events with no usable start
  const usable = events.filter(e => e.startEpoch != null)
  usable.sort((a, b) => (a.startEpoch! - b.startEpoch!))

  const items: Item[] = usable.map((e, i) => {
    const dur = e.startEpoch != null && e.endEpoch != null
      ? Math.max(0, Math.round((e.endEpoch - e.startEpoch) / 60000))
      : (e.allDay ? 24 * 60 : undefined)
    return {
      id: `i_${String(i + 1).padStart(4, "0")}`,
      title: e.summary || "(untitled event)",
      kind: "event",
      start: e.start,
      end: e.end,
      startEpoch: e.startEpoch,
      endEpoch: e.endEpoch,
      durationMinutes: dur,
      allDay: e.allDay,
      status: e.status,
      statusBucket: bucketIcsStatus(e.status),
      organizer: e.organizer,
      assignees: e.attendees.length ? e.attendees : undefined,
      owner: e.organizer,
      labels: e.categories.length ? e.categories : undefined,
      location: e.location,
      description: e.description,
      rrule: e.rrule,
      isCompleted: e.status === "completed",
    }
  })

  const calendar = buildCalendarAggregations(items)
  const dateRange = describeRange(items[0]?.startEpoch, items[items.length - 1]?.startEpoch)

  meta.format = "ics"
  meta.kind = "ics-calendar"
  meta.eventCount = items.length
  meta.dateRange = dateRange
  meta.calendarName = calName
  meta.prodId = prodId
  meta.totalMinutes = calendar.totalMinutes
  meta.uniqueAttendees = calendar.uniqueAttendees

  return {
    contentType: "ics-calendar",
    summary: `${calName ? `${calName}: ` : ""}${items.length} events, ${dateRange}, ${formatHours(calendar.totalMinutes)} of scheduled time across ${calendar.uniqueAttendees} unique participant${calendar.uniqueAttendees === 1 ? "" : "s"}.`,
    sample: buildSample(items, "calendar", calendar, undefined),
    data: { kind: "calendar", format: "ics", items, calendar, totals: calendar.totals, meta: { ...meta }, calendarName: calName },
    meta,
  }
}

const ICS_UNFOLD = /^[ \t]/
function unfoldIcs(lines: string[]): string[] {
  const out: string[] = []
  for (const ln of lines) {
    if (ICS_UNFOLD.test(ln) && out.length > 0) {
      out[out.length - 1] += ln.slice(1)
    } else {
      out.push(ln)
    }
  }
  return out
}

function parseIcsParams(blob: string): Map<string, string> {
  const m = new Map<string, string>()
  if (!blob) return m
  // blob looks like ";TZID=America/New_York;CN=Alex"
  for (const part of blob.split(";")) {
    if (!part) continue
    const eq = part.indexOf("=")
    if (eq < 0) continue
    const k = part.slice(0, eq).trim().toUpperCase()
    let v = part.slice(eq + 1).trim()
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    m.set(k, v)
  }
  return m
}

function decodeIcsValue(v: string): string {
  return v
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
}

function parseIcsTime(value: string, tzid: string | undefined): number | null {
  // YYYYMMDD (all-day)
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(value)
  if (m) {
    const d = Date.UTC(+m[1], +m[2] - 1, +m[3])
    return Number.isFinite(d) ? d : null
  }
  // YYYYMMDDTHHmmssZ (utc)
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value)
  if (m) {
    const d = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
    return Number.isFinite(d) ? d : null
  }
  // YYYYMMDDTHHmmss (floating or TZID-prefixed local) — best-effort treat as UTC
  // for stable bucketing. The presentation layer can re-localize using
  // the rendered string if needed.
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(value)
  if (m) {
    const d = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
    return Number.isFinite(d) ? d : null
  }
  return null
}

function toIso(epoch: number, allDay: boolean): string {
  const d = new Date(epoch)
  const date = d.toISOString().slice(0, 10)
  if (allDay) return date
  return `${date} ${d.toISOString().slice(11, 16)}`
}

function bucketIcsStatus(s: string | undefined): Item["statusBucket"] {
  if (!s) return "open"
  const x = s.toLowerCase()
  if (x === "confirmed") return "open"
  if (x === "tentative") return "open"
  if (x === "cancelled") return "cancelled"
  if (x === "completed") return "done"
  return "open"
}

// ===========================================================================
// Trello board parser
// ===========================================================================

interface TrelloRoot {
  id?: string
  name?: string
  desc?: string
  url?: string
  shortUrl?: string
  closed?: boolean
  prefs?: unknown
  lists?: TrelloList[]
  cards?: TrelloCard[]
  members?: TrelloMember[]
  labels?: TrelloLabel[]
  checklists?: TrelloChecklist[]
  actions?: unknown[]
}

interface TrelloList { id?: string; name?: string; closed?: boolean; pos?: number }
interface TrelloMember { id?: string; fullName?: string; username?: string }
interface TrelloLabel { id?: string; name?: string; color?: string | null }
interface TrelloChecklistItem { state?: string; name?: string }
interface TrelloChecklist { id?: string; idCard?: string; checkItems?: TrelloChecklistItem[] }
interface TrelloCard {
  id?: string
  name?: string
  desc?: string
  idList?: string
  idMembers?: string[]
  idLabels?: string[]
  closed?: boolean
  due?: string | null
  dueComplete?: boolean
  dateLastActivity?: string
  url?: string
  shortUrl?: string
  pos?: number
  labels?: TrelloLabel[]
}

function looksLikeTrelloBoard(o: unknown): boolean {
  if (!o || typeof o !== "object") return false
  const r = o as TrelloRoot
  if (!Array.isArray(r.lists) || !Array.isArray(r.cards)) return false
  if (typeof r.name !== "string" && typeof r.id !== "string") return false
  // Trello lists always have id+name, cards always have id+name+idList
  const list = r.lists[0]
  const card = r.cards[0]
  if (list && typeof list === "object" && (typeof list.id !== "string" || typeof list.name !== "string")) return false
  if (card && typeof card === "object" && (typeof card.id !== "string" || typeof card.idList !== "string")) return false
  return true
}

function parseTrello(raw: string, meta: Record<string, unknown> & { sourceFile: string; sizeBytes: number }): ParsedFile {
  const root = JSON.parse(raw) as TrelloRoot
  const listById = new Map<string, TrelloList>()
  for (const l of root.lists || []) if (l.id) listById.set(l.id, l)
  const memberById = new Map<string, TrelloMember>()
  for (const m of root.members || []) if (m.id) memberById.set(m.id, m)
  const labelById = new Map<string, TrelloLabel>()
  for (const l of root.labels || []) if (l.id) labelById.set(l.id, l)
  const checklistsByCard = new Map<string, TrelloChecklist[]>()
  for (const cl of root.checklists || []) {
    if (!cl.idCard) continue
    const arr = checklistsByCard.get(cl.idCard) || []
    arr.push(cl)
    checklistsByCard.set(cl.idCard, arr)
  }

  const now = Date.now()
  const items: Item[] = []
  let i = 0
  for (const card of root.cards || []) {
    if (!card || card.closed) continue
    i += 1
    const list = card.idList ? listById.get(card.idList) : undefined
    const status = list?.name || "Unknown"
    const statusBucket = bucketTaskStatus(status)
    const assignees = (card.idMembers || []).map(id => {
      const m = memberById.get(id)
      return m?.fullName || m?.username || id
    }).filter(Boolean)
    const labels = [
      ...(card.idLabels || []).map(id => labelById.get(id)?.name || "").filter(Boolean),
      ...(card.labels || []).map(l => l?.name || "").filter(Boolean),
    ]
    const dueEpoch = card.due ? Date.parse(card.due) : undefined
    const updatedEpoch = card.dateLastActivity ? Date.parse(card.dateLastActivity) : undefined
    const ageDays = updatedEpoch && Number.isFinite(updatedEpoch) ? Math.floor((now - updatedEpoch) / 86400000) : undefined
    const isCompleted = !!card.dueComplete || statusBucket === "done"
    const isOverdue = !isCompleted && dueEpoch != null && dueEpoch < now
    const checklists = checklistsByCard.get(card.id || "") || []
    const checklistTotal = checklists.reduce((n, cl) => n + (cl.checkItems?.length || 0), 0)
    const checklistDone = checklists.reduce((n, cl) => n + (cl.checkItems || []).filter(ci => ci.state === "complete").length, 0)
    items.push({
      id: `i_${String(i).padStart(4, "0")}`,
      title: card.name || "(untitled card)",
      kind: "card",
      status,
      statusBucket,
      assignees: assignees.length ? assignees : undefined,
      owner: assignees[0],
      labels: labels.length ? Array.from(new Set(labels)) : undefined,
      list: list?.name,
      project: root.name,
      url: card.shortUrl || card.url,
      description: card.desc?.slice(0, 4000),
      due: dueEpoch ? toIso(dueEpoch, false) : undefined,
      dueEpoch,
      updatedEpoch,
      ageDays,
      staleDays: !isCompleted ? ageDays : undefined,
      isStale: !isCompleted && ageDays != null && ageDays >= 14,
      isOverdue,
      isCompleted,
      raw: checklistTotal ? { checklistDone, checklistTotal } : undefined,
    })
  }

  const tasks = buildTaskAggregations(items)
  meta.format = "trello"
  meta.kind = "trello-board"
  meta.boardName = root.name
  meta.itemCount = items.length
  meta.statuses = Object.keys(tasks.statusCounts)

  return {
    contentType: "trello-board",
    summary: `Trello board "${root.name || "Untitled"}": ${items.length} open card${items.length === 1 ? "" : "s"} across ${tasks.lanes.length} list${tasks.lanes.length === 1 ? "" : "s"}, ${tasks.assigneeCounts.length} member${tasks.assigneeCounts.length === 1 ? "" : "s"}.`,
    sample: buildSample(items, "tasks", undefined, tasks),
    data: { kind: "tasks", format: "trello", items, tasks, totals: tasks.totals, board: { name: root.name, url: root.shortUrl || root.url }, meta: { ...meta } },
    meta,
  }
}

// ===========================================================================
// Issue CSV parser (Linear, Jira, GitHub Issues, Asana, ClickUp, generic)
// ===========================================================================

const TITLE_HEADERS = ["title", "summary", "name", "issue title", "task", "task name"]
const STATUS_HEADERS = ["status", "state", "stage"]
const ASSIGNEE_HEADERS = ["assignee", "assignees", "owner", "responsible", "owners", "members"]
const PRIORITY_HEADERS = ["priority", "severity"]
const ID_HEADERS = ["id", "identifier", "issue key", "key", "number", "task id", "ticket"]
const PROJECT_HEADERS = ["project", "team", "milestone", "epic", "sprint", "iteration", "cycle"]
const LABEL_HEADERS = ["labels", "label", "tags", "tag", "components"]
const DUE_HEADERS = ["due date", "due", "deadline", "target date"]
const CREATED_HEADERS = ["created", "created at", "created date", "opened", "opened at"]
const UPDATED_HEADERS = ["updated", "updated at", "last updated", "modified", "last modified", "last activity"]
const ESTIMATE_HEADERS = ["estimate", "story points", "points", "effort"]
const URL_HEADERS = ["url", "link"]
const REPORTER_HEADERS = ["reporter", "creator", "created by"]

function looksLikeIssueCsvHeader(line: string): boolean {
  const sep = line.includes("\t") ? "\t" : line.includes(";") && !line.includes(",") ? ";" : ","
  const headers = parseCsvRow(line, sep).map(h => h.trim().toLowerCase())
  if (headers.length < 3) return false
  const hasTitle = headers.some(h => TITLE_HEADERS.includes(h))
  const hasStatus = headers.some(h => STATUS_HEADERS.includes(h))
  const hasAssignee = headers.some(h => ASSIGNEE_HEADERS.includes(h))
  const hasPriority = headers.some(h => PRIORITY_HEADERS.includes(h))
  const hasId = headers.some(h => ID_HEADERS.includes(h))
  const hasProject = headers.some(h => PROJECT_HEADERS.includes(h))
  const hasLabels = headers.some(h => LABEL_HEADERS.includes(h))
  const hasDue = headers.some(h => DUE_HEADERS.includes(h))
  const hasReporter = headers.some(h => REPORTER_HEADERS.includes(h))
  // Strong signal: title + status + at least one tracker-shaped column
  if (hasTitle && hasStatus) {
    return hasAssignee || hasPriority || hasId || hasProject || hasLabels || hasDue || hasReporter
  }
  return false
}

function parseIssueCsv(raw: string, meta: Record<string, unknown> & { sourceFile: string; sizeBytes: number }): ParsedFile {
  const firstLineEnd = raw.indexOf("\n")
  const firstLine = firstLineEnd < 0 ? raw : raw.slice(0, firstLineEnd)
  const sep = firstLine.includes("\t") ? "\t" : firstLine.includes(";") && !firstLine.includes(",") ? ";" : ","
  const rows = parseCsvAll(raw, sep)
  const headers = (rows.shift() || []).map(h => h.trim())
  const headersLc = headers.map(h => h.toLowerCase())

  const findIdx = (cands: string[]): number => {
    for (const c of cands) {
      const i = headersLc.indexOf(c)
      if (i >= 0) return i
    }
    return -1
  }
  const idIdx = findIdx(ID_HEADERS)
  const titleIdx = findIdx(TITLE_HEADERS)
  const statusIdx = findIdx(STATUS_HEADERS)
  const assigneeIdx = findIdx(ASSIGNEE_HEADERS)
  const priorityIdx = findIdx(PRIORITY_HEADERS)
  const projectIdx = findIdx(PROJECT_HEADERS)
  const labelIdx = findIdx(LABEL_HEADERS)
  const dueIdx = findIdx(DUE_HEADERS)
  const createdIdx = findIdx(CREATED_HEADERS)
  const updatedIdx = findIdx(UPDATED_HEADERS)
  const estimateIdx = findIdx(ESTIMATE_HEADERS)
  const urlIdx = findIdx(URL_HEADERS)
  const reporterIdx = findIdx(REPORTER_HEADERS)
  const descIdx = headersLc.findIndex(h => h === "description" || h === "body")

  const detectedFlavor = detectIssueFlavor(headersLc)

  const now = Date.now()
  const items: Item[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (!r || r.every(c => !c.trim())) continue
    const title = (titleIdx >= 0 ? (r[titleIdx] || "").trim() : "") || "(untitled)"
    const status = statusIdx >= 0 ? (r[statusIdx] || "").trim() : undefined
    const priority = priorityIdx >= 0 ? (r[priorityIdx] || "").trim() : undefined
    const assigneesRaw = assigneeIdx >= 0 ? (r[assigneeIdx] || "").trim() : ""
    const assignees = assigneesRaw ? splitMulti(assigneesRaw) : []
    const labelsRaw = labelIdx >= 0 ? (r[labelIdx] || "").trim() : ""
    const labels = labelsRaw ? splitMulti(labelsRaw) : []
    const project = projectIdx >= 0 ? (r[projectIdx] || "").trim() : undefined
    const dueEpoch = parseFlexibleDate(dueIdx >= 0 ? (r[dueIdx] || "") : "")
    const createdEpoch = parseFlexibleDate(createdIdx >= 0 ? (r[createdIdx] || "") : "")
    const updatedEpoch = parseFlexibleDate(updatedIdx >= 0 ? (r[updatedIdx] || "") : "")
    const url = urlIdx >= 0 ? (r[urlIdx] || "").trim() : undefined
    const description = descIdx >= 0 ? (r[descIdx] || "").trim().slice(0, 4000) : undefined
    const reporter = reporterIdx >= 0 ? (r[reporterIdx] || "").trim() : undefined
    const estimate = estimateIdx >= 0 ? (r[estimateIdx] || "").trim() : undefined
    const externalId = idIdx >= 0 ? (r[idIdx] || "").trim() : undefined

    const statusBucket = bucketTaskStatus(status)
    const isCompleted = statusBucket === "done" || statusBucket === "cancelled"
    const referenceEpoch = updatedEpoch ?? createdEpoch
    const ageDays = referenceEpoch != null ? Math.max(0, Math.floor((now - referenceEpoch) / 86400000)) : undefined
    const isOverdue = !isCompleted && dueEpoch != null && dueEpoch < now

    const itemRaw: Record<string, unknown> = {}
    if (externalId) itemRaw.externalId = externalId
    if (reporter) itemRaw.reporter = reporter
    if (estimate) itemRaw.estimate = estimate

    items.push({
      id: `i_${String(i + 1).padStart(4, "0")}`,
      title,
      kind: "issue",
      status,
      statusBucket,
      priority,
      priorityRank: rankPriority(priority),
      assignees: assignees.length ? assignees : undefined,
      owner: assignees[0],
      labels: labels.length ? labels : undefined,
      list: project,
      project,
      url: url || undefined,
      description,
      due: dueEpoch ? toIso(dueEpoch, false) : undefined,
      dueEpoch,
      createdEpoch,
      updatedEpoch,
      ageDays,
      staleDays: !isCompleted ? ageDays : undefined,
      isStale: !isCompleted && ageDays != null && ageDays >= 21,
      isOverdue,
      isCompleted,
      raw: Object.keys(itemRaw).length ? itemRaw : undefined,
    })
  }

  const tasks = buildTaskAggregations(items)
  meta.format = detectedFlavor.format
  meta.flavor = detectedFlavor.flavor
  meta.kind = "issue-tracker"
  meta.itemCount = items.length
  meta.headers = headers

  return {
    contentType: "issue-tracker",
    summary: `${detectedFlavor.label} issue list: ${items.length} item${items.length === 1 ? "" : "s"}, ${tasks.openCount} open / ${tasks.inProgressCount} in progress / ${tasks.doneCount} done, ${tasks.assigneeCounts.length} owner${tasks.assigneeCounts.length === 1 ? "" : "s"}.`,
    sample: buildSample(items, "tasks", undefined, tasks),
    data: { kind: "tasks", format: detectedFlavor.format, flavor: detectedFlavor.flavor, items, tasks, totals: tasks.totals, headers, meta: { ...meta } },
    meta,
  }
}

interface IssueFlavor { format: string; flavor: string; label: string }

function detectIssueFlavor(headersLc: string[]): IssueFlavor {
  const hs = new Set(headersLc)
  // Linear export: "ID" + "Title" + "Status" + "Estimate" + "Cycle" / "Project"
  if (hs.has("identifier") && hs.has("title") && (hs.has("cycle") || hs.has("estimate") || hs.has("project"))) {
    return { format: "linear-csv", flavor: "linear", label: "Linear" }
  }
  // Jira CSV: "Issue key" + "Summary" + "Status" + "Issue Type"
  if (hs.has("issue key") || (hs.has("summary") && hs.has("issue type"))) {
    return { format: "jira-csv", flavor: "jira", label: "Jira" }
  }
  // GitHub Issues CSV (gh issue list --json then csv): typically has number/title/state/labels
  if (hs.has("number") && hs.has("title") && hs.has("state")) {
    return { format: "github-csv", flavor: "github", label: "GitHub Issues" }
  }
  // Asana / ClickUp tend to use "Task Name" + "Section / Column" + "Assignee"
  if (hs.has("task name") || hs.has("task")) {
    return { format: "task-csv", flavor: "task-tracker", label: "Task tracker" }
  }
  return { format: "issue-csv", flavor: "generic", label: "Generic issue tracker" }
}

// ===========================================================================
// Shared aggregations
// ===========================================================================

interface CalendarAgg {
  totalMinutes: number
  uniqueAttendees: number
  weeks: Array<{ weekOf: string; count: number; totalMinutes: number; overloaded: boolean }>
  busyHours: Array<{ day: string; hourCounts: number[] }>
  topAttendees: Array<{ name: string; count: number; minutes: number }>
  topOrganizers: Array<{ name: string; count: number; minutes: number }>
  longestEvents: Array<{ id: string; title: string; minutes: number; start?: string }>
  recurring: Array<{ title: string; count: number; rrule?: string }>
  backToBackBlocks: Array<{ start: string; end: string; count: number; minutes: number }>
  meetingFreeStreaks: Array<{ start: string; end: string; days: number }>
  totals: {
    events: number
    cancelled: number
    minutes: number
    distinctTitles: number
  }
}

function buildCalendarAggregations(items: Item[]): CalendarAgg {
  const minutesByAttendee = new Map<string, { count: number; minutes: number }>()
  const minutesByOrganizer = new Map<string, { count: number; minutes: number }>()
  const weeks = new Map<string, { count: number; minutes: number }>()
  const busyHours: Array<{ day: string; hourCounts: number[] }> = [
    { day: "Mon", hourCounts: Array(24).fill(0) },
    { day: "Tue", hourCounts: Array(24).fill(0) },
    { day: "Wed", hourCounts: Array(24).fill(0) },
    { day: "Thu", hourCounts: Array(24).fill(0) },
    { day: "Fri", hourCounts: Array(24).fill(0) },
    { day: "Sat", hourCounts: Array(24).fill(0) },
    { day: "Sun", hourCounts: Array(24).fill(0) },
  ]
  let cancelled = 0
  let totalMinutes = 0
  const titleCounts = new Map<string, { count: number; rrule?: string }>()

  for (const it of items) {
    if (it.statusBucket === "cancelled") cancelled++
    const mins = it.durationMinutes ?? 60
    if (it.statusBucket !== "cancelled") totalMinutes += mins
    if (it.assignees) {
      for (const a of it.assignees) {
        const cur = minutesByAttendee.get(a) || { count: 0, minutes: 0 }
        cur.count++
        cur.minutes += mins
        minutesByAttendee.set(a, cur)
      }
    }
    if (it.owner) {
      const cur = minutesByOrganizer.get(it.owner) || { count: 0, minutes: 0 }
      cur.count++
      cur.minutes += mins
      minutesByOrganizer.set(it.owner, cur)
    }
    if (it.startEpoch != null) {
      const d = new Date(it.startEpoch)
      const dayIdx = (d.getUTCDay() + 6) % 7 // Mon=0
      if (!it.allDay) {
        const hr = d.getUTCHours()
        if (hr >= 0 && hr < 24) busyHours[dayIdx].hourCounts[hr]++
      }
      const wk = isoWeekKey(d)
      const cur = weeks.get(wk) || { count: 0, minutes: 0 }
      cur.count++
      cur.minutes += mins
      weeks.set(wk, cur)
    }
    if (it.title) {
      const t = normalizeTitle(it.title)
      const cur = titleCounts.get(t) || { count: 0, rrule: it.rrule }
      cur.count++
      if (!cur.rrule && it.rrule) cur.rrule = it.rrule
      titleCounts.set(t, cur)
    }
  }

  // Overloaded weeks: > 25 hours of meetings or > 25 events
  const weeksArr = Array.from(weeks.entries())
    .map(([weekOf, v]) => ({ weekOf, count: v.count, totalMinutes: v.minutes, overloaded: v.minutes > 25 * 60 || v.count > 25 }))
    .sort((a, b) => a.weekOf.localeCompare(b.weekOf))

  const topAttendees = Array.from(minutesByAttendee.entries())
    .map(([name, v]) => ({ name, count: v.count, minutes: v.minutes }))
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 12)
  const topOrganizers = Array.from(minutesByOrganizer.entries())
    .map(([name, v]) => ({ name, count: v.count, minutes: v.minutes }))
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 8)

  const longestEvents = items
    .filter(it => it.statusBucket !== "cancelled" && it.durationMinutes && it.durationMinutes > 0)
    .sort((a, b) => (b.durationMinutes! - a.durationMinutes!))
    .slice(0, 6)
    .map(it => ({ id: it.id, title: it.title, minutes: it.durationMinutes!, start: it.start }))

  const recurring = Array.from(titleCounts.entries())
    .filter(([, v]) => v.count >= 2)
    .map(([title, v]) => ({ title, count: v.count, rrule: v.rrule }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)

  const backToBackBlocks = computeBackToBackBlocks(items)
  const meetingFreeStreaks = computeMeetingFreeStreaks(items)

  return {
    totalMinutes,
    uniqueAttendees: minutesByAttendee.size,
    weeks: weeksArr,
    busyHours,
    topAttendees,
    topOrganizers,
    longestEvents,
    recurring,
    backToBackBlocks,
    meetingFreeStreaks,
    totals: {
      events: items.length,
      cancelled,
      minutes: totalMinutes,
      distinctTitles: titleCounts.size,
    },
  }
}

function computeBackToBackBlocks(items: Item[]): CalendarAgg["backToBackBlocks"] {
  const sorted = items
    .filter(it => it.statusBucket !== "cancelled" && it.startEpoch != null && it.endEpoch != null && !it.allDay)
    .sort((a, b) => a.startEpoch! - b.startEpoch!)
  const blocks: CalendarAgg["backToBackBlocks"] = []
  let curStart: number | null = null
  let curEnd: number | null = null
  let curCount = 0
  for (const it of sorted) {
    if (curEnd == null || it.startEpoch! > curEnd + 15 * 60_000) {
      if (curCount >= 3 && curStart != null && curEnd != null) {
        blocks.push({
          start: toIso(curStart, false),
          end: toIso(curEnd, false),
          count: curCount,
          minutes: Math.round((curEnd - curStart) / 60_000),
        })
      }
      curStart = it.startEpoch!
      curEnd = it.endEpoch!
      curCount = 1
    } else {
      curEnd = Math.max(curEnd, it.endEpoch!)
      curCount += 1
    }
  }
  if (curCount >= 3 && curStart != null && curEnd != null) {
    blocks.push({
      start: toIso(curStart, false),
      end: toIso(curEnd, false),
      count: curCount,
      minutes: Math.round((curEnd - curStart) / 60_000),
    })
  }
  return blocks.sort((a, b) => b.count - a.count).slice(0, 6)
}

function computeMeetingFreeStreaks(items: Item[]): CalendarAgg["meetingFreeStreaks"] {
  // Spans of >= 24 working hours with no events.
  const days = new Set<string>()
  for (const it of items) {
    if (it.statusBucket === "cancelled" || it.startEpoch == null) continue
    days.add(new Date(it.startEpoch).toISOString().slice(0, 10))
  }
  if (days.size === 0) return []
  const sortedDays = Array.from(days).sort()
  const first = new Date(sortedDays[0]).getTime()
  const last = new Date(sortedDays[sortedDays.length - 1]).getTime()
  const streaks: CalendarAgg["meetingFreeStreaks"] = []
  let prev = first
  for (const d of sortedDays) {
    const cur = new Date(d).getTime()
    const gap = (cur - prev) / 86400000
    if (gap >= 2) {
      streaks.push({
        start: new Date(prev + 86400000).toISOString().slice(0, 10),
        end: new Date(cur - 86400000).toISOString().slice(0, 10),
        days: Math.floor(gap) - 1,
      })
    }
    prev = cur
  }
  return streaks
    .filter(s => s.days >= 2 && new Date(s.start).getTime() >= first && new Date(s.end).getTime() <= last)
    .sort((a, b) => b.days - a.days)
    .slice(0, 4)
}

interface TaskAgg {
  statusCounts: Record<string, number>
  statusBucketCounts: Record<string, number>
  priorityCounts: Array<{ priority: string; count: number; rank: number }>
  assigneeCounts: Array<{ name: string; open: number; in_progress: number; done: number; total: number; oldestStaleDays: number }>
  lanes: Array<{ name: string; count: number; openCount: number; doneCount: number }>
  labelCounts: Array<{ label: string; count: number }>
  staleItems: Array<{ id: string; title: string; ageDays: number; owner?: string; status?: string }>
  overdueItems: Array<{ id: string; title: string; due?: string; owner?: string; status?: string }>
  bottlenecks: Array<{ name: string; openCount: number; oldestStaleDays: number }>
  cycleTime: { medianDays: number | null; p95Days: number | null }
  openCount: number
  inProgressCount: number
  inReviewCount: number
  doneCount: number
  blockedCount: number
  cancelledCount: number
  totals: {
    items: number
    open: number
    inProgress: number
    inReview: number
    done: number
    blocked: number
    cancelled: number
    overdue: number
    stale: number
  }
}

function buildTaskAggregations(items: Item[]): TaskAgg {
  const statusCounts: Record<string, number> = {}
  const statusBucketCounts: Record<string, number> = { open: 0, in_progress: 0, in_review: 0, done: 0, blocked: 0, cancelled: 0, unknown: 0 }
  const priorityMap = new Map<string, { count: number; rank: number }>()
  const assigneeMap = new Map<string, { open: number; in_progress: number; done: number; total: number; oldestStaleDays: number }>()
  const laneMap = new Map<string, { count: number; openCount: number; doneCount: number }>()
  const labelMap = new Map<string, number>()
  const cycleSamples: number[] = []

  for (const it of items) {
    const s = (it.status || "Unknown").trim() || "Unknown"
    statusCounts[s] = (statusCounts[s] || 0) + 1
    const bucket = it.statusBucket || "unknown"
    statusBucketCounts[bucket] = (statusBucketCounts[bucket] || 0) + 1
    if (it.priority) {
      const cur = priorityMap.get(it.priority) || { count: 0, rank: rankPriority(it.priority) }
      cur.count++
      priorityMap.set(it.priority, cur)
    }
    const owners = it.assignees && it.assignees.length ? it.assignees : ["(unassigned)"]
    for (const o of owners) {
      const cur = assigneeMap.get(o) || { open: 0, in_progress: 0, done: 0, total: 0, oldestStaleDays: 0 }
      cur.total++
      if (bucket === "open" || bucket === "in_review") cur.open++
      if (bucket === "in_progress") cur.in_progress++
      if (bucket === "done") cur.done++
      if (it.staleDays && it.staleDays > cur.oldestStaleDays) cur.oldestStaleDays = it.staleDays
      assigneeMap.set(o, cur)
    }
    if (it.list) {
      const cur = laneMap.get(it.list) || { count: 0, openCount: 0, doneCount: 0 }
      cur.count++
      if (bucket === "done") cur.doneCount++
      else cur.openCount++
      laneMap.set(it.list, cur)
    }
    if (it.labels) for (const l of it.labels) labelMap.set(l, (labelMap.get(l) || 0) + 1)
    if (it.isCompleted && it.createdEpoch && it.updatedEpoch) {
      cycleSamples.push((it.updatedEpoch - it.createdEpoch) / 86400000)
    }
  }

  const priorityCounts = Array.from(priorityMap.entries())
    .map(([priority, v]) => ({ priority, count: v.count, rank: v.rank }))
    .sort((a, b) => a.rank - b.rank)
  const assigneeCounts = Array.from(assigneeMap.entries())
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => (b.open + b.in_progress) - (a.open + a.in_progress))
  const lanes = Array.from(laneMap.entries())
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.count - a.count)
  const labelCounts = Array.from(labelMap.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 16)

  const staleItems = items
    .filter(it => it.isStale && !it.isCompleted)
    .sort((a, b) => (b.staleDays || 0) - (a.staleDays || 0))
    .slice(0, 12)
    .map(it => ({ id: it.id, title: it.title, ageDays: it.staleDays || 0, owner: it.owner, status: it.status }))
  const overdueItems = items
    .filter(it => it.isOverdue && !it.isCompleted)
    .sort((a, b) => (a.dueEpoch || 0) - (b.dueEpoch || 0))
    .slice(0, 12)
    .map(it => ({ id: it.id, title: it.title, due: it.due, owner: it.owner, status: it.status }))
  const bottlenecks = assigneeCounts
    .filter(a => a.name !== "(unassigned)")
    .filter(a => a.open + a.in_progress >= 4 || a.oldestStaleDays >= 21)
    .map(a => ({ name: a.name, openCount: a.open + a.in_progress, oldestStaleDays: a.oldestStaleDays }))
    .slice(0, 5)

  const cycleSorted = cycleSamples.slice().sort((a, b) => a - b)
  const median = cycleSorted.length ? cycleSorted[Math.floor(cycleSorted.length / 2)] : null
  const p95 = cycleSorted.length ? cycleSorted[Math.min(cycleSorted.length - 1, Math.floor(cycleSorted.length * 0.95))] : null

  return {
    statusCounts,
    statusBucketCounts,
    priorityCounts,
    assigneeCounts,
    lanes,
    labelCounts,
    staleItems,
    overdueItems,
    bottlenecks,
    cycleTime: {
      medianDays: median != null ? round1(median) : null,
      p95Days: p95 != null ? round1(p95) : null,
    },
    openCount: statusBucketCounts.open || 0,
    inProgressCount: statusBucketCounts.in_progress || 0,
    inReviewCount: statusBucketCounts.in_review || 0,
    doneCount: statusBucketCounts.done || 0,
    blockedCount: statusBucketCounts.blocked || 0,
    cancelledCount: statusBucketCounts.cancelled || 0,
    totals: {
      items: items.length,
      open: statusBucketCounts.open || 0,
      inProgress: statusBucketCounts.in_progress || 0,
      inReview: statusBucketCounts.in_review || 0,
      done: statusBucketCounts.done || 0,
      blocked: statusBucketCounts.blocked || 0,
      cancelled: statusBucketCounts.cancelled || 0,
      overdue: items.filter(it => it.isOverdue && !it.isCompleted).length,
      stale: items.filter(it => it.isStale && !it.isCompleted).length,
    },
  }
}

// ===========================================================================
// Helpers
// ===========================================================================

function buildSample(items: Item[], shape: "calendar" | "tasks", calendar: CalendarAgg | undefined, tasks: TaskAgg | undefined): Record<string, unknown> {
  const head = items.slice(0, 8)
  const tail = items.length > 12 ? items.slice(-3) : []
  const sample: Record<string, unknown> = {
    shape,
    itemCount: items.length,
    sample: [...head, ...tail].map(stripBigFields),
  }
  if (calendar) {
    sample.totals = calendar.totals
    sample.weeks = calendar.weeks
    sample.busyHours = calendar.busyHours
    sample.topAttendees = calendar.topAttendees.slice(0, 8)
    sample.topOrganizers = calendar.topOrganizers.slice(0, 5)
    sample.recurring = calendar.recurring
    sample.longestEvents = calendar.longestEvents
    sample.backToBackBlocks = calendar.backToBackBlocks
    sample.meetingFreeStreaks = calendar.meetingFreeStreaks
  }
  if (tasks) {
    sample.totals = tasks.totals
    sample.statusCounts = tasks.statusCounts
    sample.priorityCounts = tasks.priorityCounts
    sample.assigneeCounts = tasks.assigneeCounts.slice(0, 10)
    sample.lanes = tasks.lanes
    sample.labelCounts = tasks.labelCounts.slice(0, 10)
    sample.staleItems = tasks.staleItems
    sample.overdueItems = tasks.overdueItems
    sample.bottlenecks = tasks.bottlenecks
    sample.cycleTime = tasks.cycleTime
  }
  return sample
}

function stripBigFields(it: Item): Item {
  const { description, raw, ...rest } = it
  const trimmedDesc = description && description.length > 240 ? `${description.slice(0, 240)}…` : description
  return { ...rest, description: trimmedDesc, raw }
}

function bucketTaskStatus(s: string | undefined): Item["statusBucket"] {
  if (!s) return "unknown"
  const x = s.trim().toLowerCase()
  if (!x) return "unknown"
  if (/^(done|closed|complete|completed|resolved|shipped|merged|fixed)$/.test(x)) return "done"
  if (/^(cancel(?:l?ed)?|won.t fix|wontfix|duplicate|invalid)$/.test(x)) return "cancelled"
  if (/^(in[\s_-]?review|review|reviewing|qa|testing|verify|verification|pr)$/.test(x)) return "in_review"
  if (/^(in[\s_-]?progress|doing|started|active|wip)$/.test(x)) return "in_progress"
  if (/^(blocked|on[\s_-]?hold|waiting|paused)$/.test(x)) return "blocked"
  if (/^(todo|to[\s_-]?do|backlog|open|new|triage|ready|planned|inbox|unstarted)$/.test(x)) return "open"
  // Trello-list shapes
  if (/done|complete|shipped|released|✅/i.test(x)) return "done"
  if (/in[\s_-]?review|review|qa|testing/i.test(x)) return "in_review"
  if (/in[\s_-]?progress|doing|wip|building|developing|started|🔨|🚧/i.test(x)) return "in_progress"
  if (/blocked|on[\s_-]?hold|🚫/i.test(x)) return "blocked"
  if (/backlog|todo|to[\s_-]?do|inbox|ideas|🆕/i.test(x)) return "open"
  return "open"
}

function rankPriority(p: string | undefined): number {
  if (!p) return 99
  const x = p.trim().toLowerCase()
  if (/^(p?0|urgent|critical|highest|sev[\s_-]?1|fire)$/.test(x)) return 0
  if (/^(p?1|high|sev[\s_-]?2)$/.test(x)) return 1
  if (/^(p?2|medium|normal|sev[\s_-]?3)$/.test(x)) return 2
  if (/^(p?3|low|minor|sev[\s_-]?4)$/.test(x)) return 3
  if (/^(p?4|trivial|lowest|nice[\s_-]?to[\s_-]?have)$/.test(x)) return 4
  return 99
}

function splitMulti(s: string): string[] {
  return s
    .split(/[,;|]|\sand\s/i)
    .map(p => p.trim())
    .filter(Boolean)
}

function parseFlexibleDate(s: string): number | undefined {
  if (!s) return undefined
  const trimmed = s.trim()
  if (!trimmed) return undefined
  const d = Date.parse(trimmed)
  if (Number.isFinite(d)) return d
  // Try DD/MM/YYYY or MM/DD/YYYY heuristics
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(trimmed)
  if (m) {
    let [, a, b, y] = m
    if (y.length === 2) y = (parseInt(y, 10) >= 70 ? "19" : "20") + y
    // Assume MM/DD/YYYY (US-tracker default)
    const t = Date.UTC(+y, +a - 1, +b)
    if (Number.isFinite(t)) return t
  }
  return undefined
}

function isoWeekKey(d: Date): string {
  // ISO week, returned as YYYY-Www
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

function describeRange(startEpoch: number | undefined, endEpoch: number | undefined): string {
  if (!startEpoch) return "no dated events"
  const a = new Date(startEpoch).toISOString().slice(0, 10)
  if (!endEpoch || endEpoch === startEpoch) return a
  const b = new Date(endEpoch).toISOString().slice(0, 10)
  return `${a} → ${b}`
}

function formatHours(minutes: number): string {
  if (!minutes) return "0h"
  const h = Math.round(minutes / 60)
  return `${h}h`
}

function normalizeTitle(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 80)
}

function round1(n: number): number { return Math.round(n * 10) / 10 }

function parseCsvRow(line: string, sep: string): string[] {
  const out: string[] = []
  let cell = ""
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cell += '"'; i++ }
        else inQuote = false
      } else cell += ch
    } else {
      if (ch === '"') inQuote = true
      else if (ch === sep) { out.push(cell); cell = "" }
      else cell += ch
    }
  }
  out.push(cell)
  return out
}

function parseCsvAll(raw: string, sep: string): string[][] {
  const rows: string[][] = []
  let cur: string[] = []
  let cell = ""
  let inQuote = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (inQuote) {
      if (ch === '"') {
        if (raw[i + 1] === '"') { cell += '"'; i++ }
        else inQuote = false
      } else cell += ch
    } else {
      if (ch === '"') inQuote = true
      else if (ch === sep) { cur.push(cell); cell = "" }
      else if (ch === "\r") { /* skip */ }
      else if (ch === "\n") { cur.push(cell); rows.push(cur); cur = []; cell = "" }
      else cell += ch
    }
  }
  if (cell.length > 0 || cur.length > 0) { cur.push(cell); rows.push(cur) }
  return rows
}
