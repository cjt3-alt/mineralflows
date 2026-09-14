import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import Globe, { type GlobeMethods } from 'react-globe.gl'
import {
  AdditiveBlending,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  Float32BufferAttribute,
  LineSegments,
  Mesh,
  MeshPhongMaterial,
  Raycaster,
  ShaderMaterial,
  TubeGeometry,
  Vector2,
  Vector3,
} from 'three'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { feature } from 'topojson-client'
import countriesTopology from 'world-atlas/countries-110m.json'
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
 * Natural Earth admin-0 country borders at 1:110m, bundled rather than
 * fetched. Each country is its own Polygon or MultiPolygon, unlike the `land`
 * object in the same package, which collapses every landmass into one shape
 * with no internal borders. A MultiPolygon is split back into one polygon per
 * part; the shader border builder below turns every ring into line-segment
 * pairs. Done once at module scope; the borders do not change.
 */
interface Ring {
  0: number
  1: number
}
type PolygonCoordinates = Ring[][]
interface CountryPolygon {
  geometry: { type: 'Polygon'; coordinates: PolygonCoordinates }
}

const countryPolygons: CountryPolygon[] = (() => {
  const topology = countriesTopology as unknown as Topology
  const countries = topology.objects.countries
  if (!countries) return []
  const collection = feature(topology, countries) as unknown as {
    features: { geometry: { type: string; coordinates: unknown } }[]
  }
  const polygons: CountryPolygon[] = []
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
/** Bright and near-white so bloom picks the borders up as light-art, not map fill. */
const LAND_STROKE = '#eef2ff'
/** A quiet rim glow so the sphere's own silhouette reads against the page
 *  background, since the fill itself is now too faint to mark the edge. */
const ATMOSPHERE_COLOR = '#26334a'

/**
 * A dark, unlit, low-opacity sphere — thin enough that it reads as almost no
 * fill at all, letting the country borders carry the shape instead of an
 * "ocean" colour. `depthWrite` stays at its default (true): facility points
 * still need this sphere to hide the far hemisphere the way a solid planet
 * would. Borders and arcs no longer rely on it at all — see the shader below.
 */
function makeGlobeMaterial(): MeshPhongMaterial {
  return new MeshPhongMaterial({
    color: new Color(GLOBE_COLOR),
    emissive: new Color('#000000'),
    shininess: 0,
    transparent: true,
    opacity: 0.18,
  })
}

/**
 * Country borders as a raw Three.js object rather than a globe.gl layer, so
 * the far hemisphere can fade smoothly by camera angle instead of being
 * hard-clipped by the globe's depth buffer — copied from how criticalatlas.com
 * does it. Every vertex passes its own world position; the fragment shader
 * works out whether that point currently faces the camera by comparing the
 * point's own outward direction (it sits on a sphere centred at the origin, so
 * its normalized position *is* its surface normal) against the direction to
 * the camera, and fades alpha between a dim floor and full strength. No
 * uniform needs updating per frame: `cameraPosition` is a built-in three.js
 * uniform that already tracks OrbitControls' current camera position, so the
 * fade re-evaluates correctly on every frame the globe is dragged or spun.
 */
const BORDER_ALTITUDE = 0.001
const BORDER_COLOR = LAND_STROKE
/**
 * Low: with depth testing off and additive blending, every segment's alpha
 * stacks with every other segment behind it along the same screen pixel, and
 * a full country topology (thousands of segments) piles up fast — nothing
 * like criticalatlas.com's much sparser, hand-simplified line set. This has
 * to be tuned low enough that dense clusters of small countries do not blow
 * out to solid white.
 */
const BORDER_BASE_ALPHA = 0.22
/** Alpha on the far side, as a fraction of BORDER_BASE_ALPHA. Never fully
 *  zero — the point is a smooth fade, not a second hard edge. */
const BORDER_FAR_FLOOR = 0.07

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
  void main() {
    vec3 normalW = normalize(vWorld);
    vec3 viewDir = normalize(cameraPosition - vWorld);
    float facing = smoothstep(-0.15, 0.35, dot(normalW, viewDir));
    float alpha = uBaseAlpha * mix(uFloor, 1.0, facing);
    gl_FragColor = vec4(uColor, alpha);
  }
`

function makeBorderMaterial(): ShaderMaterial {
  return new ShaderMaterial({
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
}

/**
 * Flattens every country ring into consecutive-pair line segments for
 * `THREE.LineSegments`, using the same `globe.getCoords` the old graticule
 * used. Built once per globe mount — the borders themselves never change.
 */
function buildBorderGeometry(globe: GlobeMethods): BufferGeometry {
  const positions: number[] = []
  for (const polygon of countryPolygons) {
    for (const ring of polygon.geometry.coordinates) {
      for (let i = 0; i < ring.length - 1; i++) {
        const p0 = ring[i]!
        const p1 = ring[i + 1]!
        const a = globe.getCoords(p0[1], p0[0], BORDER_ALTITUDE)
        const b = globe.getCoords(p1[1], p1[0], BORDER_ALTITUDE)
        positions.push(a.x, a.y, a.z, b.x, b.y, b.z)
      }
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  return geometry
}

/**
 * The same facing fade as the borders, applied instead to facility points —
 * see the effect below that patches globe.gl's own point materials with
 * this. Unlike the border and arc shaders, points keep normal (not
 * additive) blending and real depth testing: 1,229 of them is enough that
 * additive stacking would repeat the same overexposure the borders and arcs
 * both hit at full density, and the existing hard cutoff on the true far
 * side already works, so there is nothing here to replace, only to add to.
 */
const POINT_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const POINT_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec3 vWorld;
  void main() {
    vec3 normalW = normalize(vWorld);
    vec3 viewDir = normalize(cameraPosition - vWorld);
    float facing = smoothstep(-0.15, 0.35, dot(normalW, viewDir));
    gl_FragColor = vec4(uColor, uOpacity * mix(0.12, 1.0, facing));
  }
`

/**
 * Arcs are custom `TubeGeometry` meshes rather than a globe.gl layer, for the
 * same reason as the borders: a fragment shader can fade the far hemisphere
 * smoothly instead of relying on the depth buffer, and it is what
 * criticalatlas.com actually does. Unlike the borders, arcs are not static —
 * each one grows in once, and (confidence permitting) carries a brightness
 * band that keeps traveling along its length for as long as it is on screen —
 * so every arc gets its own material instance with uniforms a render loop
 * updates every frame, tracked here so that loop, the click raycaster, and
 * the highlight pass can all find the live set of meshes.
 */
interface ArcMeshEntry {
  arc: ArcDatum
  mesh: Mesh
  material: ShaderMaterial
  createdAt: number
}

const ARC_CURVE_SEGMENTS = 48
const ARC_TUBE_RADIAL_SEGMENTS = 6
/**
 * Converts derive.ts's stroke-width scale (roughly 0.22-2.6) into a
 * world-space tube radius. The globe itself is ~100 world units in radius
 * (three-globe's own default), so this needs to land arc thickness at a
 * fraction of a percent to a few percent of that — not the sub-pixel
 * hairline a naive small multiplier produces.
 */
const ARC_RADIUS_SCALE = 1
const ARC_GROW_MS = 700
/** How fast the traveling brightness band moves, in loops per second. */
const ARC_BAND_SPEED = 0.18

/**
 * Spherical linear interpolation between two vectors of equal length,
 * tracing the great circle between them rather than cutting a straight
 * chord through the globe. `globe.getCoords` gives the true endpoint
 * vectors, so this needs no independent lat/lng-to-Cartesian formula of its
 * own to stay consistent with everything else drawn on the sphere.
 */
function slerpVector3(a: Vector3, b: Vector3, t: number): Vector3 {
  const angle = a.angleTo(b)
  if (angle < 1e-6) return a.clone()
  const sinAngle = Math.sin(angle)
  const wa = Math.sin((1 - t) * angle) / sinAngle
  const wb = Math.sin(t * angle) / sinAngle
  return new Vector3(a.x * wa + b.x * wb, a.y * wa + b.y * wb, a.z * wa + b.z * wb)
}

/**
 * The great-circle path between an arc's endpoints, bulged outward by its
 * altitude at the midpoint and settling back to the surface at both ends —
 * the same shape globe.gl's own arcs use, reimplemented here because we now
 * own the geometry instead of handing it a start/end pair.
 */
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
    const bulge = arc.altitude * Math.sin(Math.PI * t)
    points.push(direction.multiplyScalar(radius * (1 + bulge)))
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
/**
 * `vUv.x` runs along the tube's length. `uGrow` reveals it from the origin
 * end outward once; the dash and band effects both read `vUv.x` again
 * afterward, which is why they still work correctly regardless of how far
 * the reveal has gotten.
 */
const ARC_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uGrow;
  uniform float uHighlight;
  uniform float uTime;
  uniform float uLowConfidence;
  uniform float uBandStrength;
  varying vec2 vUv;
  varying vec3 vWorld;

  void main() {
    if (vUv.x > uGrow) discard;
    if (uLowConfidence > 0.5 && fract(vUv.x * 18.0) > 0.55) discard;

    vec3 normalW = normalize(vWorld);
    vec3 viewDir = normalize(cameraPosition - vWorld);
    float facing = smoothstep(-0.15, 0.35, dot(normalW, viewDir));

    float band = 0.0;
    if (uLowConfidence < 0.5) {
      float phase = fract(vUv.x - uTime * ${ARC_BAND_SPEED.toFixed(4)});
      band = smoothstep(0.12, 0.0, abs(phase - 0.5) - 0.4) * uBandStrength;
    }

    vec3 col = mix(uColor, vec3(1.0), uHighlight) + band * 0.55;
    // Low: with depth testing off (so a flow survives past the horizon
    // instead of being clipped by the globe), arcs can no longer occlude
    // each other either — every tube overlapping a busy hub like China
    // stacks additively with every other one behind it. Full density here
    // is ~300 tubes, and without a low base alpha the overlaps at a hub
    // blow straight out to solid white.
    float baseAlpha = uLowConfidence > 0.5 ? 0.05 : 0.09;
    float alpha = (baseAlpha + band * 0.12) * mix(0.16, 1.0, facing);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(col, alpha);
  }
`

function makeArcMaterial(color: string, lowConfidence: boolean, reducedMotion: boolean): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(color) },
      uGrow: { value: reducedMotion ? 1 : 0 },
      uHighlight: { value: 0 },
      uTime: { value: 0 },
      uLowConfidence: { value: lowConfidence ? 1 : 0 },
      uBandStrength: { value: reducedMotion ? 0 : 1 },
    },
    vertexShader: ARC_VERTEX_SHADER,
    fragmentShader: ARC_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: AdditiveBlending,
    side: 2, // THREE.DoubleSide — a tube viewed edge-on should not vanish
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
  /** The live set of arc meshes, for the animation loop, the highlight pass,
   *  and the click raycaster below to all read without re-triggering renders. */
  const arcMeshesRef = useRef<ArcMeshEntry[]>([])

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
   * Country borders, built once the globe exists and never rebuilt — the
   * geometry is static, and the shader's facing-based fade means no per-frame
   * uniform updates are needed either.
   */
  useEffect(() => {
    const globe = globeRef.current
    if (!globe || size.width === 0) return
    const scene = globe.scene()
    const geometry = buildBorderGeometry(globe)
    const material = makeBorderMaterial()
    const borders = new LineSegments(geometry, material)
    scene.add(borders)

    return () => {
      scene.remove(borders)
      geometry.dispose()
      material.dispose()
    }
  }, [size.width])

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

  // One orchestrated move on load. Damping (below) is what gives a drag its
  // "flick and it keeps going" coast — matching criticalatlas.com's globe —
  // and needs setting up here rather than per-render.
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
    controls.autoRotateSpeed = 0.4
    controls.enableDamping = !reducedMotion
    controls.dampingFactor = 0.06
  }, [reducedMotion, size.width, size.height])

  /**
   * Idle rotation, paused while something is actually being looked at. A
   * globe that keeps turning under an open detail panel, or while keyboard
   * navigation is mid-step, would carry the very thing you are reading about
   * out of view — the point of stopping it is the same reason `pointOfView`
   * flies to the keyboard cursor at all.
   */
  useEffect(() => {
    const globe = globeRef.current
    if (!globe) return
    globe.controls().autoRotate = !reducedMotion && !keyboardActive && selectedId === null
  }, [reducedMotion, keyboardActive, selectedId])

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
      if (point.confidence === 'low') return withAlpha(point.color, 0.2)
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

  /**
   * Facility points still come from globe.gl's own `pointsData` layer (per
   * the rebuild plan, unchanged) and are still fully hidden on the true far
   * side by the globe's own depth test — that part already works. What they
   * did not have is the graceful dim-toward-the-edge the borders and arcs
   * now get, so a cluster of points near the horizon looked untouched next
   * to lines that were already fading. This patches each point's material
   * with the same facing formula, layered on top of the existing hard cutoff
   * rather than replacing it — depthTest/depthWrite stay on, so a genuinely
   * far-side point is still fully hidden; this only dims the ones that pass.
   *
   * globe.gl shares one material per distinct (colour, opacity) pair across
   * every point that uses it, rather than one material per point — visible
   * directly in the scene graph (551 low-confidence points on one material
   * instance). Replacing per-mesh would just make 1,229 shader materials
   * instead of the handful globe.gl already collapsed to, so this preserves
   * that sharing by keying replacements on the material being replaced.
   */
  useEffect(() => {
    const replacements = new Map<object, ShaderMaterial>()

    const patchPointMaterials = () => {
      const globe = globeRef.current
      if (globe) {
        globe.scene().traverse((obj) => {
          const mesh = obj as unknown as {
            type?: string
            geometry?: { type?: string }
            material?: {
              type?: string
              color?: { getHex: () => number }
              opacity?: number
            }
          }
          if (mesh.type !== 'Mesh' || mesh.geometry?.type !== 'CylinderGeometry') return
          const material = mesh.material
          if (!material || material.type !== 'MeshLambertMaterial' || !material.color) return

          let shader = replacements.get(material)
          if (!shader) {
            shader = new ShaderMaterial({
              uniforms: {
                uColor: { value: new Color(material.color.getHex()) },
                uOpacity: { value: material.opacity ?? 1 },
              },
              vertexShader: POINT_VERTEX_SHADER,
              fragmentShader: POINT_FRAGMENT_SHADER,
              transparent: true,
              depthWrite: true,
              depthTest: true,
            })
            replacements.set(material, shader)
          }
          ;(obj as unknown as { material: ShaderMaterial }).material = shader
        })
      }
      raf = requestAnimationFrame(patchPointMaterials)
    }

    // A dependency-array effect would need to fire again the moment
    // `globeRef.current` becomes available, but GlobeCanvas only mounts once
    // the dataset is already loaded — `points` is populated from the very
    // first render and never changes identity to naturally re-trigger one.
    // Polling every frame sidesteps that timing question entirely, and costs
    // almost nothing once patched: an already-converted material fails the
    // `MeshLambertMaterial` check immediately. It also keeps catching newly
    // appearing Lambert materials as globe.gl creates them (e.g. a fresh
    // highlight colour), which a one-shot effect would miss.
    let raf = requestAnimationFrame(patchPointMaterials)
    return () => cancelAnimationFrame(raf)
  }, [])

  /**
   * Rebuilds every arc mesh whenever the filtered set changes. Each gets its
   * own `TubeGeometry` (the curve depends on that specific arc's endpoints
   * and altitude, so geometry cannot be shared) and its own material instance
   * (uniforms are per-arc: grow progress, confidence, highlight). Old meshes
   * are fully disposed rather than reused, since three.js geometry/material
   * objects hold GPU resources that only a browser tab reload would otherwise
   * reclaim.
   */
  useEffect(() => {
    const globe = globeRef.current
    if (!globe) return
    const scene = globe.scene()

    const built: ArcMeshEntry[] = arcs.map((arc) => {
      const curve = buildArcCurve(globe, arc)
      const geometry = new TubeGeometry(
        curve,
        ARC_CURVE_SEGMENTS,
        Math.max(0.15, arc.width) * ARC_RADIUS_SCALE,
        ARC_TUBE_RADIAL_SEGMENTS,
        false,
      )
      const material = makeArcMaterial(arc.color, arc.confidence === 'low', reducedMotion)
      const mesh = new Mesh(geometry, material)
      mesh.userData.arc = arc
      scene.add(mesh)
      return { arc, mesh, material, createdAt: performance.now() }
    })

    arcMeshesRef.current = built

    return () => {
      for (const { mesh, material } of built) {
        scene.remove(mesh)
        mesh.geometry.dispose()
        material.dispose()
      }
      arcMeshesRef.current = []
    }
  }, [arcs, reducedMotion])

  /**
   * Highlight is the one thing about an arc that changes without the arc set
   * itself changing (selecting one, or walking the keyboard cursor over it),
   * so it gets its own pass over the current meshes rather than waiting for
   * the rebuild effect above.
   */
  useEffect(() => {
    for (const { arc, material } of arcMeshesRef.current) {
      // Writing a GPU uniform is the correct, idiomatic way to update a
      // three.js material every frame or on every relevant change — this
      // ref holds live scene objects for exactly that, not React state the
      // compiler could otherwise reason about.
      // eslint-disable-next-line react-hooks/immutability
      material.uniforms.uHighlight!.value = highlighted(arc.id) ? 1 : 0
    }
  }, [highlighted, arcs])

  /**
   * The one continuous loop this file owns: advances the traveling brightness
   * band's clock and each arc's grow-in reveal. Everything else (the border
   * fade, the idle camera rotation) needs no per-frame JS at all — this is
   * only necessary because the band and the reveal are genuinely animated
   * over time, not just a function of the current camera angle.
   */
  useEffect(() => {
    if (reducedMotion) return
    let raf = 0
    const tick = () => {
      const now = performance.now()
      for (const { material, createdAt } of arcMeshesRef.current) {
        material.uniforms.uTime!.value = now / 1000
        const growElapsed = now - createdAt
        material.uniforms.uGrow!.value = Math.min(1, growElapsed / ARC_GROW_MS)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [reducedMotion])

  /**
   * Arc meshes are not a globe.gl layer, so clicking one needs its own
   * raycaster. This only runs on click, not on every mouse move — a hover
   * tooltip would need the same raycast on every `pointermove`, which is not
   * worth the extra cost per frame for a value the detail panel already
   * shows once you click through.
   */
  useEffect(() => {
    const globe = globeRef.current
    if (!globe || size.width === 0) return
    const dom = globe.renderer().domElement
    const raycaster = new Raycaster()

    const onClick = (event: MouseEvent) => {
      const rect = dom.getBoundingClientRect()
      const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1
      const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(new Vector2(ndcX, ndcY), globe.camera())
      const meshes = arcMeshesRef.current.map((entry) => entry.mesh)
      const hit = raycaster.intersectObjects(meshes, false)[0]
      if (hit) onSelectArc(hit.object.userData.arc as ArcDatum)
    }

    dom.addEventListener('click', onClick)
    return () => dom.removeEventListener('click', onClick)
  }, [size.width, onSelectArc])

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

  /** Low-confidence sites get a slow ring instead of a stronger fill, so
   *  "uncertain" reads as a distinct signal rather than just a dimmer dot. */
  const flaggedPoints = useMemo(
    () => (reducedMotion ? [] : points.filter((p) => p.confidence === 'low')),
    [points, reducedMotion],
  )

  const ringColor = useCallback((datum: object) => {
    const point = datum as PointDatum
    return (t: number) => withAlpha(point.color, 0.5 * (1 - t))
  }, [])

  const ringMaxRadius = useCallback((datum: object) => (datum as PointDatum).radius * 4.5, [])

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
          showAtmosphere
          atmosphereColor={ATMOSPHERE_COLOR}
          atmosphereAltitude={0.12}
          animateIn={!reducedMotion}
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
          ringsData={flaggedPoints}
          ringLat="lat"
          ringLng="lng"
          ringAltitude={0.006}
          ringColor={ringColor}
          ringMaxRadius={ringMaxRadius}
          ringPropagationSpeed={1.4}
          ringRepeatPeriod={2600}
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
