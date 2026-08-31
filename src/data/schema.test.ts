import { describe, expect, it } from 'vitest'
import {
  DataValidationError,
  FlowSchema,
  MineralSchema,
  PointGeometrySchema,
  parseFile,
} from './schema.ts'

/** Bad data must crash with the offending record, not be quietly coerced. */

const validMineral = {
  id: 'copper',
  name: 'Copper',
  hs_codes: ['260300'],
  trade_codes: [
    { hs_code: '260300', stage: 'mine', label: 'Copper ores and concentrates', active: true },
    { hs_code: '740400', stage: 'refine', label: 'Copper waste and scrap', active: false },
  ],
  usgs_commodity_code: 'copper',
  color: '#ff7a45',
  glow_intensity: 0.9,
  sort_order: 1,
  active: true,
}

const validFlow = {
  id: 'cu-chl-chn-2024',
  from_iso3: 'CHL',
  to_iso3: 'CHN',
  mineral_id: 'copper',
  year: 2024,
  value_usd: 100,
  volume_tonnes: 10,
  stage_from: 'mine',
  stage_to: 'process',
  source: 'seed',
  confidence: 'high',
}

describe('MineralSchema', () => {
  it('accepts a well-formed mineral', () => {
    expect(MineralSchema.parse(validMineral).id).toBe('copper')
  })

  it('rejects hs_codes that have drifted from the active trade_codes', () => {
    const drifted = { ...validMineral, hs_codes: ['260300', '740400'] }
    const result = MineralSchema.safeParse(drifted)
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toContain('hs_codes must list exactly')
  })

  it('rejects a duplicated HS code', () => {
    const dupe = {
      ...validMineral,
      trade_codes: [...validMineral.trade_codes, validMineral.trade_codes[0]],
    }
    expect(MineralSchema.safeParse(dupe).success).toBe(false)
  })

  it('rejects a colour that is not a 6-digit hex', () => {
    expect(MineralSchema.safeParse({ ...validMineral, color: 'orange' }).success).toBe(false)
  })
})

describe('FlowSchema', () => {
  it('accepts a well-formed flow', () => {
    expect(FlowSchema.parse(validFlow).id).toBe('cu-chl-chn-2024')
  })

  it('rejects a flow with neither a value nor a volume', () => {
    const empty = { ...validFlow, value_usd: null, volume_tonnes: null }
    const result = FlowSchema.safeParse(empty)
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toContain('at least one of')
  })

  it('rejects a self-flow, which has no arc to draw', () => {
    expect(FlowSchema.safeParse({ ...validFlow, to_iso3: 'CHL' }).success).toBe(false)
  })

  it('rejects an estimated flow with no volume behind it', () => {
    const bad = { ...validFlow, source: 'estimated', volume_tonnes: null }
    expect(FlowSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a lowercase ISO code rather than coercing it', () => {
    expect(FlowSchema.safeParse({ ...validFlow, from_iso3: 'chl' }).success).toBe(false)
  })
})

describe('PointGeometrySchema', () => {
  /**
   * Bounds only catch a swapped pair when the longitude is past +/-90, which is
   * where most of this dataset sits. Escondida at [-69.07, -24.27] swaps to a
   * latitude that is still legal, so the bounds are a net, not a guarantee.
   */
  it('rejects a swapped pair when the longitude is past the latitude range', () => {
    // Guixi smelter: lat 28.29, lon 117.21. Swapped, the latitude is impossible.
    expect(
      PointGeometrySchema.safeParse({ type: 'Point', coordinates: [28.29, 117.21] }).success,
    ).toBe(false)
  })

  it('accepts correctly ordered coordinates', () => {
    expect(
      PointGeometrySchema.parse({ type: 'Point', coordinates: [-69.07, -24.27] }).coordinates[1],
    ).toBe(-24.27)
  })
})

describe('parseFile', () => {
  it('throws naming the file and printing the offending record', () => {
    const flows = [validFlow, { ...validFlow, id: 'bad-flow', year: 'twenty twenty four' }]
    let thrown: unknown
    try {
      parseFile('flows.json', FlowSchema.array(), flows)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(DataValidationError)
    const error = thrown as DataValidationError
    expect(error.message).toContain('flows.json')
    expect(error.message).toContain('bad-flow')
    expect(error.offending).toMatchObject({ id: 'bad-flow' })
  })
})
