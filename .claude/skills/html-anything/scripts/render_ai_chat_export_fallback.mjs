/**
 * Offline fallback renderer for the AI chat-export pack
 * (chatgpt-export, claude-chat-export, ai-chat-export). The canonical
 * pipeline is `dist/cli.js → htmlize → LLM`, but example regeneration
 * may run on machines without an Anthropic / OpenAI key. This script
 * reuses the same parser, then applies a hand-tuned shared template
 * that satisfies the `_ai_chat_export.md` family contract:
 *
 *   1. Overview cards (counts, kind / model breakdown, narrative line)
 *   2. Activity timeline (weekly bars + activity-rhythm strip)
 *   3. Topic clusters (chip cloud, click filters the index)
 *   4. Reusable prompts & important answers (heuristic-labeled)
 *   5. Unresolved threads (heuristic-labeled)
 *   6. Conversation index + per-conversation drill-down
 *
 * The template emits __DATA__ and is injected with the same JSON
 * substitution as htmlize.ts, so the output renders the full inlined
 * data identically to an LLM-designed page. Outputs respect the
 * privacy-first / offline-only contract — no network calls back to
 * OpenAI / Anthropic at render or click time, no avatar fetches, no
 * URL unfurls.
 *
 * Usage:
 *   node scripts/render_ai_chat_export_fallback.mjs INPUT --out OUT --title TITLE [--editorial "..."]
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
  <style>
:root {
  --primary:#a03b00; --primary-container:#c94c00; --on-primary:#fff;
  --secondary:#7b40e0; --tertiary:#4d44e3; --accent-cyan:#00D4FF;
  --bg:#fff8f6; --surface:#fff8f6; --surface-container-lowest:#fff;
  --surface-container-low:#fbf2ef; --surface-container:#f5ece9; --surface-container-high:#efe6e3;
  --fg-1:#1e1b19; --fg-2:#594138; --fg-muted:#8d7166;
  --border:rgba(0,0,0,.06); --border-strong:rgba(0,0,0,.12);
  --green:#10b981; --blue:#3b82f6; --yellow:#f59e0b; --red:#ef4444;
  --user-tint:#3b82f6; --asst-tint:#a03b00; --sys-tint:#8d7166;
  --font-headline:'Space Grotesk',ui-sans-serif,system-ui,sans-serif;
  --font-body:'Plus Jakarta Sans',ui-sans-serif,system-ui,sans-serif;
  --font-mono:'SF Mono','Menlo',ui-monospace,monospace;
  --space-xs:4px; --space-sm:8px; --space-md:12px; --space-lg:16px;
  --space-xl:20px; --space-2xl:24px; --space-3xl:32px; --space-4xl:48px; --space-5xl:64px;
  --radius-sm:8px; --radius-md:12px; --radius-lg:16px; --radius-xl:20px; --radius-pill:9999px;
  --shadow-sm:0 1px 2px rgba(30,27,25,.04); --shadow-md:0 4px 12px rgba(30,27,25,.08);
  --shadow-accent:0 8px 24px rgba(160,59,0,.15);
  --gradient-text:linear-gradient(135deg,#a03b00 0%,#7b40e0 100%);
  --gradient-primary:linear-gradient(135deg,#a03b00 0%,#c94c00 100%);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg:#060B18; --surface:#0B1426; --surface-container-lowest:#101D35;
    --surface-container-low:#101D35; --surface-container:#162544; --surface-container-high:#1c2d52;
    --fg-1:#F8FAFC; --fg-2:#CBD5E1; --fg-muted:#64748B;
    --border:rgba(255,255,255,.08); --border-strong:rgba(255,255,255,.14);
    --primary:#FF6B35; --user-tint:#60a5fa; --asst-tint:#FF6B35; --sys-tint:#94a3b8;
    --shadow-md:0 4px 12px rgba(0,0,0,.4);
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
h4{font-size:14px;margin-bottom:var(--space-sm);color:var(--fg-2)}
.muted{color:var(--fg-muted)}
.mono{font-family:var(--font-mono);font-variant-numeric:tabular-nums}
button{font:inherit;cursor:pointer;border:none;background:transparent;color:inherit}
input,select,textarea{font:inherit;color:var(--fg-1)}
a{color:var(--primary);text-decoration:none}
a:hover{text-decoration:underline}
code,pre{font-family:var(--font-mono)}
.hero{padding:var(--space-3xl) 0 var(--space-2xl);border-bottom:1px solid var(--border)}
.hero .eyebrow{display:inline-flex;gap:var(--space-sm);align-items:center;
  background:var(--surface-container);color:var(--primary);
  padding:var(--space-xs) var(--space-md);border-radius:var(--radius-pill);
  font-family:var(--font-mono);font-size:11.5px;font-weight:500;
  text-transform:uppercase;letter-spacing:.08em;margin-bottom:var(--space-lg)}
.hero h1{background:var(--gradient-text);-webkit-background-clip:text;background-clip:text;color:transparent;max-width:24ch}
.hero .editorial{margin-top:var(--space-lg);max-width:64ch;color:var(--fg-2);font-size:17px;line-height:1.55}
.hero-actions{display:flex;gap:var(--space-md);margin-top:var(--space-xl);flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;gap:var(--space-sm);padding:var(--space-sm) var(--space-lg);
  border-radius:var(--radius-pill);font-weight:600;font-size:14px;border:1px solid var(--border-strong);
  background:var(--surface-container-lowest);color:var(--fg-1);transition:all .15s ease}
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
@media (max-width:780px){.grid-2{grid-template-columns:1fr}}
.heur-chip{display:inline-flex;align-items:center;gap:6px;padding:3px var(--space-sm);
  border-radius:var(--radius-pill);background:var(--surface-container);color:var(--secondary);
  font-family:var(--font-mono);font-size:10.5px;font-weight:500;
  text-transform:uppercase;letter-spacing:.08em}
.stack-bar{display:flex;height:14px;border-radius:var(--radius-pill);overflow:hidden;margin-top:var(--space-sm);background:var(--surface-container)}
.stack-bar i{display:block;height:100%}
.stack-legend{display:flex;flex-wrap:wrap;gap:var(--space-md);margin-top:var(--space-sm);font-size:12.5px;color:var(--fg-muted);font-family:var(--font-mono)}
.stack-legend span{display:inline-flex;align-items:center;gap:6px}
.stack-legend i{width:10px;height:10px;border-radius:2px;display:inline-block}
.kind-code{background:var(--blue)} .kind-writing{background:var(--secondary)} .kind-planning{background:var(--green)}
.kind-research{background:var(--accent-cyan)} .kind-chat{background:var(--yellow)} .kind-other{background:var(--fg-muted)}
.chips{display:flex;gap:var(--space-sm);flex-wrap:wrap;margin-bottom:var(--space-md)}
.chip{display:inline-flex;align-items:center;gap:var(--space-sm);padding:6px var(--space-md);
  border-radius:var(--radius-pill);background:var(--surface-container);border:1px solid var(--border);
  font-size:12.5px;font-weight:500;cursor:pointer;transition:all .15s ease;user-select:none}
.chip:hover{background:var(--surface-container-high)}
.chip.active{background:var(--primary);color:var(--on-primary);border-color:transparent}
.chip .count{font-family:var(--font-mono);font-size:11.5px;color:var(--fg-muted);font-weight:400}
.chip.active .count{color:rgba(255,255,255,.8)}
.timeline-svg{width:100%;height:130px;display:block;margin-top:var(--space-md)}
.timeline-svg .bar{fill:var(--secondary);opacity:.65}
.timeline-svg .bar:hover{opacity:.95}
.timeline-svg text{font-family:var(--font-mono);font-size:11px;fill:var(--fg-muted)}
.rhythm{display:grid;grid-template-columns:1fr 1fr;gap:var(--space-xl);margin-top:var(--space-lg)}
.rhythm-card h4{margin-bottom:var(--space-xs);font-size:13px;color:var(--fg-muted);font-weight:500}
.rhythm-bars{display:flex;align-items:flex-end;gap:2px;height:40px}
.rhythm-bars i{flex:1;background:var(--primary);border-radius:2px 2px 0 0;opacity:.6;min-height:2px}
.rhythm-axis{display:flex;justify-content:space-between;font-family:var(--font-mono);font-size:10.5px;color:var(--fg-muted);margin-top:var(--space-xs)}
@media (max-width:780px){.rhythm{grid-template-columns:1fr}}
.heur-panel{display:flex;flex-direction:column;gap:var(--space-md)}
.heur-card{padding:var(--space-md);border:1px solid var(--border);border-left:3px solid var(--secondary);
  border-radius:var(--radius-md);background:var(--surface-container-lowest)}
.heur-card.important{border-left-color:var(--primary)}
.heur-card .meta-row{display:flex;justify-content:space-between;gap:var(--space-md);align-items:baseline;margin-bottom:var(--space-xs);font-size:12px;color:var(--fg-muted);font-family:var(--font-mono)}
.heur-card .body{font-size:13.5px;line-height:1.5;color:var(--fg-2);white-space:pre-wrap;word-break:break-word}
.heur-card .actions{display:flex;justify-content:space-between;align-items:center;margin-top:var(--space-sm);gap:var(--space-md)}
.heur-card .copy-btn,.heur-card .jump-btn{padding:4px var(--space-sm);font-size:11.5px;border:1px solid var(--border);
  border-radius:var(--radius-sm);background:var(--surface-container);color:var(--fg-1);font-family:var(--font-mono);cursor:pointer}
.heur-card .copy-btn:hover,.heur-card .jump-btn:hover{background:var(--surface-container-high)}
.empty{font-size:13px;color:var(--fg-muted);font-style:italic;padding:var(--space-md) 0}
.callouts{display:grid;grid-template-columns:1fr;gap:var(--space-md)}
.callout{padding:var(--space-md);border:1px solid var(--border);border-left:3px solid var(--yellow);
  border-radius:var(--radius-md);background:var(--surface-container-lowest);cursor:pointer}
.callout:hover{background:var(--surface-container-low)}
.callout .ttl{font-weight:600;font-size:14px;color:var(--fg-1);margin-bottom:2px}
.callout .meta{font-family:var(--font-mono);font-size:11.5px;color:var(--fg-muted);margin-bottom:var(--space-xs)}
.callout .last{font-size:13px;color:var(--fg-2);font-style:italic}
.callout .why{font-size:11.5px;color:var(--fg-muted);margin-top:var(--space-xs);font-style:italic}
.drill-toolbar{display:flex;gap:var(--space-md);margin-bottom:var(--space-md);flex-wrap:wrap;align-items:center}
.drill-search{flex:1 1 280px;min-width:220px;padding:var(--space-sm) var(--space-md);border:1px solid var(--border-strong);
  border-radius:var(--radius-md);background:var(--surface-container-lowest);font-size:14px;font-family:var(--font-mono)}
.drill-search:focus{outline:2px solid var(--primary);outline-offset:1px;border-color:var(--primary)}
.drill-meta{font-size:12.5px;color:var(--fg-muted);font-family:var(--font-mono)}
.convo-list{display:flex;flex-direction:column;gap:var(--space-md)}
.convo{background:var(--surface-container-lowest);border:1px solid var(--border);border-radius:var(--radius-lg);
  padding:var(--space-lg) var(--space-xl);box-shadow:var(--shadow-sm)}
.convo .head{display:flex;justify-content:space-between;gap:var(--space-md);align-items:baseline;flex-wrap:wrap}
.convo .ttl{font-family:var(--font-headline);font-weight:600;font-size:17px;color:var(--fg-1)}
.convo .when{font-family:var(--font-mono);font-size:12px;color:var(--fg-muted)}
.convo .badges{display:flex;gap:var(--space-xs);flex-wrap:wrap;margin-top:var(--space-xs)}
.badge{display:inline-flex;align-items:center;gap:4px;padding:2px var(--space-sm);
  border-radius:var(--radius-pill);background:var(--surface-container);font-family:var(--font-mono);font-size:11px;color:var(--fg-2)}
.badge.kind{background:var(--surface-container-high);color:var(--fg-1)}
.badge.code{background:rgba(59,130,246,.15);color:var(--blue)}
.badge.unresolved{background:rgba(245,158,11,.15);color:var(--yellow)}
.badge.model{background:var(--surface-container);color:var(--secondary)}
.preview{margin-top:var(--space-md);display:grid;grid-template-columns:1fr 1fr;gap:var(--space-md)}
@media (max-width:780px){.preview{grid-template-columns:1fr}}
.preview .row{font-size:13px;line-height:1.5}
.preview .role{font-family:var(--font-mono);font-size:11px;color:var(--fg-muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:2px}
.preview .text{color:var(--fg-2);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}
.convo .toolbar{display:flex;gap:var(--space-sm);margin-top:var(--space-md)}
.convo .toolbar button{padding:4px var(--space-sm);font-size:11.5px;border:1px solid var(--border);
  border-radius:var(--radius-sm);background:var(--surface-container);color:var(--fg-1);font-family:var(--font-mono);cursor:pointer}
.convo .toolbar button:hover{background:var(--surface-container-high)}
.thread{margin-top:var(--space-md);border-top:1px solid var(--border);padding-top:var(--space-md);display:none}
.convo.open .thread{display:block}
.day-bucket{margin-bottom:var(--space-md)}
.day-bucket .day{font-family:var(--font-mono);font-size:11px;color:var(--fg-muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:var(--space-xs)}
.bubble{padding:var(--space-md) var(--space-lg);border-radius:var(--radius-md);margin-bottom:var(--space-sm);
  background:var(--surface-container);font-size:14px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.bubble.user{background:rgba(59,130,246,.08);border-left:3px solid var(--user-tint)}
.bubble.assistant{background:rgba(160,59,0,.06);border-left:3px solid var(--asst-tint)}
.bubble.system,.bubble.tool{background:var(--surface-container);border-left:3px solid var(--sys-tint);color:var(--fg-muted);font-size:12.5px}
.bubble .role-line{font-family:var(--font-mono);font-size:11px;color:var(--fg-muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:var(--space-xs);display:flex;justify-content:space-between;gap:var(--space-md)}
.bubble pre,.bubble code{background:var(--surface-container-high);padding:2px 6px;border-radius:4px;font-size:13px}
.bubble pre{padding:var(--space-md);overflow-x:auto;margin:var(--space-sm) 0}
.bubble pre code{background:transparent;padding:0}
.search-hit{background:rgba(245,158,11,.35);border-radius:2px;padding:0 2px}
footer{margin-top:var(--space-5xl);padding-top:var(--space-2xl);border-top:1px solid var(--border);
  font-size:12.5px;color:var(--fg-muted);font-family:var(--font-mono);font-style:italic;line-height:1.6;max-width:64ch}
  </style>
</head>
<body>
<main>
  <header class="hero">
    <div class="eyebrow"><span>__PLATFORM__</span><span>•</span><span>__ACTIVE_RANGE__</span></div>
    <h1>__TITLE__</h1>
    <p class="editorial">__EDITORIAL__</p>
    <div class="hero-actions">
      <button class="btn primary" data-action="copy-summary">Copy summary as Markdown</button>
      <button class="btn" data-action="expand-all">Expand all conversations</button>
      <button class="btn" data-action="collapse-all">Collapse all</button>
    </div>
    <div class="kpi-row" id="kpi-row"></div>
  </header>

  <section class="section" id="section-overview">
    <div class="section-head"><h2>Overview</h2><span class="meta">kind & model breakdown</span></div>
    <div class="grid-2">
      <div class="card" id="kind-card">
        <h3>What you used AI for</h3>
        <div id="kind-stack"></div>
        <div class="muted" style="font-size:12.5px;margin-top:var(--space-md)">
          Conversation kinds are inferred from message keywords and code-block density —
          <span class="heur-chip">Heuristic</span> not exact.
        </div>
      </div>
      <div class="card" id="model-card">
        <h3>Models you talked to</h3>
        <div id="model-list"></div>
      </div>
    </div>
  </section>

  <section class="section" id="section-timeline">
    <div class="section-head"><h2>Timeline</h2><span class="meta" id="timeline-meta"></span></div>
    <div class="card">
      <svg class="timeline-svg" id="timeline-svg" viewBox="0 0 1000 130" preserveAspectRatio="none"></svg>
      <div class="rhythm">
        <div class="rhythm-card">
          <h4>Hour of day (UTC)</h4>
          <div class="rhythm-bars" id="hour-bars"></div>
          <div class="rhythm-axis"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div>
        </div>
        <div class="rhythm-card">
          <h4>Day of week (UTC)</h4>
          <div class="rhythm-bars" id="dow-bars"></div>
          <div class="rhythm-axis"><span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span></div>
        </div>
      </div>
    </div>
  </section>

  <section class="section" id="section-topics">
    <div class="section-head"><h2>Topics</h2><span class="meta">click a chip to filter the index</span></div>
    <div class="card">
      <div class="chips" id="topic-chips"></div>
      <div class="muted" style="font-size:12.5px;margin-top:var(--space-md)">
        Topics come from a coarse keyword roll-up across titles + first user prompts —
        <span class="heur-chip">Heuristic</span> not real topic modeling.
      </div>
    </div>
  </section>

  <section class="section" id="section-heuristic">
    <div class="section-head"><h2>Reusable prompts &amp; important answers</h2><span class="meta">heuristic — review before reusing</span></div>
    <div class="grid-2">
      <div class="card">
        <h3>Reusable prompts <span class="heur-chip">Heuristic</span></h3>
        <p class="muted" style="font-size:12.5px;margin-bottom:var(--space-md)">
          User prompts that share keywords with prompts from other conversations
          (heuristic — review before reusing).
        </p>
        <div class="heur-panel" id="reusable-panel"></div>
      </div>
      <div class="card">
        <h3>Important answers <span class="heur-chip">Heuristic</span></h3>
        <p class="muted" style="font-size:12.5px;margin-bottom:var(--space-md)">
          The longest single assistant reply per conversation — usually the
          chunks of advice or code worth revisiting.
        </p>
        <div class="heur-panel" id="important-panel"></div>
      </div>
    </div>
  </section>

  <section class="section" id="section-unresolved">
    <div class="section-head"><h2>Unresolved threads</h2><span class="meta">heuristic — surface-pattern hints</span></div>
    <div class="card">
      <p class="muted" style="font-size:12.5px;margin-bottom:var(--space-md)">
        Conversations where the last turn is a user message, or where the
        assistant ended with an unusually short reply to a question
        (<span class="heur-chip">Heuristic</span> — these are surface-pattern hypotheses, not verdicts).
      </p>
      <div class="callouts" id="unresolved-list"></div>
    </div>
  </section>

  <section class="section" id="section-index">
    <div class="section-head"><h2>Conversation index</h2><span class="meta" id="index-meta"></span></div>
    <div class="drill-toolbar">
      <input class="drill-search" id="search" placeholder="Search titles &amp; messages…" autocomplete="off" />
      <span class="drill-meta" id="filter-summary"></span>
    </div>
    <div class="chips" id="kind-chips"></div>
    <div class="convo-list" id="convo-list"></div>
  </section>

  <footer>
    Generated locally — your AI chat export never left your machine.
    The full conversation log is embedded in this HTML and rendered in your
    browser. No network calls back to OpenAI / Anthropic at render or click
    time. For sharing, prefer an anonymized export.
  </footer>
</main>

<script>const DATA = __DATA__;</script>
<script>
(function () {
  const $ = (s, r) => (r || document).querySelector(s)
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s))

  const conversations = DATA.conversations || []
  const convoById = new Map(conversations.map(c => [c.id, c]))
  const state = { topic: null, kind: null, search: "", openIds: new Set() }

  const kpiRow = $("#kpi-row")
  function kpi(label, value, sub, accent) {
    const el = document.createElement("div")
    el.className = "kpi"
    el.innerHTML = '<div class="label">' + escapeHtml(label) + '</div>' +
      '<div class="value' + (accent ? ' accent' : '') + '">' + escapeHtml(value) + '</div>' +
      (sub ? '<div class="sub">' + escapeHtml(sub) + '</div>' : '')
    return el
  }
  kpiRow.appendChild(kpi("Conversations", String(DATA.totals.conversations || 0)))
  kpiRow.appendChild(kpi("Messages", String(DATA.totals.messages || 0), DATA.totals.userMessages + " from you, " + DATA.totals.assistantMessages + " from AI"))
  kpiRow.appendChild(kpi("Active days", String(DATA.totals.activeDays || 0), DATA.activeRange))
  kpiRow.appendChild(kpi("Code blocks", String(DATA.totals.codeBlocks || 0), null, true))

  const kindStack = $("#kind-stack")
  const kindEntries = (DATA.kindBreakdown || []).filter(k => k.count > 0)
  const kindTotal = kindEntries.reduce((s, k) => s + k.count, 0) || 1
  const stackBar = document.createElement("div")
  stackBar.className = "stack-bar"
  for (const k of kindEntries) {
    const i = document.createElement("i")
    i.className = "kind-" + k.kind
    i.style.width = (100 * k.count / kindTotal).toFixed(2) + "%"
    i.title = k.kind + " — " + k.count
    stackBar.appendChild(i)
  }
  kindStack.appendChild(stackBar)
  const legend = document.createElement("div")
  legend.className = "stack-legend"
  for (const k of kindEntries) {
    const span = document.createElement("span")
    span.innerHTML = '<i class="kind-' + k.kind + '"></i>' + escapeHtml(k.kind) + ' · ' + k.count
    legend.appendChild(span)
  }
  kindStack.appendChild(legend)

  const modelList = $("#model-list")
  const modelEntries = (DATA.modelBreakdown || []).slice(0, 8)
  if (!modelEntries.length) {
    modelList.innerHTML = '<p class="empty">No model metadata in this export.</p>'
  } else {
    const totalMsgs = modelEntries.reduce((s, m) => s + m.messageCount, 0) || 1
    for (const m of modelEntries) {
      const row = document.createElement("div")
      row.style.cssText = "display:grid;grid-template-columns:1fr auto auto;gap:var(--space-md);align-items:center;padding:var(--space-sm) 0;border-bottom:1px solid var(--border);font-size:13.5px"
      row.innerHTML = '<span class="mono">' + escapeHtml(m.model) + '</span>' +
        '<span style="width:80px;height:6px;background:var(--surface-container);border-radius:var(--radius-pill);overflow:hidden">' +
          '<i style="display:block;height:100%;background:var(--gradient-primary);width:' + (100 * m.messageCount / totalMsgs).toFixed(1) + '%"></i>' +
        '</span>' +
        '<span class="mono muted">' + m.messageCount + ' msg</span>'
      modelList.appendChild(row)
    }
  }

  const tlSvg = $("#timeline-svg")
  const tlMeta = $("#timeline-meta")
  const buckets = (DATA.weeklyHistogram && DATA.weeklyHistogram.length >= 4)
    ? DATA.weeklyHistogram : DATA.monthlyHistogram || []
  if (!buckets.length) {
    tlSvg.innerHTML = '<text x="500" y="65" text-anchor="middle">No dated conversations.</text>'
    tlMeta.textContent = ""
  } else {
    const max = Math.max(1, ...buckets.map(b => b.count))
    const w = 1000, h = 130, pad = 14
    const bw = (w - pad * 2) / buckets.length
    let svg = ""
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i]
      const bh = (b.count / max) * (h - 30)
      const x = pad + i * bw
      const y = h - bh - 14
      svg += '<rect class="bar" x="' + (x + 1) + '" y="' + y + '" width="' + (bw - 2) + '" height="' + bh + '"><title>' + escapeHtml(b.weekOf || b.month) + ' — ' + b.count + '</title></rect>'
    }
    svg += '<text x="' + pad + '" y="' + (h - 2) + '" text-anchor="start">' + escapeHtml(buckets[0].weekOf || buckets[0].month) + '</text>'
    svg += '<text x="' + (w - pad) + '" y="' + (h - 2) + '" text-anchor="end">' + escapeHtml(buckets[buckets.length - 1].weekOf || buckets[buckets.length - 1].month) + '</text>'
    tlSvg.innerHTML = svg
    tlMeta.textContent = buckets.length + ' ' + ('weekOf' in buckets[0] ? 'weeks' : 'months') + ' · peak ' + max
  }

  function renderRhythm(elId, counts, maxLabels) {
    const el = $("#" + elId)
    const max = Math.max(1, ...counts)
    el.innerHTML = ""
    for (let i = 0; i < counts.length; i++) {
      const bar = document.createElement("i")
      const pct = (counts[i] / max) * 100
      bar.style.height = Math.max(2, pct) + "%"
      bar.style.opacity = (0.35 + 0.65 * (counts[i] / max)).toFixed(2)
      bar.title = (maxLabels ? maxLabels[i] : i) + " — " + counts[i]
      el.appendChild(bar)
    }
  }
  renderRhythm("hour-bars", DATA.hourCounts || new Array(24).fill(0))
  const dowLabels = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]
  renderRhythm("dow-bars", DATA.dowCounts || new Array(7).fill(0), dowLabels)

  const topicChips = $("#topic-chips")
  const topics = (DATA.topicClusters || []).slice(0, 12)
  if (!topics.length) {
    topicChips.innerHTML = '<p class="empty">No topic clusters surfaced from this sample.</p>'
  } else {
    const allChip = mkChip("All topics", "", topics.reduce((s, t) => s + t.count, 0), true)
    allChip.dataset.topic = ""
    topicChips.appendChild(allChip)
    for (const t of topics) {
      const c = mkChip(t.name, t.name, t.count)
      c.dataset.topic = t.name
      topicChips.appendChild(c)
    }
    topicChips.addEventListener("click", e => {
      const chip = e.target.closest(".chip"); if (!chip) return
      const v = chip.dataset.topic || ""
      state.topic = v || null
      $$(".chip", topicChips).forEach(c => c.classList.toggle("active", (c.dataset.topic || "") === v))
      renderConvoList()
    })
  }

  const reusablePanel = $("#reusable-panel")
  const reusablePrompts = (DATA.reusablePrompts || []).slice(0, 8)
  if (!reusablePrompts.length) {
    reusablePanel.innerHTML = '<p class="empty">No prompts shared distinctive keywords across conversations — needs more data to surface a pattern.</p>'
  } else {
    for (const p of reusablePrompts) {
      const card = document.createElement("div")
      card.className = "heur-card"
      const conv = convoById.get(p.conversationId)
      card.innerHTML =
        '<div class="meta-row"><span>' + escapeHtml(conv ? conv.title : p.conversationId) + '</span>' +
          '<span>' + escapeHtml(p.ts || "") + '</span></div>' +
        '<div class="body">' + escapeHtml(p.text) + '</div>' +
        '<div class="meta-row" style="margin-top:var(--space-xs)">' +
          '<span>shared: ' + (p.sharedKeywords || []).slice(0,5).map(escapeHtml).join(" • ") + '</span></div>' +
        '<div class="actions"><button class="copy-btn" data-action="copy-prompt">copy prompt</button>' +
          '<button class="jump-btn" data-jump="' + escapeAttr(p.conversationId) + '">jump to conversation</button></div>'
      card.querySelector(".copy-btn").addEventListener("click", () => navigator.clipboard?.writeText(p.text))
      card.querySelector(".jump-btn").addEventListener("click", () => jumpTo(p.conversationId))
      reusablePanel.appendChild(card)
    }
  }

  const importantPanel = $("#important-panel")
  const importantAnswers = (DATA.importantAnswers || []).slice(0, 8)
  if (!importantAnswers.length) {
    importantPanel.innerHTML = '<p class="empty">No assistant reply long enough to surface as a candidate.</p>'
  } else {
    for (const a of importantAnswers) {
      const card = document.createElement("div")
      card.className = "heur-card important"
      const conv = convoById.get(a.conversationId)
      card.innerHTML =
        '<div class="meta-row"><span>' + escapeHtml(conv ? conv.title : a.conversationId) + '</span>' +
          '<span>' + a.charCount + ' chars · ' + escapeHtml(a.ts || "") + '</span></div>' +
        '<div class="body">' + escapeHtml(a.preview) + '</div>' +
        '<div class="actions"><span class="muted" style="font-size:11.5px">heuristic — review before reusing</span>' +
          '<button class="jump-btn" data-jump="' + escapeAttr(a.conversationId) + '">jump to conversation</button></div>'
      card.querySelector(".jump-btn").addEventListener("click", () => jumpTo(a.conversationId))
      importantPanel.appendChild(card)
    }
  }

  const unresolvedList = $("#unresolved-list")
  const unresolved = (DATA.unresolvedThreads || []).slice(0, 12)
  if (!unresolved.length) {
    unresolvedList.innerHTML = '<p class="empty">No threads look unresolved — every conversation ends with an assistant reply.</p>'
  } else {
    for (const u of unresolved) {
      const el = document.createElement("div")
      el.className = "callout"
      el.innerHTML =
        '<div class="ttl">' + escapeHtml(u.title) + '</div>' +
        '<div class="meta">' + escapeHtml(u.lastTs || "—") + (u.gapDays != null ? ' · ' + u.gapDays + 'd ago' : '') + '</div>' +
        '<div class="last">' + escapeHtml(u.lastUserText) + '</div>' +
        '<div class="why">' + escapeHtml(u.reason) + '</div>'
      el.addEventListener("click", () => jumpTo(u.id))
      unresolvedList.appendChild(el)
    }
  }

  const kindChips = $("#kind-chips")
  const allKinds = mkChip("All kinds", "", conversations.length, true)
  allKinds.dataset.kind = ""
  kindChips.appendChild(allKinds)
  for (const k of (DATA.kindBreakdown || [])) {
    const c = mkChip(k.kind, k.kind, k.count)
    c.dataset.kind = k.kind
    kindChips.appendChild(c)
  }
  kindChips.addEventListener("click", e => {
    const chip = e.target.closest(".chip"); if (!chip) return
    const v = chip.dataset.kind || ""
    state.kind = v || null
    $$(".chip", kindChips).forEach(c => c.classList.toggle("active", (c.dataset.kind || "") === v))
    renderConvoList()
  })

  $("#search").addEventListener("input", e => {
    state.search = e.target.value.trim().toLowerCase()
    renderConvoList()
  })

  function matchesFilters(c) {
    if (state.kind && c.kind !== state.kind) return false
    if (state.topic) {
      const t = (DATA.topicClusters || []).find(t => t.name === state.topic)
      if (!t || !t.conversationIds.includes(c.id)) return false
    }
    if (state.search) {
      const hay = (c.title + " " + c.firstUserPrompt + " " + c.firstAssistantReply + " " +
        c.messages.map(m => m.text).join(" ")).toLowerCase()
      if (!hay.includes(state.search)) return false
    }
    return true
  }

  const convoListEl = $("#convo-list")
  const indexMeta = $("#index-meta")
  const filterSummary = $("#filter-summary")

  function renderConvoList() {
    convoListEl.innerHTML = ""
    let shown = 0
    for (const c of conversations) {
      if (!matchesFilters(c)) continue
      shown++
      convoListEl.appendChild(renderConvo(c))
    }
    indexMeta.textContent = shown + " / " + conversations.length + " shown"
    const parts = []
    if (state.kind) parts.push("kind=" + state.kind)
    if (state.topic) parts.push("topic=" + state.topic)
    if (state.search) parts.push('search="' + state.search + '"')
    filterSummary.textContent = parts.length ? parts.join(" · ") : ""
    if (!shown) {
      const e = document.createElement("p")
      e.className = "empty"
      e.textContent = "No conversations match the current filters."
      convoListEl.appendChild(e)
    }
  }

  function renderConvo(c) {
    const el = document.createElement("article")
    el.className = "convo"
    el.id = "convo-" + c.id
    if (state.openIds.has(c.id)) el.classList.add("open")
    const dateStr = c.createdIso || ""
    const modelChips = (c.models || []).slice(0, 3).map(m => '<span class="badge model">' + escapeHtml(m) + '</span>').join("")
    el.innerHTML =
      '<div class="head">' +
        '<div><div class="ttl">' + escapeHtml(c.title) + '</div>' +
          '<div class="badges">' +
            '<span class="badge kind">' + escapeHtml(c.kind) + '</span>' +
            (c.hasCode ? '<span class="badge code">code</span>' : '') +
            (c.isUnresolved ? '<span class="badge unresolved">unresolved</span>' : '') +
            modelChips +
            '<span class="badge">' + c.messageCount + ' msg · ' + c.wordCount + ' words</span>' +
          '</div></div>' +
        '<div class="when">' + escapeHtml(dateStr) + '</div>' +
      '</div>' +
      '<div class="preview">' +
        '<div class="row"><div class="role">First user prompt</div><div class="text">' + highlight(c.firstUserPrompt) + '</div></div>' +
        '<div class="row"><div class="role">First assistant reply</div><div class="text">' + highlight(c.firstAssistantReply) + '</div></div>' +
      '</div>' +
      '<div class="toolbar">' +
        '<button data-action="toggle">' + (state.openIds.has(c.id) ? 'Hide' : 'Show all') + ' ' + c.messageCount + ' messages</button>' +
        '<button data-action="copy-md">Copy as Markdown</button>' +
      '</div>' +
      '<div class="thread">' + (state.openIds.has(c.id) ? renderThread(c) : "") + '</div>'
    el.querySelector('button[data-action="toggle"]').addEventListener("click", () => {
      const open = state.openIds.has(c.id)
      if (open) state.openIds.delete(c.id); else state.openIds.add(c.id)
      const newEl = renderConvo(c)
      el.replaceWith(newEl)
    })
    el.querySelector('button[data-action="copy-md"]').addEventListener("click", () => {
      navigator.clipboard?.writeText(conversationToMarkdown(c))
    })
    return el
  }

  function renderThread(c) {
    const byDay = new Map()
    for (const m of c.messages) {
      const day = m.ts ? m.ts.slice(0, 10) : "(undated)"
      const arr = byDay.get(day) || []
      arr.push(m)
      byDay.set(day, arr)
    }
    let html = ""
    for (const [day, msgs] of byDay.entries()) {
      html += '<div class="day-bucket"><div class="day">' + escapeHtml(day) + '</div>'
      for (const m of msgs) {
        html += '<div class="bubble ' + escapeAttr(m.role) + '">' +
          '<div class="role-line"><span>' + escapeHtml(m.role) + (m.model ? ' · ' + escapeHtml(m.model) : '') + '</span>' +
            '<span>' + escapeHtml(m.ts || "") + '</span></div>' +
          renderMessageBody(m.text) +
        '</div>'
      }
      html += '</div>'
    }
    return html
  }

  function renderMessageBody(text) {
    // Lightweight code-fence rendering. No syntax highlighting library.
    const FENCE = String.fromCharCode(96, 96, 96)
    const fenceRe = new RegExp("(" + FENCE + "[\\s\\S]*?" + FENCE + ")", "g")
    const parts = String(text || "").split(fenceRe)
    let out = ""
    for (const p of parts) {
      if (p.startsWith(FENCE) && p.endsWith(FENCE)) {
        const inner = p.slice(3, -3).replace(/^[a-z0-9_-]+\n/i, "")
        out += '<pre><code>' + escapeHtml(inner) + '</code></pre>'
      } else {
        out += highlight(p)
      }
    }
    return out
  }

  function highlight(text) {
    const s = escapeHtml(String(text || ""))
    if (!state.search) return s
    try {
      const re = new RegExp("(" + escapeRegExp(state.search) + ")", "gi")
      return s.replace(re, '<span class="search-hit">$1</span>')
    } catch { return s }
  }

  function jumpTo(id) {
    state.openIds.add(id)
    renderConvoList()
    const el = document.getElementById("convo-" + id)
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  $("button[data-action='copy-summary']").addEventListener("click", () => {
    const md = summaryToMarkdown()
    navigator.clipboard?.writeText(md)
  })
  $("button[data-action='expand-all']").addEventListener("click", () => {
    for (const c of conversations) state.openIds.add(c.id)
    renderConvoList()
  })
  $("button[data-action='collapse-all']").addEventListener("click", () => {
    state.openIds.clear()
    renderConvoList()
  })

  function summaryToMarkdown() {
    const lines = []
    lines.push("# " + (document.title || "AI chat export"))
    lines.push("")
    lines.push("- **Conversations**: " + DATA.totals.conversations)
    lines.push("- **Messages**: " + DATA.totals.messages + " (" + DATA.totals.userMessages + " from you, " + DATA.totals.assistantMessages + " from AI)")
    lines.push("- **Active range**: " + DATA.activeRange)
    lines.push("- **Code blocks**: " + DATA.totals.codeBlocks)
    if ((DATA.topModels || []).length) lines.push("- **Models**: " + DATA.topModels.join(", "))
    lines.push("")
    lines.push("## Topics")
    for (const t of (DATA.topicClusters || []).slice(0, 8)) lines.push("- " + t.name + " (" + t.count + ")")
    lines.push("")
    lines.push("## Unresolved")
    for (const u of (DATA.unresolvedThreads || []).slice(0, 8)) lines.push("- " + u.title + (u.lastTs ? " (" + u.lastTs + ")" : ""))
    return lines.join("\n")
  }

  function conversationToMarkdown(c) {
    const lines = []
    lines.push("# " + c.title)
    if (c.createdIso) lines.push("Date: " + c.createdIso)
    lines.push("")
    for (const m of c.messages) {
      const role = m.role.charAt(0).toUpperCase() + m.role.slice(1)
      lines.push(role + ":" + (m.model ? " (" + m.model + ")" : ""))
      lines.push(m.text)
      lines.push("")
    }
    return lines.join("\n")
  }

  function mkChip(label, value, count, active) {
    const c = document.createElement("button")
    c.className = "chip" + (active ? " active" : "")
    c.innerHTML = escapeHtml(label) + ' <span class="count">' + count + '</span>'
    return c
  }
  function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])) }
  function escapeAttr(s) { return escapeHtml(s) }
  function escapeRegExp(s) { return s.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&") }

  renderConvoList()
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
    console.error("usage: render_ai_chat_export_fallback.mjs INPUT --out OUT [--title T] [--editorial E]")
    process.exit(2)
  }
  const filepath = path.resolve(input)
  const parser = await pickParser(filepath)
  if (!parser) throw new Error(`no parser for ${input}`)
  const parsed = await parser.parse(filepath)
  const t = title || parsed.meta.sourceFile
  const platform = parsed.data.platform || "AI chat export"
  const ed = editorial || parsed.summary
  const json = JSON.stringify(parsed.data).replace(/<\/script/gi, "<\\/script")
  const html = TEMPLATE
    .replace(/__TITLE__/g, escapeHtml(t))
    .replace(/__PLATFORM__/g, escapeHtml(platform))
    .replace(/__ACTIVE_RANGE__/g, escapeHtml(parsed.data.activeRange || ""))
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
