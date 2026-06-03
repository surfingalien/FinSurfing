#!/usr/bin/env node
/**
 * Deterministic synthetic-data generator for the linkedin-connections
 * example. Produces a `Connections.csv` matching LinkedIn's "Download
 * your data" → Connections export shape (with the realistic 3-line
 * "Notes:" preamble that LinkedIn prefixes onto the file before the
 * actual header row).
 *
 *   - 110 fake connections spanning 12 years (Jan 2014 → Apr 2026)
 *     with a deliberate spike month (October 2024 = 18 new in one
 *     week to demo the conference-cluster callout).
 *   - mix of industries (engineering, product, design, marketing,
 *     sales, founder/exec, investing, recruiting, ops, consulting,
 *     legal, academia, media, healthcare, students).
 *   - intentionally incomplete rows: missing email (most), missing
 *     company (recruiter-removed / left LinkedIn), missing position,
 *     duplicate name across two cards (the canonical "rejoined under
 *     a new account" pattern), duplicate URL.
 *   - reserved example domains only (example.com / example.org /
 *     example.net) plus a small share of personal-mail example
 *     stand-ins so the personal-vs-work split is visible.
 *   - all `linkedin.com/in/synthetic-...-XXXX` slugs are obviously
 *     fake.
 *
 * Privacy: every name, company, title, URL slug, and email is wholly
 * invented. The generator never mentions a real person, company, or
 * domain.
 *
 * Usage:
 *   node scripts/generate_linkedin_connections_fixture.mjs > examples/linkedin-connections/input.csv
 *   # or
 *   node scripts/generate_linkedin_connections_fixture.mjs --out examples/linkedin-connections/input.csv
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "examples/linkedin-connections/input.csv",
)

// ---------------------------------------------------------------------------
// Synthetic name pools — invented, not derived from any real list.
// ---------------------------------------------------------------------------
const FIRST_NAMES = [
  "Riya", "Aaron", "Mira", "Tomás", "Ngozi", "Yusuf", "Dara", "Kenji",
  "Anya", "Eitan", "Soraya", "Linus", "Beatriz", "Saoirse", "Wren",
  "Theo", "Indira", "Mateo", "Ola", "Priya", "Taro", "Lila", "Esme",
  "Felix", "Hana", "Kavya", "Amani", "Zane", "Noor", "Sahar", "Kai",
  "Iris", "Reza", "Maeve", "Ezra", "Anders", "Nuria", "Hugo", "Alma",
  "Suri", "Otto", "Selma", "Kofi", "Imani", "Cyrus", "Nia",
]

const LAST_NAMES = [
  "Acharya", "Whittaker", "Okonkwo", "Vasquez", "Ito", "Brennan",
  "Marchetti", "Petrov", "Sandström", "Nakamura", "Adesanya", "Khoury",
  "Schmidt", "Tindall", "Iyer", "Olsen", "Larsson", "Mehta", "Quinn",
  "Reyes", "Aoki", "Bekele", "Costa", "Donovan", "Eriksson", "Foster",
  "Gallego", "Hassan", "Ibarra", "Jansen", "Kapoor", "Lévesque",
  "Morais", "Nyström", "Ó Briain", "Park", "Quintero", "Rasheed",
  "Saito", "Tikhonov", "Ueno", "Voss", "Wallace", "Xu", "Yamada",
  "Zayd",
]

const COMPANIES = [
  ["Solare Global", "Engineering & Data"],
  ["Solare Global", "Engineering & Data"],
  ["Solare Global", "Engineering & Data"],
  ["Solare Global", "Engineering & Data"],
  ["Brookline Manufacturing Co.", "Operations"],
  ["Brookline Manufacturing Co.", "Operations"],
  ["Linewood Studio", "Design"],
  ["Linewood Studio", "Design"],
  ["Northwind Mutual", "Investing & Finance"],
  ["Northwind Mutual", "Investing & Finance"],
  ["Northwind Mutual", "Investing & Finance"],
  ["Acme Industries", "Operations"],
  ["Acme Industries", "Operations"],
  ["Acme Industries", "Operations"],
  ["Acme Industries", "Operations"],
  ["Acme Industries", "Operations"],
  ["Pearwood & Co.", "Marketing & Growth"],
  ["Pearwood & Co.", "Marketing & Growth"],
  ["Salt Pier Capital", "Investing & Finance"],
  ["Salt Pier Capital", "Investing & Finance"],
  ["Hartwell Legal", "Legal & Compliance"],
  ["Hartwell Legal", "Legal & Compliance"],
  ["Caldera Health", "Healthcare"],
  ["Caldera Health", "Healthcare"],
  ["Verdant Press", "Media & Writing"],
  ["Verdant Press", "Media & Writing"],
  ["Aurora Talent Partners", "People & Talent"],
  ["Aurora Talent Partners", "People & Talent"],
  ["Aurora Talent Partners", "People & Talent"],
  ["Riverline Consulting", "Consulting & Strategy"],
  ["Riverline Consulting", "Consulting & Strategy"],
  ["Northshore University", "Academia"],
  ["Northshore University", "Academia"],
  ["Solo / freelance", "Other"],
  ["Solo / freelance", "Other"],
  ["", "Other"],   // intentionally blank — recruiter-removed
  ["", "Other"],
  ["", "Other"],
]

const POSITIONS_BY_INDUSTRY = {
  "Engineering & Data": [
    "Senior Software Engineer",
    "Staff Software Engineer",
    "Software Engineer II",
    "Site Reliability Engineer",
    "Platform Engineer",
    "Data Scientist",
    "Machine Learning Engineer",
    "Engineering Manager",
  ],
  "Product": [
    "Senior Product Manager",
    "Product Manager",
    "Group Product Manager",
    "Director of Product",
    "Head of Product",
  ],
  "Design": [
    "Senior Product Designer",
    "Product Designer",
    "Design Lead",
    "Design Manager",
    "Brand Designer",
  ],
  "Marketing & Growth": [
    "Growth Marketing Manager",
    "Content Strategist",
    "Brand Marketing Lead",
    "Marketing Manager",
    "SEO Specialist",
  ],
  "Sales & BD": [
    "Account Executive",
    "Senior Account Executive",
    "Sales Development Representative",
    "Head of Partnerships",
    "Business Development Manager",
  ],
  "Founder & Exec": [
    "Founder & CEO",
    "Co-Founder & CTO",
    "Chief of Staff",
    "Managing Director",
  ],
  "Investing & Finance": [
    "Investment Associate",
    "Principal",
    "Portfolio Manager",
    "Investment Analyst",
    "Partner",
  ],
  "People & Talent": [
    "Senior Technical Recruiter",
    "Technical Recruiter",
    "People Operations Lead",
    "Talent Partner",
    "Head of Talent",
  ],
  "Operations": [
    "Operations Manager",
    "Program Manager",
    "Project Manager",
    "Senior Operations Lead",
    "Chief Operating Officer",
  ],
  "Consulting & Strategy": [
    "Senior Consultant",
    "Engagement Manager",
    "Strategy Director",
    "Consultant",
  ],
  "Legal & Compliance": [
    "Senior Counsel",
    "Compliance Manager",
    "Paralegal",
    "Attorney",
  ],
  "Academia": [
    "Assistant Professor",
    "Associate Professor",
    "PhD Candidate",
    "Postdoctoral Researcher",
  ],
  "Media & Writing": [
    "Senior Editor",
    "Staff Writer",
    "Columnist",
    "Author",
  ],
  "Healthcare": [
    "Clinical Research Coordinator",
    "Nurse Practitioner",
    "Healthcare Operations Manager",
    "Physician",
  ],
  "Student & Early Career": [
    "Software Engineering Intern",
    "Graduate Student",
    "Undergraduate Researcher",
    "Fellow",
  ],
  "Other": [
    "Self-employed",
    "Independent Consultant",
  ],
}

// ---------------------------------------------------------------------------
// Deterministic PRNG so the fixture is stable across runs.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng = mulberry32(0x10C14C0)
const pick = (arr) => arr[Math.floor(rng() * arr.length)]

function pad(n, w) { return String(n).padStart(w, "0") }

function fmtConnectedOn(year, month, day) {
  // LinkedIn modern format: "12 May 2024"
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
  return `${day} ${monthNames[month - 1]} ${year}`
}

function asciiSlug(s) {
  return s
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
}

function buildEmailSlug(first, last) {
  const f = asciiSlug(first).slice(0, 6) || "x"
  const l = asciiSlug(last).slice(0, 8) || "x"
  return `${f}.${l[0]}`
}

function buildLinkedInUrl(first, last, idx) {
  const slug = `${asciiSlug(first)}-${asciiSlug(last)}-${pad(idx, 5)}`
  return `https://www.linkedin.com/in/synthetic-${slug}`
}

// ---------------------------------------------------------------------------
// Build connections.
// ---------------------------------------------------------------------------
function buildConnections() {
  const rows = []
  let idx = 1

  // Pool 1: ~75 normal connections spread across 2014..2026.
  // We build a shape that:
  //   - is sparse 2014..2017 (early career, ~3-5/year)
  //   - thickens 2018..2022 (recruiter & coworker era, ~8-12/year)
  //   - has a deliberate Oct 2024 conference spike (18 in one week)
  //   - has a thin 2025-2026 tail (~6/year) plus 4 last-30-day rows
  //     (very-recent flag).
  const distribution = [
    { year: 2014, count: 3 },
    { year: 2015, count: 4 },
    { year: 2016, count: 5 },
    { year: 2017, count: 6 },
    { year: 2018, count: 8 },
    { year: 2019, count: 9 },
    { year: 2020, count: 11 },
    { year: 2021, count: 10 },
    { year: 2022, count: 9 },
    { year: 2023, count: 6 },
    { year: 2024, count: 8 },    // separate from the spike block below
    { year: 2025, count: 6 },
    // 2026 rows are added explicitly below so the reference date stays
    // anchored at 2026-04-28 (the latest "very-recent" entry).
  ]

  // Distinct pool of names — shuffle the full Cartesian product
  // deterministically so we don't accidentally hand out the same name
  // twice. Real LinkedIn exports do contain occasional duplicate names
  // (different people with the same name), but our fixture controls
  // duplicates explicitly via the Alex Chen + Marisol Park clusters.
  const namePool = []
  for (const f of FIRST_NAMES) for (const l of LAST_NAMES) namePool.push([f, l])
  // Fisher-Yates shuffle with the seeded RNG.
  for (let i = namePool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[namePool[i], namePool[j]] = [namePool[j], namePool[i]]
  }

  let nameCursor = 0

  function nextName() {
    const n = namePool[nameCursor % namePool.length]
    nameCursor += 1
    return n
  }

  function pushOne(year, month, day, opts = {}) {
    const [first, last] = opts.name || nextName()
    const fullName = `${first} ${last}`
    const [company, industry] = opts.company || pick(COMPANIES)
    const positions = POSITIONS_BY_INDUSTRY[industry] || POSITIONS_BY_INDUSTRY["Other"]
    let position = pick(positions)
    if (opts.missingPosition) position = ""
    let companyOut = company
    if (opts.missingCompany) companyOut = ""

    let email = ""
    // ~30% have email; bias toward work emails when company present.
    const r = rng()
    if (!opts.missingEmail && r < 0.30) {
      const slug = buildEmailSlug(first, last)
      if (companyOut) {
        // Map company → work domain on example.com / example.org / etc.
        const domain = `${asciiSlug(companyOut).slice(0, 18) || "co"}.example.com`
        email = `${slug}@${domain}`
      } else {
        // Personal-mail stand-ins (still on reserved example domains so
        // no real domain is implied).
        const personal = pick([
          "personal.example.org",
          "private.example.net",
          "mail.example.com",
        ])
        email = `${slug}@${personal}`
      }
    }

    const url = opts.url || buildLinkedInUrl(first, last, idx)
    const connectedOn = fmtConnectedOn(year, month, day)
    rows.push({
      firstName: first,
      lastName: last,
      url,
      email,
      company: companyOut,
      position,
      connectedOn,
    })
    idx += 1
  }

  for (const seg of distribution) {
    const months = []
    for (let i = 0; i < seg.count; i++) {
      months.push([
        1 + Math.floor(rng() * 12),
        1 + Math.floor(rng() * 28),
      ])
    }
    months.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    for (const [m, d] of months) {
      const opts = {}
      // 8% missing-company; 6% missing-position; 5% missing-email override
      // (most are missing email anyway, this is for cards that explicitly
      // bear no email even when other fields are present).
      const dice = rng()
      if (dice < 0.08) opts.missingCompany = true
      else if (dice < 0.14) opts.missingPosition = true
      pushOne(seg.year, m, d, opts)
    }
  }

  // Inject the October 2024 spike — 18 connections in a single week.
  // We replace some of the year=2024 rows with explicit Oct dates, but
  // simpler: append 18 new ones in Oct 14-20 2024.
  for (let i = 0; i < 18; i++) {
    const day = 14 + Math.floor(rng() * 7)
    pushOne(2024, 10, day, {
      // Force a specific industry mix that fits a "fundraising / SaaS"
      // conference week so the LLM picks up the cluster.
      company: pick([
        ["Salt Pier Capital", "Investing & Finance"],
        ["Northwind Mutual", "Investing & Finance"],
        ["Pearwood & Co.", "Marketing & Growth"],
        ["Riverline Consulting", "Consulting & Strategy"],
        ["", "Other"],
      ]),
    })
  }

  // Inject 4 very-recent connections (within ~25 days of the reference
  // date 2026-04-30) so the very-recent flag has live cards.
  pushOne(2026, 4, 28, {})
  pushOne(2026, 4, 24, {})
  pushOne(2026, 4, 19, {})
  pushOne(2026, 4, 12, {})

  // Inject duplicate-name cluster: Alex Chen appears under two distinct
  // synthetic URL slugs. Both recent enough to be plausible "rejoined".
  pushOne(2017, 5, 14, {
    name: ["Alex", "Chen"],
    company: ["Brookline Manufacturing Co.", "Operations"],
  })
  pushOne(2024, 7, 9, {
    name: ["Alex", "Chen"],
    company: ["Solo / freelance", "Other"],
  })

  // Inject duplicate-URL cluster: same URL slug across two different
  // names (LinkedIn occasionally produces this when a profile has been
  // claimed/reclaimed).
  const sharedUrl = "https://www.linkedin.com/in/synthetic-shared-profile-99099"
  pushOne(2019, 11, 3, {
    name: ["Marisol", "Park"],
    company: ["Aurora Talent Partners", "People & Talent"],
    url: sharedUrl,
  })
  pushOne(2023, 2, 18, {
    name: ["Marisol", "Park"],
    company: ["Aurora Talent Partners", "People & Talent"],
    url: sharedUrl,
  })

  // Inject 3 truly skeletal rows with only a name (the deleted-account
  // / removed-by-LinkedIn shape).
  pushOne(2016, 8, 1, {
    name: ["Hugo", "Voss"],
    missingCompany: true,
    missingPosition: true,
    missingEmail: true,
    url: "",
  })
  pushOne(2018, 3, 22, {
    name: ["Selma", "Larsson"],
    missingCompany: true,
    missingPosition: true,
    missingEmail: true,
    url: "",
  })
  pushOne(2015, 12, 11, {
    name: ["Otto", "Eriksson"],
    missingCompany: true,
    missingPosition: true,
    missingEmail: true,
    url: "",
  })

  return rows
}

// ---------------------------------------------------------------------------
// Emit the CSV.
// ---------------------------------------------------------------------------
function csvEscape(value) {
  const v = (value ?? "").toString()
  if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"'
  return v
}

function buildCsv(rows) {
  // LinkedIn export prefixes a 3-line "Notes:" preamble. The parser
  // strips it; we keep it here so the fixture exercises that path.
  const lines = []
  lines.push("Notes:")
  lines.push("\"When exporting your connection data, you may notice that" +
             " some fields (such as email addresses) are blank for connections" +
             " who have not synced their address with LinkedIn.\"")
  lines.push("")
  lines.push([
    "First Name", "Last Name", "URL", "Email Address",
    "Company", "Position", "Connected On",
  ].join(","))
  for (const r of rows) {
    lines.push([
      csvEscape(r.firstName),
      csvEscape(r.lastName),
      csvEscape(r.url),
      csvEscape(r.email),
      csvEscape(r.company),
      csvEscape(r.position),
      csvEscape(r.connectedOn),
    ].join(","))
  }
  return lines.join("\n") + "\n"
}

async function main() {
  const args = process.argv.slice(2)
  const outIdx = args.indexOf("--out")
  const target = outIdx >= 0 ? args[outIdx + 1] : OUT
  const rows = buildConnections()
  const csv = buildCsv(rows)
  if (target === "-") {
    process.stdout.write(csv)
    return
  }
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, csv, "utf8")
  process.stderr.write(`Wrote ${target} — ${rows.length} connections, ${csv.length} bytes\n`)
}

await main()
