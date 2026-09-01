"""World Bank country list — arc endpoints for `countries.json`.

Flows are country-to-country while facilities are point-level, so every arc needs
one representative coordinate per country. This is the only source that runs
before the country-name resolver is built, because it is what the resolver is
built from.

**These are capital-city coordinates, not polygon centroids.** The World Bank
country API returns the latitude and longitude of each country's capital. For a
country-to-country trade arc that is a defensible representative point and it has
the large advantage of being an official, versioned, no-auth list rather than a
hand-picked one. It does mean Australia's arcs land on Canberra rather than in
the middle of the continent. That is recorded here, in `meta.json`, and in the
README, because a coordinate that looks like a centroid and is not is exactly the
kind of thing that should not be quiet.
"""

from __future__ import annotations

from datetime import date

import requests

from sources.base import AUTO, ExtractContext, SourceResult, skipped

SOURCE_ID = "worldbank-countries"
KIND = AUTO

API_URL = "https://api.worldbank.org/v2/country"
DOC_URL = "https://datahelpdesk.worldbank.org/knowledgebase/articles/898590-country-api-queries"
NAME = "World Bank country API"
TIMEOUT = 60


def extract(ctx: ExtractContext) -> SourceResult:
    coverage = (
        "Capital-city coordinates used as country-level arc endpoints, plus the canonical "
        "country names the ETL matches source spellings against. Not polygon centroids."
    )
    if ctx.offline:
        return skipped(SOURCE_ID, NAME, DOC_URL, "current", coverage, "--offline was set")

    try:
        response = requests.get(
            API_URL, params={"format": "json", "per_page": 400}, timeout=TIMEOUT
        )
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        return skipped(
            SOURCE_ID, NAME, DOC_URL, "current", coverage, f"could not reach the API: {exc}"
        )

    if not isinstance(payload, list) or len(payload) < 2:
        return skipped(
            SOURCE_ID, NAME, DOC_URL, "current", coverage, "the API returned an unexpected shape"
        )

    countries: dict[str, dict] = {}
    warnings: list[str] = []
    no_coords: list[str] = []

    for row in payload[1]:
        # Aggregates (income groups, regions) carry region id "NA". They are not
        # places and must never become an arc endpoint.
        if row.get("region", {}).get("id") == "NA":
            continue
        iso3 = row.get("id")
        lat, lon = row.get("latitude"), row.get("longitude")
        if not iso3 or lat in (None, "") or lon in (None, ""):
            if iso3:
                no_coords.append(iso3)
            continue
        countries[iso3] = {"name": row["name"], "lat": float(lat), "lon": float(lon)}

    if no_coords:
        warnings.append(
            f"{len(no_coords)} countries have no coordinates in the API and were dropped: "
            + ", ".join(sorted(no_coords))
        )

    return SourceResult(
        source_id=SOURCE_ID,
        name=NAME,
        url=DOC_URL,
        vintage="current",
        retrieved_at=date.today(),
        coverage=f"{len(countries)} countries. " + coverage,
        countries=countries,
        warnings=warnings,
    )
