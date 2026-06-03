/**
 * Offline fallback renderer for the research / reading-list family
 * (bookmarks-html, bibliography, url-list, reading-list). The canonical
 * pipeline is `dist/cli.js → htmlize → LLM`, but example regeneration
 * may run on machines without an Anthropic / OpenAI key. This script
 * reuses the same parser, then applies a hand-tuned shared template
 * that satisfies the _research.md contract:
 *
 *   1. Topic clusters / theme map
 *   2. Domain (or venue) leaderboard
 *   3. Stale / duplicate / dead-link callouts
 *   4. Reading queue / year histogram
 *   5. Searchable card drill-down
 *
 * The template emits __DATA__ and is injected with the same JSON
 * substitution as htmlize.ts, so the output renders the full inlined
 * data identically to an LLM-designed page. Outputs respect the hard
 * offline-only rule — no URL fetching at render or click time, no
 * favicon-service calls, no link previews.
 *
 * Usage:
 *   node scripts/render_research_fallback.mjs INPUT --out OUT --title TITLE [--editorial "..."]
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { pickParser } from "../dist/parse/index.js"

const TEMPLATE = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>__TITLE__</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
:root {
  --primary:#a03b00; --primary-container:#c94c00; --primary-fixed:#ffdbcd;
  --primary-fixed-dim:#ffb597; --on-primary:#fff; --accent-glow:#E8400D;
  --secondary:#d5baff; --secondary-container:#7b40e0; --tertiary:#4d44e3; --accent-cyan:#00D4FF;
  --bg:#fff8f6; --surface:#fff8f6; --surface-container-lowest:#fff;
  --surface-container-low:#fbf2ef; --surface-container:#f5ece9; --surface-container-high:#efe6e3;
  --fg-1:#1e1b19; --fg-2:#594138; --fg-muted:#8d7166;
  --border:rgba(0,0,0,.06); --border-strong:rgba(0,0,0,.12); --outline-variant:#e1bfb2;
  --green:#10b981; --blue:#3b82f6; --yellow:#f59e0b; --red:#ef4444;
  --font-headline:'Space Grotesk',ui-sans-serif,system-ui,sans-serif;
  --font-body:'Plus Jakarta Sans',ui-sans-serif,system-ui,sans-serif;
  --font-mono:'SF Mono','Menlo',ui-monospace,monospace;
  --space-xs:4px; --space-sm:8px; --space-md:12px; --space-lg:16px;
  --space-xl:20px; --space-2xl:24px; --space-3xl:32px; --space-4xl:48px; --space-5xl:64px;
  --radius-sm:8px; --radius-md:12px; --radius-lg:16px; --radius-xl:20px; --radius-2xl:28px; --radius-pill:9999px;
  --shadow-sm:0 1px 2px rgba(30,27,25,.04); --shadow-md:0 4px 12px rgba(30,27,25,.08);
  --shadow-lg:0 8px 24px rgba(30,27,25,.12); --shadow-accent:0 8px 24px rgba(160,59,0,.15);
  --gradient-primary:linear-gradient(135deg,#a03b00 0%,#c94c00 100%);
  --gradient-hero:linear-gradient(135deg,#a03b00 0%,#7b40e0 100%);
  --gradient-text:linear-gradient(135deg,#a03b00 0%,#7b40e0 100%);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg:#060B18; --surface:#0B1426; --surface-container-lowest:#101D35;
    --surface-container-low:#101D35; --surface-container:#162544; --surface-container-high:#1c2d52;
    --fg-1:#F8FAFC; --fg-2:#CBD5E1; --fg-muted:#64748B;
    --border:rgba(255,255,255,.08); --border-strong:rgba(255,255,255,.14);
    --primary:#FF6B35; --accent-glow:#00D4FF;
    --shadow-md:0 4px 12px rgba(0,0,0,.4); --shadow-lg:0 8px 24px rgba(0,0,0,.5);
  }
}
*,*::before,*::after{box-sizing:border-box;margin:0}
html,body{background:var(--bg);color:var(--fg-1);font-family:var(--font-body);
  font-size:15.5px;line-height:1.55;-webkit-font-smoothing:antialiased}
body{min-height:100vh}
main{max-width:1240px;margin:0 auto;padding:var(--space-2xl) var(--space-xl) var(--space-5xl)}
h1,h2,h3,h4{font-family:var(--font-headline);letter-spacing:-.01em;font-weight:600;color:var(--fg-1)}
h1{font-size:clamp(28px,5vw,44px);font-weight:700;line-height:1.05;letter-spacing:-.02em}
h2{font-size:clamp(20px,2.4vw,24px);margin-bottom:var(--space-md)}
h3{font-size:17px;margin-bottom:var(--space-sm)}
.muted{color:var(--fg-muted)}
.mono{font-family:var(--font-mono);font-variant-numeric:tabular-nums}
button{font:inherit;cursor:pointer;border:none;background:transparent;color:inherit}
input,select{font:inherit;color:var(--fg-1)}
a{color:var(--primary);text-decoration:none}
a:hover{text-decoration:underline}
.hero{padding:var(--space-3xl) 0 var(--space-2xl);border-bottom:1px solid var(--border)}
.hero .eyebrow{display:inline-flex;gap:var(--space-sm);align-items:center;
  background:var(--surface-container);color:var(--primary);
  padding:var(--space-xs) var(--space-md);border-radius:var(--radius-pill);
  font-family:var(--font-mono);font-size:11.5px;font-weight:500;
  text-transform:uppercase;letter-spacing:.08em;margin-bottom:var(--space-lg)}
.hero h1{background:var(--gradient-text);-webkit-background-clip:text;background-clip:text;color:transparent;max-width:22ch}
.hero .editorial{margin-top:var(--space-lg);max-width:62ch;color:var(--fg-2);font-size:17px;line-height:1.55}
.hero-actions{display:flex;gap:var(--space-md);margin-top:var(--space-xl);flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;gap:var(--space-sm);padding:var(--space-sm) var(--space-lg);
  border-radius:var(--radius-pill);font-weight:600;font-size:14px;border:1px solid var(--border-strong);
  background:var(--surface-container-lowest);color:var(--fg-1);transition:all .15s ease;cursor:pointer}
.btn:hover{background:var(--surface-container);box-shadow:var(--shadow-sm)}
.btn.primary{background:var(--gradient-primary);color:var(--on-primary);border-color:transparent}
.btn.primary:hover{box-shadow:var(--shadow-accent)}
.kpi-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:var(--space-lg);margin-top:var(--space-3xl)}
.kpi{background:var(--surface-container-lowest);border:1px solid var(--border);border-radius:var(--radius-lg);
  padding:var(--space-lg) var(--space-xl);box-shadow:var(--shadow-sm)}
.kpi .label{font-size:11.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--fg-muted);font-weight:500}
.kpi .value{font-family:var(--font-headline);font-size:28px;font-weight:600;margin-top:var(--space-xs);color:var(--fg-1)}
.kpi .value.accent{color:var(--primary)}
.kpi .sub{font-size:12.5px;color:var(--fg-muted);margin-top:2px;font-family:var(--font-mono)}
.section{margin-top:var(--space-4xl)}
.section-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:var(--space-lg);gap:var(--space-md);flex-wrap:wrap}
.section-head .meta{font-size:13px;color:var(--fg-muted);font-family:var(--font-mono)}
.card{background:var(--surface-container-lowest);border:1px solid var(--border);border-radius:var(--radius-lg);
  padding:var(--space-xl);box-shadow:var(--shadow-sm)}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:var(--space-xl)}
.grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--space-xl)}
@media (max-width:980px){.grid-3{grid-template-columns:1fr 1fr}}
@media (max-width:780px){.grid-2{grid-template-columns:1fr}.grid-3{grid-template-columns:1fr}}
/* Cluster grid */
.cluster-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:var(--space-md)}
.cluster{padding:var(--space-md) var(--space-lg);border:1px solid var(--border);border-radius:var(--radius-md);
  background:var(--surface-container-lowest);cursor:pointer;transition:all .15s ease;display:flex;align-items:baseline;justify-content:space-between;gap:var(--space-sm)}
.cluster:hover{border-color:var(--border-strong);box-shadow:var(--shadow-sm)}
.cluster.active{border-color:var(--primary);box-shadow:var(--shadow-accent)}
.cluster .name{font-weight:600;font-size:14px;color:var(--fg-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cluster .count{font-family:var(--font-mono);font-size:12px;color:var(--fg-muted)}
/* Stacked bar (topic share) */
.stack-bar{display:flex;height:14px;border-radius:var(--radius-pill);overflow:hidden;margin-top:var(--space-md);background:var(--surface-container)}
.stack-bar i{display:block;height:100%}
.stack-legend{display:flex;flex-wrap:wrap;gap:var(--space-md);margin-top:var(--space-sm);font-size:12.5px;color:var(--fg-muted);font-family:var(--font-mono)}
.stack-legend span{display:inline-flex;align-items:center;gap:6px}
.stack-legend i{width:10px;height:10px;border-radius:2px;display:inline-block}
/* Leaderboard */
.leader{display:flex;flex-direction:column;gap:0}
.leader-row{display:grid;grid-template-columns:1fr auto auto;gap:var(--space-md);align-items:center;
  padding:var(--space-sm) 0;border-bottom:1px solid var(--border);cursor:pointer}
.leader-row:hover{background:var(--surface-container-low)}
.leader-row:last-child{border-bottom:none}
.leader-row .lbl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px;font-family:var(--font-mono)}
.leader-row .lbl .sub{display:block;font-family:var(--font-body);color:var(--fg-muted);font-size:12px;font-weight:400;margin-top:2px;white-space:normal}
.leader-row .cnt{font-family:var(--font-mono);font-size:13px;color:var(--fg-1);font-weight:500;text-align:right}
.leader-row .bar{width:64px;height:6px;background:var(--surface-container);border-radius:var(--radius-pill);overflow:hidden}
.leader-row .bar i{display:block;height:100%;background:var(--gradient-primary);border-radius:var(--radius-pill)}
/* Callouts */
.callouts{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--space-xl)}
@media (max-width:980px){.callouts{grid-template-columns:1fr}}
.callout{background:var(--surface-container-lowest);border:1px solid var(--border);border-left:3px solid var(--primary);
  border-radius:var(--radius-md);padding:var(--space-lg)}
.callout.dup{border-left-color:var(--secondary-container)}
.callout.stale{border-left-color:var(--yellow)}
.callout.dead{border-left-color:var(--red)}
.callout .label{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--fg-muted);
  font-family:var(--font-mono);font-weight:500;margin-bottom:var(--space-xs)}
.callout h3{font-size:18px;margin:0 0 var(--space-xs)}
.callout .sub{font-size:13px;color:var(--fg-muted);margin-bottom:var(--space-md)}
.callout .row{display:block;padding:var(--space-sm) 0;border-bottom:1px solid var(--border);font-size:13px;line-height:1.4;cursor:pointer}
.callout .row:last-child{border-bottom:none}
.callout .row:hover{color:var(--primary)}
.callout .row .meta{display:block;font-family:var(--font-mono);font-size:11px;color:var(--fg-muted);margin-top:2px}
.callout .empty{font-size:13px;color:var(--fg-muted);font-style:italic;padding:var(--space-md) 0}
.callout .hint{font-size:11.5px;color:var(--fg-muted);margin-top:var(--space-md);font-style:italic;line-height:1.4}
/* Sparkline + queue */
.spark-card{padding:var(--space-2xl)}
.spark-svg{width:100%;height:130px;display:block;margin-top:var(--space-md)}
.spark-svg .bar{fill:var(--secondary-container);opacity:.6}
.spark-svg .bar:hover{opacity:.9}
.spark-svg text{font-family:var(--font-mono);font-size:11px;fill:var(--fg-muted)}
.spark-axis{font-family:var(--font-mono);font-size:11px;color:var(--fg-muted);display:flex;justify-content:space-between;margin-top:var(--space-xs)}
.queue-list{display:flex;flex-direction:column;gap:var(--space-sm);margin-top:var(--space-md)}
.queue-item{display:flex;justify-content:space-between;gap:var(--space-md);padding:var(--space-sm) 0;border-bottom:1px solid var(--border);align-items:baseline}
.queue-item:last-child{border-bottom:none}
.queue-item .t{font-size:13.5px;color:var(--fg-1);overflow:hidden;text-overflow:ellipsis;flex:1 1 auto;cursor:pointer}
.queue-item .t:hover{color:var(--primary)}
.queue-item .when{font-family:var(--font-mono);font-size:11.5px;color:var(--fg-muted);white-space:nowrap;flex:0 0 auto}
/* Drill-down */
.drill-toolbar{display:flex;gap:var(--space-md);margin-bottom:var(--space-md);flex-wrap:wrap;align-items:center}
.drill-search{flex:1 1 280px;min-width:220px;padding:var(--space-sm) var(--space-md);border:1px solid var(--border-strong);
  border-radius:var(--radius-md);background:var(--surface-container-lowest);font-size:14px;font-family:var(--font-mono)}
.drill-search:focus{outline:2px solid var(--primary);outline-offset:1px;border-color:var(--primary)}
.drill-meta{font-size:12.5px;color:var(--fg-muted);font-family:var(--font-mono)}
.chips{display:flex;gap:var(--space-sm);flex-wrap:wrap;margin-bottom:var(--space-md)}
.chip{display:inline-flex;align-items:center;gap:var(--space-sm);padding:6px var(--space-md);
  border-radius:var(--radius-pill);background:var(--surface-container);border:1px solid var(--border);
  font-size:12.5px;font-weight:500;cursor:pointer;transition:all .15s ease;user-select:none}
.chip:hover{background:var(--surface-container-high)}
.chip.active{background:var(--primary);color:var(--on-primary);border-color:transparent}
.chip .count{font-family:var(--font-mono);font-size:11.5px;color:var(--fg-muted);font-weight:400}
.chip.active .count{color:rgba(255,255,255,.8)}
.chip-row-label{font-size:11.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--fg-muted);
  font-family:var(--font-mono);font-weight:500;margin-bottom:var(--space-xs);margin-top:var(--space-md)}
details.drill{margin-top:var(--space-md);border:1px solid var(--border);border-radius:var(--radius-lg);
  background:var(--surface-container-lowest);overflow:hidden}
details.drill > summary{cursor:pointer;padding:var(--space-lg) var(--space-xl);font-weight:600;
  font-family:var(--font-headline);font-size:17px;list-style:none;display:flex;align-items:center;justify-content:space-between}
details.drill > summary::-webkit-details-marker{display:none}
details.drill > summary::after{content:"⌄";color:var(--fg-muted);transition:transform .2s ease;font-size:20px}
details.drill[open] > summary::after{transform:rotate(180deg)}
details.drill .drill-body{padding:0 var(--space-xl) var(--space-xl)}
.cards{display:flex;flex-direction:column;gap:var(--space-md);margin-top:var(--space-md)}
.item-card{padding:var(--space-md) var(--space-lg);border:1px solid var(--border);border-radius:var(--radius-md);
  background:var(--bg);transition:border-color .15s ease}
.item-card:hover{border-color:var(--border-strong)}
.item-card.stale{border-left:3px solid var(--yellow)}
.item-card.dead{border-left:3px solid var(--red)}
.item-card.duplicate{border-left:3px solid var(--secondary-container)}
.item-card .head{display:flex;justify-content:space-between;gap:var(--space-md);align-items:baseline;flex-wrap:wrap}
.item-card .title{font-weight:600;color:var(--fg-1);font-size:14.5px;line-height:1.35}
.item-card .title mark{background:var(--primary-fixed);color:var(--fg-1);padding:0 2px;border-radius:2px}
.item-card .open-link{font-family:var(--font-mono);font-size:11.5px;color:var(--primary);white-space:nowrap}
.item-card .meta-row{display:flex;flex-wrap:wrap;gap:var(--space-md);margin-top:var(--space-xs);font-family:var(--font-mono);font-size:11.5px;color:var(--fg-muted)}
.item-card .meta-row .badge{padding:1px 6px;border-radius:var(--radius-sm);background:var(--surface-container)}
.item-card .meta-row .badge.warn{background:rgba(245,158,11,.15);color:#a06200}
.item-card .meta-row .badge.err{background:rgba(239,68,68,.15);color:var(--red)}
.item-card .meta-row .badge.dup{background:rgba(123,64,224,.13);color:var(--secondary-container)}
.item-card .tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:var(--space-xs)}
.item-card .tags span{font-family:var(--font-mono);font-size:11px;color:var(--fg-muted);background:var(--surface-container-low);padding:1px 6px;border-radius:var(--radius-sm)}
.item-card .note{font-size:13px;color:var(--fg-2);margin-top:var(--space-xs);line-height:1.5}
.item-card .note mark{background:var(--primary-fixed);color:var(--fg-1);padding:0 2px;border-radius:2px}
.item-card .authors{font-size:12px;color:var(--fg-2);font-style:italic;margin-top:var(--space-xs)}
@media (prefers-color-scheme:dark){
  .item-card .meta-row .badge.warn{background:rgba(245,158,11,.18);color:#fcd34d}
  .item-card .tags span{background:var(--surface-container)}
}
.tbl-loadmore{display:flex;justify-content:center;padding:var(--space-md);font-size:13px;color:var(--fg-muted)}
.tbl-loadmore button{padding:var(--space-sm) var(--space-lg);border-radius:var(--radius-pill);
  border:1px solid var(--border-strong);background:var(--surface-container-lowest)}
.empty-state{padding:var(--space-2xl);text-align:center;font-size:13.5px;color:var(--fg-muted)}
footer{margin-top:var(--space-5xl);padding-top:var(--space-2xl);border-top:1px solid var(--border);
  font-size:12.5px;color:var(--fg-muted);max-width:78ch;line-height:1.6}
footer .privacy{font-style:italic}
@media (max-width:540px){
  main{padding:var(--space-lg) var(--space-md) var(--space-4xl)}
  .spark-card{padding:var(--space-lg)}
  .item-card .head{flex-direction:column;gap:var(--space-xs)}
}
  </style>
</head>
<body>
  <main>
    <header class="hero">
      <span class="eyebrow"><span class="mono" id="hero-format">RESEARCH</span> · html-anything</span>
      <h1 id="hero-title">__TITLE__</h1>
      <p class="editorial" id="hero-editorial">__EDITORIAL__</p>
      <div class="hero-actions">
        <button class="btn primary" id="copy-md-btn">Copy analysis as Markdown</button>
        <button class="btn" id="jump-drill-btn">Jump to drill-down</button>
      </div>
    </header>

    <section class="kpi-row" aria-label="Corpus summary">
      <div class="kpi"><div class="label" id="kpi-items-label">Items</div><div class="value mono" id="kpi-items">0</div><div class="sub" id="kpi-items-sub"></div></div>
      <div class="kpi"><div class="label" id="kpi-source-label">Top source</div><div class="value mono accent" id="kpi-source">—</div><div class="sub" id="kpi-source-sub"></div></div>
      <div class="kpi"><div class="label" id="kpi-window-label">Window</div><div class="value mono" id="kpi-window">—</div><div class="sub" id="kpi-window-sub"></div></div>
      <div class="kpi"><div class="label">Flags</div><div class="value mono" id="kpi-flags">0</div><div class="sub" id="kpi-flags-sub"></div></div>
    </section>

    <section class="section" aria-labelledby="head-topics">
      <div class="section-head">
        <h2 id="head-topics">Topics &amp; clusters</h2>
        <span class="meta" id="topic-meta"></span>
      </div>
      <div class="card">
        <div class="cluster-grid" id="topic-grid"></div>
        <div class="stack-bar" id="topic-stack"></div>
        <div class="stack-legend" id="topic-stack-legend"></div>
      </div>
    </section>

    <section class="section" aria-labelledby="head-sources">
      <div class="section-head">
        <h2 id="head-sources" data-bib-label="Top venues &amp; authors">Where they come from</h2>
        <span class="meta" id="sources-meta"></span>
      </div>
      <div class="grid-2">
        <div class="card">
          <h3 id="domain-heading">Top domains</h3>
          <div class="leader" id="domain-leader"></div>
        </div>
        <div class="card">
          <h3 id="second-leader-heading">Folders</h3>
          <div class="leader" id="second-leader"></div>
        </div>
      </div>
    </section>

    <section class="section" aria-labelledby="head-flags">
      <div class="section-head">
        <h2 id="head-flags">Duplicates, stale &amp; dead links</h2>
        <span class="meta">Heuristic flags · click to jump in</span>
      </div>
      <div class="callouts">
        <div class="callout dup">
          <div class="label">Duplicates</div>
          <h3 id="dup-h">0</h3>
          <div class="sub" id="dup-sub">URLs saved more than once</div>
          <div id="dup-list"></div>
        </div>
        <div class="callout stale">
          <div class="label">Stale</div>
          <h3 id="stale-h">0</h3>
          <div class="sub" id="stale-sub">Items older than 180 days or in Read Later</div>
          <div id="stale-list"></div>
        </div>
        <div class="callout dead">
          <div class="label">Likely dead</div>
          <h3 id="dead-h">0</h3>
          <div class="sub" id="dead-sub">Hosts known to be shut down or URL marked removed</div>
          <div id="dead-list"></div>
          <p class="hint">Hypothesis only — never fetched at render time. Verify manually.</p>
        </div>
      </div>
    </section>

    <section class="section" aria-labelledby="head-queue">
      <div class="section-head">
        <h2 id="head-queue">Read next &amp; recent activity</h2>
        <span class="meta" id="queue-meta"></span>
      </div>
      <div class="grid-2">
        <div class="card spark-card">
          <h3 id="spark-heading">Saving rhythm</h3>
          <div class="sub muted" id="spark-sub" style="font-size:12.5px"></div>
          <svg class="spark-svg" id="spark-svg" viewBox="0 0 600 130" preserveAspectRatio="none" aria-hidden="true"></svg>
          <div class="spark-axis" id="spark-axis"></div>
        </div>
        <div class="card">
          <h3 id="queue-heading">Recently saved</h3>
          <div class="queue-list" id="queue-list"></div>
        </div>
      </div>
    </section>

    <section class="section" aria-labelledby="head-drill">
      <details class="drill" id="drill" open>
        <summary><span><span id="drill-head">Browse all 0 items</span></span></summary>
        <div class="drill-body">
          <div class="drill-toolbar">
            <input class="drill-search" id="drill-search" type="search" placeholder="Search title, URL, tags, notes, authors…" aria-label="Search items">
            <span class="drill-meta" id="drill-count">0 of 0</span>
            <button class="btn" id="drill-clear">Clear filters</button>
          </div>
          <div class="chip-row-label">Topics</div>
          <div class="chips" id="topic-chips"></div>
          <div class="chip-row-label" id="folder-chip-label">Folders</div>
          <div class="chips" id="folder-chips"></div>
          <div class="chip-row-label">State</div>
          <div class="chips" id="state-chips"></div>
          <div class="cards" id="cards"></div>
          <div class="tbl-loadmore" id="loadmore"></div>
        </div>
      </details>
    </section>

    <footer>
      <p>Generated by <a href="https://github.com/clockless-org/html-anything">html-anything</a> from <span id="footer-source" class="mono"></span> (<span id="footer-bytes" class="mono"></span>) using the offline research-pack template.</p>
      <p class="privacy" style="margin-top:var(--space-md)">Generated locally — your bookmarks / bibliography file never left your machine. The full export is embedded in this HTML and rendered offline in your browser. <strong>No URLs are fetched at render or click time</strong> — link previews, favicons, and dead-link verification are all heuristic-only. For sharing, prefer an anonymized export.</p>
    </footer>
  </main>

  <script>const DATA = __DATA__;</script>
  <script>
(function(){
  const fmt = new Intl.NumberFormat("en-US")
  const FORMAT_LABEL = {
    "bookmarks-html": "BOOKMARKS",
    "bibtex": "BIBTEX",
    "ris": "RIS",
    "url-list": "URL LIST",
    "reading-list-csv": "READING LIST",
    "reading-list-json": "READING LIST",
  }
  const isBib = DATA.format === "bibtex" || DATA.format === "ris"
  const FMT = FORMAT_LABEL[DATA.format] || "RESEARCH"
  document.getElementById("hero-format").textContent = FMT
  document.getElementById("footer-source").textContent = DATA.meta.sourceFile
  document.getElementById("footer-bytes").textContent = humanBytes(DATA.meta.sizeBytes)

  // Hero KPIs
  const items = DATA.items || []
  const totals = DATA.totals || {}
  document.getElementById("kpi-items").textContent = fmt.format(items.length)
  document.getElementById("kpi-items-label").textContent = isBib ? "References" : "Items"
  document.getElementById("kpi-items-sub").textContent = (totals.withDates || 0) + " with dates · " + (totals.withNotes || 0) + " with notes"
  // Top source
  const topSource = isBib && DATA.venueLeaderboard && DATA.venueLeaderboard.length
    ? { name: DATA.venueLeaderboard[0].venue, count: DATA.venueLeaderboard[0].count, label: "venue" }
    : (DATA.rootDomains && DATA.rootDomains.length
      ? { name: DATA.rootDomains[0].domain, count: DATA.rootDomains[0].count, label: "domain" }
      : { name: "—", count: 0, label: "domain" })
  document.getElementById("kpi-source-label").textContent = "Top " + topSource.label
  document.getElementById("kpi-source").textContent = ellipsize(topSource.name, 22)
  document.getElementById("kpi-source-sub").textContent = topSource.count
    ? topSource.count + " of " + items.length + " · " + percent(topSource.count, items.length)
    : ""
  // Window
  if (isBib) {
    document.getElementById("kpi-window-label").textContent = "Year range"
    document.getElementById("kpi-window").textContent = (DATA.meta && DATA.meta.dateRange) ? DATA.meta.dateRange : "—"
    if (DATA.yearHistogram && DATA.yearHistogram.length) {
      const total = DATA.yearHistogram.reduce((s,h)=>s+h.count,0)
      const median = computeMedianYear(DATA.yearHistogram)
      document.getElementById("kpi-window-sub").textContent = "median " + median + " · " + total + " years coverage"
    }
  } else {
    document.getElementById("kpi-window-label").textContent = "Saving window"
    document.getElementById("kpi-window").textContent = (DATA.meta && DATA.meta.dateRange && DATA.meta.dateRange !== "no dated items") ? DATA.meta.dateRange : "—"
    if (DATA.reading && DATA.reading.monthlyHistogram && DATA.reading.monthlyHistogram.length) {
      const months = DATA.reading.monthlyHistogram.length
      const peakMonth = [...DATA.reading.monthlyHistogram].sort((a,b)=>b.count-a.count)[0]
      document.getElementById("kpi-window-sub").textContent = months + " month" + (months===1?"":"s") + " · peak " + peakMonth.month + " (" + peakMonth.count + ")"
    }
  }
  // Flags
  const flagsTotal = (totals.duplicates || 0) + (totals.stale || 0) + (totals.dead || 0)
  document.getElementById("kpi-flags").textContent = fmt.format(flagsTotal)
  document.getElementById("kpi-flags-sub").textContent = (totals.duplicates || 0) + " dup · " + (totals.stale || 0) + " stale · " + (totals.dead || 0) + " dead"

  // Topic clusters
  const topics = DATA.topics || []
  const topicGrid = document.getElementById("topic-grid")
  topics.slice(0, 16).forEach(t => {
    const el = document.createElement("button")
    el.className = "cluster"
    el.dataset.topic = t.name
    el.innerHTML = '<span class="name">' + escapeHtml(t.name) + '</span><span class="count">' + t.count + '</span>'
    el.addEventListener("click", () => toggleTopic(t.name))
    topicGrid.appendChild(el)
  })
  if (!topics.length) topicGrid.innerHTML = '<div class="empty-state">No topic clusters detected.</div>'
  document.getElementById("topic-meta").textContent = topics.length ? topics.length + " topic" + (topics.length===1?"":"s") + " · click to filter" : ""
  // Stacked bar (top 6 topics)
  const stack = document.getElementById("topic-stack")
  const stackLegend = document.getElementById("topic-stack-legend")
  const PALETTE = ["#a03b00","#7b40e0","#3b82f6","#10b981","#f59e0b","#00D4FF","#c94c00","#4d44e3"]
  const top6 = topics.slice(0, 6)
  const top6Total = top6.reduce((s,t)=>s+t.count,0) || 1
  top6.forEach((t,i) => {
    const seg = document.createElement("i")
    seg.style.width = (100 * t.count / top6Total) + "%"
    seg.style.background = PALETTE[i % PALETTE.length]
    seg.title = t.name + " — " + t.count
    stack.appendChild(seg)
    const li = document.createElement("span")
    li.innerHTML = '<i style="background:' + PALETTE[i % PALETTE.length] + '"></i>' + escapeHtml(t.name) + ' (' + t.count + ')'
    stackLegend.appendChild(li)
  })

  // Sources leaderboard (domain or venue)
  const domainLeader = document.getElementById("domain-leader")
  const secondLeader = document.getElementById("second-leader")
  const domainHeading = document.getElementById("domain-heading")
  const secondHeading = document.getElementById("second-leader-heading")
  if (isBib) {
    document.getElementById("head-sources").textContent = "Top venues & authors"
    domainHeading.textContent = "Venues"
    secondHeading.textContent = "Authors"
    fillLeader(domainLeader, (DATA.venueLeaderboard || []).slice(0, 10).map(v => ({ label: v.venue, count: v.count, kind: "venue", value: v.venue })))
    fillLeader(secondLeader, (DATA.authorLeaderboard || []).slice(0, 10).map(a => ({ label: a.name, count: a.count, kind: "author", value: a.name })))
  } else {
    domainHeading.textContent = "Top domains"
    secondHeading.textContent = "Folders / sections"
    fillLeader(domainLeader, (DATA.rootDomains || []).slice(0, 10).map(d => ({
      label: d.domain,
      sub: sampleTitleForDomain(d.domain),
      count: d.count,
      kind: "domain",
      value: d.domain,
    })))
    const folders = (DATA.folders || []).filter(f => f.name && f.name !== "(uncategorized)").slice(0, 10)
    fillLeader(secondLeader, folders.map(f => ({ label: f.name, count: f.count, kind: "folder", value: f.name })))
    if (!folders.length) document.getElementById("folder-chip-label").style.display = "none"
  }
  document.getElementById("sources-meta").textContent = isBib
    ? (DATA.venueLeaderboard || []).length + " venues · " + (DATA.authorLeaderboard || []).length + " authors"
    : (DATA.rootDomains || []).length + " unique domains"

  function sampleTitleForDomain(d) {
    const m = (DATA.domains || []).find(x => x.domain === d || (x.domain && x.domain.replace(/^www\./,"") === d))
    return m && m.sampleTitle ? m.sampleTitle : ""
  }

  function fillLeader(el, rows) {
    if (!rows.length) { el.innerHTML = '<div class="empty-state">No data</div>'; return }
    const max = rows[0].count
    rows.forEach(r => {
      const row = document.createElement("button")
      row.className = "leader-row"
      row.dataset.kind = r.kind
      row.dataset.value = r.value || r.label
      row.innerHTML = '<span class="lbl">' + escapeHtml(r.label) + (r.sub ? '<span class="sub">' + escapeHtml(r.sub) + '</span>' : '') + '</span>' +
        '<span class="cnt">' + r.count + '</span>' +
        '<span class="bar"><i style="width:' + (100 * r.count / max) + '%"></i></span>'
      row.addEventListener("click", () => toggleLeaderFilter(r.kind, r.value || r.label))
      el.appendChild(row)
    })
  }

  // Callouts
  const dupGroups = DATA.duplicateGroups || []
  document.getElementById("dup-h").textContent = dupGroups.length
  const dupList = document.getElementById("dup-list")
  if (!dupGroups.length) dupList.innerHTML = '<div class="empty">No duplicate URLs detected.</div>'
  else dupGroups.slice(0, 6).forEach(g => {
    const div = document.createElement("button")
    div.className = "row"
    div.innerHTML = '<strong>' + escapeHtml(g.titles[0] || "(untitled)") + '</strong>' +
      '<span class="meta">' + g.ids.length + ' copies · ' + escapeHtml(displayUrl(g.url)) + '</span>'
    div.addEventListener("click", () => focusItem(g.ids[0]))
    dupList.appendChild(div)
  })

  const stale = DATA.staleItems || []
  document.getElementById("stale-h").textContent = totals.stale || stale.length
  const staleList = document.getElementById("stale-list")
  if (!stale.length) staleList.innerHTML = '<div class="empty">Nothing stale — recent activity across the file.</div>'
  else stale.slice(0, 6).forEach(s => {
    const div = document.createElement("button")
    div.className = "row"
    div.innerHTML = '<strong>' + escapeHtml(s.title) + '</strong>' +
      '<span class="meta">' + (s.ageDays != null ? s.ageDays + 'd · ' : '') + escapeHtml(s.folder || '—') + '</span>'
    div.addEventListener("click", () => focusItem(s.id))
    staleList.appendChild(div)
  })

  const dead = DATA.deadLinks || []
  document.getElementById("dead-h").textContent = dead.length
  const deadList = document.getElementById("dead-list")
  if (!dead.length) deadList.innerHTML = '<div class="empty">No likely-dead links detected.</div>'
  else dead.slice(0, 6).forEach(d => {
    const div = document.createElement("button")
    div.className = "row"
    div.innerHTML = '<strong>' + escapeHtml(d.title) + '</strong>' +
      '<span class="meta">' + escapeHtml(d.domain || '') + ' · ' + escapeHtml(d.reason) + '</span>'
    div.addEventListener("click", () => focusItem(d.id))
    deadList.appendChild(div)
  })

  // Saving rhythm sparkline / year histogram
  const sparkSvg = document.getElementById("spark-svg")
  const sparkAxis = document.getElementById("spark-axis")
  const sparkSub = document.getElementById("spark-sub")
  const sparkHeading = document.getElementById("spark-heading")
  let buckets = []
  if (isBib && DATA.yearHistogram && DATA.yearHistogram.length) {
    sparkHeading.textContent = "Year coverage"
    sparkSub.textContent = "References per publication year"
    buckets = DATA.yearHistogram.map(y => ({ label: String(y.year), count: y.count }))
  } else if (DATA.reading && DATA.reading.monthlyHistogram && DATA.reading.monthlyHistogram.length) {
    sparkSub.textContent = "Items saved per month"
    buckets = DATA.reading.monthlyHistogram.map(m => ({ label: m.month.slice(2), count: m.count }))
  } else if (DATA.reading && DATA.reading.weeklyHistogram && DATA.reading.weeklyHistogram.length) {
    sparkSub.textContent = "Items saved per ISO week"
    buckets = DATA.reading.weeklyHistogram.map(w => ({ label: w.weekOf, count: w.count }))
  }
  if (buckets.length) {
    const max = Math.max(...buckets.map(b => b.count))
    const W = 600, H = 130, pad = 6
    const bw = (W - pad * 2) / buckets.length
    const sb = []
    buckets.forEach((b, i) => {
      const h = max ? (H - 30) * (b.count / max) : 0
      const x = pad + i * bw + 1
      const y = H - 22 - h
      sb.push('<rect class="bar" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + (bw - 2).toFixed(1) + '" height="' + h.toFixed(1) + '" rx="1"><title>' + escapeHtml(b.label) + ': ' + b.count + '</title></rect>')
    })
    if (buckets.length > 0) {
      const labelEvery = Math.max(1, Math.ceil(buckets.length / 6))
      buckets.forEach((b, i) => {
        if (i % labelEvery === 0 || i === buckets.length - 1) {
          const x = pad + i * bw + bw / 2
          sb.push('<text x="' + x.toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + escapeHtml(b.label) + '</text>')
        }
      })
    }
    sparkSvg.innerHTML = sb.join("")
    sparkAxis.innerHTML = '<span>0</span><span>peak ' + max + '</span>'
  } else {
    sparkSvg.parentElement.querySelector(".spark-svg").style.display = "none"
    sparkSub.textContent = "No date metadata — prioritization shown via topic clusters and most-saved domains."
    document.getElementById("spark-axis").style.display = "none"
  }

  // Recently saved queue
  const queueList = document.getElementById("queue-list")
  let queue
  if (isBib) {
    document.getElementById("queue-heading").textContent = "Most-recent papers"
    queue = items.filter(i => i.year).sort((a,b) => (b.year||0) - (a.year||0)).slice(0, 8)
  } else {
    queue = items.filter(i => i.addedEpoch).sort((a,b) => (b.addedEpoch||0) - (a.addedEpoch||0)).slice(0, 8)
    if (!queue.length) queue = items.slice(0, 8)
  }
  document.getElementById("queue-meta").textContent = isBib
    ? (DATA.yearHistogram || []).length + " years covered"
    : (queue.length ? queue.length + " most recent" : "")
  if (!queue.length) queueList.innerHTML = '<div class="empty-state">Nothing to prioritize.</div>'
  queue.forEach(it => {
    const div = document.createElement("div")
    div.className = "queue-item"
    const when = isBib
      ? (it.year ? String(it.year) : (it.venue || ""))
      : (it.addedIso ? it.addedIso : (it.folder || ""))
    div.innerHTML = '<button class="t" data-id="' + it.id + '">' + escapeHtml(it.title) + '</button>' +
      '<span class="when">' + escapeHtml(when) + '</span>'
    div.querySelector(".t").addEventListener("click", () => focusItem(it.id))
    queueList.appendChild(div)
  })

  // Drill-down state
  const state = {
    search: "",
    topics: new Set(),
    folders: new Set(),
    domains: new Set(),
    venues: new Set(),
    authors: new Set(),
    states: new Set(),
    rendered: 0,
    pageSize: 40,
  }

  const drillHead = document.getElementById("drill-head")
  drillHead.textContent = "Browse all " + items.length + " items"

  // Topic chips
  const topicChips = document.getElementById("topic-chips")
  topics.slice(0, 14).forEach(t => {
    const c = mkChip(t.name + " ", t.count)
    c.dataset.topic = t.name
    c.addEventListener("click", () => toggleTopic(t.name))
    topicChips.appendChild(c)
  })

  // Folder chips
  const folderChips = document.getElementById("folder-chips")
  if (isBib) {
    document.getElementById("folder-chip-label").textContent = "Reference type"
    const refTypeMap = new Map()
    items.forEach(it => { const k = it.refType || "misc"; refTypeMap.set(k, (refTypeMap.get(k) || 0) + 1) })
    Array.from(refTypeMap.entries()).sort((a,b)=>b[1]-a[1]).forEach(([k, c]) => {
      const chip = mkChip(k, c)
      chip.dataset.folder = k
      chip.addEventListener("click", () => toggleFolder(k))
      folderChips.appendChild(chip)
    })
  } else {
    const folders = (DATA.folders || []).filter(f => f.name && f.name !== "(uncategorized)").slice(0, 12)
    if (!folders.length) document.getElementById("folder-chip-label").style.display = "none"
    folders.forEach(f => {
      const chip = mkChip(f.name, f.count)
      chip.dataset.folder = f.name
      chip.addEventListener("click", () => toggleFolder(f.name))
      folderChips.appendChild(chip)
    })
  }

  // State chips
  const stateChips = document.getElementById("state-chips")
  const stateOptions = [
    { key: "stale", label: "Stale", count: totals.stale || 0 },
    { key: "duplicate", label: "Duplicate", count: totals.duplicates || 0 },
    { key: "dead", label: "Likely dead", count: totals.dead || 0 },
    { key: "has-note", label: "Has note", count: totals.withNotes || items.filter(i=>i.note).length },
  ]
  stateOptions.forEach(o => {
    const chip = mkChip(o.label, o.count)
    chip.dataset.state = o.key
    chip.addEventListener("click", () => toggleState(o.key))
    if (o.count === 0) chip.style.opacity = "0.45"
    stateChips.appendChild(chip)
  })

  // Search
  const searchInput = document.getElementById("drill-search")
  searchInput.addEventListener("input", () => { state.search = searchInput.value.trim().toLowerCase(); render() })
  document.getElementById("drill-clear").addEventListener("click", () => {
    state.topics.clear(); state.folders.clear(); state.domains.clear(); state.venues.clear(); state.authors.clear(); state.states.clear()
    state.search = ""; searchInput.value = ""
    syncChipState(); render()
  })

  function toggleTopic(name) { toggleInSet(state.topics, name); syncChipState(); render() }
  function toggleFolder(name) { toggleInSet(state.folders, name); syncChipState(); render() }
  function toggleState(key) { toggleInSet(state.states, key); syncChipState(); render() }
  function toggleLeaderFilter(kind, value) {
    if (kind === "domain") toggleInSet(state.domains, value)
    else if (kind === "folder") toggleInSet(state.folders, value)
    else if (kind === "venue") toggleInSet(state.venues, value)
    else if (kind === "author") toggleInSet(state.authors, value)
    syncChipState(); render(); document.getElementById("drill").scrollIntoView({ behavior: "smooth", block: "start" })
  }
  function toggleInSet(set, val) { if (set.has(val)) set.delete(val); else set.add(val) }

  function syncChipState() {
    document.querySelectorAll("#topic-chips .chip").forEach(c => c.classList.toggle("active", state.topics.has(c.dataset.topic)))
    document.querySelectorAll("#folder-chips .chip").forEach(c => c.classList.toggle("active", state.folders.has(c.dataset.folder)))
    document.querySelectorAll("#state-chips .chip").forEach(c => c.classList.toggle("active", state.states.has(c.dataset.state)))
    document.querySelectorAll(".cluster").forEach(c => c.classList.toggle("active", state.topics.has(c.dataset.topic)))
  }

  function matches(it) {
    if (state.topics.size) {
      const inTopic = (it.tags && it.tags.some(t => state.topics.has(t))) ||
        (it.topic && state.topics.has(it.topic)) ||
        (it.folder && state.topics.has(it.folder))
      if (!inTopic) return false
    }
    if (state.folders.size) {
      const inFolder = (it.folder && state.folders.has(it.folder)) ||
        (isBib && it.refType && state.folders.has(it.refType))
      if (!inFolder) return false
    }
    if (state.domains.size) {
      const dom = it.domainRoot || it.domain
      if (!dom || !state.domains.has(dom)) return false
    }
    if (state.venues.size && (!it.venue || !state.venues.has(it.venue))) return false
    if (state.authors.size && (!it.authors || !it.authors.some(a => state.authors.has(a)))) return false
    if (state.states.size) {
      for (const s of state.states) {
        if (s === "stale" && !it.isStale) return false
        if (s === "duplicate" && !it.isDuplicate) return false
        if (s === "dead" && !it.isDead) return false
        if (s === "has-note" && !(it.note || it.abstract)) return false
      }
    }
    if (state.search) {
      const q = state.search
      const hay = [it.title, it.url, it.note, it.abstract, it.venue, it.folder, (it.tags||[]).join(" "), (it.authors||[]).join(" ")]
        .filter(Boolean).join(" ").toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  }

  const cards = document.getElementById("cards")
  const loadmore = document.getElementById("loadmore")
  function render() {
    cards.innerHTML = ""
    const matching = items.filter(matches)
    document.getElementById("drill-count").textContent = matching.length + " of " + items.length
    state.rendered = 0
    appendCards(matching)
    if (state.rendered < matching.length) {
      loadmore.innerHTML = ""
      const btn = document.createElement("button")
      btn.textContent = "Show " + Math.min(state.pageSize, matching.length - state.rendered) + " more"
      btn.addEventListener("click", () => appendCards(matching))
      loadmore.appendChild(btn)
    } else loadmore.innerHTML = ""
  }

  function appendCards(matching) {
    const next = matching.slice(state.rendered, state.rendered + state.pageSize)
    next.forEach(it => cards.appendChild(buildCard(it)))
    state.rendered += next.length
    if (state.rendered >= matching.length) loadmore.innerHTML = ""
  }

  function buildCard(it) {
    const card = document.createElement("div")
    card.className = "item-card"
    card.id = "card-" + it.id
    if (it.isStale) card.classList.add("stale")
    if (it.isDead) card.classList.add("dead")
    if (it.isDuplicate) card.classList.add("duplicate")
    const titleHtml = highlight(it.title || "(untitled)", state.search)
    const noteHtml = (it.abstract || it.note) ? highlight(ellipsize(it.abstract || it.note, 360), state.search) : ""
    const link = it.url
      ? '<a class="open-link" href="' + escapeAttr(it.url) + '" target="_blank" rel="noopener noreferrer">open ↗</a>'
      : ''
    const meta = []
    if (isBib) {
      if (it.year) meta.push('<span>' + it.year + '</span>')
      if (it.venue) meta.push('<span>' + escapeHtml(it.venue) + '</span>')
      if (it.refType) meta.push('<span class="badge">' + escapeHtml(it.refType) + '</span>')
      if (it.doi) meta.push('<span>doi:' + escapeHtml(it.doi) + '</span>')
    } else {
      if (it.domain) meta.push('<span>' + escapeHtml(it.domain) + '</span>')
      if (it.folder) meta.push('<span class="badge">' + escapeHtml(it.folder) + '</span>')
      if (it.addedIso) meta.push('<span>added ' + it.addedIso + '</span>')
      if (it.ageDays != null) meta.push('<span>' + it.ageDays + 'd</span>')
    }
    if (it.isStale) meta.push('<span class="badge warn">stale</span>')
    if (it.isDuplicate) meta.push('<span class="badge dup">duplicate</span>')
    if (it.isDead) meta.push('<span class="badge err">likely dead</span>')
    const tagsHtml = it.tags && it.tags.length
      ? '<div class="tags">' + it.tags.map(t => '<span>' + escapeHtml(t) + '</span>').join("") + '</div>'
      : ""
    const authorsHtml = (isBib && it.authors && it.authors.length)
      ? '<div class="authors">' + escapeHtml(it.authors.slice(0, 4).join(", ")) + (it.authors.length > 4 ? ", +" + (it.authors.length - 4) + " more" : "") + '</div>'
      : ""
    card.innerHTML =
      '<div class="head"><div class="title">' + titleHtml + '</div>' + link + '</div>' +
      authorsHtml +
      (meta.length ? '<div class="meta-row">' + meta.join("") + '</div>' : "") +
      tagsHtml +
      (noteHtml ? '<div class="note">' + noteHtml + '</div>' : "")
    return card
  }

  function focusItem(id) {
    state.search = ""; searchInput.value = ""
    state.topics.clear(); state.folders.clear(); state.domains.clear()
    state.venues.clear(); state.authors.clear(); state.states.clear()
    syncChipState(); render()
    requestAnimationFrame(() => {
      const el = document.getElementById("card-" + id)
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" })
        el.style.transition = "background-color 0.6s ease"
        const orig = el.style.backgroundColor
        el.style.backgroundColor = "var(--primary-fixed)"
        setTimeout(() => { el.style.backgroundColor = orig || "" }, 1100)
      }
    })
  }

  document.getElementById("jump-drill-btn").addEventListener("click", () => {
    document.getElementById("drill").open = true
    document.getElementById("drill").scrollIntoView({ behavior: "smooth", block: "start" })
  })

  document.getElementById("copy-md-btn").addEventListener("click", async () => {
    const lines = []
    lines.push("# " + (document.getElementById("hero-title").textContent || "html-anything"))
    lines.push("")
    lines.push((document.getElementById("hero-editorial").textContent || "").trim())
    lines.push("")
    lines.push("## Topics")
    topics.slice(0, 8).forEach(t => lines.push("- " + t.name + " — " + t.count))
    lines.push("")
    lines.push("## " + (isBib ? "Top venues" : "Top domains"))
    if (isBib) (DATA.venueLeaderboard || []).slice(0, 8).forEach(v => lines.push("- " + v.venue + " — " + v.count))
    else (DATA.rootDomains || []).slice(0, 8).forEach(d => lines.push("- " + d.domain + " — " + d.count))
    lines.push("")
    lines.push("## Flags")
    lines.push("- Duplicates: " + (totals.duplicates || 0))
    lines.push("- Stale items: " + (totals.stale || 0))
    lines.push("- Likely-dead links: " + (totals.dead || 0))
    if (isBib && DATA.authorLeaderboard && DATA.authorLeaderboard.length) {
      lines.push("")
      lines.push("## Top authors")
      DATA.authorLeaderboard.slice(0, 8).forEach(a => lines.push("- " + a.name + " — " + a.count))
    }
    const md = lines.join("\n")
    try {
      await navigator.clipboard.writeText(md)
      const btn = document.getElementById("copy-md-btn")
      const orig = btn.textContent
      btn.textContent = "Copied ✓"
      setTimeout(() => { btn.textContent = orig }, 1600)
    } catch (e) {
      window.prompt("Copy markdown:", md)
    }
  })

  function mkChip(label, count) {
    const c = document.createElement("button")
    c.className = "chip"
    c.innerHTML = escapeHtml(label) + ' <span class="count">' + count + '</span>'
    return c
  }

  function highlight(text, q) {
    const safe = escapeHtml(text)
    if (!q) return safe
    const re = new RegExp("(" + escapeRegExp(q) + ")", "ig")
    return safe.replace(re, "<mark>$1</mark>")
  }
  function escapeRegExp(s) { return s.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&") }
  function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])) }
  function escapeAttr(s) { return escapeHtml(s) }
  function ellipsize(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s }
  function displayUrl(s) {
    s = String(s || "")
    if (s.length <= 60) return s
    try {
      const u = new URL(s)
      return u.host + (u.pathname === "/" ? "" : ellipsize(u.pathname, 36))
    } catch { return ellipsize(s, 60) }
  }
  function percent(part, whole) {
    if (!whole) return "—"
    return Math.round(100 * part / whole) + "%"
  }
  function humanBytes(n) {
    if (!n) return "0 B"
    if (n < 1024) return n + " B"
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB"
    return (n / 1024 / 1024).toFixed(2) + " MB"
  }
  function computeMedianYear(hist) {
    const total = hist.reduce((s, h) => s + h.count, 0)
    const half = total / 2
    let acc = 0
    for (const h of hist) {
      acc += h.count
      if (acc >= half) return h.year
    }
    return hist[hist.length - 1].year
  }

  // initial render
  render()
})()
  </script>
</body>
</html>`

async function main() {
  const argv = process.argv.slice(2)
  let input = ""
  let out = ""
  let title = ""
  let editorial = ""
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--out") out = argv[++i]
    else if (a === "--title") title = argv[++i]
    else if (a === "--editorial") editorial = argv[++i]
    else if (!input) input = a
    else throw new Error(`unexpected positional: ${a}`)
  }
  if (!input) {
    console.error("usage: render_research_fallback.mjs INPUT --out OUT [--title T] [--editorial E]")
    process.exit(2)
  }
  const filepath = path.resolve(input)
  const parser = await pickParser(filepath)
  if (!parser) throw new Error(`no parser for ${input}`)
  const parsed = await parser.parse(filepath)
  const t = title || parsed.meta.sourceFile
  const ed = editorial || parsed.summary
  const json = JSON.stringify(parsed.data).replace(/<\/script/gi, "<\\/script")
  const html = TEMPLATE
    .replace(/__TITLE__/g, escapeHtml(t))
    .replace(/__EDITORIAL__/g, escapeHtml(ed))
    .replace(/__DATA__/g, json)
  const outPath = path.resolve(out || filepath.replace(/\.[^.]+$/, ".html"))
  await fs.writeFile(outPath, html, "utf8")
  process.stderr.write(`✓ ${path.relative(process.cwd(), outPath)} (${(html.length / 1024).toFixed(1)} KB)\n`)
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1) })
