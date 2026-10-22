import { FLOW_KIND_LABEL, STAGE_LABEL, TOP_N_OPTIONS, formatUsd } from '../data/derive.ts'
import { STAGES, type Stage } from '../data/schema.ts'
import { CountrySearch, Dot, LayerRow, Line, type FilterRailProps } from './FilterRail.tsx'

/**
 * The trade-flow page in the voice of the chokepoint: a headline that says what
 * the picture is saying, one big number, and a single glass panel instead of a
 * console rail. Same stage colours too: ore is verdigris, the smelter's heat is
 * gold, refined metal is copper, so a line on this page means the same thing as
 * a glow on the other.
 */

export interface FlowsHeadlineProps {
  mineralName: string
  year: number | null
  tradeUsd: number
  valueByKind: Record<Stage, number>
  /** Set when the map is focused on one country. */
  focusName: string | null
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0)

export function FlowsHeadline({ mineralName, year, tradeUsd, valueByKind, focusName }: FlowsHeadlineProps) {
  const name = mineralName.toLowerCase()
  const whole = valueByKind.mine + valueByKind.process + valueByKind.refine
  const ore = pct(valueByKind.mine, whole)
  const refined = pct(valueByKind.refine, whole)

  return (
    <>
      {/* A soft scrim so arcs passing behind the headline never fight the type. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-0 left-0 h-[22rem] w-[min(46rem,100%)]"
        style={{
          background:
            'radial-gradient(ellipse 75% 85% at 0% 0%, rgba(13, 11, 10, 0.9), rgba(13, 11, 10, 0.55) 55%, transparent 100%)',
        }}
      />
      <div className="pointer-events-none absolute top-5 left-5 max-w-[min(34rem,calc(100%-2.5rem))] sm:top-7 sm:left-8">
        <p className="hud-label text-muted">
          {mineralName}
          {year !== null ? ` · trade ${year}` : ''} · {focusName ?? 'worldwide'}
        </p>
        <h2 className="font-display mt-2 text-[1.65rem] leading-[1.15] font-semibold tracking-tight text-ink sm:text-[2.35rem]">
          {focusName ? `${focusName}'s ${name} trade.` : `Where ${name} goes next.`}
        </h2>
        <p className="font-serif mt-2 max-w-[31rem] text-[1.1rem] leading-[1.3] text-dim">
          {whole > 0 ? (
            <>
              <strong className="font-semibold" style={{ color: 'var(--mf-ore-tint)' }}>
                {ore}%
              </strong>{' '}
              of it by value is raw ore and concentrate, shipped out of the mines to be smelted somewhere
              else.{' '}
              <strong className="font-semibold" style={{ color: 'var(--mf-copper-refined)' }}>
                {refined}%
              </strong>{' '}
              is finished metal.
            </>
          ) : (
            'Nothing matches these filters.'
          )}
        </p>
        <p aria-hidden="true" className="mt-3 flex items-end gap-3">
          <span
            className="font-display text-[3.6rem] leading-[0.85] font-semibold tabular-nums sm:text-[5rem]"
            style={{ color: 'var(--mf-copper-refined)' }}
          >
            {formatUsd(tradeUsd)}
          </span>
          <span className="hud-label pb-1 text-muted">
            moved between
            <br />
            countries
          </span>
        </p>
      </div>
    </>
  )
}

export type FlowsPanelProps = Omit<FilterRailProps, 'terrainLayers' | 'onToggleTerrain'>

export function FlowsPanel(props: FlowsPanelProps) {
  const {
    overview,
    countries,
    searchableCountries,
    focusCountry,
    onFocusCountry,
    onClearFocus,
    stages,
    facilityCounts,
    onToggleStage,
    flowKinds,
    valueByKind,
    onToggleFlowKind,
    topN,
    onChangeTopN,
    topFlows,
    selectedId,
    onHoverFlow,
    onSelectFlow,
    shade,
  } = props

  const stageOn = (s: Stage) => stages.length === 0 || stages.includes(s)
  const kindOn = (k: Stage) => flowKinds.length === 0 || flowKinds.includes(k)
  const name = (iso3: string) => countries[iso3]?.name ?? iso3
  const list = topFlows.slice(0, 6)
  const maxTop = list[0]?.value.usd ?? 0

  return (
    <aside
      aria-label="Trade flow controls"
      className="panel scroll-quiet absolute top-24 right-5 bottom-20 w-[20.5rem] overflow-y-auto p-3.5 sm:right-8"
    >
      <p className="hud-label flex items-center justify-between text-dim">
        <span>The flows</span>
        <span className="normal-case text-muted">
          {overview.flowsDrawn} of {overview.flowsTotal} drawn
        </span>
      </p>

      <div className="mt-2 flex flex-col">
        {STAGES.map((k) => (
          <LayerRow
            key={k}
            on={kindOn(k)}
            onClick={() => onToggleFlowKind(k)}
            swatch={<Line color={shade[k]} thickness={2} />}
            label={FLOW_KIND_LABEL[k]}
            value={formatUsd(valueByKind[k])}
          />
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="hud-label text-muted" id="flows-topn-label">
          Draw
        </span>
        <div
          role="radiogroup"
          aria-labelledby="flows-topn-label"
          className="flex flex-1 border border-line-strong"
        >
          {TOP_N_OPTIONS.map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={topN === n}
              aria-pressed={topN === n}
              onClick={() => onChangeTopN(n)}
              className="toggle flex-1 border-r border-line-strong py-1 font-mono text-xs text-dim last:border-r-0 hover:text-ink"
            >
              Top {n}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 border-t border-line pt-3">
        {focusCountry ? (
          <div className="flex items-center justify-between border border-accent/40 bg-accent/5 px-3 py-2">
            <div>
              <p className="hud-label text-accent">Focused</p>
              <p className="text-sm text-ink">{name(focusCountry)}</p>
            </div>
            <button
              type="button"
              onClick={onClearFocus}
              aria-label={'Clear focus on ' + name(focusCountry)}
              className="px-1 text-lg leading-none text-muted hover:text-ink"
            >
              ×
            </button>
          </div>
        ) : (
          <CountrySearch countries={countries} searchable={searchableCountries} onPick={onFocusCountry} />
        )}
      </div>

      <div className="mt-3 border-t border-line pt-3">
        <p className="hud-label text-muted">Largest flows</p>
        {list.length === 0 ? (
          <p className="mt-2 text-xs text-muted">No flows match these filters.</p>
        ) : (
          <ol className="mt-1.5 flex flex-col" onMouseLeave={() => onHoverFlow(null)}>
            {list.map((arc, i) => {
              const fraction = maxTop > 0 ? (arc.value.usd ?? 0) / maxTop : 0
              return (
                <li key={arc.id}>
                  <button
                    type="button"
                    onClick={() => onSelectFlow(arc)}
                    onMouseEnter={() => onHoverFlow(arc.id)}
                    onFocus={() => onHoverFlow(arc.id)}
                    onBlur={() => onHoverFlow(null)}
                    className={
                      'grid w-full grid-cols-[1.25rem_1fr_auto] items-baseline gap-x-2 border-l-2 px-2 py-1.5 text-left hover:bg-accent/5 ' +
                      (arc.id === selectedId ? 'border-accent bg-accent/10' : 'border-transparent')
                    }
                  >
                    <span className="font-mono text-xs text-muted">{String(i + 1).padStart(2, '0')}</span>
                    <span className="truncate text-[13px] text-ink">
                      {name(arc.flow.from_iso3)} <span className="text-muted">→</span>{' '}
                      {name(arc.flow.to_iso3)}
                    </span>
                    <span className="font-mono text-xs text-ink">
                      {formatUsd(arc.value.usd)}
                      {arc.value.estimated && <span className="text-alert">*</span>}
                    </span>
                    <span />
                    <span className="col-span-2 mt-1 flex items-center gap-2">
                      <span className="relative h-[3px] flex-1 bg-line">
                        <span
                          className="absolute inset-y-0 left-0"
                          style={{ width: `${Math.max(2, fraction * 100)}%`, backgroundColor: arc.color }}
                        />
                      </span>
                      <span className="w-28 shrink-0 truncate text-right text-[11px] text-muted">
                        {FLOW_KIND_LABEL[arc.kind]}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        )}
      </div>

      <div className="mt-3 border-t border-line pt-3">
        <p className="hud-label text-muted">Sites</p>
        <div className="mt-1 flex flex-col">
          {STAGES.map((s) => (
            <LayerRow
              key={s}
              on={stageOn(s)}
              onClick={() => onToggleStage(s)}
              swatch={<Dot color={shade[s]} size={s === 'mine' ? 5 : s === 'process' ? 8 : 10} />}
              label={STAGE_LABEL[s]}
              value={facilityCounts[s].toLocaleString('en-US')}
            />
          ))}
        </div>
        <p className="mt-2 flex items-center gap-2 text-xs text-muted">
          <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full border border-dim" />
          Hollow ring = location poorly documented
        </p>
      </div>
    </aside>
  )
}
