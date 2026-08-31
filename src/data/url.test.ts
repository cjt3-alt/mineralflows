import { describe, expect, it } from 'vitest'
import {
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
    const filters: Filters = { mineralIds: ['copper', 'cobalt'], stages: ['mine', 'refine'] }
    expect(roundTrip(filters)).toEqual(filters)
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
    const params = filtersToSearchParams({ mineralIds: ['rare-earths'], stages: ['refine'] })
    expect(params.toString()).toBe('minerals=rare-earths&stages=refine')
  })
})
