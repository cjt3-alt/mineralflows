import { formatUsd, valueScaleFraction } from '../data/derive.ts'
import type { Meta } from '../data/schema.ts'

/**
 * Two pieces of standing context. `Legend` floats over the map and says what
 * the marks mean that the control column does not already say (arc width,
 * dashed arcs, hollow rings, the cap). `StatusBar` credits every source by its
 * own name, with its own vintage, because the sources update on different
 * cadences and several require attribution wherever their data is reproduced.
 */

const SWATCH_MIN_PX = 1
const SWATCH_MAX_PX = 7

export interface LegendProps {
  maxValueUsd: number
  shownArcCount: number
  totalArcCount: number
  hasEstimatedValues: boolean
  hasLowConfidenceFlows: boolean
  /** Swatch colour: the mid shade of the active mineral. */
  color: string
}

export function Legend({
  maxValueUsd,
  shownArcCount,
  totalArcCount,
  hasEstimatedValues,
  hasLowConfidenceFlows,
  color,
}: LegendProps) {
  // Three reference points across the square-root scale, not evenly spaced in
  // dollars, because the scale is not linear.
  const steps = [maxValueUsd / 100, maxValueUsd / 10, maxValueUsd].filter((v) => v > 0)

  return (
    <div className="panel pointer-events-auto w-52 px-3 py-2.5">
      <p className="hud-label mb-2 text-muted">Flow value</p>
      {steps.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {steps
            .slice()
            .reverse()
            .map((value) => {
              const t = valueScaleFraction(value, maxValueUsd)
              return (
                <div key={value} className="flex items-center gap-2">
                  <span className="flex w-8 items-center">
                    <span
                      aria-hidden="true"
                      className="inline-block w-8 rounded-full"
                      style={{
                        height: SWATCH_MIN_PX + (SWATCH_MAX_PX - SWATCH_MIN_PX) * t + 'px',
                        background: `linear-gradient(90deg, color-mix(in srgb, ${color} 50%, black), ${color}, #ffe2bd)`,
                        boxShadow: `0 0 ${2 + 6 * t}px color-mix(in srgb, ${color} 55%, transparent)`,
                      }}
                    />
                  </span>
                  <span className="font-mono text-xs text-dim">{formatUsd(value)}</span>
                </div>
              )
            })}
        </div>
      ) : (
        <p className="text-xs text-muted">No flows match these filters. Sites still show.</p>
      )}

      <div className="mt-2 flex flex-col gap-1 border-t border-line pt-2 text-xs text-muted">
        {hasLowConfidenceFlows && (
          <p className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-block h-0 w-8 border-t-2 border-dashed"
              style={{ borderColor: color }}
            />
            Importer-reported only
          </p>
        )}
        {hasEstimatedValues && (
          <p>
            <span className="text-alert">*</span> Estimated from volume × price
          </p>
        )}
        <p>
          Top <span className="font-mono text-dim">{shownArcCount}</span> of{' '}
          <span className="font-mono text-dim">{totalArcCount}</span> flows drawn
        </p>
      </div>
    </div>
  )
}

export function StatusBar({ meta, onOpenAbout }: { meta: Meta; onOpenAbout: () => void }) {
  // Hand-authored seed rows only stand in for sources that are unreachable or
  // for minerals that are switched off; they are credited in the About dialog
  // rather than presented here as a source of what is on screen.
  const sources = meta.sources.filter((s) => !s.id.startsWith('seed'))
  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 overflow-hidden border-t border-line bg-surface px-4">
      <span className="hud-label shrink-0 text-muted">Sources</span>
      <p className="min-w-0 flex-1 truncate text-xs text-muted">
        {sources.map((s, i) => (
          <span key={s.id} title={s.coverage}>
            {i > 0 && <span className="mx-2 text-line-strong">/</span>}
            <span className="text-dim">{s.name}</span> <span className="font-mono">{s.vintage}</span>
          </span>
        ))}
      </p>
      <button type="button" onClick={onOpenAbout} className="hud-label shrink-0 text-muted hover:text-accent">
        Method →
      </button>
    </footer>
  )
}
