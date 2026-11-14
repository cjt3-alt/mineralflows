import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ExploreMapHandle, Lens } from '../map/ExploreMap.tsx'
import type { ChokepointModel } from '../data/chokepoint.ts'
import { formatShare, shockOf, toCsv } from '../data/chokepoint.ts'
import { formatUsd, type ArcDatum, type PointDatum } from '../data/derive.ts'
import type { Country } from '../data/schema.ts'
import type { RepositionedSite } from '../data/load.ts'
import { DetailPanel, type Selection } from './DetailPanel.tsx'
import type { Mineral, Price } from '../data/schema.ts'

const ExploreMap = lazy(() => import('../map/ExploreMap.tsx').then((m) => ({ default: m.ExploreMap })))

/**
 * The explorer: one map, three lenses, and a short guided opening that hands
 * the map over. Everything the viewer can do lives here: switch lens, search,
 * jump somewhere at random, turn satellite on, click into a country, a mine or
 * a route.
 */

export interface ExplorerViewProps {
  lens: Lens
  onChangeLens: (lens: Lens) => void
  /** One model per year, oldest first; the last is the newest. Empty when the story cannot be told. */
  models: ChokepointModel[]
  /** Annual average prices, for the timeline. */
  priceHistory: Price[]
  points: PointDatum[]
  /** Sites whose dot was moved onto their mining outline. */
  repositioned: ReadonlyMap<string, RepositionedSite>
  arcs: ArcDatum[]
  countries: Record<string, Country>
  mineralsById: ReadonlyMap<string, Mineral>
  selection: Selection | null
  selectedId: string | null
  focusCountry: string | null
  reducedMotion: boolean
  compact: boolean
  /** Whether the guided opening should play. */
  playIntro: boolean
  onSelectPoint: (point: PointDatum) => void
  onSelectArc: (arc: ArcDatum) => void
  onFocusCountry: (iso3: string) => void
  onClearSelection: () => void
  onClosePanel: () => void
}

/** What a route carries, in a word. */
const KIND_SHORT = { mine: 'ore', process: 'smelted', refine: 'refined' } as const

const LENSES: { id: Lens; label: string; short: string }[] = [
  { id: 'mined', label: 'Mined', short: 'Mined' },
  { id: 'refined', label: 'Refined', short: 'Refined' },
  { id: 'trade', label: 'Trade routes', short: 'Trade' },
]

/** Guided opening: what each beat says, how long it holds, and where the camera goes. */
interface Beat {
  lens: Lens
  holdMs: number
  fly: { lng: number; lat: number; zoom: number } | null
}

const BEATS: Beat[] = [
  { lens: 'mined', holdMs: 4800, fly: null },
  { lens: 'refined', holdMs: 6200, fly: { lng: 104, lat: 32, zoom: 3.1 } },
  { lens: 'trade', holdMs: 5600, fly: { lng: 40, lat: 24, zoom: 1.9 } },
]

function percentWord(share: number): string {
  return formatShare(share)
}

/** Plain-language read of a Herfindahl-Hirschman index, on the 0..10,000 scale. */
function hhiWord(hhi: number): string {
  if (hhi >= 2500) return 'highly concentrated'
  if (hhi >= 1500) return 'moderately concentrated'
  return 'fairly spread out'
}

function beatCopy(model: ChokepointModel, index: number): { eyebrow: string; headline: string; line: string } {
  const mined = [...model.rows].sort((a, b) => b.mine - a.mine)
  const leader = model.leader
  const metal = model.mineralName.toLowerCase()
  if (index === 0) {
    const top = mined.slice(0, 3).map((r) => r.name)
    return {
      eyebrow: `01 / ${model.mineralName} is dug up`,
      headline: `Where ${metal} comes out of the ground.`,
      line: `${top[0]}, ${top[1]} and ${top[2]} lead. ${leader.name} mines ${percentWord(leader.mine)}.`,
    }
  }
  if (index === 1) {
    return {
      eyebrow: `02 / ${model.mineralName} becomes metal`,
      headline: `${leader.name} refines ${percentWord(leader.refine)} of it.`,
      line: `It mines only ${percentWord(leader.mine)}. The ore travels to wherever the smelters are.`,
    }
  }
  return {
    eyebrow: `03 / The journey`,
    headline: `Every line is ore on the move.`,
    line: `The thickest routes carry the most money. Drag, zoom, and click anything.`,
  }
}

/** True on screens wide enough to hold the summary plate and a detail panel at once. */
function useRoomForBoth(): boolean {
  const query = '(min-width: 1440px)'
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
  )
}

/** One line on who leads, for places too small for the summary plate. */
function summaryLine(model: ChokepointModel, lens: 'mined' | 'refined'): string {
  const stage = lens === 'refined' ? 'refine' : 'mine'
  const top = [...model.rows].sort((a, b) => b[stage] - a[stage])[0]
  if (!top) return ''
  const conc = lens === 'refined' ? model.refineConcentration : model.mineConcentration
  return `${top.name} ${percentWord(top[stage])} of world ${lens === 'refined' ? 'refining' : 'mining'}. The top three hold ${percentWord(conc.top3)}.`
}

/* ------------------------------------------------------------------ pieces */

function LensButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className="hud-label relative whitespace-nowrap px-3 py-2 transition-colors sm:px-3.5"
      style={{
        color: active ? 'var(--mf-void)' : 'var(--mf-text-dim)',
        background: active ? 'var(--mf-accent)' : 'transparent',
      }}
    >
      {children}
    </button>
  )
}

interface SearchHit {
  key: string
  label: string
  sub: string
  run: () => void
}

function SearchBox({
  countries,
  places,
  points,
  onCountry,
  onPoint,
}: {
  countries: Record<string, Country>
  places: string[]
  points: PointDatum[]
  onCountry: (iso3: string) => void
  onPoint: (p: PointDatum) => void
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const hits = useMemo((): SearchHit[] => {
    const needle = q.trim().toLowerCase()
    if (needle.length < 2) return []
    const out: SearchHit[] = []
    for (const iso3 of places) {
      const c = countries[iso3]
      if (c && c.name.toLowerCase().includes(needle)) {
        out.push({ key: 'c' + iso3, label: c.name, sub: 'Country', run: () => onCountry(iso3) })
      }
    }
    for (const p of points) {
      const f = p.facility.properties
      if (out.length >= 9) break
      if (f.name.toLowerCase().includes(needle) || (f.operator ?? '').toLowerCase().includes(needle)) {
        const kind = f.stage === 'mine' ? 'Mine' : f.stage === 'refine' ? 'Refinery' : 'Smelter'
        out.push({
          key: p.id,
          label: f.name,
          sub: `${kind} · ${countries[f.country_iso3]?.name ?? f.country_iso3}`,
          run: () => onPoint(p),
        })
      }
    }
    return out.slice(0, 8)
  }, [q, places, points, countries, onCountry, onPoint])

  return (
    <div className="relative">
      <label className="sr-only" htmlFor="mf-search">
        Search countries, mines and refineries
      </label>
      <input
        id="mf-search"
        type="search"
        value={q}
        placeholder="Search a country, mine or refinery"
        autoComplete="off"
        onChange={(e) => {
          setQ(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 140)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && hits[0]) {
            hits[0].run()
            setQ('')
            ;(e.target as HTMLInputElement).blur()
          }
          if (e.key === 'Escape') (e.target as HTMLInputElement).blur()
        }}
        className="w-full border border-line-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-muted focus:border-accent focus:outline-none sm:w-72"
      />
      {open && hits.length > 0 && (
        <ul className="panel absolute top-full right-0 left-0 z-30 mt-1 max-h-72 overflow-y-auto py-1" role="listbox">
          {hits.map((h) => (
            <li key={h.key} role="option" aria-selected={false}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  h.run()
                  setQ('')
                  setOpen(false)
                }}
                className="flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left hover:bg-accent/10"
              >
                <span className="truncate text-[13px] text-ink">{h.label}</span>
                <span className="shrink-0 text-[11px] text-muted">{h.sub}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Bar({ share, color }: { share: number; color: string }) {
  return (
    <span className="relative h-[3px] w-full bg-line">
      <span
        className="absolute inset-y-0 left-0"
        style={{ width: `${Math.max(1.5, Math.min(100, share * 100))}%`, backgroundColor: color }}
      />
    </span>
  )
}

function LensPanel({
  lens,
  model,
  arcs,
  countries,
  focusCountry,
  onFocusCountry,
  onSelectArc,
  onHide,
  models,
  prices,
  playing,
  onTogglePlay,
  onYear,
}: {
  lens: Lens
  model: ChokepointModel
  models: ChokepointModel[]
  prices: Price[]
  playing: boolean
  onTogglePlay: () => void
  onYear: (year: number) => void
  arcs: ArcDatum[]
  countries: Record<string, Country>
  focusCountry: string | null
  onFocusCountry: (iso3: string) => void
  onSelectArc: (arc: ArcDatum) => void
  onHide: () => void
}) {
  const stage = lens === 'refined' ? 'refine' : 'mine'
  const rows = useMemo(
    () => [...model.rows].sort((a, b) => b[stage] - a[stage]).slice(0, 8),
    [model.rows, stage],
  )
  const conc = lens === 'refined' ? model.refineConcentration : model.mineConcentration
  const color = lens === 'refined' ? 'var(--mf-copper)' : 'var(--mf-ore)'
  const name = (iso3: string) => countries[iso3]?.name ?? iso3
  const [copied, setCopied] = useState(false)
  const first = rows[0]
  // The country that leads in the newest year, and how its share moved over the whole period.
  const newest = models[models.length - 1]
  const oldest = models[0]
  const leaderIso = newest ? [...newest.rows].sort((a, b) => b[stage] - a[stage])[0]?.iso3 : undefined
  const trend =
    newest && oldest && leaderIso
      ? {
          name: countries[leaderIso]?.name ?? leaderIso,
          from: oldest.rows.find((r) => r.iso3 === leaderIso)?.[stage] ?? 0,
          to: newest.rows.find((r) => r.iso3 === leaderIso)?.[stage] ?? 0,
        }
      : null
  const price = prices.find((p) => p.mineral_id === model.mineralId && p.year === model.year)

  const download = useCallback(() => {
    const blob = new Blob([toCsv(model)], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${model.mineralId}-mined-vs-refined-${model.year}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }, [model])

  const copyLink = useCallback(() => {
    void navigator.clipboard?.writeText(window.location.href).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    })
  }, [])

  return (
    <aside className="panel scroll-quiet max-h-full w-[20.5rem] overflow-y-auto p-5" aria-label="Summary">
      <p className="hud-label text-muted">
        {model.mineralName} · {lens === 'trade' ? 'trade routes' : lens === 'refined' ? 'refined' : 'mined'} ·{' '}
        {model.year}
        {model.estimated ? ' est.' : ''}
      </p>

      {lens !== 'trade' && models.length > 1 && (
        <div className="mt-3">
          <div className="flex items-center gap-1" role="group" aria-label="Year">
            <button
              type="button"
              onClick={onTogglePlay}
              aria-label={playing ? 'Pause the timeline' : 'Play the timeline'}
              className="hud-label mr-1 w-8 border border-line-strong py-1 text-center text-dim hover:border-accent hover:text-ink"
            >
              {playing ? 'II' : '▶'}
            </button>
            {models.map((m) => (
              <button
                key={m.year}
                type="button"
                aria-pressed={m.year === model.year}
                onClick={() => onYear(m.year)}
                className={
                  'hud-label flex-1 border py-1 text-center tabular-nums ' +
                  (m.year === model.year
                    ? 'border-accent bg-accent/10 text-ink'
                    : 'border-line text-muted hover:border-line-strong hover:text-ink')
                }
              >
                {String(m.year).slice(2)}
                {m.estimated ? '*' : ''}
              </button>
            ))}
          </div>
          {trend && (
            <p className="mt-2 text-xs leading-snug text-muted">
              {trend.name}: {percentWord(trend.from)} in {models[0]!.year}, {percentWord(trend.to)} in{' '}
              {models[models.length - 1]!.year}.
            </p>
          )}
        </div>
      )}

      {lens === 'trade' ? (
        <>
          <h2 className="font-display mt-2 text-[1.4rem] leading-[1.1] text-ink">Where the ore goes</h2>
          <p className="font-serif mt-2 text-[15px] leading-snug text-dim">
            The biggest {Math.min(arcs.length, 8)} routes by value. Click one to see who ships to whom.
          </p>
          <ol className="mt-4 flex flex-col">
            {arcs.slice(0, 8).map((arc, i) => (
              <li key={arc.id}>
                <button
                  type="button"
                  onClick={() => onSelectArc(arc)}
                  className="grid w-full grid-cols-[1.25rem_1fr_auto] items-baseline gap-x-2 border-l-2 border-transparent px-2 py-1.5 text-left hover:bg-accent/5"
                >
                  <span className="font-mono text-xs text-muted">{String(i + 1).padStart(2, '0')}</span>
                  <span className="truncate text-[13px] text-ink">
                    {name(arc.flow.from_iso3)} <span className="text-muted">→</span> {name(arc.flow.to_iso3)}{' '}
                    <span className="text-[11px] text-muted">{KIND_SHORT[arc.kind]}</span>
                  </span>
                  <span className="font-mono text-xs text-ink">
                    {formatUsd(arc.value.usd)}
                    {arc.value.estimated && <span className="text-alert">*</span>}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <>
          <h2 className="font-display mt-2 text-[1.4rem] leading-[1.1] text-ink">
            {first ? `${first.name}: ${percentWord(first[stage])}` : ''}
          </h2>
          <p className="font-serif mt-2 text-[15px] leading-snug text-dim">
            The top three hold {percentWord(conc.top3)} of world {lens === 'refined' ? 'refining' : 'mining'}. It is{' '}
            {hhiWord(conc.hhi)}.
          </p>
          <ol className="mt-4 flex flex-col">
            {rows.map((r, i) => (
              <li key={r.iso3}>
                <button
                  type="button"
                  onClick={() => onFocusCountry(r.iso3)}
                  className={
                    'grid w-full grid-cols-[1.25rem_1fr_auto] items-baseline gap-x-2 border-l-2 px-2 py-1.5 text-left hover:bg-accent/5 ' +
                    (focusCountry === r.iso3 ? 'border-accent bg-accent/10' : 'border-transparent')
                  }
                >
                  <span className="font-mono text-xs text-muted">{String(i + 1).padStart(2, '0')}</span>
                  <span className="truncate text-[13px] text-ink">{r.name}</span>
                  <span className="font-mono text-xs text-ink">{percentWord(r[stage])}</span>
                  <span />
                  <span className="col-span-2 mt-1 flex">
                    <Bar share={r[stage] / (rows[0]?.[stage] || 1)} color={color} />
                  </span>
                </button>
              </li>
            ))}
          </ol>
          {first && (
            <p className="mt-3 border-t border-line pt-3 text-xs leading-relaxed text-muted">
              Lose {first.name}'s {lens === 'refined' ? 'refining' : 'mining'} and{' '}
              {percentWord(shockOf(first, stage).lostShare)} of the world's supply goes with it; everyone else would
              need to raise output {Math.round(shockOf(first, stage).uplift * 100)}% to cover it. Output, not
              capacity, so this measures dependence, not a forecast.
            </p>
          )}
        </>
      )}

      {price && lens !== 'trade' && (
        <p className="mt-3 text-xs leading-snug text-muted">
          {model.mineralName} averaged ${Math.round(price.avg_price_usd_per_tonne).toLocaleString('en-US')} a tonne
          in {price.year} (World Bank).
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3">
        <button type="button" onClick={download} className="hud-label text-dim hover:text-ink">
          CSV
        </button>
        <button type="button" onClick={copyLink} className="hud-label text-dim hover:text-ink">
          {copied ? 'Copied' : 'Copy link'}
        </button>
        <a href={model.sourceUrl} target="_blank" rel="noreferrer" className="hud-label text-muted hover:text-ink">
          USGS
        </a>
        <button type="button" onClick={onHide} className="hud-label ml-auto text-muted hover:text-ink">
          Hide
        </button>
      </div>
    </aside>
  )
}

/* -------------------------------------------------------------------- view */

export function ExplorerView(props: ExplorerViewProps) {
  const {
    lens,
    onChangeLens,
    models,
    priceHistory,
    points,
    repositioned,
    arcs,
    countries,
    mineralsById,
    selection,
    selectedId,
    focusCountry,
    reducedMotion,
    compact,
    onSelectPoint,
    onSelectArc,
    onFocusCountry,
    onClearSelection,
    onClosePanel,
  } = props
  const mapRef = useRef<ExploreMapHandle>(null)
  const [satellite, setSatellite] = useState(false)
  const [mapReady, setMapReady] = useState(false)
  // -1 means the opening is over (or never played).
  const latest = models[models.length - 1] ?? null
  const [beat, setBeat] = useState<number>(props.playIntro && !reducedMotion && latest ? 0 : -1)
  const [year, setYear] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [hint, setHint] = useState(false)
  const [summaryOpen, setSummaryOpen] = useState(true)
  // Asking the camera to go home waits for the next render, so it sees the panel insets as they will be, not as they were.
  const homeRequest = useRef<{ lens: Lens; duration: number } | null>(null)
  const [homeTick, setHomeTick] = useState(0)
  const setHomeRequest = useCallback((r: { lens: Lens; duration: number }) => {
    homeRequest.current = r
    setHomeTick((t) => t + 1)
  }, [])

  const introOn = beat >= 0
  // The opening always tells the newest year; afterwards the viewer chooses.
  const model = (introOn || year === null ? latest : models.find((m) => m.year === year)) ?? latest

  // Play steps through the years once, then stops on the newest.
  useEffect(() => {
    if (!playing || !model) return
    const i = models.indexOf(model)
    const t = window.setTimeout(
      () => {
        const next = models[i + 1]
        if (next) setYear(next.year)
        else setPlaying(false)
      },
      i + 1 < models.length ? 1500 : 600,
    )
    return () => window.clearTimeout(t)
  }, [playing, model, models])

  const onTogglePlay = useCallback(() => {
    if (playing) {
      setPlaying(false)
      return
    }
    // From the newest year, play starts again from the oldest.
    if (models.length > 0 && model === models[models.length - 1]) setYear(models[0]!.year)
    setPlaying(true)
  }, [playing, models, model])

  /* The mine footprints load once the map is up; they are about 1 MB and nothing needs them before then. */
  const [outlines, setOutlines] = useState<GeoJSON.FeatureCollection | null>(null)
  useEffect(() => {
    if (!mapReady) return
    let off = false
    const base = import.meta.env.BASE_URL
    fetch((base.endsWith('/') ? base : base + '/') + 'data/outlines.geojson')
      .then((r) => (r.ok ? r.json() : null))
      .then((json: GeoJSON.FeatureCollection | null) => {
        if (!off && json && Array.isArray(json.features)) setOutlines(json)
      })
      .catch(() => {})
    return () => {
      off = true
    }
  }, [mapReady])

  const footprints = useMemo(() => {
    const out = new Map<string, { km2: number; shared: boolean }>()
    for (const f of outlines?.features ?? []) {
      const props = f.properties as { area_km2: number; facility_ids: string[] } | null
      if (!props) continue
      for (const id of props.facility_ids) {
        const prev = out.get(id)
        out.set(id, {
          km2: (prev?.km2 ?? 0) + props.area_km2,
          shared: (prev?.shared ?? false) || props.facility_ids.length > 1,
        })
      }
    }
    return out
  }, [outlines])

  const labelCountries = useMemo(() => {
    const seen = new Map<string, string>()
    for (const m of models) {
      for (const r of m.rows) {
        if (r.mine >= 0.015 || r.refine >= 0.015) seen.set(r.iso3, r.name)
      }
    }
    return [...seen].map(([iso3, name]) => ({ iso3, name }))
  }, [models])
  const roomForBoth = useRoomForBoth()
  // On a narrower screen the detail panel takes the summary's place rather than crowding the map.
  const showSummary = summaryOpen && !introOn && !compact && (selection === null || roomForBoth)

  useEffect(() => {
    const request = homeRequest.current
    homeRequest.current = null
    if (request) mapRef.current?.home(request)
  }, [homeTick])

  /* The guided opening: each beat sets the lens, moves the camera, holds, moves on. */
  useEffect(() => {
    if (!introOn || !mapReady) return
    const b = BEATS[beat]
    if (!b) return
    onChangeLens(b.lens)
    if (b.fly) mapRef.current?.flyTo({ ...b.fly, duration: 3200 })
    const timer = window.setTimeout(() => {
      if (beat + 1 < BEATS.length) setBeat(beat + 1)
      else {
        setBeat(-1)
        onChangeLens('mined')
        setHomeRequest({ duration: 2600, lens: 'mined' })
        setHint(true)
      }
    }, b.holdMs)
    return () => window.clearTimeout(timer)
    // The beat index is the only thing that should restart the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beat, introOn, mapReady])

  useEffect(() => {
    if (!hint) return
    const t = window.setTimeout(() => setHint(false), 7000)
    return () => window.clearTimeout(t)
  }, [hint])

  const skipIntro = useCallback(() => {
    if (beat < 0) return
    setBeat(-1)
    onChangeLens('mined')
    setHomeRequest({ duration: 1400, lens: 'mined' })
    setHint(true)
  }, [beat, onChangeLens, setHomeRequest])

  const replayIntro = useCallback(() => {
    onClearSelection()
    setHint(false)
    setYear(null)
    setPlaying(false)
    setBeat(0)
  }, [onClearSelection])

  const pickLens = useCallback(
    (next: Lens) => {
      if (introOn) setBeat(-1)
      setHint(false)
      onChangeLens(next)
      // Bring the lens's subject into view, unless someone is looking at a particular place.
      if (introOn || (selection === null && focusCountry === null)) {
        setHomeRequest({ duration: 1800, lens: next })
      }
    },
    [introOn, onChangeLens, selection, focusCountry, setHomeRequest],
  )

  const goToPoint = useCallback(
    (p: PointDatum, zoom = 11.5) => {
      if (introOn) setBeat(-1)
      onSelectPoint(p)
      mapRef.current?.flyTo({ lng: p.lng, lat: p.lat, zoom })
    },
    [introOn, onSelectPoint],
  )

  const surprise = useCallback(() => {
    if (points.length === 0) return
    // Pick the kind of place first so refineries, which are rare, come up as often as mines.
    const kinds = ['mine', 'process', 'refine'] as const
    const kind = kinds[Math.floor(Math.random() * kinds.length)]!
    const pool = points.filter((p) => p.stage === kind && p.confidence === 'high')
    const from = pool.length > 0 ? pool : points
    const p = from[Math.floor(Math.random() * from.length)]!
    setSatellite(true)
    goToPoint(p, 12.5)
  }, [points, goToPoint])

  const countryChosen = useCallback(
    (iso3: string) => {
      if (introOn) setBeat(-1)
      setHint(false)
      onFocusCountry(iso3)
    },
    [introOn, onFocusCountry],
  )

  const placeList = useMemo(() => {
    const set = new Set<string>()
    for (const p of points) set.add(p.facility.properties.country_iso3)
    for (const r of model?.rows ?? []) set.add(r.iso3)
    return [...set]
  }, [points, model])

  // Panels sit over the map; flights land in the clear part.
  const panelOpen = selection !== null
  const insets = {
    left: showSummary ? 20.5 * 16 + 40 : 0,
    right: compact ? 0 : panelOpen ? 23 * 16 + 24 : 0,
    top: compact ? 215 : 70,
    bottom: compact ? 120 : introOn ? 230 : 20,
  }

  const copy = latest && introOn ? beatCopy(latest, beat) : null

  return (
    <div className="absolute inset-0" onPointerDownCapture={() => introOn && skipIntro()}>
      <Suspense fallback={null}>
        <ExploreMap
          ref={mapRef}
          lens={lens}
          model={model}
          labelCountries={labelCountries}
          outlines={outlines}
          points={points}
          arcs={arcs}
          selectedId={selectedId}
          focusCountry={focusCountry}
          reducedMotion={reducedMotion}
          insets={insets}
          satellite={satellite}
          onSelectPoint={(p) => goToPoint(p, Math.max(9, mapRef.current?.getZoom() ?? 0))}
          onSelectArc={onSelectArc}
          onSelectCountry={countryChosen}
          onClearSelection={onClearSelection}
          onReady={() => setMapReady(true)}
        />
      </Suspense>

      {/* Controls: lens, search, and the two ways to wander. */}
      <div
        className="pointer-events-none absolute top-5 right-4 left-4 z-20 flex flex-wrap items-start gap-2 sm:top-7 sm:right-8 sm:left-8"
        onPointerDownCapture={(e) => e.stopPropagation()}
      >
        <div
          role="group"
          aria-label="What the map shows"
          className="panel pointer-events-auto flex items-stretch p-0.5"
        >
          {LENSES.map((l) => (
            <LensButton key={l.id} active={lens === l.id} onClick={() => pickLens(l.id)}>
              {compact ? l.short : l.label}
            </LensButton>
          ))}
        </div>

        <div className="pointer-events-auto flex gap-2">
          <button
            type="button"
            aria-pressed={satellite}
            onClick={() => setSatellite((s) => !s)}
            className="hud-label border border-line-strong bg-surface px-3 py-2 text-dim transition-colors hover:text-ink aria-pressed:border-accent aria-pressed:text-accent"
          >
            Satellite
          </button>
          <button
            type="button"
            onClick={surprise}
            className="hud-label border border-line-strong bg-surface px-3 py-2 text-dim transition-colors hover:border-accent hover:text-ink"
          >
            {compact ? 'Surprise me' : 'Take me somewhere'}
          </button>
        </div>

        <div className="pointer-events-auto ml-auto w-full sm:w-auto">
          <SearchBox
            countries={countries}
            places={placeList}
            points={points}
            onCountry={countryChosen}
            onPoint={(p) => goToPoint(p)}
          />
        </div>
      </div>

      {/* Summary plate for the current lens. */}
      {model && !introOn && !compact && !summaryOpen && selection === null && (
        <button
          type="button"
          onClick={() => setSummaryOpen(true)}
          className="hud-label absolute top-[5.75rem] left-8 z-10 border border-line-strong bg-surface px-3 py-2 text-dim hover:border-accent hover:text-ink"
        >
          Show summary
        </button>
      )}
      {model && showSummary && (
        <div className="pointer-events-none absolute top-[5.75rem] bottom-16 left-8 z-10 flex">
          <div className="pointer-events-auto flex max-h-full">
            <LensPanel
              lens={lens}
              model={model}
              arcs={arcs}
              countries={countries}
              focusCountry={focusCountry}
              onFocusCountry={countryChosen}
              onSelectArc={onSelectArc}
              onHide={() => setSummaryOpen(false)}
              models={models}
              prices={priceHistory}
              playing={playing}
              onTogglePlay={onTogglePlay}
              onYear={(y) => {
                setPlaying(false)
                setYear(y)
              }}
            />
          </div>
        </div>
      )}

      {/* On a phone the summary plate would cover the map, so the headline number rides along as one line. */}
      {model && !introOn && compact && selection === null && lens !== 'trade' && (
        <p className="panel pointer-events-none absolute right-20 bottom-4 left-4 z-10 px-3 py-2 text-[13px] leading-snug text-ink">
          {summaryLine(model, lens)}
        </p>
      )}

      {/* The guided opening's words. */}
      {copy && (
        <div
          key={beat}
          className="mf-intro pointer-events-none absolute bottom-16 left-4 z-10 max-w-[38rem] sm:bottom-20 sm:left-8"
        >
          <p className="hud-label text-accent">{copy.eyebrow}</p>
          <h2
            className="font-display mt-2 text-ink"
            style={{ fontSize: 'clamp(1.9rem, 4.4vw, 3.6rem)', lineHeight: 1.02, textWrap: 'balance' as never }}
          >
            {copy.headline}
          </h2>
          <p className="font-serif mt-3 max-w-[30rem] text-[1.05rem] leading-snug text-dim">{copy.line}</p>
        </div>
      )}

      {introOn && (
        <div className="absolute right-4 bottom-16 z-20 flex items-center gap-4 sm:right-8 sm:bottom-20">
          <div className="flex gap-1.5" aria-hidden="true">
            {BEATS.map((_, i) => (
              <span
                key={i}
                className="h-[3px] w-8"
                style={{ background: i <= beat ? 'var(--mf-accent)' : 'var(--mf-line-strong)' }}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={skipIntro}
            className="hud-label border border-line-strong bg-surface px-3 py-2 text-dim hover:border-accent hover:text-ink"
          >
            Skip to the map
          </button>
        </div>
      )}

      {hint && !introOn && (
        <p className="mf-intro panel hud-label pointer-events-none absolute bottom-16 left-1/2 z-10 -translate-x-1/2 px-4 py-2 text-dim">
          Your turn. Drag anywhere, zoom in on a mine, click a country.
        </p>
      )}

      {!introOn && model && props.playIntro !== undefined && (
        <button
          type="button"
          onClick={replayIntro}
          className="hud-label absolute bottom-3 left-4 z-10 hidden text-muted hover:text-ink sm:left-8 sm:block"
          style={{ bottom: '2.6rem' }}
        >
          Replay the intro
        </button>
      )}

      <DetailPanel
        variant={compact ? 'sheet' : 'panel'}
        selection={selection}
        mineralsById={mineralsById}
        countries={countries}
        onClose={onClosePanel}
        onFocusCountry={countryChosen}
        sites={points}
        footprints={footprints}
        repositioned={repositioned}
        onSelectSite={(p) => goToPoint(p, 11.5)}
      />
    </div>
  )
}
