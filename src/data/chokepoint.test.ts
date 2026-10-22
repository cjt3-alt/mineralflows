import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseDataset, type RawFiles } from './load.ts'
import { buildChokepoint, canTellStory, concentrationOf, formatShare } from './chokepoint.ts'

function read(file: string): unknown {
  return JSON.parse(readFileSync(new URL('../../public/data/' + file, import.meta.url), 'utf8'))
}

const raw: RawFiles = {
  minerals: read('minerals.json'),
  facilities: read('facilities.geojson'),
  flows: read('flows.json'),
  prices: read('prices.json'),
  production: read('production.json'),
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
