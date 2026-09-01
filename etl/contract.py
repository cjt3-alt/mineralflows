"""The data contract, in Python.

`src/data/schema.ts` is the authority on the shape of everything in
`public/data/`. This module mirrors it so the pipeline validates its own output
against the same rules the browser will apply, and fails before writing rather
than after. When one changes, the other has to change with it.

Validation is deliberately strict and loud. A record that does not conform is
printed in full alongside the reason, because silently coercing bad data is
worse than a crash.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
ETL_ROOT = REPO_ROOT / "etl"
OUTPUT_DIR = REPO_ROOT / "public" / "data"

SCHEMA_VERSION = "1.0.0"

STAGES = ("mine", "process", "refine")
CONFIDENCE_LEVELS = ("high", "low")

#: The stage a shipment lands in, given the stage its HS code describes. Ore
#: leaving a mining country arrives somewhere to be processed; refined metal
#: arrives already refined. This is what turns a single-stage trade code into
#: the two-ended flow the globe draws.
NEXT_STAGE = {"mine": "process", "process": "refine", "refine": "refine"}

SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
ID_RE = re.compile(r"^[a-z0-9]+(?:[-.][a-z0-9]+)*$")
HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
ISO3_RE = re.compile(r"^[A-Z]{3}$")
HS_RE = re.compile(r"^\d{6}$")
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")


class DataValidationError(Exception):
    """Raised with the file, every problem found, and the offending record."""

    def __init__(self, file: str, problems: Sequence[str], offending: Any) -> None:
        rendered = json.dumps(offending, indent=2, default=str)[:2000]
        super().__init__(
            f"{file} failed validation:\n"
            + "\n".join(f"  - {p}" for p in problems)
            + f"\n\nOffending record:\n{rendered}"
        )
        self.file = file
        self.problems = list(problems)
        self.offending = offending


def slugify(value: str) -> str:
    """Lowercase kebab-case, for ids built out of source strings."""
    cleaned = re.sub(r"[^a-z0-9]+", "-", str(value).lower()).strip("-")
    return re.sub(r"-{2,}", "-", cleaned)


# --------------------------------------------------------------- field checks


def _check(problems: list[str], ok: bool, message: str) -> None:
    if not ok:
        problems.append(message)


def _is_num(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _check_url(problems: list[str], field: str, value: Any, nullable: bool) -> None:
    if value is None:
        _check(problems, nullable, f"{field}: must not be null")
        return
    _check(
        problems,
        isinstance(value, str) and value.startswith(("http://", "https://")),
        f"{field}: must be an absolute http(s) URL, got {value!r}",
    )


# ------------------------------------------------------------------- minerals


def validate_minerals(records: Sequence[dict]) -> None:
    if not records:
        raise DataValidationError("minerals.json", ["must contain at least one mineral"], records)
    _validate_each("minerals.json", records, _mineral_problems)
    _check_unique("minerals.json", records, lambda m: m["id"], "mineral id")


def _mineral_problems(m: dict) -> list[str]:
    p: list[str] = []
    _check(p, SLUG_RE.match(str(m.get("id", ""))) is not None, "id: must be a kebab-case slug")
    _check(p, bool(str(m.get("name", "")).strip()), "name: must not be empty")
    _check(p, HEX_RE.match(str(m.get("color", ""))) is not None, "color: must be a 6-digit hex")
    glow = m.get("glow_intensity")
    _check(p, _is_num(glow) and 0 <= glow <= 1, "glow_intensity: must be between 0 and 1")
    _check(p, isinstance(m.get("sort_order"), int), "sort_order: must be an integer")
    _check(p, isinstance(m.get("active"), bool), "active: must be a boolean")
    _check(p, bool(str(m.get("usgs_commodity_code", "")).strip()), "usgs_commodity_code: required")

    codes = m.get("trade_codes") or []
    _check(p, len(codes) > 0, "trade_codes: must not be empty")
    seen: set[str] = set()
    for code in codes:
        hs = str(code.get("hs_code", ""))
        _check(p, HS_RE.match(hs) is not None, f"trade_codes: {hs!r} is not a 6-digit HS code")
        _check(p, code.get("stage") in STAGES, f"trade_codes: {hs} has stage {code.get('stage')!r}")
        _check(p, isinstance(code.get("active"), bool), f"trade_codes: {hs} needs a boolean active")
        _check(p, hs not in seen, f"trade_codes: duplicate HS code {hs}")
        seen.add(hs)

    active = sorted(c["hs_code"] for c in codes if c.get("active"))
    flat = sorted(m.get("hs_codes") or [])
    _check(
        p,
        active == flat,
        f"hs_codes: must list exactly the active trade_codes. Got {flat}, expected {active}.",
    )
    return p


# ----------------------------------------------------------------- facilities


def validate_facilities(collection: dict) -> None:
    if collection.get("type") != "FeatureCollection":
        raise DataValidationError(
            "facilities.geojson", ["type: must be FeatureCollection"], collection
        )
    features = collection.get("features") or []
    _validate_each("facilities.geojson", features, _facility_problems)
    _check_unique("facilities.geojson", features, lambda f: f["properties"]["id"], "facility id")


def _facility_problems(f: dict) -> list[str]:
    p: list[str] = []
    if f.get("type") != "Feature":
        p.append("type: must be Feature")
    geometry = f.get("geometry") or {}
    coords = geometry.get("coordinates") or []
    if geometry.get("type") != "Point" or len(coords) != 2:
        p.append("geometry: must be a Point with two coordinates")
    else:
        lon, lat = coords
        # GeoJSON is [longitude, latitude]. Getting it backwards puts Chile in
        # the Indian Ocean, so the bounds are checked rather than assumed.
        _check(p, _is_num(lon) and -180 <= lon <= 180, f"geometry: longitude {lon} out of range")
        _check(p, _is_num(lat) and -90 <= lat <= 90, f"geometry: latitude {lat} out of range")

    props = f.get("properties") or {}
    _check(p, ID_RE.match(str(props.get("id", ""))) is not None, "id: must be a lowercase id")
    _check(p, bool(str(props.get("name", "")).strip()), "name: must not be empty")
    minerals = props.get("mineral_ids") or []
    _check(p, len(minerals) > 0, "mineral_ids: must not be empty")
    for mid in minerals:
        _check(p, SLUG_RE.match(str(mid)) is not None, f"mineral_ids: {mid!r} is not a slug")
    _check(p, props.get("stage") in STAGES, f"stage: {props.get('stage')!r} is not a stage")
    _check(p, ISO3_RE.match(str(props.get("country_iso3", ""))) is not None, "country_iso3: ISO3")
    operator = props.get("operator")
    _check(p, operator is None or bool(str(operator).strip()), "operator: null or a name")
    capacity = props.get("capacity_tonnes_per_year")
    ok_capacity = capacity is None or (_is_num(capacity) and capacity > 0)
    _check(p, ok_capacity, "capacity_tonnes_per_year: null or positive")
    _check(p, bool(str(props.get("source", "")).strip()), "source: required")
    _check_url(p, "source_url", props.get("source_url"), nullable=True)
    _check(p, props.get("confidence") in CONFIDENCE_LEVELS, "confidence: high or low")
    last_updated = str(props.get("last_updated", ""))
    _check(p, ISO_DATE_RE.match(last_updated) is not None, "last_updated: must be a date")
    return p


# ---------------------------------------------------------------------- flows


def validate_flows(records: Sequence[dict]) -> None:
    _validate_each("flows.json", records, _flow_problems)
    _check_unique("flows.json", records, lambda f: f["id"], "flow id")


def _flow_problems(f: dict) -> list[str]:
    p: list[str] = []
    _check(p, ID_RE.match(str(f.get("id", ""))) is not None, "id: must be a lowercase id")
    for field in ("from_iso3", "to_iso3"):
        _check(p, ISO3_RE.match(str(f.get(field, ""))) is not None, f"{field}: must be ISO3")
    _check(p, SLUG_RE.match(str(f.get("mineral_id", ""))) is not None, "mineral_id: must be a slug")
    year = f.get("year")
    _check(p, isinstance(year, int) and 1900 <= year <= 2100, "year: must be between 1900 and 2100")
    for field in ("value_usd", "volume_tonnes"):
        v = f.get(field)
        _check(p, v is None or (_is_num(v) and v >= 0), f"{field}: null or non-negative")
    for field in ("stage_from", "stage_to"):
        _check(p, f.get(field) in STAGES, f"{field}: {f.get(field)!r} is not a stage")
    _check(p, bool(str(f.get("source", "")).strip()), "source: required")
    _check(p, f.get("confidence") in CONFIDENCE_LEVELS, "confidence: high or low")

    if f.get("value_usd") is None and f.get("volume_tonnes") is None:
        p.append("a flow needs at least one of value_usd or volume_tonnes")
    if f.get("from_iso3") == f.get("to_iso3"):
        p.append(f"self-flow {f.get('from_iso3')} to {f.get('to_iso3')} has no arc to draw")
    if f.get("source") == "estimated" and f.get("volume_tonnes") is None:
        p.append("an estimated flow must carry the volume its value was derived from")
    return p


# --------------------------------------------------------------------- prices


def validate_prices(records: Sequence[dict]) -> None:
    _validate_each("prices.json", records, _price_problems)
    _check_unique("prices.json", records, lambda r: f"{r['mineral_id']}:{r['year']}", "price key")


def _price_problems(r: dict) -> list[str]:
    p: list[str] = []
    _check(p, SLUG_RE.match(str(r.get("mineral_id", ""))) is not None, "mineral_id: must be a slug")
    year = r.get("year")
    _check(p, isinstance(year, int) and 1900 <= year <= 2100, "year: must be between 1900 and 2100")
    price = r.get("avg_price_usd_per_tonne")
    _check(p, _is_num(price) and price > 0, "avg_price_usd_per_tonne: must be positive")
    _check(p, bool(str(r.get("source", "")).strip()), "source: required")
    _check_url(p, "source_url", r.get("source_url"), nullable=False)
    return p


# ------------------------------------------------------------------ countries


def validate_countries(mapping: dict) -> None:
    if not mapping:
        raise DataValidationError("countries.json", ["must contain at least one country"], mapping)
    for iso3, country in mapping.items():
        p: list[str] = []
        _check(p, ISO3_RE.match(str(iso3)) is not None, f"{iso3!r}: key must be an ISO3 code")
        _check(p, bool(str(country.get("name", "")).strip()), "name: must not be empty")
        lat, lon = country.get("lat"), country.get("lon")
        _check(p, _is_num(lat) and -90 <= lat <= 90, f"lat: {lat} out of range")
        _check(p, _is_num(lon) and -180 <= lon <= 180, f"lon: {lon} out of range")
        if p:
            raise DataValidationError("countries.json", p, {iso3: country})


# ----------------------------------------------------------------------- meta


def validate_meta(meta: dict) -> None:
    p: list[str] = []
    generated = str(meta.get("generated_at", ""))
    try:
        datetime.fromisoformat(generated.replace("Z", "+00:00"))
    except ValueError:
        p.append(f"generated_at: {generated!r} is not an ISO datetime")
    else:
        # zod's z.iso.datetime() accepts a "Z" suffix and rejects "+00:00", so
        # anything else here is valid Python and invalid in the browser.
        _check(
            p,
            generated.endswith("Z"),
            f"generated_at: {generated!r} must end in Z, not a numeric UTC offset",
        )
    version = str(meta.get("schema_version", ""))
    _check(p, SEMVER_RE.match(version) is not None, "schema_version: must be semver")
    sources = meta.get("sources") or []
    _check(p, len(sources) > 0, "sources: must not be empty")
    for source in sources:
        sid = source.get("id")
        _check(p, SLUG_RE.match(str(sid or "")) is not None, f"sources: bad id {sid!r}")
        for field in ("name", "vintage", "coverage"):
            _check(p, bool(str(source.get(field, "")).strip()), f"sources[{sid}].{field}: required")
        _check_url(p, f"sources[{sid}].url", source.get("url"), nullable=True)
        _check(
            p,
            ISO_DATE_RE.match(str(source.get("retrieved_at", ""))) is not None,
            f"sources[{sid}].retrieved_at: must be a date",
        )
    if p:
        raise DataValidationError("meta.json", p, meta)


# ------------------------------------------------------------------- plumbing


def _validate_each(
    file: str, records: Iterable[dict], checker: Callable[[dict], list[str]]
) -> None:
    for record in records:
        problems = checker(record)
        if problems:
            raise DataValidationError(file, problems, record)


def _check_unique(
    file: str, records: Sequence[dict], key: Callable[[dict], str], label: str
) -> None:
    seen: set[str] = set()
    for record in records:
        k = key(record)
        if k in seen:
            raise DataValidationError(file, [f"duplicate {label} {k!r}"], record)
        seen.add(k)


@dataclass(frozen=True)
class Dataset:
    """Everything the pipeline is about to write, before it is written."""

    minerals: list[dict]
    facilities: list[dict]
    flows: list[dict]
    prices: list[dict]
    countries: dict[str, dict]
    meta: dict

    def validate(self) -> None:
        validate_minerals(self.minerals)
        validate_facilities(self.as_feature_collection())
        validate_flows(self.flows)
        validate_prices(self.prices)
        validate_countries(self.countries)
        validate_meta(self.meta)
        self._check_references()

    def as_feature_collection(self) -> dict:
        return {"type": "FeatureCollection", "features": self.facilities}

    def _check_references(self) -> None:
        """The joins the browser's loader also checks, caught here first.

        A dangling ISO3 is not a cosmetic problem: an arc with no endpoint never
        draws, so the app would show a quietly incomplete globe rather than an
        error anyone could act on.
        """
        problems: list[str] = []
        mineral_ids = {m["id"] for m in self.minerals}

        for facility in self.facilities:
            props = facility["properties"]
            for mid in props["mineral_ids"]:
                if mid not in mineral_ids:
                    problems.append(f"facility {props['id']}: unknown mineral {mid!r}")
            if props["country_iso3"] not in self.countries:
                problems.append(
                    f"facility {props['id']}: country {props['country_iso3']} "
                    "missing from countries.json"
                )

        for flow in self.flows:
            if flow["mineral_id"] not in mineral_ids:
                problems.append(f"flow {flow['id']}: unknown mineral {flow['mineral_id']!r}")
            for iso3 in (flow["from_iso3"], flow["to_iso3"]):
                if iso3 not in self.countries:
                    problems.append(
                        f"flow {flow['id']}: country {iso3} missing from countries.json"
                    )

        for price in self.prices:
            if price["mineral_id"] not in mineral_ids:
                problems.append(f"price: unknown mineral {price['mineral_id']!r}")

        if problems:
            raise DataValidationError(
                "(references between files)", problems[:20], {"problems_found": len(problems)}
            )


def write_json(path: Path, payload: Any) -> int:
    """Write pretty, newline-terminated JSON and report the bytes written.

    Indented rather than minified because these files are committed and every
    refresh opens a pull request: a readable diff is the point.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    # newline="" so the bytes come out the same on Windows and Linux. Without it
    # the same run writes CRLF on one and LF on the other, and CI compares them.
    with path.open("w", encoding="utf-8", newline="") as handle:
        handle.write(text)
    return len(text.encode("utf-8"))


def write_dataset(dataset: Dataset, output_dir: Path = OUTPUT_DIR) -> dict[str, int]:
    dataset.validate()
    return {
        "minerals.json": write_json(output_dir / "minerals.json", dataset.minerals),
        "facilities.geojson": write_json(
            output_dir / "facilities.geojson", dataset.as_feature_collection()
        ),
        "flows.json": write_json(output_dir / "flows.json", dataset.flows),
        "prices.json": write_json(output_dir / "prices.json", dataset.prices),
        "countries.json": write_json(output_dir / "countries.json", dataset.countries),
        "meta.json": write_json(output_dir / "meta.json", dataset.meta),
    }


def today() -> date:
    return date.today()
