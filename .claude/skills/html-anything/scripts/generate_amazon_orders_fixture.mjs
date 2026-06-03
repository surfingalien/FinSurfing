#!/usr/bin/env node
/**
 * Synthetic Amazon order-history fixture generator.
 *
 * Writes `examples/amazon-orders/input.csv` — a fully fictional consumer
 * Amazon order export covering ~3 years, with deliberate patterns:
 *   - repeat / habit purchases (cat litter, coffee filters, ink, vitamins)
 *   - one-off splurges (espresso machine, monitor, chair)
 *   - book buying as a steady drumbeat
 *   - 3 recipients (primary + a kid + a parent, all fake)
 *   - seasonal Black Friday / Prime Day / December clusters
 *   - a few returns, refunds, and cancellations
 *
 * No real ASINs, real product titles tied to specific brands' real ASINs,
 * real names, real addresses, real order IDs. Verified zero leakage by
 * keeping every identifier prefix-stamped (ASIN starts B0SYNTH; Order ID
 * starts 222-SYNTH-).
 *
 * Run from repo root:
 *   node scripts/generate_amazon_orders_fixture.mjs
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, "..", "examples", "amazon-orders", "input.csv")

const RECIPIENTS = [
  { name: "Sam Reyes",   state: "NY", weight: 0.62 },
  { name: "Alex Reyes",  state: "MA", weight: 0.22 },
  { name: "Jordan Reyes", state: "FL", weight: 0.16 },
]

const CARRIERS = ["AMZL_US", "UPS", "USPS", "FEDEX"]

const REPEATS = [
  { title: "FreshPaw Clumping Cat Litter, 35 lb (synthetic example)",       asin: "B0SYNTH001", category: "Pet Supplies",            unit: 18.99, cadenceDays: 42, qty: 1 },
  { title: "MorningHill Permanent Coffee Filter, #4 (synthetic example)",  asin: "B0SYNTH002", category: "Kitchen",                 unit:  9.49, cadenceDays: 90, qty: 1 },
  { title: "Pioneer Black Ink Cartridge, XL (synthetic example)",          asin: "B0SYNTH003", category: "Office",                  unit: 24.50, cadenceDays: 70, qty: 1 },
  { title: "Daily Multivitamin, 90 capsules (synthetic example)",          asin: "B0SYNTH004", category: "Health & Personal Care",  unit: 14.95, cadenceDays: 60, qty: 1 },
  { title: "Stoneground Toothpaste 4-pack (synthetic example)",            asin: "B0SYNTH005", category: "Health & Personal Care",  unit: 12.99, cadenceDays: 75, qty: 1 },
  { title: "Tiny Trees AAA Batteries 24-pack (synthetic example)",         asin: "B0SYNTH006", category: "Electronics",             unit:  9.99, cadenceDays: 120, qty: 1 },
  { title: "BrightHome LED Bulbs, 4-pack soft white (synthetic example)",  asin: "B0SYNTH007", category: "Household",               unit: 13.49, cadenceDays: 180, qty: 1 },
]

const ONE_OFFS = [
  { title: "Wandering Stars: A Novel by Riverstone Press (synthetic)",     asin: "B0SYNTH101", category: "Books",                   unit: 18.95 },
  { title: "The Paper Garden — paperback (synthetic example)",             asin: "B0SYNTH102", category: "Books",                   unit: 14.99 },
  { title: "Field Notes No. 7: Migration — paperback (synthetic)",         asin: "B0SYNTH103", category: "Books",                   unit: 16.50 },
  { title: "How Cities Think — paperback (synthetic example)",             asin: "B0SYNTH104", category: "Books",                   unit: 19.95 },
  { title: "A Short History of Light — hardcover (synthetic)",             asin: "B0SYNTH105", category: "Books",                   unit: 24.00 },
  { title: "Slow Lane Cookbook — hardcover (synthetic)",                   asin: "B0SYNTH106", category: "Books",                   unit: 27.50 },
  { title: "Letters from the Reading Room — paperback (synthetic)",        asin: "B0SYNTH107", category: "Books",                   unit: 16.99 },
  { title: "The Whale Atlas — illustrated edition (synthetic)",            asin: "B0SYNTH108", category: "Books",                   unit: 32.00 },
  { title: "Rivermouth: Stories — paperback (synthetic)",                  asin: "B0SYNTH109", category: "Books",                   unit: 15.50 },
  { title: "The Quiet Engineer — paperback (synthetic)",                   asin: "B0SYNTH110", category: "Books",                   unit: 18.00 },
  { title: "27-inch QHD Monitor (synthetic example)",                      asin: "B0SYNTH201", category: "Electronics",             unit: 299.99 },
  { title: "USB-C Hub, 7 ports (synthetic example)",                       asin: "B0SYNTH202", category: "Electronics",             unit:  39.99 },
  { title: "Wireless Mechanical Keyboard, 65% (synthetic example)",        asin: "B0SYNTH203", category: "Electronics",             unit: 119.00 },
  { title: "Noise-Cancelling Headphones (synthetic example)",              asin: "B0SYNTH204", category: "Electronics",             unit: 248.00 },
  { title: "Webcam, 1080p (synthetic example)",                            asin: "B0SYNTH205", category: "Electronics",             unit:  64.99 },
  { title: "Espresso Machine, semi-automatic (synthetic example)",         asin: "B0SYNTH301", category: "Kitchen",                 unit: 549.00 },
  { title: "Cast Iron Skillet, 12-inch (synthetic example)",               asin: "B0SYNTH302", category: "Kitchen",                 unit:  39.95 },
  { title: "Glass Storage Containers, 10-piece (synthetic example)",       asin: "B0SYNTH303", category: "Kitchen",                 unit:  44.50 },
  { title: "Stainless Steel Tea Kettle (synthetic example)",               asin: "B0SYNTH304", category: "Kitchen",                 unit:  72.00 },
  { title: "Conical Burr Coffee Grinder (synthetic example)",              asin: "B0SYNTH305", category: "Kitchen",                 unit: 139.00 },
  { title: "Laundry Detergent, 96 loads (synthetic example)",              asin: "B0SYNTH401", category: "Household",               unit:  19.99 },
  { title: "Microfiber Cleaning Cloths, 24-pack (synthetic example)",      asin: "B0SYNTH402", category: "Household",               unit:  14.99 },
  { title: "Dish Soap, lemon, 2-pack (synthetic example)",                 asin: "B0SYNTH403", category: "Household",               unit:  10.99 },
  { title: "Trash Bags, 13-gal, 90 count (synthetic example)",             asin: "B0SYNTH404", category: "Household",               unit:  21.99 },
  { title: "Toddler Snack Cups, 4-pack (synthetic example)",               asin: "B0SYNTH501", category: "Baby",                    unit:  16.99 },
  { title: "Soft-Sole Slippers, kids 7 (synthetic example)",               asin: "B0SYNTH502", category: "Baby",                    unit:  22.50 },
  { title: "Picture Book Bundle, 6 titles (synthetic example)",            asin: "B0SYNTH503", category: "Baby",                    unit:  38.00 },
  { title: "Kids Rain Boots, size 9 (synthetic example)",                  asin: "B0SYNTH504", category: "Baby",                    unit:  29.95 },
  { title: "Wooden Building Blocks, 100 pc (synthetic example)",           asin: "B0SYNTH601", category: "Toys",                    unit:  34.99 },
  { title: "Magnetic Tile Set, 32 pieces (synthetic example)",             asin: "B0SYNTH602", category: "Toys",                    unit:  44.99 },
  { title: "Adjustable Laptop Stand (synthetic example)",                  asin: "B0SYNTH701", category: "Office",                  unit:  39.99 },
  { title: "Standing Desk Mat (synthetic example)",                        asin: "B0SYNTH702", category: "Office",                  unit:  79.00 },
  { title: "Office Chair, ergonomic (synthetic example)",                  asin: "B0SYNTH703", category: "Office",                  unit: 389.00 },
  { title: "Notebook Set, 3 ruled (synthetic example)",                    asin: "B0SYNTH704", category: "Office",                  unit:  18.50 },
  { title: "Garden Trowel, stainless (synthetic example)",                 asin: "B0SYNTH801", category: "Garden",                  unit:  17.99 },
  { title: "Tomato Cages, 4-pack (synthetic example)",                     asin: "B0SYNTH802", category: "Garden",                  unit:  29.99 },
  { title: "Soaker Hose, 50 ft (synthetic example)",                       asin: "B0SYNTH803", category: "Garden",                  unit:  24.49 },
  { title: "Running Socks, merino, 6-pack (synthetic example)",            asin: "B0SYNTH901", category: "Apparel",                 unit:  34.00 },
  { title: "Rain Jacket, lightweight (synthetic example)",                 asin: "B0SYNTH902", category: "Apparel",                 unit:  89.00 },
  { title: "Wool Beanie, charcoal (synthetic example)",                    asin: "B0SYNTH903", category: "Apparel",                 unit:  22.00 },
  { title: "Foam Roller, 18-inch (synthetic example)",                     asin: "B0SYNTHA01", category: "Health & Personal Care",  unit:  24.99 },
  { title: "Resistance Bands, 5-pack (synthetic example)",                 asin: "B0SYNTHA02", category: "Health & Personal Care",  unit:  18.99 },
  { title: "Reusable Water Bottle, 32oz (synthetic example)",              asin: "B0SYNTHA03", category: "Health & Personal Care",  unit:  29.95 },
]

const RETURNS = [
  { sourceAsin: "B0SYNTH702", reason: "didn't fit the desk", refund: true },
  { sourceAsin: "B0SYNTH204", reason: "uncomfortable for long sessions", refund: true },
  { sourceAsin: "B0SYNTH902", reason: "wrong size", refund: true },
  { sourceAsin: "B0SYNTH303", reason: "lid leaked", refund: true },
]

const CANCELLATIONS = [
  { sourceAsin: "B0SYNTH301", reason: "decided not to upgrade" },
  { sourceAsin: "B0SYNTH703", reason: "ordered locally" },
]

// Deterministic PRNG (mulberry32) so the fixture is stable across runs.
function rng(seed) {
  let s = seed >>> 0
  return function () {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = rng(202604_25)

function pickWeighted(arr) {
  const total = arr.reduce((s, x) => s + x.weight, 0)
  let r = rand() * total
  for (const x of arr) {
    r -= x.weight
    if (r <= 0) return x
  }
  return arr[arr.length - 1]
}

function pickFlat(arr) {
  return arr[Math.floor(rand() * arr.length)]
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10)
}

function addDays(d, n) {
  const out = new Date(d.getTime())
  out.setUTCDate(out.getUTCDate() + n)
  return out
}

function jitter(d, days) {
  return addDays(d, Math.floor(rand() * (2 * days + 1)) - days)
}

function makeOrderId(seq) {
  return `222-SYNTH-${(7000000 + seq).toString().padStart(7, "0")}`
}

function csvEscape(v) {
  const s = String(v ?? "")
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

const HEADERS = [
  "Order Date",
  "Order ID",
  "Title",
  "ASIN",
  "Category",
  "Quantity",
  "Item Subtotal",
  "Item Total",
  "Shipping Address Name",
  "Shipping Address State",
  "Order Status",
  "Carrier",
  "Currency",
]

const ROWS = []
let orderSeq = 0

function pushRow({ date, asin, title, category, qty, unit, recipient, status, carrier }) {
  const subtotal = +(qty * unit).toFixed(2)
  const tax = +(subtotal * 0.085).toFixed(2)
  const total = +(subtotal + tax).toFixed(2)
  ROWS.push({
    "Order Date": fmtDate(date),
    "Order ID": makeOrderId(orderSeq++),
    "Title": title,
    "ASIN": asin,
    "Category": category,
    "Quantity": qty,
    "Item Subtotal": subtotal.toFixed(2),
    "Item Total": total.toFixed(2),
    "Shipping Address Name": recipient.name,
    "Shipping Address State": recipient.state,
    "Order Status": status,
    "Carrier": carrier,
    "Currency": "USD",
  })
}

// 1) Repeat / habit purchases — generated on cadence with mild jitter.
const RANGE_START = new Date("2023-01-12T00:00:00Z")
const RANGE_END   = new Date("2025-12-12T00:00:00Z")

for (const r of REPEATS) {
  let d = jitter(RANGE_START, 14)
  while (d <= RANGE_END) {
    const recipient = r.category === "Pet Supplies" ? RECIPIENTS[0]
                    : r.category === "Office" ? RECIPIENTS[0]
                    : pickWeighted(RECIPIENTS)
    pushRow({
      date: d,
      asin: r.asin,
      title: r.title,
      category: r.category,
      qty: r.qty,
      unit: r.unit,
      recipient,
      status: "Delivered",
      carrier: pickFlat(CARRIERS),
    })
    d = jitter(addDays(d, r.cadenceDays), Math.max(3, Math.floor(r.cadenceDays / 6)))
  }
}

// 2) One-off purchases scattered through the years, with seasonal pull
//    toward Black Friday + Prime Day + December.
function biasedDate() {
  // 60% uniform across the window, 40% biased to seasonal clusters.
  if (rand() < 0.6) {
    const span = RANGE_END.getTime() - RANGE_START.getTime()
    return new Date(RANGE_START.getTime() + rand() * span)
  }
  const year = 2023 + Math.floor(rand() * 3)
  const cluster = pickFlat([
    { month: 6, day: 13 },   // Prime Day
    { month: 10, day: 25 },  // Black Friday lead
    { month: 11, day: 23 },  // Black Friday
    { month: 11, day: 30 },  // Cyber Monday
    { month: 11, day: 12 },  // Mid-Nov gift run
    { month: 11, day: 18 },  // late Nov
  ])
  const d = new Date(Date.UTC(year, cluster.month, cluster.day))
  return jitter(d, 4)
}

const ONEOFF_TARGET = 70  // line-item count for one-offs (in addition to repeats)
let drawn = 0
while (drawn < ONEOFF_TARGET) {
  const item = pickFlat(ONE_OFFS)
  const date = biasedDate()
  if (date < RANGE_START || date > RANGE_END) continue
  const qty = item.unit < 25 && rand() < 0.18 ? 2 : 1
  const recipient = item.category === "Baby" ? (rand() < 0.7 ? RECIPIENTS[1] : RECIPIENTS[0])
                  : item.category === "Toys" ? RECIPIENTS[1]
                  : item.category === "Health & Personal Care" && rand() < 0.25 ? RECIPIENTS[2]
                  : pickWeighted(RECIPIENTS)
  pushRow({
    date,
    asin: item.asin,
    title: item.title,
    category: item.category,
    qty,
    unit: item.unit,
    recipient,
    status: "Delivered",
    carrier: pickFlat(CARRIERS),
  })
  drawn++
}

// 3) Returns / refunds — replace status on a couple of existing items, or
//    add follow-up rows if the product wasn't already in the list.
for (const r of RETURNS) {
  const candidates = ROWS.filter(row => row.ASIN === r.sourceAsin && row["Order Status"] === "Delivered")
  if (candidates.length) {
    const target = candidates[Math.floor(rand() * candidates.length)]
    target["Order Status"] = r.refund ? "Refunded" : "Returned"
  } else {
    const item = ONE_OFFS.find(o => o.asin === r.sourceAsin) || ONE_OFFS[0]
    pushRow({
      date: biasedDate(),
      asin: item.asin,
      title: item.title,
      category: item.category,
      qty: 1,
      unit: item.unit,
      recipient: pickWeighted(RECIPIENTS),
      status: r.refund ? "Refunded" : "Returned",
      carrier: pickFlat(CARRIERS),
    })
  }
}

// 4) Cancellations — discrete rows.
for (const c of CANCELLATIONS) {
  const item = ONE_OFFS.find(o => o.asin === c.sourceAsin) || ONE_OFFS[0]
  pushRow({
    date: biasedDate(),
    asin: item.asin,
    title: item.title,
    category: item.category,
    qty: 1,
    unit: item.unit,
    recipient: pickWeighted(RECIPIENTS),
    status: "Cancelled",
    carrier: "",
  })
}

// 5) One delivery exception so the "problem" callout has a row.
pushRow({
  date: new Date("2024-11-29T00:00:00Z"),
  asin: "B0SYNTH303",
  title: "Glass Storage Containers, 10-piece (synthetic example)",
  category: "Kitchen",
  qty: 1,
  unit: 44.50,
  recipient: RECIPIENTS[0],
  status: "Late delivery exception",
  carrier: "USPS",
})

// Sort chronologically + write CSV.
ROWS.sort((a, b) => a["Order Date"].localeCompare(b["Order Date"]))

const lines = [
  HEADERS.join(","),
  ...ROWS.map(row => HEADERS.map(h => csvEscape(row[h])).join(",")),
]

await fs.mkdir(path.dirname(OUT), { recursive: true })
await fs.writeFile(OUT, lines.join("\n") + "\n", "utf8")

console.log(`Wrote ${ROWS.length} rows to ${path.relative(process.cwd(), OUT)}`)
