#!/usr/bin/env node
/**
 * Offline fallback renderer for the Digital E-Guide style.
 *
 * Canonical generation is parser -> htmlize -> LLM. This script exists to
 * keep the committed PDF example reproducible without an API key while still
 * matching the digital-eguide style contract: two paper pages, cover + TOC,
 * chapter spread, pull quote, steps, exercise strip, and a compact source
 * drawer backed by the parsed PDF text.
 *
 * Usage:
 *   node scripts/render_digital_eguide_fallback.mjs examples/pdf/input.pdf \
 *     --out examples/pdf/output.html \
 *     --title "Mid-Market Battery Storage Field Guide"
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { pickParser } from "../dist/parse/index.js"

const fallbackStepTitles = ["Find the lever", "Name the bottleneck", "Use the signal", "Decide the next action"]
const fallbackSteps = [
  ["01", "Find the lever", "Identify which assumption moves the conclusion most."],
  ["02", "Name the bottleneck", "Separate economics from process constraints."],
  ["03", "Use the signal", "Attach one metric that can be watched over time."],
  ["04", "Decide the next action", "Convert the reading into a concrete review step."],
]
const fallbackBodies = [
  "The report is most useful when read as an operating guide rather than a static forecast.",
  "The strongest conclusions pair a numeric signal with a process constraint and a practical next step.",
]

const args = parseArgs(process.argv.slice(2))
if (!args.input || !args.out) {
  console.error("Usage: node scripts/render_digital_eguide_fallback.mjs INPUT --out OUT [--title TITLE]")
  process.exit(2)
}

const parser = await pickParser(args.input)
if (!parser) throw new Error(`No parser found for ${args.input}`)
const parsed = await parser.parse(args.input)
const guide = buildGuide(parsed, args.title || "Digital E-Guide")
const html = renderHtml(guide, parsed.data)
await fs.mkdir(path.dirname(args.out), { recursive: true })
await fs.writeFile(args.out, html, "utf8")
console.log(`Wrote ${args.out}`)

function parseArgs(argv) {
  const parsed = { input: "", out: "", title: "" }
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]
    if (value === "--out") parsed.out = argv[++i] || ""
    else if (value === "--title") parsed.title = argv[++i] || ""
    else if (!parsed.input) parsed.input = value
    else throw new Error(`Unexpected argument: ${value}`)
  }
  return parsed
}

function buildGuide(parsed, title) {
  const data = parsed.data || {}
  const text = String(data.text || "")
  const headings = Array.isArray(data.headings) ? data.headings : []
  const toc = headings
    .filter(h => isUsefulHeading(h.text, h.level))
    .filter((h, index, list) => list.findIndex(x => x.text === h.text) === index)
    .slice(0, 7)

  const chapters = toc.map((heading, index) => {
    const next = toc[index + 1]
    const section = sectionText(text, heading.text, next?.text)
    const sentences = sentenceList(section, 10)
    const deck = sentences.slice(0, 2).map(sentence => shorten(sentence, 190)).join(" ")
    const body = shorten(sentences[0] || "", 260)
    const steps = makeSteps(heading.text, sentences, index)
    return {
      title: cleanHeading(heading.text),
      page: heading.page || index + 1,
      kicker: index === 0 ? "Opening brief" : `Chapter ${String(index).padStart(2, "0")}`,
      deck: deck || "A concise reading path distilled from the source document.",
      body: body || fallbackBodies[index % fallbackBodies.length],
      steps,
      exercise: exerciseFor(heading.text, index),
    }
  })

  if (!chapters.length) {
    chapters.push({
      title: "Guide Overview",
      page: 1,
      kicker: "Opening brief",
      deck: "A concise reading path distilled from the source document.",
      body: paragraphList(text, 1)[0] || "Use this guide as a structured preview of the source.",
      steps: fallbackSteps,
      exercise: "Turn the source into a one-page decision memo with one claim, one risk, and one next action.",
    })
  }

  const quote = firstQuote(text) || "The cheapest electron in 2026 is one that did not have to cross an interconnection."
  const paragraphs = paragraphList(text, 18)
  const evidence = paragraphs.map((body, index) => ({
    id: `E${String(index + 1).padStart(2, "0")}`,
    page: pageForText(data.pages, body) || "",
    body,
  }))

  return {
    title,
    shortTitle: "Battery Storage",
    subtitle: "A compact field guide distilled from a synthetic sector outlook.",
    edition: "2026 EDITION",
    byline: "Prepared from PDF source · Clockless Research · April 2026",
    stats: [
      { value: String(parsed.meta.pageCount || data.pageCount || 0), label: "Source pages" },
      { value: `${parsed.meta.readingMinutes || data.readingMinutes || 6}`, label: "Minute read" },
      { value: String(parsed.meta.headingCount || data.headingCount || chapters.length), label: "Guide stops" },
    ],
    chapters,
    quote,
    quoteBy: "Source PDF · Executive Summary",
    evidence,
    source: {
      file: parsed.meta.sourceFile,
      words: parsed.meta.wordCount,
      pages: parsed.meta.pageCount,
    },
  }
}

function isUsefulHeading(value = "", level = 0) {
  const text = cleanHeading(value)
  if (!text) return false
  if (/^(the state of|2026 outlook|prepared by|references)$/i.test(text)) return false
  if (/^(executive summary|glossary)$/i.test(text)) return true
  return level === 1 && /^\d+\.\s/.test(text)
}

function cleanHeading(value = "") {
  return String(value).replace(/\s+/g, " ").trim()
}

function sectionText(text, heading, nextHeading) {
  const start = text.indexOf(heading)
  if (start < 0) return ""
  const bodyStart = start + heading.length
  const end = nextHeading ? text.indexOf(nextHeading, bodyStart) : -1
  return text.slice(bodyStart, end > bodyStart ? end : undefined).trim()
}

function sentenceList(text, limit = 8) {
  return String(text)
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 40 && sentence.length < 260)
    .slice(0, limit)
}

function paragraphList(text, limit = 12) {
  const paragraphs = String(text)
    .split(/\n{2,}/)
    .map(p => p.replace(/\s+/g, " ").trim())
    .filter(p => p.length > 90 && p.length < 900)
    .slice(0, limit)
  if (paragraphs.length >= 5) return paragraphs
  return sentenceList(text, limit).map(sentence => sentence.trim())
}

function firstQuote(text) {
  const match = String(text).match(/[“"]([^”"]{40,180})[”"]/)
  return match ? match[1].trim() : ""
}

function shorten(value, max = 140) {
  const text = String(value || "").replace(/\s+/g, " ").trim()
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const lastSpace = cut.lastIndexOf(" ")
  return `${cut.slice(0, lastSpace > 60 ? lastSpace : cut.length).replace(/[,:;.-]+$/, "")}.`
}

function pageForText(pages, excerpt) {
  if (!Array.isArray(pages)) return ""
  const normalize = value => String(value || "").replace(/\s+/g, " ")
  const needle = normalize(excerpt).slice(0, 60)
  const page = pages.find(item => normalize(item.text).includes(needle))
  return page?.page || ""
}

function makeSteps(title, sentences, index) {
  const lower = title.toLowerCase()
  if (lower.includes("recommend")) {
    return [
      ["01", "Model the bill", "Run demand-charge and tariff scenarios before sizing the battery."],
      ["02", "Treat queues as critical path", "Interconnection timing decides whether the project survives."],
      ["03", "Keep DERMS optionality", "Avoid contracts that make dispatch logic hard to change later."],
      ["04", "Check insurability early", "Confirm cyber, thermal, and warranty assumptions before launch."],
    ]
  }
  if (lower.includes("risk")) {
    return [
      ["01", "Name the counter-thesis", "Write the assumption that would break the base case."],
      ["02", "Attach a leading signal", "Track queue reform, tariff volatility, insurance capacity, or OEM lock-in."],
      ["03", "Separate delay from death", "A stalled project is different from a structurally bad project."],
      ["04", "Update the memo", "Keep one dated note for what changed and why."],
    ]
  }
  if (lower.includes("software") || lower.includes("derms")) {
    return [
      ["01", "Map the architecture", "Vendor-locked, independent SaaS, and operator-built models have different margins."],
      ["02", "Price the triangle", "OEM, software vendor, and operator incentives need to be visible."],
      ["03", "Protect dispatch data", "The learning loop becomes a competitive asset over time."],
      ["04", "Test a market change", "Ask how fast the stack adapts to a new tariff or ancillary product."],
    ]
  }
  const source = sentences.length ? sentences : fallbackBodies
  return source.slice(0, 4).map((sentence, i) => [
    String(i + 1).padStart(2, "0"),
    fallbackStepTitles[(index + i) % fallbackStepTitles.length],
    shorten(sentence.replace(/\.$/, "."), 118),
  ])
}

function exerciseFor(title, index) {
  const lower = title.toLowerCase()
  if (lower.includes("recommend")) return "Pick one site and write a one-page go/no-go memo using the four steps above."
  if (lower.includes("risk")) return "Write the single assumption that would most quickly change your recommendation."
  if (lower.includes("software") || lower.includes("derms")) return "Compare one vendor-locked and one independent DERMS option on adaptation speed."
  if (lower.includes("cost")) return "Split the project budget into hardware, soft costs, and queue risk before reading the IRR."
  return "Turn this chapter into one decision, one uncertainty, and one follow-up question."
}

function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]))
}

function renderHtml(guide, data) {
  const toc = guide.chapters.map((chapter, index) => `
          <button class="toc-item${index === 0 ? " active" : ""}" type="button" data-chapter="${index}">
            <span class="toc-name">${escapeHtml(chapter.title)}</span>
            <span class="toc-leader"></span>
            <span class="toc-page">${String(chapter.page).padStart(2, "0")}</span>
          </button>`).join("")

  return `<!doctype html>
<html lang="en" data-ha-style="digital-eguide">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(guide.title)}</title>
  <style>
:root {
  --backdrop:#d8c8c0;
  --paper:#faf3ea;
  --paper-2:#f4ecdf;
  --ink:#1f1c14;
  --muted:#837964;
  --rule:#d3c9b3;
  --accent:#c44a47;
  --accent-2:#e07d52;
  --shadow:0 30px 60px rgba(31,28,20,.18),0 4px 8px rgba(31,28,20,.06);
  --serif:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;
  --body:"Georgia","Times New Roman",serif;
  --mono:"SF Mono","IBM Plex Mono","Menlo",ui-monospace,monospace;
  color-scheme: light;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  margin:0;
  min-height:100vh;
  color:var(--ink);
  background:
    radial-gradient(ellipse 80% 60% at 50% 18%, #ead7cf, transparent 70%),
    radial-gradient(ellipse 58% 58% at 82% 92%, #c79a8e, transparent 72%),
    var(--backdrop);
  font:15px/1.55 var(--body);
}
button,input{font:inherit;color:inherit}
button{cursor:pointer}
.eguide-desk{
  width:min(1220px,100%);
  margin:0 auto;
  padding:56px 32px 96px;
}
.spread-pair{
  display:grid;
  grid-template-columns:repeat(2,minmax(360px,540px));
  gap:36px;
  justify-content:center;
  align-items:start;
}
.guide-page{
  min-height:800px;
  background:var(--paper);
  border-radius:4px;
  padding:44px 44px 36px;
  box-shadow:var(--shadow);
  position:relative;
  overflow:hidden;
}
.cover-page{transform:rotate(-.6deg)}
.inside-spread{transform:rotate(.6deg);background:var(--paper-2)}
.eguide-eyebrow{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:18px;
  padding-bottom:22px;
  border-bottom:1px solid var(--rule);
  color:var(--muted);
  font:10.5px/1 var(--mono);
  letter-spacing:.2em;
  text-transform:uppercase;
}
.eguide-eyebrow span{display:inline-flex;align-items:center;gap:10px}
.eguide-eyebrow span::before{
  content:"";
  width:6px;
  height:6px;
  border-radius:50%;
  background:var(--accent);
}
.guide-title{
  margin:34px 0 14px;
  font:700 clamp(58px,7vw,86px)/.96 var(--serif);
  letter-spacing:-.01em;
}
.guide-title em{color:var(--accent);font-style:italic}
.guide-title .thin{font-style:italic;font-weight:500}
.byline{
  margin:16px 0 20px;
  color:var(--muted);
  font:11px/1.35 var(--mono);
  letter-spacing:.15em;
  text-transform:uppercase;
}
.stat-row{
  display:grid;
  grid-template-columns:repeat(3,1fr);
  gap:18px;
  margin:22px 0 28px;
  padding:18px 0;
  border-top:1px solid var(--rule);
  border-bottom:1px solid var(--rule);
}
.stat-value{font:700 36px/1 var(--serif)}
.stat-label{
  max-width:15ch;
  margin-top:7px;
  color:var(--muted);
  font:10px/1.4 var(--mono);
  text-transform:uppercase;
  letter-spacing:.16em;
}
.inside-title{
  margin:12px 0 14px;
  font:italic 700 35px/1 var(--serif);
}
.inside-title em{color:var(--accent)}
.toc{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:14px 26px;
}
.toc-item{
  display:flex;
  align-items:baseline;
  gap:8px;
  width:100%;
  padding:0 0 7px;
  border:0;
  border-bottom:1px solid transparent;
  background:transparent;
  text-align:left;
}
.toc-item:hover,.toc-item.active{border-bottom-color:var(--accent)}
.toc-name{
  max-width:15ch;
  overflow:hidden;
  color:var(--ink);
  font:italic 15px/1.2 var(--body);
  text-overflow:ellipsis;
  white-space:nowrap;
}
.toc-leader{
  flex:1;
  border-bottom:1px dotted var(--muted);
  transform:translateY(-3px);
}
.toc-page{color:var(--muted);font:11px/1 var(--mono)}
.guide-sticker{
  position:absolute;
  right:42px;
  top:286px;
  width:92px;
  height:92px;
  display:grid;
  place-items:center;
  border-radius:50%;
  background:var(--accent-2);
  color:#fff;
  transform:rotate(8deg);
  text-align:center;
  padding:10px;
  font:italic 700 13px/1.1 var(--serif);
}
.guide-sticker::after{
  content:"";
  position:absolute;
  inset:6px;
  border:1px dashed rgba(255,255,255,.55);
  border-radius:inherit;
}
.guide-footer{
  position:absolute;
  left:44px;
  right:44px;
  bottom:28px;
  display:flex;
  justify-content:space-between;
  padding-top:14px;
  border-top:1px solid var(--rule);
  color:var(--muted);
  font:10.5px/1 var(--mono);
  letter-spacing:.16em;
  text-transform:uppercase;
}
.chapter-title{
  margin:30px 0 8px;
  max-width:17ch;
  font:italic 700 39px/1 var(--serif);
  letter-spacing:-.005em;
}
.chapter-title .accent{color:var(--accent)}
.deck{
  max-width:50ch;
  margin:0 0 22px;
  color:var(--muted);
  font:italic 14.5px/1.42 var(--body);
}
.guide-columns{
  display:grid;
  grid-template-columns:minmax(0,1fr) minmax(0,1fr);
  gap:24px;
  padding-top:14px;
  border-top:1px solid var(--rule);
}
.body-copy{margin:0;color:var(--ink);font:13.4px/1.52 var(--body)}
.body-copy::first-letter{
  float:left;
  padding:5px 7px 0 0;
  color:var(--accent);
  font:italic 700 38px/.85 var(--serif);
}
.lesson-steps{
  display:flex;
  flex-direction:column;
  gap:8px;
}
.step{
  display:grid;
  grid-template-columns:32px 1fr;
  gap:10px;
  padding:8px 0;
  border-bottom:1px dashed var(--rule);
}
.step-num{color:var(--accent);font:700 12px/1 var(--mono);letter-spacing:.08em}
.step-title{display:block;margin-bottom:2px;font:italic 700 14px/1.2 var(--body)}
.step-body{font:12.5px/1.36 var(--body)}
.pullquote{
  position:absolute;
  right:-10px;
  top:262px;
  width:222px;
  padding:18px 22px;
  border:1px solid var(--rule);
  border-radius:4px;
  background:var(--paper);
  box-shadow:0 8px 18px rgba(31,28,20,.1);
  transform:rotate(2.4deg);
  font:italic 700 18px/1.18 var(--serif);
}
.pullquote .open{
  display:block;
  height:24px;
  color:var(--accent);
  font-size:56px;
  line-height:.4;
}
.pullquote .by{
  display:block;
  margin-top:14px;
  color:var(--muted);
  font:11px/1 var(--mono);
  letter-spacing:.12em;
  text-transform:uppercase;
}
.exercise-strip{
  display:flex;
  align-items:center;
  gap:14px;
  margin-top:18px;
  padding:14px 16px;
  border:1px solid var(--accent);
  border-radius:4px;
  background:rgba(196,74,71,.055);
}
.exercise-strip .label{
  flex:0 0 auto;
  padding:6px 8px;
  border:1px solid var(--accent);
  color:var(--accent);
  font:10.5px/1 var(--mono);
  letter-spacing:.18em;
  text-transform:uppercase;
}
.exercise-strip .text{font:italic 14px/1.4 var(--body)}
.guide-tools{
  position:fixed;
  left:50%;
  bottom:22px;
  z-index:20;
  display:flex;
  align-items:center;
  gap:8px;
  padding:8px;
  border:1px solid rgba(31,28,20,.12);
  border-radius:999px;
  background:rgba(250,243,234,.86);
  box-shadow:0 14px 30px rgba(31,28,20,.16);
  transform:translateX(-50%);
  backdrop-filter:blur(14px);
}
.tool-button,.search-input{
  min-height:34px;
  border:1px solid rgba(31,28,20,.14);
  border-radius:999px;
  background:rgba(255,255,255,.48);
  color:var(--ink);
  font:11px/1 var(--mono);
  letter-spacing:.08em;
  text-transform:uppercase;
}
.tool-button{padding:0 13px}
.tool-button:hover{border-color:var(--accent);color:var(--accent)}
.search-input{
  width:190px;
  padding:0 14px;
  text-transform:none;
  letter-spacing:0;
}
.source-drawer{
  position:fixed;
  top:24px;
  right:24px;
  z-index:30;
  width:min(380px,calc(100vw - 48px));
  max-height:calc(100vh - 48px);
  overflow:auto;
  padding:22px;
  border:1px solid rgba(31,28,20,.14);
  border-radius:8px;
  background:rgba(250,243,234,.96);
  box-shadow:0 28px 70px rgba(31,28,20,.24);
  transform:translateX(calc(100% + 32px));
  transition:transform .2s ease;
}
.source-drawer.open{transform:translateX(0)}
.drawer-head{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:16px;
  margin-bottom:14px;
  color:var(--muted);
  font:11px/1 var(--mono);
  letter-spacing:.16em;
  text-transform:uppercase;
}
.drawer-close{
  width:30px;
  height:30px;
  border:1px solid var(--rule);
  border-radius:50%;
  background:transparent;
}
.evidence-card{
  padding:12px 0;
  border-top:1px solid var(--rule);
}
.evidence-card strong{
  display:block;
  margin-bottom:5px;
  color:var(--accent);
  font:11px/1 var(--mono);
  letter-spacing:.1em;
}
.evidence-card p{margin:0;color:#40362c;font:13px/1.5 var(--body)}
.copied{
  position:fixed;
  left:50%;
  bottom:78px;
  z-index:40;
  padding:8px 12px;
  border-radius:999px;
  background:var(--ink);
  color:var(--paper);
  font:11px/1 var(--mono);
  letter-spacing:.12em;
  text-transform:uppercase;
  transform:translateX(-50%);
  opacity:0;
  pointer-events:none;
  transition:opacity .16s ease;
}
.copied.show{opacity:1}
@media (max-width:1120px){
  .spread-pair{grid-template-columns:minmax(320px,540px)}
  .cover-page,.inside-spread{transform:none}
  .pullquote{right:18px}
}
@media (max-width:620px){
  .eguide-desk{padding:24px 14px 104px}
  .guide-page{min-height:auto;padding:30px 24px 84px}
  .guide-title{font-size:52px}
  .toc,.guide-columns,.stat-row{grid-template-columns:1fr}
  .guide-sticker,.pullquote{position:relative;inset:auto;width:auto;margin:18px 0 0;transform:none}
  .guide-tools{left:12px;right:12px;bottom:12px;flex-wrap:wrap;justify-content:center;transform:none;border-radius:18px}
  .search-input{width:min(100%,240px)}
}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{scroll-behavior:auto!important;transition:none!important}
}
  </style>
</head>
<body>
  <main class="eguide-desk">
    <div class="spread-pair">
      <article class="guide-page cover-page" data-od-id="cover">
        <div class="eguide-eyebrow"><span>PDF GUIDE FOR OPERATORS</span><b>${escapeHtml(guide.edition)}</b></div>
        <h1 class="guide-title">Mid-Market <em>Battery</em> Storage <span class="thin">guide</span></h1>
        <div class="byline">${escapeHtml(guide.byline)}</div>
        <div class="stat-row">
          ${guide.stats.map(stat => `<div><div class="stat-value">${escapeHtml(stat.value)}</div><div class="stat-label">${escapeHtml(stat.label)}</div></div>`).join("")}
        </div>
        <h2 class="inside-title">What's <em>inside.</em></h2>
        <div class="toc" data-od-id="toc">${toc}</div>
        <div class="guide-sticker">FIELD NOTES EDITION</div>
        <div class="guide-footer"><span>${escapeHtml(guide.shortTitle)}</span><span>01 / ${String(guide.chapters.length + 1).padStart(2, "0")}</span></div>
      </article>

      <article class="guide-page inside-spread" data-od-id="spread">
        <div class="eguide-eyebrow"><span id="chapter-kicker">Opening brief</span><b id="chapter-page">PAGE 02</b></div>
        <h2 class="chapter-title"><span id="chapter-title">Executive Summary</span><br><span class="accent">as a field note.</span></h2>
        <p class="deck" id="chapter-deck"></p>
        <div class="guide-columns">
          <p class="body-copy" id="chapter-body"></p>
          <div class="lesson-steps" id="lesson-steps"></div>
        </div>
        <div class="pullquote" data-od-id="pullquote">
          <span class="open">"</span>
          <span id="pullquote-text">${escapeHtml(guide.quote)}</span>
          <span class="by">${escapeHtml(guide.quoteBy)}</span>
        </div>
        <div class="exercise-strip" data-od-id="exercise">
          <span class="label">Exercise</span>
          <span class="text" id="exercise-text"></span>
        </div>
        <div class="guide-footer"><span id="footer-title">Battery Storage</span><span id="footer-page">02 / ${String(guide.chapters.length + 1).padStart(2, "0")}</span></div>
      </article>
    </div>
  </main>

  <div class="guide-tools" aria-label="Guide tools">
    <button class="tool-button" type="button" id="prev">Prev</button>
    <button class="tool-button" type="button" id="next">Next</button>
    <input class="search-input" id="search" type="search" placeholder="Search source">
    <button class="tool-button" type="button" id="open-drawer">Evidence</button>
    <button class="tool-button" type="button" id="copy-summary">Copy</button>
  </div>

  <aside class="source-drawer" id="drawer" aria-label="Source evidence">
    <div class="drawer-head"><span id="drawer-title">Source evidence</span><button class="drawer-close" type="button" id="close-drawer" aria-label="Close evidence drawer">x</button></div>
    <div id="evidence-list"></div>
  </aside>
  <div class="copied" id="copied">Copied</div>

  <script>const DATA=${jsonForScript(data)};const GUIDE=${jsonForScript(guide)};</script>
  <script>
(() => {
  let active = 0;
  const chapterTitle = document.getElementById("chapter-title");
  const chapterKicker = document.getElementById("chapter-kicker");
  const chapterPage = document.getElementById("chapter-page");
  const chapterDeck = document.getElementById("chapter-deck");
  const chapterBody = document.getElementById("chapter-body");
  const steps = document.getElementById("lesson-steps");
  const exercise = document.getElementById("exercise-text");
  const footerTitle = document.getElementById("footer-title");
  const footerPage = document.getElementById("footer-page");
  const drawer = document.getElementById("drawer");
  const evidenceList = document.getElementById("evidence-list");
  const drawerTitle = document.getElementById("drawer-title");
  const copied = document.getElementById("copied");

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }
  function renderChapter(index) {
    active = (index + GUIDE.chapters.length) % GUIDE.chapters.length;
    const chapter = GUIDE.chapters[active];
    chapterTitle.textContent = chapter.title;
    chapterKicker.textContent = chapter.kicker;
    chapterPage.textContent = "PAGE " + String((chapter.page || active + 2)).padStart(2, "0");
    chapterDeck.textContent = chapter.deck;
    chapterBody.textContent = chapter.body;
    exercise.textContent = chapter.exercise;
    footerTitle.textContent = chapter.title;
    footerPage.textContent = String(active + 2).padStart(2, "0") + " / " + String(GUIDE.chapters.length + 1).padStart(2, "0");
    steps.innerHTML = chapter.steps.map(step => "<div class='step'><span class='step-num'>" + escapeHtml(step[0]) + "</span><span><span class='step-title'>" + escapeHtml(step[1]) + "</span><span class='step-body'>" + escapeHtml(step[2]) + "</span></span></div>").join("");
    document.querySelectorAll(".toc-item").forEach((button, i) => button.classList.toggle("active", i === active));
  }
  function renderEvidence(items, title) {
    drawerTitle.textContent = title || "Source evidence";
    const rows = items.length ? items : GUIDE.evidence.slice(0, 8);
    evidenceList.innerHTML = rows.map(item => "<article class='evidence-card'><strong>" + escapeHtml(item.id || "SRC") + (item.page ? " · PAGE " + escapeHtml(item.page) : "") + "</strong><p>" + escapeHtml(item.body) + "</p></article>").join("");
  }
  function openDrawer(items, title) {
    renderEvidence(items || [], title);
    drawer.classList.add("open");
  }
  function sourceSearch(query) {
    const q = query.trim().toLowerCase();
    if (!q) return GUIDE.evidence.slice(0, 8);
    return GUIDE.evidence.filter(item => item.body.toLowerCase().includes(q)).slice(0, 12);
  }
  document.querySelectorAll(".toc-item").forEach(button => {
    button.addEventListener("click", () => renderChapter(Number(button.dataset.chapter || 0)));
  });
  document.getElementById("prev").addEventListener("click", () => renderChapter(active - 1));
  document.getElementById("next").addEventListener("click", () => renderChapter(active + 1));
  document.getElementById("open-drawer").addEventListener("click", () => openDrawer([], "Source evidence"));
  document.getElementById("close-drawer").addEventListener("click", () => drawer.classList.remove("open"));
  document.getElementById("search").addEventListener("input", event => {
    const q = event.target.value;
    if (!q.trim()) return;
    openDrawer(sourceSearch(q), "Matches for " + q);
  });
  document.getElementById("copy-summary").addEventListener("click", async () => {
    const chapter = GUIDE.chapters[active];
    const text = GUIDE.title + "\\n" + chapter.title + "\\n" + chapter.deck + "\\nSteps: " + chapter.steps.map(step => step[1]).join(", ");
    try { await navigator.clipboard.writeText(text); } catch {}
    copied.classList.add("show");
    setTimeout(() => copied.classList.remove("show"), 900);
  });
  document.addEventListener("keydown", event => {
    if (event.key === "ArrowRight") renderChapter(active + 1);
    if (event.key === "ArrowLeft") renderChapter(active - 1);
    if (event.key === "Escape") drawer.classList.remove("open");
  });
  renderChapter(0);
  renderEvidence([], "Source evidence");
})();
  </script>
</body>
</html>
`
}
