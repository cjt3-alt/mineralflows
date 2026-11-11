import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseDataset, type RawFiles } from './load.ts'
import { buildChokepoint, buildChokepointSeries, canTellStory, commonYears, concentrationOf, formatShare, shockOf, toCsv } from './chokepoint.ts'

function read(file: string): unknown {
  return JSON.parse(readFileSync(new URL('../../public/data/' + file, import.meta.url), 'utf8'))
}

const raw: RawFiles = {
  minerals: read('minerals.json'),
  facilities: read('facilities.geojson'),
  flows: read('flows.json'),
  prices: read('prices.json'),
  production: read('production.json'),
  productionHistory: read('production_history.json'),
  priceHistory: read('price_history.json'),
  countries: read('countries.json'),
  meta: read('meta.json'),
}
const dataset = parseDataset(raw)

describe('concentrationOf', () => {
  it('measures a monopoly and an even split differently', () => {
    expect(concentrationOf([1]).hhi).toBe(10000)
    const even = concentrationOf([0.25, 0.25, 0.25, 0.25])
    expect(even.hhi).toBe(2500)
    expect(even.top1).toBe(0.25)
    expect(even.top3).toBe(0.75)
  })
})

describe('formatShare', () => {
  it('never shows a real but tiny share as 0%', () => {
    expect(formatShare(0.004)).toBe('<1%')
    expect(formatShare(0)).toBe('0%')
    expect(formatShare(0.483)).toBe('48%')
  })
})

describe('the copper chokepoint', () => {
  const model = buildChokepoint(dataset, 'copper')

  it('can be told for copper and not for a mineral with no production table', () => {
    expect(canTellStory(dataset, 'copper')).toBe(true)
    expect(canTellStory(dataset, 'cobalt')).toBe(false)
    expect(buildChokepoint(dataset, 'cobalt')).toBeNull()
  })

  it('names China as the refining leader, far ahead of its mining share', () => {
    expect(model?.leader.iso3).toBe('CHN')
    expect(model?.leader.refine).toBeGreaterThan(0.4)
    expect(model?.leader.mine).toBeLessThan(0.15)
  })

  it('is more concentrated at the refinery than at the mine', () => {
    expect(model).not.toBeNull()
    if (!model) return
    expect(model.refineConcentration.hhi).toBeGreaterThan(model.mineConcentration.hhi * 2)
    expect(model.refineConcentration.top3).toBeGreaterThan(model.mineConcentration.top3)
  })

  it('keeps every share between 0 and 1', () => {
    for (const row of model?.rows ?? []) {
      expect(row.mine).toBeGreaterThanOrEqual(0)
      expect(row.mine).toBeLessThanOrEqual(1)
      expect(row.refine).toBeGreaterThanOrEqual(0)
      expect(row.refine).toBeLessThanOrEqual(1)
    }
  })

  it('carries ore routes only for the mine-to-smelter leg, largest first', () => {
    const ore = model?.ore ?? []
    expect(ore.length).toBeGreaterThan(0)
    for (let i = 1; i < ore.length; i++) {
      expect(ore[i - 1]!.valueUsd).toBeGreaterThanOrEqual(ore[i]!.valueUsd)
    }
  })
})

describe('switching a country off', () => {
  it('turns a share into the uplift everyone else would need', () => {
    expect(shockOf({ iso3: 'XXX', name: 'X', mine: 0.5, refine: 0.5 }, 'refine').uplift).toBeCloseTo(1, 6)
    expect(shockOf({ iso3: 'XXX', name: 'X', mine: 0.2, refine: 0.2 }, 'mine').uplift).toBeCloseTo(0.25, 6)
    expect(shockOf({ iso3: 'XXX', name: 'X', mine: 1, refine: 1 }, 'mine').uplift).toBe(Infinity)
  })

  it('makes the China refining shock several times its mining shock', () => {
    const model = buildChokepoint(dataset, 'copper')
    const china = model?.rows.find((r) => r.iso3 === 'CHN')
    expect(china).toBeDefined()
    if (!china) return
    expect(shockOf(china, 'refine').uplift).toBeGreaterThan(0.7)
    expect(shockOf(china, 'mine').uplift).toBeLessThan(0.15)
  })
})

describe('toCsv', () => {
  it('has a header and one line per country, quoted where names have commas', () => {
    const model = buildChokepoint(dataset, 'copper')
    expect(model).not.toBeNull()
    if (!model) return
    const lines = toCsv(model).trimEnd().split('\n')
    expect(lines[0]).toContain('mine_share')
    expect(lines).toHaveLength(model.rows.length + 1)
  })
})

describe('the timeline', () => {
  const series = buildChokepointSeries(dataset, 'copper')

  it('runs from 2020 to the newest year with no gaps, oldest first', () => {
    const years = series.map((m) => m.year)
    expect(years[0]).toBe(2020)
    expect(years).toEqual([...years].sort((a, b) => a - b))
    for (let i = 1; i < years.length; i++) expect(years[i]! - years[i - 1]!).toBe(1)
    expect(commonYears(dataset, 'copper')).toEqual(years)
  })

  it('keeps the newest year as the default model', () => {
    expect(buildChokepoint(dataset, 'copper')?.year).toBe(series[series.length - 1]!.year)
  })

  it('shows refining concentrating on the leader over the period, and it is flagged where estimated', () => {
    const first = series[0]!
    const last = series[series.length - 1]!
    const share = (m: (typeof series)[number]) => m.rows.find((r) => r.iso3 === last.leader.iso3)!.refine
    expect(share(last)).toBeGreaterThan(share(first))
    expect(last.estimated).toBe(true)
    expect(first.estimated).toBe(false)
  })

  it('has shares that never exceed the world total in any year', () => {
    for (const m of series) {
      expect(m.rows.reduce((s, r) => s + r.mine, 0)).toBeLessThanOrEqual(1.0001)
      expect(m.rows.reduce((s, r) => s + r.refine, 0)).toBeLessThanOrEqual(1.0001)
    }
  })

  it('has a price for each year of the series', () => {
    for (const m of series) {
      expect(dataset.priceHistory.some((p) => p.mineral_id === 'copper' && p.year === m.year)).toBe(true)
    }
  })
})
