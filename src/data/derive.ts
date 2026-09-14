import type { Dataset } from './load.ts'
import { STAGES, type Confidence, type FacilityFeature, type Flow, type Mineral, type Stage } from './schema.ts'

/**
 * Everything between the validated dataset and what the globe draws: filtering,
 * value resolution, arc geometry, and the width scale. Kept out of the
 * components so the rules are testable and so no component ever branches on a
 * specific mineral id.
 */

/* ------------------------------------------------------------------ filters */

/**
 * An empty array means "no filter applied", not "nothing selected". Adding a
 * year or region filter later means adding a field here and a clause in the
 * two match functions, not touching any component.
 */
export interface Filters {
  mineralIds: string[]
  stages: Stage[]
  /** Flows below this resolved value are dropped before the arc cap. 0 means no threshold. */
  minValueUsd: number
}

export const EMPTY_FILTERS: Filters = { mineralIds: [], stages: [], minValueUsd: 0 }

/**
 * Filters round-trip through the query string so a view is shareable. Empty
 * groups are omitted rather than written as empty params, so the default view
 * has a clean URL.
 */
export function filtersToSearchParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.mineralIds.length > 0) params.set('minerals', filters.mineralIds.join(','))
  if (filters.stages.length > 0) params.set('stages', filters.stages.join(','))
  if (filters.minValueUsd > 0) params.set('minValue', String(filters.minValueUsd))
  return params
}

/**
 * Unknown ids are dropped rather than trusted: a stale or hand-edited link
 * should degrade to a broader view, never to an empty globe or a crash.
 */
export function filtersFromSearchParams(
  params: URLSearchParams,
  knownMineralIds: readonly string[],
): Filters {
  const split = (value: string | null): string[] =>
    value === null ? [] : value.split(',').map((s) => s.trim()).filter(Boolean)

  const rawMinValue = Number(params.get('minValue'))
  const minValueUsd = Number.isFinite(rawMinValue) && rawMinValue > 0 ? rawMinValue : 0

  return {
    mineralIds: split(params.get('minerals')).filter((id) => knownMineralIds.includes(id)),
    stages: split(params.get('stages')).filter((s): s is Stage =>
      (STAGES as readonly string[]).includes(s),
    ),
    minValueUsd,
  }
}

function matchesMineral(filters: Filters, mineralIds: readonly string[]): boolean {
  if (filters.mineralIds.length === 0) return true
  return mineralIds.some((id) => filters.mineralIds.includes(id))
}

function matchesStage(filters: Filters, stages: readonly Stage[]): boolean {
  if (filters.stages.length === 0) return true
  return stages.some((s) => filters.stages.includes(s))
}

/** A facility shows if any of its minerals is selected and its stage is selected. */
export function filterFacilities(
  facilities: readonly FacilityFeature[],
  filters: Filters,
  activeMineralIds: ReadonlySet<string>,
): FacilityFeature[] {
  return facilities.filter((f) => {
    const visibleMinerals = f.properties.mineral_ids.filter((id) => activeMineralIds.has(id))
    if (visibleMinerals.length === 0) return false
    return matchesMineral(filters, visibleMinerals) && matchesStage(filters, [f.properties.stage])
  })
}

/**
 * A flow shows if either of its endpoints sits at a selected stage. Matching on
 * either end rather than both is what keeps a mineral that only trades at one
 * stage visible: rare earths have no mine-stage trade at all, so requiring both
 * ends to match would make them vanish under any filter that includes "mine".
 */
export function filterFlows(
  flows: readonly Flow[],
  filters: Filters,
  activeMineralIds: ReadonlySet<string>,
): Flow[] {
  return flows.filter((f) => {
    if (!activeMineralIds.has(f.mineral_id)) return false
    return (
      matchesMineral(filters, [f.mineral_id]) && matchesStage(filters, [f.stage_from, f.stage_to])
    )
  })
}

/** Stages that actually occur in a set of flows. Drives the "no data" hints. */
export function stagesPresent(flows: readonly Flow[]): Set<Stage> {
  const present = new Set<Stage>()
  for (const flow of flows) {
    present.add(flow.stage_from)
    present.add(flow.stage_to)
  }
  return present
}

/* ------------------------------------------------------------------- values */

export interface ResolvedValue {
  usd: number | null
  /** True when this number came from volume x price rather than trade data. */
  estimated: boolean
  /** Set when the value had to be derived here rather than read from the flow. */
  derivedFrom: { volumeTonnes: number; pricePerTonne: number; priceYear: number } | null
}

/**
 * The single place a flow turns into a dollar figure, and the single place that
 * decides whether the figure is estimated. Anything that displays a value must
 * carry the flag with it.
 */
export function resolveValue(flow: Flow, priceFor: Dataset['priceFor']): ResolvedValue {
  if (flow.value_usd !== null) {
    return { usd: flow.value_usd, estimated: flow.source === 'estimated', derivedFrom: null }
  }
  if (flow.volume_tonnes !== null) {
    const price = priceFor(flow.mineral_id, flow.year)
    if (price) {
      return {
        usd: flow.volume_tonnes * price.avg_price_usd_per_tonne,
        estimated: true,
        derivedFrom: {
          volumeTonnes: flow.volume_tonnes,
          pricePerTonne: price.avg_price_usd_per_tonne,
          priceYear: price.year,
        },
      }
    }
  }
  return { usd: null, estimated: false, derivedFrom: null }
}

/* -------------------------------------------------------------- arc geometry */

const ARC_WIDTH_MIN = 0.22
const ARC_WIDTH_MAX = 2.6
const ARC_ALTITUDE_MIN = 0.08
const ARC_ALTITUDE_MAX = 0.42

/** Great-circle separation in degrees, used only to shape arc altitude. */
export function angularDistanceDegrees(
  startLat: number,
  startLng: number,
  endLat: number,
  endLng: number,
): number {
  const toRad = Math.PI / 180
  const dLat = (endLat - startLat) * toRad
  const dLng = (endLng - startLng) * toRad
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(startLat * toRad) * Math.cos(endLat * toRad) * Math.sin(dLng / 2) ** 2
  return (2 * Math.asin(Math.min(1, Math.sqrt(a))) * 180) / Math.PI
}

/**
 * Longer hops arc higher, so a Chile-to-China line clears the globe instead of
 * cutting through it, while short hops stay flat and readable.
 */
export function arcAltitude(distanceDegrees: number): number {
  const t = Math.min(1, Math.max(0, distanceDegrees / 180))
  return ARC_ALTITUDE_MIN + (ARC_ALTITUDE_MAX - ARC_ALTITUDE_MIN) * Math.sqrt(t)
}

/**
 * Where a value sits on the scale, from 0 to 1. Square root, because copper
 * flows are an order of magnitude larger than rare earth flows and a linear
 * scale renders everything else as a hairline.
 *
 * The legend reads this too, so the swatch widths and the arc widths cannot
 * drift apart.
 */
export function valueScaleFraction(valueUsd: number | null, maxValueUsd: number): number {
  if (!(maxValueUsd > 0) || valueUsd === null || valueUsd <= 0) return 0
  return Math.min(1, Math.sqrt(valueUsd / maxValueUsd))
}

export function makeWidthScale(maxValueUsd: number): (valueUsd: number | null) => number {
  return (valueUsd) =>
    ARC_WIDTH_MIN + (ARC_WIDTH_MAX - ARC_WIDTH_MIN) * valueScaleFraction(valueUsd, maxValueUsd)
}

/* --------------------------------------------------------------- globe data */

export interface ArcDatum {
  id: string
  flow: Flow
  startLat: number
  startLng: number
  endLat: number
  endLng: number
  altitude: number
  width: number
  color: string
  value: ResolvedValue
  confidence: Confidence
}

export interface PointDatum {
  id: string
  facility: FacilityFeature
  lat: number
  lng: number
  color: string
  radius: number
  confidence: Confidence
}

/**
 * Point size by stage. Refining is the largest because that is where the
 * concentration this app is about actually sits; mines are the smallest because
 * there are more of them and they cluster.
 */
const STAGE_RADIUS: Record<Stage, number> = {
  mine: 0.45,
  process: 0.6,
  refine: 0.8,
}

/**
 * Multi-mineral rule: a facility takes the colour of its lowest `sort_order`
 * mineral among those currently visible, so the same point does not change
 * colour arbitrarily between renders. The detail panel lists every mineral, so
 * nothing is hidden by the choice; only the dot has to pick one.
 */
export function facilityColor(
  facility: FacilityFeature,
  mineralsById: ReadonlyMap<string, Mineral>,
  visibleMineralIds: ReadonlySet<string>,
): string {
  const candidates = facility.properties.mineral_ids
    .map((id) => mineralsById.get(id))
    .filter((m): m is Mineral => m !== undefined)
  const visible = candidates.filter((m) => visibleMineralIds.has(m.id))
  const pool = visible.length > 0 ? visible : candidates
  const chosen = pool.reduce<Mineral | undefined>(
    (best, m) => (best === undefined || m.sort_order < best.sort_order ? m : best),
    undefined,
  )
  return chosen?.color ?? '#8a94a6'
}

export function toPointData(
  facilities: readonly FacilityFeature[],
  mineralsById: ReadonlyMap<string, Mineral>,
  visibleMineralIds: ReadonlySet<string>,
): PointDatum[] {
  return facilities.map((facility) => {
    const [lng, lat] = facility.geometry.coordinates
    return {
      id: facility.properties.id,
      facility,
      lat,
      lng,
      color: facilityColor(facility, mineralsById, visibleMineralIds),
      radius: STAGE_RADIUS[facility.properties.stage],
      confidence: facility.properties.confidence,
    }
  })
}

export interface ArcBuildResult {
  arcs: ArcDatum[]
  /** How many flows matched the filters before the cap was applied. */
  totalMatching: number
  /** True when the cap dropped some, so the UI can say so instead of lying. */
  truncated: boolean
  maxValueUsd: number
}

/**
 * Past a few hundred arcs the frame rate collapses, so the set is capped by
 * value and the caller is told it happened.
 */
export const DEFAULT_ARC_CAP = 300

export function toArcData(
  flows: readonly Flow[],
  dataset: Pick<Dataset, 'countries' | 'mineralsById' | 'priceFor'>,
  cap: number = DEFAULT_ARC_CAP,
  minValueUsd = 0,
): ArcBuildResult {
  const built: ArcDatum[] = []

  for (const flow of flows) {
    const from = dataset.countries[flow.from_iso3]
    const to = dataset.countries[flow.to_iso3]
    // The loader guarantees both exist; skip rather than throw so a future
    // partial extract degrades to a missing arc instead of a blank globe.
    if (!from || !to) continue

    const value = resolveValue(flow, dataset.priceFor)
    // The value threshold is resolved here, in the one place that already
    // turns a flow into a dollar figure, so no component ever has to.
    if (minValueUsd > 0 && (value.usd ?? 0) < minValueUsd) continue
    const distance = angularDistanceDegrees(from.lat, from.lon, to.lat, to.lon)

    built.push({
      id: flow.id,
      flow,
      startLat: from.lat,
      startLng: from.lon,
      endLat: to.lat,
      endLng: to.lon,
      altitude: arcAltitude(distance),
      width: ARC_WIDTH_MIN,
      color: dataset.mineralsById.get(flow.mineral_id)?.color ?? '#8a94a6',
      value,
      confidence: flow.confidence,
    })
  }

  const totalMatching = built.length
  built.sort((a, b) => (b.value.usd ?? 0) - (a.value.usd ?? 0))
  const arcs = built.slice(0, cap)

  const maxValueUsd = arcs.reduce((max, a) => Math.max(max, a.value.usd ?? 0), 0)
  const widthOf = makeWidthScale(maxValueUsd)
  for (const arc of arcs) arc.width = widthOf(arc.value.usd)

  return { arcs, totalMatching, truncated: totalMatching > arcs.length, maxValueUsd }
}

/* --------------------------------------------------------------- formatting */

/** Compact dollars: 14720000000 -> "$14.7B". */
export function formatUsd(value: number | null): string {
  if (value === null) return 'no value'
  const abs = Math.abs(value)
  if (abs >= 1e12) return '$' + (value / 1e12).toFixed(1) + 'T'
  if (abs >= 1e9) return '$' + (value / 1e9).toFixed(1) + 'B'
  if (abs >= 1e6) return '$' + (value / 1e6).toFixed(0) + 'M'
  if (abs >= 1e3) return '$' + (value / 1e3).toFixed(0) + 'k'
  return '$' + value.toFixed(0)
}

/**
 * Exact dollars, for figures where rounding to "$9k" would destroy the meaning
 * — a per-tonne price above all, where the significant digits are the point.
 */
export function formatUsdExact(value: number): string {
  return '$' + Math.round(value).toLocaleString('en-US')
}

/** Tonnes with thousands separators: 1600000 -> "1,600,000 t". */
export function formatTonnes(value: number | null): string {
  if (value === null) return 'no volume'
  return value.toLocaleString('en-US') + ' t'
}
