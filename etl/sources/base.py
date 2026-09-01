"""The uniform interface every source module implements.

A source module does exactly three things: work out whether its input is
reachable, normalise what it finds into the shape of the data contract, and say
what it did. It never writes files, never decides precedence against another
source, and never fails the run on its own — the orchestrator owns all of that.

Two kinds of source, treated differently on purpose:

* `AUTO` sources fetch over the network from a stable public URL. A network
  failure is a skip, not a crash: the pipeline still has to produce valid files
  when the runner has no egress.
* `MANUAL` sources read a file a human dropped into `etl/raw/manual/<id>/`.
  A missing file is the normal case, not an error, and is reported as a skip
  with the exact path that was looked for.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Protocol

from contract import ETL_ROOT
from countries import CountryResolver

AUTO = "auto"
MANUAL = "manual"

RAW_AUTO = ETL_ROOT / "raw" / "auto"
RAW_MANUAL = ETL_ROOT / "raw" / "manual"
BASIS_FILE = ETL_ROOT / "config" / "production_basis.json"


@dataclass
class ExtractContext:
    """Everything a source needs from the outside world, passed in rather than imported."""

    minerals: list[dict]
    resolver: CountryResolver
    #: Skip every network call. Set by --offline, and by the tests.
    offline: bool = False
    #: Ignore the manual drops even when they are present, to exercise the
    #: seed-fallback path that a fresh clone or an empty runner would take.
    ignore_manual: bool = False
    #: Trade year to extract. Sources without that year report a skip.
    year: int = 2024

    def mineral_by_id(self, mineral_id: str) -> dict | None:
        return next((m for m in self.minerals if m["id"] == mineral_id), None)

    def active_trade_codes(self) -> dict[str, tuple[str, str]]:
        """`hs_code -> (mineral_id, stage)`, for active codes only.

        This is the whole reason adding a fifth mineral is a data edit: the
        trade extractor knows nothing about copper or lithium, only about which
        codes are switched on in `etl/config/minerals.json`.
        """
        mapping: dict[str, tuple[str, str]] = {}
        for mineral in self.minerals:
            if not mineral.get("active"):
                continue
            for code in mineral["trade_codes"]:
                if code.get("active"):
                    mapping[code["hs_code"]] = (mineral["id"], code["stage"])
        return mapping


@dataclass
class SourceResult:
    """What one source produced, and how the run should describe it afterwards."""

    source_id: str
    name: str
    url: str | None
    vintage: str
    retrieved_at: date
    coverage: str

    available: bool = True
    #: Filled in when `available` is False. Printed verbatim by the pipeline.
    skip_reason: str | None = None

    facilities: list[dict] = field(default_factory=list)
    flows: list[dict] = field(default_factory=list)
    prices: list[dict] = field(default_factory=list)
    countries: dict[str, dict] = field(default_factory=dict)
    #: Country-level production, in tonnes, keyed `(mineral_id, iso3, stage)`.
    #: Not an output file — the contract has no production table. It is used for
    #: the cross-source sanity check and nothing else.
    production: dict[tuple[str, str, str], float] = field(default_factory=dict)
    #: Non-fatal observations worth printing: rows dropped, columns missing.
    warnings: list[str] = field(default_factory=list)

    @property
    def row_count(self) -> int:
        return (
            len(self.facilities)
            + len(self.flows)
            + len(self.prices)
            + len(self.countries)
            + len(self.production)
        )

    def as_source_ref(self) -> dict:
        """The `meta.json` entry for this source. Only written if it contributed."""
        return {
            "id": self.source_id,
            "name": self.name,
            "url": self.url,
            "vintage": self.vintage,
            "retrieved_at": self.retrieved_at.isoformat(),
            "coverage": self.coverage,
        }


class Source(Protocol):
    """What `pipeline.py` expects of every module in this package."""

    SOURCE_ID: str
    KIND: str

    def extract(self, ctx: ExtractContext) -> SourceResult: ...


def skipped(
    source_id: str,
    name: str,
    url: str | None,
    vintage: str,
    coverage: str,
    reason: str,
) -> SourceResult:
    """A source that produced nothing, with the reason it produced nothing."""
    return SourceResult(
        source_id=source_id,
        name=name,
        url=url,
        vintage=vintage,
        retrieved_at=date.today(),
        coverage=coverage,
        available=False,
        skip_reason=reason,
    )


def manual_dir(source_id: str) -> Path:
    return RAW_MANUAL / source_id


def find_manual(source_id: str, pattern: str) -> list[Path]:
    """Manual drops, matched by glob so a dated filename still gets picked up."""
    directory = manual_dir(source_id)
    if not directory.is_dir():
        return []
    return sorted(p for p in directory.glob(pattern) if p.is_file() and not p.name.startswith("~$"))


def production_basis(source_id: str) -> dict[str, float]:
    """`mineral_id -> factor` converting this source's tonnages to the basis flows use.

    Lithium is the reason this exists: the USGS reports contained lithium and
    flows are carried as lithium carbonate equivalent, a factor of 5.3 apart. See
    `etl/config/production_basis.json` for the arithmetic and the reasoning.
    """
    config = json.loads(BASIS_FILE.read_text(encoding="utf-8"))["factors"]
    return {k: float(v) for k, v in config.get(source_id, {}).items()}


def drop_date(path: Path) -> date:
    """When a human put this file here, as best it can be established.

    Not the modification time. A fresh `git clone` stamps every file with the
    time of the clone, so mtime would have `meta.json` claim a five-year-old
    extract was retrieved this morning. The commit date is the date it was
    actually dropped in; mtime is the fallback for a file that is not committed
    yet, which is exactly the case where mtime is right.
    """
    try:
        result = subprocess.run(
            ["git", "log", "-1", "--format=%cs", "--", str(path)],
            cwd=path.parent,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        stamp = result.stdout.strip()
        if result.returncode == 0 and stamp:
            return date.fromisoformat(stamp)
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return datetime.fromtimestamp(path.stat().st_mtime).date()


def cache_path(source_id: str, filename: str) -> Path:
    """Where an auto source parks its download. Gitignored and safe to delete."""
    directory = RAW_AUTO / source_id
    directory.mkdir(parents=True, exist_ok=True)
    return directory / filename
