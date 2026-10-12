import { useEffect, useRef, type ReactNode } from 'react'
import type { Meta } from '../data/schema.ts'

/**
 * Sources and method, in plain language. A native <dialog>, so focus trapping,
 * Escape and the backdrop come from the browser rather than from code here.
 */

export interface AboutDialogProps {
  open: boolean
  onClose: () => void
  meta: Meta
}

function Block({ index, title, children }: { index: string; title: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h3 className="section-title mb-3">
        <span className="index">{index}</span>
        <span>{title}</span>
      </h3>
      <div className="flex flex-col gap-2 text-sm leading-relaxed text-dim">{children}</div>
    </section>
  )
}

export function AboutDialog({ open, onClose, meta }: AboutDialogProps) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === e.currentTarget) onClose()
      }}
      aria-labelledby="about-title"
      className="panel m-auto max-h-[86vh] w-[min(44rem,calc(100vw-2rem))] overflow-y-auto p-0 text-ink"
    >
      <div className="bracketed p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="hud-label text-accent">Briefing · Sources & method</p>
            <h2 id="about-title" className="mt-1 font-display text-2xl font-semibold tracking-wide">
              How to read MineralFlows
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="hud-label border border-line-strong px-2 py-1 text-muted hover:border-accent hover:text-ink"
          >
            Close
          </button>
        </div>

        <p className="mt-4 text-sm leading-relaxed text-dim">
          MineralFlows maps where critical minerals are mined, smelted and refined, and how they move
          between countries as they are worked up the supply chain. It is built entirely from public
          data, and every number on screen traces back to a named source below.
        </p>

        <Block index="01" title="Reading the map">
          <p>
            <span className="text-ink">Points are sites.</span> Small, dark points are mines; larger,
            brighter ones are smelters and refineries, where the processing chokepoints sit. A hollow
            ring means the site&rsquo;s location is poorly documented.
          </p>
          <p>
            <span className="text-ink">Arcs are trade.</span> Each arc is one country pair and one
            kind of material, for one year, drawn from exporter to importer. Width is value, on a
            square-root scale so smaller flows stay visible. Colour follows the material: dark copper
            for ore and concentrate, mid copper for smelted intermediates, pale gold for refined
            metal. A dashed arc was reported only by the importer.
          </p>
          <p>
            <span className="text-ink">Cyan is you.</span> Whatever you hover, select or focus turns
            cyan. Click a country to see only its trade and a breakdown of its position.
          </p>
          <p>
            <span className="text-ink">The projection is Mercator</span>, the one web maps use. Like
            every flat map it distorts: land near the poles is drawn larger than it is. The map is cut
            where the least trade crosses, which for copper puts the Pacific, where the largest flows
            run, in the middle.
          </p>
        </Block>

        <Block index="02" title="Sources">
          <ul className="flex flex-col gap-3">
            {meta.sources.map((s) => (
              <li key={s.id} className="border-l-2 border-line-strong pl-3">
                <p className="text-ink">
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-2 hover:decoration-accent">
                      {s.name}
                    </a>
                  ) : (
                    s.name
                  )}{' '}
                  <span className="font-mono text-xs text-muted">· {s.vintage}</span>
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">{s.coverage}</p>
              </li>
            ))}
          </ul>
        </Block>

        <Block index="03" title="Base map">
          <ul className="flex flex-col gap-3">
            <li className="border-l-2 border-line-strong pl-3">
              <p className="text-ink">Terrain Tiles on AWS Open Data</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">
                Elevation for the shaded relief of land and sea floor, from Mapzen&rsquo;s Tilezen
                project. Sources include SRTM, GMTED2010 and ETOPO1. Shaded and tinted for this app.
              </p>
            </li>
            <li className="border-l-2 border-line-strong pl-3">
              <p className="text-ink">Natural Earth</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">
                Country borders and coastlines. Public domain.
              </p>
            </li>
          </ul>
        </Block>

        <Block index="04" title="Caveats">
          <ul className="list-disc space-y-1.5 pl-5 marker:text-muted">
            <li>
              Arcs start and end at capital cities. They show which countries trade, not which ports
              or plants the material moved through.
            </li>
            <li>
              Values are customs-reported traded values in US dollars. Where only a volume exists, the
              value is volume times an annual average price, and it is marked as an estimate wherever
              it appears.
            </li>
            <li>
              Trade covers three forms: ore and concentrate, smelted intermediates, and refined metal
              (cathode, wire-bar, billet). Scrap and semi-finished or finished products, such as wire,
              tube, sheet and copper inside cables and electronics, are not included. A country&rsquo;s
              &ldquo;net importer&rdquo; or &ldquo;net exporter&rdquo; position is for those three forms
              only, not its whole copper balance.
            </li>
            <li>
              The data keeps each mineral&rsquo;s 500 largest country-to-country flows; the rest, each
              small, are left out. The map draws the largest 25, 100 or 300 of those, and the totals in
              the control panel count all 500, drawn or not.
            </li>
            <li>
              Site coverage follows the ICMM dataset. Small and informal operations are under-counted,
              and sites carry no capacity figures, so point size shows stage, not output.
            </li>
          </ul>
        </Block>

        <p className="mt-6 border-t border-line pt-4 text-xs text-muted">
          Data generated {meta.generated_at.slice(0, 10)}. Code and pipeline:{' '}
          <a
            href="https://github.com/cjt3-alt/mineralflows"
            target="_blank"
            rel="noreferrer"
            className="text-dim underline underline-offset-2 hover:text-accent"
          >
            github.com/cjt3-alt/mineralflows
          </a>
        </p>
      </div>
    </dialog>
  )
}
