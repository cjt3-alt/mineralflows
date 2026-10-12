import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { MapCanvas, type TerrainLayers } from './MapCanvas.tsx'
import { chooseSeam, wrapLng } from './mapDynamics.ts'
import { isOpenOceanMeridian } from '../data/geo.ts'
import { Banner, TopBar } from './TopBar.tsx'
import { FilterRail, type FilterRailProps } from './FilterRail.tsx'
import { DetailPanel, type Selection } from './DetailPanel.tsx'
import { Legend, StatusBar } from './LegendBar.tsx'
import { AboutDialog } from './AboutDialog.tsx'
import { loadDataset, type Dataset } from '../data/load.ts'
import {
  EMPTY_FILTERS,
  countriesInPlay,
  filterFacilities,
  filterFlows,
  filtersFromSearchParams,
  filtersToSearchParams,
  formatUsd,
  resolveValue,
  stageShade,
  summarizeCountry,
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
  | { status: 'loading' }
  | { status: 'ready'; dataset: Dataset }
  | { status: 'error'; error: Error }

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

/**
 * Layer switches: every layer is on by default (stored as an empty list), a
 * click turns one off, and the last one on cannot be turned off. Turning the
 * last missing one back on returns to the empty "all" list, so the URL stays
 * clean.
 */
function toggleLayer(list: Stage[], value: Stage): Stage[] {
  const on: Stage[] = list.length === 0 ? [...STAGES] : list
  const next = on.includes(value) ? on.filter((s) => s !== value) : [...on, value]
  if (next.length === 0) return list
  if (next.length === STAGES.length) return []
  return STAGES.filter((s) => next.includes(s))
}

const LIST_LENGTH = 8

export function AppShell() {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [selection, setSelection] = useState<PickedSelection | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [terrainLayers, setTerrainLayers] = useState<TerrainLayers>({ relief: true, ranges: true })
  const onToggleTerrain = useCallback(
    (layer: keyof TerrainLayers) => setTerrainLayers((t) => ({ ...t, [layer]: !t[layer] })),
    [],
  )

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
    const query = filtersToSearchParams(filters).toString()
    window.history.replaceState(null, '', window.location.pathname + (query ? '?' + query : '') + window.location.hash)
  }, [filters, state.status])

  const dataset = state.status === 'ready' ? state.dataset : null

  /**
   * Where the flat map is cut, from every active flow rather than the filtered
   * set, so the map does not re-centre when a filter changes.
   */
  const centralMeridian = useMemo(() => {
    if (!dataset) return 0
    const active = new Set(dataset.activeMinerals.map((m) => m.id))
    const flows = dataset.flows.flatMap((f) => {
      const from = dataset.countries[f.from_iso3]
      const to = dataset.countries[f.to_iso3]
      if (!active.has(f.mineral_id) || !from || !to) return []
      return [{ fromLng: from.lon, toLng: to.lon, usd: resolveValue(f, dataset.priceFor).usd ?? 0 }]
    })
    return wrapLng(chooseSeam(flows, isOpenOceanMeridian) + 180)
  }, [dataset])

  const view = useMemo(() => {
    if (!dataset) return null
    const activeIds = new Set(dataset.activeMinerals.map((m) => m.id))

    // Layer counts and values reflect the other filters but not their own, so
    // each row says what switching it on would give you.
    const byMineral = filterFacilities(dataset.facilities, { mineralIds: filters.mineralIds, stages: [] }, activeIds)
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
    const baseColor = dataset.activeMinerals[0]?.color ?? '#ff7a45'
    const shade = Object.fromEntries(STAGES.map((s) => [s, stageShade(baseColor, s)])) as Record<Stage, string>

    const summary =
      filters.country === null
        ? null
        : summarizeCountry(filters.country, flowsWorld, byMineral, dataset.priceFor)

    const searchable = [...countriesInPlay(allActiveFlows, byMineral)].filter((iso3) => iso3 in dataset.countries)
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
    if (view.summary !== null) return { kind: 'country', iso3: view.summary.iso3, summary: view.summary }
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
  const onToggleStage = useCallback((s: Stage) => setFilters((f) => ({ ...f, stages: toggleLayer(f.stages, s) })), [])
  const onToggleFlowKind = useCallback(
    (k: Stage) => setFilters((f) => ({ ...f, flowKinds: toggleLayer(f.flowKinds, k) })),
    [],
  )
  const onChangeTopN = useCallback((topN: number) => setFilters((f) => ({ ...f, topN })), [])
  const onFocusCountry = useCallback((iso3: string) => {
    setSelection(null)
    setSheetOpen(false)
    setFilters((f) => ({ ...f, country: iso3 }))
  }, [])
  const onClearFocus = useCallback(() => setFilters((f) => ({ ...f, country: null })), [])
  const onSelectPoint = useCallback((point: PointDatum) => setSelection({ kind: 'facility', point }), [])
  const onSelectArc = useCallback((arc: ArcDatum) => {
    setSheetOpen(false)
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
        <p className="hud-label text-muted">
          <span className="blink text-accent">■</span> Acquiring supply chain data…
        </p>
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
            The app reads flat files from the same origin, so this is usually a missing or malformed
            file rather than a network problem. The message below names the file and the record.
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
  const nothingVisible = v.points.length === 0 && v.arcs.length === 0

  const railProps: FilterRailProps = {
    overview: v.overview,
    countries: data.countries,
    searchableCountries: v.searchable,
    focusCountry: filters.country,
    onFocusCountry,
    onClearFocus,
    stages: filters.stages,
    facilityCounts: v.facilityCounts,
    onToggleStage,
    flowKinds: filters.flowKinds,
    valueByKind: v.valueByKind,
    onToggleFlowKind,
    topN: filters.topN,
    onChangeTopN,
    topFlows: v.arcs.slice(0, LIST_LENGTH),
    selectedId,
    onHoverFlow: setHoverId,
    onSelectFlow: onSelectArc,
    shade: v.shade,
    terrainLayers,
    onToggleTerrain,
  }

  const legend = (
    <Legend
      maxValueUsd={v.maxValueUsd}
      shownArcCount={v.arcs.length}
      totalArcCount={v.totalMatching}
      hasEstimatedValues={v.hasEstimated}
      hasLowConfidenceFlows={v.hasLowConfidenceFlows}
      color={v.shade.process}
    />
  )

  return (
    <div className="flex h-full flex-col">
      <a
        href="#map"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-30 focus:border focus:border-accent focus:bg-surface focus:px-2 focus:py-1 focus:text-xs focus:text-ink"
      >
        Skip to the map
      </a>

      <Banner />
      <TopBar
        minerals={data.activeMinerals}
        selectedMineralIds={filters.mineralIds}
        onToggleMineral={onToggleMineral}
        onClearMinerals={onClearMinerals}
        dataYear={v.dataYear}
        onOpenAbout={openAbout}
        compact={isSmall}
      />

      <div className="flex min-h-0 flex-1">
        {!isSmall && (
          <nav
            aria-label="Controls"
            className="scroll-quiet flex shrink-0 flex-col overflow-y-auto border-r border-line bg-surface"
            style={{ width: 'var(--mf-rail-width)' }}
          >
            <FilterRail {...railProps} />
          </nav>
        )}

        <main id="map" tabIndex={-1} className="stage relative min-w-0 flex-1 overflow-hidden">
          <MapCanvas
            points={v.points}
            arcs={v.arcs}
            countries={data.countries}
            selectedId={selectedId}
            externalHoverId={hoverId}
            focusCountry={filters.country}
            centralMeridian={centralMeridian}
            terrainLayers={terrainLayers}
            // The floating panel is 23rem wide with a 1rem gap; on phones it is a sheet instead.
            insetRight={!isSmall && panelSelection !== null ? 23 * 16 + 16 : 0}
            reducedMotion={reducedMotion}
            onSelectPoint={onSelectPoint}
            onSelectArc={onSelectArc}
            onSelectCountry={onFocusCountry}
            onClearSelection={onClearSelection}
          />

          {!isSmall && <div className="pointer-events-none absolute bottom-6 left-6">{legend}</div>}

          {isSmall && !sheetOpen && panelSelection === null && (
            <div className="pointer-events-none absolute inset-x-3 bottom-3 flex items-end justify-between gap-2">
              <button
                type="button"
                onClick={() => setSheetOpen(true)}
                className="panel hud-label pointer-events-auto px-3 py-2 text-ink"
              >
                ☰ Layers & search
              </button>
              <p className="panel hud-label px-2.5 py-2 text-dim">
                {formatUsd(v.overview.tradeUsd)} · {v.arcs.length} flows
              </p>
            </div>
          )}

          {isSmall && sheetOpen && (
            <div className="panel scroll-quiet absolute inset-x-0 bottom-0 z-20 max-h-[78%] overflow-y-auto border-x-0 border-b-0">
              <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-surface px-4 py-2">
                <span className="hud-label text-dim">Layers & search</span>
                <button type="button" onClick={() => setSheetOpen(false)} className="hud-label text-muted hover:text-ink">
                  Done
                </button>
              </div>
              <FilterRail {...railProps} />
              <div className="p-4">{legend}</div>
            </div>
          )}

          {nothingVisible && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
              <div className="panel bracketed pointer-events-auto max-w-sm p-4 text-center">
                <p className="hud-label text-alert">No matches</p>
                <p className="mt-1 text-sm text-ink">Nothing matches these filters.</p>
                <p className="mt-1 text-xs text-dim">Switch a layer back on, or clear the country focus.</p>
              </div>
            </div>
          )}

          <DetailPanel
            variant={isSmall ? 'sheet' : 'panel'}
            selection={panelSelection}
            mineralsById={data.mineralsById}
            countries={data.countries}
            onClose={onClosePanel}
            onFocusCountry={onFocusCountry}
          />
        </main>
      </div>

      {!isSmall && <StatusBar meta={data.meta} onOpenAbout={openAbout} />}
      <AboutDialog open={aboutOpen} onClose={closeAbout} meta={data.meta} />
    </div>
  )
}
