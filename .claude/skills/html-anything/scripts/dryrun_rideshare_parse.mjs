#!/usr/bin/env node
/**
 * Quick dry-run: parse the synthetic rideshare fixture and print a
 * compact summary so we can verify aggregations without having to
 * regenerate the full HTML output.
 */
import { pickParser } from "../dist/parse/index.js"

const file = process.argv[2] || "examples/travel-history/input.csv"
const parser = await pickParser(file)
if (!parser || parser.name !== "rideshare-history") {
  console.error(`expected rideshare-history parser, got ${parser?.name || "(none)"}`)
  process.exit(1)
}
const parsed = await parser.parse(file)
const d = parsed.data

console.log("==", parsed.contentType)
console.log(parsed.summary)
console.log("rows:", d.rows.length, "geo.hasCoordinates:", d.geo.hasCoordinates, "geo.points:", d.geo.points.length)
console.log("monthly buckets:", d.monthly.length, "yearly:", d.yearly.length, "heatmap cells:", d.heatmap.length)
console.log("cities:", d.cities.length, d.cities.slice(0, 4))
console.log("top pickups:", d.pickupPlaces.slice(0, 3))
console.log("top dropoffs:", d.dropoffPlaces.slice(0, 3))
console.log("products:", d.productTypes.slice(0, 4))
console.log("distance buckets:", d.distanceBuckets)
console.log("money:", { fare: d.money.fare, tip: d.money.tip, fee: d.money.fee, refund: d.money.refund, total: d.money.total })
console.log("flags:", d.flags.map(f => ({ kind: f.kind, label: f.label, n: f.rowIds.length })))
console.log("late-night share:", d.summary.lateNightShare, "weekend share:", d.summary.weekendShare, "airport share:", d.summary.airportShare)
console.log("busiest:", { city: d.summary.busiestCity, month: d.summary.busiestMonth, weekday: d.summary.busiestWeekday })
console.log("top:", { pickup: d.summary.topPickup, dropoff: d.summary.topDropoff, product: d.summary.topProduct })
