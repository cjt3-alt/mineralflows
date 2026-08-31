import { useEffect, useRef } from 'react'
import {
  formatTonnes,
  formatUsd,
  formatUsdExact,
  type ArcDatum,
  type PointDatum,
} from '../data/derive.ts'
import type { Country, Mineral } from '../data/schema.ts'

/**
 * Detail for whichever facility or flow is selected. Closes on Escape, takes
 * focus when it opens, and hands focus back when it closes.
 *
 * The rule this panel exists to enforce: an estimated value never appears
 * without saying so, and a low-confidence record never appears looking verified.
 */

export type Selection =
  | { kind: 'facility'; point: PointDatum }
  | { kind: 'flow'; arc: ArcDatum }

export interface DetailPanelProps {
  selection: Selection | null
  mineralsById: ReadonlyMap<string, Mineral>
  countries: Record<string, Country>
  onClose: () => void
}

type BadgeTone = 'neutral' | 'warn'

function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: BadgeTone }) {
  return (
    <span
      className={
        'inline-flex items-center border px-1.5 py-0.5 font-mono text-2xs ' +
        (tone === 'warn'
          ? 'border-alert/50 text-alert'
          : 'border-line-strong text-dim')
      }
      style={{ borderRadius: 'var(--mf-radius)' }}
    >
      {children}
    </span>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-2">
      <dt className="shrink-0 text-xs text-muted">{label}</dt>
      <dd className="text-right font-mono text-xs text-ink">{children}</dd>
    </div>
  )
}

function SourceLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-xs text-dim underline underline-offset-2 hover:text-ink"
    >
      Open source
    </a>
  )
}

function FacilityDetail({
  point,
  mineralsById,
  countries,
}: {
  point: PointDatum
  mineralsById: ReadonlyMap<string, Mineral>
  countries: Record<string, Country>
}) {
  const p = point.facility.properties
  const [lng, lat] = point.facility.geometry.coordinates
  const country = countries[p.country_iso3]
  const minerals = p.mineral_ids.map((id) => mineralsById.get(id)?.name ?? id)

  return (
    <>
      <header className="mb-3">
        <p className="text-xs text-muted">Facility</p>
        <h2 className="mt-0.5 text-lg leading-tight text-ink">{p.name}</h2>
        <p className="mt-1 text-xs text-dim">
          {country?.name ?? p.country_iso3}
          {p.operator === null ? '' : ' · operated by ' + p.operator}
        </p>
      </header>

      <div className="mb-4 flex flex-wrap gap-1.5">
        <Badge>{p.stage}</Badge>
        <Badge>src: {p.source}</Badge>
        {p.confidence === 'low' && <Badge tone="warn">low confidence</Badge>}
      </div>

      {p.confidence === 'low' && (
        <p className="mb-4 border border-alert/40 bg-alert/5 p-2 text-xs text-dim">
          This site is poorly documented in public sources. Its location, operator and output are
          approximate, and it is drawn faint on the globe for that reason.
        </p>
      )}

      <dl>
        <Row label="Minerals">{minerals.join(', ')}</Row>
        <Row label="Stage">{p.stage}</Row>
        <Row label="Capacity">
          {p.capacity_tonnes_per_year === null ? (
            <span className="text-muted">not recorded</span>
          ) : (
            formatTonnes(p.capacity_tonnes_per_year) + '/yr'
          )}
        </Row>
        <Row label="Coordinates">
          {lat.toFixed(3)}, {lng.toFixed(3)}
        </Row>
        <Row label="Country">{p.country_iso3}</Row>
        <Row label="Updated">{p.last_updated}</Row>
      </dl>

      {p.source_url !== null && (
        <div className="mt-4">
          <SourceLink url={p.source_url} />
        </div>
      )}
    </>
  )
}

function FlowDetail({
  arc,
  mineralsById,
  countries,
}: {
  arc: ArcDatum
  mineralsById: ReadonlyMap<string, Mineral>
  countries: Record<string, Country>
}) {
  const { flow, value } = arc
  const from = countries[flow.from_iso3]
  const to = countries[flow.to_iso3]
  const mineral = mineralsById.get(flow.mineral_id)

  return (
    <>
      <header className="mb-3">
        <p className="text-xs text-muted">Flow</p>
        <h2 className="mt-0.5 text-lg leading-tight text-ink">
          {from?.name ?? flow.from_iso3} to {to?.name ?? flow.to_iso3}
        </h2>
        <p className="mt-1 text-xs text-dim">
          {mineral?.name ?? flow.mineral_id}, {flow.stage_from} to {flow.stage_to}, {flow.year}
        </p>
      </header>

      <div className="mb-4 flex flex-wrap gap-1.5">
        <Badge>src: {flow.source}</Badge>
        {value.estimated && <Badge tone="warn">estimated value</Badge>}
        {flow.confidence === 'low' && <Badge tone="warn">low confidence</Badge>}
      </div>

      {value.estimated && (
        <p className="mb-4 border border-alert/40 bg-alert/5 p-2 text-xs text-dim">
          This is volume multiplied by an average annual price, not a traded value. Treat it as an
          order of magnitude.
          {value.derivedFrom !== null && (
            <>
              {' '}
              Derived here from {formatTonnes(value.derivedFrom.volumeTonnes)} at{' '}
              {formatUsdExact(value.derivedFrom.pricePerTonne)}/t ({value.derivedFrom.priceYear}).
            </>
          )}
        </p>
      )}

      <dl>
        <Row label={value.estimated ? 'Estimated value' : 'Value'}>
          {formatUsd(value.usd)}
          {value.estimated && <span className="ml-1 text-muted">est.</span>}
        </Row>
        <Row label="Volume">{formatTonnes(flow.volume_tonnes)}</Row>
        <Row label="Route">
          {flow.from_iso3} → {flow.to_iso3}
        </Row>
        <Row label="Stage">
          {flow.stage_from} → {flow.stage_to}
        </Row>
        <Row label="Year">{flow.year}</Row>
        <Row label="Flow id">{flow.id}</Row>
      </dl>
    </>
  )
}

export function DetailPanel({ selection, mineralsById, countries, onClose }: DetailPanelProps) {
  const panelRef = useRef<HTMLElement>(null)
  const returnFocusTo = useRef<Element | null>(null)

  useEffect(() => {
    if (selection === null) return
    returnFocusTo.current = document.activeElement
    panelRef.current?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      const target = returnFocusTo.current
      if (target instanceof HTMLElement) target.focus()
    }
  }, [selection, onClose])

  if (selection === null) return null

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      aria-label="Detail"
      className="w-88 shrink-0 overflow-y-auto border-l border-line bg-surface p-4"
      style={{ width: 'var(--mf-panel-width)' }}
    >
      <div className="mb-3 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-muted hover:text-ink"
          aria-label="Close detail panel"
        >
          Close
        </button>
      </div>

      {selection.kind === 'facility' ? (
        <FacilityDetail
          point={selection.point}
          mineralsById={mineralsById}
          countries={countries}
        />
      ) : (
        <FlowDetail arc={selection.arc} mineralsById={mineralsById} countries={countries} />
      )}
    </aside>
  )
}
