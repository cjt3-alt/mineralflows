import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { GlobeCanvas } from './GlobeCanvas.tsx'
import { TopBar } from './TopBar.tsx'
import { FilterRail } from './FilterRail.tsx'
import { DetailPanel, type Selection } from './DetailPanel.tsx'
import { LegendBar } from './LegendBar.tsx'
import { loadDataset, type Dataset } from '../data/load.ts'
import {
  EMPTY_FILTERS,
  filterFacilities,
  filterFlows,
  filtersFromSearchParams,
  filtersToSearchParams,
  toArcData,
  toPointData,
  type Filters,
} from '../data/derive.ts'
import { STAGES, type Stage } from '../data/schema.ts'

/**
 * Owns data loading, filter state, and selection. Everything below it is
 * presentational. Filter state round-trips through the query string so a view
 * is shareable.
 */

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; dataset: Dataset }
  | { status: 'error'; error: Error }

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
  const [selection, setSelection] = useState<Selection | null>(null)

  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const isSmall = useMediaQuery('(max-width: 767px)')

  useEffect(() => {
    let cancelled = false
    loadDataset()
      .then((dataset) => {
        if (cancelled) return
        setState({ status: 'ready', dataset })
        // Read the URL only once the mineral ids are known, so unknown ids in a
        // stale link can be dropped rather than silently kept.
        setFilters(
          filtersFromSearchParams(
            new URLSearchParams(window.location.search),
            dataset.minerals.map((m) => m.id),
          ),
        )
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState({
          status: 'error',
          error: error instanceof Error ? error : new Error(String(error)),
        })
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Reflect filters in the URL without adding history entries for every click.
  useEffect(() => {
    if (state.status !== 'ready') return
    const params = filtersToSearchParams(filters)
    const query = params.toString()
    const next = window.location.pathname + (query ? '?' + query : '') + window.location.hash
    window.history.replaceState(null, '', next)
  }, [filters, state.status])

  const dataset = state.status === 'ready' ? state.dataset : null

  const view = useMemo(() => {
    if (!dataset) {
      return {
        points: [],
        arcs: [],
        maxValueUsd: 0,
        truncated: false,
        totalMatching: 0,
        facilityCounts: { mine: 0, process: 0, refine: 0 } as Record<Stage, number>,
        hasEstimated: false,
      }
    }

    const activeIds = new Set(dataset.activeMinerals.map((m) => m.id))

    // Stage counts reflect the mineral filter but not the stage filter, so the
    // rail shows what each stage would give you rather than what is already on.
    const mineralOnly: Filters = { mineralIds: filters.mineralIds, stages: [] }
    const byMineral = filterFacilities(dataset.facilities, mineralOnly, activeIds)
    const facilityCounts = Object.fromEntries(
      STAGES.map((stage) => [stage, byMineral.filter((f) => f.properties.stage === stage).length]),
    ) as Record<Stage, number>

    const facilities = filterFacilities(dataset.facilities, filters, activeIds)
    const flows = filterFlows(dataset.flows, filters, activeIds)
    const built = toArcData(flows, dataset)

    return {
      points: toPointData(facilities, dataset.mineralsById, activeIds),
      arcs: built.arcs,
      maxValueUsd: built.maxValueUsd,
      truncated: built.truncated,
      totalMatching: built.totalMatching,
      facilityCounts,
      hasEstimated: built.arcs.some((a) => a.value.estimated),
    }
  }, [dataset, filters])

  /**
   * A selection that no longer matches the filters must not linger in the
   * panel. Derived during render rather than cleared in an effect, so filtering
   * something out never causes a second render pass with a stale panel.
   */
  const visibleSelection = useMemo((): Selection | null => {
    if (selection === null) return null
    const stillVisible =
      selection.kind === 'facility'
        ? view.points.some((p) => p.id === selection.point.id)
        : view.arcs.some((a) => a.id === selection.arc.id)
    return stillVisible ? selection : null
  }, [view, selection])

  const onToggleMineral = useCallback((id: string) => {
    setFilters((f) => ({ ...f, mineralIds: toggle(f.mineralIds, id) }))
  }, [])
  const onClearMinerals = useCallback(() => {
    setFilters((f) => ({ ...f, mineralIds: [] }))
  }, [])
  const onToggleStage = useCallback((stage: Stage) => {
    setFilters((f) => ({ ...f, stages: toggle(f.stages, stage) }))
  }, [])
  const onClearStages = useCallback(() => {
    setFilters((f) => ({ ...f, stages: [] }))
  }, [])
  const onClose = useCallback(() => setSelection(null), [])

  if (state.status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="font-mono text-xs text-muted">Loading supply chain data…</p>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-md">
          <h1 className="text-lg text-ink">The data files did not load.</h1>
          <p className="mt-2 text-sm text-dim">
            The app reads flat files from the same origin, so this is usually a missing or malformed
            file rather than a network problem. Reload to try again.
          </p>
          <pre className="mt-4 overflow-x-auto border border-line bg-surface p-3 font-mono text-2xs whitespace-pre-wrap text-alert">
            {state.error.message}
          </pre>
        </div>
      </div>
    )
  }

  const { dataset: data } = state
  const nothingVisible = view.points.length === 0 && view.arcs.length === 0

  return (
    <div className="flex h-full flex-col">
      <TopBar
        minerals={data.activeMinerals}
        selectedMineralIds={filters.mineralIds}
        onToggleMineral={onToggleMineral}
        onClearMinerals={onClearMinerals}
      />

      <div className="flex min-h-0 flex-1">
        <FilterRail
          selectedStages={filters.stages}
          onToggleStage={onToggleStage}
          onClearStages={onClearStages}
          facilityCounts={view.facilityCounts}
          visibleFacilityCount={view.points.length}
          visibleFlowCount={view.arcs.length}
        />

        <main className="relative min-w-0 flex-1">
          <GlobeCanvas
            points={view.points}
            arcs={view.arcs}
            selectedId={
              visibleSelection === null
                ? null
                : visibleSelection.kind === 'facility'
                  ? visibleSelection.point.id
                  : visibleSelection.arc.id
            }
            reducedMotion={reducedMotion}
            bloomEnabled={!isSmall}
            onSelectPoint={(point) => setSelection({ kind: 'facility', point })}
            onSelectArc={(arc) => setSelection({ kind: 'flow', arc })}
            onClearSelection={onClose}
          />

          {nothingVisible && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
              <div className="pointer-events-auto max-w-sm border border-line bg-surface p-4 text-center">
                <p className="text-sm text-ink">Nothing matches these filters.</p>
                <p className="mt-1 text-xs text-dim">
                  Rare earths have no mine-stage trade, so combining that mineral with the mine
                  stage returns nothing. Widen the stage filter to see them.
                </p>
              </div>
            </div>
          )}
        </main>

        <DetailPanel
          selection={visibleSelection}
          mineralsById={data.mineralsById}
          countries={data.countries}
          onClose={onClose}
        />
      </div>

      <LegendBar
        maxValueUsd={view.maxValueUsd}
        truncated={view.truncated}
        shownArcCount={view.arcs.length}
        totalArcCount={view.totalMatching}
        hasEstimatedValues={view.hasEstimated}
        meta={data.meta}
      />
    </div>
  )
}
