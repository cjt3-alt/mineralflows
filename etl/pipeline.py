"""MineralFlows ETL — runs every source, merges what they return, writes public/data/.

    python etl/pipeline.py                # everything available
    python etl/pipeline.py --offline      # no network; manual drops and seed only
    python etl/pipeline.py --no-manual    # ignore the manual drops
    python etl/pipeline.py --offline --no-manual   # the empty-runner case
    python etl/pipeline.py --dry-run      # validate and report, write nothing

The run always finishes with valid output files or a non-zero exit and an
explanation. A source that cannot be reached is a skip, printed with the reason;
a source that returns malformed data is a failure, printed with the record that
broke. Those two are not the same thing and the pipeline never confuses them.

What happens, in order:

1. Country centroids, first, because the name resolver every other source needs
   is built from them.
2. Every other source, each catching its own failure and reporting a skip.
3. Merge, under the precedence rules documented in `sources/seed.py`.
4. Derive estimated values: volume x price, tagged `source: "estimated"`.
5. Cross-check flow volumes against reported production, warning only.
6. Validate against the contract, then write.
"""

from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import contract
import countries as country_tools
from contract import OUTPUT_DIR, Dataset, DataValidationError, write_dataset
from sources import CENTROID_SOURCE, SOURCES
from sources import seed as seed_source
from sources.base import ExtractContext, SourceResult

MINERALS_CONFIG = contract.ETL_ROOT / "config" / "minerals.json"

#: Which source wins when two of them price the same mineral in the same year.
#: The Pink Sheet is the reference series for exchange-traded metals; the USGS
#: fills in everything the Pink Sheet does not carry; the seed is the last resort.
PRICE_PRECEDENCE = ["worldbank-pinksheet", "usgs-nmic", "seed"]

#: A flow whose volume exceeds this multiple of the origin country's entire
#: reported production for that mineral and stage is flagged. Not an error —
#: re-exports and stock draws are real — but a factor of three is the kind of gap
#: a unit conversion error produces, and it should never pass unnoticed.
PRODUCTION_CHECK_FACTOR = 3.0


class Reporter:
    """Run log. Everything the pipeline decides gets said out loud."""

    def __init__(self) -> None:
        self.warnings: list[str] = []

    def section(self, title: str) -> None:
        print(f"\n{title}\n" + "-" * len(title))

    def line(self, text: str) -> None:
        print(f"  {text}")

    def warn(self, text: str) -> None:
        self.warnings.append(text)
        print(f"  ! {text}")


def load_minerals() -> list[dict]:
    """`minerals.json` is configuration, not an extract.

    It is the file that decides which HS codes turn into flows and which
    minerals render, so it is hand-maintained here and copied through to the
    output unchanged. Adding a fifth mineral is an edit to this file.
    """
    import json

    minerals = json.loads(MINERALS_CONFIG.read_text(encoding="utf-8"))
    contract.validate_minerals(minerals)
    return minerals


# ------------------------------------------------------------------ extraction


def run_sources(ctx: ExtractContext, reporter: Reporter) -> list[SourceResult]:
    results: list[SourceResult] = []
    for module in SOURCES:
        results.append(run_one(module, ctx, reporter))
    return results


def run_one(module, ctx: ExtractContext, reporter: Reporter) -> SourceResult:
    label = f"{module.SOURCE_ID} [{module.KIND}]"
    try:
        result = module.extract(ctx)
    except Exception as exc:
        reporter.warn(f"{label} raised {type(exc).__name__}: {exc}")
        from sources.base import skipped

        return skipped(
            module.SOURCE_ID,
            getattr(module, "NAME", module.SOURCE_ID),
            getattr(module, "URL", None),
            "unknown",
            "The source raised before it produced anything.",
            f"{type(exc).__name__}: {exc}",
        )

    if result.available:
        reporter.line(f"{label}: {result.row_count} rows")
    else:
        reporter.line(f"{label}: skipped — {result.skip_reason}")
    for warning in result.warnings:
        reporter.warn(f"{module.SOURCE_ID}: {warning}")
    return result


# ---------------------------------------------------------------------- merges


def merge_countries(
    real: list[SourceResult], seed: SourceResult, reporter: Reporter
) -> tuple[dict[str, dict], bool]:
    """ISO3 by ISO3: a real centroid displaces the seed's, nothing is duplicated."""
    merged: dict[str, dict] = dict(seed.countries)
    seed_only = set(merged)

    for result in real:
        for iso3, country in result.countries.items():
            merged[iso3] = country
            seed_only.discard(iso3)

    # The four entries no country list covers, always applied last so a
    # deliberate hand-picked point is never silently overwritten.
    extras = country_tools.extra_countries()
    merged.update(extras)

    if seed_only:
        reporter.line(
            f"countries: {len(seed_only)} centroids still come from the seed "
            f"({', '.join(sorted(seed_only))})"
        )
    return merged, bool(seed_only)


def merge_prices(
    real: list[SourceResult], seed: SourceResult, reporter: Reporter
) -> tuple[list[dict], set[str]]:
    """Mineral and year: whichever source ranks highest in PRICE_PRECEDENCE wins."""
    by_key: dict[tuple[str, int], dict] = {}
    rank = {source_id: i for i, source_id in enumerate(PRICE_PRECEDENCE)}
    fallback_rank = len(rank)

    for result in [*real, seed]:
        for price in result.prices:
            key = (price["mineral_id"], price["year"])
            incumbent = by_key.get(key)
            if incumbent is None or rank.get(price["source"], fallback_rank) < rank.get(
                incumbent["source"], fallback_rank
            ):
                by_key[key] = price

    prices = sorted(by_key.values(), key=lambda p: (p["mineral_id"], p["year"]))
    used = {p["source"] for p in prices}
    for source_id in sorted(used):
        count = sum(1 for p in prices if p["source"] == source_id)
        reporter.line(f"prices: {count} from {source_id}")
    return prices, used


def merge_table(
    table: str, real: list[SourceResult], seed: SourceResult, reporter: Reporter
) -> tuple[list[dict], bool]:
    """Whole-table fallback for facilities and flows. See `sources/seed.py`."""
    rows: list[dict] = []
    contributors: list[str] = []
    for result in real:
        produced = getattr(result, table)
        if produced:
            rows.extend(produced)
            contributors.append(f"{result.source_id} ({len(produced)})")

    if rows:
        reporter.line(f"{table}: {len(rows)} rows from " + ", ".join(contributors))
        return rows, False

    seed_rows = list(getattr(seed, table))
    reporter.line(f"{table}: no source produced any, so {len(seed_rows)} seed rows are used")
    return seed_rows, True


def prune_countries(
    merged: dict[str, dict],
    facilities: list[dict],
    flows: list[dict],
    reporter: Reporter,
) -> dict[str, dict]:
    """Keep only the countries something actually references.

    `countries.json` exists to give arcs their endpoints and facilities their
    country label. A full world list would ship two hundred entries the browser
    never looks up, so the file is cut to what the other files point at. Anything
    referenced and missing is a validation failure, not a prune.
    """
    referenced = {f["properties"]["country_iso3"] for f in facilities}
    for flow in flows:
        referenced.add(flow["from_iso3"])
        referenced.add(flow["to_iso3"])

    kept = {iso3: merged[iso3] for iso3 in sorted(referenced) if iso3 in merged}
    dropped = len(merged) - len(kept)
    if dropped > 0:
        reporter.line(f"countries: {len(kept)} referenced, {dropped} unreferenced dropped")
    return kept


# ------------------------------------------------------------------- estimates


def derive_values(
    flows: list[dict], prices: list[dict], reporter: Reporter
) -> tuple[list[dict], int]:
    """volume x price, for flows that carry a volume and no traded value.

    This is the one number in the app that is not reported by anyone, so it is
    the one that has to be labelled everywhere it surfaces. The tag it writes,
    `source: "estimated"`, is what the interface keys its estimated badge on — a
    flow that reaches here with a real traded value keeps its own source and is
    never touched.
    """
    index = {(p["mineral_id"], p["year"]): p["avg_price_usd_per_tonne"] for p in prices}
    kept: list[dict] = []
    derived = 0
    unpriced = 0

    for flow in flows:
        if flow.get("value_usd") is None and flow.get("volume_tonnes") is not None:
            price = index.get((flow["mineral_id"], flow["year"]))
            if price is None:
                unpriced += 1
                # The contract allows a flow with a volume and no value; the app
                # resolves what it can and shows the rest as volume only.
                kept.append(flow)
                continue
            flow = {
                **flow,
                "value_usd": round(flow["volume_tonnes"] * price, 2),
                "source": "estimated",
            }
            derived += 1
        kept.append(flow)

    if derived:
        reporter.line(f"values: {derived} flows valued at volume x price, tagged estimated")
    if unpriced:
        reporter.warn(
            f"{unpriced} flows have a volume but no price for their mineral and year, so they "
            "carry no value; the interface shows them by volume alone"
        )
    return kept, derived


def check_against_production(
    flows: list[dict], production: dict[tuple[str, str, str], float], reporter: Reporter
) -> None:
    """Flag a flow that moves more than a country could plausibly have produced.

    Warning only. Re-exports, stock draws and transhipment through entrepots are
    all real, so a large ratio is not proof of an error. It is, though, exactly
    what a units mistake looks like, and this is the cheapest place to catch one.
    """
    if not production:
        reporter.line("cross-check: no production figures available, so nothing was checked")
        return

    flagged = 0
    for flow in flows:
        volume = flow.get("volume_tonnes")
        if volume is None:
            continue
        produced = production.get((flow["mineral_id"], flow["from_iso3"], flow["stage_from"]))
        if produced and volume > produced * PRODUCTION_CHECK_FACTOR:
            flagged += 1
            reporter.warn(
                f"{flow['id']} moves {volume:,.0f} t but {flow['from_iso3']} is reported to "
                f"produce {produced:,.0f} t of {flow['mineral_id']} at the {flow['stage_from']} "
                "stage"
            )
    if not flagged:
        reporter.line(
            f"cross-check: no flow exceeds {PRODUCTION_CHECK_FACTOR:g}x its origin's "
            f"reported production ({len(production)} figures)"
        )


# ------------------------------------------------------------------------ meta


def build_meta(
    contributors: list[SourceResult],
    seed: SourceResult,
    seed_tables: list[str],
) -> dict:
    sources = [result.as_source_ref() for result in contributors]
    parts = seed_source.parts()
    for table in seed_tables:
        vintage, coverage = parts[table]
        sources.append(
            {
                "id": f"seed-{table}",
                "name": f"{seed.name}: {table}",
                "url": None,
                "vintage": vintage,
                "retrieved_at": seed.retrieved_at.isoformat(),
                "coverage": coverage,
            }
        )
    sources.sort(key=lambda s: s["id"])
    return {
        # A "Z" suffix, not "+00:00": the browser-side schema uses zod's ISO
        # datetime, which accepts the former and rejects the latter.
        "generated_at": datetime.now(UTC).replace(microsecond=0, tzinfo=None).isoformat() + "Z",
        "schema_version": contract.SCHEMA_VERSION,
        "sources": sources,
    }


# ------------------------------------------------------------------------- run


def build(ctx: ExtractContext, reporter: Reporter) -> Dataset:
    minerals = load_minerals()
    ctx.minerals = minerals

    reporter.section("Sources")
    centroids = run_one(CENTROID_SOURCE, ctx, reporter)

    # The resolver can only resolve a name to a country it has a centroid for,
    # so it is built from the merged set rather than from the API alone.
    seed = seed_source.extract(ctx)
    provisional = {**seed.countries, **centroids.countries, **country_tools.extra_countries()}
    ctx.resolver = country_tools.build_resolver(provisional)

    results = run_sources(ctx, reporter)
    real = [r for r in [centroids, *results] if r.available]

    reporter.section("Merge")
    merged_countries, used_seed_countries = merge_countries(real, seed, reporter)
    prices, price_sources = merge_prices(real, seed, reporter)
    facilities, used_seed_facilities = merge_table("facilities", real, seed, reporter)
    flows, used_seed_flows = merge_table("flows", real, seed, reporter)

    reporter.section("Derived values")
    flows, _ = derive_values(flows, prices, reporter)

    production: dict[tuple[str, str, str], float] = {}
    for result in real:
        for key, tonnes in result.production.items():
            production[key] = max(production.get(key, 0.0), tonnes)
    check_against_production(flows, production, reporter)

    merged_countries = prune_countries(merged_countries, facilities, flows, reporter)

    reporter.section("Country names")
    reporter.line(ctx.resolver.report())

    seed_tables = [
        table
        for table, used in (
            ("facilities", used_seed_facilities),
            ("flows", used_seed_flows),
            ("prices", "seed" in price_sources),
            ("countries", used_seed_countries),
        )
        if used
    ]
    # Only sources whose rows actually reached the output are credited in
    # meta.json. A source that ran but was outranked everywhere is not a source
    # of anything the interface is showing.
    contributors = [
        r
        for r in real
        if r.row_count > 0
        and (r.source_id in price_sources or r.facilities or r.flows or r.countries)
    ]

    return Dataset(
        minerals=minerals,
        facilities=facilities,
        flows=flows,
        prices=prices,
        countries=merged_countries,
        meta=build_meta(contributors, seed, seed_tables),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--offline", action="store_true", help="skip every network fetch")
    parser.add_argument(
        "--no-manual",
        dest="no_manual",
        action="store_true",
        help="ignore etl/raw/manual, to exercise the seed fallback",
    )
    parser.add_argument("--dry-run", action="store_true", help="validate and report, write nothing")
    parser.add_argument("--year", type=int, default=2024, help="trade year to extract")
    parser.add_argument(
        "--output", type=Path, default=OUTPUT_DIR, help="where to write the data files"
    )
    args = parser.parse_args(argv)

    reporter = Reporter()
    ctx = ExtractContext(
        minerals=[],
        resolver=country_tools.CountryResolver(),
        offline=args.offline,
        ignore_manual=args.no_manual,
        year=args.year,
    )

    try:
        dataset = build(ctx, reporter)
    except DataValidationError as exc:
        print(f"\nFAILED\n{exc}", file=sys.stderr)
        return 1

    reporter.section("Output")
    try:
        if args.dry_run:
            dataset.validate()
            reporter.line("dry run: the dataset is valid and nothing was written")
        else:
            for name, size in write_dataset(dataset, args.output).items():
                reporter.line(f"{name}: {size / 1024:,.1f} kB")
    except DataValidationError as exc:
        print(f"\nFAILED\n{exc}", file=sys.stderr)
        return 1

    print(
        f"\nDone. {len(dataset.facilities)} facilities, {len(dataset.flows)} flows, "
        f"{len(dataset.prices)} prices, {len(dataset.countries)} countries, "
        f"{len(reporter.warnings)} warnings."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
