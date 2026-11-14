import {
  CountriesFileSchema,
  FacilityCollectionSchema,
  FlowsFileSchema,
  MetaSchema,
  MineralsFileSchema,
  PricesFileSchema,
  ProductionFileSchema,
  parseFile,
  type Country,
  type FacilityFeature,
  type Flow,
  type Meta,
  type Mineral,
  type Price,
  type Production,
} from './schema.ts'

/**
 * Reads the seven data files, validates each against the contract, then checks
 * the references between them. Both halves fail loudly: a dangling mineral_id
 * is as broken as a malformed record, and finding out at render time means a
 * blank globe with no explanation.
 */

/** Common English names for countries whose official short names read badly in prose. */
export const COMMON_NAMES: Record<string, string> = {
  COD: 'DR Congo',
  COG: 'Republic of the Congo',
  KOR: 'South Korea',
  PRK: 'North Korea',
  RUS: 'Russia',
  EGY: 'Egypt',
  IRN: 'Iran',
  VEN: 'Venezuela',
  YEM: 'Yemen',
  TWN: 'Taiwan',
  HKG: 'Hong Kong',
  MAC: 'Macao',
  VNM: 'Vietnam',
  LAO: 'Laos',
  SVK: 'Slovakia',
  KGZ: 'Kyrgyzstan',
  CZE: 'Czechia',
  TUR: 'Türkiye',
  SYR: 'Syria',
  GMB: 'The Gambia',
  BHS: 'The Bahamas',
  MKD: 'North Macedonia',
  MDA: 'Moldova',
  FSM: 'Micronesia',
  LCA: 'Saint Lucia',
  VCT: 'Saint Vincent and the Grenadines',
  KNA: 'Saint Kitts and Nevis',
}

/** File names, relative to public/data/. */
export const DATA_FILES = {
  minerals: 'minerals.json',
  facilities: 'facilities.geojson',
  flows: 'flows.json',
  prices: 'prices.json',
  production: 'production.json',
  productionHistory: 'production_history.json',
  priceHistory: 'price_history.json',
  sitePositions: 'site_positions.json',
  countries: 'countries.json',
  meta: 'meta.json',
} as const

export interface RawFiles {
  minerals: unknown
  facilities: unknown
  flows: unknown
  prices: unknown
  /** Optional: a seed-only run has no production table. */
  production?: unknown
  /** Optional: earlier years of `production`, from the USGS back-releases. */
  productionHistory?: unknown
  /** Optional: annual average prices back to 2000. */
  priceHistory?: unknown
  /** Optional: dots moved onto the mining outline each site was matched to (`etl/outlines.py`). */
  sitePositions?: unknown
  countries: unknown
  meta: unknown
}

export interface Dataset {
  /** Every mineral, including inactive ones. */
  minerals: Mineral[]
  /** Only minerals the UI should render, in sort_order. */
  activeMinerals: Mineral[]
  mineralsById: Map<string, Mineral>
  facilities: FacilityFeature[]
  /** Record ids left out of `facilities` because they repeat a plant held elsewhere in the data. */
  hiddenDuplicates: Set<string>
  /** Sites whose dot was moved onto their mining outline, with where the source reported them. */
  repositioned: Map<string, RepositionedSite>
  flows: Flow[]
  prices: Price[]
  /** Annual average prices over a longer span than `prices`, for the timeline. */
  priceHistory: Price[]
  /** Mine and refinery output by country, every year available; empty when the run had no source for it. */
  production: Production[]
  countries: Record<string, Country>
  meta: Meta
  /** Price lookup keyed by `${mineral_id}:${year}`. */
  priceFor: (mineralId: string, year: number) => Price | undefined
}

export interface RepositionedSite {
  /** Where the source reported the site. */
  fromLng: number
  fromLat: number
  /** How far the dot moved, in kilometres. */
  km: number
  /** Onto a mining outline, or to a plant's published coordinates checked on imagery. */
  method: 'snapped_to_outline' | 'published_coordinates'
  /** Where a published position came from; absent for outline snaps. */
  source?: string
  /** Another mining outline was nearly as close, so the dot may be on the wrong one. Not yet checked. */
  closeCall?: boolean
  /** A close call that was looked at on satellite imagery and judged plausible. */
  checked?: boolean
}

/**
 * Move dots onto the mining outline each site was matched to. A move is only applied while the
 * facility still reports the point it was computed from, so a refreshed source can never leave a
 * stale correction behind. Anything malformed is ignored: the reported position is always safe.
 */
export function applySitePositions(
  facilities: FacilityFeature[],
  raw: unknown,
): { facilities: FacilityFeature[]; repositioned: Map<string, RepositionedSite>; hidden: Set<string> } {
  const repositioned = new Map<string, RepositionedSite>()
  const hidden = new Set<string>()
  const file = raw as { positions?: Record<string, unknown>; hidden?: Record<string, { name?: unknown }> } | null
  // Records that repeat a plant already in the data at its real location are left out. The monthly
  // refresh does not re-run the outline script, so a record is hidden only while it still carries
  // the name it had when it was reviewed.
  if (file?.hidden && typeof file.hidden === 'object') {
    const byId = new Map(facilities.map((f) => [f.properties.id, f.properties.name]))
    for (const [id, entry] of Object.entries(file.hidden)) {
      if (typeof entry?.name === 'string' && byId.get(id) === entry.name) hidden.add(id)
    }
  }
  const table = file?.positions
  if (!table || typeof table !== 'object') {
    return { facilities: facilities.filter((f) => !hidden.has(f.properties.id)), repositioned, hidden }
  }
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-4
  const moved = facilities.map((facility) => {
    const entry = table[facility.properties.id] as
      | { lng?: unknown; lat?: unknown; from?: unknown; moved_km?: unknown; method?: unknown; source?: unknown; close_call?: unknown; checked?: unknown }
      | undefined
    if (!entry || !Array.isArray(entry.from)) return facility
    const [lng, lat] = facility.geometry.coordinates
    const [fromLng, fromLat] = entry.from as unknown[]
    if (
      typeof entry.lng !== 'number' ||
      typeof entry.lat !== 'number' ||
      typeof fromLng !== 'number' ||
      typeof fromLat !== 'number' ||
      !near(lng, fromLng) ||
      !near(lat, fromLat)
    ) {
      return facility
    }
    repositioned.set(facility.properties.id, {
      fromLng: lng,
      fromLat: lat,
      km: typeof entry.moved_km === 'number' ? entry.moved_km : 0,
      method: entry.method === 'published_coordinates' ? 'published_coordinates' : 'snapped_to_outline',
      ...(typeof entry.source === 'string' ? { source: entry.source } : {}),
      ...(entry.close_call === true ? { closeCall: true } : {}),
      ...(entry.checked === true ? { checked: true } : {}),
    })
    return { ...facility, geometry: { ...facility.geometry, coordinates: [entry.lng, entry.lat] as [number, number] } }
  })
  return { facilities: moved.filter((f) => !hidden.has(f.properties.id)), repositioned, hidden }
}

export class ReferentialError extends Error {
  constructor(readonly problems: string[]) {
    super(
      'Data files do not line up with each other:\n' + problems.map((p) => '  - ' + p).join('\n'),
    )
    this.name = 'ReferentialError'
  }
}

function findDuplicates(ids: string[]): string[] {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id)
    seen.add(id)
  }
  return [...dupes]
}

/**
 * Validate and join already-read file contents. Pure, so tests can feed it the
 * real files from disk without a network or a DOM.
 */
export function parseDataset(raw: RawFiles): Dataset {
  const minerals = parseFile(DATA_FILES.minerals, MineralsFileSchema, raw.minerals)
  const facilityCollection = parseFile(
    DATA_FILES.facilities,
    FacilityCollectionSchema,
    raw.facilities,
  )
  const flows = parseFile(DATA_FILES.flows, FlowsFileSchema, raw.flows)
  const prices = parseFile(DATA_FILES.prices, PricesFileSchema, raw.prices)
  const currentProduction = parseFile(DATA_FILES.production, ProductionFileSchema, raw.production ?? [])
  const historicProduction = parseFile(
    DATA_FILES.productionHistory,
    ProductionFileSchema,
    raw.productionHistory ?? [],
  )
  const priceHistory = parseFile(DATA_FILES.priceHistory, PricesFileSchema, raw.priceHistory ?? [])
  // The current file wins where both carry a year: it is the newer release.
  const productionKey = (r: Production) => r.mineral_id + ':' + r.stage + ':' + r.year
  const haveKeys = new Set(currentProduction.map(productionKey))
  const production = [
    ...historicProduction.filter((r) => !haveKeys.has(productionKey(r))),
    ...currentProduction,
  ].sort((a, b) => a.year - b.year)
  const countries = parseFile(DATA_FILES.countries, CountriesFileSchema, raw.countries)
  const meta = parseFile(DATA_FILES.meta, MetaSchema, raw.meta)

  const { facilities, repositioned, hidden } = applySitePositions(facilityCollection.features, raw.sitePositions)
  const mineralsById = new Map(minerals.map((m) => [m.id, m]))
  const problems: string[] = []

  for (const dupe of findDuplicates(minerals.map((m) => m.id))) {
    problems.push('minerals.json: duplicate mineral id "' + dupe + '"')
  }
  for (const dupe of findDuplicates(facilities.map((f) => f.properties.id))) {
    problems.push('facilities.geojson: duplicate facility id "' + dupe + '"')
  }
  for (const dupe of findDuplicates(flows.map((f) => f.id))) {
    problems.push('flows.json: duplicate flow id "' + dupe + '"')
  }
  for (const dupe of findDuplicates(prices.map((p) => p.mineral_id + ':' + p.year))) {
    problems.push('prices.json: more than one price for ' + dupe.replace(':', ' in '))
  }

  for (const facility of facilities) {
    const { id, mineral_ids, country_iso3 } = facility.properties
    for (const mineralId of mineral_ids) {
      if (!mineralsById.has(mineralId)) {
        problems.push(
          'facilities.geojson: "' + id + '" references unknown mineral "' + mineralId + '"',
        )
      }
    }
    if (!(country_iso3 in countries)) {
      problems.push(
        'facilities.geojson: "' + id + '" is in "' + country_iso3 + '", missing from countries.json',
      )
    }
  }

  for (const flow of flows) {
    if (!mineralsById.has(flow.mineral_id)) {
      problems.push('flows.json: "' + flow.id + '" references unknown mineral "' + flow.mineral_id + '"')
    }
    for (const iso3 of [flow.from_iso3, flow.to_iso3]) {
      if (!(iso3 in countries)) {
        problems.push('flows.json: "' + flow.id + '" uses "' + iso3 + '", missing from countries.json')
      }
    }
  }

  for (const price of prices) {
    if (!mineralsById.has(price.mineral_id)) {
      problems.push('prices.json: price for unknown mineral "' + price.mineral_id + '"')
    }
  }

  for (const record of production) {
    const label = 'production.json: ' + record.mineral_id + '/' + record.stage + '/' + record.year
    if (!mineralsById.has(record.mineral_id)) {
      problems.push(label + ' references unknown mineral')
    }
    for (const iso3 of Object.keys(record.by_country)) {
      if (!(iso3 in countries)) {
        problems.push(label + ' uses "' + iso3 + '", missing from countries.json')
      }
    }
  }

  if (problems.length > 0) throw new ReferentialError(problems)

  // The World Bank's official short names read awkwardly in a sentence
  // ("Congo, Dem. Rep."); show the names people use. Codes are unchanged.
  for (const [iso3, display] of Object.entries(COMMON_NAMES)) {
    const country = countries[iso3]
    if (country) countries[iso3] = { ...country, name: display }
  }

  const priceIndex = new Map(prices.map((p) => [p.mineral_id + ':' + p.year, p]))

  return {
    minerals,
    activeMinerals: minerals.filter((m) => m.active).sort((a, b) => a.sort_order - b.sort_order),
    mineralsById,
    facilities,
    hiddenDuplicates: hidden,
    repositioned,
    flows,
    prices,
    priceHistory,
    production,
    countries,
    meta,
    priceFor: (mineralId, year) => priceIndex.get(mineralId + ':' + year),
  }
}

/**
 * Resolve a data file URL relative to the deployed base, so the same build
 * works under a project path, an apex domain, and a plain file server.
 */
function dataUrl(file: string): string {
  const base = import.meta.env.BASE_URL
  return (base.endsWith('/') ? base : base + '/') + 'data/' + file
}

async function fetchJson(file: string): Promise<unknown> {
  const url = dataUrl(file)
  let response: Response
  try {
    response = await fetch(url)
  } catch (cause) {
    throw new Error('Could not reach ' + url + '.', { cause })
  }
  if (!response.ok) {
    throw new Error('Could not load ' + url + ' (HTTP ' + response.status + ').')
  }
  try {
    return (await response.json()) as unknown
  } catch (cause) {
    throw new Error(url + ' is not valid JSON.', { cause })
  }
}

/** A file the app can do without: a missing or unreadable one is an empty list, not an error. */
async function fetchOptionalJson(file: string): Promise<unknown> {
  try {
    return await fetchJson(file)
  } catch {
    return []
  }
}

/** Fetch, validate, and join the whole dataset. */
export async function loadDataset(): Promise<Dataset> {
  const [
    [minerals, facilities, flows, prices, production, countries, meta],
    [productionHistory, priceHistory, sitePositions],
  ] = await Promise.all([
    Promise.all([
      fetchJson(DATA_FILES.minerals),
      fetchJson(DATA_FILES.facilities),
      fetchJson(DATA_FILES.flows),
      fetchJson(DATA_FILES.prices),
      fetchJson(DATA_FILES.production),
      fetchJson(DATA_FILES.countries),
      fetchJson(DATA_FILES.meta),
    ]),
    Promise.all([
      fetchOptionalJson(DATA_FILES.productionHistory),
      fetchOptionalJson(DATA_FILES.priceHistory),
      fetchOptionalJson(DATA_FILES.sitePositions),
    ]),
  ])
  return parseDataset({
    minerals,
    facilities,
    flows,
    prices,
    production,
    productionHistory,
    priceHistory,
    sitePositions,
    countries,
    meta,
  })
}
