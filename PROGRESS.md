# Progress

Working log for the MineralFlows scaffold build. Updated at the end of every phase.

**Last updated:** 2026-08-31. All six phases complete. The app, the data contract, the ETL, both
workflows and the polish pass are done and committed.

## Phases

| Phase | Scope                                                        | Status      |
| ----- | ------------------------------------------------------------ | ----------- |
| 0     | Repo, tooling, CI, deploy target                             | ✅ complete |
| 1     | Data contract: types, schema validation, seed data, loader   | ✅ complete |
| 2     | Globe canvas: points, arcs, bloom, interaction               | ✅ complete |
| 3     | Dashboard shell: top bar, filter rail, detail panel, legend  | ✅ complete |
| 4     | ETL skeleton and refresh workflow                            | ✅ complete |
| 5     | Polish: responsive, keyboard, reduced motion, states, README | ✅ complete |

## Where things stand

Repo is at <https://github.com/cjt3-alt/mineralflows>, deployed to
<https://cjt3-alt.github.io/mineralflows/>.

The app runs on the seed dataset: 4 minerals, 30 facilities, 28 flows, 8 prices, 17 country
centroids. Globe with glowing arcs and points, mineral and stage filters, working detail panel,
legend, shareable URLs, and a keyboard path through the globe. 63 vitest tests and 43 ETL test
assertions pass; typecheck, eslint, ruff and the production build are clean, and the built bundle
was confirmed working from `npm run preview`.

The ETL reads six real sources and runs end to end in every combination of `--offline` and
`--no-manual`. A full run with everything reachable produces 1,364 facilities and 2,000 flows and
was verified to validate against the app's own schema — but that output is **not** what is
committed. See the next section.

### Deliberate: `public/data/` is still the seed dataset

`public/data/` is exactly what `python etl/pipeline.py --offline --no-manual` writes, and
`deploy.yml` checks that on every push. Swapping thirty checkable facilities for thirteen hundred
and twenty-eight flows for two thousand is a change worth reading a diff for, and `refresh-data.yml`
exists to deliver it as a pull request. The brief also scoped this session as a scaffold rather than
a data project.

**To ship the real data:** run `refresh-data.yml` via `workflow_dispatch` and merge the PR it opens.
Or locally, `python etl/pipeline.py && npm test`, then commit.

### Verification note

The globe was confirmed rendering in the automated browser pane this session, at desktop, tablet
and mobile viewport sizes, in both the dev server and the production preview. The earlier note about
a black canvas turned out to be a pane-compositing artifact that does not always occur. The
keyboard path was exercised end to end: focus the globe, arrow to a flow, Enter, and the detail
panel opens with the estimated-value warning.

Not exercised in a real browser: `prefers-reduced-motion` (the pane cannot emulate it) and a real
touch device.

## Assumptions and deferred items

Decisions made without asking, listed so they can be reversed cheaply.

**From phase 0**

- **TypeScript pinned to `~6.0.3`, not the latest 7.0.2.** `typescript-eslint@8.68.0` declares
  `typescript >=4.8.4 <6.1.0`; TS 7 would leave linting unsupported. Revisit when typescript-eslint
  ships TS 7 support.
- **Vite `base` is `./`, not `/`.** A relative base serves correctly from the `github.io` project
  path, the apex domain, and a plain file server.
- **No `public/CNAME`.** Pages ignores it when publishing from Actions, so the custom domain goes in
  repo settings instead.
- **`PROMPT.md` and `mineral-flows-data/` are gitignored.** The brief is not mine to publish, and
  the raw staging directory is superseded by `etl/raw/manual/`.
- **Pages was enabled via the API** (`build_type: workflow`). Custom domain and DNS remain manual.

**From phase 1**

- **`minerals.json` carries both `hs_codes` and `trade_codes`**, with a schema refinement that fails
  if they disagree, so the redundancy cannot silently drift.
- **Flow volumes are on a contained-metal basis** — LCE for lithium, REO for rare earths. Phase 4
  had to convert USGS lithium production by 5.323 to match; see `etl/config/production_basis.json`.
- **Three low-confidence facilities**, not two: Kolwezi artisanal district, Ganzhou separation
  cluster, Kachin State REE district.
- **Rare earths have no mine-stage trade code or flow.** Deliberate. `filterFlows` matches on either
  arc endpoint so a refine-only mineral does not vanish.
- **A "no fabrication stage" gap.** The three-stage taxonomy has no slot for semi-fabrication, so
  copper semis and alloys sit under `refine` as inactive codes.

**From phases 2 and 3**

- **globe.gl's built-in graticule is replaced with our own**, dark enough to stay under the bloom
  threshold.
- **`world-atlas` and `topojson-client` added** for the landmass outline: 55 KB of public-domain
  Natural Earth data bundled at build time.
- **`chunkSizeWarningLimit` raised to 3000 kB.** three.js plus globe.gl is ~2.2 MB and all of it is
  needed on first paint.
- **Multi-mineral facilities take the colour of their lowest `sort_order` visible mineral.** The
  detail panel lists all of them.

**From phase 4**

- **Seed data is a fallback, not a layer.** Facilities and flows fall back at the whole-table level
  because a seed row and a real row can be the same mine with two ids; prices and centroids merge on
  their natural keys because no single price source covers all four minerals. Written up in
  `etl/sources/seed.py` and `etl/README.md`.
- **`etl/seed/flows.json` stores estimated flows with `value_usd: null`**, derived by the pipeline
  on every run, so the estimated-value path is live code rather than a frozen number. A test asserts
  no stored value ever appears there.
- **Country coordinates are World Bank capital cities, not polygon centroids.** Official, versioned,
  no-auth. Australia's arcs land on Canberra. Four places the list omits (TWN, GUF, MSR, VAT) are
  hand-added in `etl/config/extra_countries.json`.
- **`countries.json` is pruned to what the other files reference** — 17 rows on the seed path, 138
  on a full run, instead of 217.
- **The country resolver refuses to guess.** Unmatched names are counted, reported, and dropped, not
  fuzzy-matched.
- **Exports define flow direction in TiCM.** Import rows only fill pairs with no export row, and
  those flows are marked low confidence.
- **TiCM flows are capped at the top 500 per mineral by value**, per mineral so copper cannot crowd
  out rare earths.
- **NdPr oxide is the rare-earth price proxy.** The least comfortable call in the pipeline: there is
  no published mixed-REO basket price, and the alternative series is cheap cerium-lanthanum
  mischmetal. Reasoned in `etl/config/usgs_price_series.json`; every value derived from it is tagged
  estimated.
- **UN Comtrade is wired in but inert.** Its API needs a subscription key an unattended workflow
  cannot hold. It reports a skip on every run rather than pretending to be implemented.
- **The IEA and USGS production figures write to no output file.** The contract has no production
  table. They feed the cross-check that flags a flow larger than its origin's output.
- **The ICMM and IEA workbooks are CC BY 4.0 and committed.** The TiCM extracts' redistribution
  terms have not been checked — flagged in the README as a manual step before the repo goes public.
- **A multi-stage ICMM site becomes one facility per stage** at the same coordinates, because
  collapsing it would make the stage filter lie about what is there.
- **`contract.py` mirrors `schema.ts` by hand.** `refresh-data.yml` runs the app's own test suite
  over freshly written files, which is what catches the two drifting apart. It already caught one:
  zod's ISO datetime rejects `+00:00` and requires `Z`.

**From phase 5**

- **The globe is keyboard-operable.** A WebGL canvas is otherwise unreachable, which would leave the
  detail panel — the only place source, confidence and estimate warnings appear — openable by mouse
  alone. The keyboard cursor is separate state from the selection, so moving it does not pull focus
  into the panel.
- **`--mf-muted` raised from `#66738a` to `#707d95`.** The old value was 4.2:1 on the page ground,
  under AA for the 10–11px sizes it is mostly used at. The new one is 4.9:1.
- **Camera altitude is computed from the viewport aspect** rather than fixed at 2.4, because
  globe.gl's field of view is vertical and a tall phone viewport crops the sphere at any fixed
  altitude.
- **Below 768px the rail becomes a strip and the panel a sheet.** Both are variants of the same
  components, chosen by the shell; nothing is hidden on a small screen.
- **A `mineralflows-preview` entry was added to `.claude/launch.json`** so the production bundle can
  be checked in the browser without a shell server.

## Blockers

None.

## What is left, if you want more

Not in the brief, so not built:

- Ship the real ETL output (see the deliberate note above).
- Year, region and confidence filters. `FilterRail` and the `Filters` type were built with the seam
  for them.
- A production table in the contract, which would give the USGS and IEA extracts somewhere to land.
- Comtrade, if a key is ever available to a workflow.

## How to check the app locally

```bash
npm run dev
```

`npm run build && npm run preview` checks the production bundle.
