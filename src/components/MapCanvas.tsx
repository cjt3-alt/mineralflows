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
  ZOOM_STEP,
  bowControl,
  centreOn,
  clampWrapView,
  copyOffsets,
  fitPoints,
  keepInView,
  nearestRepeat,
  quadAt,
  shortWay,
  wrapLng,
  zoomAbout,
  type Pt,
  type Rect,
  type View,
} from './mapDynamics.ts'

/**
 * The flat map: the same data, marks and interactions as the globe, drawn on
 * a 2D canvas in the Mercator projection, the one web maps use, so it reads
 * like the map everyone already knows. Like a web map it fills its panel top
 * to bottom and repeats east–west: drag far enough and you come back round,
 * and a flow that crosses the map's edge takes the short way across it. The map is cut where the least traded value crosses
 * (see `chooseSeam`), which for copper puts the Pacific in the middle.
 *
 * Two layers. A static layer — ocean, graticule, dot-matrix land, borders —
 * is rendered to an offscreen canvas with a margin around the viewport, only
 * when the view settles or a pan runs past the margin; in between it is
 * reused, shifted and scaled, so dragging costs one bitmap copy. A dynamic
 * layer — arcs, comets, landing pulses, sites, highlights — is redrawn every
 * frame on top.
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
  /** Which terrain layers to draw under the data. */
  terrainLayers: TerrainLayers
  reducedMotion: boolean
  onSelectPoint: (point: PointDatum) => void
  onSelectArc: (arc: ArcDatum) => void
  onSelectCountry: (iso3: string) => void
  onClearSelection: () => void
}

/* ------------------------------------------------------------------ palette */

const ACCENT = '#5ad8f0'
/** Shown only until the relief image arrives, or with relief switched off. */
const OCEAN_FILL = 'rgba(9, 17, 27, 0.75)'
const GRATICULE = 'rgba(90, 216, 240, 0.06)'
const LAND_UNDERFILL = 'rgba(14, 30, 44, 0.9)'
const RANGE_LABEL = 'rgba(176, 205, 228, 0.42)'
/**
 * Borders are engraved into the dot matrix: a narrow channel is cleared along
 * each one, and a crisp hairline runs down its middle. Coastlines get a softer
 * line of their own, so land reads as shapes and countries as countries.
 */
const BORDER = 'rgba(150, 196, 226, 0.62)'
const BORDER_CHANNEL_PX = 3.4
const BORDER_WIDTH_PX = 0.85
const COASTLINE = 'rgba(110, 170, 205, 0.4)'
const COASTLINE_WIDTH_PX = 0.8
const COMET = '255, 244, 225'
const PULSE = '255, 201, 138'

/* ---------------------------------------------------------------- geometry */

const topology = countriesTopology as unknown as Topology
interface Outlines {
  land: GeoPermissibleObjects
  borders: GeoPermissibleObjects
}

function outlinesOf(t: Topology): Outlines {
  return {
    land: feature(t, t.objects.land!) as unknown as GeoPermissibleObjects,
    borders: mesh(t, t.objects.countries as never, (a, b) => a !== b) as unknown as GeoPermissibleObjects,
  }
}

/** Natural Earth 1:110m: bundled, and plenty at world scale. */
const OUTLINES = outlinesOf(topology)

/**
 * Natural Earth 1:50m, for borders that stay smooth when zoomed in. About
 * 236 kB compressed, so it is fetched only the first time someone zooms past
 * `DETAIL_ZOOM`, as its own chunk, never on first paint.
 */
const DETAIL_ZOOM = 2
let detailOutlines: Outlines | null = null
let detailRequest: Promise<Outlines> | null = null

function loadDetailOutlines(): Promise<Outlines> {
  detailRequest ??= import('world-atlas/countries-50m.json').then((m) => {
    detailOutlines = outlinesOf((m.default ?? m) as unknown as Topology)
    return detailOutlines
  })
  return detailRequest
}
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
 * web maps are. The crop is what fills the panel's height at zoom 1.
 */
const LAT_TOP = 80
const LAT_BOTTOM = -58

interface Fitted {
  projection: GeoProjection
  /** Pixels per radian. */
  s: number
  /** Screen position of the central meridian and the equator at zoom 1. */
  tx: number
  ty: number
  /** One world's width at zoom 1; the map repeats every `mapW`. */
  mapW: number
  centralMeridian: number
}

/** Fit by height: the cropped world exactly fills the panel top to bottom. */
function fitProjection(width: number, height: number, centralMeridian: number): Fitted {
  const unit = geoMercator().rotate([-centralMeridian, 0]).scale(1).translate([0, 0])
  const top = unit([centralMeridian, LAT_TOP])![1]
  const bottom = unit([centralMeridian, LAT_BOTTOM])![1]
  const s = height / (bottom - top)
  const tx = width / 2
  const ty = -s * top
  const projection = geoMercator()
    .rotate([-centralMeridian, 0])
    .scale(s)
    .translate([tx, ty])
    .clipExtent([
      [tx - Math.PI * s, 0],
      [tx + Math.PI * s, height],
    ])
  return { projection, s, tx, ty, mapW: 2 * Math.PI * s, centralMeridian }
}

/* --------------------------------------------------------------- terrain */

/**
 * The terrain base map, built offline by tools/build_basemap.py into
 * public/basemap/: a shaded-relief image (land and sea floor) already in Web
 * Mercator, and named mountain ranges. Both
 * load after first paint; until the relief arrives the map draws flat land.
 */
export interface TerrainLayers {
  relief: boolean
  ranges: boolean
}

interface Terrain {
  relief: HTMLImageElement | null
  ranges: { name: string; rank: number; lng: number; lat: number }[]
}

const terrain: Terrain = { relief: null, ranges: [] }
let terrainRequest: Promise<void> | null = null

function basemapUrl(file: string): string {
  const base = import.meta.env.BASE_URL
  return (base.endsWith('/') ? base : base + '/') + 'basemap/' + file
}

function loadTerrain(): Promise<void> {
  terrainRequest ??= Promise.all([
    new Promise<void>((resolve) => {
      const img = new Image()
      img.onload = () => {
        terrain.relief = img
        resolve()
      }
      // Without relief the map still works on flat land; nothing to report.
      img.onerror = () => resolve()
      img.src = basemapUrl('relief.webp')
    }),
    fetch(basemapUrl('ranges.json'))
      .then((r) => (r.ok ? r.json() : []))
      .then((d: unknown) => {
        terrain.ranges = Array.isArray(d) ? (d as Terrain['ranges']) : []
      })
      .catch(() => undefined),
  ]).then(() => undefined)
  return terrainRequest
}

/** The relief image's latitude span, matching tools/build_basemap.py. */
const RELIEF_LAT_TOP = 80
const RELIEF_LAT_BOTTOM = -58

/** Margins of the cached static layer beyond the viewport, as fractions of its size. */
const STATIC_MARGIN_X = 0.35
const STATIC_MARGIN_Y = 0.2

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
  terrainLayers,
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
  const staticRef = useRef<{ canvas: HTMLCanvasElement; view: View; mx: number; my: number; at: number } | null>(null)
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

  const fitted = useMemo<Fitted | null>(
    () => (size.width > 0 && size.height > 0 ? fitProjection(size.width, size.height, centralMeridian) : null),
    [size.width, size.height, centralMeridian],
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
  /** One world's extent in base coordinates. */
  const mapRect = useMemo<Rect | null>(
    () =>
      fitted ? { left: fitted.tx - fitted.mapW / 2, top: 0, right: fitted.tx + fitted.mapW / 2, bottom: size.height } : null,
    [fitted, size.height],
  )

  /** Base-map position of a lat/lng (zoom 1), in the primary copy of the world. */
  const project = useCallback(
    (lat: number, lng: number): Pt | null => {
      const p = fitted?.projection([lng, lat])
      return p ? { x: p[0], y: p[1] } : null
    },
    [fitted],
  )

  /** Base-map position to lat/lng; Mercator inverts in closed form, and wraps. */
  const baseToLatLng = useCallback(
    (bx: number, by: number): { lat: number; lng: number } | null => {
      if (!fitted) return null
      const lat = ((2 * Math.atan(Math.exp((fitted.ty - by) / fitted.s)) - Math.PI / 2) * 180) / Math.PI
      if (lat > LAT_TOP || lat < LAT_BOTTOM) return null
      return { lat, lng: wrapLng(fitted.centralMeridian + (((bx - fitted.tx) / fitted.s) * 180) / Math.PI) }
    },
    [fitted],
  )

  const unproject = useCallback(
    (x: number, y: number) => {
      const v = viewRef.current
      return baseToLatLng((x - v.x) / v.k, (y - v.y) / v.k)
    },
    [baseToLatLng],
  )

  /* ------------------------------------------------------- static layer */

  const [detailReady, setDetailReady] = useState(false)
  const [terrainReady, setTerrainReady] = useState(false)

  const renderStatic = useCallback(() => {
    if (!fitted || !mapRect || size.width === 0) return
    const v = { ...viewRef.current }
    const W = size.width
    const H = size.height
    const mx = Math.round(W * STATIC_MARGIN_X)
    const my = Math.round(H * STATIC_MARGIN_Y)
    const canvas = staticRef.current?.canvas ?? document.createElement('canvas')
    canvas.width = Math.round((W + 2 * mx) * dpr)
    canvas.height = Math.round((H + 2 * my) * dpr)
    const ctx = canvas.getContext('2d')!
    const path = geoPath(fitted.projection, ctx)
    const period = fitted.mapW * v.k
    const offsets = copyOffsets(mapRect.left * v.k + v.x, mapRect.right * v.k + v.x, period, -mx, W + mx)
    const outlines = v.k > DETAIL_ZOOM && detailReady && detailOutlines ? detailOutlines : OUTLINES
    const atCopy = (off: number) =>
      ctx.setTransform(dpr * v.k, 0, 0, dpr * v.k, dpr * (v.x + off + mx), dpr * (v.y + my))

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    const relief = terrainLayers.relief && terrainReady ? terrain.relief : null
    for (const off of offsets) {
      atCopy(off)
      if (relief) {
        // The image spans longitude -180..180 from its left edge, already in
        // Mercator rows; place it by where -180 falls in this rotated map,
        // once, and once a world to the left, to cover the copy.
        const x0 = fitted.tx + fitted.s * ((wrapLng(-180 - fitted.centralMeridian) * Math.PI) / 180)
        const top = fitted.projection([fitted.centralMeridian, RELIEF_LAT_TOP])![1]
        const bottom = fitted.projection([fitted.centralMeridian, RELIEF_LAT_BOTTOM])![1]
        ctx.imageSmoothingQuality = 'high'
        for (const shift of [0, -fitted.mapW]) {
          ctx.drawImage(relief, x0 + shift, top, fitted.mapW, bottom - top)
        }
      } else {
        ctx.fillStyle = OCEAN_FILL
        ctx.fillRect(mapRect.left, mapRect.top, fitted.mapW, mapRect.bottom - mapRect.top)
        ctx.beginPath()
        path(outlines.land)
        ctx.fillStyle = LAND_UNDERFILL
        ctx.fill()
      }
      ctx.beginPath()
      path(GRATICULE_LINES)
      ctx.strokeStyle = GRATICULE
      ctx.lineWidth = 1 / v.k
      ctx.stroke()
    }

    // Line widths are in screen pixels at any zoom, and grow a touch when
    // zoomed in so borders stay legible.
    const lineScale = (1 + 0.15 * Math.log2(v.k)) / v.k
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    for (const off of offsets) {
      atCopy(off)
      // Cut a narrow dark channel along each border, engraved into the terrain.
      ctx.globalCompositeOperation = 'destination-out'
      ctx.beginPath()
      path(outlines.borders)
      ctx.strokeStyle = '#000'
      ctx.lineWidth = BORDER_CHANNEL_PX * lineScale
      ctx.stroke()
      ctx.globalCompositeOperation = 'source-over'

      ctx.beginPath()
      path(outlines.land)
      ctx.strokeStyle = COASTLINE
      ctx.lineWidth = COASTLINE_WIDTH_PX * lineScale
      ctx.stroke()

      ctx.beginPath()
      path(outlines.borders)
      ctx.strokeStyle = BORDER
      ctx.lineWidth = BORDER_WIDTH_PX * lineScale
      ctx.stroke()
    }

    // Mountain range names: the biggest at world scale, more as you zoom in.
    if (terrainLayers.ranges && terrain.ranges.length > 0) {
      const maxRank = v.k < 1.6 ? 1 : v.k < 3 ? 2 : v.k < 5 ? 4 : 9
      ctx.setTransform(dpr, 0, 0, dpr, dpr * mx, dpr * my)
      ctx.font = '500 10px "IBM Plex Mono", ui-monospace, monospace'
      ;(ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '2.5px'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = RANGE_LABEL
      // Ranges are sorted most important first; a label that would overlap
      // one already placed is skipped rather than drawn on top of it.
      const placed: Rect[] = []
      for (const range of terrain.ranges) {
        if (range.rank > maxRank) continue
        const p = fitted.projection([range.lng, range.lat])
        if (!p) continue
        const text = range.name.toUpperCase()
        const half = ctx.measureText(text).width / 2 + 6
        const sx0 = p[0] * v.k + v.x
        const sy = p[1] * v.k + v.y
        for (const off of copyOffsets(sx0, sx0, period, -mx, W + mx)) {
          const box = { left: sx0 + off - half, right: sx0 + off + half, top: sy - 8, bottom: sy + 8 }
          if (placed.some((b) => b.left < box.right && box.left < b.right && b.top < box.bottom && box.top < b.bottom))
            continue
          placed.push(box)
          ctx.fillText(text, sx0 + off, sy)
        }
      }
      ;(ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0px'
    }

    staticRef.current = { canvas, view: v, mx, my, at: performance.now() }
  }, [fitted, mapRect, size.width, size.height, dpr, detailReady, terrainReady, terrainLayers])

  /* Load the terrain once, then redraw with it. */
  useEffect(() => {
    let live = true
    void loadTerrain().then(() => live && setTerrainReady(true))
    return () => {
      live = false
    }
  }, [])
  /* Redraw whenever what the static layer depends on changes: detail or
     terrain arriving, or a terrain layer switched. */
  useEffect(() => {
    renderStatic()
  }, [renderStatic])


  /* ------------------------------------------------------------ the view */

  const reportView = useCallback(() => {
    const c = unproject(visibleCentre.x, visibleCentre.y)
    setReadout(c ? { lat: c.lat, lng: c.lng, k: viewRef.current.k } : null)
  }, [unproject, visibleCentre])

  /** Apply a view (clamped top and bottom only) and schedule a crisp re-render once it settles. */
  const setView = useCallback(
    (next: View) => {
      if (!mapRect) return
      viewRef.current = clampWrapView(next, visible, mapRect)
      if (viewRef.current.k > DETAIL_ZOOM && !detailOutlines) {
        void loadDetailOutlines().then(() => setDetailReady(true))
      }
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

  /** Animate to a view, via its nearest repeat so it never laps the world; any input cancels it. */
  const flyTo = useCallback(
    (raw: View, ms = 700) => {
      if (!fitted || !mapRect) return
      cancelAnimationFrame(flightRef.current)
      const target = nearestRepeat(clampWrapView(raw, visible, mapRect), viewRef.current, fitted.mapW)
      if (reducedMotion || ms === 0) return setView(target)
      const from = { ...viewRef.current }
      const start = performance.now()
      const step = () => {
        const t = Math.min(1, (performance.now() - start) / ms)
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
        // Zoom geometrically so it feels even; translation linearly.
        const k = from.k * Math.pow(target.k / from.k, e)
        setView({ k, x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e })
        if (t < 1) flightRef.current = requestAnimationFrame(step)
      }
      flightRef.current = requestAnimationFrame(step)
    },
    [fitted, mapRect, visible, reducedMotion, setView],
  )

  const homeView = useCallback(
    (): View => (fitted ? centreOn({ x: fitted.tx, y: size.height / 2 }, 1, visibleCentre) : { k: 1, x: 0, y: 0 }),
    [fitted, size.height, visibleCentre],
  )

  /* First fit, and a re-clamp when the canvas changes size. */
  const fittedOnceRef = useRef(false)
  useEffect(() => {
    if (!fitted || !mapRect) return
    if (!fittedOnceRef.current) {
      fittedOnceRef.current = true
      viewRef.current = clampWrapView(homeView(), visible, mapRect)
    } else {
      viewRef.current = clampWrapView(viewRef.current, visible, mapRect)
    }
    renderStatic()
    reportView()
    // Only when the canvas itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitted, mapRect])

  /* --------------------------------------------------------- arc models */

  useEffect(() => {
    if (!fitted) return
    const now = performance.now()
    const previous = new Map(arcGeomRef.current.map((g) => [g.arc.id, g]))
    arcGeomRef.current = arcs.flatMap((arc, i) => {
      const a = project(arc.startLat, arc.startLng)
      const end = project(arc.endLat, arc.endLng)
      if (!a || !end) return []
      // The short way round, across the map's edge if that is shorter.
      const b = shortWay(a, end, fitted.mapW)
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

  const pointPositions = useMemo(() => points.map((p) => project(p.lat, p.lng)), [points, project])

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
    if (!canvas || !fitted || !mapRect || size.width === 0) return
    canvas.width = Math.round(size.width * dpr)
    canvas.height = Math.round(size.height * dpr)
    const ctx = canvas.getContext('2d')!
    const path = geoPath(fitted.projection, ctx)
    const W = size.width
    const H = size.height
    let raf = 0

    const draw = () => {
      const now = performance.now()
      const seconds = now / 1000
      const v = viewRef.current
      const s = frameState.current
      const period = fitted.mapW * v.k
      const isHi = (id: string) =>
        id === s.selectedId || id === s.hoverId || id === s.externalHoverId || id === s.cursorId
      const zoomWidth = 1 + 0.28 * Math.log2(v.k)

      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      // Static layer, shifted and scaled from the view it was rendered at.
      // Its content repeats every world width, so the shift is taken modulo
      // that; once it nears the edge of the cached margin, re-render.
      const cached = staticRef.current
      if (cached) {
        const f = v.k / cached.view.k
        const restX = -cached.mx * f
        const restY = -cached.my * f
        let dx = v.x - (cached.mx + cached.view.x) * f - restX
        dx -= period * Math.round(dx / period)
        const dy = v.y - (cached.my + cached.view.y) * f - restY
        // Copy only the part of the cache that lands on screen: the cache is
        // larger than the viewport, and blitting all of it every frame costs
        // fill rate for pixels nobody sees.
        const ox = dpr * (restX + dx)
        const oy = dpr * (restY + dy)
        const sx = Math.max(0, -ox / f)
        const sy = Math.max(0, -oy / f)
        const sw = Math.min(cached.canvas.width - sx, (canvas.width - ox) / f - sx)
        const sh = Math.min(cached.canvas.height - sy, (canvas.height - oy) / f - sy)
        if (sw > 0 && sh > 0) ctx.drawImage(cached.canvas, sx, sy, sw, sh, ox + sx * f, oy + sy * f, sw * f, sh * f)
        const stale =
          Math.abs(dx) > cached.mx * 0.55 || Math.abs(dy) > cached.my * 0.55 || f < 0.8 || f > 1.25
        if (stale && now - cached.at > 120) renderStatic()
      }

      /** Every copy of a span of base x that is on screen, as screen offsets. */
      const copies = (minBase: number, maxBase: number, pad = 40) =>
        copyOffsets(minBase * v.k + v.x, maxBase * v.k + v.x, period, -pad, W + pad)

      // Hovered and focused countries get a faint fill.
      for (const [iso3, alpha] of [
        [s.focusCountry, 0.12],
        [s.hoverCountry !== s.focusCountry ? s.hoverCountry : null, 0.07],
      ] as const) {
        const geom = iso3 ? COUNTRY_GEOMETRY.get(iso3) : undefined
        if (!geom) continue
        for (const off of copies(mapRect.left, mapRect.right, 0)) {
          ctx.setTransform(dpr * v.k, 0, 0, dpr * v.k, dpr * (v.x + off), dpr * v.y)
          ctx.beginPath()
          path(geom)
          ctx.fillStyle = rgba(ACCENT, alpha)
          ctx.fill()
          ctx.strokeStyle = rgba(ACCENT, alpha * 3)
          ctx.lineWidth = 0.8 / v.k
          ctx.stroke()
        }
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.lineCap = 'round'

      // Arcs: halo, then core, then comet, for each copy on screen.
      for (const g of arcGeomRef.current) {
        const hiTarget = isHi(g.arc.id) ? 1 : 0
        const dimTarget = s.selectedId !== null && hiTarget === 0 ? 1 : 0
        g.hi += (hiTarget - g.hi) * (reducedMotion ? 1 : STATE_EASE)
        g.dim += (dimTarget - g.dim) * (reducedMotion ? 1 : STATE_EASE)
        const t = g.startsAt === 0 ? 1 : Math.min(1, Math.max(0, (now - g.startsAt) / ARC_GROW_MS))
        if (t <= 0) continue
        const grow = 1 - Math.pow(1 - t, 3)
        const low = g.arc.confidence === 'low'
        const dimF = 1 - 0.85 * g.dim
        const width = Math.max(0.7, g.arc.width * 1.6) * zoomWidth
        // Importer-reported flows are dashed, not faint: a country that publishes
        // no trade data (Russia, in this data) should still be visible, just
        // marked as less certain. They get no halo or comet.
        const alpha = (low ? 0.38 + 0.45 * g.arc.weight : 0.45 + 0.5 * g.arc.weight) * dimF
        const minX = Math.min(g.a.x, g.b.x, g.c.x)
        const maxX = Math.max(g.a.x, g.b.x, g.c.x)

        for (const off of copies(minX, maxX)) {
          const toScreen = (p: Pt) => ({ x: p.x * v.k + v.x + off, y: p.y * v.k + v.y })
          const a = toScreen(g.a)
          const c = toScreen(g.c)
          const b = toScreen(g.b)
          const [sa, sc, sb] = grow >= 1 ? [a, c, b] : subQuad(a, c, b, 0, grow)
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
          grad.addColorStop(0, rgba(mixHex(g.arc.color, '#000000', 0.5), alpha))
          grad.addColorStop(1, rgba(mixHex(g.arc.color, '#ffdcaa', 0.5), alpha))
          ctx.setLineDash(low ? [5, 4] : [])
          curve()
          ctx.strokeStyle = grad
          ctx.lineWidth = width
          ctx.stroke()
          if (g.hi > 0.02) {
            curve()
            ctx.strokeStyle = rgba(ACCENT, g.hi)
            ctx.lineWidth = width * (1 + 0.4 * g.hi)
            ctx.stroke()
          }
          ctx.setLineDash([])

          if (!low && !reducedMotion && grow >= 1) {
            const head = (seconds * COMET_SPEED + g.phase) % 1
            if (head > 0.01) {
              const [ca, cc, cb] = subQuad(a, c, b, Math.max(0, head - COMET_TAIL), head)
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
      }

      // Landing pulses at the largest import hubs.
      if (!reducedMotion) {
        for (const pulse of s.pulses) {
          const t = (seconds * 0.38 + pulse.phase) % 1
          const r = (6 + (18 + 26 * pulse.weight) * t) * Math.sqrt(zoomWidth)
          for (const off of copies(pulse.p.x, pulse.p.x, r)) {
            ctx.beginPath()
            ctx.arc(pulse.p.x * v.k + v.x + off, pulse.p.y * v.k + v.y, r, 0, Math.PI * 2)
            ctx.strokeStyle = `rgba(${PULSE}, ${(1 - t) * (0.3 + 0.4 * pulse.weight)})`
            ctx.lineWidth = 1.2
            ctx.stroke()
          }
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
          const sy = pos.y * v.k + v.y
          if (sy < -20 || sy > H + 20) continue
          const hi = isHi(p.id)
          const dim =
            !hi &&
            (s.selectedId !== null ||
              (s.focusCountry !== null && p.facility.properties.country_iso3 !== s.focusCountry))
          const sz = p.size * pointScale * (hi ? 1.5 : 1)
          const img = sprite(p.color, sz, p.confidence === 'low', p.stage === 'mine' ? 0.25 : p.stage === 'process' ? 0.8 : 1, dpr)
          const d = img.width / dpr
          for (const off of copies(pos.x, pos.x, 20)) {
            const sx = pos.x * v.k + v.x + off
            ctx.globalAlpha = dim ? 0.16 : 1
            ctx.drawImage(img, sx - d / 2, sy - d / 2, d, d)
            ctx.globalAlpha = 1
            if (hi) {
              ctx.beginPath()
              ctx.arc(sx, sy, sz * 0.95, 0, Math.PI * 2)
              ctx.strokeStyle = ACCENT
              ctx.lineWidth = 1.4
              ctx.stroke()
            }
          }
        }
      }

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [fitted, mapRect, size.width, size.height, dpr, reducedMotion, renderStatic])

  /* ------------------------------------------------------------ picking */

  const pick = useCallback(
    (x: number, y: number): Hit | null => {
      if (!fitted) return null
      const v = viewRef.current
      const period = fitted.mapW * v.k
      const pointScale = POINT_SIZE * (1 + 0.15 * Math.log2(v.k))
      let best: Hit | null = null
      let bestDist = Infinity
      points.forEach((p, i) => {
        const pos = pointPositions[i]
        if (!pos) return
        let sx = pos.x * v.k + v.x
        sx += period * Math.round((x - sx) / period)
        const d = Math.hypot(sx - x, pos.y * v.k + v.y - y)
        if (d < Math.max(7, (p.size * pointScale) / 2 + 3) && d < bestDist) {
          bestDist = d
          best = { kind: 'facility', point: p }
        }
      })
      if (best) return best
      for (const g of arcGeomRef.current) {
        const minX = Math.min(g.a.x, g.b.x, g.c.x) * v.k + v.x
        const maxX = Math.max(g.a.x, g.b.x, g.c.x) * v.k + v.x
        for (const off of copyOffsets(minX, maxX, period, x - 12, x + 12)) {
          const a = { x: g.a.x * v.k + v.x + off, y: g.a.y * v.k + v.y }
          const c = { x: g.c.x * v.k + v.x + off, y: g.c.y * v.k + v.y }
          const b = { x: g.b.x * v.k + v.x + off, y: g.b.y * v.k + v.y }
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
      }
      return best
    },
    [fitted, points, pointPositions],
  )

  /* --------------------------------------------------------- flights */

  const zoomBy = useCallback(
    (factor: number, at?: Pt) => {
      cancelAnimationFrame(flightRef.current)
      flyTo(zoomAbout(viewRef.current, factor, at ?? visibleCentre), 320)
    },
    [flyTo, visibleCentre],
  )

  const goHome = useCallback(() => flyTo(homeView(), 700), [flyTo, homeView])

  const centreBase = useCallback(
    (p: Pt) => flyTo(centreOn(p, viewRef.current.k, visibleCentre), 800),
    [flyTo, visibleCentre],
  )

  /**
   * A country focused from search or a link is fitted with the far ends of its
   * drawn flows; one clicked on the map is left where it is. Either way the
   * country itself ends up clear of the panel.
   */
  const clickedCountryRef = useRef<string | null>(null)
  useEffect(() => {
    if (focusCountry === null || !mapRect) return
    if (clickedCountryRef.current === focusCountry) {
      clickedCountryRef.current = null
      return
    }
    clickedCountryRef.current = null
    const c = countries[focusCountry]
    const home = c ? project(c.lat, c.lon) : null
    if (!home) return
    // Arc ends are positioned relative to the exporter; move each set so it
    // hangs off this country's own position.
    const ends = arcGeomRef.current.flatMap((g) => {
      if (g.arc.flow.from_iso3 === focusCountry) {
        const d = home.x - g.a.x
        return [{ x: g.b.x + d, y: g.b.y }, { x: g.c.x + d, y: g.c.y }]
      }
      if (g.arc.flow.to_iso3 === focusCountry) {
        const d = home.x - g.b.x
        return [{ x: g.a.x + d, y: g.a.y }, { x: g.c.x + d, y: g.c.y }]
      }
      return []
    })
    const fit = fitPoints([home, ...ends], visible, 70, 2.5)
    if (fit) flyTo(keepInView(clampWrapView(fit, visible, mapRect), home, visible), 900)
    // The arcs are read once per focus, not re-fitted when a layer toggles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusCountry, countries, project])

  /* A flow picked from the list: bring it into view if it is not already. */
  useEffect(() => {
    if (!fitted || selectedId === null || selectedId !== externalHoverId) return
    const g = arcGeomRef.current.find((x) => x.arc.id === selectedId)
    if (!g) return
    const v = viewRef.current
    const period = fitted.mapW * v.k
    const mid = quadAt(g.a, g.c, g.b, 0.5)
    const off = period * Math.round((visibleCentre.x - (mid.x * v.k + v.x)) / period)
    const inView = (p: Pt) => {
      const sx = p.x * v.k + v.x + off
      const sy = p.y * v.k + v.y
      return sx > visible.left + 40 && sy > 40 && sx < visible.right - 40 && sy < size.height - 40
    }
    if (inView(g.a) && inView(g.b)) return
    const target = fitPoints([g.a, g.b, mid], visible, 80, v.k)
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
