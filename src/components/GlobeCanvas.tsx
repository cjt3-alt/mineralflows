import React, { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import Globe, { type GlobeMethods } from 'react-globe.gl'
import {
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  Points,
  ShaderMaterial,
  SRGBColorSpace,
  TubeGeometry,
  Vector3,
} from 'three'
import {
  FLOW_KIND_LABEL,
  STAGE_LABEL_SINGULAR,
  formatLatLng,
  formatUsd,
  type ArcDatum,
  type PointDatum,
} from '../data/derive.ts'
import { COUNTRY_SHAPES, countryAt } from '../data/geo.ts'
import type { Country } from '../data/schema.ts'

/**
 * The globe. Props in, callbacks out: it holds no filter state, fetches
 * nothing, and knows nothing about minerals beyond the colours already baked
 * into the data it is handed.
 *
 * Everything drawn on it — borders, facility points, flow arcs — is a raw
 * Three.js object added to globe.gl's scene, not a globe.gl layer. That buys
 * three things the declarative layers could not give: a smooth fade toward the
 * far hemisphere instead of a hard clip at the horizon, round points that stay
 * crisp at any size, and hover hit-testing cheap enough to run on every mouse
 * move (it is done in screen space against cached positions, not by
 * raycasting meshes).
 *
 * One piece of state does live here: the keyboard cursor. A WebGL canvas is
 * unreachable by keyboard, which would leave the detail panel — the only place
 * a source, a confidence rating or an estimated-value warning is shown —
 * openable by mouse alone. So the canvas takes focus, arrow keys walk the
 * visible flows and sites, and Enter opens the one under the cursor.
 */

export interface GlobeCanvasProps {
  points: PointDatum[]
  arcs: ArcDatum[]
  countries: Record<string, Country>
  /** Id of the selected facility or flow. Everything else dims around it. */
  selectedId: string | null
  /** Id hovered somewhere other than the globe, such as the top-flows list. */
  externalHoverId: string | null
  /** ISO3 of the focused country. Its facilities stay bright; the rest dim. */
  focusCountry: string | null
  reducedMotion: boolean
  onSelectPoint: (point: PointDatum) => void
  onSelectArc: (arc: ArcDatum) => void
  onSelectCountry: (iso3: string) => void
  onClearSelection: () => void
}

/* ------------------------------------------------------------------ palette */

/** The interface accent: selection, hover and the keyboard cursor. Never data. */
const ACCENT = '#5ad8f0'
const OCEAN = '#04070c'
const LAND = '#15222f'
const GRATICULE = 'rgba(90, 216, 240, 0.09)'
const GRATICULE_MAJOR = 'rgba(90, 216, 240, 0.18)'
const BORDER_COLOR = '#8aa2bf'
const ATMOSPHERE_COLOR = '#2a7a92'

/* ------------------------------------------------------------------ framing */

/**
 * globe.gl's camera has a 50 degree vertical field of view. This works out how
 * far back the camera has to sit for the sphere to fill `FILL` of the narrower
 * axis, so the globe is large on a desktop and still whole on a phone.
 */
const CAMERA_FOV_DEGREES = 50
const FILL = 0.8

function framingAltitude(width: number, height: number): number {
  if (width === 0 || height === 0) return 2.4
  const halfVertical = ((CAMERA_FOV_DEGREES / 2) * Math.PI) / 180
  const halfHorizontal = Math.atan(Math.tan(halfVertical) * (width / height))
  const half = Math.min(halfVertical, halfHorizontal)
  const angular = Math.atan(FILL * Math.tan(half))
  return 1 / Math.sin(angular) - 1
}

/** Where the camera starts: over the western Pacific, with East Asia's import hubs in view and the arcs from South America arriving over the horizon. */
const HOME_VIEW = { lat: 8, lng: 150 }

/* ------------------------------------------------------------- land texture */

/**
 * The sphere's own surface: dark water, slightly lifted land, and a faint
 * targeting grid every 15 degrees. Painted once onto an equirectangular canvas
 * from the same country rings the borders use. Natural Earth splits shapes at
 * the antimeridian, so no ring needs unwrapping.
 */
function makeSurfaceTexture(): CanvasTexture {
  const width = 4096
  const height = 2048
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const x = (lng: number) => ((lng + 180) / 360) * width
  const y = (lat: number) => ((90 - lat) / 180) * height

  ctx.fillStyle = OCEAN
  ctx.fillRect(0, 0, width, height)

  ctx.fillStyle = LAND
  for (const shape of COUNTRY_SHAPES) {
    for (const polygon of shape.polygons) {
      ctx.beginPath()
      for (const ring of polygon) {
        ring.forEach(([lng, lat], i) => (i === 0 ? ctx.moveTo(x(lng), y(lat)) : ctx.lineTo(x(lng), y(lat))))
        ctx.closePath()
      }
      ctx.fill('evenodd')
    }
  }

  for (let lng = -180; lng <= 180; lng += 15) {
    ctx.strokeStyle = lng % 90 === 0 ? GRATICULE_MAJOR : GRATICULE
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(x(lng), 0)
    ctx.lineTo(x(lng), height)
    ctx.stroke()
  }
  for (let lat = -75; lat <= 75; lat += 15) {
    ctx.strokeStyle = lat === 0 ? GRATICULE_MAJOR : GRATICULE
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(0, y(lat))
    ctx.lineTo(width, y(lat))
    ctx.stroke()
  }

  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

/* ---------------------------------------------------------------- borders */

/**
 * Country borders fade smoothly toward the far hemisphere rather than being
 * hard-clipped by the depth buffer. Each fragment compares its outward normal
 * (on a sphere centred at the origin, that is just its normalized position)
 * against the direction to the camera. `cameraPosition` is a built-in uniform,
 * so the fade tracks every drag with no per-frame JS.
 */
const BORDER_ALTITUDE = 0.001
const BORDER_BASE_ALPHA = 0.34
const BORDER_FAR_FLOOR = 0.05

const FACING_GLSL = /* glsl */ `
  float facingOf(vec3 world) {
    return smoothstep(-0.15, 0.35, dot(normalize(world), normalize(cameraPosition - world)));
  }
`

const BORDER_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const BORDER_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uBaseAlpha;
  uniform float uFloor;
  varying vec3 vWorld;
  ${FACING_GLSL}
  void main() {
    gl_FragColor = vec4(uColor, uBaseAlpha * mix(uFloor, 1.0, facingOf(vWorld)));
  }
`

function buildBorders(globe: GlobeMethods): LineSegments {
  const positions: number[] = []
  for (const shape of COUNTRY_SHAPES) {
    for (const polygon of shape.polygons) {
      for (const ring of polygon) {
        for (let i = 0; i < ring.length - 1; i++) {
          const [lng0, lat0] = ring[i]!
          const [lng1, lat1] = ring[i + 1]!
          const a = globe.getCoords(lat0, lng0, BORDER_ALTITUDE)
          const b = globe.getCoords(lat1, lng1, BORDER_ALTITUDE)
          positions.push(a.x, a.y, a.z, b.x, b.y, b.z)
        }
      }
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  const material = new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(BORDER_COLOR) },
      uBaseAlpha: { value: BORDER_BASE_ALPHA },
      uFloor: { value: BORDER_FAR_FLOOR },
    },
    vertexShader: BORDER_VERTEX_SHADER,
    fragmentShader: BORDER_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: AdditiveBlending,
  })
  const lines = new LineSegments(geometry, material)
  lines.renderOrder = 1
  return lines
}

/* ----------------------------------------------------------------- points */

/**
 * Facility points as one `THREE.Points` draw call with round, anti-aliased
 * sprites. A filled disc is a documented site; a hollow ring is a
 * low-confidence one, so "uncertain" reads as a different mark rather than
 * just a dimmer dot. Real depth testing against the opaque globe hides the far
 * side; the facing fade only softens points near the horizon.
 *
 * Per-point state (0 normal, 1 dimmed, 2 highlighted) is a vertex attribute,
 * so selecting something rewrites one small buffer instead of any materials.
 */
const POINT_ALTITUDE = 0.004
/** Camera distance (globe radii x 100) the point sizes in derive.ts are tuned for. */
const POINT_REFERENCE_DISTANCE = 290

const POINT_VERTEX_SHADER = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aState;
  attribute float aLow;
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vLow;
  varying float vHi;
  ${FACING_GLSL}
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec4 mv = viewMatrix * world;
    float hi = aState > 1.5 ? 1.0 : 0.0;
    float dim = (aState > 0.5 && aState < 1.5) ? 1.0 : 0.0;
    float scale = clamp(${POINT_REFERENCE_DISTANCE.toFixed(1)} / -mv.z, 0.6, 3.0);
    gl_PointSize = aSize * uPixelRatio * scale * (hi > 0.5 ? 2.2 : 1.0);
    gl_Position = projectionMatrix * mv;
    vColor = aColor;
    vLow = aLow;
    vHi = hi;
    float base = aLow > 0.5 ? 0.6 : 0.95;
    vAlpha = base * mix(0.15, 1.0, facingOf(world.xyz)) * (dim > 0.5 ? 0.18 : 1.0);
  }
`
const POINT_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uAccent;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vLow;
  varying float vHi;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float a = vLow > 0.5
      ? smoothstep(0.45, 0.6, d) * (1.0 - smoothstep(0.82, 1.0, d))
      : 1.0 - smoothstep(0.72, 1.0, d);
    vec3 col = vColor;
    if (vHi > 0.5) {
      float core = 1.0 - smoothstep(0.32, 0.42, d);
      float ring = smoothstep(0.7, 0.78, d) * (1.0 - smoothstep(0.9, 1.0, d));
      col = mix(uAccent, vec3(1.0), core * 0.6);
      a = max(core, ring);
    }
    gl_FragColor = vec4(col, a * vAlpha);
  }
`

interface PointLayer {
  object: Points
  geometry: BufferGeometry
  material: ShaderMaterial
  /** World positions, x/y/z interleaved, for screen-space picking. */
  world: Float32Array
  state: Float32BufferAttribute
}

function buildPoints(globe: GlobeMethods, points: PointDatum[]): PointLayer {
  const n = points.length
  const positions = new Float32Array(n * 3)
  const colors = new Float32Array(n * 3)
  const sizes = new Float32Array(n)
  const lows = new Float32Array(n)
  const color = new Color()
  points.forEach((p, i) => {
    const c = globe.getCoords(p.lat, p.lng, POINT_ALTITUDE)
    positions.set([c.x, c.y, c.z], i * 3)
    color.set(p.color)
    colors.set([color.r, color.g, color.b], i * 3)
    sizes[i] = p.size
    lows[i] = p.confidence === 'low' ? 1 : 0
  })
  // Draw mines first and refineries last, so the rarer, larger marks sit on
  // top of the mine clusters they are often surrounded by.
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('aColor', new Float32BufferAttribute(colors, 3))
  geometry.setAttribute('aSize', new Float32BufferAttribute(sizes, 1))
  geometry.setAttribute('aLow', new Float32BufferAttribute(lows, 1))
  const state = new Float32BufferAttribute(new Float32Array(n), 1)
  geometry.setAttribute('aState', state)
  const material = new ShaderMaterial({
    uniforms: {
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      uAccent: { value: new Color(ACCENT) },
    },
    vertexShader: POINT_VERTEX_SHADER,
    fragmentShader: POINT_FRAGMENT_SHADER,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: NormalBlending,
  })
  const object = new Points(geometry, material)
  object.renderOrder = 3
  return { object, geometry, material, world: positions, state }
}

/* ------------------------------------------------------------------- arcs */

/**
 * Arcs are one `TubeGeometry` per flow with its own small material, because
 * each has its own grow-in progress, highlight and dim state. Normal blending
 * rather than additive: with depth testing off (so a flow survives past the
 * horizon) hundreds of tubes overlap at hubs like China, and additive blending
 * stacked them to solid white. Normal blending converges on the arc colour
 * instead, however many overlap.
 */
interface ArcEntry {
  arc: ArcDatum
  mesh: Mesh
  material: ShaderMaterial
  /** Points along the curve in world space, for screen-space picking. */
  samples: Vector3[]
  createdAt: number
}

const ARC_CURVE_SEGMENTS = 48
const ARC_TUBE_RADIAL_SEGMENTS = 6
/** derive.ts widths are in globe-radius hundredths; this sets on-screen thickness. */
const ARC_RADIUS_SCALE = 0.7
const ARC_MIN_RADIUS = 0.16
const ARC_GROW_MS = 900
/** Loops per second of the bright band that travels from exporter to importer. */
const ARC_BAND_SPEED = 0.22
const ARC_PICK_SAMPLES = 24

function slerpVector3(a: Vector3, b: Vector3, t: number): Vector3 {
  const angle = a.angleTo(b)
  if (angle < 1e-6) return a.clone()
  const sinAngle = Math.sin(angle)
  const wa = Math.sin((1 - t) * angle) / sinAngle
  const wb = Math.sin(t * angle) / sinAngle
  return new Vector3(a.x * wa + b.x * wb, a.y * wa + b.y * wb, a.z * wa + b.z * wb)
}

/** The great-circle path between endpoints, bulged outward by the arc's altitude. */
function buildArcCurve(globe: GlobeMethods, arc: ArcDatum): CatmullRomCurve3 {
  const start = globe.getCoords(arc.startLat, arc.startLng, 0)
  const end = globe.getCoords(arc.endLat, arc.endLng, 0)
  const startVec = new Vector3(start.x, start.y, start.z)
  const endVec = new Vector3(end.x, end.y, end.z)
  const radius = startVec.length()
  const points: Vector3[] = []
  for (let i = 0; i <= ARC_CURVE_SEGMENTS; i++) {
    const t = i / ARC_CURVE_SEGMENTS
    const direction = slerpVector3(startVec, endVec, t).normalize()
    points.push(direction.multiplyScalar(radius * (1 + arc.altitude * Math.sin(Math.PI * t))))
  }
  return new CatmullRomCurve3(points)
}

const ARC_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`
const ARC_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uAccent;
  uniform float uGrow;
  uniform float uTime;
  uniform float uWeight;
  uniform float uState;
  uniform float uLowConfidence;
  uniform float uBandStrength;
  varying vec2 vUv;
  varying vec3 vWorld;
  ${FACING_GLSL}
  void main() {
    if (vUv.x > uGrow) discard;
    if (uLowConfidence > 0.5 && fract(vUv.x * 22.0) > 0.55) discard;

    float hi = uState > 1.5 ? 1.0 : 0.0;
    float dim = (uState > 0.5 && uState < 1.5) ? 1.0 : 0.0;

    float band = 0.0;
    if (uLowConfidence < 0.5) {
      float phase = fract(vUv.x - uTime * ${ARC_BAND_SPEED.toFixed(4)});
      band = (1.0 - smoothstep(0.0, 0.1, abs(phase - 0.5))) * uBandStrength;
    }

    vec3 col = hi > 0.5 ? uAccent : uColor;
    col = mix(col, vec3(1.0), band * 0.55);
    float base = uLowConfidence > 0.5 ? 0.22 : 0.16 + 0.44 * uWeight;
    if (hi > 0.5) base = 0.95;
    if (dim > 0.5) base *= 0.16;
    float alpha = min(1.0, base + band * 0.35 * (1.0 - dim)) * mix(0.1, 1.0, facingOf(vWorld));
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(col, alpha);
  }
`

function buildArc(globe: GlobeMethods, arc: ArcDatum, reducedMotion: boolean): ArcEntry {
  const curve = buildArcCurve(globe, arc)
  const geometry = new TubeGeometry(
    curve,
    ARC_CURVE_SEGMENTS,
    Math.max(ARC_MIN_RADIUS, arc.width * ARC_RADIUS_SCALE),
    ARC_TUBE_RADIAL_SEGMENTS,
    false,
  )
  const material = new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(arc.color) },
      uAccent: { value: new Color(ACCENT) },
      uGrow: { value: reducedMotion ? 1 : 0 },
      uTime: { value: 0 },
      uWeight: { value: arc.weight },
      uState: { value: 0 },
      uLowConfidence: { value: arc.confidence === 'low' ? 1 : 0 },
      uBandStrength: { value: reducedMotion ? 0 : 1 },
    },
    vertexShader: ARC_VERTEX_SHADER,
    fragmentShader: ARC_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: NormalBlending,
    side: DoubleSide,
  })
  const mesh = new Mesh(geometry, material)
  // Larger flows draw last so they sit on top of the small ones they cross.
  mesh.renderOrder = 4 + arc.weight
  const samples = curve.getSpacedPoints(ARC_PICK_SAMPLES)
  return { arc, mesh, material, samples, createdAt: performance.now() }
}

/* ---------------------------------------------------------------- picking */

type Hit = { kind: 'facility'; point: PointDatum } | { kind: 'flow'; arc: ArcDatum }

const POINT_PICK_PX = 7
const ARC_PICK_PX = 6

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
  const x = ax + t * dx - px
  const y = ay + t * dy - py
  return Math.sqrt(x * x + y * y)
}

/** Is this world point on the side of the globe facing the camera? Mirrors the shaders. */
function faces(v: Vector3, camera: Vector3, threshold: number): boolean {
  const len = v.length()
  const tx = camera.x - v.x
  const ty = camera.y - v.y
  const tz = camera.z - v.z
  const tlen = Math.sqrt(tx * tx + ty * ty + tz * tz)
  return (v.x * tx + v.y * ty + v.z * tz) / (len * tlen) > threshold
}

/* -------------------------------------------------------------- component */

function countryName(countries: Record<string, Country>, iso3: string): string {
  return countries[iso3]?.name ?? iso3
}

export function GlobeCanvas({
  points,
  arcs,
  countries,
  selectedId,
  externalHoverId,
  focusCountry,
  reducedMotion,
  onSelectPoint,
  onSelectArc,
  onSelectCountry,
  onClearSelection,
}: GlobeCanvasProps) {
  const globeRef = useRef<GlobeMethods | undefined>(undefined)
  const containerRef = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [cursor, setCursor] = useState(0)
  const [keyboardActive, setKeyboardActive] = useState(false)
  const [hover, setHover] = useState<{ hit: Hit; x: number; y: number } | null>(null)
  const [pointer, setPointer] = useState<{ lat: number; lng: number } | null>(null)
  const [view, setView] = useState<{ lat: number; lng: number; altitude: number } | null>(null)
  const [hoverCountry, setHoverCountry] = useState<string | null>(null)

  const pointLayerRef = useRef<PointLayer | null>(null)
  const arcEntriesRef = useRef<ArcEntry[]>([])

  /**
   * The globe exists only after its first commit, and `points`/`arcs` are
   * already populated on the very first render because this component mounts
   * after the data has loaded. Effects keyed only on the data would therefore
   * run once, before the globe exists, and never again — which is exactly how
   * arcs used to stay invisible until a filter changed. Keying every scene
   * effect on `ready` as well makes them run once the globe is really there.
   */
  const globeCallbackRef = useCallback((globe: GlobeMethods | null) => {
    globeRef.current = globe ?? undefined
    if (globe) setReady(true)
  }, [])

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

  const globeMaterial = useMemo(
    () => new MeshBasicMaterial({ map: makeSurfaceTexture(), color: new Color('#ffffff') }),
    [],
  )

  /* Borders: built once the globe exists, never rebuilt. */
  useEffect(() => {
    const globe = globeRef.current
    if (!ready || !globe) return
    const borders = buildBorders(globe)
    globe.scene().add(borders)
    return () => {
      globe.scene().remove(borders)
      borders.geometry.dispose()
      ;(borders.material as ShaderMaterial).dispose()
    }
  }, [ready])

  /* Points: rebuilt when the filtered set changes. */
  useEffect(() => {
    const globe = globeRef.current
    if (!ready || !globe) return
    const layer = buildPoints(globe, points)
    globe.scene().add(layer.object)
    pointLayerRef.current = layer
    return () => {
      globe.scene().remove(layer.object)
      layer.geometry.dispose()
      layer.material.dispose()
      pointLayerRef.current = null
    }
  }, [ready, points])

  /* Arcs: rebuilt when the filtered set changes. Old GPU objects are disposed. */
  useEffect(() => {
    const globe = globeRef.current
    if (!ready || !globe) return
    const scene = globe.scene()
    const built = arcs.map((arc) => buildArc(globe, arc, reducedMotion))
    for (const entry of built) scene.add(entry.mesh)
    arcEntriesRef.current = built
    return () => {
      for (const { mesh, material } of built) {
        scene.remove(mesh)
        mesh.geometry.dispose()
        material.dispose()
      }
      arcEntriesRef.current = []
    }
  }, [ready, arcs, reducedMotion])

  /* ------------------------------------------------------------ keyboard */

  /**
   * What the arrow keys walk: flows first, largest first, then sites. Rebuilt
   * whenever the filters change, which is why the cursor is clamped rather
   * than remembered by identity.
   */
  const walk = useMemo<Hit[]>(
    () => [
      ...arcs.map((arc) => ({ kind: 'flow' as const, arc })),
      ...points.map((point) => ({ kind: 'facility' as const, point })),
    ],
    [arcs, points],
  )
  const index = walk.length === 0 ? 0 : Math.min(cursor, walk.length - 1)
  const current = walk[index]
  const cursorId =
    keyboardActive && current !== undefined
      ? current.kind === 'facility'
        ? current.point.id
        : current.arc.id
      : null

  const hoverId = hover === null ? null : hover.hit.kind === 'facility' ? hover.hit.point.id : hover.hit.arc.id

  /* -------------------------------------------------------- highlighting */

  /**
   * Highlighted: selected, hovered (here or in a list), or under the keyboard
   * cursor. Dimmed: anything else while a selection is open, so the selected
   * thing stands alone; and, under a country focus, facilities elsewhere.
   */
  useEffect(() => {
    const isHi = (id: string) =>
      id === selectedId || id === hoverId || id === externalHoverId || id === cursorId

    const layer = pointLayerRef.current
    if (layer) {
      const state = layer.state.array as Float32Array
      points.forEach((p, i) => {
        if (isHi(p.id)) state[i] = 2
        else if (selectedId !== null) state[i] = 1
        else if (focusCountry !== null && p.facility.properties.country_iso3 !== focusCountry)
          state[i] = 1
        else state[i] = 0
      })
      layer.state.needsUpdate = true
    }
    for (const { arc, material } of arcEntriesRef.current) {
      // Writing a uniform is how a three.js material is updated; the ref holds
      // live scene objects, not React state.
      // eslint-disable-next-line react-hooks/immutability
      material.uniforms.uState!.value = isHi(arc.id) ? 2 : selectedId !== null ? 1 : 0
    }
  }, [ready, points, arcs, selectedId, hoverId, externalHoverId, cursorId, focusCountry])

  /* --------------------------------------------------------------- camera */

  useEffect(() => {
    const globe = globeRef.current
    if (!ready || !globe || size.width === 0) return
    const controls = globe.controls()
    controls.enablePan = false
    controls.minDistance = 140
    controls.maxDistance = 650
    controls.autoRotateSpeed = 0.35
    controls.enableDamping = !reducedMotion
    controls.dampingFactor = 0.07
    controls.rotateSpeed = 0.6
    controls.zoomSpeed = 0.7

    // Report the camera position to the HUD, at most once a frame.
    let pending = 0
    const onChange = () => {
      if (pending) return
      pending = requestAnimationFrame(() => {
        pending = 0
        const pov = globe.pointOfView()
        setView({ lat: pov.lat, lng: pov.lng, altitude: pov.altitude })
      })
    }
    controls.addEventListener('change', onChange)
    return () => {
      controls.removeEventListener('change', onChange)
      cancelAnimationFrame(pending)
    }
  }, [ready, reducedMotion, size.width])

  /* One orchestrated move on load, and a refit whenever the viewport changes shape. */
  useEffect(() => {
    const globe = globeRef.current
    if (!ready || !globe || size.width === 0) return
    globe.pointOfView(
      { ...HOME_VIEW, altitude: framingAltitude(size.width, size.height) },
      reducedMotion ? 0 : 1600,
    )
  }, [ready, reducedMotion, size.width, size.height])

  /* Fly to a focused country. */
  useEffect(() => {
    const globe = globeRef.current
    if (!ready || !globe || focusCountry === null) return
    const c = countries[focusCountry]
    if (!c) return
    globe.pointOfView(
      { lat: c.lat, lng: c.lon, altitude: framingAltitude(size.width, size.height) * 1.25 },
      reducedMotion ? 0 : 1100,
    )
  }, [ready, focusCountry, countries, reducedMotion, size.width, size.height])

  /**
   * Fly to a flow picked from the list. A flow clicked on the globe is already
   * in view, so this only moves when the pick came from elsewhere — which is
   * exactly when the list row was being hovered.
   */
  useEffect(() => {
    const globe = globeRef.current
    if (!ready || !globe || selectedId === null || selectedId !== externalHoverId) return
    const arc = arcs.find((a) => a.id === selectedId)
    if (!arc) return
    const a = globe.getCoords(arc.startLat, arc.startLng, 0)
    const b = globe.getCoords(arc.endLat, arc.endLng, 0)
    const mid = slerpVector3(new Vector3(a.x, a.y, a.z), new Vector3(b.x, b.y, b.z), 0.5)
    const coords = globe.toGeoCoords({ x: mid.x, y: mid.y, z: mid.z })
    globe.pointOfView(
      { lat: coords.lat, lng: coords.lng, altitude: framingAltitude(size.width, size.height) * 1.1 },
      reducedMotion ? 0 : 900,
    )
    // Only on a new selection, not on every hover change after it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, selectedId])

  /* Fly to the keyboard cursor, so it is actually on screen. */
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

  /**
   * Idle rotation, paused whenever anything is being looked at: a selection,
   * a hover, a focused country or keyboard navigation. A globe that keeps
   * turning under the pointer carries the thing you are reading out of view.
   */
  useEffect(() => {
    const globe = globeRef.current
    if (!ready || !globe) return
    globe.controls().autoRotate =
      !reducedMotion &&
      !keyboardActive &&
      selectedId === null &&
      focusCountry === null &&
      hover === null &&
      externalHoverId === null
  }, [ready, reducedMotion, keyboardActive, selectedId, focusCountry, hover, externalHoverId])

  /* ----------------------------------------------------------- animation */

  useEffect(() => {
    if (reducedMotion) return
    let raf = 0
    const tick = () => {
      const now = performance.now()
      for (const { material, createdAt } of arcEntriesRef.current) {
        material.uniforms.uTime!.value = now / 1000
        material.uniforms.uGrow!.value = Math.min(1, (now - createdAt) / ARC_GROW_MS)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [reducedMotion])

  /* ------------------------------------------------------- pointer input */

  /**
   * Hit-testing in screen space. Points win over arcs within their radius,
   * because a site is the smaller target. Only things on the near side count:
   * the far hemisphere is faded for context, not for clicking.
   */
  const pick = useCallback(
    (x: number, y: number): Hit | null => {
      const globe = globeRef.current
      if (!globe) return null
      const camera = globe.camera()
      const cam = camera.position
      const w = size.width
      const h = size.height
      const v = new Vector3()

      let best: Hit | null = null
      let bestDist = Infinity

      const layer = pointLayerRef.current
      if (layer) {
        const world = layer.world
        for (let i = 0; i < points.length; i++) {
          v.set(world[i * 3]!, world[i * 3 + 1]!, world[i * 3 + 2]!)
          if (!faces(v, cam, 0.05)) continue
          v.project(camera)
          const sx = ((v.x + 1) / 2) * w
          const sy = ((1 - v.y) / 2) * h
          const d = Math.hypot(sx - x, sy - y)
          const radius = Math.max(POINT_PICK_PX, points[i]!.size / 2 + 3)
          if (d < radius && d < bestDist) {
            bestDist = d
            best = { kind: 'facility', point: points[i]! }
          }
        }
      }
      if (best) return best

      for (const entry of arcEntriesRef.current) {
        let prev: [number, number] | null = null
        for (const s of entry.samples) {
          if (!faces(s, cam, 0.2)) {
            prev = null
            continue
          }
          v.copy(s).project(camera)
          const sx = ((v.x + 1) / 2) * w
          const sy = ((1 - v.y) / 2) * h
          if (prev) {
            const d = distToSegment(x, y, prev[0], prev[1], sx, sy)
            if (d < ARC_PICK_PX + entry.arc.width * 2 && d < bestDist) {
              bestDist = d
              best = { kind: 'flow', arc: entry.arc }
            }
          }
          prev = [sx, sy]
        }
      }
      return best
    },
    [points, size.width, size.height],
  )

  useEffect(() => {
    const globe = globeRef.current
    if (!ready || !globe) return
    const dom = globe.renderer().domElement
    let frame = 0
    let last: PointerEvent | null = null
    let down: { x: number; y: number } | null = null

    const local = (event: PointerEvent | MouseEvent) => {
      const rect = dom.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }

    const run = () => {
      frame = 0
      if (!last) return
      const { x, y } = local(last)
      const hit = down ? null : pick(x, y)
      setHover(hit ? { hit, x, y } : null)
      const coords = globe.toGlobeCoords(x, y)
      setPointer(coords ? { lat: coords.lat, lng: coords.lng } : null)
      const shape = !hit && coords ? countryAt(coords.lat, coords.lng) : null
      setHoverCountry(shape?.iso3 && shape.iso3 in countries ? shape.iso3 : null)
      dom.style.cursor = hit || (shape?.iso3 && shape.iso3 in countries) ? 'pointer' : 'grab'
    }

    const onMove = (event: PointerEvent) => {
      last = event
      if (!frame) frame = requestAnimationFrame(run)
    }
    const onLeave = () => {
      last = null
      setHover(null)
      setPointer(null)
      setHoverCountry(null)
    }
    const onDown = (event: PointerEvent) => {
      down = local(event)
    }
    const onUp = (event: PointerEvent) => {
      const start = down
      down = null
      if (!start) return
      const { x, y } = local(event)
      // A drag that rotated the globe is not a click.
      if (Math.hypot(x - start.x, y - start.y) > 5) return
      const hit = pick(x, y)
      if (hit) {
        setKeyboardActive(false)
        if (hit.kind === 'facility') onSelectPoint(hit.point)
        else onSelectArc(hit.arc)
        return
      }
      const coords = globe.toGlobeCoords(x, y)
      const shape = coords ? countryAt(coords.lat, coords.lng) : null
      if (shape?.iso3 && shape.iso3 in countries) onSelectCountry(shape.iso3)
      else onClearSelection()
    }

    dom.addEventListener('pointermove', onMove)
    dom.addEventListener('pointerleave', onLeave)
    dom.addEventListener('pointerdown', onDown)
    dom.addEventListener('pointerup', onUp)
    return () => {
      cancelAnimationFrame(frame)
      dom.removeEventListener('pointermove', onMove)
      dom.removeEventListener('pointerleave', onLeave)
      dom.removeEventListener('pointerdown', onDown)
      dom.removeEventListener('pointerup', onUp)
    }
  }, [ready, pick, countries, onSelectPoint, onSelectArc, onSelectCountry, onClearSelection])

  /* ------------------------------------------------------------ keyboard */

  const describe = useCallback(
    (item: Hit): string => {
      if (item.kind === 'facility') {
        const p = item.point.facility.properties
        return `${p.name}, ${STAGE_LABEL_SINGULAR[p.stage]}, ${countryName(countries, p.country_iso3)}${
          p.confidence === 'low' ? ', low confidence' : ''
        }`
      }
      const { flow, value, kind } = item.arc
      return `${countryName(countries, flow.from_iso3)} to ${countryName(countries, flow.to_iso3)}, ${
        FLOW_KIND_LABEL[kind]
      }, ${formatUsd(value.usd)}`
    },
    [countries],
  )

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
          return current.kind === 'facility' ? onSelectPoint(current.point) : onSelectArc(current.arc)
        case 'Escape':
          setKeyboardActive(false)
          return onClearSelection()
        default:
          return
      }
    },
    [walk, current, onSelectPoint, onSelectArc, onClearSelection],
  )

  /* -------------------------------------------------------------- render */

  return (
    <div
      ref={containerRef}
      role="application"
      aria-label="Globe. Drag to rotate, scroll to zoom, click a flow, site or country. With the keyboard, arrow keys move between flows and sites and Enter opens one."
      tabIndex={0}
      onKeyDown={onKeyDown}
      onBlur={() => setKeyboardActive(false)}
      className="relative h-full w-full overflow-hidden"
    >
      {size.width > 0 && (
        <Globe
          ref={globeCallbackRef as unknown as React.MutableRefObject<GlobeMethods | undefined>}
          width={size.width}
          height={size.height}
          backgroundColor="rgba(0,0,0,0)"
          globeImageUrl={null}
          globeMaterial={globeMaterial}
          showGlobe
          showAtmosphere
          atmosphereColor={ATMOSPHERE_COLOR}
          atmosphereAltitude={0.13}
          animateIn={!reducedMotion}
          enablePointerInteraction={false}
        />
      )}

      <Hud view={view} pointer={pointer} hoverCountry={hoverCountry} countries={countries} />

      {hover && <Tooltip hit={hover.hit} x={hover.x} y={hover.y} width={size.width} countries={countries} />}

      {keyboardActive && (
        <p className="hud-label pointer-events-none absolute bottom-10 left-1/2 -translate-x-1/2 text-muted">
          {walk.length === 0
            ? 'Nothing to step through'
            : `${index + 1} / ${walk.length} · arrows move · enter opens · esc clears`}
        </p>
      )}
      <p aria-live="polite" className="sr-only">
        {keyboardActive && current !== undefined ? describe(current) : ''}
      </p>
    </div>
  )
}

/* -------------------------------------------------------------------- HUD */

function Hud({
  view,
  pointer,
  hoverCountry,
  countries,
}: {
  view: { lat: number; lng: number; altitude: number } | null
  pointer: { lat: number; lng: number } | null
  hoverCountry: string | null
  countries: Record<string, Country>
}) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      <span className="hud-corner left-3 top-3 border-l border-t" />
      <span className="hud-corner right-3 top-3 border-r border-t" />
      <span className="hud-corner bottom-3 left-3 border-b border-l" />
      <span className="hud-corner bottom-3 right-3 border-b border-r" />

      <div className="hud-label absolute left-6 top-5 hidden flex-col gap-0.5 sm:flex">
        <span>
          <span className="text-muted">CAM </span>
          <span className="text-dim">{view ? formatLatLng(view.lat, view.lng, 1) : '—'}</span>
        </span>
        <span>
          <span className="text-muted">ALT </span>
          <span className="text-dim">{view ? view.altitude.toFixed(2) : '—'}</span>
        </span>
      </div>

      <div className="hud-label absolute bottom-5 right-6 hidden text-right sm:block">
        {pointer ? (
          <>
            <span className="text-dim">{formatLatLng(pointer.lat, pointer.lng)}</span>
            {hoverCountry && (
              <span className="ml-2 text-accent">{(countries[hoverCountry]?.name ?? hoverCountry).toUpperCase()}</span>
            )}
          </>
        ) : (
          <span className="text-muted">DRAG · SCROLL · CLICK</span>
        )}
      </div>
    </div>
  )
}

function Tooltip({
  hit,
  x,
  y,
  width,
  countries,
}: {
  hit: Hit
  x: number
  y: number
  width: number
  countries: Record<string, Country>
}) {
  // Flip to the left of the pointer near the right edge, so it never clips.
  const flip = x > width - 260
  const style = flip
    ? { right: width - x + 14, top: y + 14 }
    : { left: x + 14, top: y + 14 }

  return (
    <div role="tooltip" className="tooltip pointer-events-none absolute z-10" style={style}>
      {hit.kind === 'flow' ? (
        <>
          <p className="hud-label text-muted">
            FLOW · {hit.arc.flow.from_iso3} → {hit.arc.flow.to_iso3}
          </p>
          <p className="mt-0.5 text-sm text-ink">
            {countryName(countries, hit.arc.flow.from_iso3)} → {countryName(countries, hit.arc.flow.to_iso3)}
          </p>
          <p className="mt-1 flex items-baseline justify-between gap-4">
            <span className="text-xs text-dim">{FLOW_KIND_LABEL[hit.arc.kind]}</span>
            <span className="font-mono text-sm text-ink">
              {formatUsd(hit.arc.value.usd)}
              {hit.arc.value.estimated && <span className="ml-1 text-alert">est.</span>}
            </span>
          </p>
          {hit.arc.confidence === 'low' && <p className="mt-1 text-2xs text-alert">Low confidence (mirror data)</p>}
        </>
      ) : (
        <>
          <p className="hud-label text-muted">
            SITE · {STAGE_LABEL_SINGULAR[hit.point.stage].toUpperCase()}
          </p>
          <p className="mt-0.5 text-sm text-ink">{hit.point.facility.properties.name}</p>
          <p className="mt-0.5 text-xs text-dim">
            {countryName(countries, hit.point.facility.properties.country_iso3)}
          </p>
          {hit.point.confidence === 'low' && <p className="mt-1 text-2xs text-alert">Low confidence location</p>}
        </>
      )}
    </div>
  )
}
