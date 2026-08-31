import type { ReactNode } from 'react'
import { STAGES, type Stage } from '../data/schema.ts'

/**
 * Stage filter today; year, region and confidence are coming. `FilterGroup` is
 * the seam for that: a new group is a new block here, not a new layout.
 */

export interface FilterRailProps {
  /** Empty means every stage is showing. */
  selectedStages: Stage[]
  onToggleStage: (stage: Stage) => void
  onClearStages: () => void
  /** Facility count per stage, after the mineral filter but before the stage filter. */
  facilityCounts: Record<Stage, number>
  visibleFacilityCount: number
  visibleFlowCount: number
}

const STAGE_LABELS: Record<Stage, string> = {
  mine: 'Mine',
  process: 'Process',
  refine: 'Refine',
}

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-4">
      <h2 className="mb-2 text-xs font-medium text-dim">{label}</h2>
      {children}
    </section>
  )
}

export function FilterRail({
  selectedStages,
  onToggleStage,
  onClearStages,
  facilityCounts,
  visibleFacilityCount,
  visibleFlowCount,
}: FilterRailProps) {
  const showingAll = selectedStages.length === 0

  return (
    <nav
      aria-label="Filters"
      className="flex w-52 shrink-0 flex-col overflow-y-auto border-r border-line"
    >
      <FilterGroup label="Stage">
        <ul className="flex flex-col gap-0.5">
          <li>
            <button
              type="button"
              aria-pressed={showingAll}
              onClick={onClearStages}
              className={
                'flex w-full items-center justify-between px-1.5 py-1 text-left text-sm ' +
                (showingAll ? 'text-ink' : 'text-muted hover:text-dim')
              }
            >
              <span>All stages</span>
            </button>
          </li>
          {STAGES.map((stage) => {
            const active = selectedStages.includes(stage)
            const count = facilityCounts[stage]
            return (
              <li key={stage}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => onToggleStage(stage)}
                  className={
                    'flex w-full items-center justify-between px-1.5 py-1 text-left text-sm ' +
                    (active ? 'text-ink' : 'text-muted hover:text-dim')
                  }
                >
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="inline-block border border-line-strong"
                      style={{
                        width: stage === 'mine' ? 5 : stage === 'process' ? 7 : 9,
                        height: stage === 'mine' ? 5 : stage === 'process' ? 7 : 9,
                        borderRadius: '50%',
                        backgroundColor: active ? 'var(--mf-text-dim)' : 'transparent',
                      }}
                    />
                    {STAGE_LABELS[stage]}
                  </span>
                  <span className="font-mono text-2xs text-muted">{count}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </FilterGroup>

      <div className="mt-auto px-4 py-4">
        <dl className="flex flex-col gap-1 font-mono text-2xs text-muted">
          <div className="flex justify-between">
            <dt>Facilities</dt>
            <dd className="text-dim">{visibleFacilityCount}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Flows</dt>
            <dd className="text-dim">{visibleFlowCount}</dd>
          </div>
        </dl>
      </div>
    </nav>
  )
}
