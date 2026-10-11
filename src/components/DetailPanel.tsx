import { useEffect, useRef, type ReactNode } from 'react'
import {
  FLOW_KIND_DETAIL,
  FLOW_KIND_LABEL,
  STAGE_LABEL,
  STAGE_LABEL_SINGULAR,
  formatLatLng,
  formatShare,
  formatTonnes,
  formatUsd,
  formatUsdExact,
  type ArcDatum,
  type CountrySummary,
  type PointDatum,
} from '../data/derive.ts'
import { STAGES, type Country, type Mineral } from '../data/schema.ts'

/**
 * The dossier for whatever is selected: a facility, a flow, or a focused
 * country. Closes on Escape, takes focus when it opens, and hands focus back
 * when it closes.
 *
 * The rule this panel exists to enforce: an estimated value never appears
 * without saying so, and a low-confidence record never appears looking verified.
 */

export type Selection =
  | { kind: 'facility'; point: PointDatum }
  | { kind: 'flow'; arc: ArcDatum }
  | { kind: 'country'; iso3: string; summary: CountrySummary }

export interface DetailPanelProps {
  selection: Selection | null
  mineralsById: ReadonlyMap<string, Mineral>
  countries: Record<string, Country>
  onClose: () => void
  /** Offered on facilities and flows, to jump to a country's dossier. */
  onFocusCountry?: (iso3: string) => void
  /**
   * `sheet` is the narrow-viewport layout: the same content, over the map
   * from the bottom edge rather than floating beside it.
   */
  variant?: 'panel' | 'sheet'
}

type BadgeTone = 'neutral' | 'warn' | 'accent'

function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: BadgeTone }) {
  const cls =
    tone === 'warn'
      ? 'border-alert/50 text-alert'
      : tone === 'accent'
        ? 'border-accent/50 text-accent'
        : 'border-line-strong text-dim'
  return (
    <span className={'hud-label inline-flex items-center border px-1.5 py-0.5 ' + cls} style={{ borderRadius: 'var(--mf-radius)' }}>
      {children}
    </span>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-2">
      <dt className="shrink-0 text-xs text-muted">{label}</dt>
      <dd className="text-right font-mono text-xs text-ink">{children}</dd>
    </div>
  )
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <h3 className="section-title mt-5 mb-2">{children}</h3>
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <p className="mb-4 border border-alert/40 border-l-2 border-l-alert bg-alert/5 p-2.5 text-xs leading-relaxed text-dim">
      {children}
    </p>
  )
}

function SourceLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="hud-label text-dim underline decoration-line-strong underline-offset-4 hover:text-accent hover:decoration-accent"
    >
      Open source
    </a>
  )
}

function FocusButton({ iso3, name, onFocus }: { iso3: string; name: string; onFocus?: ((iso3: string) => void) | undefined }) {
  if (!onFocus) return null
  return (
    <button
      type="button"
      onClick={() => onFocus(iso3)}
      aria-label={'Focus ' + name}
      className="hud-label border border-line-strong px-2 py-1 text-dim hover:border-accent hover:text-ink"
      style={{ borderRadius: 'var(--mf-radius)' }}
    >
      {iso3} dossier →
    </button>
  )
}

function Header({ kicker, title, sub }: { kicker: ReactNode; title: ReactNode; sub?: ReactNode }) {
  return (
    <header className="mb-3">
      <p className="hud-label text-accent">{kicker}</p>
      <h2 className="mt-1 font-display text-xl leading-tight font-semibold tracking-wide text-ink">{title}</h2>
      {sub && <p className="mt-1 text-xs text-dim">{sub}</p>}
    </header>
  )
}

function Figure({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="border-t border-line-strong pt-2.5 pb-1">
      <p className="hud-label text-muted">{label}</p>
      <p className="mt-1 font-display text-[1.75rem] leading-none font-medium tracking-tight text-ink">{value}</p>
      {note && <p className="mt-0.5 text-xs text-muted">{note}</p>}
    </div>
  )
}

function FacilityDetail({
  point,
  mineralsById,
  countries,
  onFocusCountry,
}: {
  point: PointDatum
  mineralsById: ReadonlyMap<string, Mineral>
  countries: Record<string, Country>
  onFocusCountry?: ((iso3: string) => void) | undefined
}) {
  const p = point.facility.properties
  const [lng, lat] = point.facility.geometry.coordinates
  const country = countries[p.country_iso3]
  const minerals = p.mineral_ids.map((id) => mineralsById.get(id)?.name ?? id)

  return (
    <>
      <Header
        kicker={'Site · ' + STAGE_LABEL_SINGULAR[p.stage]}
        title={p.name}
        sub={
          <>
            {country?.name ?? p.country_iso3}
            {p.operator === null ? '' : ' · operated by ' + p.operator}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <Badge>src: {p.source}</Badge>
        {p.confidence === 'low' && <Badge tone="warn">low confidence</Badge>}
        <span className="ml-auto">
          <FocusButton iso3={p.country_iso3} name={country?.name ?? p.country_iso3} onFocus={onFocusCountry} />
        </span>
      </div>

      {p.confidence === 'low' && (
        <Warning>
          This site is poorly documented in public sources. Its location, operator and output are
          approximate, and it is drawn as a hollow ring on the map for that reason.
        </Warning>
      )}

      <dl>
        <Row label="Minerals">{minerals.join(', ')}</Row>
        <Row label="Stage">{STAGE_LABEL_SINGULAR[p.stage]}</Row>
        <Row label="Capacity">
          {p.capacity_tonnes_per_year === null ? (
            <span className="text-muted">not recorded</span>
          ) : (
            formatTonnes(p.capacity_tonnes_per_year) + '/yr'
          )}
        </Row>
        <Row label="Coordinates">{formatLatLng(lat, lng, 3)}</Row>
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
  onFocusCountry,
}: {
  arc: ArcDatum
  mineralsById: ReadonlyMap<string, Mineral>
  countries: Record<string, Country>
  onFocusCountry?: ((iso3: string) => void) | undefined
}) {
  const { flow, value, kind } = arc
  const fromName = countries[flow.from_iso3]?.name ?? flow.from_iso3
  const toName = countries[flow.to_iso3]?.name ?? flow.to_iso3
  const mineral = mineralsById.get(flow.mineral_id)

  return (
    <>
      <Header
        kicker={'Flow · ' + flow.from_iso3 + ' → ' + flow.to_iso3}
        title={
          <>
            {fromName} <span className="text-muted">→</span> {toName}
          </>
        }
        sub={
          <>
            {mineral?.name ?? flow.mineral_id} · {FLOW_KIND_LABEL[kind]} · {flow.year}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap gap-1.5">
        <Badge>src: {flow.source}</Badge>
        {value.estimated && <Badge tone="warn">estimated value</Badge>}
        {flow.confidence === 'low' && <Badge tone="warn">low confidence</Badge>}
      </div>

      {value.estimated && (
        <Warning>
          This is volume multiplied by an average annual price, not a traded value. Treat it as an
          order of magnitude.
          {value.derivedFrom !== null && (
            <>
              {' '}
              Derived here from {formatTonnes(value.derivedFrom.volumeTonnes)} at{' '}
              {formatUsdExact(value.derivedFrom.pricePerTonne)}/t ({value.derivedFrom.priceYear}).
            </>
          )}
        </Warning>
      )}
      {flow.confidence === 'low' && !value.estimated && (
        <Warning>
          Only the importing country reported this trade. Direction and value come from its mirror
          record, so treat it as less certain than an exporter-reported flow.
        </Warning>
      )}

      <div className="mb-4 grid grid-cols-1">
        <Figure
          label={value.estimated ? 'Estimated' : 'Traded value'}
          value={
            <>
              {formatUsd(value.usd)}
              {value.estimated && <span className="ml-1 text-base text-alert">est.</span>}
            </>
          }
          note={FLOW_KIND_DETAIL[kind]}
        />
      </div>

      <dl>
        <Row label={value.estimated ? 'Estimated value' : 'Value'}>{formatUsd(value.usd)}</Row>
        <Row label="Volume">{formatTonnes(flow.volume_tonnes)}</Row>
        <Row label="Route">
          {flow.from_iso3} → {flow.to_iso3}
        </Row>
        <Row label="Material">{FLOW_KIND_LABEL[kind]}</Row>
        <Row label="Year">{flow.year}</Row>
        <Row label="Record">{flow.id}</Row>
      </dl>

      {onFocusCountry && (
        <div className="mt-4 flex flex-wrap gap-2">
          <FocusButton iso3={flow.from_iso3} name={fromName} onFocus={onFocusCountry} />
          <FocusButton iso3={flow.to_iso3} name={toName} onFocus={onFocusCountry} />
        </div>
      )}
    </>
  )
}

function PartnerList({
  partners,
  countries,
  total,
  onFocusCountry,
}: {
  partners: CountrySummary['topDestinations']
  countries: Record<string, Country>
  total: number
  onFocusCountry?: ((iso3: string) => void) | undefined
}) {
  if (partners.length === 0) return <p className="text-xs text-muted">None in the data.</p>
  return (
    <ol className="flex flex-col gap-1">
      {partners.map((p) => {
        const share = total > 0 ? p.usd / total : 0
        const name = countries[p.iso3]?.name ?? p.iso3
        return (
          <li key={p.iso3}>
            <button
              type="button"
              onClick={() => onFocusCountry?.(p.iso3)}
              disabled={!onFocusCountry}
              className="grid w-full grid-cols-[1fr_auto_2.5rem] items-center gap-x-2 py-0.5 text-left hover:text-accent"
            >
              <span className="truncate text-[13px] text-ink">{name}</span>
              <span className="font-mono text-xs text-dim">{formatUsd(p.usd)}</span>
              <span className="text-right font-mono text-xs text-muted">{formatShare(share)}</span>
              <span className="col-span-3 mt-0.5 h-[2px] bg-line">
                <span className="block h-full bg-copper/80" style={{ width: `${Math.max(2, share * 100)}%` }} />
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

function CountryDetail({
  summary,
  countries,
  onFocusCountry,
}: {
  summary: CountrySummary
  countries: Record<string, Country>
  onFocusCountry?: ((iso3: string) => void) | undefined
}) {
  const name = countries[summary.iso3]?.name ?? summary.iso3
  const sites = STAGES.reduce((n, s) => n + summary.facilities[s], 0)
  const net = summary.exportsUsd - summary.importsUsd

  return (
    <>
      <Header kicker={'Country dossier · ' + summary.iso3} title={name} sub="All flows matching the current filters" />

      <div className="grid grid-cols-2 gap-4">
        <Figure label="Exports" value={formatUsd(summary.exportsUsd)} note={formatShare(summary.shareOfExports) + ' of world flows'} />
        <Figure label="Imports" value={formatUsd(summary.importsUsd)} note={formatShare(summary.shareOfImports) + ' of world flows'} />
      </div>
      {summary.exportsUsd > 0 && summary.exportsBuyerReportedUsd / summary.exportsUsd > 0.5 && (
        <div className="mt-3">
          <Warning>
            {summary.exportsBuyerReportedUsd >= summary.exportsUsd * 0.995
              ? `All of ${name}'s exports here`
              : `${formatShare(summary.exportsBuyerReportedUsd / summary.exportsUsd)} of ${name}'s exports here`}{' '}
            come only from its buyers&rsquo; customs records: {name} did not report them itself. They
            show where its copper went, but treat the values as less certain, and expect trade that
            no buyer reported to be missing entirely.
          </Warning>
        </div>
      )}

      <p className="mt-2 text-xs text-muted">
        Net position:{' '}
        <span className={net >= 0 ? 'text-ok' : 'text-alert'}>
          {net >= 0 ? 'net exporter' : 'net importer'} by {formatUsd(Math.abs(net))}
        </span>
      </p>

      <SectionLabel>What it ships and buys</SectionLabel>
      <dl>
        {STAGES.map((k) => (
          <Row key={k} label={FLOW_KIND_LABEL[k]}>
            <span className="text-dim">out</span> {formatUsd(summary.exportsByKind[k])}{' '}
            <span className="ml-2 text-dim">in</span> {formatUsd(summary.importsByKind[k])}
          </Row>
        ))}
      </dl>

      <SectionLabel>Top destinations</SectionLabel>
      <PartnerList partners={summary.topDestinations} countries={countries} total={summary.exportsUsd} onFocusCountry={onFocusCountry} />

      <SectionLabel>Top suppliers</SectionLabel>
      <PartnerList partners={summary.topOrigins} countries={countries} total={summary.importsUsd} onFocusCountry={onFocusCountry} />

      <SectionLabel>Sites in country</SectionLabel>
      {sites === 0 ? (
        <p className="text-xs text-muted">No sites recorded in the dataset.</p>
      ) : (
        <dl>
          {STAGES.map((s) => (
            <Row key={s} label={STAGE_LABEL[s]}>
              {summary.facilities[s]}
            </Row>
          ))}
        </dl>
      )}
    </>
  )
}

export function DetailPanel({
  selection,
  mineralsById,
  countries,
  onClose,
  onFocusCountry,
  variant = 'panel',
}: DetailPanelProps) {
  const panelRef = useRef<HTMLElement>(null)
  const returnFocusTo = useRef<Element | null>(null)
  const key =
    selection === null
      ? null
      : selection.kind === 'facility'
        ? selection.point.id
        : selection.kind === 'flow'
          ? selection.arc.id
          : 'country:' + selection.iso3

  useEffect(() => {
    if (key === null) return
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
      if (target instanceof HTMLElement && document.contains(target)) target.focus()
    }
  }, [key, onClose])

  if (selection === null) return null

  const sheet = variant === 'sheet'

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      aria-label="Detail"
      className={
        'panel scroll-quiet z-10 overflow-y-auto ' +
        (sheet
          ? 'absolute inset-x-0 bottom-0 max-h-[68%] border-x-0 border-b-0 p-4'
          : 'absolute top-4 right-4 bottom-4 p-5')
      }
      style={sheet ? undefined : { width: 'var(--mf-panel-width)' }}
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="hud-label text-muted">
          {selection.kind === 'facility' ? 'Record' : selection.kind === 'flow' ? 'Record' : 'Dossier'}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="hud-label border border-line-strong px-2 py-0.5 text-muted hover:border-accent hover:text-ink"
          aria-label="Close detail panel"
        >
          Close ×
        </button>
      </div>

      {selection.kind === 'facility' ? (
        <FacilityDetail point={selection.point} mineralsById={mineralsById} countries={countries} onFocusCountry={onFocusCountry} />
      ) : selection.kind === 'flow' ? (
        <FlowDetail arc={selection.arc} mineralsById={mineralsById} countries={countries} onFocusCountry={onFocusCountry} />
      ) : (
        <CountryDetail summary={selection.summary} countries={countries} onFocusCountry={onFocusCountry} />
      )}
    </aside>
  )
}
