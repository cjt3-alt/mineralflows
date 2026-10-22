import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  geoArea,
  geoCentroid,
  geoGraticule10,
  geoMercator,
  geoPath,
  type GeoPermissibleObjects,
} from 'd3-geo'
import { feature, mesh } from 'topojson-client'
import countriesTopology from 'world-atlas/countries-110m.json'
import type { Topology } from 'topojson-specification'
import { COUNTRY_SHAPES } from '../data/geo.ts'
import { formatShare, shockOf, toCsv, type ChokepointModel, type CountryRow } from '../data/chokepoint.ts'
import { COPPER_HEX, ORE_HEX, hexToRgb, toneAt } from '../styles/palette.ts'

/**
 * "The Chokepoint": the same world, drawn twice and morphed between. At one end
 * the countries that dig a mineral out of the ground glow; at the other, the
 * countries that turn it into metal. The distance between the two pictures is
 * the story, so nothing here is explained in a paragraph.
 *
 * One scalar, `t`, runs the whole thing: 0 is mined, 1 is refined. Country
 * shading and share readouts interpolate between the two published figures,
 * mines fade out as smelters and refineries fade in, and the ore routes (the
 * mine-to-smelter leg of the trade data) sweep across the map in between, the
 * way the ore actually moves. Only mined and refined output are published by
 * country, so the middle of the scrubber is the journey, not a third dataset.
 */

export interface ChokepointViewProps {
  model: ChokepointModel
  reducedMotion: boolean
  compact: boolean
  /** Hand over to the trade-flow explorer. */
  onExplore: () => void
}

/* ------------------------------------------------------------------ palette */

const ACCENT = '217, 182, 114'
const ORE_RGB = hexToRgb(ORE_HEX).join(',')
const COPPER_RGB = hexToRgb(COPPER_HEX).join(',')
const FONT_MONO = "'IBM Plex Mono', ui-monospace, 'SF Mono', 'Cascadia Mono', monospace"
const CENTRAL_MERIDIAN = 155 // Pacific in the middle, the cut running through the Atlantic
const CENTER_LAT = 24

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const smooth = (t: number) => t * t * (3 - 2 * t)
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const mix = toneAt

/* ----------------------------------------------------------------- geometry */

const topology = countriesTopology as unknown as Topology
const LAND = feature(topology, topology.objects.land!) as unknown as GeoPermissibleObjects
const BORDERS = mesh(
  topology,
  topology.objects.countries as never,
  (a, b) => a !== b,
) as unknown as GeoPermissibleObjects
const GRATICULE = geoGraticule10()

const SHAPES = new Map(COUNTRY_SHAPES.filter((s) => s.iso3 !== null).map((s) => [s.iso3!, s]))

/** The centroid of a country's largest polygon, so Alaska does not drag the US north. */
function anchorOf(iso3: string): [number, number] | null {
  const shape = SHAPES.get(iso3)
  if (!shape) return null
  let best: GeoPermissibleObjects | null = null
  let bestArea = -1
  for (const polygon of shape.polygons) {
    const geometry = {
      type: 'Polygon',
      coordinates: polygon,
    } as GeoPermissibleObjects
    const area = geoArea(geometry)
    if (area > bestArea) {
      best = geometry
      bestArea = area
    }
  }
  return best ? (geoCentroid(best) as [number, number]) : null
}

interface Layout {
  width: number
  height: number
  dpr: number
  project: (lonLat: [number, number]) => [number, number]
  base: HTMLCanvasElement
  paths: Map<string, Path2D>
  anchors: Map<string, [number, number]>
  sites: {
    x: number
    y: number
    stage: 'mine' | 'process' | 'refine'
    low: boolean
    iso3: string
  }[]
}

function buildLayout(model: ChokepointModel, width: number, height: number, dpr: number): Layout {
  const scale = width / (2 * Math.PI)
  const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
  const projection = geoMercator()
    .rotate([-CENTRAL_MERIDIAN, 0])
    .scale(scale)
    .translate([width / 2, height / 2 + mercY(CENTER_LAT) * scale])
  const project = (p: [number, number]) => projection(p) ?? [-1000, -1000]
  // Crop where web maps do: the far north and Antarctica carry nothing here.
  projection.clipExtent([
    [0, project([0, 80])[1]],
    [width, project([0, -57])[1]],
  ])

  const base = document.createElement('canvas')
  base.width = Math.round(width * dpr)
  base.height = Math.round(height * dpr)
  const g = base.getContext('2d')!
  g.scale(dpr, dpr)
  const path = geoPath(projection, g)

  const ocean = g.createRadialGradient(
    width * 0.5,
    height * 0.45,
    0,
    width * 0.5,
    height * 0.45,
    Math.max(width, height) * 0.75,
  )
  ocean.addColorStop(0, '#15110f')
  ocean.addColorStop(1, '#0d0b0a')
  g.fillStyle = ocean
  g.fillRect(0, 0, width, height)

  g.beginPath()
  path(GRATICULE)
  g.strokeStyle = 'rgba(217, 182, 114, 0.04)'
  g.lineWidth = 0.6
  g.stroke()

  g.beginPath()
  path(LAND)
  g.fillStyle = 'rgba(46, 38, 30, 0.98)'
  g.fill()
  g.strokeStyle = 'rgba(206, 178, 146, 0.42)'
  g.lineWidth = 0.7
  g.stroke()

  g.beginPath()
  path(BORDERS)
  g.strokeStyle = 'rgba(214, 190, 160, 0.2)'
  g.lineWidth = 0.55
  g.stroke()

  const paths = new Map<string, Path2D>()
  const anchors = new Map<string, [number, number]>()
  for (const row of model.rows) {
    const shape = SHAPES.get(row.iso3)
    if (!shape) continue
    const p2d = new Path2D()
    geoPath(
      projection,
      p2d as unknown as CanvasRenderingContext2D,
    )({
      type: 'MultiPolygon',
      coordinates: shape.polygons,
    } as GeoPermissibleObjects)
    paths.set(row.iso3, p2d)
    const anchor = anchorOf(row.iso3)
    if (anchor) anchors.set(row.iso3, project(anchor))
  }

  const sites = model.sites.map((s) => {
    const [x, y] = project([s.lon, s.lat])
    return { x, y, stage: s.stage, low: s.lowConfidence, iso3: s.iso3 }
  })

  return { width, height, dpr, project, base, paths, anchors, sites }
}

/** A bowed arc between two screen points: control point lifted above the chord. */
function arcControl(a: [number, number], b: [number, number]): [number, number] {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const dist = Math.hypot(dx, dy)
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - Math.min(dist * 0.28, 150)]
}

function quadAt(a: [number, number], c: [number, number], b: [number, number], t: number): [number, number] {
  const u = 1 - t
  return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]
}

/* ------------------------------------------------------------------ the view */

/** A shared link can open at a stage, with a country already switched off. */
function readShared(model: ChokepointModel): { stage: 0 | 1 | null; off: string | null } {
  if (typeof window === 'undefined') return { stage: null, off: null }
  const params = new URLSearchParams(window.location.search)
  const wanted = params.get('off')
  const stage = params.get('stage')
  return {
    stage: stage === 'refined' ? 1 : stage === 'mined' ? 0 : null,
    off: wanted && model.rows.some((r) => r.iso3 === wanted) ? wanted : null,
  }
}

export function ChokepointView({ model, reducedMotion, compact, onExplore }: ChokepointViewProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const layoutRef = useRef<Layout | null>(null)
  const shared = useMemo(() => readShared(model), [model])
  const tRef = useRef<number>(shared.stage ?? 0)
  const animRef = useRef<{
    from: number
    to: number
    start: number
    dur: number
  } | null>(null)
  const hoverRef = useRef<string | null>(null)
  const offRef = useRef<string | null>(shared.off)
  const [t, setT] = useState<number>(shared.stage ?? 0)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [hover, setHover] = useState<{
    iso3: string
    x: number
    y: number
  } | null>(null)
  const [off, setOff] = useState<string | null>(shared.off)
  const [hintOn, setHintOn] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const firstPlay = useRef(shared.stage === null)

  const rowsByIso = useMemo(() => new Map(model.rows.map((r) => [r.iso3, r])), [model])
  const maxShare = useMemo(() => Math.max(...model.rows.flatMap((r) => [r.mine, r.refine])), [model])

  /* Start, stop and drive the morph. */
  const animateTo = useCallback(
    (to: number, dur: number) => {
      if (reducedMotion || dur <= 0) {
        animRef.current = null
        tRef.current = to
        setT(to)
        return
      }
      animRef.current = {
        from: tRef.current,
        to,
        start: performance.now(),
        dur,
      }
    },
    [reducedMotion],
  )

  /* Play once on arrival: sit on the mines for a beat, then carry the ore across. */
  useEffect(() => {
    if (reducedMotion) return
    const id = window.setTimeout(() => {
      if (firstPlay.current) animateTo(1, 7200)
    }, 1700)
    return () => window.clearTimeout(id)
  }, [animateTo, reducedMotion])

  /* Once the morph has finished by itself, tell people what they can do next. */
  useEffect(() => {
    if (t < 0.999 || !firstPlay.current || off) return
    firstPlay.current = false
    setHintOn(true)
    const id = window.setTimeout(() => setHintOn(false), 11000)
    return () => window.clearTimeout(id)
  }, [t, off])

  /* Track the container. */
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      setSize({
        width: Math.round(entry.contentRect.width),
        height: Math.round(entry.contentRect.height),
      })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  /* Rebuild the static layer when the size or the data changes. */
  useEffect(() => {
    if (size.width === 0 || size.height === 0) return
    layoutRef.current = buildLayout(model, size.width, size.height, Math.min(window.devicePixelRatio || 1, 2))
  }, [model, size])

  /* The draw loop. */
  useEffect(() => {
    let raf = 0
    let lastReported = -1
    const tick = (now: number) => {
      const anim = animRef.current
      if (anim) {
        const p = clamp01((now - anim.start) / anim.dur)
        tRef.current = lerp(anim.from, anim.to, easeInOut(p))
        if (p >= 1) animRef.current = null
      }
      const current = tRef.current
      if (Math.abs(current - lastReported) > 0.0015) {
        lastReported = current
        setT(current)
      }
      const layout = layoutRef.current
      const canvas = canvasRef.current
      if (layout && canvas)
        draw(canvas, layout, model, rowsByIso, maxShare, current, now, hoverRef.current, offRef.current)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [model, rowsByIso, maxShare])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const layout = layoutRef.current
    const canvas = canvasRef.current
    if (!layout || !canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(layout.dpr, 0, 0, layout.dpr, 0, 0)
    let found: string | null = null
    for (const [iso3, p2d] of layout.paths) {
      if (ctx.isPointInPath(p2d, x * layout.dpr, y * layout.dpr)) {
        found = iso3
        break
      }
    }
    hoverRef.current = found
    setHover((prev) => (found ? { iso3: found, x, y } : prev === null ? prev : null))
  }, [])

  const onLeave = useCallback(() => {
    hoverRef.current = null
    setHover(null)
  }, [])

  /* Click a country to switch it off; click it again to bring it back. */
  const toggleOff = useCallback((iso3: string | null) => {
    const next = iso3 && iso3 !== offRef.current ? iso3 : null
    offRef.current = next
    setOff(next)
    setHintOn(false)
  }, [])

  const onPick = useCallback(() => toggleOff(hoverRef.current), [toggleOff])

  const onScrub = (value: number) => {
    animRef.current = null
    tRef.current = value
    setT(value)
  }

  /* ---------------------------------------------------------- derived copy */

  const leader = model.leader
  const ease = smooth(t)
  const leaderNow = lerp(leader.mine, leader.refine, ease)
  const phase = t < 0.34 ? 'mined' : t > 0.66 ? 'refined' : 'moving'
  const ranked = useMemo(() => model.rows.slice(0, compact ? 6 : 9), [model, compact])
  const exporter = useMemo(
    () => [...model.rows].sort((a, b) => b.mine - b.refine - (a.mine - a.refine))[0],
    [model],
  )
  const focus = hover?.iso3 ?? off
  const offRow = off ? rowsByIso.get(off) : undefined
  const shockStage = ease < 0.5 ? 'mine' : 'refine'
  const shock = offRow ? shockOf(offRow, shockStage) : null
  const focusRow = focus ? rowsByIso.get(focus) : undefined
  const name = model.mineralName.toLowerCase()
  const flash = (what: string) => {
    setCopied(what)
    window.setTimeout(() => setCopied(null), 2200)
  }

  return (
    <div ref={wrapRef} className="stage relative h-full w-full overflow-hidden">
      <canvas
        ref={canvasRef}
        width={Math.round(
          size.width * Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, 2),
        )}
        height={Math.round(
          size.height * Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, 2),
        )}
        style={{
          width: size.width,
          height: size.height,
          cursor: hover ? 'pointer' : 'default',
        }}
        className="absolute inset-0"
        role="img"
        aria-label={`World map morphing from where ${name} is mined to where it is refined. ${leader.name} mines ${formatShare(leader.mine)} and refines ${formatShare(leader.refine)}.`}
        onPointerMove={onPointerMove}
        onPointerLeave={onLeave}
        onClick={onPick}
      />

      {/* Headline: the one sentence the picture is making. */}
      <div className="pointer-events-none absolute top-5 left-5 max-w-[min(34rem,calc(100%-2.5rem))] sm:top-7 sm:left-8">
        <p className="hud-label text-muted">
          {model.mineralName} · {model.year}
          {model.estimated ? ' est.' : ''} · by country
        </p>
        <div className="relative mt-2 h-[2.6em] text-[1.65rem] leading-[1.15] sm:h-[2.4em] sm:text-[2.35rem]">
          <h2
            className="font-display absolute inset-0 font-semibold tracking-tight text-ink"
            style={{
              opacity: 1 - smooth(clamp01((t - 0.3) / 0.25)),
              transform: `translateY(${-smooth(clamp01((t - 0.3) / 0.25)) * 8}px)`,
            }}
          >
            Where {name} is dug.
          </h2>
          <h2
            className="font-display absolute inset-0 font-semibold tracking-tight"
            style={{
              color: 'var(--mf-copper-refined)',
              opacity: smooth(clamp01((t - 0.5) / 0.25)),
              transform: `translateY(${(1 - smooth(clamp01((t - 0.5) / 0.25))) * 8}px)`,
            }}
          >
            Where it becomes metal.
          </h2>
        </div>
        <p
          className="font-serif mt-2 min-h-[3.4em] max-w-[31rem] text-[1.1rem] leading-[1.3] text-dim"
          aria-live="polite"
        >
          {offRow && shock ? (
            <>
              Without <strong className="font-semibold text-ink">{offRow.name}</strong>,{' '}
              {formatShare(shock.lostShare)} of the world&apos;s {shockStage === 'mine' ? 'mined' : 'refined'}{' '}
              {name} disappears.{' '}
              {Number.isFinite(shock.uplift)
                ? `Every other country would have to raise output by ${Math.round(shock.uplift * 100)}% to make it up.`
                : 'Nobody else produces any.'}{' '}
              <button
                type="button"
                onClick={() => toggleOff(null)}
                className="pointer-events-auto underline decoration-line-strong underline-offset-2 hover:text-ink"
              >
                Bring it back
              </button>
            </>
          ) : null}
          {!offRow &&
            phase === 'mined' &&
            `No one country dominates the mines. The largest three account for ${formatShare(model.mineConcentration.top3)} of the world's ${name}.`}
          {!offRow &&
            phase === 'moving' &&
            `Most ore is not refined where it is dug. It ships, mostly across the Pacific.`}
          {!offRow && phase === 'refined' && (
            <>
              <strong className="font-semibold text-ink">{leader.name}</strong> mines{' '}
              {formatShare(leader.mine)} of the world&apos;s {name} and refines{' '}
              <strong className="font-semibold" style={{ color: 'var(--mf-copper-refined)' }}>
                {formatShare(leader.refine)}
              </strong>
              .{' '}
              {exporter && exporter.iso3 !== leader.iso3
                ? `${exporter.name} digs ${formatShare(exporter.mine)} and refines ${formatShare(exporter.refine)}.`
                : ''}
            </>
          )}
        </p>
        <p aria-hidden="true" className="mt-3 flex items-end gap-3">
          <span
            className="font-display text-[3.6rem] leading-[0.85] font-semibold tabular-nums sm:text-[5rem]"
            style={{
              color: shock ? 'var(--mf-alert)' : `rgb(${mix(ease).join(',')})`,
            }}
          >
            {shock ? '−' + formatShare(shock.lostShare) : formatShare(leaderNow)}
          </span>
          <span className="hud-label pb-1 text-muted">
            {offRow ? offRow.name : leader.name}
            <br />
            {shock ? 'switched off' : ease < 0.5 ? 'of world mining' : 'of world refining'}
          </span>
        </p>
      </div>

      {/* Explore the trade flows. */}
      <div className="absolute top-5 right-5 hidden sm:top-7 sm:right-8 sm:block">
        <button
          type="button"
          onClick={onExplore}
          className="hud-label panel border-line-strong px-3 py-2 text-ink hover:border-accent"
          style={{ borderRadius: 'var(--mf-radius)' }}
        >
          Explore the trade flows →
        </button>
      </div>

      {/* The gap, country by country. */}
      {!compact && (
        <aside
          aria-label={`${model.mineralName} mine versus refinery share by country`}
          className="panel absolute top-24 right-5 w-[19.5rem] p-3.5 sm:right-8"
        >
          <p className="hud-label flex items-center justify-between text-dim">
            <span>The gap</span>
            <span className="flex items-center gap-3 text-muted normal-case">
              <span className="flex items-center gap-1">
                <i
                  className="inline-block h-2 w-2 rounded-full border"
                  style={{ borderColor: `rgb(${ORE_RGB})` }}
                />{' '}
                mined
              </span>
              <span className="flex items-center gap-1">
                <i
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: `rgb(${COPPER_RGB})` }}
                />{' '}
                refined
              </span>
            </span>
          </p>
          <ul className="mt-2.5 space-y-1.5">
            {ranked.map((row) => (
              <GapRow
                key={row.iso3}
                row={row}
                t={ease}
                axisMax={maxShare}
                active={focus === row.iso3}
                off={off === row.iso3}
                onToggle={toggleOff}
              />
            ))}
          </ul>
          <div className="mt-3 border-t border-line pt-2.5">
            <p className="hud-label text-muted">Concentration index (HHI)</p>
            <p className="mt-1 flex items-baseline gap-2 tabular-nums">
              <span className="font-display text-lg text-ink">
                {Math.round(
                  lerp(model.mineConcentration.hhi, model.refineConcentration.hhi, ease),
                ).toLocaleString('en-US')}
              </span>
              <span className="text-xs text-muted">
                {model.mineConcentration.hhi.toLocaleString('en-US')} mined →{' '}
                {model.refineConcentration.hhi.toLocaleString('en-US')} refined
              </span>
            </p>
            <p className="mt-0.5 text-[0.68rem] leading-snug text-muted">
              US antitrust treats a market above 1,800 as highly concentrated. Used here as a yardstick only,
              and a lower bound.
            </p>
            <p className="hud-label mt-2.5 text-muted">Top 3 countries</p>
            <p className="mt-1 flex items-baseline gap-2 tabular-nums">
              <span className="font-display text-lg text-ink">
                {formatShare(lerp(model.mineConcentration.top3, model.refineConcentration.top3, ease))}
              </span>
              <span className="text-xs text-muted">
                {formatShare(model.mineConcentration.top3)} mined →{' '}
                {formatShare(model.refineConcentration.top3)} refined
              </span>
            </p>
          </div>
        </aside>
      )}

      {hintOn && !off && (
        <p
          className="panel pointer-events-none absolute top-[17.5rem] right-5 hidden px-3 py-2 text-[0.75rem] text-ink sm:right-8 lg:block"
          style={{ width: '19.5rem' }}
        >
          Try it: click a country, here or on the map, to switch it off.
        </p>
      )}

      {/* Country read-out on hover. */}
      {focusRow && hover && (
        <div
          className="panel pointer-events-none absolute z-10 px-3 py-2"
          style={{
            left: Math.min(Math.max((hover?.x ?? size.width / 2) + 14, 8), Math.max(size.width - 210, 8)),
            top: Math.min(Math.max((hover?.y ?? size.height / 2) + 14, 8), Math.max(size.height - 96, 8)),
            width: 196,
          }}
        >
          <p className="font-display text-sm font-semibold text-ink">{focusRow.name}</p>
          <p className="mt-0.5 text-xs text-dim tabular-nums">
            Mines <span className="text-ink">{formatShare(focusRow.mine)}</span> · Refines{' '}
            <span className="text-ink">{formatShare(focusRow.refine)}</span>
          </p>
          <p className="mt-0.5 text-[0.7rem] text-muted">{roleOf(focusRow)}</p>
        </div>
      )}

      {/* Scrubber. */}
      <div className="absolute inset-x-0 bottom-5 flex flex-col items-center px-5 sm:bottom-7">
        <div className="w-full max-w-[34rem]">
          <div className="flex items-end justify-between">
            <StopButton label="01 · Mined" active={phase === 'mined'} onClick={() => animateTo(0, 2200)} />
            <StopButton
              label="02 · Shipped"
              active={phase === 'moving'}
              onClick={() => animateTo(0.5, 2200)}
            />
            <StopButton
              label="03 · Refined"
              active={phase === 'refined'}
              onClick={() => animateTo(1, 2200)}
            />
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={t}
            onChange={(e) => onScrub(Number(e.target.value))}
            aria-label={`Supply chain stage for ${name}, from mined to refined`}
            aria-valuetext={phase === 'mined' ? 'Mined' : phase === 'refined' ? 'Refined' : 'In transit'}
            className="stage-slider mt-2 w-full"
            style={{
              ['--fill' as string]: `${t * 100}%`,
              ['--thumb' as string]: `rgb(${mix(ease).join(',')})`,
            }}
          />
          <button
            type="button"
            onClick={onExplore}
            className="hud-label panel mx-auto mt-3 block border-line-strong px-3 py-2 text-ink hover:border-accent sm:hidden"
            style={{ borderRadius: 'var(--mf-radius)' }}
          >
            Explore the trade flows →
          </button>
          <p className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[0.68rem] text-dim">
            <ShareButton
              label={copied === 'link' ? 'Link copied' : 'Copy link'}
              onClick={() => {
                const url = new URL(window.location.href)
                url.search = ''
                url.searchParams.set('stage', phase === 'mined' ? 'mined' : 'refined')
                if (off) url.searchParams.set('off', off)
                void copyText(url.toString()).then(() => flash('link'))
              }}
            />
            <ShareButton label="Download CSV" onClick={() => downloadCsv(model)} />
            <ShareButton
              label={copied === 'cite' ? 'Citation copied' : 'Cite'}
              onClick={() => void copyText(citation(model)).then(() => flash('cite'))}
            />
          </p>
          <p className="mt-2 text-center text-[0.68rem] leading-snug text-muted">
            Source: USGS Mineral Commodity Summaries · {model.year}
            {model.estimated ? ' (estimate)' : ''} · contained metal · shares of the published world total, so
            concentration figures are lower bounds
          </p>
        </div>
      </div>

      {/* Screen-reader text alternative of everything the picture says. */}
      <table className="sr-only">
        <caption>
          {model.mineralName} output by country, {model.year}
        </caption>
        <thead>
          <tr>
            <th>Country</th>
            <th>Share of mining</th>
            <th>Share of refining</th>
          </tr>
        </thead>
        <tbody>
          {model.rows.slice(0, 12).map((r) => (
            <tr key={r.iso3}>
              <td>{r.name}</td>
              <td>{formatShare(r.mine)}</td>
              <td>{formatShare(r.refine)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ShareButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hud-label text-dim underline decoration-line-strong underline-offset-4 hover:text-ink"
    >
      {label}
    </button>
  )
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
}

function citation(model: ChokepointModel): string {
  return (
    `MineralFlows. "${model.mineralName}: where it is mined versus where it is refined, ${model.year}." ` +
    `Data: USGS Mineral Commodity Summaries (public domain), contained metal` +
    `${model.estimated ? ', newest year an estimate' : ''}. ${window.location.origin}${window.location.pathname}`
  )
}

function downloadCsv(model: ChokepointModel) {
  const blob = new Blob([toCsv(model)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `mineralflows-${model.mineralId}-${model.year}.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function roleOf(row: CountryRow): string {
  const gap = row.refine - row.mine
  if (gap > 0.03) return 'Makes more metal than it digs: a net importer of ore.'
  if (gap < -0.03) return 'Digs more than it refines: ships ore to others.'
  return 'Roughly balanced between mining and refining.'
}

function StopButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="hud-label px-1 py-1 transition-colors"
      style={{ color: active ? 'var(--mf-text)' : 'var(--mf-muted)' }}
    >
      {label}
    </button>
  )
}

function GapRow({
  row,
  t,
  axisMax,
  active,
  off,
  onToggle,
}: {
  row: CountryRow
  t: number
  axisMax: number
  active: boolean
  off: boolean
  onToggle: (iso3: string) => void
}) {
  const pos = (share: number) => `${(share / axisMax) * 100}%`
  const now = lerp(row.mine, row.refine, t)
  const lo = Math.min(row.mine, row.refine)
  const hi = Math.max(row.mine, row.refine)
  return (
    <li>
      <button
        type="button"
        onClick={() => onToggle(row.iso3)}
        aria-pressed={off}
        title={off ? `Bring ${row.name} back` : `Switch ${row.name} off`}
        className="grid w-full cursor-pointer grid-cols-[5.2rem_1fr_2.3rem] items-center gap-2 text-left"
        style={{ opacity: off ? 0.45 : active ? 1 : 0.92 }}
      >
        <span
          className={`truncate text-[0.72rem] ${active ? 'text-ink' : 'text-dim'}`}
          style={{ textDecoration: off ? 'line-through' : 'none' }}
        >
          {row.name}
        </span>
        <span className="relative block h-3">
          <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line-strong" />
          <span
            className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full"
            style={{
              left: pos(lo),
              width: `calc(${pos(hi)} - ${pos(lo)})`,
              background: 'rgba(208, 122, 69, 0.3)',
            }}
          />
          <i
            className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border"
            style={{
              left: pos(row.mine),
              borderColor: `rgb(${ORE_RGB})`,
              background: 'var(--mf-surface)',
            }}
          />
          <i
            className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ left: pos(row.refine), background: `rgb(${COPPER_RGB})` }}
          />
          <i
            className="absolute top-1/2 h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{
              left: pos(now),
              background: `rgb(${mix(t).join(',')})`,
            }}
          />
        </span>
        <span className="text-right text-[0.72rem] text-ink tabular-nums">{formatShare(now)}</span>
      </button>
    </li>
  )
}

/* --------------------------------------------------------------------- draw */

function draw(
  canvas: HTMLCanvasElement,
  layout: Layout,
  model: ChokepointModel,
  rows: Map<string, CountryRow>,
  maxShare: number,
  t: number,
  now: number,
  hoverIso: string | null,
  offIso: string | null,
) {
  const { width, height, dpr } = layout
  const g = canvas.getContext('2d')!
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.clearRect(0, 0, canvas.width, canvas.height)
  g.drawImage(layout.base, 0, 0, canvas.width, canvas.height)
  g.setTransform(dpr, 0, 0, dpr, 0, 0)

  const e = smooth(t)
  const [cr, cg, cb] = mix(e)

  // Countries, lit by how much of the world's output they hold right now.
  for (const row of rows.values()) {
    const p2d = layout.paths.get(row.iso3)
    if (!p2d) continue
    if (row.iso3 === offIso) {
      g.fillStyle = 'rgba(13, 11, 10, 0.92)'
      g.fill(p2d)
      g.setLineDash([5, 4])
      g.strokeStyle = 'rgba(255, 122, 107, 0.85)'
      g.lineWidth = 1.2
      g.stroke(p2d)
      g.setLineDash([])
      continue
    }
    const share = lerp(row.mine, row.refine, e)
    const k = Math.sqrt(share / maxShare)
    g.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.06 + 0.5 * k})`
    g.fill(p2d)
    if (k > 0.3) {
      g.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.18 + 0.5 * k})`
      g.lineWidth = 0.9
      g.stroke(p2d)
    }
  }

  // Additive glow: each country's bubble, sized by sqrt of its share.
  g.globalCompositeOperation = 'lighter'
  const rMax = Math.min(width, height) * (width < 640 ? 0.13 : 0.1)
  for (const row of rows.values()) {
    if (row.iso3 === offIso) continue
    const anchor = layout.anchors.get(row.iso3)
    if (!anchor) continue
    const share = lerp(row.mine, row.refine, e)
    const k = Math.sqrt(share / maxShare)
    if (k < 0.08) continue
    const r = rMax * k
    const grad = g.createRadialGradient(anchor[0], anchor[1], 0, anchor[0], anchor[1], r)
    grad.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, ${0.26 * k + 0.05})`)
    grad.addColorStop(0.5, `rgba(${cr}, ${cg}, ${cb}, ${0.07 * k})`)
    grad.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0)`)
    g.fillStyle = grad
    g.beginPath()
    g.arc(anchor[0], anchor[1], r, 0, Math.PI * 2)
    g.fill()
  }

  // Sites: mines fade out as smelters and refineries fade in.
  const mineAlpha = 1 - smooth(clamp01(t / 0.7))
  const plantAlpha = smooth(clamp01((t - 0.3) / 0.7))
  for (const site of layout.sites) {
    if (site.iso3 === offIso) continue
    const a = (site.stage === 'mine' ? mineAlpha : plantAlpha) * (site.low ? 0.45 : 1)
    if (a < 0.02) continue
    const size = site.stage === 'refine' ? 2.2 : site.stage === 'process' ? 1.9 : 1.3
    g.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.78 * a})`
    g.beginPath()
    g.arc(site.x, site.y, size, 0, Math.PI * 2)
    g.fill()
  }

  // Ore on the move: the mine-to-smelter leg, swept across the map mid-morph.
  const sweep = clamp01(t / 0.62)
  const fade = Math.sin(Math.PI * clamp01(t)) ** 0.7
  if (fade > 0.01) {
    const maxValue = Math.max(...model.ore.map((o) => o.valueUsd), 1)
    for (const route of model.ore) {
      if (route.from === offIso || route.to === offIso) continue
      const a = layout.anchors.get(route.from) ?? null
      const b = layout.anchors.get(route.to) ?? null
      if (!a || !b) continue
      const c = arcControl(a, b)
      const w = 0.6 + 2.6 * Math.sqrt(route.valueUsd / maxValue)
      const steps = 40
      const upTo = Math.max(1, Math.floor(steps * sweep))
      g.beginPath()
      for (let i = 0; i <= upTo; i++) {
        const [x, y] = quadAt(a, c, b, i / steps)
        if (i === 0) g.moveTo(x, y)
        else g.lineTo(x, y)
      }
      g.strokeStyle = `rgba(232, 200, 120, ${(route.mirrored ? 0.22 : 0.5) * fade})`
      g.lineWidth = w
      g.lineCap = 'round'
      g.stroke()
      // The head of the shipment.
      const head = quadAt(a, c, b, upTo / steps)
      const glow = g.createRadialGradient(head[0], head[1], 0, head[0], head[1], 3 + w)
      glow.addColorStop(0, `rgba(255, 240, 214, ${0.95 * fade})`)
      glow.addColorStop(1, 'rgba(255, 240, 214, 0)')
      g.fillStyle = glow
      g.beginPath()
      g.arc(head[0], head[1], 3 + w, 0, Math.PI * 2)
      g.fill()
    }
  }
  g.globalCompositeOperation = 'source-over'

  // Hover and pin outline.
  for (const iso of new Set([hoverIso])) {
    const p2d = iso ? layout.paths.get(iso) : undefined
    if (!p2d) continue
    g.strokeStyle = `rgba(${ACCENT}, 0.95)`
    g.lineWidth = 1.5
    g.stroke(p2d)
  }

  // Labels: the biggest players, placed greedily so they never collide.
  const labelled: { x: number; y: number; w: number; h: number }[] = []
  const ordered = [...rows.values()]
    .map((r) => ({ r, share: lerp(r.mine, r.refine, e) }))
    .sort((a, b) => b.share - a.share)
  g.textBaseline = 'middle'
  if (offIso) {
    const row = rows.get(offIso)
    const anchor = layout.anchors.get(offIso)
    if (row && anchor) {
      const lost = e < 0.5 ? row.mine : row.refine
      const text = `${row.name.toUpperCase()}  OFF  −${formatShare(lost)}`
      g.font = `500 ${width < 640 ? 9 : 10.5}px ${FONT_MONO}`
      const w = g.measureText(text).width
      g.fillStyle = 'rgba(13, 11, 10, 0.8)'
      g.fillRect(anchor[0] - w / 2 - 4, anchor[1] - 8, w + 8, 16)
      g.fillStyle = '#ff7a6b'
      g.textAlign = 'left'
      g.fillText(text, anchor[0] - w / 2, anchor[1])
    }
  }
  for (const { r, share } of ordered) {
    if (r.iso3 === offIso) continue
    if (share < 0.035) break
    const anchor = layout.anchors.get(r.iso3)
    if (!anchor) continue
    const text = `${r.name.toUpperCase()}  ${formatShare(share)}`
    g.font = `500 ${width < 640 ? 9 : 10.5}px ${FONT_MONO}`
    const w = g.measureText(text).width
    const box = { x: anchor[0] - w / 2, y: anchor[1] - 22, w, h: 14 }
    if (
      labelled.some(
        (o) =>
          box.x < o.x + o.w + 6 &&
          box.x + box.w + 6 > o.x &&
          box.y < o.y + o.h + 3 &&
          box.y + box.h + 3 > o.y,
      )
    )
      continue
    labelled.push(box)
    g.fillStyle = 'rgba(13, 11, 10, 0.64)'
    g.fillRect(box.x - 4, box.y - 1, box.w + 8, box.h + 2)
    g.fillStyle = r.iso3 === model.leader.iso3 && e > 0.5 ? '#fff6ea' : 'rgba(239, 231, 220, 0.92)'
    g.textAlign = 'left'
    g.fillText(text, box.x, box.y + box.h / 2)
  }
  void now
}
