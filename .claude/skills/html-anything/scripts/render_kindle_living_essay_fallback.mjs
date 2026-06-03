#!/usr/bin/env node
/**
 * Offline example renderer for the living-essay / mycelium writing style using
 * the checked-in Kindle highlights fixture.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { pickParser } from "../dist/parse/index.js"

const TEMPLATE = String.raw`<!doctype html>
<html lang="en" data-ha-style="living-essay">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>__TITLE__</title>
<!-- html-anything family sections: Reading rhythm | Bookshelf | Themes you return to | Quote browser | Heuristic | Hour-of-day | Generated locally | kindle-highlights -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
:root {
  --bg-paper: #faf9f7;
  --text-ink: #2b2b2b;
  --text-soft: #42403c;
  --text-meta: #68645d;
  --accent-mycelium: #cfa86e;
  --accent-deep: #8c7040;
  --accent-glow: rgba(207, 168, 110, 0.38);
  --capsule-bg: #f0efe9;
  --capsule-border: #e0ded5;
  --hairline: #eae8e0;
  --paper-panel: rgba(255, 255, 255, 0.46);
  --font-serif: Georgia, "Times New Roman", ui-serif, serif;
  --font-sans: "Plus Jakarta Sans", ui-sans-serif, system-ui, sans-serif;
  --font-headline: "Space Grotesk", ui-sans-serif, system-ui, sans-serif;
  --radius-pill: 999px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  min-height: 100vh;
  overflow-x: hidden;
  background: var(--bg-paper);
  color: var(--text-ink);
  font-family: var(--font-serif);
  line-height: 2.18;
  -webkit-font-smoothing: antialiased;
}
button, input { font: inherit; }
button { color: inherit; }
.mycelium-layer {
  position: fixed;
  inset: 0;
  z-index: 10;
  width: 100vw;
  height: 100vh;
  pointer-events: none;
}
.layout {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 240px 680px 1fr;
  max-width: 1400px;
  margin: 0 auto;
  padding: 120px 0 132px;
}
.question-zone {
  grid-column: 2;
  display: flex;
  justify-content: flex-end;
  padding-right: 48px;
}
.capsule-container {
  position: sticky;
  top: 20vh;
  height: max-content;
}
.question-capsule {
  position: relative;
  z-index: 20;
  display: block;
  min-height: 244px;
  border: 1px solid var(--capsule-border);
  border-radius: var(--radius-pill);
  background: var(--capsule-bg);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.03);
  cursor: pointer;
  padding: 32px 14px;
  writing-mode: vertical-rl;
  text-orientation: mixed;
  color: var(--text-ink);
  font-family: var(--font-serif);
  font-size: 1.08rem;
  line-height: 1.65;
  letter-spacing: 0.15em;
  text-align: center;
  user-select: none;
  transition: transform 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94), box-shadow 0.4s ease, border-color 0.4s ease;
}
.question-capsule:hover {
  transform: translateY(-2px);
  border-color: var(--accent-mycelium);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.06);
}
.question-capsule::before {
  content: "";
  position: absolute;
  inset: -4px;
  border: 1px solid var(--accent-mycelium);
  border-radius: var(--radius-pill);
  opacity: 0.22;
  transform: scale(0.97);
  animation: pulse-border 3.2s infinite;
}
.question-help {
  width: 92px;
  margin: 18px auto 0;
  color: var(--text-meta);
  font-family: var(--font-sans);
  font-size: 0.68rem;
  line-height: 1.5;
  text-align: center;
}
.manuscript {
  grid-column: 3;
  max-width: 680px;
  color: #333;
  font-size: 1.15rem;
}
.meta-data {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  margin-bottom: 4rem;
  border-bottom: 1px solid var(--hairline);
  padding-bottom: 24px;
  color: var(--text-meta);
  font-family: var(--font-sans);
  font-size: 0.82rem;
  line-height: 1.4;
}
h1 {
  margin-bottom: 2rem;
  color: #1a1a1a;
  font-family: var(--font-serif);
  font-size: clamp(3.2rem, 7vw, 4.65rem);
  font-weight: 500;
  line-height: 1.18;
  letter-spacing: -0.02em;
}
.manuscript p {
  margin-bottom: 2.55rem;
  text-align: justify;
}
.lead {
  color: var(--text-soft);
}
.spore {
  position: relative;
  display: inline-block;
  border: 0;
  background: transparent;
  padding: 0 0.03em;
  color: inherit;
  cursor: pointer;
  font-family: inherit;
  line-height: inherit;
  transition: color 0.8s ease, text-shadow 0.8s ease;
}
.spore.connected,
.spore[aria-pressed="true"] {
  color: var(--accent-deep);
  text-shadow: 0 0 1px rgba(207, 168, 110, 0.3);
}
.spore::after {
  content: "";
  position: absolute;
  left: 0;
  bottom: 0.08em;
  width: 100%;
  height: 1px;
  background: var(--accent-mycelium);
  transform: scaleX(0);
  transform-origin: left;
  transition: transform 0.6s ease;
}
.spore.connected::after,
.spore[aria-pressed="true"]::after {
  transform: scaleX(1);
}
.analysis-fields {
  margin-top: 96px;
  padding-top: 36px;
  border-top: 1px solid var(--hairline);
}
.field-section {
  margin-top: 72px;
}
.field-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 24px;
}
.field-head h2 {
  color: #1f1f1d;
  font-family: var(--font-serif);
  font-size: 1.5rem;
  font-weight: 500;
  letter-spacing: -0.01em;
}
.field-note,
.count-note {
  color: var(--text-meta);
  font-family: var(--font-sans);
  font-size: 0.78rem;
  line-height: 1.5;
}
.seed-list,
.book-list,
.quote-list {
  border-top: 1px solid var(--hairline);
}
.seed-row,
.book-row,
.quote-row {
  width: 100%;
  border: 0;
  border-bottom: 1px solid var(--hairline);
  background: transparent;
  padding: 18px 0;
  color: var(--text-ink);
  text-align: left;
}
.seed-row,
.book-row {
  cursor: pointer;
  transition: color 0.3s ease, padding-left 0.3s ease;
}
.seed-row:hover,
.seed-row[aria-pressed="true"],
.book-row:hover,
.book-row[aria-pressed="true"] {
  color: var(--accent-deep);
  padding-left: 12px;
}
.row-top {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  color: inherit;
  font-family: var(--font-sans);
  font-size: 0.86rem;
  line-height: 1.5;
}
.row-top strong {
  font-weight: 500;
}
.row-meta {
  margin-top: 5px;
  color: var(--text-meta);
  font-family: var(--font-sans);
  font-size: 0.76rem;
  line-height: 1.5;
}
.rhythm-panel {
  display: grid;
  grid-template-columns: 1.05fr 0.95fr;
  gap: 32px;
  border-top: 1px solid var(--hairline);
  padding-top: 20px;
}
.year-bars {
  display: grid;
  gap: 10px;
}
.year-row {
  display: grid;
  grid-template-columns: 50px 1fr 44px;
  align-items: center;
  gap: 10px;
  color: var(--text-meta);
  font-family: var(--font-sans);
  font-size: 0.72rem;
  line-height: 1;
}
.year-track {
  height: 7px;
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: #efede6;
}
.year-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--accent-mycelium);
  transform-origin: left;
  animation: grow 0.9s ease both;
}
.hour-strip {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: 5px;
}
.hour-cell {
  position: relative;
  min-height: 46px;
  overflow: hidden;
  border: 1px solid var(--hairline);
  border-radius: 999px;
  color: var(--text-meta);
  font-family: var(--font-sans);
  font-size: 0.63rem;
  text-align: center;
}
.hour-cell::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: var(--h);
  background: var(--accent-mycelium);
  opacity: 0.45;
}
.hour-cell span {
  position: relative;
  z-index: 1;
}
.folio-tools {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;
}
.folio-search {
  flex: 1 1 auto;
  min-height: 42px;
  border: 1px solid var(--capsule-border);
  border-radius: var(--radius-pill);
  background: rgba(255, 255, 255, 0.42);
  color: var(--text-ink);
  padding: 0 16px;
  font-family: var(--font-sans);
  font-size: 0.82rem;
}
.folio-search:focus {
  outline: 2px solid rgba(207, 168, 110, 0.42);
  outline-offset: 2px;
}
.quiet-button {
  min-height: 42px;
  border: 1px solid var(--capsule-border);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-meta);
  cursor: pointer;
  padding: 0 14px;
  font-family: var(--font-sans);
  font-size: 0.78rem;
}
.quote-row {
  display: block;
}
.quote-text {
  color: var(--text-soft);
  font-size: 1rem;
  line-height: 1.86;
}
.quote-row.active .quote-text {
  color: var(--accent-deep);
}
.quote-meta {
  margin-top: 10px;
  color: var(--text-meta);
  font-family: var(--font-sans);
  font-size: 0.72rem;
  line-height: 1.55;
}
.footer-note {
  margin-top: 96px;
  border-top: 1px solid var(--hairline);
  padding-top: 26px;
  color: var(--text-meta);
  font-family: var(--font-sans);
  font-size: 0.78rem;
  line-height: 1.75;
}
.fade-in {
  opacity: 0;
  animation: fade-in 1.2s ease forwards;
}
.mycelium-path {
  fill: none;
  stroke: var(--accent-mycelium);
  stroke-width: 1.45;
  stroke-opacity: 0.58;
  filter: url(#glow);
}
@keyframes pulse-border {
  0% { opacity: 0.12; transform: scale(1); }
  50% { opacity: 0.38; transform: scale(1.05); }
  100% { opacity: 0.12; transform: scale(1); }
}
@keyframes fade-in { to { opacity: 1; } }
@keyframes grow { from { transform: scaleX(0); } }
@media (max-width: 1024px) {
  .layout {
    grid-template-columns: 1fr 68px minmax(0, 1fr) 28px;
    padding-top: 64px;
  }
  .question-zone {
    padding-right: 10px;
  }
  .manuscript {
    max-width: min(680px, calc(100vw - 118px));
  }
  h1 {
    font-size: clamp(2.6rem, 11vw, 3.3rem);
  }
  .rhythm-panel {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 640px) {
  .layout {
    display: block;
    width: min(100% - 30px, 680px);
    padding: 34px 0 76px;
  }
  .question-zone {
    display: block;
    padding-right: 0;
  }
  .capsule-container {
    position: sticky;
    top: 0;
    z-index: 30;
    padding: 8px 0 14px;
    background: linear-gradient(var(--bg-paper) 70%, rgba(250, 249, 247, 0));
  }
  .question-capsule {
    min-height: 0;
    width: 100%;
    writing-mode: horizontal-tb;
    padding: 13px 18px;
    font-family: var(--font-sans);
    letter-spacing: 0.02em;
  }
  .question-capsule::before,
  .question-help {
    display: none;
  }
  .manuscript {
    max-width: none;
  }
  .meta-data {
    margin-top: 32px;
  }
  .field-head {
    display: block;
  }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    scroll-behavior: auto !important;
  }
}
</style>
</head>
<body>
<svg class="mycelium-layer" id="mycelium-canvas" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="hyphae-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:var(--accent-mycelium);stop-opacity:0.8"></stop>
      <stop offset="100%" style="stop-color:var(--accent-mycelium);stop-opacity:0"></stop>
    </linearGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="2" result="coloredBlur"></feGaussianBlur>
      <feMerge>
        <feMergeNode in="coloredBlur"></feMergeNode>
        <feMergeNode in="SourceGraphic"></feMergeNode>
      </feMerge>
    </filter>
  </defs>
</svg>

<div class="layout">
  <aside class="question-zone fade-in" style="animation-delay:0.2s">
    <div class="capsule-container">
      <button class="question-capsule active" id="source-capsule" type="button">What is this archive trying to remember?</button>
      <div class="question-help">click to shift the question</div>
    </div>
  </aside>

  <article class="manuscript fade-in" style="animation-delay:0.4s">
    <div class="meta-data">
      <span>kindle-highlights</span>
      <span id="meta-period">reading window</span>
      <span id="meta-count">0 clippings</span>
    </div>

    <h1>Reading as a living field</h1>
    <div id="essay-body"></div>

    <div class="analysis-fields">
      <section class="field-section reading-rhythm" id="reading-rhythm" aria-labelledby="rhythm-title">
        <div class="field-head">
          <h2 id="rhythm-title">Reading rhythm</h2>
          <span class="field-note">Yearly volume and Hour-of-day traces</span>
        </div>
        <div class="rhythm-panel">
          <div class="year-bars" id="year-bars"></div>
          <div class="hour-strip" id="hour-strip"></div>
        </div>
      </section>

      <section class="field-section" aria-labelledby="themes-title">
        <div class="field-head">
          <h2 id="themes-title">Themes you return to</h2>
          <span class="field-note">Heuristic keyword spores</span>
        </div>
        <div class="seed-list" id="seed-list"></div>
      </section>

      <section class="field-section" aria-labelledby="books-title">
        <div class="field-head">
          <h2 id="books-title">Bookshelf</h2>
          <span class="field-note">The books with the densest residue</span>
        </div>
        <div class="book-list" id="book-list"></div>
      </section>

      <section class="field-section evidence-folio" aria-labelledby="quote-title">
        <div class="field-head">
          <h2 id="quote-title">Quote browser</h2>
          <span class="count-note" id="folio-count">0 passages</span>
        </div>
        <div class="folio-tools">
          <input class="folio-search" id="folio-search" type="search" placeholder="Search passages, books, authors..." aria-label="Search quote browser">
          <button class="quiet-button" id="copy-note" type="button">Copy note</button>
        </div>
        <div class="quote-list" id="quote-list"></div>
      </section>
    </div>

    <footer class="footer-note">
      <strong>Generated locally</strong> by html-anything from <span id="source-file">input.txt</span>. This page uses the <code>living-essay</code> style. Theme links are a heuristic roll-up from the parser, not semantic truth.
    </footer>
  </article>
</div>

<script>const DATA = __DATA__;</script>
<script>
(() => {
  const rows = (DATA.rows || []).filter(function(row) { return !row.duplicateOf; });
  const quotes = rows.filter(function(row) { return row.text && row.text.trim(); });
  const books = DATA.books || [];
  const themes = (DATA.themeClusters || []).slice(0, 7);
  const yearTotals = DATA.yearTotals || [];
  const hourCounts = DATA.hourCounts || Array.from({ length: 24 }, function() { return 0; });
  const summary = DATA.summary || {};
  const meta = DATA.meta || {};
  const fmt = new Intl.NumberFormat("en-US");
  let activeTheme = themes[0] ? themes[0].key : "";
  let activeBook = "";
  let query = "";
  let activePaths = [];
  let questionIndex = 0;

  const conceptNames = {
    every: "everydayness",
    small: "small rituals",
    weather: "weather",
    other: "otherness",
    different: "difference",
    forest: "forest thinking"
  };
  const questions = [
    "What is this archive trying to remember?",
    "Where does the same thought return?",
    "Which passage keeps sending roots outward?",
    "What changes when the shelf is read as soil?"
  ];

  function $(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"]/g, function(c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function conceptLabel(theme) {
    if (!theme) return "reading";
    return conceptNames[theme.key] || theme.keyword || theme.key;
  }
  function conceptWords(theme) {
    if (!theme) return [];
    const raw = String(theme.key || "") + " " + String(theme.keyword || "");
    const words = raw.toLowerCase().match(/[a-z][a-z'-]{3,}/g) || [];
    return Array.from(new Set(words.map(function(word) {
      return word.replace(/(?:'s|ing|ed|es|s)$/, "");
    })));
  }
  function rowMatchesTheme(row, key) {
    const theme = themes.find(function(item) { return item.key === key; });
    if (!theme) return false;
    if ((theme.sampleClippingIds || []).includes(row.id)) return true;
    const text = (String(row.text || "") + " " + String(row.title || "")).toLowerCase();
    return conceptWords(theme).some(function(word) { return text.includes(word); });
  }
  function currentTheme() {
    return themes.find(function(item) { return item.key === activeTheme; }) || themes[0];
  }
  function topBook() {
    return books.slice().sort(function(a, b) {
      return (b.highlightCount + b.noteCount + b.bookmarkCount) - (a.highlightCount + a.noteCount + a.bookmarkCount);
    })[0];
  }
  function filteredQuotes() {
    const q = query.trim().toLowerCase();
    return quotes.filter(function(row) {
      if (activeTheme && !rowMatchesTheme(row, activeTheme)) return false;
      if (activeBook && row.bookId !== activeBook) return false;
      if (!q) return true;
      return (String(row.text || "") + " " + String(row.title || "") + " " + String(row.author || "")).toLowerCase().includes(q);
    });
  }
  function spore(label, key, type) {
    const attr = type === "book" ? "data-book" : "data-theme";
    const pressed = type === "book" ? key === activeBook : key === activeTheme;
    return '<button class="spore" type="button" ' + attr + '="' + esc(key) + '" aria-pressed="' + pressed + '">' + esc(label) + '</button>';
  }

  function renderEssay() {
    const theme = currentTheme();
    const top = topBook();
    const period = summary.period || meta.period || "reading window";
    $("meta-period").textContent = period;
    $("meta-count").textContent = fmt.format(summary.rowCount || rows.length) + " clippings";
    $("source-file").textContent = meta.sourceFile || "input.txt";

    const active = conceptLabel(theme);
    const bookTitle = top ? top.title : "the most marked book";
    const bookId = top ? top.id : "";
    const bookCount = summary.bookCount || books.length;
    const clippingCount = summary.rowCount || rows.length;
    const highlightCount = summary.highlightCount || rows.filter(function(row) { return row.kind === "highlight"; }).length;
    const activeMonths = summary.activeMonths || "many";

    $("essay-body").innerHTML = [
      '<p class="lead">This Kindle export is not arranged like a report. It behaves more like a patch of soil: ' + spore(fmt.format(clippingCount) + " clippings", activeTheme, "theme") + ' from ' + spore(fmt.format(bookCount) + " books", bookId, "book") + ' keep breaking down into smaller traces, then sending threads back toward the same few questions.</p>',
      '<p>The strongest visible spore is ' + spore(active, activeTheme, "theme") + '. It appears across distant books as if the shelf were quietly reusing one vocabulary. A highlight is not a conclusion here; it is a place where attention paused long enough to leave residue.</p>',
      '<p>The densest shelf signal comes from ' + spore(bookTitle, bookId, "book") + '. That does not mean it is the most important book. It only means the reader returned to it with a different pressure: more underlines, more notes, more little attempts to keep a sentence alive.</p>',
      '<p>Across ' + esc(String(activeMonths)) + ' active months, the archive keeps mixing ' + spore("reading rhythm", activeTheme, "theme") + ' with daily interruption. Some clippings look like deliberate study. Others feel more accidental, like a phrase caught between errands, weather, and sleep.</p>',
      '<p>The lower sections preserve the ordinary instruments: ' + spore("Reading rhythm", activeTheme, "theme") + ', ' + spore("Bookshelf", bookId, "book") + ', ' + spore("Themes you return to", activeTheme, "theme") + ', and the full ' + spore("Quote browser", activeTheme, "theme") + '. But the page begins with the living relation between a question and the words it keeps touching.</p>',
      '<p>Read this as a heuristic field. The page is allowed to be suggestive, but not mystical: ' + esc(fmt.format(highlightCount)) + ' highlights, source titles, timestamps, and short passages remain available below for checking where each thread actually lands.</p>'
    ].join("");

    document.querySelectorAll(".spore[data-theme]").forEach(function(el) {
      el.addEventListener("click", function() { selectTheme(el.dataset.theme); });
    });
    document.querySelectorAll(".spore[data-book]").forEach(function(el) {
      el.addEventListener("click", function() { selectBook(el.dataset.book); });
    });
  }

  function renderRhythm() {
    const max = Math.max.apply(null, [1].concat(yearTotals.map(function(y) {
      return (y.highlights || 0) + (y.notes || 0) + (y.bookmarks || 0);
    })));
    $("year-bars").innerHTML = yearTotals.map(function(y) {
      const total = (y.highlights || 0) + (y.notes || 0) + (y.bookmarks || 0);
      const width = Math.max(4, total / max * 100).toFixed(1);
      return '<div class="year-row"><span>' + esc(y.year) + '</span><div class="year-track"><div class="year-fill" style="width:' + width + '%"></div></div><span>' + fmt.format(total) + '</span></div>';
    }).join("") || '<p class="field-note">No dated highlights.</p>';

    const hourMax = Math.max.apply(null, [1].concat(hourCounts));
    $("hour-strip").innerHTML = hourCounts.map(function(count, hour) {
      const h = Math.max(4, count / hourMax * 100).toFixed(1);
      return '<div class="hour-cell" title="' + hour + ':00 - ' + count + ' clippings" style="--h:' + h + '%"><span>' + hour + '</span></div>';
    }).join("");
  }

  function renderThemes() {
    $("seed-list").innerHTML = themes.map(function(theme) {
      const label = conceptLabel(theme);
      const pressed = theme.key === activeTheme;
      return '<button class="seed-row" type="button" data-key="' + esc(theme.key) + '" aria-pressed="' + pressed + '"><span class="row-top"><strong>' + esc(label) + '</strong><span>' + fmt.format(theme.count || 0) + ' passages</span></span><span class="row-meta">Heuristic keyword: ' + esc(theme.keyword || theme.key) + ' / ' + fmt.format((theme.bookIds || []).length) + ' books</span></button>';
    }).join("");
    document.querySelectorAll(".seed-row").forEach(function(row) {
      row.addEventListener("click", function() { selectTheme(row.dataset.key); });
    });
  }

  function renderBooks() {
    const topBooks = books.slice().sort(function(a, b) {
      return (b.highlightCount + b.noteCount + b.bookmarkCount) - (a.highlightCount + a.noteCount + a.bookmarkCount);
    }).slice(0, 9);
    $("book-list").innerHTML = topBooks.map(function(book) {
      const total = book.highlightCount + book.noteCount + book.bookmarkCount;
      return '<button class="book-row" type="button" data-book-id="' + esc(book.id) + '" aria-pressed="' + (book.id === activeBook) + '"><span class="row-top"><strong>' + esc(book.title) + '</strong><span>' + fmt.format(total) + '</span></span><span class="row-meta">' + esc(book.author || "Unknown author") + ' / ' + book.highlightCount + ' H / ' + book.noteCount + ' N / ' + book.bookmarkCount + ' B</span></button>';
    }).join("");
    document.querySelectorAll(".book-row").forEach(function(row) {
      row.addEventListener("click", function() { selectBook(row.dataset.bookId); });
    });
  }

  function renderQuotes() {
    const list = filteredQuotes();
    $("folio-count").textContent = fmt.format(list.length) + " passages";
    $("quote-list").innerHTML = list.slice(0, 24).map(function(row) {
      const active = activeTheme && rowMatchesTheme(row, activeTheme);
      const place = row.page ? "page " + row.page : row.locationStart ? "loc " + row.locationStart : "kindle clipping";
      return '<article class="quote-row ' + (active ? "active" : "") + '" data-id="' + esc(row.id) + '"><div class="quote-text">' + esc(row.text) + '</div><div class="quote-meta">' + esc(row.title) + ' / ' + esc(row.author || "Unknown") + ' / ' + esc(row.date || "") + ' / ' + esc(place) + ' / ' + esc(row.kind) + '</div></article>';
    }).join("") || '<article class="quote-row"><div class="quote-text">No passages match this focus.</div></article>';
  }

  function updateQuestion() {
    const theme = currentTheme();
    const base = questions[questionIndex % questions.length];
    $("source-capsule").textContent = theme ? base.replace("this archive", conceptLabel(theme)) : base;
  }
  function selectTheme(key) {
    activeTheme = key || activeTheme;
    activeBook = "";
    renderAll();
  }
  function selectBook(id) {
    activeBook = id || "";
    renderEssay();
    renderBooks();
    renderQuotes();
  }
  function renderAll() {
    renderEssay();
    renderRhythm();
    renderThemes();
    renderBooks();
    renderQuotes();
    updateQuestion();
  }

  function getCoords(elem) {
    const rect = elem.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      right: rect.right,
      left: rect.left
    };
  }
  function createPath(target) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "mycelium-path");
    $("mycelium-canvas").appendChild(path);
    target.classList.add("connected");
    return { element: path, target: target, progress: 0, phase: "growing", life: 80 + Math.random() * 210 };
  }
  function updatePaths() {
    const source = $("source-capsule");
    if (!source) return;
    const src = getCoords(source);
    const startX = src.right;
    const startY = src.y;

    activePaths.forEach(function(obj, index) {
      if (!document.body.contains(obj.target)) {
        activePaths.splice(index, 1);
        return;
      }
      const target = getCoords(obj.target);
      const endX = target.left;
      const endY = target.y + 4;
      const cp1x = startX + 80 + Math.sin(Date.now() / 1000 + index) * 20;
      const cp1y = startY;
      const cp2x = endX - 80 + Math.cos(Date.now() / 800 + index) * 20;
      const cp2y = endY;
      const d = "M " + startX + " " + startY + " C " + cp1x + " " + cp1y + ", " + cp2x + " " + cp2y + ", " + endX + " " + endY;
      obj.element.setAttribute("d", d);
      const length = obj.element.getTotalLength();
      obj.element.style.strokeDasharray = length;
      if (obj.phase === "growing") {
        obj.progress += 0.025;
        if (obj.progress >= 1) {
          obj.progress = 1;
          obj.phase = "sustained";
        }
        obj.element.style.strokeDashoffset = length * (1 - obj.progress);
      } else if (obj.phase === "sustained") {
        obj.element.style.strokeDashoffset = 0;
        obj.life -= 1;
        if (obj.life <= 0) obj.phase = "dying";
      } else {
        obj.progress -= 0.025;
        obj.element.style.strokeDashoffset = length * (1 - obj.progress);
        if (obj.progress <= 0) {
          obj.element.remove();
          obj.target.classList.remove("connected");
          activePaths.splice(index, 1);
        }
      }
    });
  }
  function visibleSporeTargets() {
    return Array.from(document.querySelectorAll(".spore")).filter(function(sporeEl) {
      if (sporeEl.classList.contains("connected")) return false;
      if (activeTheme && sporeEl.dataset.theme && sporeEl.dataset.theme !== activeTheme) return false;
      const rect = sporeEl.getBoundingClientRect();
      return rect.top > 0 && rect.bottom < window.innerHeight;
    });
  }
  function manageMycelium() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (activePaths.length < 4 && Math.random() > 0.952) {
      const targets = visibleSporeTargets();
      if (targets.length) {
        activePaths.push(createPath(targets[Math.floor(Math.random() * targets.length)]));
      }
    }
    updatePaths();
    requestAnimationFrame(manageMycelium);
  }

  $("source-capsule").addEventListener("click", function() {
    questionIndex += 1;
    updateQuestion();
  });
  $("folio-search").addEventListener("input", function(event) {
    query = event.target.value || "";
    renderQuotes();
  });
  $("copy-note").addEventListener("click", function() {
    const theme = currentTheme();
    const note = [
      "# " + document.title,
      "",
      "Active question: " + $("source-capsule").textContent,
      "Active spore: " + conceptLabel(theme),
      "",
      "## Sample passages",
      filteredQuotes().slice(0, 5).map(function(row) { return '- "' + row.text + '" - ' + row.title; }).join("\n")
    ].join("\n");
    if (navigator.clipboard) {
      navigator.clipboard.writeText(note).catch(function() { window.prompt("Copy this:", note); });
    } else {
      window.prompt("Copy this:", note);
    }
  });
  window.addEventListener("resize", function() {
    activePaths.forEach(function(obj) {
      obj.element.remove();
      obj.target.classList.remove("connected");
    });
    activePaths = [];
  });

  renderAll();
  requestAnimationFrame(manageMycelium);
})();
</script>
</body>
</html>`;

async function main() {
  const args = process.argv.slice(2)
  if (!args.length) {
    console.error("Usage: node scripts/render_kindle_living_essay_fallback.mjs INPUT --out OUT --title TITLE")
    process.exit(1)
  }
  const input = args[0]
  const out = arg(args, "--out") || input.replace(/\.[^.]+$/, ".html")
  const title = arg(args, "--title") || path.basename(input).replace(/\.[^.]+$/, "")

  const parser = await pickParser(input)
  if (!parser) {
    console.error("No parser matched " + input)
    process.exit(2)
  }
  const parsed = await parser.parse(input)
  if (parsed.contentType !== "kindle-highlights") {
    console.error("Expected kindle-highlights, got " + parsed.contentType)
    process.exit(3)
  }
  const html = TEMPLATE
    .replace(/__TITLE__/g, escapeHtml(title))
    .replace("__DATA__", inlineJson(parsed.data))
  await fs.writeFile(out, html, "utf8")
  console.log("Wrote " + out + " (" + (html.length / 1024).toFixed(1) + " KB)")
}

function arg(args, name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : null
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
}

function inlineJson(value) {
  return JSON.stringify(value).replace(/<\/(script)/gi, "<\\/$1")
}

await main()
