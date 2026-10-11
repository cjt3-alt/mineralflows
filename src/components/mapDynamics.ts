/**
 * Pure rules for the flat map: where to cut the world open, how arcs bend,
 * and how zoom and pan are bounded. Kept out of the component so they can be
 * tested without a canvas.
 */

/* ------------------------------------------------------------------ seam */

/** Normalise a longitude to [-180, 180). */
export function wrapLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180
}

/**
 * Does the shorter way round between two longitudes cross a given meridian?
 * A flat map has to be cut somewhere; a flow that crosses the cut is drawn the
 * long way across the map, which reads as wrong.
 */
export function crossesSeam(lngA: number, lngB: number, seam: number): boolean {
  // Measure both ends east of the seam, in [0, 360).
  const a = (((lngA - seam) % 360) + 360) % 360
  const b = (((lngB - seam) % 360) + 360) % 360
  // The short way round crosses the seam exactly when the ends are more than
  // half the world apart measured without crossing it.
  return Math.abs(a - b) > 180
}

/**
 * Where to cut the map: of the meridians that run through open ocean (so no
 * continent is split across the edges), the one the least traded value
 * crosses, so the big flows are never split either. For copper this lands in
 * the Atlantic, which puts the Pacific (Chile and Peru to China) in the middle
 * of the map. Ties prefer the Atlantic default of -30.
 *
 * `isOpenOcean` says whether a meridian is clear of land; leave it out to
 * consider every meridian.
 */
export function chooseSeam(
  flows: { fromLng: number; toLng: number; usd: number }[],
  isOpenOcean: (lng: number) => boolean = () => true,
  step = 5,
): number {
  let best = -30
  let bestCost = Infinity
  for (let seam = -180; seam < 180; seam += step) {
    if (!isOpenOcean(seam)) continue
    let cost = 0
    for (const f of flows) if (crossesSeam(f.fromLng, f.toLng, seam)) cost += f.usd
    const tieBreak = Math.abs(wrapLng(seam + 30)) * 1e-9
    if (cost + tieBreak < bestCost) {
      bestCost = cost + tieBreak
      best = seam
    }
  }
  return best
}

/* ------------------------------------------------------------------- arcs */

export interface Pt {
  x: number
  y: number
}

/** How far an arc bows away from its chord, as a fraction of the chord's length. */
export const ARC_BOW = 0.24

/**
 * The control point for a quadratic arc between two screen points. Arcs bow
 * upward (toward the top of the screen), the way flight-path maps draw them,
 * so parallel flows stack neatly instead of crossing; a near-vertical chord
 * bows to its left.
 */
export function bowControl(a: Pt, b: Pt, bow = ARC_BOW): Pt {
  const mx = (a.x + b.x) / 2
  const my = (a.y + b.y) / 2
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len === 0) return { x: mx, y: my }
  let px = -dy / len
  let py = dx / len
  if (py > 0 || (Math.abs(py) < 1e-6 && px > 0)) {
    px = -px
    py = -py
  }
  return { x: mx + px * len * bow, y: my + py * len * bow }
}

export function quadAt(a: Pt, c: Pt, b: Pt, t: number): Pt {
  const u = 1 - t
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y }
}

/* ------------------------------------------------------------- zoom & pan */

export const MIN_ZOOM = 1
export const MAX_ZOOM = 10
export const ZOOM_STEP = 1.6

export interface View {
  /** Scale on top of the fitted projection. 1 shows the whole map. */
  k: number
  /** Screen translation after scaling. */
  x: number
  y: number
}

/** A rectangle in base-map coordinates (zoom 1) or in screen pixels. */
export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Keep the map filling the visible area. `visible` is the part of the screen
 * not covered by panels; `map` is the map's extent in base coordinates. Along
 * an axis where the zoomed map is smaller than the visible area it is centred
 * in it; where it is larger it can be panned only as far as its own edges.
 */
export function clampView(view: View, visible: Rect, map: Rect): View {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k))
  const axis = (t: number, lo: number, hi: number, start: number, end: number) => {
    const size = (end - start) * k
    if (size <= hi - lo) return (lo + hi) / 2 - ((start + end) / 2) * k
    return Math.min(lo - start * k, Math.max(hi - end * k, t))
  }
  return {
    k,
    x: axis(view.x, visible.left, visible.right, map.left, map.right),
    y: axis(view.y, visible.top, visible.bottom, map.top, map.bottom),
  }
}

/** Zoom by a factor about a screen point, keeping that point fixed under the cursor. */
export function zoomAbout(view: View, factor: number, at: Pt): View {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k * factor))
  const f = k / view.k
  return { k, x: at.x - (at.x - view.x) * f, y: at.y - (at.y - view.y) * f }
}

/** The view that puts a base-map point at a given screen point. */
export function centreOn(base: Pt, k: number, at: Pt): View {
  return { k, x: at.x - base.x * k, y: at.y - base.y * k }
}

/**
 * The view that fits a set of base-map points into the visible area with a
 * margin, zooming in no further than `maxK` (so a single country does not fill
 * the screen) and never out past the whole map.
 */
export function fitPoints(points: Pt[], visible: Rect, margin = 60, maxK = 3): View | null {
  if (points.length === 0) return null
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const left = Math.min(...xs)
  const right = Math.max(...xs)
  const top = Math.min(...ys)
  const bottom = Math.max(...ys)
  const w = Math.max(1, visible.right - visible.left - margin * 2)
  const h = Math.max(1, visible.bottom - visible.top - margin * 2)
  const k = Math.max(MIN_ZOOM, Math.min(maxK, w / Math.max(1, right - left), h / Math.max(1, bottom - top)))
  return centreOn(
    { x: (left + right) / 2, y: (top + bottom) / 2 },
    k,
    { x: (visible.left + visible.right) / 2, y: (visible.top + visible.bottom) / 2 },
  )
}
