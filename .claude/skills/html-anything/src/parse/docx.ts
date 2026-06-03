/**
 * DOCX parser — turns a Word document into the same shape we use for
 * markdown / PDF: structured text, headings, and a sample. We use
 * mammoth to extract markdown (it preserves headings, lists, basic
 * emphasis, and tables as pipe-style text) and treat the rest like a
 * long-form document.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as mammoth from "mammoth"
import type { Parser, ParsedFile } from "../types.js"

interface Heading {
  level: number
  text: string
}

export const parser: Parser = {
  name: "docx",
  matches: [".docx"],
  async parse(filepath: string): Promise<ParsedFile> {
    const buf = await fs.readFile(filepath)
    // mammoth.convertToMarkdown gives us heading levels + lists + tables
    // in a single text stream we can both sample and render client-side.
    // mammoth's TS types only expose `convertToHtml`, but the runtime
    // module also ships `convertToMarkdown`, which gives us heading
    // levels + lists + tables in a single text stream we can both
    // sample to the LLM and render client-side. Cast through unknown
    // because the published d.ts is incomplete.
    type MammothExtra = {
      convertToMarkdown: (input: { buffer: Buffer }) => Promise<{
        value: string
        messages: unknown[]
      }>
    }
    const md = await (mammoth as unknown as MammothExtra).convertToMarkdown({ buffer: buf })
    const markdown = md.value
    const plain = markdownToPlain(markdown)
    const lines = markdown.split("\n")
    const headings: Heading[] = []
    for (const line of lines) {
      const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
      if (m) headings.push({ level: m[1].length, text: unescapeMarkdown(m[2]) })
    }

    const wordCount = plain.split(/\s+/).filter(Boolean).length
    const readingMinutes = Math.max(1, Math.round(wordCount / 220))
    const meta = {
      sourceFile: path.basename(filepath),
      sizeBytes: buf.byteLength,
      wordCount,
      lineCount: lines.length,
      headingCount: headings.length,
      readingMinutes,
    }

    const summary =
      `Word document, ${wordCount} words, ` +
      `~${readingMinutes}-min read, ` +
      `${headings.length} heading${headings.length === 1 ? "" : "s"}` +
      (headings.length ? ` (top: "${headings[0].text}")` : "") +
      (md.messages?.length ? ` (mammoth notes: ${md.messages.length})` : "")

    return {
      contentType: "docx-document",
      summary,
      sample: {
        ...meta,
        headings: headings.slice(0, 40),
        opening: markdown.slice(0, 1800),
        closing: markdown.length > 3500 ? markdown.slice(-700) : "",
      },
      data: {
        markdown,
        plainText: plain,
        headings,
        ...meta,
      },
      meta,
    }
  },
}

function unescapeMarkdown(text: string): string {
  // mammoth escapes characters that would otherwise look like markdown
  // syntax (`1\.` instead of `1.`). The escape is correct in the
  // markdown body but visually noisy in heading labels.
  return text.replace(/\\([\\`*_{}\[\]()#+\-.!|])/g, "$1")
}

function markdownToPlain(md: string): string {
  // Cheap markdown-to-plain to make the word count meaningful. We strip
  // fences, list markers, link/image syntax, and emphasis chars; we keep
  // the words inside.
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[*_~]+/g, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}
