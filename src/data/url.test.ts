import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TOP_N,
  EMPTY_FILTERS,
  filtersFromSearchParams,
  filtersToSearchParams,
  type Filters,
} from './derive.ts'

const KNOWN = ['copper', 'lithium', 'cobalt', 'rare-earths']

function roundTrip(filters: Filters): Filters {
  return filtersFromSearchParams(filtersToSearchParams(filters), KNOWN)
}

describe('filter URL round-trip', () => {
  it('leaves the default view with a clean URL', () => {
    expect(filtersToSearchParams(EMPTY_FILTERS).toString()).toBe('')
  })

  it('round-trips minerals and stages', () => {
    const filters: Filters = {
      ...EMPTY_FILTERS,
      mineralIds: ['copper', 'cobalt'],
      stages: ['mine', 'refine'],
      flowKinds: ['refine'],
    }
    expect(roundTrip(filters)).toEqual(filters)
  })

  it('round-trips the flow count and a focused country', () => {
    const filters: Filters = { ...EMPTY_FILTERS, topN: 25, country: 'CHL' }
    expect(filtersFromSearchParams(filtersToSearchParams(filters), KNOWN, ['CHL'])).toEqual(filters)
  })

  it('ignores a flow count that is not one of the options', () => {
    expect(filtersFromSearchParams(new URLSearchParams('top=banana'), KNOWN).topN).toBe(DEFAULT_TOP_N)
    expect(filtersFromSearchParams(new URLSearchParams('top=5000'), KNOWN).topN).toBe(DEFAULT_TOP_N)
  })

  it('ignores a country it does not know', () => {
    expect(filtersFromSearchParams(new URLSearchParams('country=ATL'), KNOWN, ['CHL']).country).toBeNull()
  })

  it('ignores the retired minValue parameter rather than failing on an old link', () => {
    expect(filtersFromSearchParams(new URLSearchParams('minValue=5000000'), KNOWN)).toEqual(EMPTY_FILTERS)
  })

  it('reads an empty query as no filters, not as nothing selected', () => {
    expect(filtersFromSearchParams(new URLSearchParams(''), KNOWN)).toEqual(EMPTY_FILTERS)
  })

  /** A stale or hand-edited link should widen the view, never empty it. */
  it('drops mineral ids it does not recognise', () => {
    const params = new URLSearchParams('minerals=copper,unobtainium')
    expect(filtersFromSearchParams(params, KNOWN).mineralIds).toEqual(['copper'])
  })

  it('drops stages it does not recognise', () => {
    const params = new URLSearchParams('stages=mine,smelt')
    expect(filtersFromSearchParams(params, KNOWN).stages).toEqual(['mine'])
  })

  it('survives junk without throwing', () => {
    const params = new URLSearchParams('minerals=,,&stages=')
    expect(filtersFromSearchParams(params, KNOWN)).toEqual(EMPTY_FILTERS)
  })

  it('writes a query a person can read', () => {
    const params = filtersToSearchParams({
      ...EMPTY_FILTERS,
      mineralIds: ['rare-earths'],
      stages: ['refine'],
    })
    expect(params.toString()).toBe('minerals=rare-earths&stages=refine')
  })
})
