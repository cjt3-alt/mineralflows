"""ICMM Global Mining Dataset — facility-level points with confidence flags.

A manual drop. ICMM publishes the workbook behind a download form on its site,
so no machine can fetch it; a human downloads it and puts it in
`etl/raw/manual/icmm/`. Licensed CC BY 4.0, which is why the copy in this repo
can be committed.

Two decisions worth knowing about:

**Confidence.** ICMM rates each site High, Moderate or Very Low. The contract has
two levels. Only High maps to `high`; Moderate and Very Low both map to `low`,
so a moderately-sourced point is never promoted to look verified. That is the
conservative direction and it is the one the brief asks for.

**Multi-stage sites.** A site can be a `Mine;Smelter;Refinery`. The contract
gives a facility exactly one stage, and the stage filter is a first-class
control in the interface, so collapsing a three-stage site into one stage would
make that filter lie about what is there. Each stage therefore becomes its own
feature, sharing the site's coordinates and differing only in id and stage. The
consequence is coincident points on the globe for the few hundred sites that do
more than one thing, which is the lesser of the two problems.
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime
from pathlib import Path

import openpyxl

from contract import ETL_ROOT, slugify
from sources.base import MANUAL, ExtractContext, SourceResult, find_manual, manual_dir, skipped

SOURCE_ID = "icmm"
KIND = MANUAL

NAME = "ICMM Global Mining Dataset"
URL = "https://www.icmm.com/en-gb/research/social-performance/2025/global-mining-dataset"
EXPECTED_FILENAME = "global-mining-dataset-*.xlsx"
SHEET_PREFIX = "Global Mining Dataset"
ALIAS_FILE = ETL_ROOT / "config" / "commodity_aliases.json"

COMMODITY_COLUMNS = ("Primary Commodity", "Secondary Commodity ", "Other Commodities")

#: ICMM's asset vocabulary, in ours. "Plant" covers concentrators and chemical
#: plants, which sit between the mine and the refinery.
ASSET_TYPE_TO_STAGE = {
    "mine": "mine",
    "plant": "process",
    "smelter": "process",
    "steel plant": "process",
    "refinery": "refine",
}

#: Only a directly verified site is allowed to read as verified.
CONFIDENCE_MAP = {"high": "high", "moderate": "low", "very low": "low", "low": "low"}


def _tokens(value: object) -> list[str]:
    if value is None:
        return []
    return [t.strip().lower() for t in re.split(r"[;,/]", str(value)) if t.strip()]


def extract(ctx: ExtractContext) -> SourceResult:
    coverage_stub = (
        "Geocoded mines, plants, smelters and refineries, with ICMM's own confidence rating "
        "carried through."
    )
    if ctx.ignore_manual:
        return skipped(SOURCE_ID, NAME, URL, "v1.5", coverage_stub, "--no-manual was set")

    matches = find_manual(SOURCE_ID, EXPECTED_FILENAME)
    if not matches:
        return skipped(
            SOURCE_ID,
            NAME,
            URL,
            "v1.5",
            coverage_stub,
            f"no file matching {EXPECTED_FILENAME} in {manual_dir(SOURCE_ID)}. "
            "See etl/README.md for where to download it.",
        )

    path = matches[-1]
    try:
        return _read(path, ctx, coverage_stub)
    except Exception as exc:
        # A malformed drop is a skip, not a crash: the run still has to produce
        # valid files from whatever else it can reach.
        return skipped(
            SOURCE_ID, NAME, URL, "v1.5", coverage_stub, f"could not read {path.name}: {exc}"
        )


def _read(path: Path, ctx: ExtractContext, coverage_stub: str) -> SourceResult:
    book = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        sheet_name = next(
            (s for s in book.sheetnames if s.startswith(SHEET_PREFIX)),
            None,
        )
        if sheet_name is None:
            raise RuntimeError(f"no sheet starting with {SHEET_PREFIX!r}")
        rows = book[sheet_name].iter_rows(values_only=True)
        header = list(next(rows))
        index = {name: i for i, name in enumerate(header)}
        missing = [c for c in (*COMMODITY_COLUMNS, "ICMMID", "Latitude") if c not in index]
        if missing:
            raise RuntimeError("the sheet is missing columns: " + ", ".join(missing))
        records = list(rows)
    finally:
        book.close()

    version = _version_from(path.name, sheet_name)
    aliases = json.loads(ALIAS_FILE.read_text(encoding="utf-8"))["tokens"]
    wanted: dict[str, set[str]] = {}
    for mineral in ctx.minerals:
        if not mineral.get("active"):
            continue
        wanted[mineral["id"]] = {mineral["name"].strip().lower()} | {
            t.lower() for t in aliases.get(mineral["id"], [])
        }

    features: list[dict] = []
    warnings: list[str] = []
    dropped_country = 0
    dropped_coords = 0
    dropped_stage = 0
    seen_ids: set[str] = set()
    last_updated = date.today().isoformat()

    for row in records:
        commodities: set[str] = set()
        for column in COMMODITY_COLUMNS:
            commodities.update(_tokens(row[index[column]]))
        mineral_ids = sorted(mid for mid, tokens in wanted.items() if commodities & tokens)
        if not mineral_ids:
            continue

        try:
            lat = float(row[index["Latitude"]])
            lon = float(row[index["Longitude"]])
        except (TypeError, ValueError):
            dropped_coords += 1
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            dropped_coords += 1
            continue

        iso3 = ctx.resolver.resolve(row[index["Country"]])
        if iso3 is None:
            dropped_country += 1
            continue

        stages = sorted(
            {
                stage
                for token in _tokens(row[index["Asset Type"]])
                if (stage := ASSET_TYPE_TO_STAGE.get(token)) is not None
            }
        )
        if not stages:
            dropped_stage += 1
            continue

        icmm_id = str(row[index["ICMMID"]]).strip()
        name = str(row[index["Mine Name"]] or icmm_id).strip()
        operator = row[index["Group Names"]]
        operator = str(operator).split(";")[0].strip() if operator else None
        confidence = CONFIDENCE_MAP.get(
            str(row[index["Confidence Factor"]] or "").strip().lower(), "low"
        )

        for stage in stages:
            facility_id = f"{SOURCE_ID}.{slugify(icmm_id)}.{stage}"
            if facility_id in seen_ids:
                continue
            seen_ids.add(facility_id)
            features.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [lon, lat]},
                    "properties": {
                        "id": facility_id,
                        "name": name,
                        "mineral_ids": mineral_ids,
                        "stage": stage,
                        "country_iso3": iso3,
                        "operator": operator or None,
                        # ICMM v1.5 publishes no capacity column. Null is the
                        # honest answer; the interface renders it as unknown.
                        "capacity_tonnes_per_year": None,
                        "source": SOURCE_ID,
                        "source_url": URL,
                        "confidence": confidence,
                        "last_updated": last_updated,
                    },
                }
            )

    for count, reason in (
        (dropped_country, "an unresolved country name"),
        (dropped_coords, "missing or out-of-range coordinates"),
        (dropped_stage, "an asset type with no stage equivalent"),
    ):
        if count:
            warnings.append(f"{count} matching sites were dropped for {reason}")

    low = sum(1 for f in features if f["properties"]["confidence"] == "low")
    return SourceResult(
        source_id=SOURCE_ID,
        name=NAME,
        url=URL,
        vintage=version,
        retrieved_at=_file_date(path),
        coverage=(
            f"{len(features)} facility records across {len(seen_ids)} site-stages, of which "
            f"{low} are low confidence. {coverage_stub} A site that does more than one thing "
            "appears once per stage at the same coordinates."
        ),
        facilities=features,
        warnings=warnings,
    )


def _version_from(filename: str, sheet_name: str) -> str:
    match = re.search(r"v?(\d+[\.-]\d+)", sheet_name) or re.search(r"(\d+-\d+)\.xlsx$", filename)
    return "v" + match.group(1).replace("-", ".") if match else "unknown version"


def _file_date(path: Path) -> date:
    """When the human dropped the file in, which is the honest retrieval date."""
    return datetime.fromtimestamp(path.stat().st_mtime).date()
