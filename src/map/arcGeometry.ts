/**
 * Geometry for trade routes drawn on a flat web map. Pure, so the shapes are
 * tested rather than eyeballed.
 *
 * An arc runs the short way round the world (a route from Peru to Japan
 * crosses the Pacific, not Asia), so its end longitude may lie beyond ±180.
 * MapLibre draws the world repeated, so such a line is shown wherever you pan.
 */

export type LngLat = [number, number]

/** Signed longitude change from `from` to `to`, the short way, in (-180, 180]. */
export function shortLngDelta(from: number, to: number): number {
  let d = (to - from) % 360
  if (d > 180) d -= 360
  if (d <= -180) d += 360
  return d
}

/**
 * A curved line between two places: a quadratic curve that bows toward the
 * nearer pole, the way a great circle looks on a Mercator map. Longer routes
 * bow further, so they read as sweeps rather than ruler lines.
 */
export function arcLine(from: LngLat, to: LngLat, steps = 48): LngLat[] {
  const [lng1, lat1] = from
  const dLng = shortLngDelta(lng1, to[0])
  const lng2 = lng1 + dLng
  const lat2 = to[1]
  const dx = lng2 - lng1
  const dy = lat2 - lat1
  const dist = Math.hypot(dx, dy)
  if (dist < 1e-6) return [from, [lng2, lat2]]

  const midLat = (lat1 + lat2) / 2
  // Perpendicular to the chord; choose the side that moves away from the equator.
  let px = -dy / dist
  let py = dx / dist
  if (Math.abs(midLat + py) < Math.abs(midLat - py)) {
    px = -px
    py = -py
  }
  const bulge = Math.min(0.22 * dist, 28)
  const cx = (lng1 + lng2) / 2 + px * bulge
  const cy = Math.max(-78, Math.min(78, midLat + py * bulge))

  const line: LngLat[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const a = (1 - t) * (1 - t)
    const b = 2 * (1 - t) * t
    const c = t * t
    line.push([a * lng1 + b * cx + c * lng2, a * lat1 + b * cy + c * lat2])
  }
  return line
}

/** The point a fraction `f` (0..1) of the way along a polyline, by length. */
export function pointAlong(line: readonly LngLat[], f: number): LngLat {
  if (line.length === 0) return [0, 0]
  if (line.length === 1) return line[0]!
  const lengths: number[] = [0]
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!
    const b = line[i]!
    lengths.push(lengths[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1]))
  }
  const total = lengths[lengths.length - 1]!
  const target = Math.max(0, Math.min(1, f)) * total
  for (let i = 1; i < line.length; i++) {
    if (lengths[i]! >= target) {
      const span = lengths[i]! - lengths[i - 1]!
      const k = span === 0 ? 0 : (target - lengths[i - 1]!) / span
      const a = line[i - 1]!
      const b = line[i]!
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]
    }
  }
  return line[line.length - 1]!
}
