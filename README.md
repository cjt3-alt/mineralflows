# MineralFlows

A static, client-only web app that visualises critical mineral supply chains on an interactive 3D
globe: where copper, lithium, cobalt, and rare earths are mined, processed, and refined, and how
they move between countries. Flow lines are sized by market value, and every value derived from
volume × price is labelled as an estimate wherever it appears.

Live at <https://cjt3-alt.github.io/mineralflows/>.

There is no backend. The browser reads six flat files from the same origin and nothing else. No
database, no server rendering, no runtime API calls.

## What is here

- **The app** — a dashboard with the globe as its centre: mineral chips across the top, a stage
  filter down the left, a detail panel on the right, and a legend that maps arc width to dollars
  and reports a vintage per source. Filters round-trip through the query string, so a view is a
  link.
- **The data contract** — [`src/data/schema.ts`](src/data/schema.ts) is the single source of truth
  for the six files in `public/data/`. Everything validates against it on load and fails loudly,
  naming the record that broke.
- **The ETL** — [`etl/`](etl/) reads six public sources, normalises them to that contract, and
  writes `public/data/`. See [`etl/README.md`](etl/README.md).

## The data in the app right now is the seed dataset

Thirty real facilities, twenty-eight flows, and eight indicative prices, hand-authored to prove the
contract before real extracts landed. Real places — Escondida, Kamoa-Kakula, Greenbushes, Bayan Obo,
Salar de Atacama — with approximate coordinates. It deliberately includes three low-confidence
facilities and fourteen estimated-value flows, so those code paths are exercised from the first
render rather than the first refresh.

The ETL is wired to real sources and runs end to end, but `public/data/` is **not** the output of a
full run. Replacing thirty checkable facilities with thirteen hundred, and twenty-eight flows with
two thousand, is a change worth reading a diff for — so it arrives through the pull request that
`refresh-data.yml` opens, not through a commit nobody looked at. What is committed is exactly what
`python etl/pipeline.py --offline --no-manual` produces, and CI checks that on every push.

## Development

```bash
npm install
npm run dev        # vite dev server
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm test           # vitest
npm run build      # static bundle into dist/
npm run preview    # serve dist/ locally
```

The ETL has its own toolchain and its own tests:

```bash
pip install -r etl/requirements.txt
python etl/pipeline.py --offline --no-manual
python etl/test_pipeline.py
python -m ruff check etl/ && python -m ruff format --check etl/
```

## How to read the globe

- **Points are facilities**, coloured by mineral and sized by stage: mines smallest, refineries
  largest, because refining is where the concentration this app is about actually sits. A facility
  that handles more than one mineral takes the colour of its lowest `sort_order` visible mineral;
  the detail panel lists all of them.
- **Arcs are flows**, width on a square-root scale. Linear width would make copper a solid band and
  everything else a hairline. Altitude rises with distance so a Chile-to-China arc clears the globe
  rather than cutting through it.
- **Low confidence is visible without reading anything.** Low-confidence facilities are drawn faint
  and flush against the sphere while verified ones stand proud of it; low-confidence flows are
  dashed. The difference survives greyscale and colourblindness, and it never disappears under
  reduced motion.
- **Estimated values never look like traded ones.** A value derived from volume × price carries a
  badge, a plain-language warning, and the arithmetic that produced it.

At most 300 arcs are drawn. Past that the frame rate collapses, so the set is capped by value and
the legend says how many of how many are showing rather than quietly dropping the rest.

## Keyboard and accessibility

- **The globe is reachable by keyboard.** A WebGL canvas normally is not, which would leave the
  detail panel — the only place a source, a confidence rating, or an estimate warning appears —
  openable by mouse alone. Tab to the globe, then arrow keys walk the visible flows and sites,
  Enter opens the one under the cursor, Escape clears it. The camera follows, and each move is
  announced to a screen reader.
- The detail panel takes focus when it opens, closes on Escape, and hands focus back.
- Focus is always visible and always the same shape.
- `prefers-reduced-motion` turns off bloom, arc animation, and the load camera move.
- Below 768px the rail becomes a strip under the top bar and the panel becomes a sheet over the
  globe. Nothing is hidden on a small screen. Bloom is switched off there too, on cost grounds.
- The globe camera works out how far back it has to sit for the sphere to fit the narrower axis, so
  a tall phone viewport does not crop it.

## Installed versions

Resolved against the npm registry and PyPI on 2026-08-31, not pinned from memory.

| Package             | Version  |
| ------------------- | -------- |
| vite                | 8.2.2    |
| react / react-dom   | 19.2.8   |
| typescript          | 6.0.3    |
| react-globe.gl      | 2.38.0   |
| three               | 0.185.1  |
| tailwindcss         | 4.3.3    |
| zod                 | 4.5.4    |
| vitest              | 4.1.11   |
| eslint              | 10.9.1   |
| typescript-eslint   | 8.68.0   |
| pandas              | 3.0.5    |
| requests            | 2.34.2   |
| openpyxl            | 3.1.5    |
| ruff                | 0.16.5   |

### Deliberate deviations from the brief

**TypeScript is 6.0.3, not the latest 7.0.2.** `typescript-eslint@8.68.0` declares a peer range of
`typescript >=4.8.4 <6.1.0`. Installing TypeScript 7 would leave linting unsupported. 6.0.3 is the
newest release inside that range, pinned as `~6.0.3` so a 6.1 release cannot drift out of it.
Revisit when typescript-eslint ships TS 7 support.

**Vite `base` is `./`, not `/`.** A relative base makes one build work in all three places this is
served from: the project page at `cjt3-alt.github.io/mineralflows/` (live now, before DNS is cut
over), the apex domain once it is, and a plain static file server. An absolute `/` base would 404
every asset at the `github.io` URL. There is no client-side router, so a relative base costs
nothing.

**`world-atlas` and `topojson-client` are dependencies.** A landmass outline needs land geometry and
runtime API calls are not allowed, so 55 KB of public-domain Natural Earth data is bundled at build
time.

**Country coordinates are capital cities, not polygon centroids.** They come from the World Bank
country API, which is an official, versioned, no-auth list. It means Australia's arcs land on
Canberra rather than in the middle of the continent. Recorded here, in `meta.json`, and in
[`etl/sources/worldbank_countries.py`](etl/sources/worldbank_countries.py), because a coordinate
that looks like a centroid and is not should not be quiet.

## Deployment

Pushes to `main` run [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml): typecheck,
lint, test, build, and publish `dist/` to GitHub Pages via the official Pages actions. A parallel
job lints and tests the ETL and checks that an offline run reproduces the committed data files
exactly.

[`refresh-data.yml`](.github/workflows/refresh-data.yml) runs on the 3rd of each month and on
demand. It runs the pipeline, validates the output with the app's own test suite, and opens a pull
request if `public/data/` changed. Never a push to `main` — a silent auto-commit of a bad extract is
the failure worth designing against.

### Manual steps

These cannot be done from code and are yours to do in the browser.

1. **Repo settings → Pages → Build and deployment → Source: GitHub Actions.** Without this the
   workflow's deploy job fails. Once, and it is already done.
2. **Repo settings → Pages → Custom domain: `mineralflows.com`**, then tick **Enforce HTTPS** once
   the certificate is issued (up to an hour after DNS resolves).
3. **Add the DNS records below** at your registrar, before step 2.
4. **Decide whether the raw TiCM extracts stay in the repo.** ADB-WTO permit non-commercial
   redistribution with attribution, which this project is and does. But TiCM aggregates UN Comtrade
   data, and its terms require third-party data to keep to that provider's own limits — Comtrade
   restricts bulk redistribution, and 24 MB of un-aggregated bilateral rows in a public repo is
   arguably that. The derived `flows.json` is not affected: it is aggregated, capped, and credited.
   If you want the raw files out, delete `etl/raw/manual/adb-wto-ticm/` and gitignore it; the
   pipeline already handles that source being absent, and it takes ~24 MB off every clone.

There is deliberately no `public/CNAME`. When Pages publishes from Actions rather than from a
branch it ignores `CNAME` in the artifact — the custom domain lives in repo settings, which is what
step 2 sets.

### DNS records for `mineralflows.com`

Apex A records, from GitHub's Pages documentation:

| Type | Name | Value             |
| ---- | ---- | ----------------- |
| A    | `@`  | `185.199.108.153` |
| A    | `@`  | `185.199.109.153` |
| A    | `@`  | `185.199.110.153` |
| A    | `@`  | `185.199.111.153` |

Apex AAAA records, if your registrar supports IPv6:

| Type | Name | Value                  |
| ---- | ---- | ---------------------- |
| AAAA | `@`  | `2606:50c0:8000::153`  |
| AAAA | `@`  | `2606:50c0:8001::153`  |
| AAAA | `@`  | `2606:50c0:8002::153`  |
| AAAA | `@`  | `2606:50c0:8003::153`  |

And a CNAME so `www` redirects to the apex:

| Type  | Name  | Value                |
| ----- | ----- | -------------------- |
| CNAME | `www` | `cjt3-alt.github.io` |

The CNAME target has no repository name in it. Verify the A record IPs against
<https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site>
before relying on them; GitHub has changed them before.

## Adding a fifth mineral

Add a row to [`etl/config/minerals.json`](etl/config/minerals.json) with its HS codes and the stage
each code represents, add its source spellings to
[`etl/config/commodity_aliases.json`](etl/config/commodity_aliases.json), give it a price series in
[`etl/config/usgs_price_series.json`](etl/config/usgs_price_series.json), and run the pipeline. No
component branches on a mineral id, and no source module knows what copper is.

## Data sources

| Source | Licence | Used for |
| --- | --- | --- |
| [World Bank country API](https://datahelpdesk.worldbank.org/knowledgebase/articles/898590-country-api-queries) | CC BY 4.0 | Country coordinates and canonical names |
| [World Bank Pink Sheet](https://www.worldbank.org/en/research/commodity-markets) | CC BY 4.0 | Copper prices |
| [USGS Mineral Commodity Summaries](https://www.usgs.gov/centers/national-minerals-information-center) | Public domain | Prices and country production |
| [ICMM Global Mining Dataset](https://www.icmm.com/en-gb/research/social-performance/2025/global-mining-dataset) | CC BY 4.0 | Facilities |
| [ADB-WTO TiCM](https://critmin.org) | Non-commercial reuse with attribution | Bilateral trade flows |
| [IEA Critical Minerals Data Explorer](https://www.iea.org/data-and-statistics/data-tools/critical-minerals-data-explorer) | CC BY 4.0 | Mine-versus-refine supply |
| [Natural Earth via world-atlas](https://github.com/topojson/world-atlas) | Public domain | Landmass outlines |

## Licence

MIT, for the code. The data files carry the licences of their sources, listed above and recorded per
source in `meta.json`, which is what the legend bar reads.

Trade flows are derived from the **ADB-WTO Trade in Critical Minerals Database**
(<https://critmin.org>), reused here for non-commercial public research. Facility records are from
the **ICMM Global Mining Dataset** (CC BY 4.0) and production figures from the **IEA Critical
Minerals Data Explorer** (CC BY 4.0). Reusing anything from this repository commercially means
clearing it with those publishers first, not with me.
