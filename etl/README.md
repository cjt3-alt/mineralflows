# ETL

Reads six public sources, normalises them to the data contract in
[`src/data/schema.ts`](../src/data/schema.ts), and writes `public/data/`. No database, no service:
it runs on a laptop or in a GitHub Action and its whole output is six flat files the browser reads
directly.

```bash
pip install -r etl/requirements.txt

python etl/pipeline.py                        # everything reachable
python etl/pipeline.py --offline              # no network
python etl/pipeline.py --no-manual            # ignore the manual drops
python etl/pipeline.py --offline --no-manual  # what a bare runner sees
python etl/pipeline.py --dry-run              # validate and report, write nothing
python etl/test_pipeline.py                   # the tests
python -m ruff check etl/ && python -m ruff format --check etl/
```

The run always ends in one of two ways: valid files written, or a non-zero exit naming the record
that broke. A source that cannot be reached is a **skip**, printed with the reason. A source that
returns malformed data is a **failure**, printed with the offending record. Those are different
things and the pipeline never confuses them.

## What each source contributes

| Source | Kind | Writes | Notes |
| --- | --- | --- | --- |
| World Bank country API | auto | `countries.json` | Capital-city coordinates as arc endpoints. Also supplies the names the country resolver matches on. |
| World Bank Pink Sheet | auto | `prices.json` | Copper only. There is no lithium, cobalt or rare-earth series in it. |
| USGS Mineral Commodity Summaries | auto | `prices.json` | Prices for everything the Pink Sheet misses, plus country production for the cross-check. |
| ICMM Global Mining Dataset | manual | `facilities.geojson` | Geocoded sites with ICMM's own confidence rating. |
| ADB-WTO TiCM | manual | `flows.json` | Bilateral trade by HS code, 2024. |
| IEA Critical Minerals Data Explorer | manual | nothing | Mine-versus-refine supply by country, used only for the cross-check. |
| UN Comtrade | manual | nothing | Deliberately inert. Needs a subscription key the unattended refresh cannot hold. |

`minerals.json` is not extracted from anything. It is configuration, hand-maintained at
[`config/minerals.json`](config/minerals.json), and it is what decides which HS codes become flows
and which minerals render. **Adding a fifth mineral is an edit to that file**, not to any module
here.

Two sources produce country-level production that has nowhere to go: the contract has no production
table and adding one is out of scope. It is read anyway, because the pipeline uses it to flag a
trade flow larger than the origin country could have produced — the check most likely to catch a
unit error.

## Seed data is a fallback, not a layer

`etl/seed/` holds the hand-authored dataset from phase 1. When a real source produces facilities or
flows, **the seed rows for that file are dropped whole.** They are not added to it.

That asymmetry is deliberate, and the reason is different per file:

- **Facilities and flows fall back at the whole-table level.** The seed's Escondida and ICMM's
  Escondida are one mine with two ids; a seed copper flow and a TiCM copper flow are one trade with
  two ids. There is no key that would let the pipeline merge them, so mixing the two double-counts.
- **Prices and centroids merge key by key.** A price is identified by mineral and year, a centroid
  by ISO3, so a real row displaces exactly the row it replaces and nothing can be counted twice.
  This matters because no single price source covers all four minerals: dropping the whole file the
  moment copper arrives from the Pink Sheet would leave lithium, cobalt and rare earths unpriced.

One consequence worth knowing: the seed stores its estimated flows with `value_usd: null`. The value
is derived from volume × price on every run, so the estimated-value path is live code rather than a
number frozen into a file.

## Manual drops

Manual sources live under `raw/manual/<source-id>/` and are committed, because no machine can fetch
them. A missing file is the normal case: the pipeline prints a skip naming the exact path it looked
in, and carries on.

`raw/auto/` is gitignored. Anything in it is a cache and safe to delete.

### ICMM Global Mining Dataset — `raw/manual/icmm/`

Expected filename: `global-mining-dataset-*.xlsx`

Download from <https://www.icmm.com/en-gb/research/social-performance/2025/global-mining-dataset>.
Licensed CC BY 4.0. Refresh when ICMM publishes a new version — roughly annually; v1.5 is July 2026.

### ADB-WTO TiCM — `raw/manual/adb-wto-ticm/`

Expected filenames: `ticm-*.csv`

Query <https://critmin.org> and export CSV per commodity per year. The committed extracts are the
2024 headline codes for copper (260300 and 740100), cobalt (260500), lithium (253090) and rare
earths (284610). Refresh when a new trade year is published, roughly annually.

Four things about these files that the code depends on, all confirmed by reading them:

1. **Values are raw US dollars, not thousands.**
2. **A file holds far more HS codes than its filename says.** The 740100 extract carries 42 codes.
   Every file is read whole and filtered on the codes `config/minerals.json` marks active.
3. **The same code appears in several files.** Rows are deduplicated on
   `reporter+partner+flow+hs_code+year` or rare earths are counted three times.
4. **Aggregate partners sit alongside real ones.** `World` and `European Union` rows are dropped
   before anything is summed.

A fifth thing is a choice rather than a fact: each pair appears twice, once as the exporter's
`Export` row and once as the importer's `Import` row, and the two disagree. **Exports define
direction.** Import rows are used only to fill pairs with no export row at all, and those flows are
marked low confidence.

There is also a cap: the top 500 flows per mineral by value. TiCM 2024 aggregates to about ten
thousand country pairs, and this is a static site that fetches the whole file before it can draw
anything. The cap is per mineral so copper cannot crowd rare earths out of the file.

**On redistributing these extracts.** ADB-WTO permit non-commercial reuse with attribution, and
require the source to be credited wherever the data is reproduced — including in a visualisation,
which is why `meta.json` carries the full source name and the legend bar surfaces it. Commercial
redistribution needs clearance from ADB and the WTO.

The wrinkle is third-party data. TiCM integrates UN Comtrade, ITC and TDM, and its terms require
extracts of that data to keep to those providers' own limits; Comtrade restricts bulk
redistribution. The derived `flows.json` is comfortably clear of that — it is aggregated across HS
codes, capped, and credited. The 24 MB of raw bilateral rows committed here is the part that is not.

**These files stay for now, deliberately.** The app runs on seed data, the project is not being shown
to anyone, and keeping them is what lets the monthly refresh produce real flows unattended. The
README's "Before this runs on real data" section has the trigger for revisiting that and the order to
do it in. Short version: ship the derived data first, then `git rm -r --cached` this directory and
gitignore it. The pipeline already handles the source being absent, so nothing breaks — trade
refreshes just become a manual re-download.

The ICMM and IEA workbooks are CC BY 4.0 and carry no such restriction.

### IEA Critical Minerals Data Explorer — `raw/manual/iea-critical-minerals/`

Expected filename: `*Critical Minerals*.xlsx`

Download from
<https://www.iea.org/data-and-statistics/data-tools/critical-minerals-data-explorer>. Licensed
CC BY 4.0. Refresh annually with the Global Critical Minerals Outlook.

Only the `2 Total supply for key minerals` sheet is read. It publishes projection years starting at
2025 rather than historical years, so the nearest published year is used for the cross-check and the
substitution is named in the run log.

### UN Comtrade

Not implemented, on purpose. See [`sources/comtrade.py`](sources/comtrade.py) for what turning it on
would take.

## Configuration

Everything that is a judgement rather than a fact lives in `config/`, so it can be changed without
touching a module:

| File | What it decides |
| --- | --- |
| `minerals.json` | Which minerals exist, which HS codes are active, and what stage each code represents. |
| `country_aliases.json` | Source spellings that a punctuation-insensitive match cannot resolve, and the aggregate labels to drop. Every alias came from a real value in a real file. |
| `extra_countries.json` | The four places no country list covers but the sources reference. |
| `commodity_aliases.json` | How each source spells our minerals in prose — ICMM says "lanthanides", the IEA says "Magnet rare earth elements". |
| `usgs_price_series.json` | Which of the several USGS price series to use per mineral, and why. |
| `production_basis.json` | Conversions between a source's reported basis and the one flow volumes use. Lithium is a factor of 5.3. |

The country resolver **refuses to guess**. A name it cannot match is counted, reported, and its rows
dropped — never fuzzy-matched into the nearest neighbour, because a flow attributed to the wrong
country is worse than a missing one.

## The refresh workflow

[`.github/workflows/refresh-data.yml`](../.github/workflows/refresh-data.yml) runs monthly and on
demand. It lints, tests, runs the pipeline, then runs the app's own test suite over the freshly
written files — `contract.py` mirrors `schema.ts`, and that step is what catches the two drifting
apart. If `public/data/` changed, it opens a pull request rather than pushing to `main`, because a
silent auto-commit of a bad extract is the failure worth designing against.

The manual drops are used as they stand. They do not refresh themselves; that is what the sections
above are for.

## Adding a source

1. Write `sources/<id>.py` exporting `SOURCE_ID`, `KIND`, and `extract(ctx) -> SourceResult`.
2. Return rows in contract shape. Never raise for a missing input — return `skipped(...)` with the
   reason a human would need.
3. Add it to `SOURCES` in [`sources/__init__.py`](sources/__init__.py).
4. If it prices something, give it a rank in `PRICE_PRECEDENCE` in
   [`pipeline.py`](pipeline.py).
