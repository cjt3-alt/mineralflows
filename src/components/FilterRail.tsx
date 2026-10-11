import { useId, useState, type ReactNode } from 'react'
import {
  FLOW_KIND_LABEL,
  STAGE_LABEL,
  TOP_N_OPTIONS,
  formatUsd,
  type ArcDatum,
} from '../data/derive.ts'
import { STAGES, type Country, type Stage } from '../data/schema.ts'
import type { TerrainLayers } from './MapCanvas.tsx'

/**
 * The control column: what is on screen, what can be switched on and off, and
 * the largest flows as a list you can point at. Everything here is a view of
 * state the shell owns.
 *
 * Sites and flows are separate layer groups. Each row is a switch that is on
 * by default; turning one off hides that layer. The last layer in a group
 * cannot be switched off, because an empty group would only ever mean
 * "show nothing", which is never what anyone wants from a click.
 */

export interface Overview {
  /** Value of every flow that passes the filters, before the top-N cap. */
  tradeUsd: number
  flowsDrawn: number
  flowsTotal: number
  sites: number
  countries: number
}

export interface FilterRailProps {
  overview: Overview
  countries: Record<string, Country>
  /** ISO3 codes a search can land on: anything with a flow or a site. */
  searchableCountries: string[]
  focusCountry: string | null
  onFocusCountry: (iso3: string) => void
  onClearFocus: () => void

  /** Layers on. Empty means all. */
  stages: Stage[]
  facilityCounts: Record<Stage, number>
  onToggleStage: (stage: Stage) => void

  flowKinds: Stage[]
  valueByKind: Record<Stage, number>
  onToggleFlowKind: (kind: Stage) => void

  topN: number
  onChangeTopN: (n: number) => void

  topFlows: ArcDatum[]
  selectedId: string | null
  onHoverFlow: (id: string | null) => void
  onSelectFlow: (arc: ArcDatum) => void

  /** Stage shades of the active mineral, for swatches that match the map. */
  shade: Record<Stage, string>

  terrainLayers: TerrainLayers
  onToggleTerrain: (layer: keyof TerrainLayers) => void
}

function Section({ index, title, children, aside }: { index: string; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-4">
      <div className="mb-3 flex items-center gap-3">
        <h2 className="section-title flex-1">
          <span className="index">{index}</span>
          <span>{title}</span>
        </h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="px-3 py-3">
      <dt className="hud-label text-muted">{label}</dt>
      <dd className="mt-1 font-display text-[1.65rem] leading-none font-medium tracking-tight text-ink">{value}</dd>
      {sub && <dd className="mt-1.5 text-xs text-muted">{sub}</dd>}
    </div>
  )
}

function LayerRow({
  on,
  onClick,
  swatch,
  label,
  value,
}: {
  on: boolean
  onClick: () => void
  swatch: ReactNode
  label: string
  value: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      className={
        'group relative flex w-full items-center gap-3 py-1.5 pr-1 pl-3 text-left transition-colors hover:bg-white/[0.025] ' +
        (on ? 'text-ink' : 'text-muted hover:text-dim')
      }
    >
      <span
        aria-hidden="true"
        className={
          'absolute top-1.5 bottom-1.5 left-0 w-[2px] transition-colors ' + (on ? 'bg-accent' : 'bg-line-strong')
        }
      />
      <span className="flex w-7 shrink-0 items-center justify-center" style={{ opacity: on ? 1 : 0.35 }}>
        {swatch}
      </span>
      <span className="flex-1 text-[13px]">{label}</span>
      <span className="font-mono text-xs text-muted">{value}</span>
    </button>
  )
}

function Dot({ color, size }: { color: string; size: number }) {
  // The same soft glow the map gives smelters and refineries, scaled with size.
  return (
    <span
      className="inline-block rounded-full"
      style={{ width: size, height: size, backgroundColor: color, boxShadow: `0 0 ${size - 3}px ${color}` }}
    />
  )
}

function Line({ color, thickness }: { color: string; thickness: number }) {
  // Dim at the exporter end, bright where it lands, like the arcs.
  return (
    <span
      className="inline-block w-7 rounded-full"
      style={{
        height: thickness,
        background: `linear-gradient(90deg, color-mix(in srgb, ${color} 45%, black), ${color} 70%, color-mix(in srgb, ${color} 55%, #ffdcb4))`,
        boxShadow: `0 0 4px color-mix(in srgb, ${color} 50%, transparent)`,
      }}
    />
  )
}

const DOT_SIZE: Record<Stage, number> = { mine: 5, process: 8, refine: 10 }
const LINE_THICKNESS: Record<Stage, number> = { mine: 2, process: 2, refine: 2 }

function CountrySearch({
  countries,
  searchable,
  onPick,
}: {
  countries: Record<string, Country>
  searchable: string[]
  onPick: (iso3: string) => void
}) {
  const id = useId()
  const [text, setText] = useState('')
  const byName = new Map(searchable.map((iso3) => [(countries[iso3]?.name ?? iso3).toLowerCase(), iso3]))

  const commit = (value: string) => {
    const v = value.trim().toLowerCase()
    const hit = byName.get(v) ?? searchable.find((iso3) => iso3.toLowerCase() === v)
    if (hit) {
      onPick(hit)
      setText('')
    }
  }

  return (
    <div>
      <label htmlFor={id} className="sr-only">
        Focus a country
      </label>
      <div className="flex items-center gap-2 border border-line-strong bg-void px-2 focus-within:border-accent">
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" className="shrink-0 text-muted">
          <circle cx="5" cy="5" r="3.75" fill="none" stroke="currentColor" strokeWidth="1.25" />
          <path d="M8 8l3 3" stroke="currentColor" strokeWidth="1.25" />
        </svg>
        <input
          id={id}
          list={id + '-list'}
          value={text}
          placeholder="Search a country…"
          onChange={(e) => {
            setText(e.target.value)
            // A datalist pick arrives as a change with the full name.
            if (byName.has(e.target.value.trim().toLowerCase())) commit(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(text)
          }}
          className="w-full bg-transparent py-1.5 text-[13px] text-ink placeholder:text-muted focus:outline-none"
          autoComplete="off"
        />
        <datalist id={id + '-list'}>
          {searchable
            .map((iso3) => countries[iso3]?.name ?? iso3)
            .sort((a, b) => a.localeCompare(b))
            .map((name) => (
              <option key={name} value={name} />
            ))}
        </datalist>
      </div>
      <p className="mt-1.5 text-xs text-muted">Or click any country on the map.</p>
    </div>
  )
}

export function FilterRail(props: FilterRailProps) {
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
    terrainLayers,
    onToggleTerrain,
  } = props

  const stageOn = (s: Stage) => stages.length === 0 || stages.includes(s)
  const kindOn = (k: Stage) => flowKinds.length === 0 || flowKinds.includes(k)
  const maxTop = topFlows[0]?.value.usd ?? 0
  const name = (iso3: string) => countries[iso3]?.name ?? iso3

  return (
    <>
      <Section index="01" title="Overview">
        <dl className="-mx-3 grid grid-cols-2 [&>*:nth-child(-n+2)]:border-b [&>*:nth-child(-n+2)]:border-line [&>*:nth-child(even)]:border-l [&>*:nth-child(even)]:border-line">
          <Kpi label="Trade value" value={formatUsd(overview.tradeUsd)} sub={focusCountry ? name(focusCountry) : 'All flows'} />
          <Kpi label="Flows drawn" value={String(overview.flowsDrawn)} sub={`of ${overview.flowsTotal}`} />
          <Kpi label="Sites" value={overview.sites.toLocaleString('en-US')} sub="Mines to refineries" />
          <Kpi label="Countries" value={String(overview.countries)} sub="With trade or sites" />
        </dl>
      </Section>

      <Section
        index="02"
        title="Focus"
        aside={
          focusCountry && (
            <button type="button" onClick={onClearFocus} className="hud-label text-muted hover:text-ink">
              Clear
            </button>
          )
        }
      >
        {focusCountry ? (
          <div className="bracketed flex items-center justify-between border border-accent/40 bg-accent/5 px-3 py-2">
            <div>
              <p className="hud-label text-accent">Country · {focusCountry}</p>
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
      </Section>

      <Section index="03" title="Sites">
        <div className="flex flex-col">
          {STAGES.map((s) => (
            <LayerRow
              key={s}
              on={stageOn(s)}
              onClick={() => onToggleStage(s)}
              swatch={<Dot color={shade[s]} size={DOT_SIZE[s]} />}
              label={STAGE_LABEL[s]}
              value={facilityCounts[s].toLocaleString('en-US')}
            />
          ))}
        </div>
        <p className="mt-2 flex items-center gap-2 text-xs text-muted">
          <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full border border-dim" />
          Hollow ring = location poorly documented
        </p>
      </Section>

      <Section index="04" title="Flows">
        <div className="flex flex-col">
          {STAGES.map((k) => (
            <LayerRow
              key={k}
              on={kindOn(k)}
              onClick={() => onToggleFlowKind(k)}
              swatch={<Line color={shade[k]} thickness={LINE_THICKNESS[k]} />}
              label={FLOW_KIND_LABEL[k]}
              value={formatUsd(valueByKind[k])}
            />
          ))}
        </div>

        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="hud-label text-muted" id="topn-label">
            Draw
          </span>
          <div role="radiogroup" aria-labelledby="topn-label" className="flex flex-1 border border-line-strong">
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
        <p className="mt-2 text-xs text-muted">Largest flows by value. Arc width is value.</p>
      </Section>

      <Section index="05" title="Terrain">
        <div className="flex flex-col">
          <LayerRow
            on={terrainLayers.relief}
            onClick={() => onToggleTerrain('relief')}
            swatch={
              <span
                className="inline-block h-3 w-7"
                style={{ background: 'linear-gradient(90deg, #0b1726, #2e4256 45%, #5a7690 55%, #1d2f40)' }}
              />
            }
            label="Relief & sea floor"
            value=""
          />
          <LayerRow
            on={terrainLayers.plates}
            onClick={() => onToggleTerrain('plates')}
            swatch={<span className="inline-block w-7 border-t-2 border-dashed" style={{ borderColor: 'rgba(176, 150, 255, 0.8)' }} />}
            label="Tectonic plate boundaries"
            value=""
          />
          <LayerRow
            on={terrainLayers.ranges}
            onClick={() => onToggleTerrain('ranges')}
            swatch={<span className="font-mono text-[9px] tracking-widest text-dim">ABC</span>}
            label="Mountain ranges"
            value=""
          />
        </div>
        <p className="mt-2 text-xs text-muted">
          Most mined copper comes from porphyry deposits, formed above subduction zones where plates
          converge. That is why the Andes line up with Chile and Peru.
        </p>
      </Section>

      <Section index="06" title="Largest flows">
        {topFlows.length === 0 ? (
          <p className="text-xs text-muted">No flows match these filters.</p>
        ) : (
          <ol className="flex flex-col" onMouseLeave={() => onHoverFlow(null)}>
            {topFlows.map((arc, i) => {
              const fraction = maxTop > 0 ? (arc.value.usd ?? 0) / maxTop : 0
              const selected = arc.id === selectedId
              return (
                <li key={arc.id}>
                  <button
                    type="button"
                    onClick={() => onSelectFlow(arc)}
                    onMouseEnter={() => onHoverFlow(arc.id)}
                    onFocus={() => onHoverFlow(arc.id)}
                    onBlur={() => onHoverFlow(null)}
                    className={
                      'group grid w-full grid-cols-[1.25rem_1fr_auto] items-baseline gap-x-2 border-l-2 px-2 py-1.5 text-left hover:bg-accent/5 ' +
                      (selected ? 'border-accent bg-accent/10' : 'border-transparent')
                    }
                  >
                    <span className="font-mono text-xs text-muted">{String(i + 1).padStart(2, '0')}</span>
                    <span className="truncate text-[13px] text-ink">
                      {name(arc.flow.from_iso3)} <span className="text-muted">→</span> {name(arc.flow.to_iso3)}
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
                      <span className="w-32 shrink-0 truncate text-right text-[11px] text-muted">
                        {FLOW_KIND_LABEL[arc.kind]}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        )}
      </Section>
    </>
  )
}
