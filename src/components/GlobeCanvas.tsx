import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
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
 *
 * One piece of state does live here: the keyboard cursor. A WebGL canvas is
 * unreachable by keyboard, which would leave the detail panel — the only place
 * a source, a confidence rating or an estimated-value warning is shown —
 * openable by mouse alone. So the canvas takes focus, arrow keys walk the
 * visible sites and flows, and Enter opens the one under the cursor. The cursor
 * is separate from the selection on purpose: moving it must not pull focus into
 * the panel, or the next arrow key would go somewhere else.
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

/**
 * globe.gl's camera has a 50 degree *vertical* field of view, so a tall narrow
 * viewport crops the globe at the sides however far back a fixed altitude puts
 * the camera. This works out how far back it has to be for the sphere to fit
 * the narrower axis, which keeps the whole globe on screen on a phone without
 * shrinking it to a dot on a desktop.
 */
const CAMERA_FOV_DEGREES = 50
const DEFAULT_ALTITUDE = 2.4

function framingAltitude(width: number, height: number): number {
  if (width === 0 || height === 0) return DEFAULT_ALTITUDE
  const halfVertical = ((CAMERA_FOV_DEGREES / 2) * Math.PI) / 180
  const halfHorizontal = Math.atan(Math.tan(halfVertical) * (width / height))
  const half = Math.min(halfVertical, halfHorizontal)
  // Distance in globe radii at which the sphere exactly fills that axis, plus a
  // margin so the arcs, which stand off the surface, are not clipped either.
  return Math.max(DEFAULT_ALTITUDE, (1 / Math.sin(half)) * 1.25 - 1)
}

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
  const [cursor, setCursor] = useState(0)
  const [keyboardActive, setKeyboardActive] = useState(false)

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
   * What the arrow keys walk. Flows come first because they are the larger
   * story and are already sorted by value; sites follow in the order the
   * filters produced them. Rebuilt whenever the filters change, which is why
   * the cursor is clamped rather than remembered by identity.
   */
  const walk = useMemo(
    () => [
      ...arcs.map((arc) => ({ kind: 'flow' as const, arc })),
      ...points.map((point) => ({ kind: 'facility' as const, point })),
    ],
    [arcs, points],
  )

  const index = walk.length === 0 ? 0 : Math.min(cursor, walk.length - 1)
  const current = walk[index]

  /** The cursor is drawn like a selection so it is visible at all, but only once
   *  the keyboard has been used — a mouse user should never see it. */
  const cursorId =
    keyboardActive && current !== undefined
      ? current.kind === 'facility'
        ? current.point.id
        : current.arc.id
      : null


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
    globe.pointOfView(
      { lat: 12, lng: 24, altitude: framingAltitude(size.width, size.height) },
      reducedMotion ? 0 : 1400,
    )
    const controls = globe.controls()
    controls.enablePan = false
    controls.minDistance = 180
    controls.maxDistance = 600
    // Deliberately no autoRotate: motion answers user action, not idle time.
    controls.autoRotate = false
  }, [reducedMotion, size.width, size.height])

  /**
   * Highlighted means selected or under the keyboard cursor. Both get the same
   * treatment: there is only ever one of each, and they are usually the same
   * thing, so a second visual language would be noise.
   */
  const highlighted = useCallback(
    (id: string) => id === selectedId || id === cursorId,
    [selectedId, cursorId],
  )

  const pointColor = useCallback(
    (datum: object) => {
      const point = datum as PointDatum
      if (point.confidence === 'low') return withAlpha(point.color, 0.38)
      return highlighted(point.id) ? '#ffffff' : point.color
    },
    [highlighted],
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
      return highlighted(point.id) ? point.radius * 1.5 : point.radius
    },
    [highlighted],
  )

  const arcColor = useCallback(
    (datum: object) => {
      const arc = datum as ArcDatum
      if (highlighted(arc.id)) return ['#ffffff', arc.color]
      const head = arc.confidence === 'low' ? 0.22 : 0.85
      const tail = arc.confidence === 'low' ? 0.05 : 0.15
      return [withAlpha(arc.color, tail), withAlpha(arc.color, head)]
    },
    [highlighted],
  )

  const arcStroke = useCallback(
    (datum: object) => {
      const arc = datum as ArcDatum
      return highlighted(arc.id) ? arc.width * 1.8 : arc.width
    },
    [highlighted],
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

  const describe = useCallback((item: (typeof walk)[number]): string => {
    if (item.kind === 'facility') {
      const p = item.point.facility.properties
      return `${p.name}, ${p.stage}, ${p.country_iso3}${
        p.confidence === 'low' ? ', low confidence' : ''
      }`
    }
    const { flow } = item.arc
    return `${flow.from_iso3} to ${flow.to_iso3}, ${flow.mineral_id}, ${flow.stage_from} to ${flow.stage_to}`
  }, [])

  /** Fly the camera to whatever the cursor lands on, so it is actually on screen. */
  useEffect(() => {
    const globe = globeRef.current
    if (!globe || !keyboardActive || current === undefined) return
    const lat = current.kind === 'facility' ? current.point.lat : current.arc.startLat
    const lng = current.kind === 'facility' ? current.point.lng : current.arc.startLng
    globe.pointOfView(
      { lat, lng, altitude: framingAltitude(size.width, size.height) * 0.85 },
      reducedMotion ? 0 : 600,
    )
  }, [current, keyboardActive, reducedMotion, size.width, size.height])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (walk.length === 0) return
      const step = (delta: number) => {
        event.preventDefault()
        setKeyboardActive(true)
        setCursor((c) => (Math.min(c, walk.length - 1) + delta + walk.length) % walk.length)
      }

      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          return step(1)
        case 'ArrowLeft':
        case 'ArrowUp':
          return step(-1)
        case 'Home':
          event.preventDefault()
          setKeyboardActive(true)
          return setCursor(0)
        case 'End':
          event.preventDefault()
          setKeyboardActive(true)
          return setCursor(walk.length - 1)
        case 'Enter':
        case ' ':
          if (current === undefined) return
          event.preventDefault()
          setKeyboardActive(true)
          return current.kind === 'facility'
            ? onSelectPoint(current.point)
            : onSelectArc(current.arc)
        case 'Escape':
          setKeyboardActive(false)
          return onClearSelection()
        default:
          return
      }
    },
    [walk, current, onSelectPoint, onSelectArc, onClearSelection],
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
    <div
      ref={containerRef}
      role="application"
      aria-label="Globe. Arrow keys move between flows and sites, Enter opens detail."
      tabIndex={0}
      onKeyDown={onKeyDown}
      onBlur={() => setKeyboardActive(false)}
      className="relative h-full w-full overflow-hidden"
    >
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

      {/* Only while the keyboard is driving. A mouse user never sees either of
          these, and a screen reader hears the cursor move without them. */}
      {keyboardActive && (
        <p className="pointer-events-none absolute bottom-2 left-2 font-mono text-2xs text-muted">
          {walk.length === 0
            ? 'Nothing to step through'
            : `${index + 1} of ${walk.length} · arrows move · enter opens · esc clears`}
        </p>
      )}
      <p aria-live="polite" className="sr-only">
        {keyboardActive && current !== undefined ? describe(current) : ''}
      </p>
    </div>
  )
}
