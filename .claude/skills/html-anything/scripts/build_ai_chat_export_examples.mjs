#!/usr/bin/env node
/**
 * Builds the synthetic AI chat-export examples for the html-anything
 * pack. Output files (committed):
 *
 *   examples/chatgpt-export/input.json   OpenAI-style conversations.json
 *                                         (mapping graph per conversation)
 *   examples/ai-chat-log/input.md        plain-text "User: / Assistant:"
 *                                         transcript with several threads
 *
 * All data is synthetic. Names, projects, code snippets, and decisions
 * are invented for the demo. Run from the repo root:
 *
 *   node scripts/build_ai_chat_export_examples.mjs
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")

function dateToEpoch(iso) { return Math.floor(new Date(iso).getTime() / 1000) }

let nextUuidCounter = 0
function uuid(prefix = "n") {
  nextUuidCounter++
  return `${prefix}-${String(nextUuidCounter).padStart(6, "0")}-fake`
}

// ---------------------------------------------------------------------------
// 1. ChatGPT export — 15 synthetic conversations across 3 months
// ---------------------------------------------------------------------------

const conversations = [
  {
    title: "Tax classification logic for 1099 contractors",
    startedAt: "2026-02-04T15:14:00Z",
    model: "gpt-4o",
    turns: [
      ["user", "I'm building a payroll tool for a small agency. How should I model 1099 vs W-2 classification in the database? I want to make sure the logic is auditable later."],
      ["assistant", "For a small payroll tool, model classification as a first-class field on the worker record, not derived from anything else. A reasonable schema:\n\n```sql\ncreate table workers (\n  id uuid primary key,\n  legal_name text not null,\n  classification text not null check (classification in ('w2','1099')),\n  classified_at timestamptz not null default now(),\n  classified_by_user_id uuid references users(id),\n  classification_reason text\n);\n```\n\nThree reasons to keep it explicit:\n\n1. **Auditability** — the IRS standard is a multi-factor test (behavioral, financial, type of relationship). You don't want to re-derive that on every payroll run.\n2. **Reclassification is a known event** — track it. When you flip a worker from 1099 to W-2 (or vice versa), insert a new row in a `worker_classification_history` table with the prior classification, the new one, and an effective date.\n3. **Tax forms diverge** — 1099-NEC and W-2 generation paths look different from this field down. Branching at the data layer keeps the rest of the app cleaner.", 1],
      ["user", "Got it. Should the history table use temporal columns or an append-only log shape?"],
      ["assistant", "Append-only log shape, with the current classification denormalized onto `workers` for fast lookups. Temporal columns (`valid_from`, `valid_to`) get awkward when you need to fix a misclassification retroactively without rewriting history.\n\n```sql\ncreate table worker_classification_history (\n  id uuid primary key,\n  worker_id uuid not null references workers(id),\n  prior_classification text,\n  new_classification text not null,\n  effective_date date not null,\n  recorded_at timestamptz not null default now(),\n  recorded_by_user_id uuid references users(id),\n  reason text\n);\n```\n\nWhen you need point-in-time classification, query the history with `effective_date <= :asof` ordered desc, take the first row. Slightly more SQL but fixable mistakes don't corrupt the audit trail.", 4],
      ["user", "Makes sense. Last thing: any gotchas with how Stripe Tax handles 1099-NEC reporting?"],
      ["assistant", "Two things worth pinning down before you wire it up:\n\n1. Stripe Tax does not file 1099-NEC for you — it surfaces totals you can hand to a filing service (Track1099, Tax1099, etc.). Plan to export annual totals per contractor to CSV.\n2. The filing threshold is $600/year per contractor as of the 2026 tax year. Track lifetime payments per worker so you don't accidentally miss a contractor who crossed the threshold across multiple short engagements.\n\nFor the actual filing, look at the Track1099 API — they accept a JSON manifest of payees + totals and handle the 1099-NEC submission to the IRS plus copies to the worker.", 6],
    ],
  },
  {
    title: "1099 contractor invoicing — should I prorate the threshold?",
    startedAt: "2026-02-09T11:42:00Z",
    model: "gpt-4o",
    turns: [
      ["user", "Following up on the contractor classification thing. If a 1099 contractor crosses the $600 threshold mid-year, do I need to retroactively change anything about how I issued earlier invoices?"],
      ["assistant", "No retroactive change to invoices. The $600 threshold is for whether you need to *file* a 1099-NEC for that contractor at year-end, not for how you process payments. Keep issuing invoices the same way; just make sure your year-end report aggregates total paid per contractor and flags anyone who crossed $600 for filing."],
      ["user", "What about state filing — same threshold?"],
      ["assistant", "State thresholds vary. Some states (like Massachusetts) require 1099-NEC filings even below the federal $600 if total payments are over $0 to a state resident. California has its own DE 542 form for independent contractor reporting separate from 1099-NEC.\n\nIf you're going to operate in multiple states, the practical move is to pick a 1099 filing service (Track1099, Tax1099, Tax Bandits) that handles state filings as part of the federal package. They keep the threshold table updated; you don't want to rebuild that yourself.", 2],
      ["user", "How do you actually trigger filing through Track1099 — is it API-driven?"],
    ],
  },
  {
    title: "Refactoring auth middleware — drop session-token storage",
    startedAt: "2026-02-12T09:08:00Z",
    model: "gpt-4o",
    turns: [
      ["user", "I have an Express auth middleware that stores session tokens in a Postgres table and validates each request against it. Legal flagged this for compliance. They want stateless JWTs instead. Here's the current shape:\n\n```js\nasync function authMiddleware(req, res, next) {\n  const token = req.headers.authorization?.replace('Bearer ', '');\n  if (!token) return res.status(401).end();\n  const session = await db.query('select * from sessions where token = $1 and expires_at > now()', [token]);\n  if (!session.rows.length) return res.status(401).end();\n  req.user = await db.query('select * from users where id = $1', [session.rows[0].user_id]);\n  next();\n}\n```\n\nHow should I rewrite this?"],
      ["assistant", "Replace it with a JWT verifier and drop the sessions table entirely. The compliance issue is the at-rest storage of session tokens; if you sign a short-lived JWT and keep nothing server-side, there's nothing to leak.\n\n```js\nimport jwt from 'jsonwebtoken';\n\nconst JWT_SECRET = process.env.JWT_SECRET; // 256-bit, in your secret manager\nconst JWT_ISSUER = 'your-app';\n\nasync function authMiddleware(req, res, next) {\n  const token = req.headers.authorization?.replace('Bearer ', '');\n  if (!token) return res.status(401).end();\n  try {\n    const decoded = jwt.verify(token, JWT_SECRET, {\n      issuer: JWT_ISSUER,\n      algorithms: ['HS256'],\n    });\n    req.user = { id: decoded.sub, email: decoded.email, roles: decoded.roles };\n    next();\n  } catch (err) {\n    return res.status(401).end();\n  }\n}\n```\n\nTwo things you'll need to handle separately:\n\n1. **Logout / revocation.** Stateless JWTs can't be revoked mid-flight. Either (a) keep tokens short (5–15 min) and use refresh tokens, or (b) maintain a small revocation list in Redis keyed by JWT ID. Option (a) is simpler unless you have hard \"log them out NOW\" requirements.\n2. **Refresh tokens.** These DO need server storage, but they're long-lived and only used to mint new access tokens — so the surface area is much smaller than full session storage.", 2],
      ["user", "What if I want to support 'log out everywhere' — kill all my own sessions?"],
      ["assistant", "Track a per-user `token_version` integer in the users table, embed it in every JWT as a custom claim, and verify it on each request:\n\n```js\nconst decoded = jwt.verify(token, JWT_SECRET, { ... });\nconst user = await db.query('select token_version from users where id = $1', [decoded.sub]);\nif (user.rows[0].token_version !== decoded.token_version) {\n  return res.status(401).end();\n}\n```\n\nTo \"log out everywhere\", `update users set token_version = token_version + 1 where id = $1`. Every existing JWT for that user instantly fails verification on the next request. You're back to one DB lookup per request, but it's a single-row index hit on the users table — much cheaper than the sessions-table validation you had before, and no tokens at rest.", 4],
      ["user", "Can I use RS256 instead of HS256 so I can verify in other services without sharing the secret?"],
      ["assistant", "Yes — RS256 is the right call once you have more than one service. Generate an RSA key pair, sign with the private key in the auth service, hand out the public key (or a JWKS endpoint) to every other service.\n\n```js\n// Auth service — sign\nconst token = jwt.sign(payload, RSA_PRIVATE_KEY, {\n  algorithm: 'RS256',\n  issuer: 'your-app',\n  expiresIn: '15m',\n});\n\n// Any other service — verify\nconst decoded = jwt.verify(token, RSA_PUBLIC_KEY, {\n  algorithms: ['RS256'],\n  issuer: 'your-app',\n});\n```\n\nFor the JWKS endpoint, expose `/.well-known/jwks.json` from the auth service with the public key in JWK format. Other services fetch it on startup (or on demand with a small cache). This gives you key rotation later without redeploying every service — bump the `kid` in the JWT header, add the new key to JWKS, services pick it up.", 3],
    ],
  },
  {
    title: "JWT key rotation — what's the right cadence?",
    startedAt: "2026-02-19T16:33:00Z",
    model: "gpt-4o",
    turns: [
      ["user", "How often should I rotate the JWT signing keys for an internal app — small team, all internal use?"],
      ["assistant", "For a small internal app, **annually is fine** as a baseline, with an immediate rotation if you have any reason to suspect compromise (laptop loss, accidental key commit, departing employee with access).\n\nThe annual-baseline reasoning: the cost of rotation is the operational drag (refresh JWKS endpoint, verify all services pick up the new key, retire the old key after the longest-lived JWT expires). The benefit grows slowly with time. For a small internal app, monthly rotation buys very little real security and adds real ops friction.\n\nThe thing that *does* matter for a small internal app: keep your JWT TTLs short (15 min access tokens, 7-day refresh) so a leaked active token has a small blast radius. That gets you 90% of what frequent key rotation would.", 1],
      ["user", "What's the actual rotation procedure look like — concretely, step by step?"],
      ["assistant", "Concrete sequence assuming RS256 + a JWKS endpoint:\n\n1. Generate a new RSA key pair locally (or in your secret manager).\n2. Add the new public key to your JWKS endpoint with a new `kid`. Old key stays in JWKS for now.\n3. Switch the auth service to sign new JWTs with the new private key. Already-issued JWTs (signed with the old key) keep verifying because the old public key is still in JWKS.\n4. Wait until all old JWTs have expired (= longest-lived refresh token TTL — usually 7 days for an internal app).\n5. Remove the old public key from JWKS. Securely destroy the old private key.\n\nTotal elapsed time: ~7 days. The only ops moment is steps 2 and 3 (which can happen in the same deploy). Steps 4–5 are a calendar reminder, not a deploy.", 4],
    ],
  },
  {
    title: "Pricing copy for the agency tier — make it less corporate",
    startedAt: "2026-02-22T20:11:00Z",
    model: "gpt-4o",
    turns: [
      ["user", "Here's the current pricing-page copy for our \"Agency\" tier. Can you make it sound less like enterprise software and more like it was written by a human?\n\n> Empower your agency with our enterprise-grade Agency tier. Unlock advanced collaboration features, dedicated account management, and SLA-backed uptime guarantees. Scale your client work with confidence."],
      ["assistant", "A version that sounds like a person wrote it:\n\n> **Agency**\\\n> For shops running client work on top of us. You get shared workspaces for your team, a way to keep each client's data separate, and a real human you can call when something breaks. Most agencies on this tier are 5–25 people.\n\nThree things I changed:\n\n- \"Enterprise-grade\" → cut. Nobody buys software because the vendor called itself enterprise-grade.\n- \"Empower / unlock / scale\" → cut. These are filler words; replace with what the tier actually does.\n- \"SLA-backed uptime guarantees\" → \"a real human you can call when something breaks.\" Same thing, said in a way that sounds like you mean it.\n\nIf your team count is wrong, swap that line — I picked 5–25 from your description but adjust as needed.", 1],
      ["user", "Love it. Can you do the same for the 'Solo' tier?"],
      ["assistant", "Sure — give me your current Solo copy and I'll do the same pass.\n\nIf you don't have one yet, here's a starting point in the same voice:\n\n> **Solo**\\\n> For one person doing the work. Everything you need, nothing you don't. The cheapest tier we ship — if it's not enough, the Pro tier is one click away.", 2],
    ],
  },
  {
    title: "Help me draft an apology to a customer about the outage",
    startedAt: "2026-03-02T08:47:00Z",
    model: "gpt-4o",
    turns: [
      ["user", "Customer email coming up — they were down for 3 hours yesterday during a peak sales window. Help me draft an apology that owns it without sounding lawyered up."],
      ["assistant", "Here's a draft. I went short on purpose — long apologies feel like cover.\n\n> Hi [name],\n>\n> Yesterday between 2:14 and 5:30 PM ET, the service was down for you. I know that landed in the middle of your peak sales window, and I'm sorry.\n>\n> Here's what happened: [one-sentence root cause — keep it concrete, e.g. \"a database migration we ran during a window we'd told you was safe took longer than expected and locked writes\"]. We've already changed the migration playbook so the same shape of failure can't happen again. I can walk you through the change if it would help.\n>\n> I want to credit your account for the affected window. We'll back that out automatically on next month's invoice — you don't need to do anything. If you'd rather take it as an account credit you can apply to a future month, just say the word.\n>\n> Happy to hop on a call this week if you want to talk through what we're doing differently.\n>\n> [Your name]\n\nTwo notes:\n\n- I left placeholders for the customer's name and the actual root cause. Fill those in directly — vague RCAs (\"a technical issue affected service\") are worse than no explanation.\n- The credit is offered as the default, not as a question. That signals you take it seriously.", 1],
      ["user", "Should I have someone from eng on the call too?"],
      ["assistant", "Depends on the customer and the relationship. Three rules of thumb:\n\n- If they've never asked for technical detail before and the email seems to land fine, you don't need to bring eng. Adding a third party can make a small thing feel formal.\n- If they ask \"what specifically went wrong\" or \"show me your post-mortem\", bring eng. They want to evaluate whether the fix is real.\n- If they're a technical buyer (CTO, head of eng on the customer side), bring eng by default. Showing the actual person who fixed it builds more trust than a polished slide.\n\nIf you do bring eng, give them 5 minutes of the call max. The customer wants you to own the apology; eng is there to answer specific technical questions if they come up.", 4],
    ],
  },
  {
    title: "What's the difference between Postgres ROW EXCLUSIVE and EXCLUSIVE locks?",
    startedAt: "2026-03-04T14:22:00Z",
    model: "gpt-4-turbo",
    turns: [
      ["user", "Quick one: what's the actual difference between ROW EXCLUSIVE and EXCLUSIVE table locks in Postgres? The docs are confusing."],
      ["assistant", "Despite the name, **ROW EXCLUSIVE doesn't lock rows**. It's a *table-level* lock that says \"I might modify rows in this table.\" It conflicts with locks like SHARE, SHARE ROW EXCLUSIVE, EXCLUSIVE, and ACCESS EXCLUSIVE — but does NOT conflict with other ROW EXCLUSIVE locks. So multiple sessions doing INSERT / UPDATE / DELETE on the same table all coexist fine; they each hold ROW EXCLUSIVE on the table while doing per-row work.\n\n**EXCLUSIVE** is much more restrictive. It conflicts with every lock mode except ACCESS SHARE. So while one transaction holds EXCLUSIVE on a table, no other transaction can read or write it (well, ACCESS SHARE — which SELECT takes — is allowed, so SELECT still works, but anything else blocks).\n\nThe naming is historical and confusing. The mental model that helps:\n\n- **ROW EXCLUSIVE** = \"I'm going to write rows here, in row-by-row fashion. Other writers can do the same.\" (Default lock for INSERT/UPDATE/DELETE.)\n- **EXCLUSIVE** = \"Don't let anyone else write while I'm doing this.\" (Used by REFRESH MATERIALIZED VIEW.)\n- **ACCESS EXCLUSIVE** = \"Don't even read while I'm doing this.\" (Used by ALTER TABLE, DROP, TRUNCATE.)", 1],
    ],
  },
  {
    title: "Migrate a 50M-row table to add a NOT NULL column safely",
    startedAt: "2026-03-09T10:15:00Z",
    model: "gpt-4o",
    turns: [
      ["user", "I need to add a NOT NULL column with a default to a 50M-row Postgres table. Doing it in one ALTER TABLE locks the table for too long. What's the safe pattern?"],
      ["assistant", "Standard 4-step zero-downtime pattern:\n\n1. **Add the column nullable, with a default.** From PG 11+, this is metadata-only — it doesn't rewrite the table.\n   ```sql\n   alter table widgets add column status text default 'active';\n   ```\n2. **Backfill in batches.** New writes already pick up the default. Existing rows have NULL, so backfill them in chunks so you don't lock the table:\n   ```sql\n   update widgets set status = 'active' where status is null and id between 0 and 100000;\n   ```\n3. **Add the NOT NULL constraint as NOT VALID first**, then validate it.\n   ```sql\n   alter table widgets add constraint widgets_status_not_null check (status is not null) not valid;\n   alter table widgets validate constraint widgets_status_not_null;\n   ```\n   \"NOT VALID\" means future inserts/updates respect it but existing rows aren't checked yet. The VALIDATE step then scans without an exclusive lock.\n4. **Replace the constraint with a real NOT NULL.** PG 12+ will use the existing CHECK constraint to validate the NOT NULL conversion in O(1):\n   ```sql\n   alter table widgets alter column status set not null;\n   alter table widgets drop constraint widgets_status_not_null;\n   ```\n\nTotal: zero exclusive locks longer than a millisecond, even on a 50M-row table.", 1],
      ["user", "What if I want the default to be a computed value (based on another column), not a literal?"],
      ["assistant", "Same pattern, but step 1 omits the default and step 2 does the computation. Skip the column-level default because PG can't make it metadata-only when the value depends on another column:\n\n```sql\n-- 1. Add nullable, no default\nalter table widgets add column tier text;\n\n-- 2. Backfill with the computed value, in batches\nupdate widgets set tier = case\n  when revenue > 100000 then 'enterprise'\n  when revenue > 1000 then 'pro'\n  else 'free'\nend where tier is null and id between 0 and 100000;\n```\n\nFor new rows after the migration: either set `tier` explicitly in the INSERT, or add a BEFORE INSERT trigger that computes it. A trigger is usually cleaner since it keeps the logic in one place and you don't have to remember it in every callsite.", 5],
    ],
  },
  {
    title: "Brainstorm names for the new offline-mode feature",
    startedAt: "2026-03-15T19:04:00Z",
    model: "gpt-4o",
    turns: [
      ["user", "I'm shipping an offline mode for the app. Internal name was 'offline mode' but that feels boring. Brainstorm 8 options that are short, memorable, and don't sound like jargon."],
      ["assistant", "Here are 8 options grouped by tone:\n\n**Plain & short** (the safe direction):\n1. **Offline** — sometimes the literal word IS the best name.\n2. **Local mode** — describes what it actually does (data lives locally).\n3. **Standalone** — emphasizes self-sufficiency.\n\n**Slightly more flavor**:\n4. **Detached** — slightly nautical / Git-y; works if your audience leans technical.\n5. **Solo mode** — friendly, suggests one-person use.\n6. **Quiet mode** — leans into the \"no network\" framing as a feature, not a limitation.\n\n**Going for memorable**:\n7. **Plane mode** — borrows the established phone term, immediately understood.\n8. **Lighthouse** — works alone, even when everyone else has gone home. Pretty.\n\nIf you want one pick: **Plane mode** if the audience is general consumer (everyone knows it). **Local mode** if technical (no ambiguity).", 1],
      ["user", "I like Plane mode. Will it confuse people who don't fly?"],
    ],
  },
  {
    title: "What's the actual cost of dropping 'enterprise' messaging?",
    startedAt: "2026-03-21T13:51:00Z",
    model: "gpt-4o",
    turns: [
      ["user", "Quick gut-check. We've been positioning ourselves as 'enterprise-grade' on the marketing site. I want to drop that language. Will real enterprise buyers be put off?"],
      ["assistant", "Real enterprise buyers don't read your marketing copy to decide whether you're enterprise-grade. They read it to decide whether to take a meeting. Then they evaluate you on:\n\n- Whether you can answer their security review questionnaire\n- Whether you have a SOC 2 / ISO report\n- Whether they can talk to a reference customer of similar size\n- Whether your contract terms are negotiable\n- Whether someone will pick up the phone when something breaks\n\nYour website saying \"enterprise-grade\" affects approximately none of that. Dropping the word is more likely to *help* — startups that say \"enterprise-grade\" tend to underwhelm on the actual evaluation criteria, so the phrase has lost signal. Real enterprise buyers expect SOC 2, references, and uptime guarantees as table stakes; calling that out as \"enterprise-grade\" reads as overcompensating.\n\nWhat I'd put on the site instead: a one-page security overview with concrete bullets (SOC 2 report available under NDA, deployed in N regions, X% uptime over the last 12 months, customer logos at scale Y). That does the same job and reads as confident, not aspirational.", 2],
    ],
  },
  {
    title: "Recipe brainstorm — what to make with miso paste and salmon?",
    startedAt: "2026-03-26T18:30:00Z",
    model: "gpt-4o",
    turns: [
      ["user", "I have miso paste and a salmon fillet. What can I make in under 30 minutes?"],
      ["assistant", "Miso-glazed salmon, 25 minutes total:\n\n**You'll need**: 2 tbsp white miso, 1 tbsp mirin (or honey + a splash of rice vinegar), 1 tbsp soy sauce, 1 tsp sesame oil, optionally 1 tbsp sake.\n\n1. Whisk the miso, mirin, soy, and sesame together. Spread half on the salmon, both sides. Let it sit 10 min while the oven preheats to 400°F.\n2. Bake on parchment for 8–12 min depending on thickness — you want the center just opaque.\n3. Brush the rest of the glaze on for the last 2 min. Optionally finish under the broiler for 60 seconds for a caramelized top.\n\nServe with rice and a quick cucumber side (sliced cucumber + rice vinegar + a pinch of sugar + sesame seeds). Total active time: maybe 7 minutes."],
      ["user", "What if I don't have mirin?"],
      ["assistant", "Honey + rice vinegar (2:1) is the closest substitute. Or sake + a tiny pinch of sugar. Or just leave it out — the miso carries enough sweetness on its own that it's still good, just less glossy."],
    ],
  },
  {
    title: "How do I think about the cost of a free tier?",
    startedAt: "2026-04-02T22:14:00Z",
    model: "claude-sonnet-4-6",
    turns: [
      ["user", "I'm thinking about adding a free tier to the product. How do I figure out whether it'll actually pay for itself?"],
      ["assistant", "The right framing is \"what fraction of free users do I need to convert to paid for the free tier to be net positive on a 12-month basis?\"\n\nThree numbers you need:\n1. **Per-free-user infrastructure cost / month.** Compute, storage, bandwidth, support tickets — all the variable costs you'd not have if the user weren't there.\n2. **LTV of a paid user.** Average monthly revenue × expected months retained, minus per-paid-user variable costs.\n3. **Conversion rate target.** This is the unknown — what fraction of free users need to convert for the math to work.\n\nThe arithmetic: required conversion rate = (per-free-user cost × months on free × 12) / (LTV × 12). For a typical SaaS where per-free cost is ~$0.50/mo and LTV is ~$1,200, you need roughly 0.5–1% conversion to break even. If your conversion rate is below that, the free tier is a marketing expense, not a self-sustaining channel.\n\nThe thing that often gets missed: **free users have a non-trivial support cost**. If you have a team of 3 supporting 100 paid customers, adding 5,000 free users without adding support headcount means everyone's support quality drops. The right answer might be a free tier WITHOUT human support (community forum only), so the per-free-user cost stays close to pure infrastructure.", 2],
      ["user", "What's a reasonable conversion rate to assume if I'm just modeling this for the first time?"],
      ["assistant", "For a B2B SaaS targeting small businesses, **2–5% is a typical range** for free → paid over the first 12 months. Consumer prosumer tools often see 1–3%. Pure consumer apps (where the alternative is ad-supported) can be much lower, 0.5% or less.\n\nIf you're new to this and want a single conservative number to model with, use **2%**. That's at the low end of B2B and gives you a margin of safety. If you target it and exceed it, the free tier is a winner. If you target it and miss by a wide margin, you'll know early and can rip it out.\n\nA few things that move the rate up:\n- Strong \"wall\" — you hit a hard limit that's painful to work around (storage cap, seat cap, feature gate on something users actually need).\n- In-product nudges — the upgrade prompt is contextual (\"you've used 80% of your free quota this week\"), not a banner ad.\n- Time-limited free trial of paid features inside the free tier — gets users used to the paid experience before asking them to pay.\n\nWhat moves it down: a free tier that's \"good enough forever\". If users can run a real business on the free tier, most won't upgrade.", 5],
    ],
  },
  {
    title: "Untitled",
    startedAt: "2026-04-08T07:23:00Z",
    model: "gpt-4o",
    turns: [
      ["user", "what's a good way to learn french fast"],
      ["assistant", "\"Fast\" is doing a lot of work in that sentence — let me ask back: are you optimizing for **speaking confidently in 3 months** (different game than reading), **passing a placement test**, or **being functional on a trip in 6 weeks**? The answer changes pretty radically.\n\nGeneric best practices regardless of goal:\n\n1. **Daily contact, even 15 min**, beats weekly long sessions. Spaced repetition works; cramming doesn't.\n2. **Comprehensible input** — listen to material slightly above your level. Podcasts like *Coffee Break French* or *InnerFrench* hit this for early learners.\n3. **Speak from week one** — even badly. Italki / Preply tutors are cheap ($15–25/hour for non-native French speakers).\n4. **Pick a single spaced-repetition app and stick with it** — Anki if you want full control, Drops or Memrise if you want it pre-built. Don't bounce between three.\n\nIf you tell me which goal you're optimizing for I can sketch a more concrete 8-week plan.", 1],
      ["user", "speaking, for a trip in september"],
    ],
  },
  {
    title: "Why is my React component re-rendering on every keystroke?",
    startedAt: "2026-04-14T11:59:00Z",
    model: "gpt-4o",
    turns: [
      ["user", "My SearchInput component is re-rendering on every keystroke even when the prop hasn't changed. Wrapped it in React.memo, didn't help. Here's the parent:\n\n```jsx\nfunction SearchPage() {\n  const [query, setQuery] = useState('');\n  const filterFn = (item) => item.name.includes(query);\n  return (\n    <div>\n      <SearchInput onChange={setQuery} />\n      <ResultsList filter={filterFn} />\n    </div>\n  );\n}\n```\n\nThe issue is that ResultsList re-renders every keystroke too, which is slow. What am I missing?"],
      ["assistant", "Two related issues here, both of which break memoization:\n\n**1. `filterFn` is a new function on every render.** Even if you wrap `ResultsList` in `React.memo`, the prop comparison sees `prevProps.filter !== nextProps.filter` (different function instance), so it re-renders anyway.\n\nFix with `useCallback`:\n\n```jsx\nconst filterFn = useCallback((item) => item.name.includes(query), [query]);\n```\n\nBut notice — `filterFn` STILL changes on every keystroke because `query` is in the dependency array. That's not actually wrong (the filter function genuinely depends on query), but it means `ResultsList` will still re-render on every keystroke, which is what you wanted to avoid.\n\n**2. The real fix: lift the filtering logic out of the prop.**\n\n```jsx\nfunction SearchPage() {\n  const [query, setQuery] = useState('');\n  return (\n    <div>\n      <SearchInput onChange={setQuery} />\n      <ResultsList query={query} />\n    </div>\n  );\n}\n\nconst ResultsList = React.memo(function ResultsList({ query }) {\n  const filtered = useMemo(\n    () => allItems.filter(item => item.name.includes(query)),\n    [query]\n  );\n  return <ul>{filtered.map(it => <li key={it.id}>{it.name}</li>)}</ul>;\n});\n```\n\nNow `ResultsList` re-renders only when `query` (a string) changes — which is unavoidable, since the user is literally changing the search.\n\nIf you want to avoid re-rendering on every keystroke, **debounce the query** before passing it down:\n\n```jsx\nconst debouncedQuery = useDebounce(query, 200);\nreturn <ResultsList query={debouncedQuery} />;\n```\n\nNow `ResultsList` only re-renders 200ms after the user stops typing. The visible input stays responsive (driven by `query`), but the expensive list filtering uses `debouncedQuery`.", 1],
      ["user", "Where would I implement useDebounce — is that built in?"],
      ["assistant", "Not built in — write it yourself, it's 10 lines:\n\n```jsx\nimport { useEffect, useState } from 'react';\n\nexport function useDebounce(value, delay = 200) {\n  const [debounced, setDebounced] = useState(value);\n  useEffect(() => {\n    const t = setTimeout(() => setDebounced(value), delay);\n    return () => clearTimeout(t);\n  }, [value, delay]);\n  return debounced;\n}\n```\n\nOr use `use-debounce` from npm if you'd rather not own it.", 3],
    ],
  },
  {
    title: "Q2 OKR draft — which framing lands better?",
    startedAt: "2026-04-22T15:40:00Z",
    model: "claude-sonnet-4-6",
    turns: [
      ["user", "Drafting Q2 OKRs for the eng team. Two framings I'm torn between:\n\nA) **Outcome-led**: \"Reduce customer-reported bugs by 40% quarter-over-quarter.\"\nB) **Behavior-led**: \"Establish a weekly bug-bash ritual. Run 12 by end of quarter.\"\n\nWhich lands better with a team of 6 mid-to-senior engineers?"],
      ["assistant", "For a team of 6 mid-to-senior engineers, **A (outcome-led)** lands better — but the failure mode is real and worth naming.\n\nWhy outcome-led wins for senior engineers: they don't need you to tell them HOW to reduce bugs. Bug bashes are one tactic among many — they might also want to invest in better integration tests, fix CI flakiness, or rewrite the part of the codebase that generates 60% of the bugs. Locking the team into \"12 bug bashes\" closes off the better tactical choices they'd make on their own.\n\nWhy outcome-led can fail: \"reduce reported bugs by 40%\" can be hit by **changing how bugs get reported**, not by reducing actual bugs. If your team starts triaging more aggressively in support and closing things as \"won't fix\" or \"by design\", the metric goes down without the underlying quality going up. Goodhart's law — the metric becomes the target.\n\nWhat I'd do:\n\n1. Use A as the OKR.\n2. Add a guardrail metric on the side: \"while keeping support ticket count flat or growing.\" This blocks the gaming pattern.\n3. In the kickoff conversation, explicitly say: *I'm not telling you how to do this. I'd love to see what the team comes up with — bug bashes are one option, but they're not the only one.*\n\nThen you let the team take the agency that comes with being mid-to-senior.", 2],
      ["user", "What's a reasonable target if I have no baseline data on bug counts?"],
      ["assistant", "Don't pick a number for the first quarter — instead, pick a **measurement-and-baseline goal**:\n\n> \"Establish baseline metrics for customer-reported bugs (count, severity distribution, mean time to resolution). Publish a quarterly report by end of Q2.\"\n\nThen in Q3 you have data and can set a real reduction target. Picking 40% out of thin air invites a few outcomes, none good:\n\n- You hit 40% by accident (didn't actually do anything different) — the OKR rewards luck.\n- You miss it by a wide margin and the team feels punished for an arbitrary number.\n- You set the target at 40% and the team optimizes for the metric, not the actual goal (see the guardrail discussion above).\n\nThe \"establish baseline\" OKR sounds boring but it's the right move when you don't have data. It also gives you a credible number to aim for next quarter that's defensible to the team.", 4],
    ],
  },
]

function buildChatGptConversation(spec) {
  let cur = dateToEpoch(spec.startedAt)
  const mapping = {}
  const rootId = uuid("root")
  mapping[rootId] = { id: rootId, message: null, parent: null, children: [] }
  let prevId = rootId
  let lastMsgId = null

  // Optional system seed (ChatGPT exports often have one).
  const sysId = uuid("sys")
  mapping[sysId] = {
    id: sysId,
    message: {
      id: sysId,
      author: { role: "system", name: null, metadata: {} },
      create_time: cur,
      update_time: null,
      content: { content_type: "text", parts: [""] },
      status: "finished_successfully",
      end_turn: true,
      weight: 0,
      metadata: { is_visually_hidden_from_conversation: true },
      recipient: "all",
      channel: null,
    },
    parent: rootId,
    children: [],
  }
  mapping[rootId].children.push(sysId)
  prevId = sysId

  for (const [roleRaw, text, gapMin] of spec.turns) {
    const dt = (gapMin || 1) * 60
    cur += dt
    const id = uuid(roleRaw === "user" ? "msg-u" : "msg-a")
    lastMsgId = id
    mapping[id] = {
      id,
      message: {
        id,
        author: { role: roleRaw, name: null, metadata: {} },
        create_time: cur,
        update_time: null,
        content: { content_type: "text", parts: [text] },
        status: "finished_successfully",
        end_turn: true,
        weight: 1,
        metadata: roleRaw === "assistant"
          ? { model_slug: spec.model, default_model_slug: spec.model }
          : {},
        recipient: "all",
        channel: null,
      },
      parent: prevId,
      children: [],
    }
    mapping[prevId].children.push(id)
    prevId = id
  }

  return {
    title: spec.title,
    create_time: dateToEpoch(spec.startedAt),
    update_time: cur,
    mapping,
    moderation_results: [],
    current_node: lastMsgId,
    plugin_ids: null,
    conversation_id: uuid("conv").replace("-fake", ""),
    conversation_template_id: null,
    gizmo_id: null,
    is_archived: false,
    safe_urls: [],
    default_model_slug: spec.model,
    conversation_origin: null,
  }
}

const chatGptExport = conversations.map(buildChatGptConversation)
const chatGptOut = path.join(root, "examples/chatgpt-export/input.json")
fs.mkdirSync(path.dirname(chatGptOut), { recursive: true })
fs.writeFileSync(chatGptOut, JSON.stringify(chatGptExport, null, 2) + "\n")
console.log(`✓ ${path.relative(root, chatGptOut)} — ${chatGptExport.length} conversations, ${(fs.statSync(chatGptOut).size / 1024).toFixed(1)} KB`)

// ---------------------------------------------------------------------------
// 2. Markdown chat log — 6 hand-saved conversations from a few months
// ---------------------------------------------------------------------------

function buildMarkdownLog() {
  const conversations = [
    {
      title: "Picking a CRM that won't outgrow us",
      date: "2026-01-09",
      turns: [
        ["User", "We're 14 people, mostly engineers, with a small founding sales team. Looking for a CRM that we can use without hiring a dedicated ops person to run it. What should I be evaluating?"],
        ["Assistant", "Three things to evaluate, in order of how often they sink small-team CRM rollouts:\n\n1. **Time to first useful report.** Can a non-ops person build the \"deals closing this quarter, by stage\" view in under 30 minutes? If the CRM requires custom report-builder fluency, you'll either build it yourself and resent it forever, or ignore the CRM and live in spreadsheets.\n2. **What happens when the founder stops updating it.** Most CRMs decay because the founder enters deals during pipeline review and forgets the rest of the time. Look for one that pulls activity from email + calendar automatically (Pipedrive, HubSpot, Attio, Folk all do this to varying degrees) so the system stays accurate without manual entry.\n3. **Migration cost when you outgrow it.** Look at the export format. Will you be able to dump all your contacts + deals + activity history into a CSV / API in a year when you hire a real RevOps person and want to move to Salesforce? CRMs vary a lot here.\n\nFor a 14-person team with no ops headcount, I'd start with **Attio** or **Folk** (both lean toward \"spreadsheet that grew up\", easy onboarding) over HubSpot or Pipedrive (more functionality but more configuration). Salesforce is overkill until you're ~50 people or have a dedicated admin."],
        ["User", "What about HubSpot's free tier — is that a real option or a sales funnel?"],
        ["Assistant", "Real option for the first ~6 months, then sales funnel.\n\nThe free tier genuinely covers contacts + deals + a basic pipeline + email tracking — enough to run small-team sales. The catch is the upgrade cliff: the moment you want **email sequences, custom reports beyond a few presets, more than 1000 marketing contacts, or remove HubSpot branding from forms**, you jump to Sales Hub Professional at $450+/month/team.\n\nFor a 14-person team that's growing, you'll probably hit one of those needs within 6 months. So treat the free tier as a \"free trial\" and plan the budget for the paid tier on day one — don't be surprised by it.\n\nIf $450/month feels steep, the lighter alternatives (Pipedrive Advanced at ~$30/user/month, Attio Pro at ~$30/user/month, Folk at ~$20/user/month) get you most of the same functionality at small-team pricing."],
      ],
    },
    {
      title: "Help me prep for a board update",
      date: "2026-01-22",
      turns: [
        ["User", "Quarterly board update is on Friday. We had a tough Q4 — missed revenue, lost two deals to competitors. How should I frame this without being defensive?"],
        ["Assistant", "Three principles for a \"tough quarter\" board update:\n\n1. **Lead with the bad news.** If you bury it in slide 14, the board will spend slides 1–13 wondering when you'll get to it. Putting it on slide 2 (after a one-slide TL;DR) signals you're owning it and lets the conversation move forward.\n2. **Diagnose, don't blame.** \"We missed Q4 revenue by 18%\" → followed by your honest read on *why*. Was it a single deal that slipped, broader market softness, a product gap, sales execution? Be specific. Vague diagnoses (\"the macro environment\") read as deflecting.\n3. **What you've changed already.** The board doesn't want to hear \"we'll do better.\" They want to see that you've already changed something — pricing, the comp plan, hiring profile, ICP focus, product roadmap. If you don't have a change yet, lead with \"here's the diagnosis, here's what we'll have decided by next month, and I'll bring the decision to the next call.\"\n\nFor the specific case (missed revenue + lost deals to competitors): the board wants to know whether this is a **temporary execution miss** (fixable with sales changes) or a **structural product gap** (the competitors have a feature you don't, and that's the deciding factor). If it's the latter, that's actually a much bigger conversation. Be honest about which it is."],
        ["User", "How long should the update be? Last quarter mine ran 90 minutes, two board members complained."],
        ["Assistant", "Aim for 45 minutes of presentation + 30 minutes of discussion, capped at 90 minutes total. The structure that usually fits:\n\n- **5 min**: TL;DR — what happened, what's next, what you need from the board\n- **15 min**: Business performance (revenue, churn, hiring, runway). Numbers + context, not 20 slides of charts.\n- **15 min**: One deep-dive topic — the most important strategic question this quarter. Pick ONE. (For your case: \"is this a sales execution issue or a product gap?\")\n- **10 min**: Asks of the board — intros, advice, hiring help, decisions you need.\n- **30 min**: Open discussion / Q&A.\n\n90 minutes total. If you ran 90 minutes of presentation last time and got pushback, the issue was probably that you spent it on numbers + updates rather than on a strategic conversation. Board members care about the strategic question; they can read the numbers in the deck before the call."],
      ],
    },
    {
      title: "Debugging — npm install hangs on this project",
      date: "2026-02-14",
      turns: [
        ["User", "npm install on this project hangs at \"reify:trace: timing reifyNode\" forever. Tried clearing cache, deleting node_modules, no luck. Node 20, npm 10, package-lock checked in."],
        ["Assistant", "Three usual culprits for hangs at the reify step:\n\n1. **A registry mirror that's silently stalling.** Check `npm config get registry` — if it's pointing at an internal mirror or a moved registry, requests can hang without timing out. Try `npm install --registry https://registry.npmjs.org/` to bypass.\n2. **A peer dependency conflict that npm is silently retrying.** Run with verbose logging:\n   ```bash\n   npm install --loglevel=verbose 2>&1 | tee install.log\n   ```\n   Look for repeated lines about a specific package. The hang is usually npm trying alternative resolutions in a loop.\n3. **A package script (postinstall, etc.) that's blocking on user input.** Some packages prompt during install. Run with `--ignore-scripts` to confirm:\n   ```bash\n   npm install --ignore-scripts\n   ```\n   If that finishes fast, you have a script-side hang to track down.\n\nWhat's in your package.json? If you paste it I can be more specific."],
        ["User", "Tried verbose, it loops on 'reify:trace: timing audit' lines. Could that be the issue?"],
        ["Assistant", "Yes — that's almost certainly `npm audit` calling the npm registry on every package, and it's hanging if the registry is slow or unreachable.\n\nQuick fix: `npm install --no-audit`\n\nIf that works, you have two longer-term options:\n\n- **Add it to .npmrc**: `audit=false` if you don't run audit in this project at all (e.g. it's a sandbox).\n- **Run audit separately**: keep audit on for installs in CI but skip it locally with the flag. Most teams do this — `npm audit` is slow and noisy and most people only check it in CI anyway.\n\nIf `--no-audit` also hangs, it's the registry connection itself. Run `curl -v https://registry.npmjs.org/express` and see if that hangs too — if yes, it's a network / DNS issue, not npm."],
      ],
    },
    {
      title: "Untitled",
      date: "2026-03-03",
      turns: [
        ["User", "what's the difference between bind mounts and volumes in docker"],
        ["Assistant", "**Bind mount**: Docker mounts a directory from your host filesystem into the container. The host path is the source of truth — you control where it lives, what permissions it has, who else can read it.\n\n```bash\ndocker run -v /host/path:/container/path my-image\n```\n\nUse when: you want to edit files on the host and have them reflect in the container immediately (development), or you want to use existing host files (config, certs, project source).\n\n**Volume**: Docker creates and manages a named storage location, typically under `/var/lib/docker/volumes/` on Linux. The container sees it at the mount path; you don't deal with the host path directly.\n\n```bash\ndocker volume create mydata\ndocker run -v mydata:/container/path my-image\n```\n\nUse when: you want Docker to manage the lifecycle (backup, share between containers, portable across machines), or the data is opaque to the host (database files).\n\n**Practical rule**: dev / source code → bind mount. Production data (db files, app state) → volume."],
      ],
    },
    {
      title: "Make this email less aggressive",
      date: "2026-03-18",
      turns: [
        ["User", "Vendor missed a deadline they committed to. I drafted this email but it reads as too hot — can you tone it down without losing the signal that I'm unhappy?\n\n> Hi [vendor],\n> You committed to delivering the Q1 milestone by March 15. It's now March 18 and I haven't heard from you. This is the second deadline you've missed in the last six months. We need to talk about whether this engagement is working. Please respond by EOD tomorrow."],
        ["Assistant", "Same signal, calmer delivery:\n\n> Hi [vendor],\n>\n> The Q1 milestone we agreed to was due March 15 — wanted to check in on where things stand. I haven't seen an update yet, so I'm guessing something's gotten in the way.\n>\n> Stepping back a bit: this is the second deadline that's slipped this engagement, and I want to be honest that it's making it hard for me to plan around your work. Can we get on a call this week to figure out what's going on and whether the current setup is the right fit?\n>\n> Thanks,\n> [your name]\n\nWhat I changed:\n\n- \"You committed... It's now... I haven't heard\" — these stack as accusations. Replaced with one neutral check-in and one explicit observation.\n- \"We need to talk about whether this engagement is working\" → \"whether the current setup is the right fit.\" Same outcome on the table; less of an ultimatum.\n- \"Please respond by EOD tomorrow\" → cut. Hard deadlines in a \"this isn't working\" email feel punitive. Asking for a call this week sets a similar pace without the ultimatum framing.\n\nIf they don't respond within ~3 business days, then send a firmer follow-up with a hard date. The first one shouldn't lead with that."],
        ["User", "What if they respond apologetically but vaguely — what do I say back?"],
      ],
    },
    {
      title: "Recipe — what to do with leftover roasted vegetables",
      date: "2026-04-19",
      turns: [
        ["User", "I have a sheet pan of roasted vegetables left over from last night — sweet potato, broccoli, red onion, peppers. What can I make for lunch in 15 min?"],
        ["Assistant", "Five quick options, depending on what else you have:\n\n1. **Grain bowl**: throw the vegetables over rice or quinoa, drizzle with tahini-lemon-garlic dressing (3 tbsp tahini + juice of half a lemon + 1 minced garlic clove + warm water to thin). Top with a fried egg if you have one.\n2. **Frittata**: whisk 4 eggs + a splash of milk + salt, pour over the vegetables in an oven-safe pan, cook on the stove until edges set, then 8 min at 375°F to finish. Crumble feta on top before serving.\n3. **Quesadilla**: chop everything small, spread on half a tortilla with shredded cheese, fold and pan-fry until crisp. Serve with hot sauce or salsa.\n4. **Cold pasta salad**: toss with cooked pasta + olive oil + lemon + salt + a handful of arugula. Eat at room temp.\n5. **Soup base**: blitz with chicken / veg stock + a can of white beans, simmer 5 min, top with olive oil + chili flakes.\n\nIf you tell me what protein you have I can be more specific."],
      ],
    },
  ]
  const lines = [
    "# Saved AI conversations — Sam Reyes (synthetic)",
    "",
    "A few conversations I've saved from chatting with Claude and ChatGPT over",
    "the last few months. Each one is something I want to keep handy.",
    "",
  ]
  for (let i = 0; i < conversations.length; i++) {
    const c = conversations[i]
    if (i > 0) lines.push("---", "")
    lines.push(`## ${c.title}`)
    lines.push(`Date: ${c.date}`, "")
    for (const [role, text] of c.turns) {
      lines.push(`${role}: ${text}`, "")
    }
  }
  return lines.join("\n").trimEnd() + "\n"
}

const mdLog = buildMarkdownLog()
const mdOut = path.join(root, "examples/ai-chat-log/input.md")
fs.mkdirSync(path.dirname(mdOut), { recursive: true })
fs.writeFileSync(mdOut, mdLog)
console.log(`✓ ${path.relative(root, mdOut)} — ${(fs.statSync(mdOut).size / 1024).toFixed(1)} KB`)
