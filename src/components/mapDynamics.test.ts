import { describe, expect, it } from 'vitest'
import { bowControl, centreOn, chooseSeam, clampView, crossesSeam, fitPoints, quadAt, wrapLng, zoomAbout } from './mapDynamics.ts'

describe('seam', () => {
  it('knows which flows a cut would split', () => {
    // Chile (-70) to China (116) the short way crosses the Pacific, not the Atlantic.
    expect(crossesSeam(-70, 116, 180)).toBe(true)
    expect(crossesSeam(-70, 116, -30)).toBe(false)
    expect(crossesSeam(10, 20, 15)).toBe(true)
    expect(crossesSeam(10, 20, 100)).toBe(false)
  })

  it('cuts the map where the least value crosses, keeping the Pacific whole for copper', () => {
    const flows = [
      { fromLng: -70, toLng: 116, usd: 21 }, // Chile to China, across the Pacific
      { fromLng: -76, toLng: 116, usd: 15 }, // Peru to China
      { fromLng: 27, toLng: 116, usd: 14 }, // DR Congo to China
      { fromLng: -70, toLng: 2, usd: 1 }, // Chile to Europe, across the Atlantic
    ]
    const seam = chooseSeam(flows)
    expect(crossesSeam(-70, 116, seam)).toBe(false)
    expect(crossesSeam(27, 116, seam)).toBe(false)
  })

  it('never cuts through land, even where less trade would cross', () => {
    const flows = [{ fromLng: -70, toLng: 116, usd: 21 }]
    // Pretend only the mid-Atlantic is open water.
    const seam = chooseSeam(flows, (lng) => lng >= -40 && lng <= -20)
    expect(seam).toBeGreaterThanOrEqual(-40)
    expect(seam).toBeLessThanOrEqual(-20)
  })

  it('wraps longitudes', () => {
    expect(wrapLng(190)).toBe(-170)
    expect(wrapLng(-190)).toBe(170)
  })
})

describe('arcs', () => {
  it('bows upward, the way flight maps draw them', () => {
    const c = bowControl({ x: 0, y: 100 }, { x: 200, y: 100 })
    expect(c.y).toBeLessThan(100)
    const back = bowControl({ x: 200, y: 100 }, { x: 0, y: 100 })
    expect(back.y).toBeLessThan(100)
  })

  it('passes through both ends', () => {
    const a = { x: 0, y: 0 }
    const b = { x: 10, y: 0 }
    const c = bowControl(a, b)
    expect(quadAt(a, c, b, 0)).toEqual(a)
    expect(quadAt(a, c, b, 1)).toEqual(b)
  })
})

describe('zoom and pan', () => {
  // A 1000 x 600 screen with a 1000 x 500 map centred in it.
  const screen = { left: 0, top: 0, right: 1000, bottom: 600 }
  const map = { left: 0, top: 50, right: 1000, bottom: 550 }

  it('centres the whole map at zoom 1, however far it was dragged', () => {
    const v = clampView({ k: 1, x: 300, y: -200 }, screen, map)
    expect(v).toEqual({ k: 1, x: 0, y: 0 })
  })

  it('stops a zoomed map at its edges', () => {
    expect(clampView({ k: 2, x: 500, y: 0 }, screen, map).x).toBe(0)
    expect(clampView({ k: 2, x: -5000, y: 0 }, screen, map).x).toBe(1000 - 2000)
  })

  /** With a panel over the right of the screen, the map can slide left to clear it. */
  it('lets the map slide out from under a panel', () => {
    const visible = { ...screen, right: 620 }
    const v = clampView({ k: 1, x: -380, y: 0 }, visible, map)
    expect(v.x).toBe(-380)
    expect(clampView({ k: 1, x: -900, y: 0 }, visible, map).x).toBe(620 - 1000)
  })

  it('keeps the point under the cursor fixed while zooming', () => {
    const before = { k: 1, x: 0, y: 0 }
    const at = { x: 300, y: 200 }
    const after = zoomAbout(before, 2, at)
    expect(((at.x - before.x) / before.k) * after.k + after.x).toBeCloseTo(at.x)
  })

  it('centres a point where asked', () => {
    const v = centreOn({ x: 100, y: 50 }, 2, { x: 500, y: 300 })
    expect(100 * v.k + v.x).toBe(500)
    expect(50 * v.k + v.y).toBe(300)
  })

  it('fits a set of points into the visible area, without zooming in too far', () => {
    const v = fitPoints([{ x: 100, y: 100 }, { x: 400, y: 300 }], { left: 0, top: 0, right: 600, bottom: 600 }, 50)!
    expect(v.k).toBeCloseTo(500 / 300)
    expect(250 * v.k + v.x).toBeCloseTo(300)
    const one = fitPoints([{ x: 100, y: 100 }], screen, 50, 3)!
    expect(one.k).toBe(3)
  })
})
