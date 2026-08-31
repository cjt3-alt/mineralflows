import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseDataset, type RawFiles } from './load.ts'
import { resolveValue } from './derive.ts'

/**
 * These run against the real files in public/data/, not fixtures. The point is
 * that a bad hand edit or a bad ETL run fails in CI rather than on the globe.
 */

function read(file: string): unknown {
  return JSON.parse(readFileSync(new URL('../../public/data/' + file, import.meta.url), 'utf8'))
}

const raw: RawFiles = {
  minerals: read('minerals.json'),
  facilities: read('facilities.geojson'),
  flows: read('flows.json'),
  prices: read('prices.json'),
  countries: read('countries.json'),
  meta: read('meta.json'),
}

describe('seed dataset', () => {
  const dataset = parseDataset(raw)

  it('validates and joins without error', () => {
    expect(dataset.minerals.length).toBeGreaterThan(0)
    expect(dataset.facilities.length).toBeGreaterThan(0)
    expect(dataset.flows.length).toBeGreaterThan(0)
  })

  it('covers all four v1 minerals, all active', () => {
    expect(dataset.activeMinerals.map((m) => m.id)).toEqual([
      'copper',
      'lithium',
      'cobalt',
      'rare-earths',
    ])
  })

  it('has facilities and flows for every active mineral', () => {
    for (const mineral of dataset.activeMinerals) {
      expect(
        dataset.facilities.some((f) => f.properties.mineral_ids.includes(mineral.id)),
        'no facility for ' + mineral.id,
      ).toBe(true)
      expect(
        dataset.flows.some((f) => f.mineral_id === mineral.id),
        'no flow for ' + mineral.id,
      ).toBe(true)
    }
  })

  it('exercises the low-confidence path with at least two facilities', () => {
    const low = dataset.facilities.filter((f) => f.properties.confidence === 'low')
    expect(low.length).toBeGreaterThanOrEqual(2)
  })

  it('exercises the estimated path with several flows', () => {
    const estimated = dataset.flows.filter((f) => f.source === 'estimated')
    expect(estimated.length).toBeGreaterThanOrEqual(3)
  })

  /**
   * The whole point of labelling a value estimated is that it equals
   * volume x price. If someone edits one side and not the other, the label
   * becomes a lie, so it is checked rather than trusted.
   */
  it('every estimated flow value is exactly volume x price for its year', () => {
    for (const flow of dataset.flows.filter((f) => f.source === 'estimated')) {
      const price = dataset.priceFor(flow.mineral_id, flow.year)
      expect(price, 'no price for ' + flow.mineral_id + ' in ' + flow.year).toBeDefined()
      expect(flow.volume_tonnes).not.toBeNull()
      const expected = flow.volume_tonnes! * price!.avg_price_usd_per_tonne
      expect(flow.value_usd, flow.id + ' value does not match volume x price').toBeCloseTo(
        expected,
        2,
      )
    }
  })

  it('reports every flow value as estimated or not, never ambiguously', () => {
    for (const flow of dataset.flows) {
      const resolved = resolveValue(flow, dataset.priceFor)
      expect(resolved.usd).not.toBeNull()
      expect(resolved.estimated).toBe(flow.source === 'estimated')
    }
  })

  /**
   * Deliberate gap, not an oversight: there is no HS code for rare earth ore,
   * so rare earths have no mine-stage trade. The stage filter has to survive it.
   */
  it('rare earths have refine-stage flows only, and no mine trade code', () => {
    const ree = dataset.mineralsById.get('rare-earths')
    expect(ree).toBeDefined()
    expect(ree!.trade_codes.some((c) => c.stage === 'mine')).toBe(false)

    const reeFlows = dataset.flows.filter((f) => f.mineral_id === 'rare-earths')
    expect(reeFlows.length).toBeGreaterThan(0)
    for (const flow of reeFlows) {
      expect(flow.stage_from).toBe('refine')
      expect(flow.stage_to).toBe('refine')
    }
  })

  it('keeps excluded HS codes in the config as inactive rather than dropping them', () => {
    const copper = dataset.mineralsById.get('copper')
    expect(copper).toBeDefined()
    const inactive = copper!.trade_codes.filter((c) => !c.active).map((c) => c.hs_code)
    expect(inactive).toContain('740400')
    expect(copper!.hs_codes).not.toContain('740400')
  })

  it('names a vintage for every source so the legend can be honest per source', () => {
    expect(dataset.meta.sources.length).toBeGreaterThan(0)
    for (const source of dataset.meta.sources) {
      expect(source.vintage.length).toBeGreaterThan(0)
      expect(source.coverage.length).toBeGreaterThan(0)
    }
  })
})
