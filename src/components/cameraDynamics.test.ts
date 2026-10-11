import { describe, expect, it } from 'vitest'
import {
  IDLE_RESUME_MS,
  MIN_ALTITUDE,
  clampAltitude,
  framingAltitude,
  grabRotateSpeed,
  isDoubleTap,
  isTap,
  maxAltitude,
  shouldAutoRotate,
} from './cameraDynamics.ts'

describe('grabRotateSpeed', () => {
  it('scales with altitude, so a drag covers the same ground at any zoom', () => {
    expect(grabRotateSpeed(2) / grabRotateSpeed(1)).toBeCloseTo(2)
  })

  it('never stalls or runs away', () => {
    expect(grabRotateSpeed(0)).toBeGreaterThan(0)
    expect(grabRotateSpeed(100)).toBeLessThanOrEqual(1.5)
  })
})

describe('zoom limits', () => {
  it('fits the globe on a phone and a desktop', () => {
    expect(framingAltitude(390, 700)).toBeGreaterThan(framingAltitude(1200, 800))
  })

  it('clamps between close-up and a little past the framed globe', () => {
    expect(clampAltitude(0.01, 1200, 800)).toBe(MIN_ALTITUDE)
    expect(clampAltitude(99, 1200, 800)).toBe(maxAltitude(1200, 800))
    expect(clampAltitude(1, 1200, 800)).toBe(1)
  })
})

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

describe('shouldAutoRotate', () => {
  const base = { now: 100_000, lastInteraction: null, pointerDown: false, busy: false, reducedMotion: false }

  it('turns on load, before anyone has touched it', () => {
    expect(shouldAutoRotate(base)).toBe(true)
  })

  it('stops while a finger is down, and stays stopped for the idle period after', () => {
    expect(shouldAutoRotate({ ...base, pointerDown: true })).toBe(false)
    expect(shouldAutoRotate({ ...base, lastInteraction: base.now - 1000 })).toBe(false)
    expect(shouldAutoRotate({ ...base, lastInteraction: base.now - IDLE_RESUME_MS })).toBe(true)
  })

  it('stays off while something is selected or under reduced motion', () => {
    expect(shouldAutoRotate({ ...base, busy: true })).toBe(false)
    expect(shouldAutoRotate({ ...base, reducedMotion: true })).toBe(false)
  })
})
