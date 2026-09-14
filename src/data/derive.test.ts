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

const noFilters: Filters = { mineralIds: [], stages: [], minValueUsd: 0 }

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
    const filters: Filters = { mineralIds: ['cobalt'], stages: [], minValueUsd: 0 }
    expect(filterFacilities(facilities, filters, activeIds)).toHaveLength(1)
  })

  it('matches a flow when either endpoint is at a selected stage', () => {
    const flows = [flow({ stage_from: 'mine', stage_to: 'process' })]
    expect(
      filterFlows(flows, { mineralIds: [], stages: ['process'], minValueUsd: 0 }, activeIds),
    ).toHaveLength(1)
    expect(
      filterFlows(flows, { mineralIds: [], stages: ['refine'], minValueUsd: 0 }, activeIds),
    ).toHaveLength(0)
  })

  /** The rare-earths case: a mineral that only trades at one stage. */
  it('keeps a refine-only mineral visible under a refine filter and empty under mine', () => {
    const flows = [flow({ mineral_id: 'cobalt', stage_from: 'refine', stage_to: 'refine' })]
    expect(
      filterFlows(flows, { mineralIds: [], stages: ['refine'], minValueUsd: 0 }, activeIds),
    ).toHaveLength(1)
    expect(
      filterFlows(flows, { mineralIds: [], stages: ['mine'], minValueUsd: 0 }, activeIds),
    ).toHaveLength(0)
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

  it('drops flows below the value threshold before sorting and capping', () => {
    const flows = [
      flow({ id: 'small', value_usd: 10 }),
      flow({ id: 'big', value_usd: 1000, from_iso3: 'PER' }),
    ]
    const result = toArcData(flows, dataset, 300, 500)
    expect(result.arcs.map((a) => a.id)).toEqual(['big'])
    expect(result.totalMatching).toBe(1)
    expect(result.truncated).toBe(false)
  })

  it('treats a zero threshold as no filter at all', () => {
    const result = toArcData([flow({ value_usd: 1 })], dataset, 300, 0)
    expect(result.arcs).toHaveLength(1)
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
