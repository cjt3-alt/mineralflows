# Progress

Working log for the MineralFlows scaffold build. Updated at the end of every phase.

**Last updated:** 2026-08-31, end of phase 3.

## Phases

| Phase | Scope                                                    | Status         |
| ----- | -------------------------------------------------------- | -------------- |
| 0     | Repo, tooling, CI, deploy target                          | ✅ complete    |
| 1     | Data contract: types, schema validation, seed data, loader | ✅ complete    |
| 2     | Globe canvas: points, arcs, bloom, interaction             | ✅ complete    |
| 3     | Dashboard shell: top bar, filter rail, detail panel, legend | ✅ complete    |
| 4     | ETL skeleton and refresh workflow                          | ⬜ not started |
| 5     | Polish: responsive, keyboard, reduced motion, states, README | ⬜ not started |

## Where things stand

Repo is live at <https://github.com/cjt3-alt/mineralflows>, deployed to
<https://cjt3-alt.github.io/mineralflows/>. CI runs typecheck, lint, test, build, deploy on every
push to `main` and is green.

The data contract is written and the seed dataset validates against it: 4 minerals, 30 facilities,
28 flows, 8 prices, 26 countries. The app runs: globe with glowing arcs and points, mineral and
stage filters, a working detail panel, a legend, and shareable URLs. 62 tests pass; typecheck,
lint and build are clean.

### Next step

Phase 4: the ETL skeleton. Create `etl/pipeline.py` plus one module per source under
`etl/sources/`, and `.github/workflows/refresh-data.yml`. Copy (do not move) the files from
`./mineral-flows-data` into `etl/raw/manual/<source>/`. The pipeline must run end to end with every
manual source missing and still write valid files.

## Assumptions and deferred items

Decisions made without asking, listed so they can be reversed cheaply.

**From phase 0**

- **TypeScript pinned to `~6.0.3`, not the latest 7.0.2.** `typescript-eslint@8.68.0` declares
  `typescript >=4.8.4 <6.1.0`; TS 7 would leave linting unsupported. Revisit when typescript-eslint
  ships TS 7 support.
- **Vite `base` is `./`, not `/`.** A relative base serves correctly from the `github.io` project
  path, the apex domain, and a plain file server. An absolute `/` would 404 every asset at the
  `github.io` URL, which is where the site lives until DNS is cut over.
- **No `public/CNAME`.** Per instruction: Pages ignores it when publishing from Actions, so the
  custom domain goes in repo settings instead.
- **`PROMPT.md` and `mineral-flows-data/` are gitignored.** The brief is not mine to publish to a
  public repo, and the 36 MB of raw sources stay unversioned until phase 4 copies what it needs
  into `etl/raw/manual/`. One-line reversal in `.gitignore` if either call is wrong.
- **Pages was enabled via the API** (`build_type: workflow`) after you approved it. The custom
  domain and DNS remain manual; records are in the README.
- **`refresh-data.yml` deferred to phase 4.** It cannot do anything without `etl/pipeline.py`, so
  committing it now would mean a workflow that fails if dispatched.

**From phase 1**

- **`minerals.json` carries both `hs_codes` and `trade_codes`.** The contract specified
  `hs_codes: string[]`; your note required an explicit HS-code-to-stage map with inactive codes
  retained. `trade_codes` is the authoritative structure, `hs_codes` is the flat list of active
  codes. A schema refinement fails validation if the two ever disagree, so the redundancy cannot
  silently drift.
- **Flow volumes are on a contained-metal basis** — LCE for lithium, REO for rare earths — so that
  `volume x price` produces a sane number. Spodumene concentrate tonnage against a carbonate price
  would overstate lithium by roughly 8x. The ETL must normalise the same way in phase 4.
- **Seed flows are tagged `source: "seed"`, except estimated ones which are tagged
  `source: "estimated"`.** The brief asked for both; `estimated` wins where they collide because
  that is the label the UI must never lose.
- **Three low-confidence facilities**, not two: Kolwezi artisanal district, Ganzhou separation
  cluster, Kachin State REE district. All three are genuinely poorly documented in public sources,
  which is the point.
- **Rare earths have no mine-stage trade code or flow.** Deliberate, per your note. A test asserts
  it, and `filterFlows` matches on *either* arc endpoint so a refine-only mineral does not vanish.
- **Facility `source_url` points at USGS NMIC commodity pages** (verified 200, they block plain
  curl but serve a browser UA). Low-confidence facilities have `source_url: null`. No URL was
  invented.
- **Country centroids are hand-picked representative land points**, not computed polygon centroids.
  Malaysia uses a peninsular point rather than its true centroid, which falls in the sea. Recorded
  as source `seed-centroids` in `meta.json`; phase 4 swaps in a public dataset.
- **A "no fabrication stage" gap.** The three-stage taxonomy (mine/process/refine) has no slot for
  semi-fabrication, so copper semis and alloys sit under `refine` as inactive codes.
- **ICMM and IEA source URLs are not yet recorded.** Both block automated fetches, so rather than
  guess a URL I left them out of `meta.json` until phase 4, where the ETL needs them anyway.

**From phases 2 and 3**

- **globe.gl's built-in graticule is replaced with our own.** The library draws it light grey, which
  clears any useful bloom threshold and makes the grid the brightest thing on screen. Ours is dark
  enough to stay under it.
- **`world-atlas` and `topojson-client` added as dependencies.** A landmass outline needs land
  geometry, and no runtime API calls are allowed. `land-110m.json` is 55 KB of public-domain Natural
  Earth data, bundled at build time.
- **`jsdom` and Testing Library added** so the detail panel's honesty rules are covered by tests
  rather than by a manual click.
- **`chunkSizeWarningLimit` raised to 3000 kB.** three.js plus globe.gl is ~2.2 MB and all of it is
  needed on first paint, so the default would warn on every build forever.
- **Multi-mineral facilities take the colour of their lowest `sort_order` visible mineral.** The
  detail panel lists all of them, so nothing is hidden by the choice; only the dot has to pick one.
- **Design tokens landed in phase 2, not 3**, because the globe was the first thing that needed real
  colours.

### Verification note

The globe cannot be screenshotted from the automated browser pane while the pane is not being
composited: `document.visibilityState` reports "visible" but zero animation frames fire, so
three.js's render loop never runs and the canvas stays black while the DOM chrome paints normally.
This is an artifact of the tooling, not the app. The globe was confirmed rendering in screenshots
taken while the pane was displayed, including the full phase 3 shell. **Worth one manual look in a
real browser** (`npm run dev`) to confirm nothing regressed since.

Click-to-open-detail-panel was verified as far as the environment allows: globe.gl hit-testing was
confirmed working (an arc tooltip resolved to "MDG → JPN"), and the panel itself is covered by
tests. The click-through path from a point to an open panel has not been exercised end to end in a
real browser.

## Blockers

None.

## Resume instruction

Paste this into a fresh session started in the repo root:

> Read PROGRESS.md and PROMPT.md, then continue the MineralFlows build from the next incomplete
> phase. Work through the remaining phases in order without stopping for confirmation between them;
> only stop if you hit a genuine blocker. Commit incrementally with clear messages tied to the
> phase, and update PROGRESS.md as each phase completes. Note that `PROMPT.md` and
> `mineral-flows-data/` are gitignored but present on disk.
