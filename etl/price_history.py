"""Price history: annual average prices from the World Bank Pink Sheet, back to 2000.

The monthly pipeline keeps only the last two years of prices. The Pink Sheet workbook carries every
month since 1960, so this script averages it by year for each active mineral it covers (copper;
see `sources/worldbank_pinksheet.py` for why only copper) and writes
`public/data/price_history.json`. These are nominal US dollars per tonne, not adjusted for
inflation, and a year is included only when all twelve months are present.

Run:  python etl/price_history.py        (reads the cached workbook, or downloads it)
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import openpyxl
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sources import worldbank_pinksheet as pink
from sources.base import cache_path

ROOT = Path(__file__).resolve().parent.parent
MINERALS = ROOT / "etl" / "config" / "minerals.json"
OUT = ROOT / "public" / "data" / "price_history.json"
FIRST_YEAR = 2000


def annual_averages(rows: list[tuple], columns: dict[str, int]) -> list[dict]:
    """Annual means of the monthly series, whole years only, from `FIRST_YEAR`."""
    monthly: dict[tuple[str, int], list[float]] = {}
    for row in rows:
        label = row[0]
        m = re.match(r"^(\d{4})M(\d{2})$", str(label).strip()) if label else None
        if not m:
            continue
        year = int(m.group(1))
        if year < FIRST_YEAR:
            continue
        for mineral_id, index in columns.items():
            try:
                monthly.setdefault((mineral_id, year), []).append(float(row[index]))
            except (TypeError, ValueError):
                continue  # the sheet writes an ellipsis for a missing month
    return [
        {
            "mineral_id": mineral_id,
            "year": year,
            "avg_price_usd_per_tonne": round(sum(v) / len(v), 2),
            "source": pink.SOURCE_ID,
            "source_url": pink.LANDING_URL,
        }
        for (mineral_id, year), v in sorted(monthly.items())
        if len(v) == 12
    ]


def main() -> int:
    path = cache_path(pink.SOURCE_ID, "CMO-Historical-Data-Monthly.xlsx")
    if not path.exists():
        response = requests.get(
            pink.discover_url(), timeout=pink.TIMEOUT, headers={"User-Agent": pink.USER_AGENT}
        )
        response.raise_for_status()
        path.write_bytes(response.content)

    book = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        rows = list(book[pink.SHEET].iter_rows(values_only=True))
    finally:
        book.close()

    headers = [str(c).strip() if c is not None else "" for c in rows[4]]
    units = [str(c).strip("() ") if c is not None else "" for c in rows[5]]
    wanted = {
        m["name"].strip().lower(): m["id"]
        for m in json.loads(MINERALS.read_text(encoding="utf-8"))
        if m.get("active")
    }
    columns = {
        wanted[h.lower()]: i
        for i, h in enumerate(headers)
        if h.lower() in wanted and units[i] == pink.EXPECTED_UNIT
    }
    out = annual_averages(rows[6:], columns)
    OUT.write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8")
    years = sorted({r["year"] for r in out})
    names = ", ".join(sorted(columns))
    print(f"{len(out)} annual prices ({names}), {years[0]}..{years[-1]} -> {OUT.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
