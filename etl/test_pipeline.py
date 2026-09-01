"""Tests for the parts of the ETL where being wrong would be quiet.

Run with `python etl/test_pipeline.py`. There is no pytest dependency: the ETL
already needs pandas, requests and openpyxl, and adding a test runner to a
six-file pipeline is not worth the install.

Nothing here touches the network or the manual drops. The cases worth covering
are the ones where a mistake produces plausible-looking output rather than an
error: the seed fallback rules, the estimated-value tag, and the unit
conversions that would silently move a decimal point.
"""

from __future__ import annotations

import json
import sys
import tempfile
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import contract
import countries as country_tools
import pipeline
from sources import seed as seed_source
from sources.base import ExtractContext, SourceResult

FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok   {name}")
    else:
        FAILURES.append(f"{name}{': ' + detail if detail else ''}")
        print(f"  FAIL {name}{': ' + detail if detail else ''}")


def silent() -> pipeline.Reporter:
    reporter = pipeline.Reporter()
    reporter.line = lambda text: None  # type: ignore[method-assign]
    reporter.warn = lambda text: reporter.warnings.append(text)  # type: ignore[method-assign]
    return reporter


def a_result(source_id: str, **kwargs) -> SourceResult:
    return SourceResult(
        source_id=source_id,
        name=source_id,
        url=None,
        vintage="2024",
        retrieved_at=date(2026, 1, 1),
        coverage="test",
        **kwargs,
    )


def context() -> ExtractContext:
    minerals = pipeline.load_minerals()
    seed = json.loads((seed_source.SEED_DIR / "countries.json").read_text(encoding="utf-8"))
    resolver = country_tools.build_resolver({**seed, **country_tools.extra_countries()})
    return ExtractContext(minerals=minerals, resolver=resolver, offline=True, ignore_manual=True)


# ------------------------------------------------------------------ the merges


def test_seed_is_a_fallback_not_a_layer() -> None:
    ctx = context()
    seed = seed_source.extract(ctx)
    real = a_result("icmm", facilities=[seed.facilities[0]])

    rows, used_seed = pipeline.merge_table("facilities", [real], seed, silent())
    check("a real facility source replaces the seed entirely", len(rows) == 1 and not used_seed)

    rows, used_seed = pipeline.merge_table("facilities", [a_result("icmm")], seed, silent())
    check(
        "no real facilities means the seed is used whole",
        len(rows) == len(seed.facilities) and used_seed,
    )


def test_prices_merge_key_by_key() -> None:
    ctx = context()
    seed = seed_source.extract(ctx)
    pink = a_result(
        "worldbank-pinksheet",
        prices=[
            {
                "mineral_id": "copper",
                "year": 2024,
                "avg_price_usd_per_tonne": 9111.0,
                "source": "worldbank-pinksheet",
                "source_url": "https://example.org",
            }
        ],
    )
    prices, used = pipeline.merge_prices([pink], seed, silent())
    by_key = {(p["mineral_id"], p["year"]): p for p in prices}

    check(
        "a Pink Sheet price displaces the seed price for the same mineral and year",
        by_key[("copper", 2024)]["source"] == "worldbank-pinksheet",
    )
    check(
        "minerals the Pink Sheet does not cover keep their seed price",
        by_key[("lithium", 2024)]["source"] == "seed",
    )
    check("both sources are reported as used", used == {"seed", "worldbank-pinksheet"})
    check("no mineral-year is priced twice", len(by_key) == len(prices))


def test_price_precedence_is_the_documented_order() -> None:
    ctx = context()
    seed = seed_source.extract(ctx)
    rows = [
        {
            "mineral_id": "copper",
            "year": 2024,
            "avg_price_usd_per_tonne": value,
            "source": source_id,
            "source_url": "https://example.org",
        }
        for source_id, value in (("usgs-nmic", 1.0), ("worldbank-pinksheet", 2.0))
    ]
    # Deliberately offered lowest-precedence first, so order of arrival cannot win.
    prices, _ = pipeline.merge_prices(
        [
            a_result("usgs-nmic", prices=[rows[0]]),
            a_result("worldbank-pinksheet", prices=[rows[1]]),
        ],
        seed,
        silent(),
    )
    winner = next(p for p in prices if p["mineral_id"] == "copper" and p["year"] == 2024)
    check("the Pink Sheet outranks the USGS", winner["source"] == "worldbank-pinksheet")


# --------------------------------------------------------------- derived values


def test_estimated_values_are_derived_and_tagged() -> None:
    prices = [
        {
            "mineral_id": "copper",
            "year": 2024,
            "avg_price_usd_per_tonne": 9200.0,
            "source": "seed",
            "source_url": "https://example.org",
        }
    ]
    flows = [
        {
            "id": "a",
            "mineral_id": "copper",
            "year": 2024,
            "value_usd": None,
            "volume_tonnes": 100.0,
            "from_iso3": "CHL",
            "to_iso3": "CHN",
            "stage_from": "mine",
            "stage_to": "process",
            "source": "seed",
            "confidence": "high",
        },
        {
            "id": "b",
            "mineral_id": "copper",
            "year": 2024,
            "value_usd": 42.0,
            "volume_tonnes": None,
            "from_iso3": "PER",
            "to_iso3": "CHN",
            "stage_from": "mine",
            "stage_to": "process",
            "source": "adb-wto-ticm",
            "confidence": "high",
        },
    ]
    derived, count = pipeline.derive_values(flows, prices, silent())

    check("volume x price is computed", derived[0]["value_usd"] == 920000.0)
    check("a derived value is tagged estimated", derived[0]["source"] == "estimated")
    check("a traded value is left alone", derived[1]["value_usd"] == 42.0)
    check("a traded value keeps its own source", derived[1]["source"] == "adb-wto-ticm")
    check("only the derivable flow was derived", count == 1)


def test_a_flow_with_no_price_keeps_its_volume() -> None:
    flows = [
        {
            "id": "a",
            "mineral_id": "cobalt",
            "year": 1999,
            "value_usd": None,
            "volume_tonnes": 5.0,
            "from_iso3": "COD",
            "to_iso3": "CHN",
            "stage_from": "mine",
            "stage_to": "process",
            "source": "seed",
            "confidence": "high",
        }
    ]
    reporter = silent()
    derived, count = pipeline.derive_values(flows, [], reporter)
    check("an unpriced flow is kept, not dropped", len(derived) == 1 and count == 0)
    check("it keeps a null value rather than a made-up one", derived[0]["value_usd"] is None)
    check("and the run says so", any("no price" in w for w in reporter.warnings))


# ------------------------------------------------------------------- resolution


def test_the_resolver_refuses_to_guess() -> None:
    ctx = context()
    check("an exact name resolves", ctx.resolver.resolve("Chile") == "CHL")
    check(
        "case and punctuation do not matter",
        ctx.resolver.resolve("democratic  republic of the congo.") == "COD",
    )
    check("an alias resolves", ctx.resolver.resolve("Congo (Kinshasa)") == "COD")
    check("an aggregate is not a country", ctx.resolver.resolve("World") is None)
    check("World is recognised as an aggregate", ctx.resolver.is_aggregate("European Union"))
    check("a near-miss is not guessed at", ctx.resolver.resolve("Chilee") is None)
    check("the miss is recorded", "Chilee" in ctx.resolver.unresolved)


# ---------------------------------------------------------------- unit handling


def test_unit_conversions() -> None:
    from sources import usgs_nmic
    from sources.base import production_basis

    table = usgs_nmic.UNIT_TO_USD_PER_TONNE
    check("dollars per tonne pass through", table["dollars per metric ton"] == 1.0)
    check("dollars per kilogram scale by 1000", table["dollars per kilogram"] == 1000.0)
    check(
        "cents per pound land near $9,100/t for copper at 414.7c",
        abs(414.7 * table["cents per pound"] - 9142) < 5,
    )
    check(
        "lithium production is converted to the LCE basis flows use",
        abs(production_basis("usgs-nmic")["lithium"] - 5.323) < 1e-9,
    )
    check("copper needs no conversion", "copper" not in production_basis("usgs-nmic"))


def test_the_production_check_flags_an_impossible_flow() -> None:
    flows = [
        {
            "id": "impossible",
            "mineral_id": "copper",
            "year": 2024,
            "value_usd": 1.0,
            "volume_tonnes": 10_000_000.0,
            "from_iso3": "CHL",
            "to_iso3": "CHN",
            "stage_from": "mine",
            "stage_to": "process",
            "source": "seed",
            "confidence": "high",
        }
    ]
    reporter = silent()
    pipeline.check_against_production(flows, {("copper", "CHL", "mine"): 5_510_000.0}, reporter)
    check("a flow at twice production is not flagged", not reporter.warnings)

    reporter = silent()
    pipeline.check_against_production(flows, {("copper", "CHL", "mine"): 100_000.0}, reporter)
    check("a flow at a hundred times production is flagged", len(reporter.warnings) == 1)


# ------------------------------------------------------------------ end to end


def test_the_offline_run_reproduces_the_seed_dataset() -> None:
    with tempfile.TemporaryDirectory() as directory:
        code = pipeline.main(["--offline", "--no-manual", "--output", directory])
        check("the empty-runner case exits clean", code == 0)

        written = Path(directory)
        for name in (
            "minerals.json",
            "facilities.geojson",
            "flows.json",
            "prices.json",
            "countries.json",
            "meta.json",
        ):
            check(f"{name} was written", (written / name).is_file())

        flows = json.loads((written / "flows.json").read_text(encoding="utf-8"))
        estimated = [f for f in flows if f["source"] == "estimated"]
        check("the seed's estimated flows came out estimated", len(estimated) == 14)
        check(
            "every estimated flow carries the volume it was derived from",
            all(f["volume_tonnes"] is not None and f["value_usd"] is not None for f in estimated),
        )

        countries = json.loads((written / "countries.json").read_text(encoding="utf-8"))
        facilities = json.loads((written / "facilities.geojson").read_text(encoding="utf-8"))
        referenced = {f["properties"]["country_iso3"] for f in facilities["features"]}
        for flow in flows:
            referenced.update((flow["from_iso3"], flow["to_iso3"]))
        check("every referenced country has a centroid", referenced <= set(countries))
        check("no unreferenced country is shipped", set(countries) == referenced)


def test_validation_rejects_a_bad_record() -> None:
    try:
        contract.validate_flows(
            [
                {
                    "id": "self",
                    "from_iso3": "CHL",
                    "to_iso3": "CHL",
                    "mineral_id": "copper",
                    "year": 2024,
                    "value_usd": 1.0,
                    "volume_tonnes": None,
                    "stage_from": "mine",
                    "stage_to": "process",
                    "source": "seed",
                    "confidence": "high",
                }
            ]
        )
        check("a self-flow is rejected", False, "no error was raised")
    except contract.DataValidationError as exc:
        check("a self-flow is rejected", "self-flow" in str(exc))

    try:
        contract.validate_flows(
            [
                {
                    "id": "unbacked",
                    "from_iso3": "CHL",
                    "to_iso3": "CHN",
                    "mineral_id": "copper",
                    "year": 2024,
                    "value_usd": 1.0,
                    "volume_tonnes": None,
                    "stage_from": "mine",
                    "stage_to": "process",
                    "source": "estimated",
                    "confidence": "high",
                }
            ]
        )
        check("an estimated flow with no volume is rejected", False, "no error was raised")
    except contract.DataValidationError as exc:
        check("an estimated flow with no volume is rejected", "volume" in str(exc))


def test_the_committed_data_still_validates() -> None:
    """The files in public/data are what the browser loads. They have to be valid."""
    read = lambda name: json.loads((contract.OUTPUT_DIR / name).read_text(encoding="utf-8"))  # noqa: E731
    dataset = contract.Dataset(
        minerals=read("minerals.json"),
        facilities=read("facilities.geojson")["features"],
        flows=read("flows.json"),
        prices=read("prices.json"),
        countries=read("countries.json"),
        meta=read("meta.json"),
    )
    try:
        dataset.validate()
        check("public/data validates against the contract", True)
    except contract.DataValidationError as exc:
        check("public/data validates against the contract", False, str(exc)[:400])


def main() -> int:
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        print(f"\n{test.__name__}")
        test()
    print(f"\n{len(FAILURES)} failures")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    raise SystemExit(main())
