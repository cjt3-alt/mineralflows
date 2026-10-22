import type { Mineral } from '../data/schema.ts'

/**
 * The navigation: a wordmark, two views, and the method. Nothing decorative. An
 * earlier version carried a live UTC clock, a "dataset loaded" light and a
 * classification banner; none of them said anything true or useful, and they
 * made a page of public data look like it was cosplaying a command centre.
 *
 * With one mineral active, it is named quietly beside the wordmark; with
 * several, the names become the toggles. Chips are driven entirely by
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
  /** Which view is showing, and how to switch. Omit to hide the switch. */
  mode?: 'story' | 'flows'
  onChangeMode?: (mode: 'story' | 'flows') => void
}

function Mark() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 22 22" className="shrink-0">
      <polygon points="11,1.5 19.5,6.25 19.5,15.75 11,20.5 2.5,15.75 2.5,6.25" fill="none" stroke="var(--mf-copper)" strokeWidth="1.5" />
      <circle cx="11" cy="11" r="2.4" fill="var(--mf-copper)" />
    </svg>
  )
}

function NavLink({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className="hud-label relative h-full whitespace-nowrap px-1 transition-colors"
      style={{ color: active ? 'var(--mf-text)' : 'var(--mf-muted)' }}
    >
      {children}
      <span
        aria-hidden="true"
        className="absolute inset-x-1 bottom-0 h-px"
        style={{ background: active ? 'var(--mf-copper)' : 'transparent' }}
      />
    </button>
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
  mode,
  onChangeMode,
}: TopBarProps) {
  const showingAll = selectedMineralIds.length === 0
  const single = minerals.length === 1 ? minerals[0] : undefined

  return (
    <header className="flex h-12 shrink-0 items-center gap-5 border-b border-line bg-void px-4 sm:px-8">
      <div className="flex items-center gap-2.5">
        <Mark />
        <h1
          className="font-display whitespace-nowrap text-ink uppercase"
          style={{ fontSize: compact ? '0.8125rem' : '0.9375rem', letterSpacing: '0.04em', fontStretch: '125%', fontWeight: 600 }}
        >
          MineralFlows
        </h1>
      </div>

      {mode && onChangeMode && (
        <nav aria-label="View" className="flex h-full items-center gap-4 sm:gap-6">
          <NavLink active={mode === 'story'} onClick={() => onChangeMode('story')}>
            {compact ? 'Chokepoint' : 'The chokepoint'}
          </NavLink>
          <NavLink active={mode === 'flows'} onClick={() => onChangeMode('flows')}>
            {compact ? 'Flows' : 'Trade flows'}
          </NavLink>
        </nav>
      )}

      {!compact && single && (
        <p className="hud-label hidden items-center gap-2 whitespace-nowrap text-muted lg:flex">
          <span aria-hidden="true" className="inline-block h-1.5 w-1.5" style={{ backgroundColor: single.color }} />
          {single.name}
          {dataYear !== null && <span className="text-line-strong">/</span>}
          {dataYear !== null && <span>Trade {dataYear}</span>}
        </p>
      )}

      {minerals.length > 1 && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label="Minerals">
          {minerals.map((mineral) => {
            const pressed = !showingAll && selectedMineralIds.includes(mineral.id)
            return (
              <button
                key={mineral.id}
                type="button"
                aria-pressed={pressed}
                onClick={() => onToggleMineral(mineral.id)}
                className="toggle hud-label flex items-center gap-1.5 border border-line px-2 py-0.5 text-dim hover:text-ink"
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

      <button
        type="button"
        onClick={onOpenAbout}
        className="hud-label ml-auto whitespace-nowrap border border-line-strong px-3 py-1.5 text-dim transition-colors hover:border-ink hover:text-ink"
      >
        {compact ? 'Method' : 'Sources & method'}
      </button>
    </header>
  )
}
