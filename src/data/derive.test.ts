import { describe, expect, it } from 'vitest'
import {
  angularDistanceDegrees,
  arcAltitude,
  facilityColor,
  filterFacilities,
  filterFlows,
  formatUsd,
  makeWidthScale,
  resolveValue,
  toArcData,
  EMPTY_FILTERS,
  flowKind,
  stageShade,
  summarizeCountry,
  type Filters,
} from './derive.ts'
import type { FacilityFeature, Flow, Mineral, Price } from './schema.ts'

const copper: Mineral = {
  id: 'copper',
  name: 'Copper',
  hs_codes: ['260300'],
  trade_codes: [{ hs_code: '260300', stage: 'mine', label: 'Ores', active: true }],
  usgs_commodity_code: 'copper',
  color: '#ff7a45',
  glow_intensity: 0.9,
  sort_order: 1,
  active: true,
}

const cobalt: Mineral = { ...copper, id: 'cobalt', name: 'Cobalt', color: '#5b8cff', sort_order: 3 }

const mineralsById = new Map<string, Mineral>([
  ['copper', copper],
  ['cobalt', cobalt],
])
const activeIds = new Set(['copper', 'cobalt'])

function facility(over: Partial<FacilityFeature['properties']>, lng = 0, lat = 0): FacilityFeature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lng, lat] },
    properties: {
      id: 'f1',
      name: 'Facility',
      mineral_ids: ['copper'],
      stage: 'mine',
      country_iso3: 'CHL',
      operator: null,
      capacity_tonnes_per_year: null,
      source: 'seed',
      source_url: null,
      confidence: 'high',
      last_updated: '2026-08-31',
      ...over,
    },
  }
}

function flow(over: Partial<Flow> = {}): Flow {
  return {
    id: 'f1',
    from_iso3: 'CHL',
    to_iso3: 'CHN',
    mineral_id: 'copper',
    year: 2024,
    value_usd: 1000,
    volume_tonnes: 10,
    stage_from: 'mine',
    stage_to: 'process',
    source: 'seed',
    confidence: 'high',
    ...over,
  }
}

const noFilters: Filters = EMPTY_FILTERS

describe('filtering', () => {
  it('treats an empty filter as no filter, not as nothing selected', () => {
    const facilities = [facility({ id: 'a' }), facility({ id: 'b', stage: 'refine' })]
    expect(filterFacilities(facilities, noFilters, activeIds)).toHaveLength(2)
  })

  it('hides facilities whose minerals are all inactive', () => {
    const facilities = [facility({ id: 'a', mineral_ids: ['nickel'] })]
    expect(filterFacilities(facilities, noFilters, activeIds)).toHaveLength(0)
  })

  it('keeps a multi-mineral facility when either mineral is selected', () => {
    const facilities = [facility({ id: 'a', mineral_ids: ['copper', 'cobalt'] })]
    const filters: Filters = { ...EMPTY_FILTERS, mineralIds: ['cobalt'] }
    expect(filterFacilities(facilities, filters, activeIds)).toHaveLength(1)
  })

  it('filters facilities by their own stage only', () => {
    const facilities = [facility({ id: 'a', stage: 'mine' }), facility({ id: 'b', stage: 'refine' })]
    const filters: Filters = { ...EMPTY_FILTERS, stages: ['refine'] }
    expect(filterFacilities(facilities, filters, activeIds).map((f) => f.properties.id)).toEqual(['b'])
  })

  it('names a flow by the stage it leaves', () => {
    expect(flowKind(flow({ stage_from: 'mine', stage_to: 'process' }))).toBe('mine')
    expect(flowKind(flow({ stage_from: 'refine', stage_to: 'refine' }))).toBe('refine')
  })

  it('filters flows by kind, independently of the facility stages', () => {
    const flows = [flow({ stage_from: 'mine', stage_to: 'process' })]
    const refineriesOnly: Filters = { ...EMPTY_FILTERS, stages: ['refine'] }
    expect(filterFlows(flows, refineriesOnly, activeIds)).toHaveLength(1)
    expect(filterFlows(flows, { ...EMPTY_FILTERS, flowKinds: ['mine'] }, activeIds)).toHaveLength(1)
    expect(filterFlows(flows, { ...EMPTY_FILTERS, flowKinds: ['refine'] }, activeIds)).toHaveLength(0)
  })

  /** The rare-earths case: a mineral that only trades refined metal. */
  it('keeps a refine-only mineral visible under refined metal and empty under ore', () => {
    const flows = [flow({ mineral_id: 'cobalt', stage_from: 'refine', stage_to: 'refine' })]
    expect(filterFlows(flows, { ...EMPTY_FILTERS, flowKinds: ['refine'] }, activeIds)).toHaveLength(1)
    expect(filterFlows(flows, { ...EMPTY_FILTERS, flowKinds: ['mine'] }, activeIds)).toHaveLength(0)
  })

  it('narrows flows to a focused country at either end', () => {
    const flows = [
      flow({ id: 'out', from_iso3: 'CHL', to_iso3: 'CHN' }),
      flow({ id: 'in', from_iso3: 'PER', to_iso3: 'CHL' }),
      flow({ id: 'other', from_iso3: 'PER', to_iso3: 'CHN' }),
    ]
    const ids = filterFlows(flows, { ...EMPTY_FILTERS, country: 'CHL' }, activeIds).map((f) => f.id)
    expect(ids).toEqual(['out', 'in'])
  })
})

describe('summarizeCountry', () => {
  const flows = [
    flow({ id: 'a', from_iso3: 'CHL', to_iso3: 'CHN', value_usd: 600 }),
    flow({ id: 'b', from_iso3: 'CHL', to_iso3: 'USA', value_usd: 200, stage_from: 'refine', stage_to: 'refine' }),
    flow({ id: 'c', from_iso3: 'PER', to_iso3: 'CHL', value_usd: 200 }),
  ]

  it('totals exports and imports by kind and ranks partners', () => {
    const s = summarizeCountry('CHL', flows, [facility({ country_iso3: 'CHL' })], () => undefined)
    expect(s.exportsUsd).toBe(800)
    expect(s.importsUsd).toBe(200)
    expect(s.exportsByKind).toEqual({ mine: 600, process: 0, refine: 200 })
    expect(s.topDestinations.map((p) => p.iso3)).toEqual(['CHN', 'USA'])
    expect(s.topOrigins).toEqual([{ iso3: 'PER', usd: 200 }])
    expect(s.facilities.mine).toBe(1)
    expect(s.shareOfExports).toBe(0.8)
    expect(s.exportsBuyerReportedUsd).toBe(0)
  })

  it('counts exports known only from buyers\' mirror reports', () => {
    const mirrored = [flow({ id: 'm', from_iso3: 'CHL', to_iso3: 'CHN', value_usd: 300, confidence: 'low' }), ...flows]
    expect(summarizeCountry('CHL', mirrored, [], () => undefined).exportsBuyerReportedUsd).toBe(300)
  })

  it('reports zeros, not NaN, for a country with no trade', () => {
    const s = summarizeCountry('ZZZ', flows, [], () => undefined)
    expect(s.exportsUsd).toBe(0)
    expect(s.shareOfImports).toBe(0)
  })
})

describe('stageShade', () => {
  it('darkens raw material and lightens refined metal around the mineral colour', () => {
    const base = '#ff7a45'
    const lum = (hex: string) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16)
    expect(stageShade(base, 'process')).toBe(base)
    expect(lum(stageShade(base, 'mine'))).toBeLessThan(lum(base))
    expect(lum(stageShade(base, 'refine'))).toBeGreaterThan(lum(base))
  })
})

describe('resolveValue', () => {
  const prices: Price[] = [
    {
      mineral_id: 'copper',
      year: 2024,
      avg_price_usd_per_tonne: 9200,
      source: 'seed',
      source_url: 'https://example.org/prices',
    },
  ]
  const priceFor = (id: string, year: number) =>
    prices.find((p) => p.mineral_id === id && p.year === year)

  it('passes through a traded value without marking it estimated', () => {
    expect(resolveValue(flow({ value_usd: 500 }), priceFor)).toMatchObject({
      usd: 500,
      estimated: false,
    })
  })

  it('marks a value estimated when the flow itself says so', () => {
    const f = flow({ value_usd: 92000, volume_tonnes: 10, source: 'estimated' })
    expect(resolveValue(f, priceFor).estimated).toBe(true)
  })

  it('derives volume x price when there is no value, and says where it came from', () => {
    const f = flow({ value_usd: null, volume_tonnes: 10 })
    const resolved = resolveValue(f, priceFor)
    expect(resolved.usd).toBe(92000)
    expect(resolved.estimated).toBe(true)
    expect(resolved.derivedFrom).toMatchObject({ pricePerTonne: 9200, priceYear: 2024 })
  })

  it('returns no value rather than a zero when there is no price to use', () => {
    const f = flow({ value_usd: null, volume_tonnes: 10, year: 1999 })
    expect(resolveValue(f, priceFor)).toMatchObject({ usd: null, estimated: false })
  })
})

describe('width scale', () => {
  it('is square-root, so a 100x larger value is 10x the width range', () => {
    const scale = makeWidthScale(10000)
    const small = scale(100)
    const large = scale(10000)
    const min = scale(0)
    expect((small - min) / (large - min)).toBeCloseTo(0.1, 5)
  })

  it('falls back to the minimum width when there is nothing to scale against', () => {
    expect(makeWidthScale(0)(500)).toBe(makeWidthScale(0)(null))
  })
})

describe('arc geometry', () => {
  it('measures antipodal points as 180 degrees apart', () => {
    expect(angularDistanceDegrees(0, 0, 0, 180)).toBeCloseTo(180, 6)
  })

  it('arcs longer hops higher than short ones', () => {
    expect(arcAltitude(180)).toBeGreaterThan(arcAltitude(20))
  })

  it('keeps altitude inside the range that clears the globe without floating off', () => {
    for (const d of [0, 1, 45, 90, 179, 180]) {
      expect(arcAltitude(d)).toBeGreaterThanOrEqual(0.08)
      expect(arcAltitude(d)).toBeLessThanOrEqual(0.42)
    }
  })
})

describe('facilityColor', () => {
  it('takes the lowest sort_order mineral when a facility has several', () => {
    const f = facility({ mineral_ids: ['cobalt', 'copper'] })
    expect(facilityColor(f, mineralsById, activeIds)).toBe(copper.color)
  })

  it('uses the visible mineral when the lower-order one is filtered out', () => {
    const f = facility({ mineral_ids: ['cobalt', 'copper'] })
    expect(facilityColor(f, mineralsById, new Set(['cobalt']))).toBe(cobalt.color)
  })
})

describe('toArcData', () => {
  const dataset = {
    countries: {
      CHL: { name: 'Chile', lat: -35.7, lon: -71.4 },
      CHN: { name: 'China', lat: 35.0, lon: 103.9 },
      PER: { name: 'Peru', lat: -9.2, lon: -75.0 },
    },
    mineralsById,
    priceFor: () => undefined,
  }

  it('sorts by value and reports truncation instead of silently dropping arcs', () => {
    const flows = [
      flow({ id: 'small', value_usd: 10 }),
      flow({ id: 'big', value_usd: 1000, from_iso3: 'PER' }),
    ]
    const result = toArcData(flows, dataset, 1)
    expect(result.arcs.map((a) => a.id)).toEqual(['big'])
    expect(result.truncated).toBe(true)
    expect(result.totalMatching).toBe(2)
  })

  it('does not report truncation when everything fits', () => {
    const result = toArcData([flow()], dataset, 300)
    expect(result.truncated).toBe(false)
  })

  it('skips a flow whose country is missing rather than throwing', () => {
    const result = toArcData([flow({ from_iso3: 'ZZZ' })], dataset)
    expect(result.arcs).toHaveLength(0)
  })

  it('colours and weights arcs by kind and value', () => {
    const flows = [
      flow({ id: 'small', value_usd: 10 }),
      flow({ id: 'big', value_usd: 1000, from_iso3: 'PER', stage_from: 'refine', stage_to: 'refine' }),
    ]
    const result = toArcData(flows, dataset, 300)
    const big = result.arcs.find((a) => a.id === 'big')!
    const small = result.arcs.find((a) => a.id === 'small')!
    expect(big.kind).toBe('refine')
    expect(big.weight).toBe(1)
    expect(small.weight).toBeCloseTo(0.1)
    expect(big.color).not.toBe(small.color)
  })
})

describe('formatUsd', () => {
  it('formats billions compactly', () => {
    expect(formatUsd(14720000000)).toBe('$14.7B')
  })

  it('says there is no value rather than showing a zero', () => {
    expect(formatUsd(null)).toBe('no value')
  })
})
