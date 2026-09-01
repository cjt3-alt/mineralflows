"""ADB-WTO TiCM — bilateral trade in critical minerals, the source of `flows.json`.

A manual drop: critmin.org serves the extracts through a query form, so a human
runs the query and drops the CSVs into `etl/raw/manual/ticm/`.

Four properties of these files decide most of the code below. All four were
confirmed by reading the actual extracts, not assumed:

1. **Values are raw US dollars, not thousands.** Chile to China under 260300
   reads 21,012,301,030.14, which is $21.0bn and matches the real trade.
2. **A file holds far more HS codes than its filename suggests.** The 740100
   extract carries 42 codes spanning 7401-7412. Filenames are labels, not
   contents, so every file is read and filtered on the codes the mineral config
   marks active.
3. **The same code appears in several files.** 280530, 284610 and 284690 each
   turn up in three of them. Without deduplication on
   reporter+partner+flow+hs_code+year, rare earths are counted three times.
4. **Aggregate partners sit alongside real ones.** Every file carries rows with
   a partner of "World" or "European Union". Summing those with their members
   doubles the total, so they are dropped before anything is added up.

One convention has to be chosen and stated: **exports define direction.** Each
pair appears twice, once as the exporter's Export row and once as the importer's
Import row, and the two disagree — Chile to China is $21.0bn as an export and
$2,554 as an import, because they describe different physical shipments. Export
rows are used with reporter as origin and partner as destination. Import rows
are read too, but only to fill pairs that have no export row at all, and those
flows are marked low confidence because they are a mirror rather than a direct
report.
"""

from __future__ import annotations

import pandas as pd

from contract import NEXT_STAGE
from sources.base import (
    MANUAL,
    ExtractContext,
    SourceResult,
    drop_date,
    find_manual,
    manual_dir,
    skipped,
)

SOURCE_ID = "adb-wto-ticm"
KIND = MANUAL

NAME = "ADB-WTO Trade in Critical Minerals database"
URL = "https://critmin.org"
EXPECTED_FILENAME = "ticm-*.csv"
REQUIRED_COLUMNS = {"reporter", "partner", "flow", "hs_code", "year", "value"}

#: How many flows to keep per mineral, largest by value. TiCM 2024 aggregates to
#: tens of thousands of country pairs; the app is a static site that fetches the
#: whole file before it can draw anything, and it caps the globe at a few hundred
#: arcs regardless. The cap is applied per mineral rather than globally so that
#: copper, which is an order of magnitude larger than everything else, cannot
#: crowd rare earths out of the file entirely.
DEFAULT_FLOWS_PER_MINERAL = 500


def extract(
    ctx: ExtractContext, flows_per_mineral: int = DEFAULT_FLOWS_PER_MINERAL
) -> SourceResult:
    coverage_stub = (
        "Bilateral trade by HS code, aggregated to one flow per mineral, country pair and "
        "supply-chain stage."
    )
    if ctx.ignore_manual:
        return skipped(SOURCE_ID, NAME, URL, str(ctx.year), coverage_stub, "--no-manual was set")

    paths = find_manual(SOURCE_ID, EXPECTED_FILENAME)
    if not paths:
        return skipped(
            SOURCE_ID,
            NAME,
            URL,
            str(ctx.year),
            coverage_stub,
            f"no files matching {EXPECTED_FILENAME} in {manual_dir(SOURCE_ID)}. "
            "See etl/README.md for the query to run at critmin.org.",
        )

    codes = ctx.active_trade_codes()
    warnings: list[str] = []
    frames: list[pd.DataFrame] = []

    for path in paths:
        try:
            frame = pd.read_csv(path, dtype=str)
        except Exception as exc:
            warnings.append(f"{path.name} could not be read and was skipped: {exc}")
            continue
        missing = REQUIRED_COLUMNS - set(frame.columns)
        if missing:
            warnings.append(f"{path.name} is missing the columns {sorted(missing)} and was skipped")
            continue
        frames.append(frame[sorted(REQUIRED_COLUMNS)])

    if not frames:
        return skipped(
            SOURCE_ID,
            NAME,
            URL,
            str(ctx.year),
            coverage_stub,
            "no readable file had the expected columns",
        )

    raw = pd.concat(frames, ignore_index=True)
    raw["hs_code"] = raw["hs_code"].str.strip().str.zfill(6)
    raw["year"] = pd.to_numeric(raw["year"], errors="coerce")
    raw["value"] = pd.to_numeric(raw["value"], errors="coerce")

    before = len(raw)
    # Point 3: the same observation appears in more than one extract.
    raw = raw.drop_duplicates(subset=["reporter", "partner", "flow", "hs_code", "year"])
    duplicates = before - len(raw)

    raw = raw[raw["hs_code"].isin(codes)]
    raw = raw[raw["year"] == ctx.year]
    raw = raw[raw["value"].notna() & (raw["value"] > 0)]
    if raw.empty:
        return skipped(
            SOURCE_ID,
            NAME,
            URL,
            str(ctx.year),
            coverage_stub,
            f"the extracts contain no {ctx.year} rows for any active HS code",
        )

    # Point 4: drop roll-up rows on either side of the pair.
    aggregate_rows = raw["reporter"].map(ctx.resolver.is_aggregate) | raw["partner"].map(
        ctx.resolver.is_aggregate
    )
    aggregates = int(aggregate_rows.sum())
    raw = raw[~aggregate_rows]

    names = pd.unique(pd.concat([raw["reporter"], raw["partner"]]))
    iso3 = {name: ctx.resolver.resolve(name) for name in names}
    raw["reporter_iso3"] = raw["reporter"].map(iso3)
    raw["partner_iso3"] = raw["partner"].map(iso3)
    unresolved = int(raw["reporter_iso3"].isna().sum() + raw["partner_iso3"].isna().sum())
    raw = raw[raw["reporter_iso3"].notna() & raw["partner_iso3"].notna()]
    raw = raw[raw["reporter_iso3"] != raw["partner_iso3"]]

    raw["mineral_id"] = raw["hs_code"].map(lambda c: codes[c][0])
    raw["stage_from"] = raw["hs_code"].map(lambda c: codes[c][1])
    raw["stage_to"] = raw["stage_from"].map(NEXT_STAGE)
    direction = raw["flow"].str.strip().str.lower()

    exports = _aggregate(
        raw[direction == "export"], origin="reporter_iso3", destination="partner_iso3"
    )
    # A mirror: the importer reporting where its goods came from.
    imports = _aggregate(
        raw[direction == "import"], origin="partner_iso3", destination="reporter_iso3"
    )

    flows: list[dict] = []
    keys = set(exports.index)
    for key, value in exports.items():
        flows.append(_flow(key, value, ctx.year, confidence="high", mirrored=False))
    mirrored = 0
    for key, value in imports.items():
        if key in keys:
            continue
        mirrored += 1
        flows.append(_flow(key, value, ctx.year, confidence="low", mirrored=True))

    kept, capped = _cap_per_mineral(flows, flows_per_mineral)

    if duplicates:
        warnings.append(f"{duplicates} rows were duplicated across extracts and were counted once")
    if aggregates:
        warnings.append(f"{aggregates} rows had an aggregate reporter or partner and were dropped")
    if unresolved:
        warnings.append(f"{unresolved} rows named a country that did not resolve and were dropped")
    if mirrored:
        warnings.append(
            f"{mirrored} country pairs had no export row and were filled from the importer's "
            "mirror report; those flows are marked low confidence"
        )
    if capped:
        warnings.append(
            f"{capped} flows beyond the top {flows_per_mineral} per mineral by value were "
            "dropped to keep the static payload small"
        )

    return SourceResult(
        source_id=SOURCE_ID,
        name=NAME,
        url=URL,
        vintage=str(ctx.year),
        retrieved_at=max(drop_date(p) for p in paths),
        coverage=(
            f"{len(kept)} flows for {ctx.year}, the largest {flows_per_mineral} per mineral by "
            f"value out of {len(flows)} found. {coverage_stub} Direction follows the exporter's "
            "report; pairs with no export row are filled from the importer's mirror and marked "
            "low confidence. Values are traded values, not estimates."
        ),
        flows=kept,
        warnings=warnings,
    )


def _aggregate(frame: pd.DataFrame, origin: str, destination: str) -> pd.Series:
    if frame.empty:
        return pd.Series(dtype="float64")
    grouped = frame.groupby(
        [origin, destination, "mineral_id", "stage_from", "stage_to"], sort=False
    )["value"].sum()
    grouped.index.names = ["from_iso3", "to_iso3", "mineral_id", "stage_from", "stage_to"]
    return grouped


def _flow(key: tuple, value: float, year: int, confidence: str, mirrored: bool) -> dict:
    from_iso3, to_iso3, mineral_id, stage_from, stage_to = key
    return {
        "id": (
            f"{SOURCE_ID}.{mineral_id}.{from_iso3.lower()}-{to_iso3.lower()}"
            f".{stage_from}-{stage_to}.{year}"
        ),
        "from_iso3": from_iso3,
        "to_iso3": to_iso3,
        "mineral_id": mineral_id,
        "year": year,
        "value_usd": round(float(value), 2),
        # TiCM reports value only. A null volume is the honest answer, and it is
        # what keeps this flow out of the estimated-value path: a traded value
        # must never be overwritten by volume x price.
        "volume_tonnes": None,
        "stage_from": stage_from,
        "stage_to": stage_to,
        "source": f"{SOURCE_ID}-mirror" if mirrored else SOURCE_ID,
        "confidence": confidence,
    }


def _cap_per_mineral(flows: list[dict], limit: int) -> tuple[list[dict], int]:
    kept: list[dict] = []
    dropped = 0
    by_mineral: dict[str, list[dict]] = {}
    for flow in flows:
        by_mineral.setdefault(flow["mineral_id"], []).append(flow)
    for mineral_id in sorted(by_mineral):
        ranked = sorted(by_mineral[mineral_id], key=lambda f: f["value_usd"] or 0, reverse=True)
        kept.extend(ranked[:limit])
        dropped += max(0, len(ranked) - limit)
    kept.sort(key=lambda f: f["value_usd"] or 0, reverse=True)
    return kept, dropped
