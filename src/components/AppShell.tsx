import { useEffect, useMemo, useState } from 'react'
import { GlobeCanvas } from './GlobeCanvas.tsx'
import { loadDataset, type Dataset } from '../data/load.ts'
import {
  EMPTY_FILTERS,
  filterFacilities,
  filterFlows,
  toArcData,
  toPointData,
  type ArcDatum,
  type PointDatum,
} from '../data/derive.ts'

/**
 * Owns data loading and all filter state. Phase 3 adds the surrounding chrome;
 * for now this is the smallest thing that can put real data on the globe.
 */

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; dataset: Dataset }
  | { status: 'error'; error: Error }

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}

function useIsSmallViewport(): boolean {
  const [small, setSmall] = useState(() => window.matchMedia('(max-width: 767px)').matches)
  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)')
    const onChange = () => setSmall(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return small
}

export function AppShell() {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const reducedMotion = usePrefersReducedMotion()
  const isSmall = useIsSmallViewport()

  useEffect(() => {
    let cancelled = false
    loadDataset()
      .then((dataset) => {
        if (!cancelled) setState({ status: 'ready', dataset })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', error: error instanceof Error ? error : new Error(String(error)) })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const dataset = state.status === 'ready' ? state.dataset : null

  const { points, arcs } = useMemo((): { points: PointDatum[]; arcs: ArcDatum[] } => {
    if (!dataset) return { points: [], arcs: [] }
    const activeIds = new Set(dataset.activeMinerals.map((m) => m.id))
    const facilities = filterFacilities(dataset.facilities, EMPTY_FILTERS, activeIds)
    const flows = filterFlows(dataset.flows, EMPTY_FILTERS, activeIds)
    return {
      points: toPointData(facilities, dataset.mineralsById, activeIds),
      arcs: toArcData(flows, dataset).arcs,
    }
  }, [dataset])

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
            The app reads flat files from the same origin, so this usually means a file is missing
            or malformed rather than a network problem. Reload to try again.
          </p>
          <pre className="mt-4 overflow-x-auto border border-line bg-surface p-3 font-mono text-2xs whitespace-pre-wrap text-alert">
            {state.error.message}
          </pre>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full w-full">
      <GlobeCanvas
        points={points}
        arcs={arcs}
        selectedId={selectedId}
        reducedMotion={reducedMotion}
        bloomEnabled={!isSmall}
        onSelectPoint={(p) => setSelectedId(p.id)}
        onSelectArc={(a) => setSelectedId(a.id)}
        onClearSelection={() => setSelectedId(null)}
      />
    </div>
  )
}
