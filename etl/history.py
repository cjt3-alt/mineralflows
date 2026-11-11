"""Production history: mine and refinery output by country for the years before the current release.

The monthly pipeline reads only the newest Mineral Commodity Summaries release, which carries two
production years. The USGS also keeps the earlier releases on ScienceBase, one item per commodity
per year ("Mineral Commodity Summaries 2024 - COPPER Data Release"), each with a small
`..._world.csv`. Stitching them together gives a few more years, enough for a timeline.

Written to `public/data/production_history.json` in the same record shape as `production.json`.
It is a separate file on purpose: the monthly refresh rewrites `production.json` from the newest
release and would otherwise drop the older years.

Honest limits, shown in the app and repeated here:
* Each release states a year's figure as an estimate the year after and revises it later. Where
  two releases carry the same year the newer one wins.
* USGS has changed its wording between releases (copper mine output was "contained" in the 2022
  release and "recoverable" in 2023 onward). Countries and totals are comparable in shape, but
  a step between releases can be a change of definition, not a change in the world.
* The 2025 per-commodity item for copper carries no world table, so the series is built from the
  2022, 2023 and 2024 releases here; the 2026 release (years 2024 and 2025) is in
  `production.json`.

Run:  python etl/history.py            (needs the network; no key)
"""

from __future__ import annotations

import csv
import io
import json
import re
import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))

import contract
import countries as country_tools

ROOT = Path(__file__).resolve().parent.parent
PRODUCTION = ROOT / "public" / "data" / "production.json"
COUNTRIES = ROOT / "public" / "data" / "countries.json"
MINERALS = ROOT / "etl" / "config" / "minerals.json"
OUT = ROOT / "public" / "data" / "production_history.json"

CATALOG_URL = "https://www.sciencebase.gov/catalog/items"
ITEM_URL = "https://www.sciencebase.gov/catalog/item/{item_id}"
ITEM_PAGE = "https://www.sciencebase.gov/catalog/item/{item_id}"
USER_AGENT = "Mozilla/5.0 (compatible; mineralflows-etl/1.0)"
TIMEOUT = 120
UNIT = "tonnes of contained metal"

STAGE_BY_TYPE = (
    ("mine production", "mine"),
    ("smelter production", "process"),
    ("refinery production", "refine"),
)


def stage_of(type_label: str) -> str | None:
    text = type_label.strip().lower()
    for prefix, stage in STAGE_BY_TYPE:
        if text.startswith(prefix):
            return stage
    return None


def to_number(value: object) -> float | None:
    text = str(value).strip().replace(",", "")
    if text in ("", "--", "W", "NA", "XX", "-"):
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_world_csv(
    text: str,
    mineral_id: str,
    release: int,
    resolver: country_tools.CountryResolver,
    source_url: str,
) -> tuple[list[dict], int]:
    """Production records from one release's world CSV, and how many rows were unresolved."""
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    fields = reader.fieldnames or []
    year_cols: list[tuple[str, int, bool]] = []
    for col in fields:
        m = re.match(r"^Prod_kt_(est_)?(\d{4})$", col.strip(), re.IGNORECASE)
        if m:
            year_cols.append((col, int(m.group(2)), m.group(1) is not None))
    if not year_cols:
        raise ValueError("no Prod_kt_<year> columns found")

    acc: dict[tuple[str, int], dict] = {}
    unresolved = 0
    for row in reader:
        stage = stage_of(row.get("Type") or "")
        if stage is None:
            continue
        name = (row.get("Country") or "").strip()
        for col, year, estimated in year_cols:
            kt = to_number(row.get(col))
            if kt is None:
                continue
            rec = acc.setdefault(
                (stage, year),
                {"by_country": {}, "world_total": None, "estimated": estimated},
            )
            tonnes = kt * 1000.0
            if name.lower().startswith("world total"):
                rec["world_total"] = tonnes
            elif name.lower() == "other countries" or resolver.is_aggregate(name):
                continue
            else:
                iso3 = resolver.resolve(name)
                if iso3 is None:
                    unresolved += 1
                    continue
                rec["by_country"][iso3] = rec["by_country"].get(iso3, 0.0) + tonnes

    records = []
    for (stage, year), rec in sorted(acc.items()):
        if not rec["by_country"] or rec["world_total"] is None:
            continue
        listed = sum(rec["by_country"].values())
        records.append(
            {
                "mineral_id": mineral_id,
                "stage": stage,
                "year": year,
                "unit": UNIT,
                "world_total": round(rec["world_total"], 1),
                "by_country": {k: round(v, 1) for k, v in sorted(rec["by_country"].items())},
                "other": round(max(rec["world_total"] - listed, 0.0), 1),
                "estimated": rec["estimated"],
                "source": "usgs-nmic",
                "source_url": source_url,
                "_release": release,
            }
        )
    return records, unresolved


def newest_wins(records: list[dict]) -> list[dict]:
    """One record per mineral, stage and year, from the newest release that has it."""
    best: dict[tuple[str, str, int], dict] = {}
    for r in records:
        key = (r["mineral_id"], r["stage"], r["year"])
        if key not in best or r["_release"] > best[key]["_release"]:
            best[key] = r
    return [{k: v for k, v in r.items() if k != "_release"} for _, r in sorted(best.items())]


def find_releases(session: requests.Session, name: str) -> dict[int, str]:
    """`{release_year: item_id}` for the commodity's per-year data releases."""
    response = session.get(
        CATALOG_URL,
        params={
            "q": f"Mineral Commodity Summaries {name} Data Release",
            "format": "json",
            "max": 100,
            "fields": "title",
        },
        timeout=TIMEOUT,
    )
    response.raise_for_status()
    pattern = re.compile(
        rf"^Mineral Commodity Summaries (\d{{4}}) - {re.escape(name.upper())} Data Release$"
    )
    found: dict[int, str] = {}
    for item in response.json().get("items", []):
        m = pattern.match(str(item.get("title", "")).strip())
        if m:
            found[int(m.group(1))] = item["id"]
    return found


def world_csv_url(session: requests.Session, item_id: str) -> str | None:
    response = session.get(
        ITEM_URL.format(item_id=item_id), params={"format": "json"}, timeout=TIMEOUT
    )
    response.raise_for_status()
    for f in response.json().get("files", []):
        if str(f.get("name", "")).endswith("_world.csv"):
            return f["url"]
    return None


def main() -> int:
    minerals = [m for m in json.loads(MINERALS.read_text(encoding="utf-8")) if m.get("active")]
    current = json.loads(PRODUCTION.read_text(encoding="utf-8"))
    have = {(r["mineral_id"], r["stage"], r["year"]) for r in current}
    # Names resolve against the countries the app already knows, so a history row can never name
    # a country the map has no outline or centroid for.
    known = json.loads(COUNTRIES.read_text(encoding="utf-8"))
    resolver = country_tools.build_resolver({**country_tools.extra_countries(), **known})

    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    records: list[dict] = []
    for mineral in minerals:
        releases = find_releases(session, mineral["name"])
        if not releases:
            print(f"{mineral['id']}: no per-year releases found")
            continue
        for year, item_id in sorted(releases.items()):
            url = world_csv_url(session, item_id)
            if url is None:
                print(f"{mineral['id']} MCS {year}: no world table in the item; skipped")
                continue
            text = session.get(url, timeout=TIMEOUT).content.decode("utf-8-sig", errors="replace")
            got, unresolved = parse_world_csv(
                text, mineral["id"], year, resolver, ITEM_PAGE.format(item_id=item_id)
            )
            print(
                f"{mineral['id']} MCS {year}: {len(got)} stage-years, {unresolved} unresolved rows"
            )
            records.extend(got)

    history = [
        r for r in newest_wins(records) if (r["mineral_id"], r["stage"], r["year"]) not in have
    ]
    contract.validate_production([*current, *history])
    OUT.write_text(json.dumps(history, indent=1) + "\n", encoding="utf-8")
    years = sorted({r["year"] for r in history})
    print(f"{len(history)} records for years {years[:1]}..{years[-1:]} -> {OUT.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
