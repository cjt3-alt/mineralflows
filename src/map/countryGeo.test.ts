import { describe, expect, it } from 'vitest'
import { mainBounds, unwrapRing } from './countryGeo.ts'

const square = (x: number, y: number, s: number): [number, number][][] => [
  [
    [x, y],
    [x + s, y],
    [x + s, y + s],
    [x, y + s],
    [x, y],
  ],
]

describe('mainBounds', () => {
  it('ignores a far-off speck, like an overseas territory', () => {
    const bounds = mainBounds([square(0, 0, 10), square(-55, 4, 1)])
    expect(bounds).toEqual([0, 0, 10, 10])
  })
  it('keeps a large second piece, like Alaska', () => {
    const bounds = mainBounds([square(0, 0, 10), square(-30, 20, 6)])
    expect(bounds).toEqual([-30, 0, 10, 26])
  })
})

describe('unwrapRing', () => {
  it('carries a ring across the antimeridian instead of leaping', () => {
    const ring = unwrapRing([
      [170, 60],
      [179.5, 65],
      [-179.5, 66],
      [-170, 64],
      [170, 60],
    ])
    expect(ring.map((p) => p[0])).toEqual([170, 179.5, 180.5, 190, 170])
  })
  it('leaves an ordinary ring alone', () => {
    const ring: [number, number][] = [
      [0, 0],
      [5, 0],
      [5, 5],
      [0, 0],
    ]
    expect(unwrapRing(ring)).toEqual(ring)
  })
})
