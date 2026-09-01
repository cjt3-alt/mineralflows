"""The hand-authored seed dataset, loaded as a fallback rather than as a source.

`etl/seed/` holds the small, checkable dataset written in phase 1: thirty real
facilities, twenty-eight flows, eight prices and twenty-six country centroids. It
exists so the app works before any real extract lands, and so every code path —
low-confidence facilities, estimated values, a mineral that only trades at one
stage — is exercised from day one.

**Fallback, not a layer.** A seed row and a real row can describe the same thing:
the seed's Escondida and ICMM's Escondida are one mine with two ids, and a seed
copper flow and a TiCM copper flow are one trade with two ids. Adding them
together would double-count, and there is no key that would let the pipeline
merge them. So for facilities and flows, if any real source produced rows, the
seed rows for that file are dropped whole.

Prices and centroids are different, and are merged key by key instead. A price is
identified by mineral and year and a centroid by ISO3, so a real row displaces
exactly the seed row it replaces and nothing can be counted twice. That matters
because no single price source covers all four minerals: the Pink Sheet has
copper alone, and dropping the whole file the moment copper arrives would leave
lithium, cobalt and rare earths with no price at all.

One deliberate difference from what phase 1 committed: the seed's estimated flows
are stored here with `value_usd: null`. The value is derived by the pipeline from
volume x price on every run, so the estimated-value path is live code rather than
a number baked into a file.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

from contract import ETL_ROOT
from sources.base import ExtractContext, SourceResult

SOURCE_ID = "seed"
KIND = "seed"

SEED_DIR = ETL_ROOT / "seed"
NAME = "Hand-authored seed dataset"


#: The day this dataset was hand-authored, which is the only honest answer to
#: "when was it retrieved". It was a constant taken from file mtime until CI
#: pointed out the obvious: a fresh clone stamps every file with the checkout
#: time, so the same seed reported a different provenance date on every machine.
AUTHORED_ON = date(2026, 8, 31)


def _load(name: str) -> object:
    return json.loads((SEED_DIR / name).read_text(encoding="utf-8"))


def extract(ctx: ExtractContext) -> SourceResult:
    facilities = _load("facilities.geojson")["features"]  # type: ignore[index]
    flows = _load("flows.json")
    prices = _load("prices.json")
    countries = _load("countries.json")

    return SourceResult(
        source_id=SOURCE_ID,
        name=NAME,
        url=None,
        vintage=str(ctx.year),
        retrieved_at=AUTHORED_ON,
        coverage=(
            f"{len(facilities)} facilities, {len(flows)} flows, {len(prices)} prices and "
            f"{len(countries)} country centroids, hand-authored to prove the data contract "
            "before real extracts landed. Real places and approximate coordinates."
        ),
        facilities=facilities,
        flows=flows,  # type: ignore[arg-type]
        prices=prices,  # type: ignore[arg-type]
        countries=countries,  # type: ignore[arg-type]
    )


def parts() -> dict[str, tuple[str, str]]:
    """Per-table `(vintage, coverage)`, so `meta.json` credits only the tables in use.

    Each table gets its own vintage because the legend bar reports vintage per
    source: the flows describe 2024 trade and the prices average two years, and
    collapsing both into one build date would be the dishonest version.
    """
    return {
        "facilities": (
            "2026",
            "Hand-authored facilities: real mines, smelters and refineries with approximate "
            "coordinates, standing in until a facility source is dropped in.",
        ),
        "flows": (
            "2024",
            "Hand-authored country-to-country flows on a contained-metal basis, standing in "
            "until a bilateral trade extract is dropped in.",
        ),
        "prices": (
            "2023-2024",
            "Indicative annual average prices, order-of-magnitude only, used where no price "
            "source covers a mineral.",
        ),
        "countries": (
            "2026",
            "Hand-picked representative country points, used where no country list covers an "
            "ISO3 code the data references.",
        ),
    }


def seed_files() -> list[Path]:
    return sorted(SEED_DIR.glob("*.json")) + sorted(SEED_DIR.glob("*.geojson"))
