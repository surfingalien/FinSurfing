#!/usr/bin/env node
/**
 * Synthetic rideshare-history fixture generator.
 *
 * Writes `examples/travel-history/input.csv` — a fully fictional
 * consumer Uber trip-history export covering ~2.5 years, with the
 * deliberate patterns the prompt promises:
 *   - Commute loops (Home → Office, Office → Home) on weekdays
 *   - Weekend brunch loops (Home → Brunch, Brunch → Home)
 *   - Late-night Fri/Sat rides
 *   - Airport runs (Home → SFO, SFO → Home; one trip leg in NYC adds JFK)
 *   - One city change mid-window (SF → NYC for ~6 weeks, then back)
 *   - Cancellations with $0 fare and a few with cancellation fees
 *   - Refunds (negative total)
 *   - Surge outlier (one ~$78 NYE ride)
 *   - One long airport run (38 mi to a synthetic out-of-town address)
 *   - Mix of UberX, Uber Pool, Uber Comfort, Uber Black
 *   - Coordinates rounded to 0.01° (fake / coarse, never real addresses)
 *
 * No real trip IDs, ASIN-style identifiers, real addresses, real
 * coordinates, real names. Every identifier is prefix-stamped: trip IDs
 * start with `SYN-` and addresses are clearly synthetic.
 *
 * Run from repo root:
 *   node scripts/generate_rideshare_history_fixture.mjs
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, "..", "examples", "travel-history", "input.csv")

// Deterministic PRNG so re-runs are identical (Mulberry32).
function makeRand(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}
const rand = makeRand(20260510)
const pick = (arr) => arr[Math.floor(rand() * arr.length)]
const jitter = (n, range) => n + (rand() - 0.5) * range
const round = (n, p = 2) => {
  const m = Math.pow(10, p)
  return Math.round(n * m) / m
}

// -----------------------------------------------------------------------
// Synthetic geography. Coordinates are rounded to 0.01° (~1.1 km) and
// labelled "(synthetic)" so there's no ambiguity about provenance.
// -----------------------------------------------------------------------
const SF = {
  city: "San Francisco",
  places: {
    home:    { label: "Home (synthetic, Mission)",        lat: 37.76, lng: -122.42 },
    office:  { label: "Office (synthetic, SoMa)",         lat: 37.78, lng: -122.40 },
    gym:     { label: "Gym (synthetic, Hayes Valley)",    lat: 37.77, lng: -122.43 },
    grocery: { label: "Grocery (synthetic, Mission)",     lat: 37.76, lng: -122.41 },
    brunch:  { label: "Brunch spot (synthetic, Mission)", lat: 37.76, lng: -122.42 },
    bar:     { label: "Bar (synthetic, Mission)",         lat: 37.76, lng: -122.41 },
    friend:  { label: "Friend's place (synthetic, Castro)", lat: 37.76, lng: -122.43 },
    airport: { label: "SFO Terminal 2 (synthetic)",       lat: 37.62, lng: -122.38 },
    parents: { label: "Parents (synthetic, Bernal)",      lat: 37.74, lng: -122.41 },
  },
}

const NYC = {
  city: "New York",
  places: {
    home:    { label: "Hotel (synthetic, Williamsburg)",  lat: 40.71, lng: -73.96 },
    office:  { label: "Co-working (synthetic, Soho)",     lat: 40.72, lng: -74.00 },
    dinner:  { label: "Dinner spot (synthetic, LES)",     lat: 40.72, lng: -73.98 },
    bar:     { label: "Bar (synthetic, Lower East Side)", lat: 40.72, lng: -73.99 },
    airport: { label: "JFK Terminal 4 (synthetic)",       lat: 40.64, lng: -73.78 },
  },
}

const PRODUCTS = ["UberX", "UberX", "UberX", "UberX", "Uber Comfort", "Uber Pool", "Uber Black"]
const STATUSES_OK   = ["completed"]
const STATUSES_BAD  = ["rider_cancelled", "driver_cancelled", "no_show"]

// -----------------------------------------------------------------------
// Trip generator
// -----------------------------------------------------------------------

function generateTrips() {
  const trips = []
  let counter = 1

  function addTrip({ when, from, to, product, status, surge, refundFraction, city }) {
    const isCancel = status && status !== "completed" && status !== "refunded"
    const isRefund = status === "refunded"
    const baseDistance = haversineMiles(from.lat, from.lng, to.lat, to.lng) || 0.5
    const distance = isCancel ? 0 : round(jitter(baseDistance, 0.4), 2)
    // Rough fare model: $2.55 base + $1.85/mi + $0.30/min, jittered.
    const baseMinutes = isCancel ? 0 : Math.max(4, baseDistance * 3.2 + jitter(2, 4))
    const baseFare = isCancel ? 0 : Math.max(7, 2.55 + 1.85 * baseDistance + 0.30 * baseMinutes)
    const surgeMul = surge || 1
    const fare = isCancel
      ? (rand() < 0.3 ? round(jitter(5, 1), 2) : 0)   // sometimes a $5 cancel fee
      : round(baseFare * surgeMul + jitter(0, 1.5), 2)
    const tip = isCancel ? 0 : (status === "completed" && rand() < 0.55 ? round(jitter(2.5, 2), 2) : 0)
    const fee = isCancel ? 0 : round(jitter(2.4, 1.5), 2)        // booking fee + tax + airport surcharge
    const total = isCancel
      ? fare
      : isRefund
        ? -round(fare + tip + fee, 2)
        : round(fare + tip + fee, 2) * (refundFraction ? -refundFraction : 1)

    const requestEpoch = when.getTime()
    const beginEpoch = isCancel ? 0 : requestEpoch + Math.floor(jitter(60, 120) * 1000)   // ~1 min wait
    const dropEpoch = isCancel ? 0 : beginEpoch + Math.floor(baseMinutes * 60 * 1000)

    const tripId = `SYN-UBR-${counter.toString().padStart(6, "0")}`
    counter++

    trips.push({
      tripId,
      requestUtc: isoUtc(requestEpoch),
      beginUtc: beginEpoch ? isoUtc(beginEpoch) : "",
      dropoffUtc: dropEpoch ? isoUtc(dropEpoch) : "",
      pickupAddress: from.label,
      pickupLat: round(from.lat, 2),
      pickupLng: round(from.lng, 2),
      dropoffAddress: to.label,
      dropoffLat: round(to.lat, 2),
      dropoffLng: round(to.lng, 2),
      distanceMiles: distance,
      fare: round(Math.abs(total >= 0 ? fare : fare), 2),
      tip: round(tip, 2),
      fee: round(fee, 2),
      total: round(total, 2),
      currency: "USD",
      status: status || "completed",
      product: product || "UberX",
      city: city || SF.city,
      surge: surge && surge > 1 ? round(surge, 2) : "",
    })
  }

  // ---------------------- Phase 1: SF, 2024-01 → 2025-09 ----------------------
  let cursor = new Date(Date.UTC(2024, 0, 8, 8, 15))  // Mon morning
  for (let week = 0; week < 84; week++) {
    const phaseStart = new Date(cursor.getTime())

    // Tue / Thu commute: Home → Office at 8:15-8:45, Office → Home at 18:00-18:45.
    for (const dayOffset of [1, 3]) {
      // Skip occasional weeks (illness, holiday, working from home).
      if (rand() < 0.18) continue
      const day = new Date(phaseStart.getTime())
      day.setUTCDate(day.getUTCDate() + dayOffset)
      const morning = new Date(day.getTime())
      morning.setUTCHours(8, Math.floor(rand() * 30) + 5, 0, 0)
      addTrip({
        when: morning,
        from: SF.places.home,
        to: SF.places.office,
        product: rand() < 0.15 ? "Uber Pool" : "UberX",
        status: "completed",
        city: SF.city,
      })
      const evening = new Date(day.getTime())
      evening.setUTCHours(18, Math.floor(rand() * 45), 0, 0)
      addTrip({
        when: evening,
        from: SF.places.office,
        to: SF.places.home,
        product: rand() < 0.20 ? "Uber Comfort" : "UberX",
        status: "completed",
        city: SF.city,
      })
    }

    // Weekend brunch loop (Sat or Sun, ~50% of weeks).
    if (rand() < 0.55) {
      const sat = new Date(phaseStart.getTime())
      sat.setUTCDate(sat.getUTCDate() + 5 + (rand() < 0.5 ? 0 : 1))
      sat.setUTCHours(11, Math.floor(rand() * 60), 0, 0)
      addTrip({
        when: sat,
        from: SF.places.home,
        to: SF.places.brunch,
        product: "UberX",
        status: "completed",
        city: SF.city,
      })
      const back = new Date(sat.getTime())
      back.setUTCHours(13, Math.floor(rand() * 60), 0, 0)
      addTrip({
        when: back,
        from: SF.places.brunch,
        to: SF.places.home,
        product: "UberX",
        status: "completed",
        city: SF.city,
      })
    }

    // Friday late-night out (~40% of weeks).
    if (rand() < 0.4) {
      const fri = new Date(phaseStart.getTime())
      fri.setUTCDate(fri.getUTCDate() + 4)
      fri.setUTCHours(23, Math.floor(rand() * 59), 0, 0)
      addTrip({
        when: fri,
        from: SF.places.home,
        to: SF.places.bar,
        product: "UberX",
        status: "completed",
        city: SF.city,
      })
      const home = new Date(fri.getTime())
      home.setUTCDate(home.getUTCDate() + 1)
      home.setUTCHours(1 + Math.floor(rand() * 3), Math.floor(rand() * 59), 0, 0)
      addTrip({
        when: home,
        from: SF.places.bar,
        to: SF.places.home,
        product: rand() < 0.25 ? "Uber Comfort" : "UberX",
        status: "completed",
        city: SF.city,
      })
    }

    // Mid-week errand (~25% of weeks).
    if (rand() < 0.25) {
      const day = new Date(phaseStart.getTime())
      day.setUTCDate(day.getUTCDate() + 2)
      day.setUTCHours(19, Math.floor(rand() * 50), 0, 0)
      addTrip({
        when: day,
        from: SF.places.home,
        to: pick([SF.places.gym, SF.places.grocery, SF.places.friend, SF.places.parents]),
        product: "UberX",
        status: "completed",
        city: SF.city,
      })
    }

    // Cancellation (~12% of weeks): driver canceled or rider canceled.
    if (rand() < 0.12) {
      const day = new Date(phaseStart.getTime())
      day.setUTCDate(day.getUTCDate() + Math.floor(rand() * 5))
      day.setUTCHours(7 + Math.floor(rand() * 14), Math.floor(rand() * 59), 0, 0)
      addTrip({
        when: day,
        from: SF.places.home,
        to: SF.places.office,
        product: "UberX",
        status: pick(STATUSES_BAD),
        city: SF.city,
      })
    }

    cursor.setUTCDate(cursor.getUTCDate() + 7)
  }

  // ---------------------- Airport runs (Phase 1) ----------------------
  // Deliberately a few SFO trips: scattered conferences + holiday travel.
  const sfoOuts = [
    new Date(Date.UTC(2024, 1, 14, 6, 30)),   // Feb 14 6:30 → SFO
    new Date(Date.UTC(2024, 4, 22, 5, 45)),   // May 22 5:45
    new Date(Date.UTC(2024, 7, 11, 12, 10)),  // Aug 11 noon
    new Date(Date.UTC(2024, 10, 22, 14, 35)), // Nov 22 (Thanksgiving)
    new Date(Date.UTC(2025, 1, 2, 15, 20)),   // Feb 2 (return holiday)
    new Date(Date.UTC(2025, 4, 30, 4, 50)),   // May 30 redeye out
    new Date(Date.UTC(2025, 7, 18, 9, 25)),   // Aug 18 morning
  ]
  for (const t of sfoOuts) {
    addTrip({
      when: t,
      from: SF.places.home,
      to: SF.places.airport,
      product: rand() < 0.4 ? "Uber Comfort" : "UberX",
      status: "completed",
      city: SF.city,
    })
    // Most have a return flight 3-9 days later.
    if (rand() < 0.85) {
      const ret = new Date(t.getTime())
      ret.setUTCDate(ret.getUTCDate() + 3 + Math.floor(rand() * 7))
      ret.setUTCHours(20 + Math.floor(rand() * 4), Math.floor(rand() * 59), 0, 0)
      addTrip({
        when: ret,
        from: SF.places.airport,
        to: SF.places.home,
        product: rand() < 0.5 ? "Uber Comfort" : "UberX",
        status: "completed",
        city: SF.city,
      })
    }
  }

  // One long out-of-town airport-area run (38 mi).
  addTrip({
    when: new Date(Date.UTC(2024, 5, 14, 5, 5)),
    from: SF.places.home,
    to: { label: "Suburb pickup (synthetic, Half Moon Bay)", lat: 37.46, lng: -122.43 },
    product: "Uber Black",
    status: "completed",
    city: SF.city,
  })

  // ---------------------- Surge outlier (NYE 2024 → 2025) ----------------------
  addTrip({
    when: new Date(Date.UTC(2025, 0, 1, 1, 50)),
    from: SF.places.bar,
    to: SF.places.home,
    product: "Uber Black",
    status: "completed",
    surge: 2.4,
    city: SF.city,
  })

  // ---------------------- Refunds ----------------------
  addTrip({
    when: new Date(Date.UTC(2024, 6, 9, 8, 40)),
    from: SF.places.home,
    to: SF.places.office,
    product: "UberX",
    status: "refunded",
    city: SF.city,
  })
  addTrip({
    when: new Date(Date.UTC(2025, 2, 18, 19, 15)),
    from: SF.places.office,
    to: SF.places.home,
    product: "UberX",
    status: "refunded",
    city: SF.city,
  })

  // ---------------------- Phase 2: NYC sub-period (Oct 2025 - mid-Nov 2025) ----------------------
  cursor = new Date(Date.UTC(2025, 9, 6, 8, 30))   // Mon Oct 6 2025
  for (let week = 0; week < 6; week++) {
    const phaseStart = new Date(cursor.getTime())

    // Mon-Fri co-working commute, lighter cadence (~3 days/week).
    for (const dayOffset of [0, 2, 4]) {
      if (rand() < 0.2) continue
      const day = new Date(phaseStart.getTime())
      day.setUTCDate(day.getUTCDate() + dayOffset)
      const morning = new Date(day.getTime())
      morning.setUTCHours(9, Math.floor(rand() * 40), 0, 0)
      addTrip({
        when: morning,
        from: NYC.places.home,
        to: NYC.places.office,
        product: "UberX",
        status: "completed",
        city: NYC.city,
      })
      const evening = new Date(day.getTime())
      evening.setUTCHours(18 + Math.floor(rand() * 3), Math.floor(rand() * 59), 0, 0)
      addTrip({
        when: evening,
        from: NYC.places.office,
        to: NYC.places.home,
        product: rand() < 0.3 ? "Uber Comfort" : "UberX",
        status: "completed",
        city: NYC.city,
      })
    }

    // Dinner out (~50% of weeks).
    if (rand() < 0.55) {
      const day = new Date(phaseStart.getTime())
      day.setUTCDate(day.getUTCDate() + 2 + Math.floor(rand() * 3))
      day.setUTCHours(19, Math.floor(rand() * 59), 0, 0)
      addTrip({
        when: day,
        from: NYC.places.home,
        to: NYC.places.dinner,
        product: "UberX",
        status: "completed",
        city: NYC.city,
      })
    }
    cursor.setUTCDate(cursor.getUTCDate() + 7)
  }
  // JFK arrival + departure for the NYC trip.
  addTrip({
    when: new Date(Date.UTC(2025, 9, 5, 22, 10)),  // arrive Sun night
    from: NYC.places.airport,
    to: NYC.places.home,
    product: "Uber Comfort",
    status: "completed",
    city: NYC.city,
  })
  addTrip({
    when: new Date(Date.UTC(2025, 10, 16, 6, 15)), // depart Sun morning
    from: NYC.places.home,
    to: NYC.places.airport,
    product: "Uber Comfort",
    status: "completed",
    city: NYC.city,
  })
  // SFO bookends.
  addTrip({
    when: new Date(Date.UTC(2025, 9, 5, 12, 30)),
    from: SF.places.home,
    to: SF.places.airport,
    product: "UberX",
    status: "completed",
    city: SF.city,
  })
  addTrip({
    when: new Date(Date.UTC(2025, 10, 16, 16, 45)),
    from: SF.places.airport,
    to: SF.places.home,
    product: "UberX",
    status: "completed",
    city: SF.city,
  })

  // ---------------------- Phase 3: SF resume, late Nov 2025 → Apr 2026 ----------------------
  cursor = new Date(Date.UTC(2025, 10, 24, 8, 15))
  for (let week = 0; week < 22; week++) {
    const phaseStart = new Date(cursor.getTime())
    for (const dayOffset of [1, 3]) {
      if (rand() < 0.20) continue
      const day = new Date(phaseStart.getTime())
      day.setUTCDate(day.getUTCDate() + dayOffset)
      const morning = new Date(day.getTime())
      morning.setUTCHours(8, Math.floor(rand() * 30) + 10, 0, 0)
      addTrip({
        when: morning,
        from: SF.places.home,
        to: SF.places.office,
        product: rand() < 0.10 ? "Uber Pool" : "UberX",
        status: "completed",
        city: SF.city,
      })
      const evening = new Date(day.getTime())
      evening.setUTCHours(18, Math.floor(rand() * 50), 0, 0)
      addTrip({
        when: evening,
        from: SF.places.office,
        to: SF.places.home,
        product: rand() < 0.18 ? "Uber Comfort" : "UberX",
        status: "completed",
        city: SF.city,
      })
    }
    if (rand() < 0.55) {
      const sat = new Date(phaseStart.getTime())
      sat.setUTCDate(sat.getUTCDate() + 5)
      sat.setUTCHours(11, Math.floor(rand() * 50), 0, 0)
      addTrip({
        when: sat,
        from: SF.places.home,
        to: SF.places.brunch,
        product: "UberX",
        status: "completed",
        city: SF.city,
      })
      const back = new Date(sat.getTime())
      back.setUTCHours(13, Math.floor(rand() * 50), 0, 0)
      addTrip({
        when: back,
        from: SF.places.brunch,
        to: SF.places.home,
        product: "UberX",
        status: "completed",
        city: SF.city,
      })
    }
    if (rand() < 0.36) {
      const fri = new Date(phaseStart.getTime())
      fri.setUTCDate(fri.getUTCDate() + 4)
      fri.setUTCHours(22 + Math.floor(rand() * 2), Math.floor(rand() * 59), 0, 0)
      addTrip({
        when: fri,
        from: SF.places.home,
        to: SF.places.bar,
        product: "UberX",
        status: "completed",
        city: SF.city,
      })
      const home = new Date(fri.getTime())
      home.setUTCDate(home.getUTCDate() + 1)
      home.setUTCHours(1 + Math.floor(rand() * 3), Math.floor(rand() * 59), 0, 0)
      addTrip({
        when: home,
        from: SF.places.bar,
        to: SF.places.home,
        product: rand() < 0.25 ? "Uber Comfort" : "UberX",
        status: "completed",
        city: SF.city,
      })
    }
    if (rand() < 0.10) {
      const day = new Date(phaseStart.getTime())
      day.setUTCDate(day.getUTCDate() + Math.floor(rand() * 5))
      day.setUTCHours(7 + Math.floor(rand() * 14), Math.floor(rand() * 59), 0, 0)
      addTrip({
        when: day,
        from: SF.places.home,
        to: SF.places.office,
        product: "UberX",
        status: pick(STATUSES_BAD),
        city: SF.city,
      })
    }
    cursor.setUTCDate(cursor.getUTCDate() + 7)
  }

  // Phase 3 airport runs.
  for (const t of [
    new Date(Date.UTC(2025, 11, 20, 13, 30)),
    new Date(Date.UTC(2026, 0, 2, 18, 45)),
    new Date(Date.UTC(2026, 2, 11, 5, 25)),
  ]) {
    addTrip({
      when: t,
      from: SF.places.home,
      to: SF.places.airport,
      product: "Uber Comfort",
      status: "completed",
      city: SF.city,
    })
    const ret = new Date(t.getTime())
    ret.setUTCDate(ret.getUTCDate() + 3 + Math.floor(rand() * 6))
    ret.setUTCHours(20 + Math.floor(rand() * 4), Math.floor(rand() * 59), 0, 0)
    addTrip({
      when: ret,
      from: SF.places.airport,
      to: SF.places.home,
      product: "Uber Comfort",
      status: "completed",
      city: SF.city,
    })
  }

  // Sort + return.
  trips.sort((a, b) => a.requestUtc.localeCompare(b.requestUtc))
  // Re-stamp trip IDs in chronological order.
  let n = 1
  for (const t of trips) t.tripId = `SYN-UBR-${(n++).toString().padStart(6, "0")}`
  return trips
}

// -----------------------------------------------------------------------
// CSV emit (canonical Uber DSAR `trips_data.csv` header order).
// -----------------------------------------------------------------------

function csvCell(v) {
  if (v == null) return ""
  const s = String(v)
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function buildCsv(trips) {
  const headers = [
    "Trip ID",
    "Request Time (UTC)",
    "Begin Trip Time (UTC)",
    "Begin Trip Lat",
    "Begin Trip Lng",
    "Begin Trip Address",
    "Dropoff Time (UTC)",
    "Dropoff Lat",
    "Dropoff Lng",
    "Dropoff Address",
    "Distance (miles)",
    "Duration (min)",
    "Fare Amount",
    "Tip Amount",
    "Fee Amount",
    "Total Amount",
    "Fare Currency",
    "Trip or Order Status",
    "Product Type",
    "City",
    "Surge Multiplier",
  ]
  const lines = [headers.join(",")]
  for (const t of trips) {
    const begin = t.beginUtc ? new Date(t.beginUtc).getTime() : 0
    const drop = t.dropoffUtc ? new Date(t.dropoffUtc).getTime() : 0
    const durationMin = begin && drop ? round((drop - begin) / 60000, 1) : 0
    lines.push([
      t.tripId,
      t.requestUtc,
      t.beginUtc,
      t.pickupLat,
      t.pickupLng,
      t.pickupAddress,
      t.dropoffUtc,
      t.dropoffLat,
      t.dropoffLng,
      t.dropoffAddress,
      t.distanceMiles,
      durationMin,
      t.fare,
      t.tip,
      t.fee,
      t.total,
      t.currency,
      t.status,
      t.product,
      t.city,
      t.surge,
    ].map(csvCell).join(","))
  }
  return lines.join("\n") + "\n"
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function isoUtc(epoch) {
  if (!epoch) return ""
  const d = new Date(epoch)
  const pad = (n) => String(n).padStart(2, "0")
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00 +0000 UTC`
}

function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------

async function main() {
  const trips = generateTrips()
  await fs.mkdir(path.dirname(OUT), { recursive: true })
  await fs.writeFile(OUT, buildCsv(trips), "utf8")
  // Light footprint summary so we can eyeball the fixture without parsing it again.
  const dated = trips.filter(t => t.requestUtc)
  const completedCount = trips.filter(t => t.status === "completed").length
  const cancelledCount = trips.filter(t => /cancel|no_show/.test(t.status)).length
  const refundCount = trips.filter(t => t.status === "refunded").length
  const airportCount = trips.filter(t => /airport/i.test(t.pickupAddress) || /airport/i.test(t.dropoffAddress)).length
  const totalSpend = trips.reduce((acc, t) => acc + (Number(t.total) > 0 ? Number(t.total) : 0), 0)
  console.log(
    `wrote ${OUT}\n` +
    `  rows: ${trips.length}\n` +
    `  completed: ${completedCount}, cancelled: ${cancelledCount}, refunded: ${refundCount}\n` +
    `  airport rows (label match): ${airportCount}\n` +
    `  spend (sum of positive totals): $${totalSpend.toFixed(2)}\n` +
    `  span: ${dated[0]?.requestUtc.slice(0, 10)} → ${dated[dated.length - 1]?.requestUtc.slice(0, 10)}`
  )
}

main().catch((e) => { console.error(e); process.exit(1) })
