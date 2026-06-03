/**
 * Research / reading-list parser. Handles four "links and references"
 * formats with one shared dispatcher + sub-parser model:
 *
 *   - bookmarks-html — Netscape-style bookmarks export (`.html`) used
 *                      by Chrome, Firefox, Safari, Edge, Pinboard,
 *                      Raindrop, etc. (the `<DL><DT><A HREF=...>`
 *                      shape with optional `<H3>` folder headings).
 *   - bibliography   — academic bibliography in BibTeX (`.bib`) or
 *                      RIS (`.ris` / `.txt`) format from Zotero,
 *                      Mendeley, EndNote, Google Scholar, JabRef.
 *   - url-list       — plain text or markdown file with one URL per
 *                      line (often with optional notes / titles after
 *                      the URL) — the "tab dump" / "founder's open
 *                      tabs" file.
 *   - reading-list   — CSV / JSON reading queue (Pocket export,
 *                      Instapaper export, Raindrop CSV, generic
 *                      title+url+tags+date) — detected by header
 *                      shape.
 *
 * The parser normalizes all four into a unified "items" array plus
 * shared aggregations (domains, topic clusters, duplicates, stale /
 * dead-link callouts). The LLM picks the right framing from
 * `contentType` and the `_research.md` family prompt.
 *
 * The parser only normalizes — it does not fetch URLs at render time
 * and does not classify topics in a nuanced way. Topic clustering is
 * a coarse keyword roll-up; the LLM does the real narrative work.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { Parser, ParsedFile } from "../types.js"

// ---------------------------------------------------------------------------
// Public parser
// ---------------------------------------------------------------------------

type Kind = "bookmarks-html" | "bibliography" | "url-list" | "reading-list"

interface Item {
  id: string
  title: string
  url?: string
  domain?: string
  domainRoot?: string
  // Source / classification
  source: "bookmark" | "bibtex" | "ris" | "url-list" | "reading-list"
  folder?: string
  folderPath?: string[]
  tags?: string[]
  topic?: string
  // Bookmark-specific
  addedEpoch?: number
  addedIso?: string
  lastVisitedEpoch?: number
  lastVisitedIso?: string
  // Bibliography-specific
  authors?: string[]
  year?: number
  venue?: string
  doi?: string
  publication?: string
  abstract?: string
  refType?: string // article / book / inproceedings / techreport / misc
  // Notes / summary
  note?: string
  excerpt?: string
  // Computed
  ageDays?: number
  isStale?: boolean
  isDead?: boolean
  isDuplicate?: boolean
  duplicateOf?: string
  // Keep the raw fields for drill-down
  raw?: Record<string, unknown>
}

const NETSCAPE_HEAD = /<!DOCTYPE\s+NETSCAPE-Bookmark-file-1>/i
const BOOKMARKS_TITLE = /<TITLE>\s*Bookmarks\s*<\/TITLE>/i
const BIBTEX_ENTRY = /^@\s*(\w+)\s*\{/m
const RIS_ENTRY = /^TY\s*-\s*\S+/m
const STALE_DAYS = 180

export const parser: Parser = {
  name: "research",
  matches: [".html", ".htm", ".bib", ".ris", ".txt", ".csv", ".json"],
  async detect(filepath: string): Promise<boolean> {
    const ext = path.extname(filepath).toLowerCase()
    if (ext === ".html" || ext === ".htm") {
      try {
        const head = await readHead(filepath, 4096)
        return NETSCAPE_HEAD.test(head) || BOOKMARKS_TITLE.test(head)
      } catch { return false }
    }
    if (ext === ".bib") {
      try {
        const head = await readHead(filepath, 4096)
        return BIBTEX_ENTRY.test(head)
      } catch { return false }
    }
    if (ext === ".ris") {
      try {
        const head = await readHead(filepath, 4096)
        return RIS_ENTRY.test(head)
      } catch { return false }
    }
    if (ext === ".txt") {
      // URL-list detection: head looks like mostly URL lines.
      try {
        const head = await readHead(filepath, 4096)
        if (BIBTEX_ENTRY.test(head) || RIS_ENTRY.test(head)) return true
        return looksLikeUrlList(head)
      } catch { return false }
    }
    if (ext === ".csv") {
      try {
        const head = await readHead(filepath, 4096)
        const firstLine = head.split(/\r?\n/, 1)[0] || ""
        return looksLikeReadingListHeader(firstLine)
      } catch { return false }
    }
    if (ext === ".json") {
      try {
        const raw = await fs.readFile(filepath, "utf8")
        const obj = JSON.parse(raw)
        return looksLikeReadingListJson(obj)
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
    if (ext === ".html" || ext === ".htm") return parseBookmarksHtml(raw, meta)
    if (ext === ".bib") return parseBibtex(raw, meta)
    if (ext === ".ris") return parseRis(raw, meta)
    if (ext === ".csv") return parseReadingListCsv(raw, meta)
    if (ext === ".json") return parseReadingListJson(raw, meta)
    // .txt — could be BibTeX-in-txt, RIS-in-txt, or URL list
    if (BIBTEX_ENTRY.test(raw)) return parseBibtex(raw, meta)
    if (RIS_ENTRY.test(raw)) return parseRis(raw, meta)
    return parseUrlList(raw, meta)
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
// Bookmarks HTML parser (Netscape bookmark file format)
// ===========================================================================

interface BookmarkParseResult {
  items: Item[]
  folderTree: FolderNode
  exportTitle?: string
}

interface FolderNode {
  name: string
  count: number
  children: FolderNode[]
  // Item ids that live directly in this folder (not in subfolders)
  itemIds: string[]
}

function parseBookmarksHtml(raw: string, meta: Record<string, unknown> & { sourceFile: string; sizeBytes: number }): ParsedFile {
  const result = parseNetscapeBookmarks(raw)
  finalizeItems(result.items)
  const aggs = buildAggregations(result.items)
  const dateRange = describeRange(result.items.map(i => i.addedEpoch).filter((n): n is number => n != null))

  meta.format = "netscape-bookmarks-html"
  meta.kind = "bookmarks-html"
  meta.itemCount = result.items.length
  meta.folderCount = countFolders(result.folderTree)
  meta.uniqueDomains = aggs.domains.length
  meta.deadLinks = aggs.deadCount
  meta.duplicates = aggs.duplicateGroups.length
  meta.stale = aggs.staleCount
  meta.dateRange = dateRange

  const summary = `${result.exportTitle ? `${result.exportTitle}: ` : ""}${result.items.length} bookmarks across ${countFolders(result.folderTree)} folder${countFolders(result.folderTree) === 1 ? "" : "s"}, ${aggs.domains.length} unique domain${aggs.domains.length === 1 ? "" : "s"}${aggs.duplicateGroups.length ? `, ${aggs.duplicateGroups.length} duplicate group${aggs.duplicateGroups.length === 1 ? "" : "s"}` : ""}${aggs.deadCount ? `, ${aggs.deadCount} likely-dead link${aggs.deadCount === 1 ? "" : "s"}` : ""}.`

  return {
    contentType: "bookmarks-html",
    summary,
    sample: buildSample(result.items, aggs, { folderTree: result.folderTree }),
    data: {
      kind: "research",
      format: "bookmarks-html",
      items: result.items,
      folderTree: result.folderTree,
      ...aggs,
      meta: { ...meta },
    },
    meta,
  }
}

function parseNetscapeBookmarks(raw: string): BookmarkParseResult {
  // Netscape bookmark format is line-oriented but tag-soupy. We use a
  // tiny tag-walk: track folder stack via <H3>/<DL>/</DL>; collect
  // <A HREF=...> as items; pull adjacent <DD> as note. Tolerant of
  // missing </DT> closings (browsers don't emit them).
  const items: Item[] = []
  const root: FolderNode = { name: "All bookmarks", count: 0, children: [], itemIds: [] }
  const folderStack: FolderNode[] = [root]
  let exportTitle: string | undefined
  const titleMatch = raw.match(/<TITLE>([^<]*)<\/TITLE>/i)
  if (titleMatch) exportTitle = decodeHtmlEntities(titleMatch[1].trim())

  // Tokenize on tags. We keep it simple — no full DOM parser needed.
  const tagRe = /<([A-Z][A-Z0-9]*)\b([^>]*)>([^<]*)/gi
  let m: RegExpExecArray | null
  let pendingFolder: FolderNode | null = null
  let lastItem: Item | null = null
  let i = 0
  while ((m = tagRe.exec(raw)) != null) {
    const tag = m[1].toUpperCase()
    const attrsBlob = m[2] || ""
    const inner = (m[3] || "").trim()
    if (tag === "DL") {
      // Opening a list — if a folder was pending from a recent <H3>,
      // push it onto the stack now.
      if (pendingFolder) {
        folderStack[folderStack.length - 1].children.push(pendingFolder)
        folderStack.push(pendingFolder)
        pendingFolder = null
      }
      continue
    }
    if (tag === "/DL" || (tag === "DL" && /\/DL/i.test(attrsBlob))) {
      if (folderStack.length > 1) folderStack.pop()
      continue
    }
    if (tag === "H3") {
      pendingFolder = {
        name: decodeHtmlEntities(inner) || "(unnamed folder)",
        count: 0,
        children: [],
        itemIds: [],
      }
      continue
    }
    if (tag === "A") {
      const href = extractAttr(attrsBlob, "HREF")
      if (!href) continue
      i += 1
      const id = `i_${String(i).padStart(4, "0")}`
      const addEpoch = parseUnixSecondsAttr(attrsBlob, "ADD_DATE")
      const lastVisit = parseUnixSecondsAttr(attrsBlob, "LAST_VISIT") ?? parseUnixSecondsAttr(attrsBlob, "LAST_MODIFIED")
      const tagsAttr = extractAttr(attrsBlob, "TAGS")
      const tags = tagsAttr ? tagsAttr.split(/[,;]/).map(t => t.trim()).filter(Boolean) : undefined
      const folder = folderStack[folderStack.length - 1]
      const item: Item = {
        id,
        title: decodeHtmlEntities(inner) || stripUrlForTitle(href),
        url: href,
        domain: domainOf(href),
        domainRoot: rootDomainOf(href),
        source: "bookmark",
        folder: folder.name,
        folderPath: folderStack.slice(1).map(f => f.name),
        tags,
        addedEpoch: addEpoch ?? undefined,
        addedIso: addEpoch ? new Date(addEpoch).toISOString().slice(0, 10) : undefined,
        lastVisitedEpoch: lastVisit ?? undefined,
        lastVisitedIso: lastVisit ? new Date(lastVisit).toISOString().slice(0, 10) : undefined,
      }
      items.push(item)
      folder.itemIds.push(id)
      folder.count += 1
      // Walk parents and increment recursive count
      for (let p = folderStack.length - 2; p >= 0; p--) folderStack[p].count += 1
      // Root counter so root is honest
      if (folderStack.length === 1) root.count += 0 // already incremented above
      lastItem = item
      continue
    }
    if (tag === "DD") {
      // Adjacent <DD> contains a free-text note for the previous item.
      if (lastItem && inner) {
        const note = decodeHtmlEntities(inner)
        lastItem.note = note
        lastItem.excerpt = note.length > 240 ? `${note.slice(0, 240)}…` : note
      }
      continue
    }
  }
  // The root counter wasn't incremented for items directly under root —
  // re-derive from folderTree leaves.
  recountFolders(root)
  return { items, folderTree: root, exportTitle }
}

function recountFolders(node: FolderNode): number {
  let n = node.itemIds.length
  for (const c of node.children) n += recountFolders(c)
  node.count = n
  return n
}

function countFolders(node: FolderNode): number {
  // Count the named subfolders (not the synthetic "All bookmarks" root)
  let n = 0
  for (const c of node.children) n += 1 + countFoldersInner(c)
  return n
}
function countFoldersInner(node: FolderNode): number {
  let n = 0
  for (const c of node.children) n += 1 + countFoldersInner(c)
  return n
}

function extractAttr(blob: string, key: string): string | undefined {
  const re = new RegExp(`${key}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i")
  const m = re.exec(blob)
  if (!m) return undefined
  return m[2] ?? m[3] ?? m[4]
}

function parseUnixSecondsAttr(blob: string, key: string): number | undefined {
  const v = extractAttr(blob, key)
  if (!v) return undefined
  const n = parseInt(v, 10)
  if (!Number.isFinite(n) || n <= 0) return undefined
  // Bookmark formats use seconds; convert to ms
  return n * 1000
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
}

// ===========================================================================
// BibTeX parser
// ===========================================================================

function parseBibtex(raw: string, meta: Record<string, unknown> & { sourceFile: string; sizeBytes: number }): ParsedFile {
  const items: Item[] = []
  // Walk one entry at a time. A BibTeX entry is `@type{key, field=value, ...}`.
  // We do a brace-balanced extraction of the entry body.
  const len = raw.length
  let i = 0
  let entryIdx = 0
  while (i < len) {
    while (i < len && raw[i] !== "@") i++
    if (i >= len) break
    const atStart = i
    i++
    // Type (e.g. article, book)
    const typeMatch = /\w+/y
    typeMatch.lastIndex = i
    const tm = typeMatch.exec(raw)
    if (!tm) { i = atStart + 1; continue }
    const refType = tm[0].toLowerCase()
    i = typeMatch.lastIndex
    // Skip whitespace
    while (i < len && /\s/.test(raw[i])) i++
    if (raw[i] !== "{") { continue }
    i++
    // Read entry up to matching closing brace
    const start = i
    let depth = 1
    while (i < len && depth > 0) {
      const c = raw[i]
      if (c === "{") depth++
      else if (c === "}") { depth--; if (depth === 0) break }
      else if (c === "%") { while (i < len && raw[i] !== "\n") i++; continue }
      i++
    }
    const body = raw.slice(start, i)
    if (raw[i] === "}") i++
    if (refType === "comment" || refType === "preamble" || refType === "string") continue
    entryIdx += 1
    const item = bibtexEntryToItem(refType, body, entryIdx)
    if (item) items.push(item)
  }
  finalizeItems(items)
  const aggs = buildAggregations(items)
  const dateRange = describeYearRange(items)

  meta.format = "bibtex"
  meta.kind = "bibliography"
  meta.subKind = "bibtex"
  meta.itemCount = items.length
  meta.uniqueDomains = aggs.domains.length
  meta.deadLinks = aggs.deadCount
  meta.duplicates = aggs.duplicateGroups.length
  meta.dateRange = dateRange

  const summary = `BibTeX bibliography: ${items.length} reference${items.length === 1 ? "" : "s"} (${countAuthors(items)} unique author${countAuthors(items) === 1 ? "" : "s"}, ${countVenues(items)} venue${countVenues(items) === 1 ? "" : "s"}, ${dateRange}).`

  return {
    contentType: "bibliography",
    summary,
    sample: buildSample(items, aggs, undefined),
    data: {
      kind: "research",
      format: "bibtex",
      items,
      ...aggs,
      meta: { ...meta },
    },
    meta,
  }
}

function bibtexEntryToItem(refType: string, body: string, idx: number): Item | null {
  // First comma-separated chunk is the citation key
  const firstComma = indexOfTopLevelComma(body, 0)
  const citeKey = (firstComma >= 0 ? body.slice(0, firstComma) : body).trim()
  const fieldsStr = firstComma >= 0 ? body.slice(firstComma + 1) : ""
  const fields = parseBibtexFields(fieldsStr)
  const id = `i_${String(idx).padStart(4, "0")}`
  const title = stripBibtexBraces(fields.get("title") || fields.get("booktitle") || citeKey || "(untitled)")
  const authorStr = fields.get("author") || fields.get("editor")
  const authors = authorStr ? splitAuthors(stripBibtexBraces(authorStr)) : undefined
  const yearStr = fields.get("year")
  const year = yearStr ? parseInt(yearStr.replace(/[^0-9]/g, ""), 10) : undefined
  const venue = stripBibtexBraces(fields.get("journal") || fields.get("booktitle") || fields.get("publisher") || "") || undefined
  const url = stripBibtexBraces(fields.get("url") || fields.get("howpublished") || "")?.replace(/^\\url\{|}$/g, "") || undefined
  const doi = stripBibtexBraces(fields.get("doi") || "") || undefined
  const note = stripBibtexBraces(fields.get("note") || fields.get("annote") || fields.get("abstract") || "") || undefined
  const tagsStr = stripBibtexBraces(fields.get("keywords") || fields.get("mendeley-tags") || "")
  const tags = tagsStr ? tagsStr.split(/[,;]/).map(t => t.trim()).filter(Boolean) : undefined
  return {
    id,
    title: cleanBibtexText(title),
    url: url || (doi ? `https://doi.org/${doi}` : undefined),
    domain: url ? domainOf(url) : (doi ? "doi.org" : undefined),
    domainRoot: url ? rootDomainOf(url) : (doi ? "doi.org" : undefined),
    source: "bibtex",
    folder: refType,
    tags,
    authors,
    year: Number.isFinite(year) ? year : undefined,
    venue,
    doi,
    publication: venue,
    abstract: cleanBibtexText(stripBibtexBraces(fields.get("abstract") || "")),
    refType,
    note: note ? cleanBibtexText(note) : undefined,
    excerpt: note && note.length > 240 ? `${cleanBibtexText(note).slice(0, 240)}…` : (note ? cleanBibtexText(note) : undefined),
    raw: { citeKey, refType, fields: Object.fromEntries(fields) },
  }
}

function parseBibtexFields(body: string): Map<string, string> {
  const out = new Map<string, string>()
  const len = body.length
  let i = 0
  while (i < len) {
    while (i < len && /[\s,]/.test(body[i])) i++
    if (i >= len) break
    const keyMatch = /[A-Za-z][A-Za-z0-9_-]*/y
    keyMatch.lastIndex = i
    const km = keyMatch.exec(body)
    if (!km) break
    const key = km[0].toLowerCase()
    i = keyMatch.lastIndex
    while (i < len && /\s/.test(body[i])) i++
    if (body[i] !== "=") { while (i < len && body[i] !== ",") i++; continue }
    i++
    while (i < len && /\s/.test(body[i])) i++
    let val = ""
    if (body[i] === "{") {
      let depth = 1
      i++
      const start = i
      while (i < len && depth > 0) {
        if (body[i] === "{") depth++
        else if (body[i] === "}") { depth--; if (depth === 0) break }
        i++
      }
      val = body.slice(start, i)
      if (body[i] === "}") i++
    } else if (body[i] === '"') {
      i++
      const start = i
      while (i < len && body[i] !== '"') i++
      val = body.slice(start, i)
      if (body[i] === '"') i++
    } else {
      const start = i
      while (i < len && body[i] !== "," && body[i] !== "\n") i++
      val = body.slice(start, i).trim()
    }
    out.set(key, val)
  }
  return out
}

function indexOfTopLevelComma(s: string, from: number): number {
  let depth = 0
  for (let i = from; i < s.length; i++) {
    const c = s[i]
    if (c === "{") depth++
    else if (c === "}") depth = Math.max(0, depth - 1)
    else if (c === "," && depth === 0) return i
  }
  return -1
}

function stripBibtexBraces(s: string): string {
  if (!s) return ""
  // Drop balanced surrounding {} layers and inner protective braces.
  let out = s.trim()
  while (out.startsWith("{") && out.endsWith("}")) {
    let depth = 0
    let balanced = true
    for (let i = 0; i < out.length; i++) {
      const c = out[i]
      if (c === "{") depth++
      else if (c === "}") {
        depth--
        if (depth === 0 && i < out.length - 1) { balanced = false; break }
      }
    }
    if (!balanced) break
    out = out.slice(1, -1).trim()
  }
  // Strip protection braces like {Smith}
  return out.replace(/\{([^{}]*)\}/g, "$1")
}

function cleanBibtexText(s: string): string {
  if (!s) return ""
  return s
    .replace(/\\&/g, "&")
    .replace(/\\%/g, "%")
    .replace(/\\_/g, "_")
    .replace(/\\\$/g, "$")
    .replace(/\\#/g, "#")
    .replace(/\\textendash\{?\}?/g, "–")
    .replace(/\\textemdash\{?\}?/g, "—")
    .replace(/\\textquoteleft\{?\}?/g, "‘")
    .replace(/\\textquoteright\{?\}?/g, "’")
    .replace(/--/g, "–")
    .replace(/\s+/g, " ")
    .trim()
}

function splitAuthors(s: string): string[] {
  return s
    .split(/\s+and\s+/i)
    .map(a => a.trim())
    .filter(Boolean)
    .map(normalizeAuthor)
}

function normalizeAuthor(s: string): string {
  // BibTeX often stores "Last, First M."; flip to "First M. Last".
  if (s.includes(",")) {
    const [last, rest] = s.split(",", 2)
    return `${rest.trim()} ${last.trim()}`.trim()
  }
  return s.replace(/\s+/g, " ").trim()
}

// ===========================================================================
// RIS parser
// ===========================================================================

const RIS_TAG = /^([A-Z][A-Z0-9])\s*-\s*(.*)$/

function parseRis(raw: string, meta: Record<string, unknown> & { sourceFile: string; sizeBytes: number }): ParsedFile {
  const items: Item[] = []
  const lines = raw.replace(/^﻿/, "").split(/\r?\n/)
  let cur: Map<string, string[]> | null = null
  let entryIdx = 0
  for (const ln of lines) {
    const m = RIS_TAG.exec(ln)
    if (!m) continue
    const tag = m[1].toUpperCase()
    const value = m[2].trim()
    if (tag === "TY") {
      cur = new Map()
      cur.set("TY", [value])
      continue
    }
    if (!cur) continue
    if (tag === "ER") {
      entryIdx += 1
      const item = risEntryToItem(cur, entryIdx)
      if (item) items.push(item)
      cur = null
      continue
    }
    const arr = cur.get(tag) || []
    if (value) arr.push(value)
    cur.set(tag, arr)
  }
  finalizeItems(items)
  const aggs = buildAggregations(items)
  const dateRange = describeYearRange(items)

  meta.format = "ris"
  meta.kind = "bibliography"
  meta.subKind = "ris"
  meta.itemCount = items.length
  meta.uniqueDomains = aggs.domains.length
  meta.deadLinks = aggs.deadCount
  meta.duplicates = aggs.duplicateGroups.length
  meta.dateRange = dateRange

  const summary = `RIS bibliography: ${items.length} reference${items.length === 1 ? "" : "s"} (${countAuthors(items)} unique author${countAuthors(items) === 1 ? "" : "s"}, ${countVenues(items)} venue${countVenues(items) === 1 ? "" : "s"}, ${dateRange}).`

  return {
    contentType: "bibliography",
    summary,
    sample: buildSample(items, aggs, undefined),
    data: {
      kind: "research",
      format: "ris",
      items,
      ...aggs,
      meta: { ...meta },
    },
    meta,
  }
}

function risEntryToItem(fields: Map<string, string[]>, idx: number): Item | null {
  const refType = (fields.get("TY")?.[0] || "GEN").toLowerCase()
  const title = (fields.get("TI")?.[0] || fields.get("T1")?.[0] || fields.get("BT")?.[0] || "(untitled)").trim()
  const authorsRaw = [
    ...(fields.get("AU") || []),
    ...(fields.get("A1") || []),
    ...(fields.get("A2") || []),
    ...(fields.get("A3") || []),
  ]
  const authors = authorsRaw.length ? authorsRaw.map(normalizeAuthor) : undefined
  const yearStr = fields.get("PY")?.[0] || fields.get("Y1")?.[0] || fields.get("DA")?.[0] || ""
  const yearMatch = /\d{4}/.exec(yearStr)
  const year = yearMatch ? parseInt(yearMatch[0], 10) : undefined
  const venue = (fields.get("JO")?.[0] || fields.get("JF")?.[0] || fields.get("T2")?.[0] || fields.get("PB")?.[0] || "").trim() || undefined
  const url = (fields.get("UR")?.[0] || fields.get("L1")?.[0] || "").trim() || undefined
  const doi = (fields.get("DO")?.[0] || "").trim() || undefined
  const abstract = (fields.get("AB")?.[0] || fields.get("N2")?.[0] || "").trim() || undefined
  const note = (fields.get("N1")?.[0] || "").trim() || undefined
  const tagsRaw = fields.get("KW") || []
  const tags = tagsRaw.length ? tagsRaw.flatMap(t => t.split(/[,;]/)).map(t => t.trim()).filter(Boolean) : undefined
  return {
    id: `i_${String(idx).padStart(4, "0")}`,
    title,
    url: url || (doi ? `https://doi.org/${doi}` : undefined),
    domain: url ? domainOf(url) : (doi ? "doi.org" : undefined),
    domainRoot: url ? rootDomainOf(url) : (doi ? "doi.org" : undefined),
    source: "ris",
    folder: refType,
    tags,
    authors,
    year: Number.isFinite(year) ? year : undefined,
    venue,
    doi,
    publication: venue,
    abstract,
    refType,
    note: note || abstract,
    excerpt: (note || abstract) && (note || abstract)!.length > 240 ? `${(note || abstract)!.slice(0, 240)}…` : (note || abstract),
    raw: { refType, fields: Object.fromEntries(Array.from(fields.entries()).map(([k, v]) => [k, v.length === 1 ? v[0] : v])) },
  }
}

// ===========================================================================
// URL list parser (.txt with URLs, optionally with leading/trailing notes)
// ===========================================================================

function looksLikeUrlList(head: string): boolean {
  const lines = head.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (lines.length < 2) return false
  let urlLines = 0
  let total = 0
  for (const ln of lines.slice(0, 40)) {
    total++
    if (extractFirstUrl(ln)) urlLines++
  }
  if (total === 0) return false
  return urlLines / total >= 0.5
}

function parseUrlList(raw: string, meta: Record<string, unknown> & { sourceFile: string; sizeBytes: number }): ParsedFile {
  const items: Item[] = []
  const lines = raw.replace(/^﻿/, "").split(/\r?\n/)
  let currentSection: string | undefined
  let entryIdx = 0
  let lastItem: Item | null = null
  for (const rawLn of lines) {
    const ln = rawLn.trim()
    if (!ln) continue
    // Markdown / plain heading: "## Section name" or "[Section name]" or
    // a line ending with ":" that isn't a URL.
    const headingMd = /^#{1,6}\s+(.+)$/.exec(ln)
    if (headingMd) { currentSection = headingMd[1].trim(); continue }
    const sectionBracket = /^\[(.+)\]\s*$/.exec(ln)
    if (sectionBracket) { currentSection = sectionBracket[1].trim(); continue }
    const sectionColon = /^([A-Z][A-Za-z0-9 &/-]{1,60}):\s*$/.exec(ln)
    if (sectionColon) { currentSection = sectionColon[1].trim(); continue }
    // Comment / note line continuation for previous entry — start with
    // ">" or ":" and contain no URL.
    if (lastItem && /^[>:]\s+/.test(ln) && !extractFirstUrl(ln)) {
      const note = ln.replace(/^[>:]\s+/, "")
      lastItem.note = lastItem.note ? `${lastItem.note} ${note}` : note
      lastItem.excerpt = lastItem.note.length > 240 ? `${lastItem.note.slice(0, 240)}…` : lastItem.note
      continue
    }
    const url = extractFirstUrl(ln)
    if (!url) {
      // Treat as a section heading if the previous line had a URL and
      // this line is short.
      if (ln.length < 80 && /^[A-Z]/.test(ln)) currentSection = ln
      continue
    }
    entryIdx += 1
    const id = `i_${String(entryIdx).padStart(4, "0")}`
    // Markdown form: [title](url) — capture title.
    const md = /^\s*-?\s*\[([^\]]+)\]\((https?:\/\/[^)]+)\)\s*(.*)$/.exec(ln)
    let title: string
    let trailingNote: string | undefined
    if (md) {
      title = md[1].trim()
      trailingNote = md[3].trim().replace(/^[—–\-:]\s*/, "")
    } else {
      // Title is the text before the URL (if any) or the URL itself
      const before = ln.slice(0, ln.indexOf(url)).trim().replace(/^[-*•]\s*/, "").replace(/[—–\-:]\s*$/, "").trim()
      const after = ln.slice(ln.indexOf(url) + url.length).trim().replace(/^[—–\-:]\s*/, "")
      title = before || stripUrlForTitle(url)
      trailingNote = after || undefined
    }
    const item: Item = {
      id,
      title,
      url,
      domain: domainOf(url),
      domainRoot: rootDomainOf(url),
      source: "url-list",
      folder: currentSection,
      note: trailingNote,
      excerpt: trailingNote && trailingNote.length > 240 ? `${trailingNote.slice(0, 240)}…` : trailingNote,
    }
    items.push(item)
    lastItem = item
  }
  finalizeItems(items)
  const aggs = buildAggregations(items)

  meta.format = "url-list"
  meta.kind = "url-list"
  meta.itemCount = items.length
  meta.uniqueDomains = aggs.domains.length
  meta.duplicates = aggs.duplicateGroups.length
  meta.deadLinks = aggs.deadCount
  meta.sectionCount = new Set(items.map(it => it.folder).filter(Boolean)).size

  const summary = `URL list: ${items.length} link${items.length === 1 ? "" : "s"} across ${aggs.domains.length} domain${aggs.domains.length === 1 ? "" : "s"}${meta.sectionCount && (meta.sectionCount as number) > 1 ? `, ${meta.sectionCount} section${meta.sectionCount === 1 ? "" : "s"}` : ""}${aggs.duplicateGroups.length ? `, ${aggs.duplicateGroups.length} duplicate group${aggs.duplicateGroups.length === 1 ? "" : "s"}` : ""}.`

  return {
    contentType: "url-list",
    summary,
    sample: buildSample(items, aggs, undefined),
    data: {
      kind: "research",
      format: "url-list",
      items,
      ...aggs,
      meta: { ...meta },
    },
    meta,
  }
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'\]\)]+/i
function extractFirstUrl(s: string): string | undefined {
  const m = URL_RE.exec(s)
  if (!m) return undefined
  return m[0].replace(/[.,;:!?)]+$/, "")
}

// ===========================================================================
// Reading-list CSV / JSON parser (Pocket / Instapaper / Raindrop / generic)
// ===========================================================================

const READING_LIST_TITLE_HEADERS = ["title", "name", "subject", "headline"]
const READING_LIST_URL_HEADERS = ["url", "link", "uri", "href"]
const READING_LIST_TAGS_HEADERS = ["tags", "tag", "labels", "topics", "categories", "category"]
const READING_LIST_NOTE_HEADERS = ["note", "notes", "excerpt", "summary", "description", "annotation"]
const READING_LIST_DATE_HEADERS = ["time_added", "added", "added_at", "date", "created", "saved"]
const READING_LIST_FOLDER_HEADERS = ["folder", "collection", "list", "status"]

function looksLikeReadingListHeader(line: string): boolean {
  const sep = line.includes("\t") ? "\t" : line.includes(";") && !line.includes(",") ? ";" : ","
  const headers = parseCsvRow(line, sep).map(h => h.trim().toLowerCase())
  if (headers.length < 2) return false
  const hasUrl = headers.some(h => READING_LIST_URL_HEADERS.includes(h))
  const hasTitle = headers.some(h => READING_LIST_TITLE_HEADERS.includes(h))
  if (!hasUrl) return false
  return hasTitle || headers.some(h => READING_LIST_TAGS_HEADERS.includes(h)) || headers.some(h => READING_LIST_DATE_HEADERS.includes(h))
}

function parseReadingListCsv(raw: string, meta: Record<string, unknown> & { sourceFile: string; sizeBytes: number }): ParsedFile {
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
  const titleIdx = findIdx(READING_LIST_TITLE_HEADERS)
  const urlIdx = findIdx(READING_LIST_URL_HEADERS)
  const tagsIdx = findIdx(READING_LIST_TAGS_HEADERS)
  const noteIdx = findIdx(READING_LIST_NOTE_HEADERS)
  const dateIdx = findIdx(READING_LIST_DATE_HEADERS)
  const folderIdx = findIdx(READING_LIST_FOLDER_HEADERS)

  const items: Item[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (!r || r.every(c => !c.trim())) continue
    const url = urlIdx >= 0 ? (r[urlIdx] || "").trim() : ""
    if (!url) continue
    const title = (titleIdx >= 0 ? (r[titleIdx] || "").trim() : "") || stripUrlForTitle(url)
    const tags = tagsIdx >= 0 ? splitTags(r[tagsIdx] || "") : undefined
    const note = noteIdx >= 0 ? (r[noteIdx] || "").trim() : undefined
    const folder = folderIdx >= 0 ? (r[folderIdx] || "").trim() : undefined
    const dateStr = dateIdx >= 0 ? (r[dateIdx] || "").trim() : ""
    const epoch = parseFlexibleDate(dateStr)
    items.push({
      id: `i_${String(i + 1).padStart(4, "0")}`,
      title,
      url,
      domain: domainOf(url),
      domainRoot: rootDomainOf(url),
      source: "reading-list",
      folder: folder || undefined,
      tags,
      addedEpoch: epoch ?? undefined,
      addedIso: epoch ? new Date(epoch).toISOString().slice(0, 10) : undefined,
      note: note || undefined,
      excerpt: note && note.length > 240 ? `${note.slice(0, 240)}…` : (note || undefined),
    })
  }
  finalizeItems(items)
  const aggs = buildAggregations(items)
  const dateRange = describeRange(items.map(i => i.addedEpoch).filter((n): n is number => n != null))

  meta.format = "reading-list-csv"
  meta.kind = "reading-list"
  meta.itemCount = items.length
  meta.uniqueDomains = aggs.domains.length
  meta.deadLinks = aggs.deadCount
  meta.duplicates = aggs.duplicateGroups.length
  meta.dateRange = dateRange

  const summary = `Reading list: ${items.length} item${items.length === 1 ? "" : "s"} from ${aggs.domains.length} domain${aggs.domains.length === 1 ? "" : "s"}${dateRange === "no dated items" ? "" : ` (${dateRange})`}.`

  return {
    contentType: "reading-list",
    summary,
    sample: buildSample(items, aggs, undefined),
    data: {
      kind: "research",
      format: "reading-list-csv",
      items,
      ...aggs,
      meta: { ...meta },
    },
    meta,
  }
}

function looksLikeReadingListJson(o: unknown): boolean {
  if (!o) return false
  if (Array.isArray(o)) {
    const first = o[0] as Record<string, unknown> | undefined
    if (!first || typeof first !== "object") return false
    return ("url" in first || "link" in first) && ("title" in first || "name" in first || "tags" in first)
  }
  if (typeof o === "object") {
    const r = o as Record<string, unknown>
    if (Array.isArray(r.bookmarks)) return looksLikeReadingListJson(r.bookmarks)
    if (Array.isArray(r.items)) return looksLikeReadingListJson(r.items)
    if (Array.isArray(r.list)) return looksLikeReadingListJson(r.list)
    if (Array.isArray(r.articles)) return looksLikeReadingListJson(r.articles)
  }
  return false
}

function parseReadingListJson(raw: string, meta: Record<string, unknown> & { sourceFile: string; sizeBytes: number }): ParsedFile {
  const obj = JSON.parse(raw) as unknown
  const arr = extractReadingListArray(obj)
  const items: Item[] = []
  for (let i = 0; i < arr.length; i++) {
    const r = arr[i] || {}
    const url = String((r.url as string | undefined) || (r.link as string | undefined) || (r.href as string | undefined) || "").trim()
    if (!url) continue
    const title = String((r.title as string | undefined) || (r.name as string | undefined) || stripUrlForTitle(url)).trim()
    const note = String((r.note as string | undefined) || (r.excerpt as string | undefined) || (r.summary as string | undefined) || (r.description as string | undefined) || "").trim()
    const tagsRaw = (r.tags as unknown) || (r.labels as unknown) || (r.topics as unknown)
    let tags: string[] | undefined
    if (Array.isArray(tagsRaw)) tags = (tagsRaw as unknown[]).map(t => String(t)).filter(Boolean)
    else if (typeof tagsRaw === "string") tags = splitTags(tagsRaw)
    const folder = String((r.folder as string | undefined) || (r.collection as string | undefined) || (r.status as string | undefined) || "").trim() || undefined
    const dateStr = String((r.added as string | undefined) || (r.added_at as string | undefined) || (r.time_added as string | undefined) || (r.date as string | undefined) || (r.created as string | undefined) || "")
    const epoch = parseFlexibleDate(dateStr)
    items.push({
      id: `i_${String(i + 1).padStart(4, "0")}`,
      title,
      url,
      domain: domainOf(url),
      domainRoot: rootDomainOf(url),
      source: "reading-list",
      folder,
      tags,
      addedEpoch: epoch ?? undefined,
      addedIso: epoch ? new Date(epoch).toISOString().slice(0, 10) : undefined,
      note: note || undefined,
      excerpt: note && note.length > 240 ? `${note.slice(0, 240)}…` : (note || undefined),
    })
  }
  finalizeItems(items)
  const aggs = buildAggregations(items)
  const dateRange = describeRange(items.map(i => i.addedEpoch).filter((n): n is number => n != null))

  meta.format = "reading-list-json"
  meta.kind = "reading-list"
  meta.itemCount = items.length
  meta.uniqueDomains = aggs.domains.length
  meta.deadLinks = aggs.deadCount
  meta.duplicates = aggs.duplicateGroups.length
  meta.dateRange = dateRange

  const summary = `Reading list: ${items.length} item${items.length === 1 ? "" : "s"} from ${aggs.domains.length} domain${aggs.domains.length === 1 ? "" : "s"}${dateRange === "no dated items" ? "" : ` (${dateRange})`}.`

  return {
    contentType: "reading-list",
    summary,
    sample: buildSample(items, aggs, undefined),
    data: {
      kind: "research",
      format: "reading-list-json",
      items,
      ...aggs,
      meta: { ...meta },
    },
    meta,
  }
}

function extractReadingListArray(o: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(o)) return o as Array<Record<string, unknown>>
  if (o && typeof o === "object") {
    const r = o as Record<string, unknown>
    if (Array.isArray(r.bookmarks)) return r.bookmarks as Array<Record<string, unknown>>
    if (Array.isArray(r.items)) return r.items as Array<Record<string, unknown>>
    if (Array.isArray(r.list)) return r.list as Array<Record<string, unknown>>
    if (Array.isArray(r.articles)) return r.articles as Array<Record<string, unknown>>
  }
  return []
}

function splitTags(s: string): string[] {
  return s.split(/[,;|]/).map(t => t.trim()).filter(Boolean)
}

// ===========================================================================
// Shared post-processing: domains, topics, duplicates, dead-link heuristic
// ===========================================================================

const STALE_FOLDER_HINT = /(read.?later|to.?read|archive|inbox|old|stale)/i
const DEAD_HOSTS = new Set([
  "geocities.com",
  "yahoo.com/groups",
  "del.icio.us",
  "delicious.com",
  "google.com/reader",
  "googlecode.com",
  "plus.google.com",
  "google.com/plus",
  "wave.google.com",
  "googlewave.com",
  "code.google.com",
  "myspace.com",
  "friendster.com",
  "orkut.com",
])
const DEAD_PATH_HINT = /(404|page-not-found|deleted|expired|removed|wayback)/i

function finalizeItems(items: Item[]): void {
  const now = Date.now()
  const byUrl = new Map<string, string>() // normalized url → first id
  for (const it of items) {
    if (it.addedEpoch != null) {
      it.ageDays = Math.max(0, Math.floor((now - it.addedEpoch) / 86400000))
      it.isStale = it.ageDays >= STALE_DAYS
    } else if (it.folder && STALE_FOLDER_HINT.test(it.folder)) {
      it.isStale = true
    }
    if (it.url) {
      it.isDead = looksDead(it.url, it.domain)
      const norm = normalizeUrlForDedupe(it.url)
      if (byUrl.has(norm)) {
        it.isDuplicate = true
        it.duplicateOf = byUrl.get(norm)
      } else {
        byUrl.set(norm, it.id)
      }
    }
    // Topic: pick the most informative tag if we don't have one already
    if (!it.topic) {
      if (it.tags && it.tags.length) it.topic = it.tags[0]
      else if (it.folder) it.topic = it.folder
    }
  }
}

function looksDead(url: string, domain?: string): boolean {
  const dom = (domain || domainOf(url) || "").toLowerCase()
  if (DEAD_HOSTS.has(dom)) return true
  if (DEAD_PATH_HINT.test(url)) return true
  // Plain http to a clearly-old-host domain pattern (heuristic only)
  if (/^http:\/\/(?:web|www)\.archive\.org\//i.test(url)) return false // archive isn't dead
  return false
}

function normalizeUrlForDedupe(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ""
    // Strip common tracking params
    const drop = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref", "ref_src", "ref_url", "fbclid", "gclid", "mc_cid", "mc_eid"]
    for (const k of drop) u.searchParams.delete(k)
    let s = `${u.protocol}//${u.host.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`
    const qs = u.searchParams.toString()
    if (qs) s += `?${qs}`
    return s.toLowerCase()
  } catch {
    return url.trim().toLowerCase().replace(/[#?].*$/, "").replace(/\/+$/, "")
  }
}

function domainOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch { return undefined }
}

function rootDomainOf(url: string): string | undefined {
  const dom = domainOf(url)
  if (!dom) return undefined
  const parts = dom.split(".")
  if (parts.length <= 2) return dom
  // Two-level TLDs we want to preserve
  const twoLevel = new Set(["co.uk", "co.jp", "ac.uk", "gov.uk", "com.au", "co.nz", "co.in", "co.za"])
  const last2 = parts.slice(-2).join(".")
  const last3 = parts.slice(-3).join(".")
  if (twoLevel.has(last2)) return last3
  return last2
}

function stripUrlForTitle(url: string): string {
  try {
    const u = new URL(url)
    return `${u.host.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`
  } catch { return url }
}

interface ResearchAggs {
  domains: Array<{ domain: string; count: number; sampleTitle?: string }>
  rootDomains: Array<{ domain: string; count: number }>
  topics: Array<{ name: string; count: number; itemIds: string[] }>
  topTags: Array<{ tag: string; count: number }>
  folders: Array<{ name: string; count: number; itemIds: string[] }>
  duplicateGroups: Array<{ url: string; ids: string[]; titles: string[] }>
  duplicateCount: number
  staleItems: Array<{ id: string; title: string; ageDays?: number; folder?: string; url?: string }>
  staleCount: number
  deadLinks: Array<{ id: string; title: string; url?: string; domain?: string; reason: string }>
  deadCount: number
  yearHistogram: Array<{ year: number; count: number }>
  authorLeaderboard: Array<{ name: string; count: number }>
  venueLeaderboard: Array<{ venue: string; count: number }>
  reading: {
    weeklyHistogram: Array<{ weekOf: string; count: number }>
    monthlyHistogram: Array<{ month: string; count: number }>
  }
  totals: {
    items: number
    domains: number
    topics: number
    duplicates: number
    stale: number
    dead: number
    withDates: number
    withNotes: number
  }
  totalOutbound: number
}

function buildAggregations(items: Item[]): ResearchAggs {
  const domainCounts = new Map<string, { count: number; sampleTitle?: string }>()
  const rootDomainCounts = new Map<string, number>()
  const tagCounts = new Map<string, number>()
  const folderMap = new Map<string, { count: number; itemIds: string[] }>()
  const dupMap = new Map<string, { url: string; ids: string[]; titles: string[] }>()
  const yearCounts = new Map<number, number>()
  const authorCounts = new Map<string, number>()
  const venueCounts = new Map<string, number>()
  const weekCounts = new Map<string, number>()
  const monthCounts = new Map<string, number>()
  let withDates = 0
  let withNotes = 0
  let staleCount = 0
  let deadCount = 0

  for (const it of items) {
    if (it.domain) {
      const cur = domainCounts.get(it.domain) || { count: 0, sampleTitle: it.title }
      cur.count++
      domainCounts.set(it.domain, cur)
    }
    if (it.domainRoot) {
      rootDomainCounts.set(it.domainRoot, (rootDomainCounts.get(it.domainRoot) || 0) + 1)
    }
    if (it.tags) for (const t of it.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1)
    const folder = it.folder || "(uncategorized)"
    const fmCur = folderMap.get(folder) || { count: 0, itemIds: [] }
    fmCur.count++
    fmCur.itemIds.push(it.id)
    folderMap.set(folder, fmCur)
    if (it.isDuplicate && it.url) {
      const norm = normalizeUrlForDedupe(it.url)
      const dup = dupMap.get(norm) || { url: it.url, ids: [], titles: [] }
      if (it.duplicateOf && !dup.ids.includes(it.duplicateOf)) {
        dup.ids.push(it.duplicateOf)
        const orig = items.find(x => x.id === it.duplicateOf)
        if (orig) dup.titles.push(orig.title)
      }
      dup.ids.push(it.id)
      dup.titles.push(it.title)
      dupMap.set(norm, dup)
    }
    if (it.year) yearCounts.set(it.year, (yearCounts.get(it.year) || 0) + 1)
    if (it.authors) for (const a of it.authors) authorCounts.set(a, (authorCounts.get(a) || 0) + 1)
    if (it.venue) venueCounts.set(it.venue, (venueCounts.get(it.venue) || 0) + 1)
    if (it.addedEpoch != null) {
      withDates++
      const d = new Date(it.addedEpoch)
      const wk = isoWeekKey(d)
      weekCounts.set(wk, (weekCounts.get(wk) || 0) + 1)
      const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
      monthCounts.set(month, (monthCounts.get(month) || 0) + 1)
    }
    if (it.note) withNotes++
    if (it.isStale) staleCount++
    if (it.isDead) deadCount++
  }

  const domains = Array.from(domainCounts.entries())
    .map(([domain, v]) => ({ domain, count: v.count, sampleTitle: v.sampleTitle }))
    .sort((a, b) => b.count - a.count)
  const rootDomains = Array.from(rootDomainCounts.entries())
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count)
  const topTags = Array.from(tagCounts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 32)
  const folders = Array.from(folderMap.entries())
    .map(([name, v]) => ({ name, count: v.count, itemIds: v.itemIds }))
    .sort((a, b) => b.count - a.count)

  const topics = computeTopics(items, topTags, folders)

  const duplicateGroups = Array.from(dupMap.values())
    .map(g => ({ url: g.url, ids: dedupe(g.ids), titles: dedupe(g.titles) }))
    .sort((a, b) => b.ids.length - a.ids.length)

  const staleItems = items
    .filter(it => it.isStale)
    .sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0))
    .slice(0, 16)
    .map(it => ({ id: it.id, title: it.title, ageDays: it.ageDays, folder: it.folder, url: it.url }))

  const deadLinks = items
    .filter(it => it.isDead)
    .slice(0, 16)
    .map(it => ({ id: it.id, title: it.title, url: it.url, domain: it.domain, reason: deadReason(it) }))

  const yearHistogram = Array.from(yearCounts.entries())
    .map(([year, count]) => ({ year, count }))
    .sort((a, b) => a.year - b.year)
  const authorLeaderboard = Array.from(authorCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12)
  const venueLeaderboard = Array.from(venueCounts.entries())
    .map(([venue, count]) => ({ venue, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  const weeklyHistogram = Array.from(weekCounts.entries())
    .map(([weekOf, count]) => ({ weekOf, count }))
    .sort((a, b) => a.weekOf.localeCompare(b.weekOf))
  const monthlyHistogram = Array.from(monthCounts.entries())
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => a.month.localeCompare(b.month))

  return {
    domains: domains.slice(0, 24),
    rootDomains: rootDomains.slice(0, 16),
    topics,
    topTags,
    folders,
    duplicateGroups,
    duplicateCount: duplicateGroups.length,
    staleItems,
    staleCount,
    deadLinks,
    deadCount,
    yearHistogram,
    authorLeaderboard,
    venueLeaderboard,
    reading: { weeklyHistogram, monthlyHistogram },
    totals: {
      items: items.length,
      domains: domainCounts.size,
      topics: topics.length,
      duplicates: duplicateGroups.length,
      stale: staleCount,
      dead: deadCount,
      withDates,
      withNotes,
    },
    totalOutbound: items.length,
  }
}

function computeTopics(items: Item[], topTags: Array<{ tag: string; count: number }>, folders: Array<{ name: string; count: number; itemIds: string[] }>): ResearchAggs["topics"] {
  // Prefer tag-driven topics; fall back to folder-driven; final fallback
  // is keyword-driven by domain root + title keywords.
  if (topTags.length >= 3) {
    const map = new Map<string, string[]>()
    for (const it of items) {
      if (!it.tags) continue
      for (const t of it.tags) {
        const arr = map.get(t) || []
        arr.push(it.id)
        map.set(t, arr)
      }
    }
    const out: ResearchAggs["topics"] = Array.from(map.entries())
      .map(([name, itemIds]) => ({ name, count: itemIds.length, itemIds }))
      .filter(t => t.count >= 1)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
    if (out.length >= 3) return out
  }
  if (folders.length >= 3) {
    return folders
      .filter(f => f.name !== "(uncategorized)")
      .slice(0, 10)
      .map(f => ({ name: f.name, count: f.count, itemIds: f.itemIds }))
  }
  // Keyword fallback: group titles by stem.
  const stems = new Map<string, string[]>()
  for (const it of items) {
    const stemList = stemKeywords(it.title)
    for (const stem of stemList) {
      const arr = stems.get(stem) || []
      arr.push(it.id)
      stems.set(stem, arr)
    }
  }
  return Array.from(stems.entries())
    .filter(([, ids]) => ids.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10)
    .map(([name, itemIds]) => ({ name, count: itemIds.length, itemIds }))
}

const STOPWORDS = new Set("a an the and or of for to in on by at with from is are was were be being been this that these those it its they them their our your we you i me my mine yours".split(" "))
function stemKeywords(s: string): string[] {
  const words = (s || "").toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []
  const out = new Set<string>()
  for (const w of words) {
    if (STOPWORDS.has(w)) continue
    if (w.length < 4) continue
    out.add(w.replace(/(s|ed|ing)$/, ""))
  }
  return Array.from(out).slice(0, 4)
}

function dedupe<T>(xs: T[]): T[] {
  const seen = new Set<T>()
  const out: T[] = []
  for (const x of xs) {
    if (seen.has(x)) continue
    seen.add(x)
    out.push(x)
  }
  return out
}

function deadReason(it: Item): string {
  if (it.url && DEAD_PATH_HINT.test(it.url)) return "URL contains 'deleted' / '404' / 'removed' marker"
  if (it.domain && DEAD_HOSTS.has(it.domain.toLowerCase())) return `Host ${it.domain} is shut down or no longer hosts content`
  return "Heuristic flag — verify manually"
}

function describeRange(epochs: number[]): string {
  if (!epochs.length) return "no dated items"
  const sorted = epochs.slice().sort((a, b) => a - b)
  const a = new Date(sorted[0]).toISOString().slice(0, 10)
  const b = new Date(sorted[sorted.length - 1]).toISOString().slice(0, 10)
  if (a === b) return a
  return `${a} → ${b}`
}

function describeYearRange(items: Item[]): string {
  const years = items.map(i => i.year).filter((y): y is number => typeof y === "number" && Number.isFinite(y))
  if (!years.length) return "no year metadata"
  const lo = Math.min(...years)
  const hi = Math.max(...years)
  return lo === hi ? `${lo}` : `${lo}–${hi}`
}

function countAuthors(items: Item[]): number {
  const s = new Set<string>()
  for (const it of items) if (it.authors) for (const a of it.authors) s.add(a)
  return s.size
}

function countVenues(items: Item[]): number {
  const s = new Set<string>()
  for (const it of items) if (it.venue) s.add(it.venue)
  return s.size
}

function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

function parseFlexibleDate(s: string): number | undefined {
  if (!s) return undefined
  const trimmed = s.trim()
  if (!trimmed) return undefined
  // Pocket / Instapaper export: unix seconds string
  if (/^\d{9,11}$/.test(trimmed)) {
    const n = parseInt(trimmed, 10)
    return Number.isFinite(n) ? n * 1000 : undefined
  }
  if (/^\d{12,13}$/.test(trimmed)) {
    const n = parseInt(trimmed, 10)
    return Number.isFinite(n) ? n : undefined
  }
  const d = Date.parse(trimmed)
  if (Number.isFinite(d)) return d
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(trimmed)
  if (m) {
    let [, a, b, y] = m
    if (y.length === 2) y = (parseInt(y, 10) >= 70 ? "19" : "20") + y
    const t = Date.UTC(+y, +a - 1, +b)
    if (Number.isFinite(t)) return t
  }
  return undefined
}

// ===========================================================================
// Sample for the LLM
// ===========================================================================

function buildSample(items: Item[], aggs: ResearchAggs, extra?: { folderTree?: FolderNode }): Record<string, unknown> {
  const head = items.slice(0, 8)
  const tail = items.length > 12 ? items.slice(-3) : []
  const sample: Record<string, unknown> = {
    itemCount: items.length,
    sample: [...head, ...tail].map(stripBigFields),
    domains: aggs.domains.slice(0, 12),
    rootDomains: aggs.rootDomains.slice(0, 8),
    topTags: aggs.topTags.slice(0, 12),
    topics: aggs.topics.slice(0, 8),
    folders: aggs.folders.slice(0, 8).map(f => ({ name: f.name, count: f.count })),
    duplicateGroups: aggs.duplicateGroups.slice(0, 6),
    staleItems: aggs.staleItems.slice(0, 8),
    deadLinks: aggs.deadLinks.slice(0, 6),
    yearHistogram: aggs.yearHistogram,
    authorLeaderboard: aggs.authorLeaderboard.slice(0, 8),
    venueLeaderboard: aggs.venueLeaderboard.slice(0, 6),
    weeklyHistogram: aggs.reading.weeklyHistogram.slice(-26),
    monthlyHistogram: aggs.reading.monthlyHistogram.slice(-12),
    totals: aggs.totals,
  }
  if (extra?.folderTree) sample.folderTree = condenseFolderTree(extra.folderTree, 0)
  return sample
}

function condenseFolderTree(node: FolderNode, depth: number): unknown {
  return {
    name: node.name,
    count: node.count,
    children: depth >= 2 ? node.children.map(c => ({ name: c.name, count: c.count })) : node.children.map(c => condenseFolderTree(c, depth + 1)),
  }
}

function stripBigFields(it: Item): Item {
  const { abstract, note, raw, ...rest } = it
  const trimmedAbs = abstract && abstract.length > 240 ? `${abstract.slice(0, 240)}…` : abstract
  const trimmedNote = note && note.length > 240 ? `${note.slice(0, 240)}…` : note
  return { ...rest, abstract: trimmedAbs, note: trimmedNote, raw }
}

// ===========================================================================
// CSV helpers (mirrors planning.ts; could be promoted later)
// ===========================================================================

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
