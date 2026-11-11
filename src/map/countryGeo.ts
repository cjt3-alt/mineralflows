import { feature } from 'topojson-client'
import type { Topology } from 'topojson-specification'
import coarseTopology from 'world-atlas/countries-110m.json'
import { NUMERIC_TO_ISO3 } from '../data/geo.ts'
import type { ChokepointModel } from '../data/chokepoint.ts'

/**
 * Country polygons for the map, at Natural Earth 1:50m (loaded when the map
 * is, not before), each stamped with the country's share of world mine and
 * refinery output so the map can colour itself from the feature alone.
 */

export type Bounds = [number, number, number, number]

export interface CountryGeo {
  collection: GeoJSON.FeatureCollection
  /** Where to put the label for a country, and the box to fly to when it is chosen. */
  places: Record<string, { name: string; lng: number; lat: number; bounds: Bounds }>
}

type Ring = [number, number][]

function bboxOf(rings: Ring[]): Bounds {
  let minX = 180
  let minY = 90
  let maxX = -180
  let maxY = -90
  for (const [x, y] of rings[0] ?? []) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return [minX, minY, maxX, maxY]
}

/**
 * The atlas cuts the world at the antimeridian, so a country that straddles it
 * (Russia's far east, Fiji) arrives as a ring that leaps from +180 to -180. Drawn flat,
 * that leap becomes a stripe across the whole map. Walking the ring and carrying the
 * longitude on past 180 instead keeps it one piece; the map repeats the world, so it
 * still shows up where it belongs.
 */
export function unwrapRing(ring: Ring): Ring {
  const out: Ring = []
  let offset = 0
  let prev: number | null = null
  for (const [x, y] of ring) {
    if (prev !== null) {
      if (x + offset - prev > 180) offset -= 360
      else if (x + offset - prev < -180) offset += 360
    }
    const lng = x + offset
    out.push([lng, y])
    prev = lng
  }
  return out
}

const area = (b: Bounds) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])

/**
 * The box worth flying to: the biggest piece of the country plus any piece at
 * least a third its size. That keeps the United States to the lower 48 and
 * Alaska together, and keeps France from stretching to French Guiana.
 */
export function mainBounds(polygons: Ring[][]): Bounds {
  const boxes = polygons.map(bboxOf)
  const biggest = Math.max(...boxes.map(area))
  const kept = boxes.filter((b) => area(b) >= biggest / 3)
  const use = kept.length > 0 ? kept : boxes
  return [
    Math.min(...use.map((b) => b[0])),
    Math.min(...use.map((b) => b[1])),
    Math.max(...use.map((b) => b[2])),
    Math.max(...use.map((b) => b[3])),
  ]
}

function unwrapGeometry(g: GeoJSON.Geometry): GeoJSON.Geometry {
  if (g.type === 'Polygon') {
    return { type: 'Polygon', coordinates: (g.coordinates as Ring[]).map(unwrapRing) }
  }
  if (g.type === 'MultiPolygon') {
    return { type: 'MultiPolygon', coordinates: (g.coordinates as Ring[][]).map((p) => p.map(unwrapRing)) }
  }
  return g
}

/**
 * `coarse` (1:110m) is small enough to draw at once; `fine` (1:50m) follows and
 * replaces it, so the land appears immediately and sharpens a moment later.
 */
export async function loadCountryGeo(
  model: ChokepointModel | null,
  detail: 'coarse' | 'fine' = 'fine',
): Promise<CountryGeo> {
  const topology = (
    detail === 'coarse' ? coarseTopology : (await import('world-atlas/countries-50m.json')).default
  ) as unknown as Topology
  const countries = topology.objects.countries
  if (!countries) return { collection: { type: 'FeatureCollection', features: [] }, places: {} }

  const shares = new Map((model?.rows ?? []).map((r) => [r.iso3, r]))
  const raw = feature(topology, countries) as unknown as GeoJSON.FeatureCollection
  const places: CountryGeo['places'] = {}

  const features: GeoJSON.Feature[] = []
  for (const f of raw.features) {
    if (!f.geometry) continue
    const iso3 = f.id !== undefined ? (NUMERIC_TO_ISO3[String(f.id)] ?? '') : ''
    // Antarctica is off the map's edge and only ever a grey slab in the way.
    if (iso3 === 'ATA' || (f.properties as { name?: string } | null)?.name === 'Antarctica') continue
    const geometry = unwrapGeometry(f.geometry)
    const row = shares.get(iso3)
    const name = (f.properties as { name?: string } | null)?.name ?? iso3
    features.push({
      type: 'Feature',
      geometry,
      properties: { iso3, name, mine: row?.mine ?? 0, refine: row?.refine ?? 0 },
    })
    if (iso3) {
      const polygons =
        geometry.type === 'MultiPolygon'
          ? (geometry.coordinates as Ring[][])
          : geometry.type === 'Polygon'
            ? [geometry.coordinates as Ring[]]
            : []
      if (polygons.length > 0) {
        const bounds = mainBounds(polygons)
        places[iso3] = {
          name: row?.name ?? name,
          lng: (bounds[0] + bounds[2]) / 2,
          lat: (bounds[1] + bounds[3]) / 2,
          bounds,
        }
      }
    }
  }
  return { collection: { type: 'FeatureCollection', features }, places }
}
