import type { Mineral } from '../data/schema.ts'

/**
 * Wordmark and the mineral toggles. Chips are driven entirely by
 * `minerals.json`, so a fifth mineral appears here by adding a row to the data.
 */

export interface TopBarProps {
  minerals: Mineral[]
  /** Empty means every mineral is showing. */
  selectedMineralIds: string[]
  onToggleMineral: (id: string) => void
  onClearMinerals: () => void
}

export function TopBar({
  minerals,
  selectedMineralIds,
  onToggleMineral,
  onClearMinerals,
}: TopBarProps) {
  const showingAll = selectedMineralIds.length === 0

  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-line px-4">
      <h1 className="text-base font-semibold tracking-tight text-ink">MineralFlows</h1>

      <div className="flex flex-1 flex-wrap items-center gap-1.5" role="group" aria-label="Minerals">
        {minerals.map((mineral) => {
          const active = showingAll || selectedMineralIds.includes(mineral.id)
          return (
            <button
              key={mineral.id}
              type="button"
              aria-pressed={!showingAll && selectedMineralIds.includes(mineral.id)}
              onClick={() => onToggleMineral(mineral.id)}
              className={
                'flex items-center gap-1.5 rounded-xs border px-2 py-1 text-xs ' +
                (active
                  ? 'border-line-strong text-ink'
                  : 'border-line text-muted hover:text-dim')
              }
              style={{ borderRadius: 'var(--mf-radius)' }}
            >
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 shrink-0"
                style={{
                  backgroundColor: mineral.color,
                  opacity: active ? 1 : 0.35,
                  borderRadius: '1px',
                }}
              />
              {mineral.name}
            </button>
          )
        })}

        {!showingAll && (
          <button
            type="button"
            onClick={onClearMinerals}
            className="ml-1 text-xs text-muted underline-offset-2 hover:text-ink hover:underline"
          >
            Show all
          </button>
        )}
      </div>
    </header>
  )
}
