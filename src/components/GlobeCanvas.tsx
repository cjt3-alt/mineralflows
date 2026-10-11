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
import {
  DAMPING,
  aimToward,
  DOUBLE_TAP_MS,
  ZOOM_STEP,
  clampAltitude,
  framingAltitude,
  grabRotateSpeed,
  isDoubleTap,
  isTap,
  maxAltitude,
  MIN_ALTITUDE,
  shouldAutoRotate,
} from './cameraDynamics.ts'
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
const OCEAN = '#050a11'
/** A barely-lifted fill under the land dots, so coastlines still read as shapes. */
const LAND_UNDERFILL = '#0a1520'
const LAND_DOT = '#4a7391'
const GRATICULE = 'rgba(90, 216, 240, 0.06)'
const GRATICULE_MAJOR = 'rgba(90, 216, 240, 0.13)'
const BORDER_COLOR = '#7f9ab8'
const ATMOSPHERE_COLOR = '#3fb3d1'
/** The sphere's edge glow, seen as an atmosphere from orbit. */
const RIM_COLOR = '#4cc3e0'

/* ------------------------------------------------------------------ framing */

/** Where the camera starts: over the western Pacific, with East Asia's import hubs in view and the arcs from South America arriving over the horizon. */
const HOME_VIEW = { lat: 8, lng: 150 }

/* ------------------------------------------------------------- land texture */

/** Spacing of the land dot matrix, in degrees of arc, and each dot's radius. */
const DOT_SPACING_DEG = 0.72
const DOT_RADIUS_DEG = 0.2

/**
 * The sphere's own surface: dark water, a faint targeting grid every 15
 * degrees, and land drawn as a dot matrix, the signature look of an
 * operations globe. Painted once onto an equirectangular canvas from the same
 * country rings the borders use; Natural Earth splits shapes at the
 * antimeridian, so no ring needs unwrapping.
 *
 * The dots are spaced evenly on the sphere, not on the texture: each row's
 * longitude step widens by 1/cos(latitude), and each dot is drawn as an
 * ellipse stretched by the same factor, so after the texture wraps the globe
 * every dot is round and the grid is even from the equator to the poles.
 */
function makeSurfaceTexture(): CanvasTexture {
  const width = 4096
  const height = 2048
  const x = (lng: number) => ((lng + 180) / 360) * width
  const y = (lat: number) => ((90 - lat) / 180) * height

  const traceLand = (ctx: CanvasRenderingContext2D, sx: (lng: number) => number, sy: (lat: number) => number) => {
    for (const shape of COUNTRY_SHAPES) {
      for (const polygon of shape.polygons) {
        ctx.beginPath()
        for (const ring of polygon) {
          ring.forEach(([lng, lat], i) => (i === 0 ? ctx.moveTo(sx(lng), sy(lat)) : ctx.lineTo(sx(lng), sy(lat))))
          ctx.closePath()
        }
        ctx.fill('evenodd')
      }
    }
  }

  // A low-resolution land mask to sample the dot grid against.
  const maskW = 1440
  const maskH = 720
  const mask = document.createElement('canvas')
  mask.width = maskW
  mask.height = maskH
  const mctx = mask.getContext('2d', { willReadFrequently: true })!
  mctx.fillStyle = '#fff'
  traceLand(
    mctx,
    (lng) => ((lng + 180) / 360) * maskW,
    (lat) => ((90 - lat) / 180) * maskH,
  )
  const maskData = mctx.getImageData(0, 0, maskW, maskH).data
  const isLand = (lat: number, lng: number) => {
    const mx = Math.min(maskW - 1, Math.max(0, Math.floor(((lng + 180) / 360) * maskW)))
    const my = Math.min(maskH - 1, Math.max(0, Math.floor(((90 - lat) / 180) * maskH)))
    return maskData[(my * maskW + mx) * 4]! > 127
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = OCEAN
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = LAND_UNDERFILL
  traceLand(ctx, x, y)

  ctx.lineWidth = 2
  for (let lng = -180; lng <= 180; lng += 15) {
    ctx.strokeStyle = lng % 90 === 0 ? GRATICULE_MAJOR : GRATICULE
    ctx.beginPath()
    ctx.moveTo(x(lng), 0)
    ctx.lineTo(x(lng), height)
    ctx.stroke()
  }
  for (let lat = -75; lat <= 75; lat += 15) {
    ctx.strokeStyle = lat === 0 ? GRATICULE_MAJOR : GRATICULE
    ctx.beginPath()
    ctx.moveTo(0, y(lat))
    ctx.lineTo(width, y(lat))
    ctx.stroke()
  }

  const pxPerDeg = width / 360
  ctx.fillStyle = LAND_DOT
  for (let lat = -84; lat <= 84; lat += DOT_SPACING_DEG) {
    const stretch = 1 / Math.max(0.08, Math.cos((lat * Math.PI) / 180))
    const step = DOT_SPACING_DEG * stretch
    // Offset alternate rows by half a step for a hex-like weave.
    const start = -180 + (Math.round((lat + 90) / DOT_SPACING_DEG) % 2 ? step / 2 : 0)
    for (let lng = start; lng < 180; lng += step) {
      if (!isLand(lat, lng)) continue
      ctx.beginPath()
      ctx.ellipse(x(lng), y(lat), DOT_RADIUS_DEG * pxPerDeg * stretch, DOT_RADIUS_DEG * pxPerDeg, 0, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = 8
  return texture
}

/* ------------------------------------------------------------------ globe */

/**
 * The sphere's material: the surface texture under a soft key light that rides
 * with the camera (up and to the left, so the globe always reads as round and
 * lit the same way at any rotation), plus a fresnel rim that brightens toward
 * the silhouette like an atmosphere seen from orbit.
 */
const GLOBE_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormalV = normalize(normalMatrix * normal);
    vViewDir = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`
const GLOBE_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uRim;
  varying vec2 vUv;
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  void main() {
    vec3 n = normalize(vNormalV);
    vec3 base = texture2D(uMap, vUv).rgb;
    vec3 light = normalize(vec3(-0.55, 0.6, 0.6));
    float key = 0.42 + 0.78 * max(dot(n, light), 0.0);
    float facing = max(dot(n, normalize(vViewDir)), 0.0);
    // Output is sRGB-encoded after this, so small linear values read bright:
    // the rim stays at zero across the face and rises only in the outer band.
    float rim = pow(smoothstep(0.6, 1.0, 1.0 - facing), 2.0);
    vec3 col = base * key + uRim * rim * 0.35;
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`

function makeGlobeMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uMap: { value: makeSurfaceTexture() },
      uRim: { value: new Color(RIM_COLOR) },
    },
    vertexShader: GLOBE_VERTEX_SHADER,
    fragmentShader: GLOBE_FRAGMENT_SHADER,
  })
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
const BORDER_BASE_ALPHA = 0.2
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

/**
 * The sprite is larger than the mark itself (`POINT_SPRITE_SCALE`), leaving
 * room for a soft glow around smelters and refineries. Mines get almost none,
 * so the processing sites — the chokepoints — are what the eye finds first.
 */
const POINT_SPRITE_SCALE = 2.6
const POINT_CORE = (1 / POINT_SPRITE_SCALE).toFixed(4)

const POINT_VERTEX_SHADER = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aState;
  attribute float aLow;
  attribute float aGlow;
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vLow;
  varying float vHi;
  varying float vGlow;
  ${FACING_GLSL}
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec4 mv = viewMatrix * world;
    float hi = aState > 1.5 ? 1.0 : 0.0;
    float dim = (aState > 0.5 && aState < 1.5) ? 1.0 : 0.0;
    float scale = clamp(${POINT_REFERENCE_DISTANCE.toFixed(1)} / -mv.z, 0.6, 3.0);
    gl_PointSize = aSize * ${POINT_SPRITE_SCALE.toFixed(2)} * uPixelRatio * scale * (hi > 0.5 ? 1.6 : 1.0);
    gl_Position = projectionMatrix * mv;
    vColor = aColor;
    vLow = aLow;
    vHi = hi;
    vGlow = aGlow;
    float base = aLow > 0.5 ? 0.65 : 1.0;
    vAlpha = base * mix(0.15, 1.0, facingOf(world.xyz)) * (dim > 0.5 ? 0.16 : 1.0);
  }
`
const POINT_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uAccent;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vLow;
  varying float vHi;
  varying float vGlow;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float r = d / ${POINT_CORE};
    vec3 col = vColor;
    float a;
    if (vLow > 0.5) {
      a = smoothstep(0.5, 0.65, r) * (1.0 - smoothstep(0.85, 1.0, r));
    } else {
      float core = 1.0 - smoothstep(0.78, 1.0, r);
      // A hot centre, then the mark's own colour, then a soft falloff of light.
      col = mix(vColor, mix(vColor, vec3(1.0, 0.95, 0.88), 0.55), 1.0 - smoothstep(0.0, 0.5, r));
      float glow = vGlow * 0.5 * exp(-max(r - 1.0, 0.0) * 1.9) * (1.0 - smoothstep(2.2, 2.6, r));
      a = max(core, glow);
    }
    if (vHi > 0.5) {
      float ring = smoothstep(1.45, 1.6, r) * (1.0 - smoothstep(1.75, 1.9, r));
      col = mix(col, uAccent, ring);
      a = max(a, ring);
    }
    a *= vAlpha;
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
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
  const glows = new Float32Array(n)
  const color = new Color()
  points.forEach((p, i) => {
    const c = globe.getCoords(p.lat, p.lng, POINT_ALTITUDE)
    positions.set([c.x, c.y, c.z], i * 3)
    color.set(p.color)
    colors.set([color.r, color.g, color.b], i * 3)
    sizes[i] = p.size
    lows[i] = p.confidence === 'low' ? 1 : 0
    glows[i] = p.stage === 'mine' ? 0.25 : p.stage === 'process' ? 0.8 : 1
  })
  // Draw mines first and refineries last, so the rarer, larger marks sit on
  // top of the mine clusters they are often surrounded by.
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('aColor', new Float32BufferAttribute(colors, 3))
  geometry.setAttribute('aSize', new Float32BufferAttribute(sizes, 1))
  geometry.setAttribute('aLow', new Float32BufferAttribute(lows, 1))
  geometry.setAttribute('aGlow', new Float32BufferAttribute(glows, 1))
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
 * Each flow is two tubes: a thin core and a wide, faint halo drawn additively
 * around it, so an arc reads as a line of light rather than a pipe. Each has
 * its own small material because each has its own grow-in, comet phase,
 * highlight and dim state.
 *
 * The core uses normal blending: with depth testing off (so a flow survives
 * past the horizon) hundreds of tubes overlap at hubs like China, and additive
 * blending stacked them to solid white. The halo is additive but faint enough
 * that even a hub's worth of overlap only warms the air around it.
 */
interface ArcEntry {
  arc: ArcDatum
  core: Mesh
  halo: Mesh | null
  materials: ShaderMaterial[]
  /** Points along the curve in world space, for screen-space picking. */
  samples: Vector3[]
  /** When the grow-in starts; staggered so the largest flows draw first. */
  startsAt: number
  /** Highlight and dim targets; the animation loop eases the uniforms toward them. */
  hiTarget: number
  dimTarget: number
}

const ARC_CURVE_SEGMENTS = 64
const ARC_TUBE_RADIAL_SEGMENTS = 8
/** derive.ts widths are in globe-radius hundredths; this sets on-screen thickness. */
const ARC_RADIUS_SCALE = 0.42
const ARC_MIN_RADIUS = 0.11
/** Halo radius as a multiple of the core's. */
const ARC_HALO_SCALE = 4.5
const ARC_GROW_MS = 1100
/** The whole set finishes drawing in within this, largest first. */
const ARC_STAGGER_MS = 1600
/** Loops per second of the comet that travels from exporter to importer. */
const ARC_COMET_SPEED = 0.16
const ARC_PICK_SAMPLES = 24
/** How quickly highlight and dim ease toward their targets, per frame. */
const ARC_STATE_EASE = 0.18

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

/**
 * `vEdge` is how squarely this bit of tube faces the camera: 1 along the
 * middle of the line, 0 at its silhouette. Fading alpha by it gives every arc
 * a soft edge instead of a hard-sided pipe.
 */
const ARC_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  varying float vEdge;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vec4 mv = viewMatrix * w;
    vec3 nV = normalize(normalMatrix * normal);
    vEdge = abs(dot(nV, normalize(-mv.xyz)));
    gl_Position = projectionMatrix * mv;
  }
`
/**
 * `vUv.x` runs along the tube from exporter (0) to importer (1). Colour ramps
 * from a dim, deep shade at the exporter to a warm, bright one where the
 * material lands, so direction reads without arrows. The comet is a bright
 * head with an exponential tail behind it, each arc on its own phase so they
 * do not pulse in lockstep.
 */
const ARC_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uAccent;
  uniform float uGrow;
  uniform float uTime;
  uniform float uWeight;
  uniform float uHi;
  uniform float uDim;
  uniform float uLowConfidence;
  uniform float uComet;
  uniform float uPhase;
  uniform float uHalo;
  varying vec2 vUv;
  varying vec3 vWorld;
  varying float vEdge;
  ${FACING_GLSL}
  void main() {
    if (vUv.x > uGrow) discard;
    if (uLowConfidence > 0.5 && fract(vUv.x * 22.0) > 0.55) discard;

    vec3 start = uColor * 0.5;
    vec3 end = mix(uColor, vec3(1.0, 0.86, 0.66), 0.5);
    vec3 col = mix(start, end, smoothstep(0.0, 1.0, vUv.x));

    float comet = 0.0;
    if (uLowConfidence < 0.5) {
      float head = fract(uTime * ${ARC_COMET_SPEED.toFixed(4)} + uPhase);
      float behind = head - vUv.x;
      if (behind < 0.0) behind += 1.0;
      comet = exp(-behind * 16.0) * step(behind, 0.4) * uComet;
    }
    col = mix(col, vec3(1.0, 0.96, 0.88), comet * 0.8);
    col = mix(col, uAccent, uHi);

    float soft;
    float base;
    if (uHalo > 0.5) {
      soft = pow(vEdge, 2.0);
      base = (0.035 + 0.11 * uWeight) * (1.0 + uHi * 1.5) + comet * 0.12;
    } else {
      soft = smoothstep(0.0, 0.55, vEdge);
      base = uLowConfidence > 0.5 ? 0.26 : 0.32 + 0.55 * uWeight;
      base = mix(base, 1.0, uHi) + comet * 0.45;
    }
    base *= mix(1.0, 0.12, uDim);
    float alpha = min(1.0, base) * soft * mix(0.08, 1.0, facingOf(vWorld));
    if (alpha < 0.005) discard;
    gl_FragColor = vec4(col, alpha);
  }
`

function makeArcMaterial(arc: ArcDatum, halo: boolean, reducedMotion: boolean): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(arc.color) },
      uAccent: { value: new Color(ACCENT) },
      uGrow: { value: reducedMotion ? 1 : 0 },
      uTime: { value: 0 },
      uWeight: { value: arc.weight },
      uHi: { value: 0 },
      uDim: { value: 0 },
      uLowConfidence: { value: arc.confidence === 'low' ? 1 : 0 },
      uComet: { value: reducedMotion ? 0 : 1 },
      uPhase: { value: Math.random() },
      uHalo: { value: halo ? 1 : 0 },
    },
    vertexShader: ARC_VERTEX_SHADER,
    fragmentShader: ARC_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: halo ? AdditiveBlending : NormalBlending,
    side: DoubleSide,
  })
}

function buildArc(globe: GlobeMethods, arc: ArcDatum, rank: number, count: number, reducedMotion: boolean): ArcEntry {
  const curve = buildArcCurve(globe, arc)
  const radius = Math.max(ARC_MIN_RADIUS, arc.width * ARC_RADIUS_SCALE)
  const coreMaterial = makeArcMaterial(arc, false, reducedMotion)
  const core = new Mesh(new TubeGeometry(curve, ARC_CURVE_SEGMENTS, radius, ARC_TUBE_RADIAL_SEGMENTS, false), coreMaterial)
  // Larger flows draw last so they sit on top of the small ones they cross.
  core.renderOrder = 5 + arc.weight
  const materials = [coreMaterial]

  // Importer-only flows stay a plain dashed line: no halo to make them look surer than they are.
  let halo: Mesh | null = null
  if (arc.confidence !== 'low') {
    const haloMaterial = makeArcMaterial(arc, true, reducedMotion)
    // Halo and core share a phase so the comet glows where it is.
    haloMaterial.uniforms.uPhase!.value = coreMaterial.uniforms.uPhase!.value
    halo = new Mesh(
      new TubeGeometry(curve, ARC_CURVE_SEGMENTS, radius * ARC_HALO_SCALE, ARC_TUBE_RADIAL_SEGMENTS, false),
      haloMaterial,
    )
    halo.renderOrder = 4
    materials.push(haloMaterial)
  }

  const delay = count > 1 ? (rank / (count - 1)) * ARC_STAGGER_MS : 0
  return {
    arc,
    core,
    halo,
    materials,
    samples: curve.getSpacedPoints(ARC_PICK_SAMPLES),
    startsAt: performance.now() + delay,
    hiTarget: 0,
    dimTarget: 0,
  }
}

/* --------------------------------------------------------- landing pulses */

/**
 * Where the most material lands, a soft ring ripples outward on the surface,
 * sized by how much arrives. It makes the import hubs readable at a glance
 * without another label. Data-coloured, never the accent.
 */
const PULSE_COUNT = 10
const PULSE_COLOR = '#ffc98a'

const PULSE_VERTEX_SHADER = /* glsl */ `
  attribute float aWeight;
  attribute float aPhase;
  uniform float uPixelRatio;
  varying float vWeight;
  varying float vPhase;
  varying float vFacing;
  ${FACING_GLSL}
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec4 mv = viewMatrix * world;
    float scale = clamp(290.0 / -mv.z, 0.6, 3.0);
    gl_PointSize = (26.0 + 46.0 * aWeight) * uPixelRatio * scale;
    gl_Position = projectionMatrix * mv;
    vWeight = aWeight;
    vPhase = aPhase;
    vFacing = facingOf(world.xyz);
  }
`
const PULSE_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  varying float vWeight;
  varying float vPhase;
  varying float vFacing;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float t = fract(uTime * 0.38 + vPhase);
    float ring = smoothstep(t - 0.12, t, d) * (1.0 - smoothstep(t, t + 0.03, d));
    float alpha = ring * (1.0 - t) * (0.35 + 0.45 * vWeight) * vFacing;
    if (alpha < 0.005) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`

interface PulseLayer {
  object: Points
  material: ShaderMaterial
}

function buildPulses(globe: GlobeMethods, arcs: ArcDatum[]): PulseLayer | null {
  const byDestination = new Map<string, { lat: number; lng: number; usd: number }>()
  for (const arc of arcs) {
    const key = arc.flow.to_iso3
    const entry = byDestination.get(key) ?? { lat: arc.endLat, lng: arc.endLng, usd: 0 }
    entry.usd += arc.value.usd ?? 0
    byDestination.set(key, entry)
  }
  const top = [...byDestination.values()].sort((a, b) => b.usd - a.usd).slice(0, PULSE_COUNT)
  if (top.length === 0) return null
  const max = top[0]!.usd
  const positions = new Float32Array(top.length * 3)
  const weights = new Float32Array(top.length)
  const phases = new Float32Array(top.length)
  top.forEach((d, i) => {
    const c = globe.getCoords(d.lat, d.lng, 0.004)
    positions.set([c.x, c.y, c.z], i * 3)
    weights[i] = max > 0 ? Math.sqrt(d.usd / max) : 0
    phases[i] = i / top.length
  })
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('aWeight', new Float32BufferAttribute(weights, 1))
  geometry.setAttribute('aPhase', new Float32BufferAttribute(phases, 1))
  const material = new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(PULSE_COLOR) },
      uTime: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    },
    vertexShader: PULSE_VERTEX_SHADER,
    fragmentShader: PULSE_FRAGMENT_SHADER,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: AdditiveBlending,
  })
  const object = new Points(geometry, material)
  object.renderOrder = 2
  return { object, material }
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
  const pulseLayerRef = useRef<PulseLayer | null>(null)

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

  const globeMaterial = useMemo(() => makeGlobeMaterial(), [])

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
    const built = arcs.map((arc, i) => buildArc(globe, arc, i, arcs.length, reducedMotion))
    for (const entry of built) {
      scene.add(entry.core)
      if (entry.halo) scene.add(entry.halo)
    }
    arcEntriesRef.current = built
    const pulses = reducedMotion ? null : buildPulses(globe, arcs)
    if (pulses) scene.add(pulses.object)
    pulseLayerRef.current = pulses
    return () => {
      for (const { core, halo, materials } of built) {
        for (const mesh of halo ? [core, halo] : [core]) {
          scene.remove(mesh)
          mesh.geometry.dispose()
        }
        for (const m of materials) m.dispose()
      }
      arcEntriesRef.current = []
      if (pulses) {
        scene.remove(pulses.object)
        pulses.object.geometry.dispose()
        pulses.material.dispose()
      }
      pulseLayerRef.current = null
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
    for (const entry of arcEntriesRef.current) {
      // The ref holds live scene objects, not React state; the animation loop
      // eases the uniforms toward these targets.
      // eslint-disable-next-line react-hooks/immutability
      entry.hiTarget = isHi(entry.arc.id) ? 1 : 0
      entry.dimTarget = selectedId !== null && entry.hiTarget === 0 ? 1 : 0
      if (reducedMotion) {
        for (const m of entry.materials) {
          m.uniforms.uHi!.value = entry.hiTarget
          m.uniforms.uDim!.value = entry.dimTarget
        }
      }
    }
  }, [ready, points, arcs, selectedId, hoverId, externalHoverId, cursorId, focusCountry, reducedMotion])

  /* --------------------------------------------------------------- camera */

  /**
   * The camera only moves when the viewer moves it, or explicitly asks to go
   * somewhere (search, the largest-flows list, the camera buttons). It never
   * re-frames itself on resize — on a phone the address bar resizes the
   * viewport during every gesture, which used to snap the view home — and a
   * click on a country filters without flying away from where it was clicked.
   * The rules themselves live in cameraDynamics.ts.
   */
  const lastInteractionRef = useRef<number | null>(null)
  const pointerDownRef = useRef(false)
  const busyRef = useRef(false)
  /** The country a click on the globe just focused, so the fly-to effect leaves the camera alone. */
  const clickedCountryRef = useRef<string | null>(null)
  const sizeRef = useRef(size)
  const framedRef = useRef(false)

  useEffect(() => {
    sizeRef.current = size
  }, [size])

  const markInteraction = useCallback(() => {
    lastInteractionRef.current = performance.now()
  }, [])

  useEffect(() => {
    busyRef.current =
      keyboardActive || selectedId !== null || focusCountry !== null || hover !== null || externalHoverId !== null
  }, [keyboardActive, selectedId, focusCountry, hover, externalHoverId])

  /* Controls: set once the globe exists, and re-tuned on every camera change. */
  useEffect(() => {
    const globe = globeRef.current
    if (!ready || !globe) return
    const controls = globe.controls()
    const radius = globe.getGlobeRadius()
    controls.enablePan = false
    // Zoom toward the centre. globe.gl zooms toward the cursor and then pulls
    // the orbit target back to the centre after every step, which made zoom
    // drift sideways.
    controls.zoomToCursor = false
    controls.enableDamping = !reducedMotion
    controls.dampingFactor = DAMPING
    controls.autoRotateSpeed = 0.35

    // globe.gl rewrites rotateSpeed and zoomSpeed on every change from a
    // listener of its own. This one is added after it, so these values win.
    const tune = () => {
      const { width, height } = sizeRef.current
      controls.rotateSpeed = grabRotateSpeed(globe.pointOfView().altitude)
      controls.zoomSpeed = 0.8
      controls.minDistance = radius * (1 + MIN_ALTITUDE)
      controls.maxDistance = radius * (1 + maxAltitude(width, height))
    }
    tune()

    // The HUD readout updates about ten times a second, not every frame, with
    // a trailing update so the last position of a move is always shown.
    let lastReport = 0
    let pending = 0
    const report = () => {
      pending = 0
      lastReport = performance.now()
      const pov = globe.pointOfView()
      setView({ lat: pov.lat, lng: pov.lng, altitude: pov.altitude })
    }
    const onChange = () => {
      tune()
      if (pending) return
      pending = window.setTimeout(report, Math.max(0, 100 - (performance.now() - lastReport)))
    }
    controls.addEventListener('change', onChange)
    return () => {
      controls.removeEventListener('change', onChange)
      window.clearTimeout(pending)
    }
  }, [ready, reducedMotion])

  /**
   * First frame: home view, fitted to the viewport. Every later resize keeps
   * wherever the viewer is and only pulls the zoom back inside the limits.
   */
  useEffect(() => {
    const globe = globeRef.current
    if (!ready || !globe || size.width === 0) return
    const controls = globe.controls()
    controls.maxDistance = globe.getGlobeRadius() * (1 + maxAltitude(size.width, size.height))
    if (!framedRef.current) {
      framedRef.current = true
      globe.pointOfView({ ...HOME_VIEW, altitude: framingAltitude(size.width, size.height) }, 0)
      return
    }
    const pov = globe.pointOfView()
    const clamped = clampAltitude(pov.altitude, size.width, size.height)
    if (Math.abs(clamped - pov.altitude) > 1e-3) globe.pointOfView({ altitude: clamped }, 0)
  }, [ready, size.width, size.height])

  /** Current altitude, kept within the limits. Flights keep the viewer's zoom. */
  const currentAltitude = useCallback((): number => {
    const globe = globeRef.current
    const { width, height } = sizeRef.current
    if (!globe) return framingAltitude(width, height)
    return clampAltitude(globe.pointOfView().altitude, width, height)
  }, [])

  /**
   * Fly to a country focused from search or a dossier link — not one just
   * clicked on the globe — leaning toward its trade partners (see `aimToward`).
   */
  useEffect(() => {
    const globe = globeRef.current
    if (!ready || !globe || focusCountry === null) return
    if (clickedCountryRef.current === focusCountry) {
      clickedCountryRef.current = null
      return
    }
    clickedCountryRef.current = null
    const c = countries[focusCountry]
    if (!c) return
    // Under a focus the arcs are already just this country's trade.
    const partners = arcs.map((arc) =>
      arc.flow.from_iso3 === focusCountry
        ? { lat: arc.endLat, lng: arc.endLng, weight: arc.value.usd ?? 0 }
        : { lat: arc.startLat, lng: arc.startLng, weight: arc.value.usd ?? 0 },
    )
    const aim = aimToward({ lat: c.lat, lng: c.lon }, partners)
    globe.pointOfView({ ...aim, altitude: currentAltitude() }, reducedMotion ? 0 : 1000)
    // The arcs are read once per flight, not re-flown every time a layer toggles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, focusCountry, countries, reducedMotion, currentAltitude])

  /**
   * Fly to a flow picked from the list. A flow clicked on the globe is already
   * in view, so this only moves when the pick came from elsewhere — which is
   * exactly when the list row was being hovered. Zooms out only as far as
   * needed for a long flow to fit.
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
    const { width, height } = sizeRef.current
    globe.pointOfView(
      { lat: coords.lat, lng: coords.lng, altitude: Math.max(currentAltitude(), framingAltitude(width, height)) },
      reducedMotion ? 0 : 900,
    )
    // Only on a new selection, not on every hover change after it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, selectedId])

  /* Fly to the keyboard cursor, so it is actually on screen, at the current zoom. */
  useEffect(() => {
    const globe = globeRef.current
    if (!globe || !keyboardActive || current === undefined) return
    const lat = current.kind === 'facility' ? current.point.lat : current.arc.startLat
    const lng = current.kind === 'facility' ? current.point.lng : current.arc.startLng
    globe.pointOfView({ lat, lng, altitude: currentAltitude() }, reducedMotion ? 0 : 600)
  }, [current, keyboardActive, reducedMotion, currentAltitude])

  /** Zoom one step in (factor < 1) or out, optionally centring on a screen point. */
  const zoomBy = useCallback(
    (factor: number, at?: { x: number; y: number }) => {
      const globe = globeRef.current
      if (!globe) return
      markInteraction()
      const pov = globe.pointOfView()
      const { width, height } = sizeRef.current
      const target = at ? globe.toGlobeCoords(at.x, at.y) : null
      globe.pointOfView(
        {
          lat: target?.lat ?? pov.lat,
          lng: target?.lng ?? pov.lng,
          altitude: clampAltitude(pov.altitude * factor, width, height),
        },
        reducedMotion ? 0 : 450,
      )
    },
    [markInteraction, reducedMotion],
  )

  const goHome = useCallback(() => {
    const globe = globeRef.current
    if (!globe) return
    markInteraction()
    const { width, height } = sizeRef.current
    globe.pointOfView({ ...HOME_VIEW, altitude: framingAltitude(width, height) }, reducedMotion ? 0 : 900)
  }, [markInteraction, reducedMotion])

  /**
   * Auto-rotate as a screensaver: on when the page opens, off the moment the
   * globe is touched, and back only after a quiet spell with nothing selected.
   * Checked on a timer from refs, so it never re-renders anything.
   */
  useEffect(() => {
    const globe = globeRef.current
    if (!ready || !globe) return
    const id = window.setInterval(() => {
      globe.controls().autoRotate = shouldAutoRotate({
        now: performance.now(),
        lastInteraction: lastInteractionRef.current,
        pointerDown: pointerDownRef.current,
        busy: busyRef.current,
        reducedMotion,
      })
    }, 250)
    return () => window.clearInterval(id)
  }, [ready, reducedMotion])

  /* ----------------------------------------------------------- animation */

  useEffect(() => {
    if (reducedMotion) return
    let raf = 0
    const tick = () => {
      const now = performance.now()
      const seconds = now / 1000
      for (const entry of arcEntriesRef.current) {
        const t = Math.min(1, Math.max(0, (now - entry.startsAt) / ARC_GROW_MS))
        const grow = 1 - Math.pow(1 - t, 3)
        for (const m of entry.materials) {
          const u = m.uniforms
          u.uTime!.value = seconds
          u.uGrow!.value = grow
          u.uHi!.value += (entry.hiTarget - u.uHi!.value) * ARC_STATE_EASE
          u.uDim!.value += (entry.dimTarget - u.uDim!.value) * ARC_STATE_EASE
        }
      }
      const pulses = pulseLayerRef.current
      if (pulses) pulses.material.uniforms.uTime!.value = seconds
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

  /**
   * Pointer input. OrbitControls owns drag, pinch and wheel; this adds hover,
   * taps and double taps on top without fighting it:
   *
   * - Nothing hover-related runs while a pointer is down, so a drag spends its
   *   frames on rendering.
   * - A tap must be quick, nearly still and single-pointer (see `isTap`), so
   *   the end of a pinch or a hesitant drag never counts as a click.
   * - A tap on land waits out the double-tap window before focusing a country,
   *   so a double tap to zoom never also changes the filters.
   */
  useEffect(() => {
    const globe = globeRef.current
    if (!ready || !globe) return
    const dom = globe.renderer().domElement
    const active = new Map<number, { x: number; y: number }>()
    let gesture: { x: number; y: number; at: number; maxPointers: number; moved: number } | null = null
    let lastTap: { at: number; x: number; y: number } | null = null
    let pendingTap = 0
    let frame = 0
    let last: PointerEvent | null = null

    const local = (event: PointerEvent | MouseEvent) => {
      const rect = dom.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }

    const run = () => {
      frame = 0
      if (!last || active.size > 0) return
      const { x, y } = local(last)
      const hit = pick(x, y)
      setHover(hit ? { hit, x, y } : null)
      const coords = globe.toGlobeCoords(x, y)
      setPointer(coords ? { lat: coords.lat, lng: coords.lng } : null)
      const shape = !hit && coords ? countryAt(coords.lat, coords.lng) : null
      const known = shape?.iso3 && shape.iso3 in countries ? shape.iso3 : null
      setHoverCountry(known)
      dom.style.cursor = hit || known ? 'pointer' : 'grab'
    }

    const onMove = (event: PointerEvent) => {
      markInteraction()
      if (gesture && active.has(event.pointerId)) {
        const p = local(event)
        gesture.moved = Math.max(gesture.moved, Math.hypot(p.x - gesture.x, p.y - gesture.y))
        return
      }
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
      markInteraction()
      pointerDownRef.current = true
      globe.controls().autoRotate = false
      const p = local(event)
      active.set(event.pointerId, p)
      if (gesture) gesture.maxPointers = Math.max(gesture.maxPointers, active.size)
      else gesture = { x: p.x, y: p.y, at: performance.now(), maxPointers: 1, moved: 0 }
      setHover(null)
      dom.style.cursor = 'grabbing'
    }
    const release = (event: PointerEvent): typeof gesture => {
      if (!active.has(event.pointerId)) return null
      active.delete(event.pointerId)
      if (active.size > 0) return null
      pointerDownRef.current = false
      markInteraction()
      dom.style.cursor = 'grab'
      const g = gesture
      gesture = null
      return g
    }
    const onUp = (event: PointerEvent) => {
      const g = release(event)
      if (!g) return
      const p = local(event)
      const now = performance.now()
      const moved = Math.max(g.moved, Math.hypot(p.x - g.x, p.y - g.y))
      if (!isTap({ durationMs: now - g.at, movedPx: moved, maxPointers: g.maxPointers })) {
        lastTap = null
        return
      }
      const tap = { at: now, x: p.x, y: p.y }
      if (isDoubleTap(lastTap, tap)) {
        lastTap = null
        window.clearTimeout(pendingTap)
        zoomBy(ZOOM_STEP, p)
        return
      }
      lastTap = tap
      const hit = pick(p.x, p.y)
      if (hit) {
        setKeyboardActive(false)
        if (hit.kind === 'facility') onSelectPoint(hit.point)
        else onSelectArc(hit.arc)
        return
      }
      window.clearTimeout(pendingTap)
      pendingTap = window.setTimeout(() => {
        const coords = globe.toGlobeCoords(p.x, p.y)
        const shape = coords ? countryAt(coords.lat, coords.lng) : null
        if (shape?.iso3 && shape.iso3 in countries) {
          clickedCountryRef.current = shape.iso3
          onSelectCountry(shape.iso3)
        } else {
          onClearSelection()
        }
      }, DOUBLE_TAP_MS)
    }
    const onCancel = (event: PointerEvent) => {
      release(event)
      lastTap = null
    }
    const onWheel = () => {
      markInteraction()
      globe.controls().autoRotate = false
    }

    dom.addEventListener('pointermove', onMove)
    dom.addEventListener('pointerleave', onLeave)
    dom.addEventListener('pointerdown', onDown)
    dom.addEventListener('pointerup', onUp)
    dom.addEventListener('pointercancel', onCancel)
    dom.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(pendingTap)
      dom.removeEventListener('pointermove', onMove)
      dom.removeEventListener('pointerleave', onLeave)
      dom.removeEventListener('pointerdown', onDown)
      dom.removeEventListener('pointerup', onUp)
      dom.removeEventListener('pointercancel', onCancel)
      dom.removeEventListener('wheel', onWheel)
    }
  }, [ready, pick, countries, markInteraction, zoomBy, onSelectPoint, onSelectArc, onSelectCountry, onClearSelection])

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
      markInteraction()
      if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        return zoomBy(ZOOM_STEP)
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault()
        return zoomBy(1 / ZOOM_STEP)
      }
      if (event.key === '0') {
        event.preventDefault()
        return goHome()
      }
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
    [walk, current, onSelectPoint, onSelectArc, onClearSelection, markInteraction, zoomBy, goHome],
  )

  /* -------------------------------------------------------------- render */

  return (
    <div
      ref={containerRef}
      role="application"
      aria-label="Globe. Drag to rotate, scroll or pinch to zoom, double-click to zoom in, click a flow, site or country. With the keyboard, arrow keys move between flows and sites, Enter opens one, plus and minus zoom, zero resets the view."
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
          atmosphereAltitude={0.17}
          animateIn={!reducedMotion}
          enablePointerInteraction={false}
        />
      )}

      <Hud view={view} pointer={pointer} hoverCountry={hoverCountry} countries={countries} />
      <CameraButtons onZoomIn={() => zoomBy(ZOOM_STEP)} onZoomOut={() => zoomBy(1 / ZOOM_STEP)} onHome={goHome} />

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

function CameraButtons({ onZoomIn, onZoomOut, onHome }: { onZoomIn: () => void; onZoomOut: () => void; onHome: () => void }) {
  const cls =
    'flex h-8 w-8 items-center justify-center border-b border-line-strong text-dim last:border-b-0 hover:bg-accent/10 hover:text-accent'
  return (
    <div className="panel absolute top-5 left-5 z-10 flex flex-col sm:top-16 sm:left-6" role="group" aria-label="Camera">
      <button type="button" onClick={onZoomIn} className={cls} aria-label="Zoom in" title="Zoom in (+)">
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.4" /></svg>
      </button>
      <button type="button" onClick={onZoomOut} className={cls} aria-label="Zoom out" title="Zoom out (−)">
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><path d="M1 6h10" stroke="currentColor" strokeWidth="1.4" /></svg>
      </button>
      <button type="button" onClick={onHome} className={cls} aria-label="Reset view" title="Reset view (0)">
        <svg aria-hidden="true" width="13" height="13" viewBox="0 0 13 13">
          <circle cx="6.5" cy="6.5" r="5" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M6.5 0v3M6.5 10v3M0 6.5h3M10 6.5h3" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
    </div>
  )
}

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
          <span className="text-muted">DRAG · SCROLL · DOUBLE-CLICK</span>
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
