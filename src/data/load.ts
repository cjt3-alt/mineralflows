import {
  CountriesFileSchema,
  FacilityCollectionSchema,
  FlowsFileSchema,
  MetaSchema,
  MineralsFileSchema,
  PricesFileSchema,
  parseFile,
  type Country,
  type FacilityFeature,
  type Flow,
  type Meta,
  type Mineral,
  type Price,
} from './schema.ts'

/**
 * Reads the six data files, validates each against the contract, then checks
 * the references between them. Both halves fail loudly: a dangling mineral_id
 * is as broken as a malformed record, and finding out at render time means a
 * blank globe with no explanation.
 */

/** File names, relative to public/data/. */
export const DATA_FILES = {
  minerals: 'minerals.json',
  facilities: 'facilities.geojson',
  flows: 'flows.json',
  prices: 'prices.json',
  countries: 'countries.json',
  meta: 'meta.json',
} as const

export interface RawFiles {
  minerals: unknown
  facilities: unknown
  flows: unknown
  prices: unknown
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
  flows: Flow[]
  prices: Price[]
  countries: Record<string, Country>
  meta: Meta
  /** Price lookup keyed by `${mineral_id}:${year}`. */
  priceFor: (mineralId: string, year: number) => Price | undefined
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
  const countries = parseFile(DATA_FILES.countries, CountriesFileSchema, raw.countries)
  const meta = parseFile(DATA_FILES.meta, MetaSchema, raw.meta)

  const facilities = facilityCollection.features
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

  if (problems.length > 0) throw new ReferentialError(problems)

  const priceIndex = new Map(prices.map((p) => [p.mineral_id + ':' + p.year, p]))

  return {
    minerals,
    activeMinerals: minerals.filter((m) => m.active).sort((a, b) => a.sort_order - b.sort_order),
    mineralsById,
    facilities,
    flows,
    prices,
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

/** Fetch, validate, and join the whole dataset. */
export async function loadDataset(): Promise<Dataset> {
  const [minerals, facilities, flows, prices, countries, meta] = await Promise.all([
    fetchJson(DATA_FILES.minerals),
    fetchJson(DATA_FILES.facilities),
    fetchJson(DATA_FILES.flows),
    fetchJson(DATA_FILES.prices),
    fetchJson(DATA_FILES.countries),
    fetchJson(DATA_FILES.meta),
  ])
  return parseDataset({ minerals, facilities, flows, prices, countries, meta })
}
