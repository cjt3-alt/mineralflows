import { describe, expect, it } from 'vitest'
import { isDoubleTap, isTap } from './cameraDynamics.ts'

describe('taps', () => {
  it('counts a quick, still, single-finger press', () => {
    expect(isTap({ durationMs: 120, movedPx: 2, maxPointers: 1 })).toBe(true)
  })

  /** A pinch that ends near where it started must not focus a country and reset the zoom. */
  it('never counts a pinch', () => {
    expect(isTap({ durationMs: 120, movedPx: 0, maxPointers: 2 })).toBe(false)
  })

  it('does not count a slow press or a small drag', () => {
    expect(isTap({ durationMs: 600, movedPx: 0, maxPointers: 1 })).toBe(false)
    expect(isTap({ durationMs: 100, movedPx: 9, maxPointers: 1 })).toBe(false)
  })

  it('pairs two nearby taps into a double tap, and nothing else', () => {
    const first = { at: 1000, x: 100, y: 100 }
    expect(isDoubleTap(first, { at: 1200, x: 105, y: 98 })).toBe(true)
    expect(isDoubleTap(first, { at: 1600, x: 100, y: 100 })).toBe(false)
    expect(isDoubleTap(first, { at: 1100, x: 200, y: 100 })).toBe(false)
    expect(isDoubleTap(null, first)).toBe(false)
  })
})
