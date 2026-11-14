import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applySitePositions, parseDataset, type RawFiles } from './load.ts'
import { resolveValue } from './derive.ts'
import { FacilityCollectionSchema, FlowsFileSchema, parseFile } from './schema.ts'

/**
 * Two suites, over two different files, because they check two different things.
 *
 * The first runs against public/data/, which is whatever the ETL last wrote and
 * what the browser actually loads. It asserts rules that must hold for any
 * dataset: the files join up, every value is either traded or estimated and
 * never ambiguously both, and an estimated value really is volume x price.
 *
 * The second runs against etl/seed/, the hand-authored fallback. Its job is to
 * exercise the code paths a real extract might not contain — low-confidence
 * facilities, estimated values — so those paths stay covered even when the live
 * data has no examples of them. Asserting "there are at least three estimated
 * flows" against public/data would fail the moment a real trade source lands,
 * because trade statistics report values rather than volumes.
 */

function read(file: string): unknown {
  return JSON.parse(readFileSync(new URL('../../public/data/' + file, import.meta.url), 'utf8'))
}

function readSeed(file: string): unknown {
  return JSON.parse(readFileSync(new URL('../../etl/seed/' + file, import.meta.url), 'utf8'))
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

describe('seed dataset', () => {
  const dataset = parseDataset(raw)

  describe('production', () => {
    const latest = (stage: 'mine' | 'refine') => {
      const record = dataset.production
        .filter((p) => p.mineral_id === 'copper' && p.stage === stage)
        .sort((a, b) => b.year - a.year)[0]
      if (!record) throw new Error('no copper ' + stage + ' production in production.json')
      return record
    }
    const share = (record: ReturnType<typeof latest>, iso3: string) =>
      (record.by_country[iso3] ?? 0) / record.world_total

    it('never lists more than the world total, and `other` closes the gap', () => {
      for (const record of dataset.production) {
        const listed = Object.values(record.by_country).reduce((a, b) => a + b, 0)
        expect(listed).toBeLessThanOrEqual(record.world_total * 1.01)
        expect(listed + record.other).toBeGreaterThanOrEqual(record.world_total * 0.99)
      }
    })

    it('shows the chokepoint: China refines several times what it mines', () => {
      const mine = latest('mine')
      const refine = latest('refine')
      const mineShare = share(mine, 'CHN')
      const refineShare = share(refine, 'CHN')
      expect(refineShare).toBeGreaterThan(0.4)
      expect(mineShare).toBeLessThan(0.15)
      expect(refineShare / mineShare).toBeGreaterThan(3)
    })

    it('shows the mirror image: Peru mines a lot and refines almost none', () => {
      const mine = latest('mine')
      const refine = latest('refine')
      expect(share(mine, 'PER')).toBeGreaterThan(0.08)
      expect(share(refine, 'PER')).toBeLessThan(0.03)
    })
  })

  it('validates and joins without error', () => {
    expect(dataset.minerals.length).toBeGreaterThan(0)
    expect(dataset.facilities.length).toBeGreaterThan(0)
    expect(dataset.flows.length).toBeGreaterThan(0)
  })

  // Scoped to copper only while the app is being critiqued on one mineral
  // before the other three are switched back on in etl/config/minerals.json.
  it('covers copper, the only currently active mineral', () => {
    expect(dataset.activeMinerals.map((m) => m.id)).toEqual(['copper'])
    expect(dataset.minerals.map((m) => m.id)).toEqual([
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

    // Rare earths are switched off while the app is scoped to copper only, so
    // public/data currently has none of its flows to check the stage on.
    const reeFlows = dataset.flows.filter((f) => f.mineral_id === 'rare-earths')
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

/**
 * The fallback the ETL falls back to when no real source produces facilities or
 * flows. It is loaded and validated here rather than trusted, because a broken
 * seed only shows up on a runner with no network and no manual drops, which is
 * the least convenient place to find out.
 */
describe('seed fallback dataset', () => {
  const facilities = parseFile(
    'etl/seed/facilities.geojson',
    FacilityCollectionSchema,
    readSeed('facilities.geojson'),
  ).features
  const flows = parseFile('etl/seed/flows.json', FlowsFileSchema, readSeed('flows.json'))

  it('exercises the low-confidence path with at least two facilities', () => {
    expect(facilities.filter((f) => f.properties.confidence === 'low').length).toBeGreaterThanOrEqual(2)
  })

  it('exercises the estimated path with several flows', () => {
    expect(flows.filter((f) => f.source === 'estimated').length).toBeGreaterThanOrEqual(3)
  })

  /**
   * The seed stores estimated flows with a null value on purpose: the pipeline
   * derives it from volume x price on every run, so the estimated-value path is
   * live code rather than a number frozen into a file. If a value ever appears
   * here, that derivation has been quietly bypassed.
   */
  it('leaves estimated values to be derived rather than storing them', () => {
    for (const flow of flows.filter((f) => f.source === 'estimated')) {
      expect(flow.value_usd, flow.id + ' has a stored value the pipeline should derive').toBeNull()
      expect(flow.volume_tonnes, flow.id + ' has no volume to derive a value from').not.toBeNull()
    }
  })
})

describe('applySitePositions', () => {
  const facility = (id: string, lng: number, lat: number) =>
    ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: { id },
    }) as unknown as Parameters<typeof applySitePositions>[0][number]
  const table = {
    positions: {
      a: { lng: 10.01, lat: 20.01, from: [10, 20], moved_km: 1.5 },
      b: { lng: 11.01, lat: 21.01, from: [11, 21], moved_km: 0.4, close_call: true },
      c: { lng: 12.01, lat: 22.01, from: [12, 22], moved_km: 0.4, checked: true },
      e: { lng: 13.01, lat: 23.01, from: [13, 23], moved_km: 2.6, far_snap: true },
      g: { lng: 14.01, lat: 24.01, from: [14, 24], moved_km: 1.2, method: 'placed_on_imagery', source: 'the works' },
    },
  }

  it('moves a facility that still reports the point the move was computed from', () => {
    const out = applySitePositions([facility('a', 10, 20)], table)
    expect(out.facilities[0]!.geometry.coordinates).toEqual([10.01, 20.01])
    expect(out.repositioned.get('a')).toEqual({ fromLng: 10, fromLat: 20, km: 1.5, method: 'snapped_to_outline' })
  })

  it('carries the close-call flag through', () => {
    const out = applySitePositions([facility('b', 11, 21)], table)
    expect(out.repositioned.get('b')?.closeCall).toBe(true)
    expect(applySitePositions([facility('a', 10, 20)], table).repositioned.get('a')?.closeCall).toBeUndefined()
  })

  it('carries the far-snap flag and the hand-placed method through', () => {
    expect(applySitePositions([facility('e', 13, 23)], table).repositioned.get('e')?.farSnap).toBe(true)
    const placed = applySitePositions([facility('g', 14, 24)], table).repositioned.get('g')
    expect(placed?.method).toBe('placed_on_imagery')
    expect(placed?.source).toBe('the works')
  })

  it('carries a verified note', () => {
    const out = applySitePositions([facility('a', 10, 20)], { verified: { a: { note: 'on the plant' } } })
    expect(out.notes.get('a')).toEqual({ kind: 'verified', text: 'on the plant' })
  })

  it('carries the checked flag through', () => {
    expect(applySitePositions([facility('c', 12, 22)], table).repositioned.get('c')?.checked).toBe(true)
  })

  it('ignores a move once the source reports a different point', () => {
    const out = applySitePositions([facility('a', 11, 21)], table)
    expect(out.facilities[0]!.geometry.coordinates).toEqual([11, 21])
    expect(out.repositioned.size).toBe(0)
  })

  it('hides a duplicate only while it still has the reviewed name', () => {
    const named = (id: string, name: string) => ({ ...facility(id, 1, 2), properties: { id, name } }) as unknown as Parameters<typeof applySitePositions>[0][number]
    const file = { hidden: { d: { name: 'Dup refinery', duplicate_of: 'x', reason: 'r' } } }
    expect(applySitePositions([named('d', 'Dup refinery'), named('e', 'Keep')], file).facilities.map((f) => f.properties.id)).toEqual(['e'])
    expect(applySitePositions([named('d', 'Renamed')], file).facilities).toHaveLength(1)
  })

  it('carries doubtful positions without moving the dot', () => {
    const file = { doubtful: { a: { reason: 'in a town' }, b: { reason: 5 } } }
    const out = applySitePositions([facility('a', 10, 20)], file)
    expect(out.notes.get('a')).toEqual({ kind: 'doubtful', text: 'in a town' })
    expect(out.notes.has('b')).toBe(false)
    expect(out.facilities[0]!.geometry.coordinates).toEqual([10, 20])
  })

  it('survives a missing or malformed file', () => {
    for (const bad of [[], null, {}, { positions: 5 }, { positions: { a: { lng: 'x', from: [10, 20] } } }]) {
      const out = applySitePositions([facility('a', 10, 20)], bad)
      expect(out.facilities[0]!.geometry.coordinates).toEqual([10, 20])
    }
  })

  it('moves only dots that sit on a real outline in the shipped data', () => {
    const positions = read('site_positions.json') as {
      hidden: Record<string, unknown>
      doubtful: Record<string, unknown>
      verified: Record<string, unknown>
    }
    const real = parseDataset({ ...raw, sitePositions: positions })
    expect(real.repositioned.size).toBeGreaterThan(100)
    expect([...real.repositioned.values()].filter((r) => r.closeCall).length).toBeGreaterThan(0)
    expect(real.hiddenDuplicates.size).toBe(Object.keys(positions.hidden).length)
    expect(real.hiddenDuplicates.size).toBeGreaterThanOrEqual(4)
    expect(real.positionNotes.size).toBe(
      Object.keys(positions.doubtful).length + Object.keys(positions.verified).length,
    )
    expect(real.facilities.some((f) => f.properties.name === 'Glogow refinery')).toBe(false)
    expect(real.facilities.some((f) => f.properties.name === 'Glogow metallurgical complex')).toBe(true)
    for (const r of real.repositioned.values()) {
      // SNAP_MAX_KM is 3 in etl/outlines.py, plus the few metres the dot steps inside the edge.
      if (r.method === 'snapped_to_outline') expect(r.km).toBeLessThanOrEqual(3.1)
      else expect(r.source).toBeTruthy()
    }
  })
})
