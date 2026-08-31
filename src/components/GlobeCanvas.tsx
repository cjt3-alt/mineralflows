import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Globe, { type GlobeMethods } from 'react-globe.gl'
import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  MeshPhongMaterial,
  Vector2,
} from 'three'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { feature } from 'topojson-client'
import landTopology from 'world-atlas/land-110m.json'
import type { Topology } from 'topojson-specification'
import type { ArcDatum, PointDatum } from '../data/derive.ts'

/**
 * The globe, and nothing else. Props in, callbacks out: it holds no filter
 * state, fetches nothing, and knows nothing about minerals beyond the colours
 * already baked into the data it is handed.
 */

export interface GlobeCanvasProps {
  points: PointDatum[]
  arcs: ArcDatum[]
  /** Id of the selected facility or flow, so it can be drawn brighter. */
  selectedId: string | null
  /** Turns off bloom and arc animation. */
  reducedMotion: boolean
  /** Bloom is expensive; the shell switches it off on small viewports. */
  bloomEnabled: boolean
  onSelectPoint: (point: PointDatum) => void
  onSelectArc: (arc: ArcDatum) => void
  onClearSelection: () => void
}

/**
 * Natural Earth land at 1:110m, bundled rather than fetched. The topology
 * collapses to a single MultiPolygon, which is split back into one polygon per
 * landmass so globe.gl strokes each outline separately. Done once at module
 * scope; the coastlines do not change.
 */
interface Ring {
  0: number
  1: number
}
type PolygonCoordinates = Ring[][]
interface LandPolygon {
  geometry: { type: 'Polygon'; coordinates: PolygonCoordinates }
}

/** globe.gl declares polygon coordinates as `number[]`, which is wrong for any
 *  real GeoJSON polygon. Cast through this rather than fight the declaration. */
type LooseGeometry = { type: string; coordinates: number[] }

const landPolygons: LandPolygon[] = (() => {
  const topology = landTopology as unknown as Topology
  const land = topology.objects.land
  if (!land) return []
  const collection = feature(topology, land) as unknown as {
    features: { geometry: { type: string; coordinates: unknown } }[]
  }
  const polygons: LandPolygon[] = []
  for (const f of collection.features) {
    if (f.geometry.type === 'MultiPolygon') {
      for (const coordinates of f.geometry.coordinates as PolygonCoordinates[]) {
        polygons.push({ geometry: { type: 'Polygon', coordinates } })
      }
    } else if (f.geometry.type === 'Polygon') {
      polygons.push({
        geometry: { type: 'Polygon', coordinates: f.geometry.coordinates as PolygonCoordinates },
      })
    }
  }
  return polygons
})()

const GLOBE_COLOR = '#080b11'
const LAND_STROKE = '#3d5273'
const GRATICULE_COLOR = '#182335'
/** Degrees between graticule lines, and the segment length used to curve them. */
const GRATICULE_STEP = 15
const GRATICULE_SEGMENT = 3

/**
 * A dark, unlit sphere. Bloom keys off luminance, so the globe body has to stay
 * genuinely dark or a high threshold will not spare it.
 */
function makeGlobeMaterial(): MeshPhongMaterial {
  return new MeshPhongMaterial({
    color: new Color(GLOBE_COLOR),
    emissive: new Color('#000000'),
    shininess: 0,
    transparent: true,
    opacity: 0.96,
  })
}

/** Low-confidence records are drawn faint. They are never promoted to look verified. */
function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')'
}

export function GlobeCanvas({
  points,
  arcs,
  selectedId,
  reducedMotion,
  bloomEnabled,
  onSelectPoint,
  onSelectArc,
  onClearSelection,
}: GlobeCanvasProps) {
  const globeRef = useRef<GlobeMethods | undefined>(undefined)
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  // The globe needs pixel dimensions, so it measures its own box rather than
  // making the shell responsible for layout arithmetic.
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const { width, height } = entry.contentRect
      setSize({ width: Math.round(width), height: Math.round(height) })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const globeMaterial = useMemo(() => makeGlobeMaterial(), [])

  /**
   * Own graticule rather than globe.gl's `showGraticules`. The built-in one is
   * light grey, which sails over the bloom threshold and turns the grid into
   * the brightest thing on screen. Drawn here dark enough to stay under it, so
   * the glow belongs to the data.
   */
  useEffect(() => {
    const globe = globeRef.current
    if (!globe || size.width === 0) return
    const scene = globe.scene()

    const positions: number[] = []
    const push = (lat: number, lng: number) => {
      const { x, y, z } = globe.getCoords(lat, lng, 0.002)
      positions.push(x, y, z)
    }
    for (let lng = -180; lng < 180; lng += GRATICULE_STEP) {
      for (let lat = -90; lat < 90; lat += GRATICULE_SEGMENT) {
        push(lat, lng)
        push(lat + GRATICULE_SEGMENT, lng)
      }
    }
    for (let lat = -75; lat <= 75; lat += GRATICULE_STEP) {
      for (let lng = -180; lng < 180; lng += GRATICULE_SEGMENT) {
        push(lat, lng)
        push(lat, lng + GRATICULE_SEGMENT)
      }
    }

    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    const material = new LineBasicMaterial({
      color: new Color(GRATICULE_COLOR),
      transparent: true,
      opacity: 0.85,
    })
    const grid = new LineSegments(geometry, material)
    scene.add(grid)

    return () => {
      scene.remove(grid)
      geometry.dispose()
      material.dispose()
    }
  }, [size.width])

  /**
   * Bloom, attached to the composer globe.gl already runs. A high threshold on
   * a dark scene means only the arcs and points cross it, which is why there is
   * no second selective-bloom pass fighting the internal render loop.
   */
  useEffect(() => {
    const globe = globeRef.current
    if (!globe || size.width === 0) return

    const composer = globe.postProcessingComposer()
    if (!composer) return

    if (!bloomEnabled || reducedMotion) return

    const pass = new UnrealBloomPass(
      new Vector2(size.width, size.height),
      1.6, // strength
      0.55, // radius
      0.35, // threshold — above the globe body and grid, below the arcs
    )
    composer.addPass(pass)

    return () => {
      composer.removePass(pass)
      pass.dispose()
    }
  }, [bloomEnabled, reducedMotion, size.width, size.height])

  // One orchestrated move on load, then the camera answers only to the user.
  useEffect(() => {
    const globe = globeRef.current
    if (!globe || size.width === 0) return
    globe.pointOfView({ lat: 12, lng: 24, altitude: 2.4 }, reducedMotion ? 0 : 1400)
    const controls = globe.controls()
    controls.enablePan = false
    controls.minDistance = 180
    controls.maxDistance = 600
    // Deliberately no autoRotate: motion answers user action, not idle time.
    controls.autoRotate = false
  }, [reducedMotion, size.width])

  const pointColor = useCallback(
    (datum: object) => {
      const point = datum as PointDatum
      if (point.confidence === 'low') return withAlpha(point.color, 0.38)
      return point.id === selectedId ? '#ffffff' : point.color
    },
    [selectedId],
  )

  const pointAltitude = useCallback((datum: object) => {
    const point = datum as PointDatum
    // Low-confidence sites sit flush against the sphere; verified ones stand
    // proud of it. The difference survives colourblindness and greyscale.
    return point.confidence === 'low' ? 0.006 : 0.022
  }, [])

  const pointRadius = useCallback(
    (datum: object) => {
      const point = datum as PointDatum
      return point.id === selectedId ? point.radius * 1.5 : point.radius
    },
    [selectedId],
  )

  const arcColor = useCallback(
    (datum: object) => {
      const arc = datum as ArcDatum
      if (arc.id === selectedId) return ['#ffffff', arc.color]
      const head = arc.confidence === 'low' ? 0.22 : 0.85
      const tail = arc.confidence === 'low' ? 0.05 : 0.15
      return [withAlpha(arc.color, tail), withAlpha(arc.color, head)]
    },
    [selectedId],
  )

  const arcStroke = useCallback(
    (datum: object) => {
      const arc = datum as ArcDatum
      return arc.id === selectedId ? arc.width * 1.8 : arc.width
    },
    [selectedId],
  )

  /**
   * Low-confidence flows are dashed whether or not anything is animating, so
   * the distinction does not disappear under reduced motion.
   */
  const arcDashLength = useCallback((datum: object) => {
    const arc = datum as ArcDatum
    return arc.confidence === 'low' ? 0.35 : 0.55
  }, [])

  const arcDashGap = useCallback((datum: object) => {
    const arc = datum as ArcDatum
    return arc.confidence === 'low' ? 0.25 : 0.12
  }, [])

  const arcDashAnimateTime = useCallback(
    (datum: object) => {
      if (reducedMotion) return 0
      const arc = datum as ArcDatum
      // Bigger flows travel faster, so the eye reads volume as momentum.
      return 6000 - Math.min(3200, arc.width * 1200)
    },
    [reducedMotion],
  )

  const pointLabel = useCallback((datum: object) => {
    const point = datum as PointDatum
    return point.facility.properties.name
  }, [])

  const arcLabel = useCallback((datum: object) => {
    const arc = datum as ArcDatum
    return arc.flow.from_iso3 + ' → ' + arc.flow.to_iso3
  }, [])

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      {size.width > 0 && (
        <Globe
          ref={globeRef}
          width={size.width}
          height={size.height}
          backgroundColor="rgba(0,0,0,0)"
          globeImageUrl={null}
          globeMaterial={globeMaterial}
          showGlobe
          showAtmosphere={false}
          animateIn={!reducedMotion}
          /* Landmass as an outline only: no fill, so the sphere stays abstract. */
          polygonsData={landPolygons}
          polygonGeoJsonGeometry={(d: object) =>
            (d as LandPolygon).geometry as unknown as LooseGeometry
          }
          polygonCapColor={() => 'rgba(0,0,0,0)'}
          polygonSideColor={() => 'rgba(0,0,0,0)'}
          polygonStrokeColor={() => LAND_STROKE}
          polygonAltitude={0.001}
          pointsData={points}
          pointLat="lat"
          pointLng="lng"
          pointColor={pointColor}
          pointAltitude={pointAltitude}
          pointRadius={pointRadius}
          pointResolution={8}
          pointsMerge={false}
          pointLabel={pointLabel}
          onPointClick={(datum) => onSelectPoint(datum as PointDatum)}
          arcsData={arcs}
          arcStartLat="startLat"
          arcStartLng="startLng"
          arcEndLat="endLat"
          arcEndLng="endLng"
          arcAltitude="altitude"
          arcColor={arcColor}
          arcStroke={arcStroke}
          arcDashLength={arcDashLength}
          arcDashGap={arcDashGap}
          arcDashAnimateTime={arcDashAnimateTime}
          arcCurveResolution={48}
          arcLabel={arcLabel}
          onArcClick={(datum) => onSelectArc(datum as ArcDatum)}
          onGlobeClick={() => onClearSelection()}
        />
      )}
    </div>
  )
}
