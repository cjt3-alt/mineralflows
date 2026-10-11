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
 *
 * Facilities and flows are filtered separately. A single "stage" filter used
 * to drive both, which left it unclear whether "Refine" meant refineries or
 * refined-metal trade; now `stages` picks facility layers and `flowKinds`
 * picks what kind of material a flow carries.
 */
export interface Filters {
  mineralIds: string[]
  /** Facility layers to show, by stage. */
  stages: Stage[]
  /** Flow kinds to show. A flow's kind is the stage it leaves: see `flowKind`. */
  flowKinds: Stage[]
  /** How many of the largest flows to draw. One of `TOP_N_OPTIONS`. */
  topN: number
  /** ISO3 of a focused country, or null. Focus narrows flows to that country's trade. */
  country: string | null
}

/**
 * Past a few hundred arcs the frame rate collapses and the picture turns to
 * noise, so the set is capped by value and the caller is told it happened.
 */
export const TOP_N_OPTIONS = [25, 100, 300] as const
export const DEFAULT_TOP_N = 100
export const DEFAULT_ARC_CAP = 300

export const EMPTY_FILTERS: Filters = {
  mineralIds: [],
  stages: [],
  flowKinds: [],
  topN: DEFAULT_TOP_N,
  country: null,
}

/**
 * Filters round-trip through the query string so a view is shareable. Empty
 * groups and defaults are omitted rather than written out, so the default view
 * has a clean URL.
 */
export function filtersToSearchParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.mineralIds.length > 0) params.set('minerals', filters.mineralIds.join(','))
  if (filters.stages.length > 0) params.set('stages', filters.stages.join(','))
  if (filters.flowKinds.length > 0) params.set('flows', filters.flowKinds.join(','))
  if (filters.topN !== DEFAULT_TOP_N) params.set('top', String(filters.topN))
  if (filters.country !== null) params.set('country', filters.country)
  return params
}

/**
 * Unknown ids are dropped rather than trusted: a stale or hand-edited link
 * should degrade to a broader view, never to an empty globe or a crash.
 */
export function filtersFromSearchParams(
  params: URLSearchParams,
  knownMineralIds: readonly string[],
  knownCountries: readonly string[] = [],
): Filters {
  const split = (value: string | null): string[] =>
    value === null ? [] : value.split(',').map((s) => s.trim()).filter(Boolean)
  const stagesOf = (value: string | null): Stage[] =>
    split(value).filter((s): s is Stage => (STAGES as readonly string[]).includes(s))

  const rawTop = Number(params.get('top'))
  const topN = (TOP_N_OPTIONS as readonly number[]).includes(rawTop) ? rawTop : DEFAULT_TOP_N

  const rawCountry = (params.get('country') ?? '').trim().toUpperCase()
  const country = knownCountries.includes(rawCountry) ? rawCountry : null

  return {
    mineralIds: split(params.get('minerals')).filter((id) => knownMineralIds.includes(id)),
    stages: stagesOf(params.get('stages')),
    flowKinds: stagesOf(params.get('flows')),
    topN,
    country,
  }
}

function matchesMineral(filters: Filters, mineralIds: readonly string[]): boolean {
  if (filters.mineralIds.length === 0) return true
  return mineralIds.some((id) => filters.mineralIds.includes(id))
}

/** A facility shows if any of its minerals is selected and its stage is selected. */
export function filterFacilities(
  facilities: readonly FacilityFeature[],
  filters: Pick<Filters, 'mineralIds' | 'stages'>,
  activeMineralIds: ReadonlySet<string>,
): FacilityFeature[] {
  return facilities.filter((f) => {
    const visibleMinerals = f.properties.mineral_ids.filter((id) => activeMineralIds.has(id))
    if (visibleMinerals.length === 0) return false
    if (!matchesMineral(filters as Filters, visibleMinerals)) return false
    return filters.stages.length === 0 || filters.stages.includes(f.properties.stage)
  })
}

/**
 * What a flow carries, named by the stage it leaves. A flow out of a mine is
 * ore or concentrate on its way to a smelter; out of a smelter, an unrefined
 * intermediate (matte, blister, anode); out of a refinery, refined metal. The
 * ETL assigns stages from HS codes, so this is a reading of the trade code,
 * not a guess.
 */
export function flowKind(flow: Pick<Flow, 'stage_from'>): Stage {
  return flow.stage_from
}

/**
 * A flow shows if its mineral and kind are selected and, when a country is in
 * focus, if that country is at either end.
 */
export function filterFlows(
  flows: readonly Flow[],
  filters: Pick<Filters, 'mineralIds' | 'flowKinds' | 'country'>,
  activeMineralIds: ReadonlySet<string>,
): Flow[] {
  return flows.filter((f) => {
    if (!activeMineralIds.has(f.mineral_id)) return false
    if (!matchesMineral(filters as Filters, [f.mineral_id])) return false
    if (filters.flowKinds.length > 0 && !filters.flowKinds.includes(flowKind(f))) return false
    if (filters.country !== null && f.from_iso3 !== filters.country && f.to_iso3 !== filters.country)
      return false
    return true
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

/* ------------------------------------------------------------------- labels */

/** Facility stages in plain words. Mineral-agnostic on purpose. */
export const STAGE_LABEL: Record<Stage, string> = {
  mine: 'Mines',
  process: 'Smelters & processing',
  refine: 'Refineries',
}
export const STAGE_LABEL_SINGULAR: Record<Stage, string> = {
  mine: 'Mine',
  process: 'Smelter / processing plant',
  refine: 'Refinery',
}

/** Flow kinds in plain words, keyed by the stage the flow leaves. */
export const FLOW_KIND_LABEL: Record<Stage, string> = {
  mine: 'Ore & concentrate',
  process: 'Smelted intermediates',
  refine: 'Refined metal',
}
export const FLOW_KIND_DETAIL: Record<Stage, string> = {
  mine: 'Mined ore and concentrate, shipped to a smelter',
  process: 'Smelted but not yet refined: matte, blister, anodes',
  refine: 'Finished refined metal: cathode, wire-bar, billet',
}

/* ------------------------------------------------------------------- colour */

function hexToRgb(hex: string): [number, number, number] {
  const v = hex.replace('#', '')
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('')
}

function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a)
  const y = hexToRgb(b)
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t])
}

/**
 * One hue per mineral, three lightnesses per stage: raw material is the
 * darkest, refined metal the brightest. It reads as the material itself being
 * worked up the chain, and it keeps working when several minerals are on screen
 * at once, because hue still says which mineral it is.
 */
export function stageShade(mineralHex: string, stage: Stage): string {
  if (stage === 'mine') return mix(mineralHex, '#2a1208', 0.35)
  if (stage === 'process') return mineralHex
  return mix(mineralHex, '#fff1d6', 0.6)
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

const ARC_WIDTH_MIN = 0.12
const ARC_WIDTH_MAX = 1.5
const ARC_ALTITUDE_MIN = 0.08
const ARC_ALTITUDE_MAX = 0.3

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
  /** What the flow carries; see `flowKind`. */
  kind: Stage
  /** 0-1 position on the value scale, for opacity as well as width. */
  weight: number
  value: ResolvedValue
  confidence: Confidence
}

export interface PointDatum {
  id: string
  facility: FacilityFeature
  lat: number
  lng: number
  color: string
  stage: Stage
  /** On-screen diameter in CSS pixels at the default zoom. */
  size: number
  confidence: Confidence
}

/**
 * Point size by stage. Smelters and refineries are the largest because that is
 * where the concentration this app is about actually sits; mines are the
 * smallest because there are hundreds of them and they cluster.
 */
const STAGE_SIZE: Record<Stage, number> = {
  mine: 3.5,
  process: 7,
  refine: 8.5,
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
    const stage = facility.properties.stage
    return {
      id: facility.properties.id,
      facility,
      lat,
      lng,
      color: stageShade(facilityColor(facility, mineralsById, visibleMineralIds), stage),
      stage,
      size: STAGE_SIZE[stage],
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

export function toArcData(
  flows: readonly Flow[],
  dataset: Pick<Dataset, 'countries' | 'mineralsById' | 'priceFor'>,
  cap: number = DEFAULT_ARC_CAP,
): ArcBuildResult {
  const built: ArcDatum[] = []

  for (const flow of flows) {
    const from = dataset.countries[flow.from_iso3]
    const to = dataset.countries[flow.to_iso3]
    // The loader guarantees both exist; skip rather than throw so a future
    // partial extract degrades to a missing arc instead of a blank globe.
    if (!from || !to) continue

    const value = resolveValue(flow, dataset.priceFor)
    const distance = angularDistanceDegrees(from.lat, from.lon, to.lat, to.lon)
    const kind = flowKind(flow)

    built.push({
      id: flow.id,
      flow,
      startLat: from.lat,
      startLng: from.lon,
      endLat: to.lat,
      endLng: to.lon,
      altitude: arcAltitude(distance),
      width: ARC_WIDTH_MIN,
      color: stageShade(dataset.mineralsById.get(flow.mineral_id)?.color ?? '#8a94a6', kind),
      kind,
      weight: 0,
      value,
      confidence: flow.confidence,
    })
  }

  const totalMatching = built.length
  built.sort((a, b) => (b.value.usd ?? 0) - (a.value.usd ?? 0))
  const arcs = built.slice(0, cap)

  const maxValueUsd = arcs.reduce((max, a) => Math.max(max, a.value.usd ?? 0), 0)
  const widthOf = makeWidthScale(maxValueUsd)
  for (const arc of arcs) {
    arc.width = widthOf(arc.value.usd)
    arc.weight = valueScaleFraction(arc.value.usd, maxValueUsd)
  }

  return { arcs, totalMatching, truncated: totalMatching > arcs.length, maxValueUsd }
}

/* ---------------------------------------------------------------- summaries */

export interface Partner {
  iso3: string
  usd: number
}

export interface CountrySummary {
  iso3: string
  exportsUsd: number
  importsUsd: number
  /** Exports by kind, so the panel can say what a country ships, not just how much. */
  exportsByKind: Record<Stage, number>
  importsByKind: Record<Stage, number>
  /**
   * Exports known only from the buyers' customs records: the country itself
   * reported none of them. When this is most of `exportsUsd`, the country's
   * own trade reporting is missing, and the panel says so.
   */
  exportsBuyerReportedUsd: number
  topDestinations: Partner[]
  topOrigins: Partner[]
  facilities: Record<Stage, number>
  /** This country's share of all imports and exports in the flows given. */
  shareOfImports: number
  shareOfExports: number
}

function zeroByStage(): Record<Stage, number> {
  return { mine: 0, process: 0, refine: 0 }
}

function topPartners(byCountry: Map<string, number>, n: number): Partner[] {
  return [...byCountry.entries()]
    .map(([iso3, usd]) => ({ iso3, usd }))
    .sort((a, b) => b.usd - a.usd)
    .slice(0, n)
}

/**
 * One country's position in the trade, from every flow that passes the mineral
 * and kind filters — before the top-N cap, so a country's totals do not change
 * with how many arcs happen to be drawn.
 */
export function summarizeCountry(
  iso3: string,
  flows: readonly Flow[],
  facilities: readonly FacilityFeature[],
  priceFor: Dataset['priceFor'],
): CountrySummary {
  const exportsByKind = zeroByStage()
  const importsByKind = zeroByStage()
  let exportsBuyerReportedUsd = 0
  const destinations = new Map<string, number>()
  const origins = new Map<string, number>()
  let total = 0

  for (const flow of flows) {
    const usd = resolveValue(flow, priceFor).usd ?? 0
    total += usd
    const kind = flowKind(flow)
    if (flow.from_iso3 === iso3) {
      exportsByKind[kind] += usd
      // Low confidence on a flow means the exporter filed no record of it and
      // the importer's mirror report stands in (see the TiCM source module).
      if (flow.confidence === 'low') exportsBuyerReportedUsd += usd
      destinations.set(flow.to_iso3, (destinations.get(flow.to_iso3) ?? 0) + usd)
    }
    if (flow.to_iso3 === iso3) {
      importsByKind[kind] += usd
      origins.set(flow.from_iso3, (origins.get(flow.from_iso3) ?? 0) + usd)
    }
  }

  const facilityCounts = zeroByStage()
  for (const f of facilities) {
    if (f.properties.country_iso3 === iso3) facilityCounts[f.properties.stage] += 1
  }

  const exportsUsd = STAGES.reduce((sum, s) => sum + exportsByKind[s], 0)
  const importsUsd = STAGES.reduce((sum, s) => sum + importsByKind[s], 0)

  return {
    iso3,
    exportsUsd,
    importsUsd,
    exportsByKind,
    importsByKind,
    exportsBuyerReportedUsd,
    topDestinations: topPartners(destinations, 5),
    topOrigins: topPartners(origins, 5),
    facilities: facilityCounts,
    shareOfImports: total > 0 ? importsUsd / total : 0,
    shareOfExports: total > 0 ? exportsUsd / total : 0,
  }
}

/** Total traded value per flow kind, before the cap. */
export function valueByKind(flows: readonly Flow[], priceFor: Dataset['priceFor']): Record<Stage, number> {
  const out = zeroByStage()
  for (const flow of flows) out[flowKind(flow)] += resolveValue(flow, priceFor).usd ?? 0
  return out
}

/** Countries at either end of any flow, or holding any facility. */
export function countriesInPlay(
  flows: readonly Flow[],
  facilities: readonly FacilityFeature[],
): Set<string> {
  const out = new Set<string>()
  for (const f of flows) {
    out.add(f.from_iso3)
    out.add(f.to_iso3)
  }
  for (const f of facilities) out.add(f.properties.country_iso3)
  return out
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

/** A share as a whole percentage, or "<1%" rather than a misleading zero. */
export function formatShare(fraction: number): string {
  if (fraction <= 0) return '0%'
  if (fraction < 0.01) return '<1%'
  return Math.round(fraction * 100) + '%'
}

/** Coordinates as a HUD would print them: 33.45°S 70.67°W. */
export function formatLatLng(lat: number, lng: number, digits = 2): string {
  const ns = lat >= 0 ? 'N' : 'S'
  const ew = lng >= 0 ? 'E' : 'W'
  return Math.abs(lat).toFixed(digits) + '°' + ns + ' ' + Math.abs(lng).toFixed(digits) + '°' + ew
}
