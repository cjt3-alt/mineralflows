"""Turning the country names in raw sources into ISO 3166-1 alpha-3 codes.

Every source names countries differently. TiCM says "Korea, Republic of", ICMM
says "South Korea", the World Bank says "Korea, Rep.". Flows and facilities are
keyed on ISO3, so one resolver reconciles them all.

The rule is: match on a punctuation-insensitive form of the name, fall back to
an explicit alias table, and otherwise **refuse to guess**. An unresolved name
is counted and reported, never fuzzy-matched into the nearest neighbour. A trade
flow attributed to the wrong country is worse than a missing one.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from contract import ETL_ROOT

ALIAS_FILE = ETL_ROOT / "config" / "country_aliases.json"
EXTRA_FILE = ETL_ROOT / "config" / "extra_countries.json"


def normalise(name: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace.

    This alone resolves most names: "Cote d'Ivoire" and "Cote D Ivoire" agree,
    and so do "Congo, Dem. Rep." and "Congo Dem Rep".
    """
    text = str(name).lower().strip().replace("&", " and ")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


@dataclass
class CountryResolver:
    """Name to ISO3, plus the record of everything it could not resolve."""

    by_name: dict[str, str] = field(default_factory=dict)
    aggregates: set[str] = field(default_factory=set)
    unresolved: Counter = field(default_factory=Counter)

    def resolve(self, name: str | None) -> str | None:
        if name is None:
            return None
        key = normalise(name)
        if not key or key in self.aggregates:
            return None
        iso3 = self.by_name.get(key)
        if iso3 is None:
            self.unresolved[str(name).strip()] += 1
        return iso3

    def is_aggregate(self, name: str | None) -> bool:
        """True for "World", "European Union" and friends.

        These are roll-up rows that sit alongside real partners in every TiCM
        file. Summing them with the countries they contain would double the
        total, so they are dropped before anything else happens.
        """
        return name is not None and normalise(name) in self.aggregates

    def report(self, limit: int = 12) -> str:
        if not self.unresolved:
            return "every country name in the sources resolved to an ISO3 code"
        total = sum(self.unresolved.values())
        top = ", ".join(f"{n} ({c})" for n, c in self.unresolved.most_common(limit))
        return (
            f"{len(self.unresolved)} country names did not resolve, "
            f"covering {total} rows, all dropped: {top}"
        )


def load_config() -> tuple[dict[str, str], set[str], list[dict]]:
    aliases_raw = json.loads(ALIAS_FILE.read_text(encoding="utf-8"))
    extras_raw = json.loads(EXTRA_FILE.read_text(encoding="utf-8"))
    aliases = {normalise(k): v for k, v in aliases_raw["aliases"].items()}
    aggregates = {normalise(a) for a in aliases_raw["aggregates"]}
    return aliases, aggregates, extras_raw["countries"]


def build_resolver(countries: dict[str, dict]) -> CountryResolver:
    """Build a resolver over the countries the pipeline actually has centroids for.

    Names come from three places, in order of precedence: the alias table wins,
    then the canonical name of each country in `countries`, then nothing. A name
    that resolves to an ISO3 with no centroid is treated as unresolved, because
    an arc endpoint that does not exist is not usable.
    """
    aliases, aggregates, _ = load_config()
    by_name: dict[str, str] = {}

    for iso3, country in countries.items():
        by_name[normalise(country["name"])] = iso3
        # The bare ISO3 is a legitimate spelling in some extracts.
        by_name[normalise(iso3)] = iso3

    for name, iso3 in aliases.items():
        if iso3 in countries:
            by_name[name] = iso3

    return CountryResolver(by_name=by_name, aggregates=aggregates)


def extra_countries() -> dict[str, dict]:
    """Hand-added entries for places no country list covers. See the config file."""
    _, _, extras = load_config()
    return {c["iso3"]: {"name": c["name"], "lat": c["lat"], "lon": c["lon"]} for c in extras}


def config_paths() -> list[Path]:
    return [ALIAS_FILE, EXTRA_FILE]
