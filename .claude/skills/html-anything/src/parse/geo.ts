/**
 * Geo / travel parser. Single dispatcher for the four geo subtypes:
 *
 *   - gpx-route          — GPX `.gpx` (running, cycling, hiking workouts;
 *                          plotted routes from Strava / Garmin / Komoot /
 *                          Apple Health / generic GPS exports). Track
 *                          points may carry `<ele>` and `<time>`; if
 *                          timestamps are present we compute splits +
 *                          moving time.
 *   - kml-route          — KML `.kml` (Google Earth / My Maps). Pulls
 *                          `<Placemark>` blocks and reads `<Point>` and
 *                          `<LineString>` `<coordinates>`. Waypoints +
 *                          a polyline; no <ele>/<time> is assumed.
 *   - travel-itinerary   — multi-day itinerary CSV. Header has a date
 *                          column plus a place-shaped column (location /
 *                          city / destination). Optional time / type /
 *                          notes / cost. Normalized into per-day
 *                          buckets with conflict detection.
 *   - location-history   — Google-Takeout-style location history JSON
 *                          (`{ "locations": [{ timestampMs / timestamp,
 *                          latitudeE7 / longitudeE7 }] }`) or a flat
 *                          CSV with timestamp + lat + lon columns.
 *                          Bucketed into days + dwelled places.
 *
 * Hard constraint: the output is **offline / single self-contained
 * HTML**. We never embed map tiles or call out to a tile provider.
 * The polyline is rendered as inline SVG using an equirectangular
 * projection (cosine-corrected longitude), which is plenty for a 5–
 * 50 km route. World-scale location histories pre-compute a low-poly
 * world outline at the parse step so the LLM can plot dwelled cities
 * without an external basemap.
 *
 * The parser only normalizes — narrative judgement (what's a hard day,
 * which segment is the climb, which place is the "anchor city") is
 * the LLM's job in the geo prompts.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { Parser, ParsedFile } from "../types.js"

// ---------------------------------------------------------------------------
// Public parser
// ---------------------------------------------------------------------------

const GPX_HEAD = /<gpx[\s>]/i
const KML_HEAD = /<kml[\s>]/i

export const parser: Parser = {
  name: "geo",
  matches: [".gpx", ".kml", ".csv", ".tsv", ".json"],
  async detect(filepath: string): Promise<boolean> {
    const ext = path.extname(filepath).toLowerCase()
    if (ext === ".gpx") {
      try {
        const head = await readHead(filepath, 4096)
        return GPX_HEAD.test(head.replace(/^﻿/, ""))
      } catch { return false }
    }
    if (ext === ".kml") {
      try {
        const head = await readHead(filepath, 4096)
        return KML_HEAD.test(head.replace(/^﻿/, ""))
      } catch { return false }
    }
    if (ext === ".csv" || ext === ".tsv") {
      try {
        const head = await readHead(filepath, 4096)
        const firstLine = head.split(/\r?\n/, 1)[0] || ""
        return looksLikeItineraryHeader(firstLine, ext === ".tsv" ? "\t" : detectCsvSep(firstLine))
            || looksLikeLocationHistoryCsvHeader(firstLine, ext === ".tsv" ? "\t" : detectCsvSep(firstLine))
      } catch { return false }
    }
    if (ext === ".json") {
      try {
        const head = await readHead(filepath, 65536)
        // Cheap shape sniff: don't fully parse a possibly-huge dump.
        return looksLikeLocationHistoryJson(head)
      } catch { return false }
    }
    return false
  },
  async parse(filepath: string): Promise<ParsedFile> {
    const ext = path.extname(filepath).toLowerCase()
    const raw = await fs.readFile(filepath, "utf8")
    const meta: Record<string, unknown> & { sourceFile: string; sizeBytes: number } = {
      sourceFile: path.basename(filepath),
      sizeBytes: Buffer.byteLength(raw, "utf8"),
    }
    if (ext === ".gpx") return parseGpx(raw, meta)
    if (ext === ".kml") return parseKml(raw, meta)
    if (ext === ".csv" || ext === ".tsv") {
      const firstLine = raw.split(/\r?\n/, 1)[0] || ""
      const sep = ext === ".tsv" ? "\t" : detectCsvSep(firstLine)
      if (looksLikeLocationHistoryCsvHeader(firstLine, sep)) return parseLocationHistoryCsv(raw, sep, meta)
      return parseItineraryCsv(raw, sep, meta)
    }
    return parseLocationHistoryJson(raw, meta)
  },
}

async function readHead(filepath: string, n: number): Promise<string> {
  const fd = await fs.open(filepath, "r")
  const buf = Buffer.alloc(n)
  const { bytesRead } = await fd.read(buf, 0, buf.length, 0)
  await fd.close()
  return buf.subarray(0, bytesRead).toString("utf8")
}

// ===========================================================================
// GPX parser
// ===========================================================================

interface RoutePoint {
  lat: number
  lon: number
  ele?: number
  t?: string
  tEpoch?: number
}

interface Waypoint {
  lat: number
  lon: number
  name?: string
  ele?: number
  time?: string
  description?: string
}

interface RouteStats {
  pointCount: number
  distanceKm: number
  elapsedSec?: number
  movingSec?: number
  pausedSec?: number
  startTime?: string
  endTime?: string
  elevationGainM?: number
  elevationLossM?: number
  minEleM?: number
  maxEleM?: number
  avgPaceSecPerKm?: number
  movingPaceSecPerKm?: number
  maxSpeedKmh?: number
  avgSpeedKmh?: number
}

interface Track {
  name?: string
  pointCount: number
  bbox: BBox
  stats: RouteStats
  polyline: string
  splits: Split[]
  elevationProfile: Array<{ km: number; ele: number }>
  paceProfile?: Array<{ km: number; paceSecPerKm: number }>
  pauses?: Array<{ atKm: number; durationSec: number; lat: number; lon: number; time?: string }>
}

interface BBox { minLat: number; maxLat: number; minLon: number; maxLon: number }
interface Split {
  km: number
  durationSec?: number
  paceSecPerKm?: number
  elevationGainM?: number
  elevationLossM?: number
  startTime?: string
  endTime?: string
}

function parseGpx(raw: string, meta: Record<string, unknown> & { sourceFile: string; sizeBytes: number }): ParsedFile {
  const cleaned = raw.replace(/^﻿/, "")
  const metadataName = extractFirst(cleaned, /<metadata>([\s\S]*?)<\/metadata>/i, m => decodeXml(extractFirst(m[1], /<name>([\s\S]*?)<\/name>/i, mm => mm[1].trim()) || ""))
  const metadataTime = extractFirst(cleaned, /<metadata>([\s\S]*?)<\/metadata>/i, m => extractFirst(m[1], /<time>([\s\S]*?)<\/time>/i, mm => mm[1].trim()) || "")
  const creator = extractFirst(cleaned, /<gpx[^>]*\bcreator="([^"]*)"/i, m => m[1])

  const waypoints: Waypoint[] = []
  const wptRe = /<wpt\s+([^>]+)>([\s\S]*?)<\/wpt>/gi
  let m: RegExpExecArray | null
  while ((m = wptRe.exec(cleaned)) !== null) {
    const attrs = parseAttrs(m[1])
    const lat = parseFloat(attrs.lat || "")
    const lon = parseFloat(attrs.lon || "")
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    const inner = m[2]
    waypoints.push({
      lat,
      lon,
      name: extractFirst(inner, /<name>([\s\S]*?)<\/name>/i, mm => decodeXml(mm[1].trim())) || undefined,
      ele: extractFloat(inner, /<ele>([\s\S]*?)<\/ele>/i),
      time: extractFirst(inner, /<time>([\s\S]*?)<\/time>/i, mm => mm[1].trim()),
      description: extractFirst(inner, /<desc>([\s\S]*?)<\/desc>/i, mm => decodeXml(mm[1].trim())) || undefined,
    })
  }

  const tracks: Track[] = []
  const trkRe = /<trk>([\s\S]*?)<\/trk>/gi
  let trkM: RegExpExecArray | null
  while ((trkM = trkRe.exec(cleaned)) !== null) {
    const trkInner = trkM[1]
    const name = extractFirst(trkInner, /<name>([\s\S]*?)<\/name>/i, mm => decodeXml(mm[1].trim())) || undefined
    const points: RoutePoint[] = []
    const segRe = /<trkseg>([\s\S]*?)<\/trkseg>/gi
    let segM: RegExpExecArray | null
    while ((segM = segRe.exec(trkInner)) !== null) {
      const segInner = segM[1]
      const ptRe = /<trkpt\s+([^>]+)>([\s\S]*?)<\/trkpt>/gi
      let ptM: RegExpExecArray | null
      while ((ptM = ptRe.exec(segInner)) !== null) {
        const attrs = parseAttrs(ptM[1])
        const lat = parseFloat(attrs.lat || "")
        const lon = parseFloat(attrs.lon || "")
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
        const inner = ptM[2]
        const ele = extractFloat(inner, /<ele>([\s\S]*?)<\/ele>/i)
        const t = extractFirst(inner, /<time>([\s\S]*?)<\/time>/i, mm => mm[1].trim())
        const tEpoch = t ? Date.parse(t) : undefined
        points.push({ lat, lon, ele, t, tEpoch: Number.isFinite(tEpoch as number) ? (tEpoch as number) : undefined })
      }
      // Handle `<trkpt ... />` self-closing form too
      const ptSelfRe = /<trkpt\s+([^/>]+)\/>/gi
      let ptSelfM: RegExpExecArray | null
      while ((ptSelfM = ptSelfRe.exec(segInner)) !== null) {
        const attrs = parseAttrs(ptSelfM[1])
        const lat = parseFloat(attrs.lat || "")
        const lon = parseFloat(attrs.lon || "")
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
        points.push({ lat, lon })
      }
    }
    if (!points.length) continue
    tracks.push(buildTrack(points, name))
  }

  // Some GPX exports use <rte>/<rtept> (a planned route, not a recorded
  // track). Fold those into tracks too.
  const rteRe = /<rte>([\s\S]*?)<\/rte>/gi
  let rteM: RegExpExecArray | null
  while ((rteM = rteRe.exec(cleaned)) !== null) {
    const rteInner = rteM[1]
    const name = extractFirst(rteInner, /<name>([\s\S]*?)<\/name>/i, mm => decodeXml(mm[1].trim())) || undefined
    const points: RoutePoint[] = []
    const ptRe = /<rtept\s+([^>]+?)(?:\/>|>([\s\S]*?)<\/rtept>)/gi
    let ptM: RegExpExecArray | null
    while ((ptM = ptRe.exec(rteInner)) !== null) {
      const attrs = parseAttrs(ptM[1])
      const lat = parseFloat(attrs.lat || "")
      const lon = parseFloat(attrs.lon || "")
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
      const inner = ptM[2] || ""
      const ele = extractFloat(inner, /<ele>([\s\S]*?)<\/ele>/i)
      const t = extractFirst(inner, /<time>([\s\S]*?)<\/time>/i, mm => mm[1].trim())
      const tEpoch = t ? Date.parse(t) : undefined
      points.push({ lat, lon, ele, t, tEpoch: Number.isFinite(tEpoch as number) ? (tEpoch as number) : undefined })
    }
    if (points.length) tracks.push(buildTrack(points, name))
  }

  const totals = sumRouteStats(tracks.map(t => t.stats))
  const dateRange = describeRouteDateRange(tracks)

  meta.format = "gpx"
  meta.kind = "gpx-route"
  meta.routeName = (tracks[0]?.name) || metadataName || meta.sourceFile
  meta.creator = creator
  meta.startTime = totals.startTime
  meta.endTime = totals.endTime
  meta.distanceKm = round2(totals.distanceKm)
  meta.elapsedSec = totals.elapsedSec
  meta.movingSec = totals.movingSec
  meta.elevationGainM = totals.elevationGainM
  meta.pointCount = totals.pointCount
  meta.trackCount = tracks.length
  meta.waypointCount = waypoints.length
  meta.dateRange = dateRange

  const isWorkout = totals.startTime != null && totals.endTime != null
  const summary = isWorkout
    ? `${formatKm(totals.distanceKm)} ${classifyActivity(tracks)} on ${shortDate(totals.startTime)} — ${formatDuration(totals.movingSec || totals.elapsedSec || 0)} ${totals.movingSec && totals.distanceKm ? `at ${formatPace(totals.movingSec / totals.distanceKm)}` : ""}, ${formatElev(totals.elevationGainM)} elevation gain.`
    : `${formatKm(totals.distanceKm)} planned route across ${tracks.length} segment${tracks.length === 1 ? "" : "s"}, ${waypoints.length} waypoint${waypoints.length === 1 ? "" : "s"}, ${formatElev(totals.elevationGainM)} cumulative gain.`

  const data = {
    kind: "route" as const,
    format: "gpx",
    metadata: { name: metadataName, time: metadataTime, creator },
    tracks,
    waypoints,
    totals,
    bbox: unionBboxes(tracks.map(t => t.bbox)),
    activityKind: classifyActivity(tracks),
    isWorkout,
    meta: { ...meta },
  }

  return {
    contentType: "gpx-route",
    summary: summary.replace(/\s+/g, " ").trim(),
    sample: buildRouteSample(data),
    data,
    meta,
  }
}

function buildTrack(points: RoutePoint[], name?: string): Track {
  const bbox = computeBbox(points)
  const stats = computeRouteStats(points)
  const polyline = buildSvgPolyline(points, bbox)
  const splits = computeKmSplits(points)
  const elevationProfile = computeElevationProfile(points, stats.distanceKm)
  const paceProfile = computePaceProfile(points)
  const pauses = computePauses(points)
  return {
    name,
    pointCount: points.length,
    bbox,
    stats,
    polyline,
    splits,
    elevationProfile,
    paceProfile,
    pauses,
  }
}

// ===========================================================================
// KML parser
// ===========================================================================

interface KmlPlacemark {
  name?: string
  description?: string
  kind: "point" | "path"
  point?: { lat: number; lon: number; ele?: number }
  path?: Array<{ lat: number; lon: number; ele?: number }>
}

function parseKml(raw: string, meta: Record<string, unknown> & { sourceFile: string; sizeBytes: number }): ParsedFile {
  const cleaned = raw.replace(/^﻿/, "")
  const docName = extractFirst(cleaned, /<Document[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>/i, m => decodeXml(m[1].trim())) || undefined
  const placemarks: KmlPlacemark[] = []
  const pmRe = /<Placemark[^>]*>([\s\S]*?)<\/Placemark>/gi
  let m: RegExpExecArray | null
  while ((m = pmRe.exec(cleaned)) !== null) {
    const inner = m[1]
    const name = extractFirst(inner, /<name>([\s\S]*?)<\/name>/i, mm => decodeXml(mm[1].trim())) || undefined
    const desc = extractFirst(inner, /<description>([\s\S]*?)<\/description>/i, mm => decodeXml(stripCdata(mm[1].trim()))) || undefined
    // Treat MultiGeometry, gx:Track, and bare LineString as paths.
    const lineCoords = extractAllCoordinates(inner, /<LineString[\s\S]*?<\/LineString>/gi)
    const trackCoords = extractAllCoordinates(inner, /<gx:Track[\s\S]*?<\/gx:Track>/gi)
    const pathCoords = lineCoords.length ? lineCoords : trackCoords
    if (pathCoords.length) {
      placemarks.push({ name, description: desc, kind: "path", path: pathCoords })
      continue
    }
    const pointCoords = extractAllCoordinates(inner, /<Point[\s\S]*?<\/Point>/gi)
    if (pointCoords.length) {
      placemarks.push({ name, description: desc, kind: "point", point: pointCoords[0] })
      continue
    }
  }

  // Build a synthesized "track" from the longest path placemark + waypoints
  // from each <Point> placemark. KML basics; ignores Polygon (areas).
  const paths = placemarks.filter(p => p.kind === "path" && p.path?.length)
  const points = placemarks.filter(p => p.kind === "point" && p.point)

  const tracks: Track[] = []
  for (const p of paths) {
    const pts: RoutePoint[] = (p.path || []).map(c => ({ lat: c.lat, lon: c.lon, ele: c.ele }))
    if (pts.length >= 2) tracks.push(buildTrack(pts, p.name))
  }

  const waypoints: Waypoint[] = points
    .map(p => p.point ? ({ lat: p.point.lat, lon: p.point.lon, ele: p.point.ele, name: p.name, description: p.description } as Waypoint) : null)
    .filter(Boolean) as Waypoint[]

  const totals = sumRouteStats(tracks.map(t => t.stats))
  meta.format = "kml"
  meta.kind = "kml-route"
  meta.routeName = docName || meta.sourceFile
  meta.distanceKm = round2(totals.distanceKm)
  meta.pointCount = totals.pointCount
  meta.trackCount = tracks.length
  meta.waypointCount = waypoints.length

  const summary = tracks.length
    ? `${formatKm(totals.distanceKm)} across ${tracks.length} KML path${tracks.length === 1 ? "" : "s"} and ${waypoints.length} placemark${waypoints.length === 1 ? "" : "s"}; no timestamps — distance + waypoints only.`
    : `${waypoints.length} KML placemark${waypoints.length === 1 ? "" : "s"} (point-only export, no path geometry).`

  const data = {
    kind: "route" as const,
    format: "kml",
    metadata: { name: docName },
    tracks,
    waypoints,
    placemarks,
    totals,
    bbox: tracks.length ? unionBboxes(tracks.map(t => t.bbox)) : computeBbox(waypoints.map(w => ({ lat: w.lat, lon: w.lon }) as RoutePoint)),
    activityKind: "kml-trip",
    isWorkout: false,
    meta: { ...meta },
  }
  return {
    contentType: "kml-route",
    summary,
    sample: buildRouteSample(data),
    data,
    meta,
  }
}

function stripCdata(s: string): string {
  return s.replace(/^<!\[CDATA\[/i, "").replace(/]]>$/i, "").trim()
}

function extractAllCoordinates(inner: string, blockRe: RegExp): Array<{ lat: number; lon: number; ele?: number }> {
  const out: Array<{ lat: number; lon: number; ele?: number }> = []
  let bm: RegExpExecArray | null
  blockRe.lastIndex = 0
  while ((bm = blockRe.exec(inner)) !== null) {
    const block = bm[0]
    const coordsBlocks = block.match(/<coordinates>[\s\S]*?<\/coordinates>/gi) || []
    for (const cb of coordsBlocks) {
      const inner = cb.replace(/<\/?coordinates>/gi, "").trim()
      // KML coordinates are lon,lat[,alt] separated by whitespace.
      const tuples = inner.split(/\s+/).filter(Boolean)
      for (const t of tuples) {
        const parts = t.split(",")
        const lon = parseFloat(parts[0])
        const lat = parseFloat(parts[1])
        const ele = parts[2] !== undefined ? parseFloat(parts[2]) : undefined
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          out.push({ lat, lon, ele: Number.isFinite(ele as number) ? (ele as number) : undefined })
        }
      }
    }
  }
  return out
}

// ===========================================================================
// Travel itinerary CSV parser
// ===========================================================================

const ITIN_DATE = ["date", "day"]
const ITIN_DAYNUM = ["day", "day #", "day number", "day no"]
const ITIN_TIME = ["time", "start", "start time", "when"]
const ITIN_LOCATION = ["location", "place", "destination", "spot", "stop", "venue", "address"]
const ITIN_CITY = ["city", "town"]
const ITIN_COUNTRY = ["country", "region"]
const ITIN_TYPE = ["type", "category", "kind", "activity"]
const ITIN_TITLE = ["title", "name", "activity", "event", "summary"]
const ITIN_NOTES = ["notes", "description", "details", "comment"]
const ITIN_COST = ["cost", "price", "amount", "spend", "total"]
const ITIN_CURRENCY = ["currency", "ccy"]
const ITIN_HOURS = ["hours", "duration", "length"]

interface ItineraryItem {
  id: string
  date?: string
  dateEpoch?: number
  dayNumber?: number
  time?: string
  location?: string
  city?: string
  country?: string
  type?: string
  title: string
  notes?: string
  cost?: number
  currency?: string
  durationHours?: number
}

function looksLikeItineraryHeader(line: string, sep: string): boolean {
  if (!line) return false
  const cells = parseCsvRow(line, sep).map(c => c.trim().toLowerCase())
  if (cells.length < 3) return false
  const has = (cands: string[]) => cands.some(c => cells.includes(c))
  const hasDate = has(ITIN_DATE)
  const hasPlace = has([...ITIN_LOCATION, ...ITIN_CITY])
  const hasItinSignal = has([...ITIN_TYPE, ...ITIN_TITLE, ...ITIN_HOURS, ...ITIN_NOTES, ...ITIN_COUNTRY])
  // Decline if it looks like a finance / issue / chat CSV by smell.
  if (cells.includes("amount") && cells.includes("merchant")) return false
  if (cells.includes("status") && (cells.includes("title") || cells.includes("summary"))) return false
  return hasDate && hasPlace && hasItinSignal
}

function parseItineraryCsv(raw: string, sep: string, meta: Record<string, unknown> & { sourceFile: string; sizeBytes: number }): ParsedFile {
  const rows = parseCsvAll(raw, sep)
  const headers = (rows.shift() || []).map(h => h.trim())
  const headersLc = headers.map(h => h.toLowerCase())

  const findIdx = (cands: string[]) => {
    for (const c of cands) {
      const i = headersLc.indexOf(c)
      if (i >= 0) return i
    }
    return -1
  }

  const dateIdx = findIdx(ITIN_DATE)
  const dayNumIdx = findIdx(ITIN_DAYNUM)
  const timeIdx = findIdx(ITIN_TIME)
  const locIdx = findIdx(ITIN_LOCATION)
  const cityIdx = findIdx(ITIN_CITY)
  const countryIdx = findIdx(ITIN_COUNTRY)
  const typeIdx = findIdx(ITIN_TYPE)
  const titleIdx = findIdx(ITIN_TITLE)
  const notesIdx = findIdx(ITIN_NOTES)
  const costIdx = findIdx(ITIN_COST)
  const currencyIdx = findIdx(ITIN_CURRENCY)
  const hoursIdx = findIdx(ITIN_HOURS)

  const items: ItineraryItem[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (!r || r.every(c => !c.trim())) continue
    const date = dateIdx >= 0 ? (r[dateIdx] || "").trim() : undefined
    const dateEpoch = parseFlexibleDate(date || "")
    const dayNumberRaw = dayNumIdx >= 0 && dayNumIdx !== dateIdx ? (r[dayNumIdx] || "").trim() : ""
    const dayNumber = dayNumberRaw && /^\d+$/.test(dayNumberRaw) ? parseInt(dayNumberRaw, 10) : undefined
    const time = timeIdx >= 0 ? (r[timeIdx] || "").trim() : undefined
    const location = locIdx >= 0 ? (r[locIdx] || "").trim() : undefined
    const city = cityIdx >= 0 ? (r[cityIdx] || "").trim() : undefined
    const country = countryIdx >= 0 ? (r[countryIdx] || "").trim() : undefined
    const type = typeIdx >= 0 ? (r[typeIdx] || "").trim() : undefined
    const titleVal = titleIdx >= 0 ? (r[titleIdx] || "").trim() : ""
    const title = titleVal || location || `Day ${dayNumber || items.length + 1}`
    const notes = notesIdx >= 0 ? (r[notesIdx] || "").trim() : undefined
    const costRaw = costIdx >= 0 ? (r[costIdx] || "").trim() : ""
    const cost = costRaw ? parseFlexibleNumber(costRaw) : undefined
    const currency = currencyIdx >= 0 ? (r[currencyIdx] || "").trim() : undefined
    const hoursRaw = hoursIdx >= 0 ? (r[hoursIdx] || "").trim() : ""
    const durationHours = hoursRaw ? parseFlexibleNumber(hoursRaw) : undefined
    items.push({
      id: `itin_${String(i + 1).padStart(4, "0")}`,
      date,
      dateEpoch,
      dayNumber,
      time,
      location: location || undefined,
      city: city || undefined,
      country: country || undefined,
      type: type || undefined,
      title,
      notes: notes || undefined,
      cost: typeof cost === "number" ? cost : undefined,
      currency: currency || undefined,
      durationHours: typeof durationHours === "number" ? durationHours : undefined,
    })
  }

  // Sort by (date, time) so day buckets come out chronological.
  items.sort((a, b) => {
    const da = a.dateEpoch ?? 0
    const db = b.dateEpoch ?? 0
    if (da !== db) return da - db
    const ta = a.time || ""
    const tb = b.time || ""
    return ta.localeCompare(tb)
  })

  // Day buckets.
  const dayMap = new Map<string, { date: string; dayNumber?: number; items: ItineraryItem[] }>()
  for (const it of items) {
    const key = it.date || (it.dayNumber != null ? `Day ${it.dayNumber}` : "Unscheduled")
    const cur = dayMap.get(key) || { date: key, dayNumber: it.dayNumber, items: [] }
    if (cur.dayNumber == null && it.dayNumber != null) cur.dayNumber = it.dayNumber
    cur.items.push(it)
    dayMap.set(key, cur)
  }
  const days = Array.from(dayMap.values())

  // Conflict detection: two items on the same date with overlapping
  // start times (within 30 minutes).
  const conflicts = detectItineraryConflicts(items)

  // Aggregations.
  const cities = new Map<string, number>()
  const countries = new Map<string, number>()
  const types = new Map<string, number>()
  let totalCost = 0
  let costItems = 0
  for (const it of items) {
    if (it.city) cities.set(it.city, (cities.get(it.city) || 0) + 1)
    if (it.country) countries.set(it.country, (countries.get(it.country) || 0) + 1)
    if (it.type) types.set(it.type.toLowerCase(), (types.get(it.type.toLowerCase()) || 0) + 1)
    if (typeof it.cost === "number") { totalCost += it.cost; costItems++ }
  }

  const datedItems = items.filter(it => it.dateEpoch != null)
  const startEpoch = datedItems[0]?.dateEpoch
  const endEpoch = datedItems[datedItems.length - 1]?.dateEpoch
  const dateRange = describeRange(startEpoch, endEpoch)

  meta.format = "itinerary-csv"
  meta.kind = "travel-itinerary"
  meta.itemCount = items.length
  meta.dayCount = days.length
  meta.dateRange = dateRange
  meta.cities = Array.from(cities.keys())
  meta.countries = Array.from(countries.keys())
  meta.headers = headers
  meta.detectedColumns = {
    date: dateIdx >= 0 ? headers[dateIdx] : null,
    location: locIdx >= 0 ? headers[locIdx] : null,
    city: cityIdx >= 0 ? headers[cityIdx] : null,
    country: countryIdx >= 0 ? headers[countryIdx] : null,
    type: typeIdx >= 0 ? headers[typeIdx] : null,
  }

  const data = {
    kind: "itinerary" as const,
    format: "itinerary-csv",
    items,
    days,
    conflicts,
    cities: Array.from(cities.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    countries: Array.from(countries.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    types: Array.from(types.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    totals: {
      items: items.length,
      days: days.length,
      cities: cities.size,
      countries: countries.size,
      totalCost: costItems ? round2(totalCost) : undefined,
      costItems,
    },
    headers,
    meta: { ...meta },
  }

  return {
    contentType: "travel-itinerary",
    summary: `${items.length} itinerary item${items.length === 1 ? "" : "s"} across ${days.length} day${days.length === 1 ? "" : "s"} (${dateRange}); ${cities.size} cit${cities.size === 1 ? "y" : "ies"}, ${countries.size} countr${countries.size === 1 ? "y" : "ies"}.`,
    sample: buildItinerarySample(data),
    data,
    meta,
  }
}

function detectItineraryConflicts(items: ItineraryItem[]): Array<{ date?: string; items: ItineraryItem[] }> {
  const byDate = new Map<string, ItineraryItem[]>()
  for (const it of items) {
    if (!it.date || !it.time) continue
    const arr = byDate.get(it.date) || []
    arr.push(it)
    byDate.set(it.date, arr)
  }
  const conflicts: Array<{ date?: string; items: ItineraryItem[] }> = []
  for (const [date, arr] of byDate.entries()) {
    arr.sort((a, b) => (a.time || "").localeCompare(b.time || ""))
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i]
      const aMin = parseTimeMin(a.time)
      if (aMin == null) continue
      const aDur = (a.durationHours ?? 1) * 60
      for (let j = i + 1; j < arr.length; j++) {
        const b = arr[j]
        const bMin = parseTimeMin(b.time)
        if (bMin == null) continue
        // Overlap if b starts before a ends.
        if (bMin < aMin + aDur - 1) {
          conflicts.push({ date, items: [a, b] })
        } else break
      }
    }
  }
  return conflicts
}

function parseTimeMin(s: string | undefined): number | null {
  if (!s) return null
  const m = /^(\d{1,2}):(\d{2})/.exec(s.trim())
  if (!m) return null
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
}

// ===========================================================================
// Location history (Google Takeout JSON or flat CSV)
// ===========================================================================

interface LocPoint {
  t: string
  tEpoch: number
  lat: number
  lon: number
  accuracy?: number
  activity?: string
}

const LH_LAT = ["lat", "latitude", "latitude_e7", "latitude e7"]
const LH_LON = ["lon", "lng", "longitude", "longitude_e7", "longitude e7"]
const LH_TIME = ["timestamp", "time", "datetime", "date", "ts", "timestamp_ms", "timestamp ms"]

function looksLikeLocationHistoryCsvHeader(line: string, sep: string): boolean {
  if (!line) return false
  const cells = parseCsvRow(line, sep).map(c => c.trim().toLowerCase())
  if (cells.length < 3) return false
  const hasLat = cells.some(c => LH_LAT.includes(c))
  const hasLon = cells.some(c => LH_LON.includes(c))
  const hasTime = cells.some(c => LH_TIME.includes(c))
  return hasLat && hasLon && hasTime
}

function looksLikeLocationHistoryJson(head: string): boolean {
  // Cheap signal: a `"locations"` array near the start, with at least
  // one `"latitudeE7"` or `"latitude_e7"` or `"latitude":` key. Also
  // accept the flat-array shape `[{ "lat":…, "lon":… }]` — common in
  // hobby exports.
  if (/"locations"\s*:\s*\[/.test(head) && /"latitudeE7"|"longitudeE7"|"latitude"|"longitude"/.test(head)) return true
  if (/^\s*\[\s*\{[\s\S]{0,200}"lat"\s*:/.test(head) && /"lon"\s*:|"lng"\s*:|"longitude"\s*:/.test(head)) return true
  return false
}

function parseLocationHistoryJson(raw: string, meta: Record<string, unknown> & { sourceFile: string; sizeBytes: number }): ParsedFile {
  let root: unknown
  try { root = JSON.parse(raw) } catch { root = null }
  const arr: unknown[] = Array.isArray(root)
    ? root
    : (root && typeof root === "object" && Array.isArray((root as { locations?: unknown[] }).locations))
      ? (root as { locations: unknown[] }).locations
      : []
  const points: LocPoint[] = []
  for (const r of arr) {
    if (!r || typeof r !== "object") continue
    const o = r as Record<string, unknown>
    let lat: number | undefined
    let lon: number | undefined
    if (typeof o.latitudeE7 === "number") lat = (o.latitudeE7 as number) / 1e7
    else if (typeof o.latitude === "number") lat = o.latitude as number
    else if (typeof o.lat === "number") lat = o.lat as number
    if (typeof o.longitudeE7 === "number") lon = (o.longitudeE7 as number) / 1e7
    else if (typeof o.longitude === "number") lon = o.longitude as number
    else if (typeof o.lon === "number") lon = o.lon as number
    else if (typeof o.lng === "number") lon = o.lng as number
    if (!Number.isFinite(lat as number) || !Number.isFinite(lon as number)) continue
    let tEpoch: number | undefined
    if (typeof o.timestampMs === "string") tEpoch = parseInt(o.timestampMs, 10)
    else if (typeof o.timestampMs === "number") tEpoch = o.timestampMs
    else if (typeof o.timestamp === "string") {
      const v = Date.parse(o.timestamp as string)
      tEpoch = Number.isFinite(v) ? v : undefined
    } else if (typeof o.timestamp === "number") {
      tEpoch = o.timestamp > 1e12 ? (o.timestamp as number) : (o.timestamp as number) * 1000
    } else if (typeof o.time === "string") {
      const v = Date.parse(o.time as string)
      tEpoch = Number.isFinite(v) ? v : undefined
    }
    if (!Number.isFinite(tEpoch as number)) continue
    const accuracy = typeof o.accuracy === "number" ? (o.accuracy as number) : undefined
    let activity: string | undefined
    if (Array.isArray(o.activity)) {
      const first = (o.activity as Array<{ activity?: Array<{ type?: string; confidence?: number }> }>)[0]
      const inner = first?.activity?.[0]
      if (inner?.type) activity = inner.type as string
    } else if (typeof o.activity === "string") {
      activity = o.activity as string
    }
    points.push({
      t: new Date(tEpoch as number).toISOString(),
      tEpoch: tEpoch as number,
      lat: lat as number,
      lon: lon as number,
      accuracy,
      activity,
    })
  }
  return finalizeLocationHistory(points, meta, "location-history-json")
}

function parseLocationHistoryCsv(raw: string, sep: string, meta: Record<string, unknown> & { sourceFile: string; sizeBytes: number }): ParsedFile {
  const rows = parseCsvAll(raw, sep)
  const headers = (rows.shift() || []).map(h => h.trim())
  const headersLc = headers.map(h => h.toLowerCase())
  const findIdx = (cands: string[]) => {
    for (const c of cands) {
      const i = headersLc.indexOf(c)
      if (i >= 0) return i
    }
    return -1
  }
  const latIdx = findIdx(LH_LAT)
  const lonIdx = findIdx(LH_LON)
  const tIdx = findIdx(LH_TIME)
  const accuracyIdx = headersLc.findIndex(h => h === "accuracy" || h === "accuracy_m" || h === "horizontal_accuracy")
  const activityIdx = headersLc.findIndex(h => h === "activity" || h === "type" || h === "kind")

  const isE7Lat = headers[latIdx] && /e7$/i.test(headers[latIdx])
  const isE7Lon = headers[lonIdx] && /e7$/i.test(headers[lonIdx])

  const points: LocPoint[] = []
  for (const r of rows) {
    if (!r || r.every(c => !c.trim())) continue
    const latRaw = parseFlexibleNumber(r[latIdx] || "")
    const lonRaw = parseFlexibleNumber(r[lonIdx] || "")
    if (typeof latRaw !== "number" || typeof lonRaw !== "number") continue
    const lat = isE7Lat ? latRaw / 1e7 : latRaw
    const lon = isE7Lon ? lonRaw / 1e7 : lonRaw
    const tStr = (r[tIdx] || "").trim()
    let tEpoch: number | undefined
    if (/^\d{10,}$/.test(tStr)) {
      const n = parseInt(tStr, 10)
      tEpoch = n > 1e12 ? n : n * 1000
    } else {
      const v = Date.parse(tStr)
      tEpoch = Number.isFinite(v) ? v : undefined
    }
    if (!Number.isFinite(tEpoch as number)) continue
    points.push({
      t: new Date(tEpoch as number).toISOString(),
      tEpoch: tEpoch as number,
      lat,
      lon,
      accuracy: accuracyIdx >= 0 ? parseFlexibleNumber(r[accuracyIdx] || "") || undefined : undefined,
      activity: activityIdx >= 0 ? (r[activityIdx] || "").trim() || undefined : undefined,
    })
  }
  return finalizeLocationHistory(points, meta, "location-history-csv")
}

function finalizeLocationHistory(points: LocPoint[], meta: Record<string, unknown> & { sourceFile: string; sizeBytes: number }, format: string): ParsedFile {
  points.sort((a, b) => a.tEpoch - b.tEpoch)
  const startEpoch = points[0]?.tEpoch
  const endEpoch = points[points.length - 1]?.tEpoch

  // Cluster into "places" using ~250m grid (lat/lon rounded to 3 dp ≈
  // 110m × 110·cos(lat) m); aggregate dwell time per cluster.
  const placeMap = new Map<string, { lat: number; lon: number; visits: number; minutes: number }>()
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const key = `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`
    const cur = placeMap.get(key) || { lat: 0, lon: 0, visits: 0, minutes: 0 }
    cur.lat += p.lat
    cur.lon += p.lon
    cur.visits++
    if (i + 1 < points.length) {
      const dt = (points[i + 1].tEpoch - p.tEpoch) / 60_000
      // Cap any single gap at 2h to avoid sleep gaps poisoning dwell time.
      cur.minutes += Math.min(dt, 120)
    }
    placeMap.set(key, cur)
  }
  const places = Array.from(placeMap.entries())
    .map(([key, v]) => ({
      key,
      lat: round5(v.lat / v.visits),
      lon: round5(v.lon / v.visits),
      visits: v.visits,
      minutes: Math.round(v.minutes),
    }))
    .sort((a, b) => b.minutes - a.minutes)

  // Day buckets.
  const dayMap = new Map<string, { date: string; pointCount: number; uniquePlaces: number }>()
  const seenPlacePerDay = new Map<string, Set<string>>()
  for (const p of points) {
    const date = new Date(p.tEpoch).toISOString().slice(0, 10)
    const key = `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`
    const set = seenPlacePerDay.get(date) || new Set<string>()
    set.add(key)
    seenPlacePerDay.set(date, set)
    const cur = dayMap.get(date) || { date, pointCount: 0, uniquePlaces: 0 }
    cur.pointCount++
    cur.uniquePlaces = set.size
    dayMap.set(date, cur)
  }
  const days = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date))

  // Activity by hour of day.
  const hourCounts = Array.from({ length: 24 }, () => 0)
  for (const p of points) hourCounts[new Date(p.tEpoch).getUTCHours()]++

  // Bbox + simple inline-SVG world projection helpers (cosine-corrected
  // equirectangular). The LLM gets a pre-projected polyline + city dots,
  // since it never sees the full points list.
  const bbox = computeBbox(points.map(p => ({ lat: p.lat, lon: p.lon }) as RoutePoint))

  // Top-N places: keep the heaviest 100 in the sample so the LLM can
  // pick a story.
  const topPlaces = places.slice(0, 100)

  meta.format = format
  meta.kind = "location-history"
  meta.pointCount = points.length
  meta.placeCount = places.length
  meta.dayCount = days.length
  meta.dateRange = describeRange(startEpoch, endEpoch)
  meta.startTime = startEpoch ? new Date(startEpoch).toISOString() : undefined
  meta.endTime = endEpoch ? new Date(endEpoch).toISOString() : undefined

  const data = {
    kind: "location-history" as const,
    format,
    points,
    places,
    days,
    hourCounts,
    bbox,
    totals: {
      points: points.length,
      uniquePlaces: places.length,
      days: days.length,
    },
    topPlaces,
    meta: { ...meta },
  }

  return {
    contentType: "location-history",
    summary: `${points.length} location ping${points.length === 1 ? "" : "s"} across ${days.length} day${days.length === 1 ? "" : "s"} (${meta.dateRange}); ${places.length} unique places, top dwell at (${topPlaces[0]?.lat ?? "—"}, ${topPlaces[0]?.lon ?? "—"}).`,
    sample: {
      shape: "location-history",
      pointCount: points.length,
      dateRange: meta.dateRange,
      bbox,
      topPlaces: topPlaces.slice(0, 20),
      days: days.slice(0, 30),
      hourCounts,
      sample: points.slice(0, 12).concat(points.length > 16 ? points.slice(-4) : []),
    },
    data,
    meta,
  }
}

// ===========================================================================
// Shared route helpers (distance, splits, projection)
// ===========================================================================

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLon = ((b.lon - a.lon) * Math.PI) / 180
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function computeBbox(points: RoutePoint[]): BBox {
  if (!points.length) return { minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 }
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat
    if (p.lat > maxLat) maxLat = p.lat
    if (p.lon < minLon) minLon = p.lon
    if (p.lon > maxLon) maxLon = p.lon
  }
  return { minLat, maxLat, minLon, maxLon }
}

function unionBboxes(boxes: BBox[]): BBox {
  if (!boxes.length) return { minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 }
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity
  for (const b of boxes) {
    if (b.minLat < minLat) minLat = b.minLat
    if (b.maxLat > maxLat) maxLat = b.maxLat
    if (b.minLon < minLon) minLon = b.minLon
    if (b.maxLon > maxLon) maxLon = b.maxLon
  }
  return { minLat, maxLat, minLon, maxLon }
}

function computeRouteStats(points: RoutePoint[]): RouteStats {
  let distanceKm = 0
  let elevationGainM = 0
  let elevationLossM = 0
  let movingSec = 0
  let pausedSec = 0
  let elapsedSec: number | undefined
  let maxSpeedKmh = 0
  let minEle: number | undefined, maxEle: number | undefined
  const startEpoch = points[0]?.tEpoch
  const endEpoch = points[points.length - 1]?.tEpoch
  if (startEpoch != null && endEpoch != null) elapsedSec = Math.round((endEpoch - startEpoch) / 1000)

  // Smooth elevation a bit so noisy GPS doesn't inflate the gain. 5-pt
  // moving-mean.
  const eles = points.map(p => p.ele)
  const smoothedEle = smoothMean(eles, 5)
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (typeof p.ele === "number") {
      if (minEle == null || p.ele < minEle) minEle = p.ele
      if (maxEle == null || p.ele > maxEle) maxEle = p.ele
    }
    if (i === 0) continue
    const prev = points[i - 1]
    const segKm = haversineKm(prev, p)
    distanceKm += segKm
    const dt = (prev.tEpoch != null && p.tEpoch != null) ? (p.tEpoch - prev.tEpoch) / 1000 : 0
    if (dt > 0 && segKm > 0) {
      const speedKmh = (segKm / dt) * 3600
      if (speedKmh > maxSpeedKmh && speedKmh < 80) maxSpeedKmh = speedKmh
      // Dwell threshold: less than 0.5 m/s is considered paused.
      if (segKm * 1000 / dt > 0.5) movingSec += dt
      else pausedSec += dt
    }
    const eA = smoothedEle[i - 1]
    const eB = smoothedEle[i]
    if (typeof eA === "number" && typeof eB === "number") {
      const d = eB - eA
      if (d > 0.3) elevationGainM += d
      else if (d < -0.3) elevationLossM += -d
    }
  }
  const stats: RouteStats = {
    pointCount: points.length,
    distanceKm: round3(distanceKm),
    elapsedSec,
    movingSec: movingSec ? Math.round(movingSec) : undefined,
    pausedSec: pausedSec ? Math.round(pausedSec) : undefined,
    elevationGainM: elevationGainM ? Math.round(elevationGainM) : undefined,
    elevationLossM: elevationLossM ? Math.round(elevationLossM) : undefined,
    minEleM: minEle != null ? Math.round(minEle) : undefined,
    maxEleM: maxEle != null ? Math.round(maxEle) : undefined,
    maxSpeedKmh: maxSpeedKmh > 0 ? round1(maxSpeedKmh) : undefined,
    startTime: points[0]?.t,
    endTime: points[points.length - 1]?.t,
  }
  if (movingSec > 0 && distanceKm > 0) {
    stats.movingPaceSecPerKm = Math.round(movingSec / distanceKm)
    stats.avgSpeedKmh = round1((distanceKm / (movingSec / 3600)))
  }
  if (elapsedSec != null && distanceKm > 0) {
    stats.avgPaceSecPerKm = Math.round(elapsedSec / distanceKm)
  }
  return stats
}

function smoothMean(arr: Array<number | undefined>, win: number): Array<number | undefined> {
  const out: Array<number | undefined> = []
  for (let i = 0; i < arr.length; i++) {
    let sum = 0, n = 0
    for (let j = -Math.floor(win / 2); j <= Math.floor(win / 2); j++) {
      const k = i + j
      if (k < 0 || k >= arr.length) continue
      const v = arr[k]
      if (typeof v === "number") { sum += v; n++ }
    }
    out.push(n ? sum / n : undefined)
  }
  return out
}

function buildSvgPolyline(points: RoutePoint[], bbox: BBox): string {
  if (!points.length) return ""
  const targetMaxPoints = 400
  const stride = Math.max(1, Math.ceil(points.length / targetMaxPoints))
  const downsampled: RoutePoint[] = []
  for (let i = 0; i < points.length; i += stride) downsampled.push(points[i])
  if (downsampled[downsampled.length - 1] !== points[points.length - 1]) {
    downsampled.push(points[points.length - 1])
  }
  // Pick a 1000 × N viewBox preserving aspect (cosine-corrected lon).
  const avgLat = (bbox.minLat + bbox.maxLat) / 2
  const lonScale = Math.cos((avgLat * Math.PI) / 180)
  const dLat = Math.max(1e-7, bbox.maxLat - bbox.minLat)
  const dLon = Math.max(1e-7, (bbox.maxLon - bbox.minLon) * lonScale)
  const W = 1000
  const H = Math.max(50, Math.round((dLat / dLon) * W))
  const sx = W / dLon
  const sy = H / dLat
  const parts: string[] = []
  for (const p of downsampled) {
    const x = ((p.lon - bbox.minLon) * lonScale) * sx
    const y = (bbox.maxLat - p.lat) * sy
    parts.push(`${round1(x)},${round1(y)}`)
  }
  return `viewBox="0 0 ${W} ${H}" points="${parts.join(" ")}"`
}

function computeKmSplits(points: RoutePoint[]): Split[] {
  if (points.length < 2) return []
  const splits: Split[] = []
  let runningKm = 0
  let nextSplit = 1
  let splitStartTime = points[0].tEpoch
  let splitStartEle = points[0].ele
  let splitGain = 0
  let splitLoss = 0
  for (let i = 1; i < points.length; i++) {
    const segKm = haversineKm(points[i - 1], points[i])
    runningKm += segKm
    if (typeof points[i].ele === "number" && typeof points[i - 1].ele === "number") {
      const d = (points[i].ele as number) - (points[i - 1].ele as number)
      if (d > 0.3) splitGain += d
      else if (d < -0.3) splitLoss += -d
    }
    while (runningKm >= nextSplit) {
      const splitEnd = points[i].tEpoch
      const splitStartTimeIso = splitStartTime != null ? new Date(splitStartTime).toISOString() : undefined
      const splitEndTimeIso = splitEnd != null ? new Date(splitEnd).toISOString() : undefined
      let durationSec: number | undefined
      let paceSecPerKm: number | undefined
      if (splitStartTime != null && splitEnd != null) {
        durationSec = Math.round((splitEnd - splitStartTime) / 1000)
        if (durationSec > 0) paceSecPerKm = Math.round(durationSec)
      }
      splits.push({
        km: nextSplit,
        durationSec,
        paceSecPerKm,
        elevationGainM: splitGain ? Math.round(splitGain) : undefined,
        elevationLossM: splitLoss ? Math.round(splitLoss) : undefined,
        startTime: splitStartTimeIso,
        endTime: splitEndTimeIso,
      })
      splitStartTime = splitEnd
      splitStartEle = points[i].ele
      splitGain = 0
      splitLoss = 0
      nextSplit += 1
      if (nextSplit > 200) break
    }
    if (nextSplit > 200) break
  }
  return splits
}

function computeElevationProfile(points: RoutePoint[], totalKm: number): Array<{ km: number; ele: number }> {
  if (!totalKm || points.length < 2) return []
  const profile: Array<{ km: number; ele: number }> = []
  const samples = 200
  let cumKm = 0
  let nextSample = 0
  for (let i = 1; i < points.length; i++) {
    cumKm += haversineKm(points[i - 1], points[i])
    while (cumKm >= (nextSample / samples) * totalKm && nextSample <= samples) {
      const ele = points[i].ele
      if (typeof ele === "number") {
        profile.push({ km: round3((nextSample / samples) * totalKm), ele: round1(ele) })
      }
      nextSample++
    }
  }
  return profile
}

function computePaceProfile(points: RoutePoint[]): Array<{ km: number; paceSecPerKm: number }> | undefined {
  // Only meaningful when timestamps exist.
  if (points.length < 4 || points[0].tEpoch == null) return undefined
  const profile: Array<{ km: number; paceSecPerKm: number }> = []
  const window = 200 // meters; rolling pace
  let i = 0
  let cumKm = 0
  let lastKm = 0
  while (i < points.length - 1) {
    let segKm = 0
    let segSec = 0
    let j = i
    while (j < points.length - 1 && segKm * 1000 < window) {
      const a = points[j]
      const b = points[j + 1]
      segKm += haversineKm(a, b)
      if (a.tEpoch != null && b.tEpoch != null) segSec += (b.tEpoch - a.tEpoch) / 1000
      j++
    }
    cumKm += segKm
    if (segSec > 0 && segKm > 0) {
      const pace = Math.round(segSec / segKm)
      if (pace < 1800) profile.push({ km: round3(cumKm), paceSecPerKm: pace })
    }
    i = j
    if (cumKm - lastKm < 0.05) break
    lastKm = cumKm
    if (profile.length > 200) break
  }
  return profile
}

function computePauses(points: RoutePoint[]): Array<{ atKm: number; durationSec: number; lat: number; lon: number; time?: string }> {
  if (points.length < 3 || points[0].tEpoch == null) return []
  const pauses: Array<{ atKm: number; durationSec: number; lat: number; lon: number; time?: string }> = []
  let cumKm = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const segKm = haversineKm(a, b)
    cumKm += segKm
    const dt = (a.tEpoch != null && b.tEpoch != null) ? (b.tEpoch - a.tEpoch) / 1000 : 0
    // Pause: time gap > 30s with movement < 5m.
    if (dt > 30 && segKm * 1000 < 5) {
      pauses.push({ atKm: round3(cumKm), durationSec: Math.round(dt), lat: a.lat, lon: a.lon, time: a.t })
    }
  }
  return pauses.sort((x, y) => y.durationSec - x.durationSec).slice(0, 6)
}

function sumRouteStats(arr: RouteStats[]): RouteStats & { trackCount: number } {
  let pointCount = 0, distanceKm = 0
  let elevationGainM = 0
  let movingSec = 0, elapsedSec = 0
  let maxSpeedKmh = 0
  let startTime: string | undefined, endTime: string | undefined
  for (const s of arr) {
    pointCount += s.pointCount
    distanceKm += s.distanceKm
    if (s.elevationGainM) elevationGainM += s.elevationGainM
    if (s.movingSec) movingSec += s.movingSec
    if (s.elapsedSec) elapsedSec += s.elapsedSec
    if (s.maxSpeedKmh && s.maxSpeedKmh > maxSpeedKmh) maxSpeedKmh = s.maxSpeedKmh
    if (s.startTime && (!startTime || s.startTime < startTime)) startTime = s.startTime
    if (s.endTime && (!endTime || s.endTime > endTime)) endTime = s.endTime
  }
  return {
    pointCount,
    distanceKm: round3(distanceKm),
    elapsedSec: elapsedSec || undefined,
    movingSec: movingSec || undefined,
    elevationGainM: elevationGainM || undefined,
    maxSpeedKmh: maxSpeedKmh || undefined,
    startTime,
    endTime,
    trackCount: arr.length,
  }
}

function classifyActivity(tracks: Track[]): "run" | "ride" | "walk" | "hike" | "trip" {
  // Heuristic from average moving speed.
  const stats = sumRouteStats(tracks.map(t => t.stats))
  if (!stats.movingSec || !stats.distanceKm) return "trip"
  const kmh = (stats.distanceKm / (stats.movingSec / 3600))
  if (kmh > 14) return "ride"
  if (kmh > 7) return "run"
  if (kmh > 4) return "hike"
  return "walk"
}

function describeRouteDateRange(tracks: Track[]): string {
  const starts = tracks.map(t => t.stats.startTime).filter(Boolean) as string[]
  const ends = tracks.map(t => t.stats.endTime).filter(Boolean) as string[]
  if (!starts.length) return "no timestamps"
  const start = starts.sort()[0]
  const end = ends.length ? ends.sort()[ends.length - 1] : start
  const a = start.slice(0, 10)
  const b = end.slice(0, 10)
  if (a === b) return a
  return `${a} → ${b}`
}

// ===========================================================================
// Sample builders
// ===========================================================================

function buildRouteSample(data: { tracks: Track[]; waypoints: Waypoint[]; totals: ReturnType<typeof sumRouteStats>; bbox: BBox; format: string; activityKind: string; isWorkout: boolean }): Record<string, unknown> {
  return {
    shape: "route",
    format: data.format,
    activityKind: data.activityKind,
    isWorkout: data.isWorkout,
    bbox: data.bbox,
    totals: data.totals,
    tracks: data.tracks.map(t => ({
      name: t.name,
      pointCount: t.pointCount,
      bbox: t.bbox,
      stats: t.stats,
      polyline: t.polyline,
      splits: t.splits,
      pauses: t.pauses,
      elevationProfile: t.elevationProfile.slice(0, 50),
      paceProfile: t.paceProfile?.slice(0, 50),
    })),
    waypoints: data.waypoints.slice(0, 30),
  }
}

function buildItinerarySample(data: { items: ItineraryItem[]; days: Array<{ date: string; dayNumber?: number; items: ItineraryItem[] }>; conflicts: Array<{ date?: string; items: ItineraryItem[] }>; cities: Array<{ name: string; count: number }>; countries: Array<{ name: string; count: number }>; types: Array<{ name: string; count: number }>; totals: { items: number; days: number; cities: number; countries: number; totalCost?: number; costItems: number } }): Record<string, unknown> {
  return {
    shape: "itinerary",
    totals: data.totals,
    cities: data.cities.slice(0, 12),
    countries: data.countries.slice(0, 8),
    types: data.types.slice(0, 12),
    days: data.days.slice(0, 12).map(d => ({
      date: d.date,
      dayNumber: d.dayNumber,
      itemCount: d.items.length,
      items: d.items.slice(0, 8),
    })),
    conflicts: data.conflicts.slice(0, 6),
    sample: data.items.slice(0, 12).concat(data.items.length > 16 ? data.items.slice(-4) : []),
  }
}

// ===========================================================================
// Helpers
// ===========================================================================

function parseAttrs(blob: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Za-z_:][A-Za-z0-9_:.\-]*)\s*=\s*"([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(blob)) !== null) out[m[1].toLowerCase()] = m[2]
  return out
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)]]>/g, (_, x) => x)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
}

function extractFirst<T>(haystack: string, re: RegExp, pick: (m: RegExpExecArray) => T | undefined): T | undefined {
  const m = re.exec(haystack)
  return m ? pick(m) : undefined
}

function extractFloat(haystack: string, re: RegExp): number | undefined {
  const m = re.exec(haystack)
  if (!m) return undefined
  const v = parseFloat(m[1].trim())
  return Number.isFinite(v) ? v : undefined
}

function detectCsvSep(line: string): string {
  if (line.includes("\t")) return "\t"
  if (line.includes(";") && !line.includes(",")) return ";"
  return ","
}

function parseCsvRow(line: string, sep: string): string[] {
  const out: string[] = []
  let cell = ""
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cell += '"'; i++ }
        else inQuote = false
      } else cell += ch
    } else {
      if (ch === '"') inQuote = true
      else if (ch === sep) { out.push(cell); cell = "" }
      else cell += ch
    }
  }
  out.push(cell)
  return out
}

function parseCsvAll(raw: string, sep: string): string[][] {
  const rows: string[][] = []
  let cur: string[] = []
  let cell = ""
  let inQuote = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (inQuote) {
      if (ch === '"') {
        if (raw[i + 1] === '"') { cell += '"'; i++ }
        else inQuote = false
      } else cell += ch
    } else {
      if (ch === '"') inQuote = true
      else if (ch === sep) { cur.push(cell); cell = "" }
      else if (ch === "\r") { /* skip */ }
      else if (ch === "\n") { cur.push(cell); rows.push(cur); cur = []; cell = "" }
      else cell += ch
    }
  }
  if (cell.length > 0 || cur.length > 0) { cur.push(cell); rows.push(cur) }
  return rows
}

function parseFlexibleNumber(s: string): number | undefined {
  if (!s) return undefined
  const cleaned = s.replace(/[\s,$£€¥]/g, "").trim()
  if (!cleaned) return undefined
  const v = parseFloat(cleaned)
  return Number.isFinite(v) ? v : undefined
}

function parseFlexibleDate(s: string): number | undefined {
  if (!s) return undefined
  const trimmed = s.trim()
  if (!trimmed) return undefined
  const d = Date.parse(trimmed)
  if (Number.isFinite(d)) return d
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(trimmed)
  if (m) {
    let [, a, b, y] = m
    if (y.length === 2) y = (parseInt(y, 10) >= 70 ? "19" : "20") + y
    const t = Date.UTC(+y, +a - 1, +b)
    if (Number.isFinite(t)) return t
  }
  return undefined
}

function describeRange(startEpoch: number | undefined, endEpoch: number | undefined): string {
  if (!startEpoch) return "no dates"
  const a = new Date(startEpoch).toISOString().slice(0, 10)
  if (!endEpoch || endEpoch === startEpoch) return a
  const b = new Date(endEpoch).toISOString().slice(0, 10)
  return `${a} → ${b}`
}

function shortDate(s?: string): string {
  if (!s) return ""
  return s.slice(0, 10)
}

function formatKm(km: number): string {
  if (!Number.isFinite(km) || km <= 0) return "0 km"
  if (km < 1) return `${Math.round(km * 1000)} m`
  return `${km < 10 ? km.toFixed(2) : km.toFixed(1)} km`
}

function formatDuration(sec: number): string {
  if (!sec) return "0s"
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.round(sec % 60)
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`
  return `${s}s`
}

function formatPace(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60)
  const s = Math.round(secPerKm % 60)
  return `${m}:${String(s).padStart(2, "0")}/km`
}

function formatElev(m?: number): string {
  if (!m || m < 1) return "0 m"
  return `${Math.round(m)} m`
}

function round1(n: number): number { return Math.round(n * 10) / 10 }
function round2(n: number): number { return Math.round(n * 100) / 100 }
function round3(n: number): number { return Math.round(n * 1000) / 1000 }
function round5(n: number): number { return Math.round(n * 100000) / 100000 }
