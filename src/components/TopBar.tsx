import { useEffect, useState } from 'react'
import type { Mineral } from '../data/schema.ts'

/**
 * The banner, the wordmark, and what is being monitored. With one mineral
 * active the mineral is the title, not a button that does nothing; with
 * several, the title becomes the set of toggles. Chips are driven entirely by
 * `minerals.json`, so a mineral appears here by switching it on in the data.
 */

export interface TopBarProps {
  minerals: Mineral[]
  /** Empty means every mineral is showing. */
  selectedMineralIds: string[]
  onToggleMineral: (id: string) => void
  onClearMinerals: () => void
  /** The trade year on screen, from the flows. */
  dataYear: number | null
  onOpenAbout: () => void
  compact?: boolean
}

function useUtcClock(): string {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(id)
  }, [])
  return now.toISOString().slice(11, 19) + 'Z'
}

function Mark() {
  return (
    <svg aria-hidden="true" width="22" height="22" viewBox="0 0 22 22" className="shrink-0">
      <polygon
        points="11,1.5 19.5,6.25 19.5,15.75 11,20.5 2.5,15.75 2.5,6.25"
        fill="none"
        stroke="var(--mf-copper)"
        strokeWidth="1.25"
      />
      <circle cx="11" cy="11" r="2.4" fill="var(--mf-copper)" />
      <path d="M11 4.5v3M11 14.5v3M4.8 11h3M14.2 11h3" stroke="var(--mf-accent)" strokeWidth="1" />
    </svg>
  )
}

export function Banner() {
  return (
    <div
      className="flex h-5 shrink-0 items-center justify-center gap-3 border-b font-mono text-[10px] tracking-[0.22em] uppercase"
      style={{
        background: 'color-mix(in srgb, var(--mf-ok) 10%, var(--mf-void))',
        borderColor: 'color-mix(in srgb, var(--mf-ok) 25%, transparent)',
        color: 'var(--mf-ok)',
      }}
    >
      <span>Unclassified</span>
      <span aria-hidden="true">//</span>
      <span>Open-source data</span>
    </div>
  )
}

export function TopBar({
  minerals,
  selectedMineralIds,
  onToggleMineral,
  onClearMinerals,
  dataYear,
  onOpenAbout,
  compact = false,
}: TopBarProps) {
  const clock = useUtcClock()
  const showingAll = selectedMineralIds.length === 0
  const single = minerals.length === 1 ? minerals[0] : undefined

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 sm:px-4">
      <Mark />
      <div className="flex min-w-0 items-baseline gap-2">
        <h1 className="font-display text-base font-semibold tracking-[0.14em] text-ink uppercase">
          MineralFlows
        </h1>
        {!compact && <span className="hud-label hidden text-muted md:inline">Supply chain monitor</span>}
      </div>

      <span aria-hidden="true" className="h-5 w-px bg-line-strong" />

      {single ? (
        <p className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 shrink-0"
            style={{ backgroundColor: single.color }}
          />
          <span className="hud-label truncate text-ink">{single.name}</span>
          {dataYear !== null && <span className="hud-label hidden text-muted sm:inline">· Trade {dataYear}</span>}
        </p>
      ) : (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" role="group" aria-label="Minerals">
          {minerals.map((mineral) => {
            const pressed = !showingAll && selectedMineralIds.includes(mineral.id)
            return (
              <button
                key={mineral.id}
                type="button"
                aria-pressed={pressed}
                onClick={() => onToggleMineral(mineral.id)}
                className="toggle hud-label flex items-center gap-1.5 border border-line px-2 py-0.5 text-dim hover:text-ink"
                style={{ borderRadius: 'var(--mf-radius)' }}
              >
                <span aria-hidden="true" className="inline-block h-2 w-2" style={{ backgroundColor: mineral.color }} />
                {mineral.name}
              </button>
            )
          })}
          {!showingAll && (
            <button type="button" onClick={onClearMinerals} className="hud-label text-muted hover:text-ink">
              All
            </button>
          )}
        </div>
      )}

      <div className="ml-auto flex items-center gap-4">
        {!compact && (
          <p className="hud-label hidden items-center gap-2 text-muted lg:flex">
            <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-ok" />
            <span>Dataset loaded</span><span aria-hidden="true">·</span><span>UTC</span>
            <span className="text-dim tabular-nums">{clock}</span>
          </p>
        )}
        <button
          type="button"
          onClick={onOpenAbout}
          className="hud-label border border-line-strong px-2.5 py-1 text-dim hover:border-accent hover:text-ink"
          style={{ borderRadius: 'var(--mf-radius)' }}
        >
          {compact ? 'About' : 'Sources & method'}
        </button>
      </div>
    </header>
  )
}
