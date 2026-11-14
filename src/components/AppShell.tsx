import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ExplorerView } from './ExplorerView.tsx'
import type { Lens } from '../map/ExploreMap.tsx'
import { buildChokepointSeries } from '../data/chokepoint.ts'
import { TopBar } from './TopBar.tsx'
import type { Selection } from './DetailPanel.tsx'
import { StatusBar } from './LegendBar.tsx'
import { AboutDialog } from './AboutDialog.tsx'
import { loadDataset, type Dataset } from '../data/load.ts'
import {
  EMPTY_FILTERS,
  countriesInPlay,
  filterFacilities,
  filterFlows,
  filtersFromSearchParams,
  filtersToSearchParams,
  resolveValue,
  stageShade,
  countryRole,
  summarizeCountry,
  type CountryRole,
  toArcData,
  toPointData,
  valueByKind,
  type ArcDatum,
  type Filters,
  type PointDatum,
} from '../data/derive.ts'
import { STAGES, type Stage } from '../data/schema.ts'

/**
 * Owns data loading, filter state, selection and hover. Everything below it is
 * presentational. Filter state round-trips through the query string so a view
 * is shareable.
 */

type LoadState =
  { status: 'loading' } | { status: 'ready'; dataset: Dataset } | { status: 'error'; error: Error }

type PickedSelection = { kind: 'facility'; point: PointDatum } | { kind: 'flow'; arc: ArcDatum }

function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query])
  return useSyncExternalStore(subscribe, getSnapshot)
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

export function AppShell() {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [selection, setSelection] = useState<PickedSelection | null>(null)
  const [aboutOpen, setAboutOpen] = useState(false)
  // The lens is what the map shows. Old links (?stage=refined, ?view=flows) still land somewhere sensible.
  const [lens, setLens] = useState<Lens>(() => {
    const q = new URLSearchParams(window.location.search)
    const asked = q.get('lens') ?? (q.get('view') === 'flows' ? 'trade' : q.get('stage'))
    return asked === 'refined' || asked === 'trade' ? asked : 'mined'
  })
  // The guided opening plays on a fresh arrival, not when someone shares a link to a particular view.
  const [playIntro] = useState(() => {
    const q = new URLSearchParams(window.location.search)
    return !q.has('lens') && !q.has('country') && !q.has('stage') && !q.has('view') && q.get('intro') !== '0'
  })
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const isSmall = useMediaQuery('(max-width: 767px)')

  useEffect(() => {
    let cancelled = false
    loadDataset()
      .then((dataset) => {
        if (cancelled) return
        setState({ status: 'ready', dataset })
        // Read the URL only once the ids are known, so unknown ids in a stale
        // link can be dropped rather than silently kept.
        setFilters(
          filtersFromSearchParams(
            new URLSearchParams(window.location.search),
            dataset.minerals.map((m) => m.id),
            Object.keys(dataset.countries),
          ),
        )
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState({ status: 'error', error: error instanceof Error ? error : new Error(String(error)) })
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Reflect filters in the URL without adding history entries for every click.
  useEffect(() => {
    if (state.status !== 'ready') return
    const params = filtersToSearchParams(filters)
    if (lens !== 'mined') params.set('lens', lens)
    const query = params.toString()
    window.history.replaceState(
      null,
      '',
      window.location.pathname + (query ? '?' + query : '') + window.location.hash,
    )
  }, [filters, lens, state.status])

  const dataset = state.status === 'ready' ? state.dataset : null

  /** One model per year for the first active mineral the story can be told for; empty: the map has no shares to show. */
  const chokepoints = useMemo(() => {
    if (!dataset) return []
    for (const mineral of dataset.activeMinerals) {
      const series = buildChokepointSeries(dataset, mineral.id)
      if (series.length > 0) return series
    }
    return []
  }, [dataset])
  const chokepoint = chokepoints[chokepoints.length - 1] ?? null

  const view = useMemo(() => {
    if (!dataset) return null
    const activeIds = new Set(dataset.activeMinerals.map((m) => m.id))

    // Layer counts and values reflect the other filters but not their own, so
    // each row says what switching it on would give you.
    const byMineral = filterFacilities(
      dataset.facilities,
      { mineralIds: filters.mineralIds, stages: [] },
      activeIds,
    )
    const facilityCounts = Object.fromEntries(
      STAGES.map((s) => [s, byMineral.filter((f) => f.properties.stage === s).length]),
    ) as Record<Stage, number>

    const facilities = filterFacilities(dataset.facilities, filters, activeIds)
    const flows = filterFlows(dataset.flows, filters, activeIds)
    const flowsAnyKind = filterFlows(dataset.flows, { ...filters, flowKinds: [] }, activeIds)
    const flowsWorld = filterFlows(dataset.flows, { ...filters, country: null }, activeIds)
    const allActiveFlows = filterFlows(dataset.flows, { ...EMPTY_FILTERS }, activeIds)
    const built = toArcData(flows, dataset, filters.topN)

    const tradeUsd = flows.reduce((sum, f) => sum + (resolveValue(f, dataset.priceFor).usd ?? 0), 0)
    const baseColor = dataset.activeMinerals[0]?.color ?? '#d07a45'
    const shade = Object.fromEntries(STAGES.map((s) => [s, stageShade(baseColor, s)])) as Record<
      Stage,
      string
    >

    const summary =
      filters.country === null
        ? null
        : summarizeCountry(filters.country, flowsWorld, byMineral, dataset.priceFor)

    const searchable = [...countriesInPlay(allActiveFlows, byMineral)].filter(
      (iso3) => iso3 in dataset.countries,
    )

    // Every country's role, for the map's hover readout and the dossier.
    const world = valueByKind(flowsWorld, dataset.priceFor)
    const nameOf = (iso3: string) => dataset.countries[iso3]?.name ?? iso3
    const roles: Record<string, CountryRole> = {}
    for (const iso3 of searchable) {
      roles[iso3] = countryRole(
        summarizeCountry(iso3, flowsWorld, byMineral, dataset.priceFor),
        world,
        nameOf,
      )
    }
    const years = flows.map((f) => f.year)

    return {
      points: toPointData(facilities, dataset.mineralsById, activeIds),
      arcs: built.arcs,
      maxValueUsd: built.maxValueUsd,
      totalMatching: built.totalMatching,
      facilityCounts,
      valueByKind: valueByKind(flowsAnyKind, dataset.priceFor),
      overview: {
        tradeUsd,
        flowsDrawn: built.arcs.length,
        flowsTotal: built.totalMatching,
        sites: facilities.length,
        countries: countriesInPlay(flows, facilities).size,
      },
      hasEstimated: built.arcs.some((a) => a.value.estimated),
      hasLowConfidenceFlows: built.arcs.some((a) => a.confidence === 'low'),
      shade,
      summary,
      roles,
      searchable,
      dataYear: years.length > 0 ? Math.max(...years) : null,
    }
  }, [dataset, filters])

  /**
   * A selection that no longer matches the filters must not linger in the
   * panel. Derived during render rather than cleared in an effect. With no
   * selection, a focused country shows its dossier instead.
   */
  const panelSelection = useMemo((): Selection | null => {
    if (!view) return null
    if (selection !== null) {
      const stillVisible =
        selection.kind === 'facility'
          ? view.points.some((p) => p.id === selection.point.id)
          : view.arcs.some((a) => a.id === selection.arc.id)
      if (stillVisible) return selection
    }
    if (view.summary !== null) {
      const role = view.roles[view.summary.iso3]
      return { kind: 'country', iso3: view.summary.iso3, summary: view.summary, ...(role ? { role } : {}) }
    }
    return null
  }, [view, selection])

  const selectedId =
    panelSelection === null || panelSelection.kind === 'country'
      ? null
      : panelSelection.kind === 'facility'
        ? panelSelection.point.id
        : panelSelection.arc.id

  const onToggleMineral = useCallback((id: string) => {
    setFilters((f) => ({ ...f, mineralIds: toggle(f.mineralIds, id) }))
  }, [])
  const onClearMinerals = useCallback(() => setFilters((f) => ({ ...f, mineralIds: [] })), [])
  const onFocusCountry = useCallback((iso3: string) => {
    setSelection(null)
    setFilters((f) => ({ ...f, country: iso3 }))
  }, [])
  const onSelectPoint = useCallback((point: PointDatum) => setSelection({ kind: 'facility', point }), [])
  const onSelectArc = useCallback((arc: ArcDatum) => {
    setSelection({ kind: 'flow', arc })
  }, [])
  const onClearSelection = useCallback(() => setSelection(null), [])

  const openAbout = useCallback(() => setAboutOpen(true), [])
  const closeAbout = useCallback(() => setAboutOpen(false), [])

  /** Closing the panel steps back one level: a record first, then the country focus. */
  const onClosePanel = useCallback(() => {
    if (selection !== null) setSelection(null)
    else setFilters((f) => ({ ...f, country: null }))
  }, [selection])

  if (state.status === 'loading') {
    return (
      <div className="stage flex h-full items-center justify-center" role="status">
        <p className="hud-label text-muted">Loading the data</p>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="stage flex h-full items-center justify-center px-6" role="alert">
        <div className="panel bracketed max-w-md p-5">
          <p className="hud-label text-alert">Data load failed</p>
          <h1 className="mt-1 font-display text-xl text-ink">The data files did not load.</h1>
          <p className="mt-2 text-sm text-dim">
            The app reads flat files from the same origin, so this is usually a missing or malformed file
            rather than a network problem. The message below names the file and the record.
          </p>
          <pre className="mt-4 overflow-x-auto border border-line bg-void p-3 font-mono text-xs whitespace-pre-wrap text-alert">
            {state.error.message}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="hud-label mt-4 border border-line-strong px-3 py-1.5 text-ink hover:border-accent"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  const data = state.dataset
  const v = view!
  const flowsMineralName = chokepoint?.mineralName ?? 'Critical minerals'

  return (
    <div className="flex h-full flex-col">
      <a
        href="#map"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-30 focus:border focus:border-accent focus:bg-surface focus:px-2 focus:py-1 focus:text-xs focus:text-ink"
      >
        Skip to the map
      </a>

      <TopBar
        minerals={data.activeMinerals}
        selectedMineralIds={filters.mineralIds}
        onToggleMineral={onToggleMineral}
        onClearMinerals={onClearMinerals}
        dataYear={v.dataYear}
        onOpenAbout={openAbout}
        compact={isSmall}
      />

      <main id="map" tabIndex={-1} className="stage relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <h2 className="sr-only">{flowsMineralName} supply chain map</h2>
        <ExplorerView
          lens={lens}
          onChangeLens={setLens}
          models={chokepoints}
          priceHistory={data.priceHistory}
          points={v.points}
          repositioned={data.repositioned}
          arcs={v.arcs}
          countries={data.countries}
          mineralsById={data.mineralsById}
          selection={panelSelection}
          selectedId={selectedId}
          focusCountry={filters.country}
          reducedMotion={reducedMotion}
          compact={isSmall}
          playIntro={playIntro}
          onSelectPoint={onSelectPoint}
          onSelectArc={onSelectArc}
          onFocusCountry={onFocusCountry}
          onClearSelection={onClearSelection}
          onClosePanel={onClosePanel}
        />
      </main>

      {!isSmall && <StatusBar meta={data.meta} onOpenAbout={openAbout} />}
      <AboutDialog open={aboutOpen} onClose={closeAbout} meta={data.meta} />
    </div>
  )
}
