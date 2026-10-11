import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { geoGraticule10, geoMercator, geoPath, type GeoPermissibleObjects, type GeoProjection } from 'd3-geo'
import { feature, mesh } from 'topojson-client'
import countriesTopology from 'world-atlas/countries-110m.json'
import type { Topology } from 'topojson-specification'
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
import { DOUBLE_TAP_MS, isDoubleTap, isTap } from './cameraDynamics.ts'
import {
  MAX_ZOOM,
  ZOOM_STEP,
  bowControl,
  centreOn,
  clampView,
  fitPoints,
  keepInView,
  quadAt,
  zoomAbout,
  type Pt,
  type Rect,
  type View,
} from './mapDynamics.ts'

/**
 * The flat map: the same data, marks and interactions as the globe, drawn on
 * a 2D canvas in the Mercator projection, the one web maps use, so it reads
 * like the map everyone already knows. The map is cut where the least traded value crosses
 * (see `chooseSeam`), which for copper puts the Pacific in the middle.
 *
 * Two layers. A static layer — ocean, graticule, dot-matrix land, borders —
 * is rendered to an offscreen canvas only when the view settles; while a pan
 * or zoom is in progress it is reused, shifted and scaled, so dragging costs
 * one bitmap copy. A dynamic layer — arcs, comets, landing pulses, sites,
 * highlights — is redrawn every frame on top.
 */

export interface MapCanvasProps {
  points: PointDatum[]
  arcs: ArcDatum[]
  countries: Record<string, Country>
  selectedId: string | null
  externalHoverId: string | null
  focusCountry: string | null
  /** Longitude at the centre of the map. */
  centralMeridian: number
  /** Pixels covered by a panel on the right; the map keeps its content clear of them. */
  insetRight: number
  reducedMotion: boolean
  onSelectPoint: (point: PointDatum) => void
  onSelectArc: (arc: ArcDatum) => void
  onSelectCountry: (iso3: string) => void
  onClearSelection: () => void
}

/* ------------------------------------------------------------------ palette */

const ACCENT = '#5ad8f0'
const SPHERE_FILL = 'rgba(9, 17, 27, 0.75)'
const SPHERE_EDGE = 'rgba(76, 195, 224, 0.45)'
const GRATICULE = 'rgba(90, 216, 240, 0.06)'
const LAND_UNDERFILL = 'rgba(14, 30, 44, 0.9)'
const LAND_DOT = '#4a7391'
const BORDER = 'rgba(127, 154, 184, 0.28)'
const COMET = '255, 244, 225'
const PULSE = '255, 201, 138'

/* ---------------------------------------------------------------- geometry */

const topology = countriesTopology as unknown as Topology
const LAND = feature(topology, topology.objects.land!) as unknown as GeoPermissibleObjects
const BORDERS = mesh(topology, topology.objects.countries as never, (a, b) => a !== b) as unknown as GeoPermissibleObjects
const SPHERE: GeoPermissibleObjects = { type: 'Sphere' }
const GRATICULE_LINES = geoGraticule10()

/** Country outlines by ISO3, for the hover and focus fills. */
const COUNTRY_GEOMETRY = new Map<string, GeoPermissibleObjects>(
  COUNTRY_SHAPES.filter((s) => s.iso3 !== null).map((s) => [
    s.iso3!,
    { type: 'MultiPolygon', coordinates: s.polygons } as GeoPermissibleObjects,
  ]),
)

/**
 * Mercator stretches toward the poles without limit, so the map is cropped, as
 * web maps are: north of Svalbard, and south at Cape Horn, since no copper
 * trade happens in Antarctica.
 */
const LAT_TOP = 78
const LAT_BOTTOM = -56

interface Fitted {
  projection: GeoProjection
  /** The fitted map's size at zoom 1, centred in the viewport. */
  mapW: number
  mapH: number
}

function fitProjection(width: number, height: number, centralMeridian: number, pad: number): Fitted {
  const projection = geoMercator().rotate([-centralMeridian, 0]).scale(1).translate([0, 0])
  // A unit Mercator spans 2π across; the height depends on the crop.
  const x0 = -Math.PI
  const x1 = Math.PI
  const top = projection([centralMeridian, LAT_TOP])![1]
  const bottom = projection([centralMeridian, LAT_BOTTOM])![1]
  const s = Math.min((width - pad * 2) / (x1 - x0), (height - pad * 2) / (bottom - top))
  const tx = width / 2 - (s * (x0 + x1)) / 2
  const ty = height / 2 - (s * (top + bottom)) / 2
  projection.scale(s).translate([tx, ty])
  // Clip to the cropped rectangle, so the "sphere" outline is the map's edge.
  projection.clipExtent([
    [tx + s * x0, ty + s * top],
    [tx + s * x1, ty + s * bottom],
  ])
  return { projection, mapW: s * (x1 - x0), mapH: s * (bottom - top) }
}

/* -------------------------------------------------------------- arc model */

interface ArcGeom {
  arc: ArcDatum
  /** Base-map coordinates (zoom 1). */
  a: Pt
  b: Pt
  c: Pt
  /** Comet phase, so comets do not run in lockstep. */
  phase: number
  startsAt: number
  hi: number
  dim: number
}

const ARC_GROW_MS = 1100
const ARC_STAGGER_MS = 1600
const COMET_SPEED = 0.16
const COMET_TAIL = 0.2
const STATE_EASE = 0.18
const PICK_SAMPLES = 24

/** The sub-curve of a quadratic from t0 to t1, by de Casteljau. */
function subQuad(a: Pt, c: Pt, b: Pt, t0: number, t1: number): [Pt, Pt, Pt] {
  // Split at t1, keep the head, then split that at t0 / t1 and keep the tail.
  const lerp = (p: Pt, q: Pt, t: number) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
  const c1 = lerp(a, c, t1)
  const e1 = quadAt(a, c, b, t1)
  if (t0 <= 0) return [a, c1, e1]
  const s = t0 / t1
  const start = quadAt(a, c1, e1, s)
  const c2 = lerp(c1, e1, s)
  return [start, c2, e1]
}

function rgba(hex: string, alpha: number): string {
  const v = hex.replace('#', '')
  return `rgba(${parseInt(v.slice(0, 2), 16)}, ${parseInt(v.slice(2, 4), 16)}, ${parseInt(v.slice(4, 6), 16)}, ${alpha})`
}

function mixHex(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const x = p(a)
  const y = p(b)
  return '#' + x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, '0')).join('')
}

/* ------------------------------------------------------------ point sprites */

const SPRITE_SCALE = 2.6
/** Sites read smaller on a flat map than on the globe, where they foreshorten. */
const POINT_SIZE = 0.85
const spriteCache = new Map<string, HTMLCanvasElement>()

/** A pre-rendered glowing dot (or hollow ring) for one colour, size and stage. */
function sprite(color: string, size: number, low: boolean, glow: number, dpr: number): HTMLCanvasElement {
  const key = `${color}|${size.toFixed(2)}|${low}|${glow}|${dpr}`
  const cached = spriteCache.get(key)
  if (cached) return cached
  const px = Math.ceil(size * SPRITE_SCALE * dpr)
  const canvas = document.createElement('canvas')
  canvas.width = px
  canvas.height = px
  const ctx = canvas.getContext('2d')!
  const c = px / 2
  const r = (size / 2) * dpr
  if (low) {
    ctx.strokeStyle = rgba(color, 0.75)
    ctx.lineWidth = Math.max(1, r * 0.35)
    ctx.beginPath()
    ctx.arc(c, c, r * 0.8, 0, Math.PI * 2)
    ctx.stroke()
  } else {
    if (glow > 0) {
      const g = ctx.createRadialGradient(c, c, r * 0.6, c, c, c)
      g.addColorStop(0, rgba(color, 0.22 * glow))
      g.addColorStop(1, rgba(color, 0))
      ctx.fillStyle = g
      ctx.fillRect(0, 0, px, px)
    }
    const core = ctx.createRadialGradient(c, c, 0, c, c, r)
    core.addColorStop(0, mixHex(color, '#fff3e0', 0.55))
    core.addColorStop(0.55, color)
    core.addColorStop(1, rgba(color, 0.9))
    ctx.fillStyle = core
    ctx.beginPath()
    ctx.arc(c, c, r, 0, Math.PI * 2)
    ctx.fill()
  }
  spriteCache.set(key, canvas)
  return canvas
}

/* ----------------------------------------------------------------- picking */

type Hit = { kind: 'facility'; point: PointDatum } | { kind: 'flow'; arc: ArcDatum }

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
  return Math.hypot(ax + t * dx - px, ay + t * dy - py)
}

function countryName(countries: Record<string, Country>, iso3: string): string {
  return countries[iso3]?.name ?? iso3
}

/* -------------------------------------------------------------- component */

export function MapCanvas({
  points,
  arcs,
  countries,
  selectedId,
  externalHoverId,
  focusCountry,
  centralMeridian,
  insetRight,
  reducedMotion,
  onSelectPoint,
  onSelectArc,
  onSelectCountry,
  onClearSelection,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [hover, setHover] = useState<{ hit: Hit; x: number; y: number } | null>(null)
  const [hoverCountry, setHoverCountry] = useState<string | null>(null)
  const [pointer, setPointer] = useState<{ lat: number; lng: number } | null>(null)
  const [readout, setReadout] = useState<{ lat: number; lng: number; k: number } | null>(null)
  const [cursor, setCursor] = useState(0)
  const [keyboardActive, setKeyboardActive] = useState(false)

  const viewRef = useRef<View>({ k: 1, x: 0, y: 0 })
  const staticRef = useRef<{ canvas: HTMLCanvasElement; view: View } | null>(null)
  const arcGeomRef = useRef<ArcGeom[]>([])
  const flightRef = useRef<number>(0)
  const settleRef = useRef<number>(0)
  const lastReportRef = useRef(0)

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      setSize({ width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const dpr = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 2)
  const small = size.width < 640

  const fitted = useMemo<Fitted | null>(
    () => (size.width > 0 ? fitProjection(size.width, size.height, centralMeridian, small ? 8 : 28) : null),
    [size.width, size.height, centralMeridian, small],
  )

  /** The part of the screen not covered by a panel. */
  const visible = useMemo<Rect>(
    () => ({ left: 0, top: 0, right: Math.max(200, size.width - insetRight), bottom: size.height }),
    [size.width, size.height, insetRight],
  )
  const visibleCentre = useMemo(
    () => ({ x: (visible.left + visible.right) / 2, y: (visible.top + visible.bottom) / 2 }),
    [visible],
  )
  /** The map's extent in base coordinates: fitted and centred in the full canvas. */
  const mapRect = useMemo<Rect | null>(() => {
    if (!fitted) return null
    const left = (size.width - fitted.mapW) / 2
    const top = (size.height - fitted.mapH) / 2
    return { left, top, right: left + fitted.mapW, bottom: top + fitted.mapH }
  }, [fitted, size.width, size.height])

  /** Base-map position of a lat/lng (zoom 1). */
  const project = useCallback(
    (lat: number, lng: number): Pt | null => {
      const p = fitted?.projection([lng, lat])
      return p ? { x: p[0], y: p[1] } : null
    },
    [fitted],
  )

  /** Screen position to lat/lng, or null off the map. */
  const unproject = useCallback(
    (x: number, y: number): { lat: number; lng: number } | null => {
      if (!fitted) return null
      const v = viewRef.current
      const ll = fitted.projection.invert?.([(x - v.x) / v.k, (y - v.y) / v.k])
      if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) return null
      // Invert happily returns points outside the sphere's outline; reject them.
      const back = fitted.projection(ll)
      if (!back || Math.hypot(back[0] - (x - v.x) / v.k, back[1] - (y - v.y) / v.k) > 0.5) return null
      return { lat: ll[1], lng: ll[0] }
    },
    [fitted],
  )

  /* ------------------------------------------------------- static layer */

  const renderStatic = useCallback(() => {
    if (!fitted || size.width === 0) return
    const v = { ...viewRef.current }
    const w = Math.round(size.width * dpr)
    const h = Math.round(size.height * dpr)
    const canvas = staticRef.current?.canvas ?? document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    const path = geoPath(fitted.projection, ctx)
    const toView = () => ctx.setTransform(dpr * v.k, 0, 0, dpr * v.k, dpr * v.x, dpr * v.y)

    ctx.clearRect(0, 0, w, h)
    toView()
    ctx.beginPath()
    path(SPHERE)
    ctx.fillStyle = SPHERE_FILL
    ctx.fill()

    ctx.beginPath()
    path(GRATICULE_LINES)
    ctx.strokeStyle = GRATICULE
    ctx.lineWidth = 1 / v.k
    ctx.stroke()

    ctx.beginPath()
    path(LAND)
    ctx.fillStyle = LAND_UNDERFILL
    ctx.fill()

    // Dot-matrix land on an even screen-space grid at any zoom, sampled from
    // a land mask drawn with the same transform.
    const mask = document.createElement('canvas')
    mask.width = w
    mask.height = h
    const mctx = mask.getContext('2d', { willReadFrequently: true })!
    mctx.setTransform(dpr * v.k, 0, 0, dpr * v.k, dpr * v.x, dpr * v.y)
    mctx.beginPath()
    geoPath(fitted.projection, mctx)(LAND)
    mctx.fillStyle = '#fff'
    mctx.fill()
    const data = mctx.getImageData(0, 0, w, h).data
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = LAND_DOT
    const spacing = 4.4 * dpr
    const radius = 1.05 * dpr
    for (let row = 0, y = spacing / 2; y < h; y += spacing, row++) {
      for (let x = spacing / 2 + (row % 2 ? spacing / 2 : 0); x < w; x += spacing) {
        if (data[(Math.floor(y) * w + Math.floor(x)) * 4]! < 128) continue
        ctx.beginPath()
        ctx.arc(x, y, radius, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    toView()
    ctx.beginPath()
    path(BORDERS)
    ctx.strokeStyle = BORDER
    ctx.lineWidth = 0.6 / v.k
    ctx.stroke()

    // The map's edge glows like the globe's rim.
    ctx.beginPath()
    path(SPHERE)
    ctx.shadowColor = 'rgba(76, 195, 224, 0.6)'
    ctx.shadowBlur = 14 * dpr
    ctx.strokeStyle = SPHERE_EDGE
    ctx.lineWidth = 1.2 / v.k
    ctx.stroke()
    ctx.shadowBlur = 0

    staticRef.current = { canvas, view: v }
  }, [fitted, size.width, size.height, dpr])


  /* ------------------------------------------------------------ the view */

  const reportView = useCallback(() => {
    const { width, height } = size
    const c = unproject(width / 2, height / 2)
    setReadout(c ? { lat: c.lat, lng: c.lng, k: viewRef.current.k } : { lat: 0, lng: centralMeridian, k: viewRef.current.k })
  }, [size, unproject, centralMeridian])

  /** Apply a view, clamped, and schedule a crisp static re-render once it settles. */
  const setView = useCallback(
    (next: View) => {
      if (!mapRect) return
      viewRef.current = clampView(next, visible, mapRect)
      // The readout follows a move about ten times a second, and settles exactly.
      const now = performance.now()
      if (now - lastReportRef.current > 100) {
        lastReportRef.current = now
        reportView()
      }
      window.clearTimeout(settleRef.current)
      settleRef.current = window.setTimeout(() => {
        renderStatic()
        reportView()
      }, 140)
    },
    [mapRect, visible, reportView, renderStatic],
  )

  /** Animate to a view; any user input cancels it. */
  const flyTo = useCallback(
    (target: View, ms = 700) => {
      cancelAnimationFrame(flightRef.current)
      if (reducedMotion || ms === 0) return setView(target)
      const from = { ...viewRef.current }
      const start = performance.now()
      const step = () => {
        const t = Math.min(1, (performance.now() - start) / ms)
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
        // Interpolate zoom geometrically so it feels even, translation linearly.
        const k = from.k * Math.pow(target.k / from.k, e)
        setView({ k, x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e })
        if (t < 1) flightRef.current = requestAnimationFrame(step)
      }
      flightRef.current = requestAnimationFrame(step)
    },
    [reducedMotion, setView],
  )

  const homeView = useCallback((): View => {
    if (!fitted) return { k: 1, x: 0, y: 0 }
    // A phone in portrait gets a closer start, so the map is not a thin strip.
    const k = Math.min(MAX_ZOOM, Math.max(1, (size.height * 0.42) / fitted.mapH))
    return centreOn({ x: size.width / 2, y: size.height / 2 }, k, visibleCentre)
  }, [fitted, size.width, size.height, visibleCentre])

  /* First fit, and a refit that keeps the centre when the viewport changes. */
  const fittedOnceRef = useRef(false)
  useEffect(() => {
    if (!fitted || !mapRect) return
    if (!fittedOnceRef.current) {
      fittedOnceRef.current = true
      viewRef.current = clampView(homeView(), visible, mapRect)
    } else {
      viewRef.current = clampView(viewRef.current, visible, mapRect)
    }
    renderStatic()
    reportView()
    // Only when the canvas itself changes; panels opening are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitted, mapRect])

  /* A panel opening or closing re-clamps the view smoothly, so content slides clear of it. */
  const insetRef = useRef(insetRight)
  useEffect(() => {
    if (insetRef.current === insetRight || !mapRect) return
    insetRef.current = insetRight
    flyTo(clampView(viewRef.current, visible, mapRect), 450)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insetRight])

  /* --------------------------------------------------------- arc models */

  useEffect(() => {
    if (!fitted) return
    const now = performance.now()
    const previous = new Map(arcGeomRef.current.map((g) => [g.arc.id, g]))
    arcGeomRef.current = arcs.flatMap((arc, i) => {
      const a = project(arc.startLat, arc.startLng)
      const b = project(arc.endLat, arc.endLng)
      if (!a || !b) return []
      const old = previous.get(arc.id)
      return [
        {
          arc,
          a,
          b,
          c: bowControl(a, b),
          phase: old?.phase ?? Math.random(),
          // Arcs already on screen stay drawn; new ones grow in, largest first.
          startsAt: reducedMotion || old ? 0 : now + (arcs.length > 1 ? (i / (arcs.length - 1)) * ARC_STAGGER_MS : 0),
          hi: old?.hi ?? 0,
          dim: old?.dim ?? 0,
        },
      ]
    })
  }, [arcs, fitted, project, reducedMotion])

  const pointPositions = useMemo(
    () => points.map((p) => project(p.lat, p.lng)),
    [points, project],
  )

  /** The ten largest import destinations, for landing pulses. */
  const pulses = useMemo(() => {
    const byDest = new Map<string, { lat: number; lng: number; usd: number }>()
    for (const arc of arcs) {
      const e = byDest.get(arc.flow.to_iso3) ?? { lat: arc.endLat, lng: arc.endLng, usd: 0 }
      e.usd += arc.value.usd ?? 0
      byDest.set(arc.flow.to_iso3, e)
    }
    const top = [...byDest.values()].sort((a, b) => b.usd - a.usd).slice(0, 10)
    const max = top[0]?.usd ?? 0
    return top.flatMap((d, i) => {
      const p = project(d.lat, d.lng)
      return p ? [{ p, weight: max > 0 ? Math.sqrt(d.usd / max) : 0, phase: i / top.length }] : []
    })
  }, [arcs, project])

  /* --------------------------------------------------------- keyboard */

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
    keyboardActive && current !== undefined ? (current.kind === 'facility' ? current.point.id : current.arc.id) : null
  const hoverId = hover === null ? null : hover.hit.kind === 'facility' ? hover.hit.point.id : hover.hit.arc.id

  /* ---------------------------------------------------- draw every frame */

  // The frame loop reads the latest props through a ref, so it never restarts.
  const frameState = useRef({
    points,
    pointPositions,
    pulses,
    selectedId,
    hoverId,
    externalHoverId,
    cursorId,
    focusCountry,
    hoverCountry,
  })
  useEffect(() => {
    frameState.current = {
      points,
      pointPositions,
      pulses,
      selectedId,
      hoverId,
      externalHoverId,
      cursorId,
      focusCountry,
      hoverCountry,
    }
  }, [points, pointPositions, pulses, selectedId, hoverId, externalHoverId, cursorId, focusCountry, hoverCountry])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !fitted || size.width === 0) return
    canvas.width = Math.round(size.width * dpr)
    canvas.height = Math.round(size.height * dpr)
    const ctx = canvas.getContext('2d')!
    const path = geoPath(fitted.projection, ctx)
    let raf = 0

    const draw = () => {
      const now = performance.now()
      const seconds = now / 1000
      const v = viewRef.current
      const s = frameState.current
      const isHi = (id: string) =>
        id === s.selectedId || id === s.hoverId || id === s.externalHoverId || id === s.cursorId
      const toScreen = (p: Pt) => ({ x: p.x * v.k + v.x, y: p.y * v.k + v.y })
      const zoomWidth = 1 + 0.28 * Math.log2(v.k)

      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      // Static layer, shifted and scaled from the view it was rendered at.
      const cached = staticRef.current
      if (cached) {
        const f = v.k / cached.view.k
        ctx.setTransform(f, 0, 0, f, dpr * (v.x - cached.view.x * f), dpr * (v.y - cached.view.y * f))
        ctx.drawImage(cached.canvas, 0, 0)
      }

      // Hovered and focused countries get a faint fill.
      ctx.setTransform(dpr * v.k, 0, 0, dpr * v.k, dpr * v.x, dpr * v.y)
      for (const [iso3, alpha] of [
        [s.focusCountry, 0.12],
        [s.hoverCountry !== s.focusCountry ? s.hoverCountry : null, 0.07],
      ] as const) {
        const geom = iso3 ? COUNTRY_GEOMETRY.get(iso3) : undefined
        if (!geom) continue
        ctx.beginPath()
        path(geom)
        ctx.fillStyle = rgba(ACCENT, alpha)
        ctx.fill()
        ctx.strokeStyle = rgba(ACCENT, alpha * 3)
        ctx.lineWidth = 0.8 / v.k
        ctx.stroke()
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.lineCap = 'round'

      // Arcs: halo, then core, then comet.
      for (const g of arcGeomRef.current) {
        const hiTarget = isHi(g.arc.id) ? 1 : 0
        const dimTarget = s.selectedId !== null && hiTarget === 0 ? 1 : 0
        g.hi += (hiTarget - g.hi) * (reducedMotion ? 1 : STATE_EASE)
        g.dim += (dimTarget - g.dim) * (reducedMotion ? 1 : STATE_EASE)
        const t = g.startsAt === 0 ? 1 : Math.min(1, Math.max(0, (now - g.startsAt) / ARC_GROW_MS))
        if (t <= 0) continue
        const grow = 1 - Math.pow(1 - t, 3)
        const a = toScreen(g.a)
        const c = toScreen(g.c)
        const b = toScreen(g.b)
        const [sa, sc, sb] = grow >= 1 ? [a, c, b] : subQuad(a, c, b, 0, grow)
        const low = g.arc.confidence === 'low'
        const dimF = 1 - 0.85 * g.dim
        const width = Math.max(0.7, g.arc.width * 1.6) * zoomWidth

        const curve = () => {
          ctx.beginPath()
          ctx.moveTo(sa.x, sa.y)
          ctx.quadraticCurveTo(sc.x, sc.y, sb.x, sb.y)
        }

        if (!low) {
          ctx.globalCompositeOperation = 'lighter'
          curve()
          ctx.strokeStyle = rgba(g.hi > 0.5 ? ACCENT : g.arc.color, (0.05 + 0.12 * g.arc.weight + 0.15 * g.hi) * dimF)
          ctx.lineWidth = width * 5
          ctx.stroke()
          ctx.globalCompositeOperation = 'source-over'
        }

        const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
        const base = g.arc.color
        const end = mixHex(base, '#ffdcaa', 0.5)
        const alpha = (low ? 0.4 : 0.45 + 0.5 * g.arc.weight) * dimF
        grad.addColorStop(0, rgba(mixHex(base, '#000000', 0.5), alpha))
        grad.addColorStop(1, rgba(end, alpha))
        curve()
        ctx.setLineDash(low ? [3, 4] : [])
        ctx.strokeStyle = g.hi > 0.02 ? rgba(ACCENT, Math.max(alpha, g.hi)) : grad
        if (g.hi > 0.02 && g.hi < 0.98) {
          // Mid-ease: draw the gradient and lay the accent over it.
          ctx.strokeStyle = grad
          ctx.lineWidth = width
          ctx.stroke()
          ctx.strokeStyle = rgba(ACCENT, g.hi)
        }
        ctx.lineWidth = width * (1 + 0.4 * g.hi)
        ctx.stroke()
        ctx.setLineDash([])

        if (!low && !reducedMotion && grow >= 1) {
          const head = (seconds * COMET_SPEED + g.phase) % 1
          const t0 = Math.max(0, head - COMET_TAIL)
          if (head > 0.01) {
            const [ca, cc, cb] = subQuad(a, c, b, t0, head)
            const cg = ctx.createLinearGradient(ca.x, ca.y, cb.x, cb.y)
            cg.addColorStop(0, `rgba(${COMET}, 0)`)
            cg.addColorStop(1, `rgba(${COMET}, ${0.85 * dimF})`)
            ctx.beginPath()
            ctx.moveTo(ca.x, ca.y)
            ctx.quadraticCurveTo(cc.x, cc.y, cb.x, cb.y)
            ctx.strokeStyle = cg
            ctx.lineWidth = width * 1.3
            ctx.stroke()
          }
        }
      }

      // Landing pulses at the largest import hubs.
      if (!reducedMotion) {
        for (const pulse of s.pulses) {
          const p = toScreen(pulse.p)
          const t = (seconds * 0.38 + pulse.phase) % 1
          const r = (6 + (18 + 26 * pulse.weight) * t) * Math.sqrt(zoomWidth)
          ctx.beginPath()
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(${PULSE}, ${(1 - t) * (0.3 + 0.4 * pulse.weight)})`
          ctx.lineWidth = 1.2
          ctx.stroke()
        }
      }

      // Sites, mines first so smelters and refineries sit on top.
      const pointScale = POINT_SIZE * (1 + 0.15 * Math.log2(v.k))
      for (const pass of ['mine', 'process', 'refine'] as const) {
        for (let i = 0; i < s.points.length; i++) {
          const p = s.points[i]!
          if (p.stage !== pass) continue
          const pos = s.pointPositions[i]
          if (!pos) continue
          const sp = toScreen(pos)
          if (sp.x < -20 || sp.y < -20 || sp.x > size.width + 20 || sp.y > size.height + 20) continue
          const hi = isHi(p.id)
          const dim =
            !hi &&
            (s.selectedId !== null ||
              (s.focusCountry !== null && p.facility.properties.country_iso3 !== s.focusCountry))
          const sz = p.size * pointScale * (hi ? 1.5 : 1)
          const img = sprite(p.color, sz, p.confidence === 'low', p.stage === 'mine' ? 0.25 : p.stage === 'process' ? 0.8 : 1, dpr)
          ctx.globalAlpha = dim ? 0.16 : 1
          const d = img.width / dpr
          ctx.drawImage(img, sp.x - d / 2, sp.y - d / 2, d, d)
          ctx.globalAlpha = 1
          if (hi) {
            ctx.beginPath()
            ctx.arc(sp.x, sp.y, sz * 0.95, 0, Math.PI * 2)
            ctx.strokeStyle = ACCENT
            ctx.lineWidth = 1.4
            ctx.stroke()
          }
        }
      }

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [fitted, size.width, size.height, dpr, reducedMotion])

  /* ------------------------------------------------------------ picking */

  const pick = useCallback(
    (x: number, y: number): Hit | null => {
      const v = viewRef.current
      const pointScale = POINT_SIZE * (1 + 0.15 * Math.log2(v.k))
      let best: Hit | null = null
      let bestDist = Infinity
      points.forEach((p, i) => {
        const pos = pointPositions[i]
        if (!pos) return
        const d = Math.hypot(pos.x * v.k + v.x - x, pos.y * v.k + v.y - y)
        if (d < Math.max(7, (p.size * pointScale) / 2 + 3) && d < bestDist) {
          bestDist = d
          best = { kind: 'facility', point: p }
        }
      })
      if (best) return best
      for (const g of arcGeomRef.current) {
        const a = { x: g.a.x * v.k + v.x, y: g.a.y * v.k + v.y }
        const c = { x: g.c.x * v.k + v.x, y: g.c.y * v.k + v.y }
        const b = { x: g.b.x * v.k + v.x, y: g.b.y * v.k + v.y }
        let prev = a
        for (let i = 1; i <= PICK_SAMPLES; i++) {
          const q = quadAt(a, c, b, i / PICK_SAMPLES)
          const d = distToSegment(x, y, prev.x, prev.y, q.x, q.y)
          if (d < 6 + g.arc.width * 2 && d < bestDist) {
            bestDist = d
            best = { kind: 'flow', arc: g.arc }
          }
          prev = q
        }
      }
      return best
    },
    [points, pointPositions],
  )

  /* --------------------------------------------------------- flights */

  const zoomBy = useCallback(
    (factor: number, at?: Pt) => {
      cancelAnimationFrame(flightRef.current)
      const p = at ?? { x: size.width / 2, y: size.height / 2 }
      flyTo(zoomAbout(viewRef.current, factor, p), 320)
    },
    [flyTo, size.width, size.height],
  )

  const goHome = useCallback(() => flyTo(homeView(), 700), [flyTo, homeView])

  /** Centre a base-map point at the current zoom. */
  const centreBase = useCallback(
    (p: Pt) => flyTo(centreOn(p, viewRef.current.k, visibleCentre), 800),
    [flyTo, visibleCentre],
  )

  /* A country focused from search or a link is centred; one clicked is left where it is. */
  const clickedCountryRef = useRef<string | null>(null)
  useEffect(() => {
    if (focusCountry === null) return
    if (clickedCountryRef.current === focusCountry) {
      clickedCountryRef.current = null
      return
    }
    clickedCountryRef.current = null
    const c = countries[focusCountry]
    const home = c ? project(c.lat, c.lon) : null
    if (!home) return
    // Fit the country and the far ends of its drawn flows into the visible area.
    const ends = arcGeomRef.current.flatMap((g) =>
      g.arc.flow.from_iso3 === focusCountry ? [g.b, g.c] : g.arc.flow.to_iso3 === focusCountry ? [g.a, g.c] : [],
    )
    const fit = fitPoints([home, ...ends], visible, 70, 2.5)
    // The country itself must end up clear of the panel, even if that pushes
    // some far-flung partners off screen.
    if (fit && mapRect) flyTo(clampView(keepInView(clampView(fit, visible, mapRect), home, visible), visible, mapRect), 900)
    // The arcs are read once per focus, not re-fitted when a layer toggles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusCountry, countries, project])

  /* A flow picked from the list: bring both ends into view if they are not already. */
  useEffect(() => {
    if (selectedId === null || selectedId !== externalHoverId) return
    const g = arcGeomRef.current.find((x) => x.arc.id === selectedId)
    if (!g) return
    const v = viewRef.current
    const inView = (p: Pt) => {
      const sx = p.x * v.k + v.x
      const sy = p.y * v.k + v.y
      return sx > visible.left + 40 && sy > 40 && sx < visible.right - 40 && sy < size.height - 40
    }
    if (inView(g.a) && inView(g.b)) return
    const target = fitPoints([g.a, g.b, quadAt(g.a, g.c, g.b, 0.5)], visible, 80, v.k)
    if (target) flyTo(target, 800)
    // Only on a new selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  /* Keyboard cursor: keep it on screen at the current zoom. */
  useEffect(() => {
    if (!keyboardActive || current === undefined) return
    const p =
      current.kind === 'facility'
        ? project(current.point.lat, current.point.lng)
        : project(current.arc.startLat, current.arc.startLng)
    if (p) centreBase(p)
  }, [current, keyboardActive, project, centreBase])

  /* ------------------------------------------------------- pointer input */

  /**
   * Drag pans with a short glide, wheel and pinch zoom about the pointer, a
   * double tap zooms in, and a tap selects. The same tap rules as the globe
   * (cameraDynamics.ts): quick, still and single-pointer, and a tap on land
   * waits out the double-tap window before focusing a country.
   */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !fitted) return
    const active = new Map<number, Pt>()
    let gesture: { start: Pt; at: number; maxPointers: number; moved: number } | null = null
    let lastTap: { at: number; x: number; y: number } | null = null
    let pendingTap = 0
    let pinch: { dist: number; mid: Pt } | null = null
    let velocity = { x: 0, y: 0, at: 0 }
    let glide = 0
    let frame = 0
    let last: PointerEvent | null = null

    const local = (e: PointerEvent | WheelEvent): Pt => {
      const r = canvas.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }

    const runHover = () => {
      frame = 0
      if (!last || active.size > 0) return
      const p = local(last)
      const hit = pick(p.x, p.y)
      setHover(hit ? { hit, x: p.x, y: p.y } : null)
      const ll = unproject(p.x, p.y)
      setPointer(ll)
      const shape = !hit && ll ? countryAt(ll.lat, ll.lng) : null
      const known = shape?.iso3 && shape.iso3 in countries ? shape.iso3 : null
      setHoverCountry(known)
      canvas.style.cursor = hit || known ? 'pointer' : 'grab'
    }

    const onDown = (e: PointerEvent) => {
      cancelAnimationFrame(flightRef.current)
      cancelAnimationFrame(glide)
      canvas.setPointerCapture(e.pointerId)
      const p = local(e)
      active.set(e.pointerId, p)
      if (gesture) gesture.maxPointers = Math.max(gesture.maxPointers, active.size)
      else gesture = { start: p, at: performance.now(), maxPointers: 1, moved: 0 }
      if (active.size === 2) {
        const [p1, p2] = [...active.values()] as [Pt, Pt]
        pinch = { dist: Math.hypot(p1.x - p2.x, p1.y - p2.y), mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 } }
      }
      velocity = { x: 0, y: 0, at: performance.now() }
      setHover(null)
      canvas.style.cursor = 'grabbing'
    }

    const onMove = (e: PointerEvent) => {
      const prev = active.get(e.pointerId)
      if (!prev) {
        last = e
        if (!frame) frame = requestAnimationFrame(runHover)
        return
      }
      const p = local(e)
      active.set(e.pointerId, p)
      if (gesture) gesture.moved = Math.max(gesture.moved, Math.hypot(p.x - gesture.start.x, p.y - gesture.start.y))
      const v = viewRef.current
      if (active.size >= 2 && pinch) {
        const [p1, p2] = [...active.values()] as [Pt, Pt]
        const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y)
        const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
        const zoomed = zoomAbout(v, dist / pinch.dist, pinch.mid)
        setView({ ...zoomed, x: zoomed.x + mid.x - pinch.mid.x, y: zoomed.y + mid.y - pinch.mid.y })
        pinch = { dist, mid }
        return
      }
      const dx = p.x - prev.x
      const dy = p.y - prev.y
      setView({ ...v, x: v.x + dx, y: v.y + dy })
      const now = performance.now()
      const dt = Math.max(1, now - velocity.at)
      velocity = { x: (dx / dt) * 16, y: (dy / dt) * 16, at: now }
    }

    const release = (e: PointerEvent) => {
      if (!active.has(e.pointerId)) return null
      active.delete(e.pointerId)
      if (active.size < 2) pinch = null
      if (active.size > 0) return null
      canvas.style.cursor = 'grab'
      const g = gesture
      gesture = null
      return g
    }

    const onUp = (e: PointerEvent) => {
      const g = release(e)
      if (!g) return
      const p = local(e)
      const now = performance.now()
      if (!isTap({ durationMs: now - g.at, movedPx: g.moved, maxPointers: g.maxPointers })) {
        lastTap = null
        // A short glide after a flick, unless the pointer had stopped.
        if (!reducedMotion && now - velocity.at < 60 && Math.hypot(velocity.x, velocity.y) > 1) {
          let vx = velocity.x
          let vy = velocity.y
          const step = () => {
            vx *= 0.9
            vy *= 0.9
            const v = viewRef.current
            setView({ ...v, x: v.x + vx, y: v.y + vy })
            if (Math.hypot(vx, vy) > 0.3) glide = requestAnimationFrame(step)
          }
          glide = requestAnimationFrame(step)
        }
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
        const ll = unproject(p.x, p.y)
        const shape = ll ? countryAt(ll.lat, ll.lng) : null
        if (shape?.iso3 && shape.iso3 in countries) {
          clickedCountryRef.current = shape.iso3
          onSelectCountry(shape.iso3)
        } else {
          onClearSelection()
        }
      }, DOUBLE_TAP_MS)
    }

    const onCancel = (e: PointerEvent) => {
      release(e)
      lastTap = null
    }
    const onLeave = () => {
      last = null
      setHover(null)
      setPointer(null)
      setHoverCountry(null)
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      cancelAnimationFrame(flightRef.current)
      const scale = e.deltaMode === 1 ? 16 : 1
      setView(zoomAbout(viewRef.current, Math.exp(-e.deltaY * scale * 0.0018), local(e)))
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onCancel)
    canvas.addEventListener('pointerleave', onLeave)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(glide)
      window.clearTimeout(pendingTap)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onCancel)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [fitted, pick, unproject, countries, setView, zoomBy, reducedMotion, onSelectPoint, onSelectArc, onSelectCountry, onClearSelection])

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
    [walk, current, zoomBy, goHome, onSelectPoint, onSelectArc, onClearSelection],
  )

  /* -------------------------------------------------------------- render */

  return (
    <div
      ref={containerRef}
      role="application"
      aria-label="Map. Drag to pan, scroll or pinch to zoom, double-click to zoom in, click a flow, site or country. With the keyboard, arrow keys move between flows and sites, Enter opens one, plus and minus zoom, zero resets the view."
      tabIndex={0}
      onKeyDown={onKeyDown}
      onBlur={() => setKeyboardActive(false)}
      className="relative h-full w-full overflow-hidden"
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        style={{ touchAction: 'none', cursor: 'grab' }}
      />

      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <span className="hud-corner top-3 left-3 border-t border-l" />
        <span className="hud-corner top-3 right-3 border-t border-r" />
        <span className="hud-corner bottom-3 left-3 border-b border-l" />
        <span className="hud-corner right-3 bottom-3 border-r border-b" />
        <div className="hud-label absolute top-5 left-6 hidden flex-col gap-0.5 sm:flex">
          <span>
            <span className="text-muted">VIEW </span>
            <span className="text-dim">{readout ? formatLatLng(readout.lat, readout.lng, 1) : '—'}</span>
          </span>
          <span>
            <span className="text-muted">ZOOM </span>
            <span className="text-dim">{readout ? readout.k.toFixed(1) + '×' : '—'}</span>
          </span>
        </div>
        <div className="hud-label absolute right-6 bottom-5 hidden text-right sm:block">
          {pointer ? (
            <>
              <span className="text-dim">{formatLatLng(pointer.lat, pointer.lng)}</span>
              {hoverCountry && (
                <span className="ml-2 text-accent">{countryName(countries, hoverCountry).toUpperCase()}</span>
              )}
            </>
          ) : (
            <span className="text-muted">DRAG · SCROLL · DOUBLE-CLICK</span>
          )}
        </div>
      </div>

      <MapButtons onZoomIn={() => zoomBy(ZOOM_STEP)} onZoomOut={() => zoomBy(1 / ZOOM_STEP)} onHome={goHome} />

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

/* ------------------------------------------------------------- overlays */

function MapButtons({ onZoomIn, onZoomOut, onHome }: { onZoomIn: () => void; onZoomOut: () => void; onHome: () => void }) {
  const cls =
    'flex h-8 w-8 items-center justify-center border-b border-line-strong text-dim last:border-b-0 hover:bg-accent/10 hover:text-accent'
  return (
    <div className="panel absolute top-5 left-5 z-10 flex flex-col sm:top-16 sm:left-6" role="group" aria-label="Map view">
      <button type="button" onClick={onZoomIn} className={cls} aria-label="Zoom in" title="Zoom in (+)">
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12">
          <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
      <button type="button" onClick={onZoomOut} className={cls} aria-label="Zoom out" title="Zoom out (−)">
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12">
          <path d="M1 6h10" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
      <button type="button" onClick={onHome} className={cls} aria-label="Reset view" title="Reset view (0)">
        <svg aria-hidden="true" width="13" height="13" viewBox="0 0 13 13">
          <rect x="1.5" y="3" width="10" height="7" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M1.5 6.5h10M6.5 3v7" stroke="currentColor" strokeWidth="0.8" />
        </svg>
      </button>
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
  const flip = x > width - 260
  const style = flip ? { right: width - x + 14, top: y + 14 } : { left: x + 14, top: y + 14 }
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
          <p className="hud-label text-muted">SITE · {STAGE_LABEL_SINGULAR[hit.point.stage].toUpperCase()}</p>
          <p className="mt-0.5 text-sm text-ink">{hit.point.facility.properties.name}</p>
          <p className="mt-0.5 text-xs text-dim">{countryName(countries, hit.point.facility.properties.country_iso3)}</p>
          {hit.point.confidence === 'low' && <p className="mt-1 text-2xs text-alert">Low confidence location</p>}
        </>
      )}
    </div>
  )
}
