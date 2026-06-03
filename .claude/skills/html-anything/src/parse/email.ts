/**
 * Parse `.eml` (single message) and `.mbox` (mailbox archive) into
 * structured email data. Also handles Gmail Takeout-style mbox exports,
 * since those are just regular mboxo with one giant file per label.
 *
 * No external deps. Best-effort RFC 5322 / 2045 / 2046 parsing:
 * unfolds headers, decodes MIME encoded-words, walks multipart bodies,
 * decodes quoted-printable and base64 text/* parts, captures attachment
 * metadata (without keeping their bytes), reconstructs threads via
 * In-Reply-To / References, and falls back to a normalized subject key
 * when those headers are missing.
 *
 * The parser's job is only to make the archive legible to the LLM —
 * counts, senders, threads, sample messages. The LLM in `htmlize`
 * decides the actual page layout.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { Parser, ParsedFile } from "../types.js"

interface Address { name: string; email: string }
interface Attachment { filename: string; contentType: string; sizeEstimate: number }

interface EmailMsg {
  id: string
  ts: string
  date: string
  time: string
  tsEpoch: number
  messageId: string
  inReplyTo: string | null
  references: string[]
  threadId: string
  from: Address
  to: Address[]
  cc: Address[]
  subject: string
  subjectKey: string
  body: string
  bodyPreview: string
  attachments: Attachment[]
  isReply: boolean
  isForward: boolean
  hasQuestion: boolean
}

interface Thread {
  id: string
  subject: string
  participants: string[]
  messageIds: string[]
  firstTs: string
  lastTs: string
  messageCount: number
  lastSender: string
  lastEndsInQuestion: boolean
}

export const parser: Parser = {
  name: "email",
  matches: [".eml", ".mbox", ".mbx"],
  async detect(filepath: string): Promise<boolean> {
    try {
      const fd = await fs.open(filepath, "r")
      const buf = Buffer.alloc(4096)
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0)
      await fd.close()
      const sample = buf.subarray(0, bytesRead).toString("utf8")
      const hasMboxSep = /^From .+\d{4}/m.test(sample)
      const hasHeader = /^(?:From|Subject|To|Date|Message-Id):\s/im.test(sample)
      return hasMboxSep || hasHeader
    } catch {
      return false
    }
  },
  async parse(filepath: string): Promise<ParsedFile> {
    const raw = await fs.readFile(filepath, "utf8")
    const ext = path.extname(filepath).toLowerCase()
    const looksLikeMbox = /^From .+\d{4}/m.test(raw.split("\n").slice(0, 5).join("\n"))
    const isMbox = ext === ".mbox" || ext === ".mbx" || looksLikeMbox

    const rawMessages = isMbox ? splitMbox(raw) : [raw]
    const messages: EmailMsg[] = []
    for (let i = 0; i < rawMessages.length; i++) {
      const m = parseMessage(rawMessages[i], `m_${String(i + 1).padStart(4, "0")}`)
      if (m) messages.push(m)
    }
    messages.sort((a, b) => a.tsEpoch - b.tsEpoch)
    // Reassign sequential ids in chronological order so the data is
    // easy to follow when scrolling through DATA.messages.
    messages.forEach((m, i) => { m.id = `m_${String(i + 1).padStart(4, "0")}` })

    assignThreads(messages)

    const threads = buildThreads(messages)
    const senders = buildSenders(messages)
    const domains = buildDomains(senders)

    const attachments: (Attachment & { threadId: string; ts: string; fromEmail: string })[] = []
    for (const m of messages) {
      for (const a of m.attachments) {
        attachments.push({ ...a, threadId: m.threadId, ts: m.ts, fromEmail: m.from.email })
      }
    }

    const dateRange = messages.length
      ? `${messages[0].date} → ${messages[messages.length - 1].date}`
      : "(empty)"

    const meta = {
      sourceFile: path.basename(filepath),
      sizeBytes: Buffer.byteLength(raw, "utf8"),
      format: isMbox ? "mbox" : "eml",
      messageCount: messages.length,
      threadCount: threads.length,
      senderCount: senders.length,
      domainCount: domains.length,
      attachmentCount: attachments.length,
      dateRange,
      topSenders: senders.slice(0, 8),
      topDomains: domains.slice(0, 6),
    }

    const longestThread = threads.slice().sort((a, b) => b.messageCount - a.messageCount)[0]
    const longestThreadSample: EmailMsg[] = []
    if (longestThread) {
      const ms = longestThread.messageIds
        .map(id => messages.find(m => m.id === id))
        .filter((m): m is EmailMsg => !!m)
      longestThreadSample.push(...ms.slice(0, 1), ...ms.slice(-2))
    }
    const sample = {
      ...meta,
      first: messages.slice(0, 4).map(stripBigBody),
      last: messages.slice(-4).map(stripBigBody),
      longestThread: longestThread
        ? {
            id: longestThread.id,
            subject: longestThread.subject,
            participants: longestThread.participants,
            messageCount: longestThread.messageCount,
            sample: longestThreadSample.map(stripBigBody),
          }
        : null,
      threadShapes: threads.slice(0, 8).map(t => ({
        id: t.id,
        subject: t.subject,
        participants: t.participants,
        messageCount: t.messageCount,
        firstTs: t.firstTs,
        lastTs: t.lastTs,
        lastEndsInQuestion: t.lastEndsInQuestion,
      })),
      openLoops: threads.filter(t => t.lastEndsInQuestion).slice(0, 6).map(t => ({
        threadId: t.id,
        subject: t.subject,
        lastSender: t.lastSender,
        lastTs: t.lastTs,
      })),
    }

    return {
      contentType: "email-archive",
      summary: `Email archive (${meta.format}): ${messages.length} messages across ${threads.length} thread${threads.length === 1 ? "" : "s"} from ${senders.length} sender${senders.length === 1 ? "" : "s"}, ${dateRange}.`,
      sample,
      data: { messages, threads, senders, domains, attachments, ...meta },
      meta,
    }
  },
}

// ---------------------------------------------------------------------------
// mbox splitter
// ---------------------------------------------------------------------------

function splitMbox(raw: string): string[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n")
  const out: string[] = []
  let curr: string[] | null = null
  for (const line of lines) {
    // mbox separator: `From ` (with space, not colon) followed by an
    // address-and-date line. Distinct from a `From:` header.
    if (line.startsWith("From ") && !line.startsWith("From:") && /\d{4}/.test(line)) {
      if (curr) out.push(curr.join("\n"))
      curr = []
      continue
    }
    if (curr !== null) {
      // mboxo unquoting: turn ">From " back into "From " inside a body.
      curr.push(line.replace(/^>From /, "From "))
    } else if (line.trim()) {
      // Some mbox files lack a leading "From " marker (or it's a single
      // .eml dressed as .mbox). Treat the whole file as one message.
      curr = [line]
    }
  }
  if (curr) out.push(curr.join("\n"))
  return out.filter(s => s.trim().length > 0)
}

// ---------------------------------------------------------------------------
// Per-message parser
// ---------------------------------------------------------------------------

function parseMessage(raw: string, fallbackId: string): EmailMsg | null {
  const norm = raw.replace(/\r\n/g, "\n")
  const cleaned = norm.replace(/^From [^\n]+\n/, "")
  const sepIdx = cleaned.indexOf("\n\n")
  const headerBlock = sepIdx === -1 ? cleaned : cleaned.slice(0, sepIdx)
  const body = sepIdx === -1 ? "" : cleaned.slice(sepIdx + 2)
  return makeStub(headerBlock, body, fallbackId)
}

function makeStub(headerBlock: string, body: string, fallbackId: string): EmailMsg | null {
  const headers = parseHeaders(headerBlock)
  const subject = decodeMimeWord(getHeader(headers, "subject") || "(no subject)")
  const fromRaw = getHeader(headers, "from") || ""
  const from = parseAddressList(fromRaw)[0] || { name: "", email: "" }
  const to = parseAddressList(getHeader(headers, "to") || "")
  const cc = parseAddressList(getHeader(headers, "cc") || "")
  const dateStr = getHeader(headers, "date") || ""
  const messageId = (getHeader(headers, "message-id") || "").trim() || `<${fallbackId}@synthetic>`
  const inReplyTo = (getHeader(headers, "in-reply-to") || "").trim() || null
  const references = (getHeader(headers, "references") || "")
    .split(/\s+/)
    .map(s => s.trim())
    .filter(s => s.startsWith("<") && s.endsWith(">"))

  const ct = getHeader(headers, "content-type") || "text/plain"
  const cte = (getHeader(headers, "content-transfer-encoding") || "").toLowerCase().trim()
  const { text, attachments } = extractBody(body, ct, cte)

  const ts = parseEmailDate(dateStr)
  const tsEpoch = ts ? ts.getTime() : 0
  const tsStr = ts ? formatTs(ts) : "1970-01-01 00:00:00"
  const date = tsStr.slice(0, 10)
  const time = tsStr.slice(11)

  const cleanedText = text.trim()
  const bodyPreview = cleanedText.replace(/\s+/g, " ").slice(0, 240)
  const lastBodyParagraph = lastSubstantialParagraph(cleanedText)
  const hasQuestion =
    /\?/.test(lastBodyParagraph) ||
    /\b(could you|can you|would you|let me know|any update|any thoughts|please confirm|please advise|please send|when can|how do)\b/i.test(lastBodyParagraph)

  const isReply = /^\s*re:/i.test(subject) || !!inReplyTo
  const isForward = /^\s*fwd?:/i.test(subject)

  return {
    id: fallbackId,
    ts: tsStr, date, time, tsEpoch,
    messageId, inReplyTo, references,
    threadId: "",
    from, to, cc,
    subject,
    subjectKey: normalizeSubjectKey(subject),
    body: cleanedText,
    bodyPreview,
    attachments,
    isReply, isForward, hasQuestion,
  }
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

function parseHeaders(block: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const lines = block.split("\n")
  let buf = ""
  let key = ""
  const flush = () => {
    if (key) {
      const arr = out.get(key) || []
      arr.push(buf.trim())
      out.set(key, arr)
    }
  }
  for (const line of lines) {
    if (/^[ \t]/.test(line)) { buf += " " + line.trim(); continue }
    flush()
    const m = /^([^:\s]+)\s*:\s*(.*)$/.exec(line)
    if (m) { key = m[1].toLowerCase(); buf = m[2] } else { key = ""; buf = "" }
  }
  flush()
  return out
}

function getHeader(headers: Map<string, string[]>, name: string): string {
  const arr = headers.get(name.toLowerCase())
  return arr && arr.length ? arr[0] : ""
}

// ---------------------------------------------------------------------------
// MIME encoded-word decoding (=?charset?Q?...?= / ...?B?base64?=)
// ---------------------------------------------------------------------------

function decodeMimeWord(input: string): string {
  return input.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset: string, enc: string, payload: string) => {
    try {
      let bytes: Buffer
      if (enc.toUpperCase() === "B") {
        bytes = Buffer.from(payload, "base64")
      } else {
        const replaced = payload
          .replace(/_/g, " ")
          .replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
        bytes = Buffer.from(replaced, "binary")
      }
      const cs = charset.toLowerCase()
      if (cs === "utf-8" || cs === "utf8" || cs === "us-ascii" || cs === "ascii") return bytes.toString("utf8")
      if (cs === "iso-8859-1" || cs === "latin1") return bytes.toString("latin1")
      try { return new TextDecoder(charset).decode(bytes) } catch { return bytes.toString("utf8") }
    } catch {
      return payload
    }
  })
}

// ---------------------------------------------------------------------------
// Address parsing
// ---------------------------------------------------------------------------

function parseAddressList(raw: string): Address[] {
  if (!raw) return []
  const decoded = decodeMimeWord(raw)
  const parts: string[] = []
  let depth = 0
  let inQuote = false
  let cur = ""
  for (const ch of decoded) {
    if (ch === '"' && depth === 0) inQuote = !inQuote
    if (!inQuote) {
      if (ch === "<") depth++
      if (ch === ">") depth = Math.max(0, depth - 1)
      if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue }
    }
    cur += ch
  }
  if (cur.trim()) parts.push(cur)
  return parts.map(parseAddress).filter(a => a.email)
}

function parseAddress(raw: string): Address {
  const s = raw.trim()
  const angle = /<([^>]+)>/.exec(s)
  if (angle) {
    const email = angle[1].trim()
    const name = s.slice(0, angle.index).trim().replace(/^"(.*)"$/, "$1").trim()
    return { name, email }
  }
  return { name: "", email: s }
}

// ---------------------------------------------------------------------------
// Body extraction (multipart walker + decoders)
// ---------------------------------------------------------------------------

function extractBody(body: string, contentType: string, cte: string): { text: string; attachments: Attachment[] } {
  const ct = contentType.toLowerCase()
  if (ct.startsWith("multipart/")) {
    const boundaryMatch = /boundary\s*=\s*"?([^";]+)"?/i.exec(contentType)
    if (!boundaryMatch) return { text: body, attachments: [] }
    return walkMultipart(body, boundaryMatch[1])
  }
  return decodeSinglePart(body, contentType, cte)
}

function walkMultipart(body: string, boundary: string): { text: string; attachments: Attachment[] } {
  const sep = `--${boundary}`
  const parts = body.split(sep)
  const collectedAttachments: Attachment[] = []
  let preferred = ""
  let htmlFallback = ""
  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed || trimmed === "--") continue
    const innerSep = trimmed.indexOf("\n\n")
    if (innerSep === -1) continue
    const headerBlock = trimmed.slice(0, innerSep)
    const partBody = trimmed.slice(innerSep + 2)
    const headers = parseHeaders(headerBlock)
    const ct = (getHeader(headers, "content-type") || "text/plain").toLowerCase()
    const cte = (getHeader(headers, "content-transfer-encoding") || "").toLowerCase().trim()
    const cd = getHeader(headers, "content-disposition") || ""
    const filename = parseFilename(cd, ct)
    const isAttachment = /attachment/i.test(cd) || (filename && !ct.startsWith("text/"))

    if (isAttachment && filename) {
      collectedAttachments.push({
        filename: decodeMimeWord(filename),
        contentType: ct.split(";")[0].trim(),
        sizeEstimate: estimateDecodedSize(partBody, cte),
      })
      continue
    }
    if (ct.startsWith("multipart/")) {
      const innerBoundary = /boundary\s*=\s*"?([^";]+)"?/i.exec(ct)?.[1] || ""
      const sub = walkMultipart(partBody, innerBoundary)
      if (sub.text && !preferred) preferred = sub.text
      collectedAttachments.push(...sub.attachments)
      continue
    }
    if (ct.startsWith("text/plain") && !preferred) {
      preferred = decodeSinglePart(partBody, ct, cte).text
      continue
    }
    if (ct.startsWith("text/html") && !htmlFallback) {
      htmlFallback = decodeSinglePart(partBody, ct, cte).text
      continue
    }
  }
  const text = preferred || htmlFallback
  return { text, attachments: collectedAttachments }
}

function decodeSinglePart(body: string, contentType: string, cte: string): { text: string; attachments: Attachment[] } {
  let text = body
  if (cte === "quoted-printable") text = decodeQuotedPrintable(text)
  else if (cte === "base64") text = Buffer.from(text.replace(/\s+/g, ""), "base64").toString("utf8")
  if (contentType.toLowerCase().startsWith("text/html")) text = htmlToText(text)
  return { text, attachments: [] }
}

function parseFilename(contentDisposition: string, contentType: string): string {
  const cd = /filename\*?=\s*"?([^";]+)"?/i.exec(contentDisposition)
  if (cd) return cd[1]
  const ct = /name\s*=\s*"?([^";]+)"?/i.exec(contentType)
  if (ct) return ct[1]
  return ""
}

function estimateDecodedSize(part: string, cte: string): number {
  if (cte === "base64") {
    const cleaned = part.replace(/\s+/g, "")
    return Math.floor((cleaned.length * 3) / 4)
  }
  return Buffer.byteLength(part, "utf8")
}

function decodeQuotedPrintable(s: string): string {
  return s
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
}

function htmlToText(s: string): string {
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(parseInt(n, 10)))
}

// ---------------------------------------------------------------------------
// Date / subject helpers
// ---------------------------------------------------------------------------

function parseEmailDate(s: string): Date | null {
  if (!s) return null
  const d = new Date(s)
  if (!isNaN(d.getTime())) return d
  return null
}

function formatTs(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

function normalizeSubjectKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/^(\s*(re|fwd?|aw|sv|antw|tr)\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim()
}

function stripReplyPrefix(s: string): string {
  return s.replace(/^(\s*(re|fwd?|aw|sv|antw|tr)\s*:\s*)+/i, "").trim()
}

function lastSubstantialParagraph(text: string): string {
  // Split into paragraphs, skip quoted blocks (lines starting with `>`)
  // and short trailing lines that look like signatures.
  const paragraphs = text
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(p => p && !/^>/m.test(p.split("\n")[0] || ""))
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const p = paragraphs[i]
    if (p.length >= 40 || /\?/.test(p)) return p
  }
  return paragraphs.length ? paragraphs[paragraphs.length - 1] : ""
}

function stripBigBody(m: EmailMsg): EmailMsg {
  return { ...m, body: m.body.length > 800 ? m.body.slice(0, 800) + "…" : m.body }
}

// ---------------------------------------------------------------------------
// Thread + sender aggregation
// ---------------------------------------------------------------------------

function assignThreads(messages: EmailMsg[]): void {
  const byId = new Map<string, EmailMsg>()
  for (const m of messages) if (m.messageId) byId.set(m.messageId, m)

  // Walk reply chains to find each message's root.
  const rootOf = new Map<string, string>()
  for (const m of messages) {
    let root = m.messageId
    const chain = [m.inReplyTo, ...(m.references || [])].filter(Boolean) as string[]
    for (const ref of chain) {
      if (byId.has(ref)) { root = ref; break }
    }
    rootOf.set(m.messageId, root)
  }
  // Resolve transitive roots in case a `root` is itself a child.
  for (const m of messages) {
    let cur = rootOf.get(m.messageId) || m.messageId
    const seen = new Set<string>()
    while (rootOf.has(cur) && rootOf.get(cur) !== cur && !seen.has(cur)) {
      seen.add(cur)
      cur = rootOf.get(cur)!
    }
    rootOf.set(m.messageId, cur)
  }

  // Subject-fallback grouping for messages with no chain match.
  const subjectGroups = new Map<string, string>()
  const threadIds = new Map<string, string>()
  let counter = 0
  for (const m of messages) {
    let key = rootOf.get(m.messageId) || m.messageId
    if (!byId.has(key) && m.subjectKey) {
      if (!subjectGroups.has(m.subjectKey)) subjectGroups.set(m.subjectKey, key)
      key = subjectGroups.get(m.subjectKey)!
    } else if (m.subjectKey) {
      // Even if we matched a root by ID, also collapse by normalized
      // subject to merge any branches with the same topic.
      const subjectRoot = subjectGroups.get(m.subjectKey)
      if (!subjectRoot) subjectGroups.set(m.subjectKey, key)
      else key = subjectRoot
    }
    if (!threadIds.has(key)) {
      counter++
      threadIds.set(key, `t_${String(counter).padStart(4, "0")}`)
    }
    m.threadId = threadIds.get(key)!
  }
}

function buildThreads(messages: EmailMsg[]): Thread[] {
  const threadMap = new Map<string, Thread>()
  for (const m of messages) {
    let t = threadMap.get(m.threadId)
    const senderLabel = m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email
    if (!t) {
      t = {
        id: m.threadId,
        subject: stripReplyPrefix(m.subject) || m.subject,
        participants: [],
        messageIds: [],
        firstTs: m.ts,
        lastTs: m.ts,
        messageCount: 0,
        lastSender: senderLabel,
        lastEndsInQuestion: false,
      }
      threadMap.set(m.threadId, t)
    }
    t.messageIds.push(m.id)
    t.messageCount++
    if (m.ts < t.firstTs) t.firstTs = m.ts
    if (m.ts >= t.lastTs) {
      t.lastTs = m.ts
      t.lastSender = senderLabel
      t.lastEndsInQuestion = m.hasQuestion
    }
    if (!t.participants.includes(senderLabel)) t.participants.push(senderLabel)
    for (const r of [...m.to, ...m.cc]) {
      const lbl = r.name ? `${r.name} <${r.email}>` : r.email
      if (!t.participants.includes(lbl)) t.participants.push(lbl)
    }
    if (!m.isReply) {
      const stripped = stripReplyPrefix(m.subject)
      if (stripped) t.subject = stripped
    }
  }
  return Array.from(threadMap.values()).sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1))
}

function buildSenders(messages: EmailMsg[]) {
  const senderMap = new Map<string, { email: string; name: string; count: number; domain: string }>()
  for (const m of messages) {
    const e = m.from.email
    if (!e) continue
    const cur = senderMap.get(e) || { email: e, name: m.from.name, count: 0, domain: e.split("@")[1] || "" }
    cur.count++
    if (!cur.name && m.from.name) cur.name = m.from.name
    senderMap.set(e, cur)
  }
  return Array.from(senderMap.values()).sort((a, b) => b.count - a.count)
}

function buildDomains(senders: { domain: string; count: number }[]) {
  const map = new Map<string, number>()
  for (const s of senders) map.set(s.domain, (map.get(s.domain) || 0) + s.count)
  return Array.from(map.entries())
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count)
}
