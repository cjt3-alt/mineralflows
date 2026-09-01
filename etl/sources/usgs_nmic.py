"""USGS National Minerals Information Center — country production and prices.

The NMIC publishes the Mineral Commodity Summaries as a machine-readable data
release on ScienceBase every January: one CSV holding world production by
country and US salient statistics, including annual average prices, for over
ninety commodities. No key, no form, no rate limit.

It contributes two things:

* **Prices**, for every mineral the World Bank Pink Sheet does not carry, which
  in practice is lithium, cobalt and rare earths. Which series to use is a
  judgement call and lives in `etl/config/usgs_price_series.json`.
* **Country-level production**, which the data contract has nowhere to put — it
  has no production table and inventing one is out of scope. It is carried
  anyway because the pipeline uses it for the cross-source check that catches a
  trade flow larger than the origin country's entire output.

The release item id is discovered rather than pinned: ScienceBase mints a new
item each year and the file URLs inside it carry content hashes that change on
every republish.
"""

from __future__ import annotations

import json
import re
from datetime import date

import pandas as pd
import requests

from contract import ETL_ROOT
from sources.base import (
    AUTO,
    ExtractContext,
    SourceResult,
    cache_path,
    production_basis,
    skipped,
)

SOURCE_ID = "usgs-nmic"
KIND = AUTO

CATALOG_URL = "https://www.sciencebase.gov/catalog/items"
ITEM_URL = "https://www.sciencebase.gov/catalog/item/{item_id}"
NMIC_URL = "https://www.usgs.gov/centers/national-minerals-information-center"
NAME = "USGS Mineral Commodity Summaries"
TITLE_RE = re.compile(r"^Mineral Commodity Summaries (\d{4}) Data Release$")
SERIES_FILE = ETL_ROOT / "config" / "usgs_price_series.json"
USER_AGENT = "Mozilla/5.0 (compatible; mineralflows-etl/1.0)"
TIMEOUT = 180

#: USGS quotes prices in whatever unit the trade uses. Everything downstream is
#: dollars per tonne, so anything not in this table is refused rather than
#: guessed at — a wrong factor here is an order-of-magnitude error in the arcs.
POUNDS_PER_TONNE = 2204.62262
UNIT_TO_USD_PER_TONNE = {
    "dollars per metric ton": 1.0,
    "dollars per kilogram": 1000.0,
    "dollars per pound": POUNDS_PER_TONNE,
    "cents per pound": POUNDS_PER_TONNE / 100.0,
}

#: Production is reported per country in one of two units.
PRODUCTION_UNIT_TO_TONNES = {"metric tons": 1.0, "thousand metric tons": 1000.0}

#: How the USGS names a production stage, in our vocabulary.
DETAIL_TO_STAGE = {
    "mine production": "mine",
    "smelter production": "process",
    "refinery production": "refine",
}


def _to_number(value: object) -> float | None:
    """USGS writes thousands separators, footnote markers and em-dashes for nil."""
    if value is None:
        return None
    text = str(value).strip().replace(",", "")
    if not text or text in {"--", "—", "NA", "W", "XX"}:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def discover_release(session: requests.Session) -> tuple[int, str, str]:
    """Return `(year, item_id, csv_url)` for the newest published release."""
    response = session.get(
        CATALOG_URL,
        params={
            "q": "Mineral Commodity Summaries Data Release",
            "format": "json",
            "max": 50,
            "fields": "title",
        },
        timeout=TIMEOUT,
    )
    response.raise_for_status()
    releases: dict[int, str] = {}
    for item in response.json().get("items", []):
        match = TITLE_RE.match(str(item.get("title", "")).strip())
        if match:
            releases[int(match.group(1))] = item["id"]
    if not releases:
        raise RuntimeError("no 'Mineral Commodity Summaries YYYY Data Release' item was found")

    year = max(releases)
    item_id = releases[year]
    item = session.get(ITEM_URL.format(item_id=item_id), params={"format": "json"}, timeout=TIMEOUT)
    item.raise_for_status()
    wanted = f"MCS{year}_Commodities_Data.csv"
    for entry in item.json().get("files", []):
        if entry.get("name") == wanted:
            return year, item_id, entry["url"]
    raise RuntimeError(f"the {year} release does not contain {wanted}")


def extract(ctx: ExtractContext) -> SourceResult:
    coverage_stub = (
        "World production by country and annual average prices, from the machine-readable "
        "Mineral Commodity Summaries data release."
    )
    if ctx.offline:
        return skipped(SOURCE_ID, NAME, NMIC_URL, "annual", coverage_stub, "--offline was set")

    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    try:
        release_year, _item_id, csv_url = discover_release(session)
        response = session.get(csv_url, timeout=TIMEOUT)
        response.raise_for_status()
        path = cache_path(SOURCE_ID, f"MCS{release_year}_Commodities_Data.csv")
        path.write_bytes(response.content)
    except Exception as exc:
        return skipped(
            SOURCE_ID, NAME, NMIC_URL, "annual", coverage_stub, f"could not download: {exc}"
        )

    # The release is not UTF-8: it carries Windows-1252 punctuation in the notes.
    frame = pd.read_csv(path, low_memory=False, encoding="latin-1", dtype=str)

    by_name = {m["name"].strip().lower(): m["id"] for m in ctx.minerals if m.get("active")}
    frame["mineral_id"] = frame["Commodity"].str.strip().str.lower().map(by_name)
    frame = frame[frame["mineral_id"].notna()]

    warnings: list[str] = []
    prices = _extract_prices(frame, ctx, warnings, release_year)
    production = _extract_production(frame, ctx, warnings)

    covered = sorted({p["mineral_id"] for p in prices})
    return SourceResult(
        source_id=SOURCE_ID,
        name=NAME,
        url=NMIC_URL,
        vintage=f"MCS {release_year}",
        retrieved_at=date.today(),
        coverage=(
            f"{coverage_stub} Prices cover "
            + (", ".join(covered) if covered else "none of the tracked minerals")
            + f"; {len(production)} country-stage production figures were read for "
            "cross-checking trade volumes."
        ),
        prices=prices,
        production=production,
        warnings=warnings,
    )


def _extract_prices(
    frame: pd.DataFrame, ctx: ExtractContext, warnings: list[str], release_year: int
) -> list[dict]:
    config = json.loads(SERIES_FILE.read_text(encoding="utf-8"))["series"]
    rows = frame[frame["Statistics"].str.strip().str.lower() == "price"]
    years = {ctx.year - 1, ctx.year}
    prices: list[dict] = []
    seen: set[tuple[str, int]] = set()

    for mineral_id, group in rows.groupby("mineral_id", sort=True):
        patterns = [p.lower() for p in config.get(str(mineral_id), [])]
        if not patterns:
            warnings.append(
                f"no price series is configured for {mineral_id}; add one to "
                "etl/config/usgs_price_series.json if a USGS price should be used"
            )
            continue

        for year in sorted(years):
            in_year = group[group["Year"].astype(str).str.strip() == str(year)]
            if in_year.empty:
                continue
            match = _first_matching_series(in_year, patterns)
            if match is None:
                warnings.append(
                    f"{mineral_id} {year}: none of the configured USGS price series were "
                    "published that year"
                )
                continue

            unit = str(match["Unit"]).strip().lower()
            factor = UNIT_TO_USD_PER_TONNE.get(unit)
            value = _to_number(match["Value"])
            if factor is None:
                warnings.append(
                    f"{mineral_id} {year}: price is quoted in {unit!r}, which has no "
                    "documented conversion to dollars per tonne; the row was dropped"
                )
                continue
            if value is None or value <= 0:
                continue
            key = (str(mineral_id), year)
            if key in seen:
                continue
            seen.add(key)
            prices.append(
                {
                    "mineral_id": str(mineral_id),
                    "year": year,
                    "avg_price_usd_per_tonne": round(value * factor, 2),
                    "source": SOURCE_ID,
                    "source_url": f"{NMIC_URL}/mineral-commodity-summaries",
                }
            )

    if release_year <= ctx.year:
        warnings.append(
            f"the newest release is MCS {release_year}, so {ctx.year} prices are the USGS "
            "estimate rather than a final figure"
        )
    return prices


def _first_matching_series(rows: pd.DataFrame, patterns: list[str]) -> pd.Series | None:
    details = rows["Statistics_detail"].fillna("").str.lower()
    for pattern in patterns:
        hits = rows[details.str.contains(pattern, regex=False)]
        if not hits.empty:
            return hits.iloc[0]
    return None


def _extract_production(
    frame: pd.DataFrame, ctx: ExtractContext, warnings: list[str]
) -> dict[tuple[str, str, str], float]:
    rows = frame[
        (frame["Statistics"].str.strip().str.lower() == "production")
        & (frame["Section"].fillna("").str.startswith("World"))
        & (frame["Year"].astype(str).str.strip() == str(ctx.year))
    ]
    production: dict[tuple[str, str, str], float] = {}
    basis = production_basis(SOURCE_ID)
    dropped = 0

    for _, row in rows.iterrows():
        detail = str(row["Statistics_detail"]).strip().lower()
        # ": rounded" duplicates the world total at lower precision.
        if detail.endswith(": rounded"):
            continue
        stage = DETAIL_TO_STAGE.get(detail)
        if stage is None:
            continue
        country = row["Country"]
        if ctx.resolver.is_aggregate(country):
            continue
        iso3 = ctx.resolver.resolve(country)
        tonnes = _to_number(row["Value"])
        factor = PRODUCTION_UNIT_TO_TONNES.get(str(row["Unit"]).strip().lower())
        if iso3 is None or tonnes is None or factor is None:
            dropped += 1
            continue
        mineral_id = str(row["mineral_id"])
        key = (mineral_id, iso3, stage)
        production[key] = production.get(key, 0.0) + tonnes * factor * basis.get(mineral_id, 1.0)

    if dropped:
        warnings.append(
            f"{dropped} production rows were dropped for an unresolved country, a withheld "
            "value, or an unrecognised unit"
        )
    for mineral_id, ratio in sorted(basis.items()):
        warnings.append(
            f"{mineral_id} production was multiplied by {ratio} to match the basis flow "
            "volumes are carried on; see etl/config/production_basis.json"
        )
    return production
