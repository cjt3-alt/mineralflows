import { formatUsd, valueScaleFraction } from '../data/derive.ts'
import type { Meta } from '../data/schema.ts'

/**
 * What arc width means in dollars, and how old each source is. Sources update
 * on genuinely different cadences, so this shows a vintage per source rather
 * than one build date pretending to cover all of them.
 */

export interface LegendBarProps {
  maxValueUsd: number
  /** True when the arc cap dropped some flows, so the bar can say so. */
  truncated: boolean
  shownArcCount: number
  totalArcCount: number
  /** True when any visible flow value came from volume x price. */
  hasEstimatedValues: boolean
  meta: Meta
  /**
   * Narrow viewports fold the per-source vintages behind a disclosure. Six
   * sources laid out flat can eat a third of a phone screen, and the scale is
   * what has to stay visible; the vintages are a lookup.
   */
  compact?: boolean
}

/** Swatch widths use the same scale as the globe, via valueScaleFraction. */
const SWATCH_MIN_PX = 1
const SWATCH_MAX_PX = 7

function Swatch({ valueUsd, maxValueUsd }: { valueUsd: number; maxValueUsd: number }) {
  const t = valueScaleFraction(valueUsd, maxValueUsd)
  const height = SWATCH_MIN_PX + (SWATCH_MAX_PX - SWATCH_MIN_PX) * t
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="inline-block w-8 bg-dim"
        style={{ height: height + 'px' }}
      />
      <span className="font-mono text-2xs text-muted">{formatUsd(valueUsd)}</span>
    </span>
  )
}

/**
 * One entry per source, with its own vintage. Sources genuinely update on
 * different cadences, so a single build date would be the dishonest version.
 */
function Vintages({ meta }: { meta: Meta }) {
  return (
    <>
      {meta.sources.map((source) => (
        <span key={source.id} className="font-mono text-2xs text-muted" title={source.coverage}>
          {source.id} <span className="text-dim">{source.vintage}</span>
        </span>
      ))}
    </>
  )
}

export function LegendBar({
  maxValueUsd,
  truncated,
  shownArcCount,
  totalArcCount,
  hasEstimatedValues,
  meta,
  compact = false,
}: LegendBarProps) {
  // Three reference points across the square-root scale, not evenly spaced in
  // dollars, because the scale is not linear.
  const steps = [maxValueUsd / 100, maxValueUsd / 10, maxValueUsd].filter((v) => v > 0)

  return (
    <footer className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2 border-t border-line px-4 py-2">
      {steps.length > 0 ? (
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted">Arc width</span>
          {steps.map((value) => (
            <Swatch key={value} valueUsd={value} maxValueUsd={maxValueUsd} />
          ))}
        </div>
      ) : (
        // Reached whenever the filters select a stage a mineral does not trade
        // at. Rare earths have no mine-stage trade at all, so this is a normal
        // state, not an error, and it says so.
        <p className="text-xs text-muted">
          No flows at this stage for the minerals selected. Facilities still show.
        </p>
      )}

      {hasEstimatedValues && (
        <p className="text-xs text-muted">
          Some values are <span className="text-dim">estimated</span> from volume times average
          price.
        </p>
      )}

      {truncated && (
        <p className="text-xs text-muted">
          Showing the top{' '}
          <span className="font-mono text-dim">{shownArcCount}</span> flows by value of{' '}
          <span className="font-mono text-dim">{totalArcCount}</span>.
        </p>
      )}

      {compact ? (
        <details className="ml-auto w-full">
          <summary className="cursor-pointer text-xs text-muted">
            Data vintage ({meta.sources.length} sources)
          </summary>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
            <Vintages meta={meta} />
          </div>
        </details>
      ) : (
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-xs text-muted">Data vintage</span>
          <Vintages meta={meta} />
        </div>
      )}
    </footer>
  )
}
