/**
 * PDF parser — extracts text + structural hints from a PDF and gives the
 * LLM enough to design a reading/insight page. We deliberately keep the
 * extraction simple: per-page text, length, top-of-page lines that look
 * like headings, and a representative sample. The LLM does the analysis;
 * we just make the bytes legible.
 *
 * Implementation: pdfjs-dist's legacy build runs in plain Node 20+ with
 * no DOM shim. We disable the worker, eval, and font loading because we
 * never need rendering — only text extraction.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { Parser, ParsedFile } from "../types.js"

interface PageText {
  page: number
  text: string
  lineCount: number
  charCount: number
}

interface Heading {
  page: number
  level: number
  text: string
}

export const parser: Parser = {
  name: "pdf",
  matches: [".pdf"],
  async parse(filepath: string): Promise<ParsedFile> {
    const buf = await fs.readFile(filepath)
    const sizeBytes = buf.byteLength
    const pages = await extractPages(buf)
    const headings = inferHeadings(pages)
    const fullText = pages.map(p => p.text).join("\n\n")
    const wordCount = fullText.split(/\s+/).filter(Boolean).length
    const charCount = fullText.length
    const readingMinutes = Math.max(1, Math.round(wordCount / 220))

    const meta = {
      sourceFile: path.basename(filepath),
      sizeBytes,
      pageCount: pages.length,
      wordCount,
      charCount,
      headingCount: headings.length,
      readingMinutes,
    }

    const summary =
      `PDF, ${pages.length} page${pages.length === 1 ? "" : "s"}, ` +
      `${wordCount} words, ~${readingMinutes}-min read` +
      (headings.length ? `, ${headings.length} likely sections` : "")

    return {
      contentType: "pdf-document",
      summary,
      sample: {
        ...meta,
        opening: fullText.slice(0, 1800),
        closing: fullText.length > 3500 ? fullText.slice(-700) : "",
        firstPage: pages[0]?.text.slice(0, 1200) || "",
        midPage: pages[Math.floor(pages.length / 2)]?.text.slice(0, 800) || "",
        headings: headings.slice(0, 40),
      },
      data: {
        pages: pages.map(p => ({ page: p.page, text: p.text })),
        headings,
        text: fullText,
        ...meta,
      },
      meta,
    }
  },
}

async function extractPages(buf: Buffer): Promise<PageText[]> {
  // pdfjs-dist exports a getDocument API on the legacy/Node-friendly
  // build. We disable the worker (runs inline) and font/eval features
  // we don't need for text extraction.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  const loading = pdfjs.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
  })
  const doc = await loading.promise
  const pages: PageText[] = []
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const text = pdfTextItemsToText(content.items as PdfTextItem[])
      pages.push({
        page: i,
        text,
        lineCount: text.split("\n").length,
        charCount: text.length,
      })
      page.cleanup()
    }
  } finally {
    await doc.cleanup()
    await doc.destroy()
  }
  return pages
}

interface PdfTextItem {
  str: string
  hasEOL?: boolean
  transform?: number[]
}

function pdfTextItemsToText(items: PdfTextItem[]): string {
  // pdfjs returns a flat list of text fragments; reconstruct lines using
  // the EOL hints it ships, falling back to a single space between items.
  const out: string[] = []
  let line: string[] = []
  for (const it of items) {
    if (typeof it.str === "string" && it.str.length) line.push(it.str)
    if (it.hasEOL) {
      out.push(line.join(""))
      line = []
    }
  }
  if (line.length) out.push(line.join(""))
  return out
    .map(l => l.replace(/[ \t]+/g, " ").trimEnd())
    .filter(l => l.length > 0)
    .join("\n")
}

function inferHeadings(pages: PageText[]): Heading[] {
  // PDFs don't expose a heading outline reliably. We approximate via
  // formatting heuristics: short, title-shaped lines that don't end
  // with sentence punctuation. Numbered headings (1., 1.1) are
  // promoted to a higher level. We deliberately err on the side of
  // *fewer* headings — a noisy nav is worse than a sparse one.
  const headings: Heading[] = []
  for (const { page, text } of pages) {
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim()
      if (!raw) continue
      if (raw.length > 80) continue
      if (raw.length < 3) continue
      if (/[.!?:;,]$/.test(raw)) continue
      // Skip lines that look like table rows (multiple numbers / %).
      const numericTokens = (raw.match(/\b\d+(\.\d+)?%?\b/g) || []).length
      if (numericTokens >= 2) continue
      // Skip lines that are mostly punctuation or non-letters.
      const letters = (raw.match(/[A-Za-z]/g) || []).length
      if (letters < raw.length * 0.5) continue
      // A heading-shaped line is one of:
      //   - numbered section ("1.", "1.1 Title", "2.3.1 Foo")
      //   - all-caps short line
      //   - Title-Case short line where MOST words start uppercase
      const numbered = /^\d+(\.\d+)*\.?\s+\S/.test(raw)
      const allCaps = raw === raw.toUpperCase() && letters >= 4
      const titleCaseScore = titleCaseScoreOf(raw)
      const titleCase = titleCaseScore >= 0.6 && raw.split(/\s+/).length <= 10
      if (!numbered && !allCaps && !titleCase) continue
      const level = inferHeadingLevel(raw)
      headings.push({ page, level, text: raw })
    }
  }
  return dedupe(headings)
}

function titleCaseScoreOf(line: string): number {
  // Fraction of "content words" (length >= 3, alphabetic) that start
  // with an uppercase letter. Conjunctions and short words are skipped
  // so "Risks &amp; Counter-Theses" still scores high.
  const words = line.split(/\s+/).filter(w => /^[A-Za-z]/.test(w) && w.length >= 3)
  if (words.length === 0) return 0
  const upper = words.filter(w => /^[A-Z]/.test(w)).length
  return upper / words.length
}

function dedupe(items: Heading[]): Heading[] {
  // Drop adjacent duplicates the parser produced from multi-column or
  // wrapped layout artifacts.
  const out: Heading[] = []
  for (const h of items) {
    const prev = out[out.length - 1]
    if (prev && prev.text === h.text && prev.page === h.page) continue
    out.push(h)
  }
  return out
}

function inferHeadingLevel(text: string): number {
  const m = /^(\d+(?:\.\d+)*)/.exec(text)
  if (m) {
    const depth = m[1].split(".").length
    return Math.min(6, Math.max(1, depth))
  }
  if (text === text.toUpperCase()) return 1
  return 2
}
