"""Tests for the production and price history scripts. Run with `python etl/test_history.py`.

No network: a small hand-made release table stands in for the USGS file. The cases are the ones
where a slip would look plausible: kilotonnes read as tonnes, an estimate marked as final, an old
release overriding a newer one, a percentage that does not add up.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import countries as country_tools
import history
import price_history

FAILURES: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(("  ok   " if ok else "  FAIL ") + name + ("" if ok else f"  {detail}"))
    if not ok:
        FAILURES.append(name)


RESOLVER = country_tools.build_resolver(
    {"CHL": {"name": "Chile", "lat": 0, "lon": 0}, "CHN": {"name": "China", "lat": 0, "lon": 0}}
)

CSV = (
    "﻿Source,Country,Type,Prod_kt_2022,Prod_kt_est_2023,Prod_notes\n"
    'MCS2024,Chile,"Mine production, recoverable copper content",5300 ,5200 ,\n'
    'MCS2024,China,"Mine production, recoverable copper content",1940 ,1700 ,\n'
    'MCS2024,Other countries,"Mine production, recoverable copper content",1000 ,1100 ,\n'
    'MCS2024,World total (rounded),"Mine production, recoverable copper content",21900 ,22000 ,\n'
    'MCS2024,Chile,"Refinery production, copper",2000 ,1900 ,\n'
    'MCS2024,China,"Refinery production, copper",11000 ,12000 ,\n'
    'MCS2024,World total (rounded),"Refinery production, copper",25900 ,27000 ,\n'
    'MCS2024,Atlantis,"Refinery production, copper",5 ,5 ,\n'
)


def test_parse() -> None:
    records, unresolved = history.parse_world_csv(
        CSV, "copper", 2024, RESOLVER, "https://example.org/x"
    )
    by = {(r["stage"], r["year"]): r for r in records}
    check("four stage-years", len(records) == 4, str(len(records)))
    mine22 = by[("mine", 2022)]
    check("kilotonnes become tonnes", mine22["by_country"]["CHL"] == 5_300_000.0)
    check("world total is read", mine22["world_total"] == 21_900_000.0)
    check("other is the remainder", abs(mine22["other"] - (21_900_000 - 5_300_000 - 1_940_000)) < 1)
    check("a final year is not marked estimated", mine22["estimated"] is False)
    check("the est_ column is marked estimated", by[("mine", 2023)]["estimated"] is True)
    check("an unknown country is dropped and counted", unresolved == 2, str(unresolved))
    check("it does not invent a country", "ATL" not in by[("refine", 2022)]["by_country"])


def test_newest_wins() -> None:
    old = {
        "mineral_id": "copper",
        "stage": "mine",
        "year": 2021,
        "world_total": 1.0,
        "_release": 2022,
    }
    new = {
        "mineral_id": "copper",
        "stage": "mine",
        "year": 2021,
        "world_total": 2.0,
        "_release": 2023,
    }
    out = history.newest_wins([old, new])
    check("one record per year", len(out) == 1)
    check("the newer release wins", out[0]["world_total"] == 2.0)
    check("the bookkeeping field is not published", "_release" not in out[0])


def test_stage_and_numbers() -> None:
    check("mine", history.stage_of("Mine production, contained copper") == "mine")
    check("refinery", history.stage_of("Refinery production, copper") == "refine")
    check("something else is ignored", history.stage_of("Net import reliance") is None)
    check(
        "placeholders are not numbers",
        history.to_number("W") is None and history.to_number("--") is None,
    )
    check("thousands separators", history.to_number("1,234 ") == 1234.0)


def test_price_history() -> None:
    rows = [("x", "y")] * 0
    months = [(f"2001M{m:02d}", 100.0 * m) for m in range(1, 13)]
    months += [(f"2002M{m:02d}", 5.0) for m in range(1, 7)]  # a part year
    months += [("1999M01", 9.0)]  # before the series starts
    out = price_history.annual_averages([(a, b) for a, b in months] + rows, {"copper": 1})
    check("only the whole year is kept", [r["year"] for r in out] == [2001], str(out))
    check("the mean is taken", out[0]["avg_price_usd_per_tonne"] == 650.0, str(out))


def main() -> int:
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            print("\n" + name)
            fn()
    print(f"\n{len(FAILURES)} failures")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    raise SystemExit(main())
