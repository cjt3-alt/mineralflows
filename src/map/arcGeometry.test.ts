import { describe, expect, it } from 'vitest'
import { arcLine, pointAlong, shortLngDelta } from './arcGeometry.ts'

describe('shortLngDelta', () => {
  it('goes the short way across the antimeridian', () => {
    expect(shortLngDelta(170, -170)).toBe(20)
    expect(shortLngDelta(-170, 170)).toBe(-20)
  })
  it('leaves ordinary spans alone', () => {
    expect(shortLngDelta(-70, 105)).toBe(175)
  })
})

describe('arcLine', () => {
  it('starts and ends exactly at the two places', () => {
    const line = arcLine([-70, -30], [105, 35])
    expect(line[0]).toEqual([-70, -30])
    const end = line[line.length - 1]!
    expect(end[0]).toBeCloseTo(105)
    expect(end[1]).toBeCloseTo(35)
  })
  it('crosses the Pacific rather than Asia for the USA to China', () => {
    const line = arcLine([-98, 39], [105, 35])
    const end = line[line.length - 1]!
    expect(end[0]).toBeLessThan(-180)
  })
  it('bows toward the nearer pole in the northern hemisphere', () => {
    const line = arcLine([0, 50], [60, 50])
    const mid = line[Math.floor(line.length / 2)]!
    expect(mid[1]).toBeGreaterThan(50)
  })
  it('stays on the map', () => {
    const line = arcLine([0, 70], [170, 75])
    for (const [, lat] of line) expect(Math.abs(lat)).toBeLessThanOrEqual(78)
  })
  it('does not blow up for identical places', () => {
    expect(arcLine([10, 10], [10, 10]).length).toBeGreaterThan(0)
  })
})

describe('pointAlong', () => {
  const line: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10],
  ]
  it('finds the ends and the middle by length', () => {
    expect(pointAlong(line, 0)).toEqual([0, 0])
    expect(pointAlong(line, 1)).toEqual([10, 10])
    expect(pointAlong(line, 0.5)).toEqual([10, 0])
  })
})
