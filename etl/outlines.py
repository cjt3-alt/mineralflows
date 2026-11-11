"""Mine outlines: the ground a mine actually covers, matched to our facilities.

Source: Maus, V. et al. (2022), "Global-scale mining polygons (Version 2)", PANGAEA,
https://doi.org/10.1594/PANGAEA.942325. 44,929 polygons of land used by mining (open cuts,
tailings dams, waste rock dumps, water ponds, processing infrastructure), drawn by eye on
Sentinel-2 imagery. Licence: CC BY-SA 4.0, so the derived file written here carries the same
licence and the credit must stay with it (see `LICENCE_NOTE`).

The polygons are not copper-specific and carry no mine names. We keep a polygon only when one of
our facilities sits inside it or within `MATCH_KM` of its edge, and record which facilities, so
the map can draw a pit's real footprint under its marker. That is a spatial match, not a
statement that the polygon is that mine: the site card says so.

Run:  python etl/outlines.py --gpkg path/to/global_mining_polygons_v2.gpkg

The raw GeoPackage (24 MB) is not committed. Standard library only.
"""

from __future__ import annotations

import argparse
import json
import math
import sqlite3
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FACILITIES = ROOT / "public" / "data" / "facilities.geojson"
OUT = ROOT / "public" / "data" / "outlines.geojson"

MATCH_KM = 3.0
SIMPLIFY_DEG = 0.0002  # about 20 m
DECIMALS = 4  # about 11 m

SOURCE = {
    "name": "Global-scale mining polygons (Version 2)",
    "authors": (
        "Maus, V., da Silva, D.M., Gutschlhofer, J., da Rosa, R., Giljum, S., "
        "Gass, S.L.B., Luckeneder, S., Lieber, M., McCallum, I."
    ),
    "year": 2022,
    "url": "https://doi.org/10.1594/PANGAEA.942325",
    "licence": "CC BY-SA 4.0",
    "licence_url": "https://creativecommons.org/licenses/by-sa/4.0/",
}
LICENCE_NOTE = (
    "Derived from Maus et al. (2022), CC BY-SA 4.0. Polygons are simplified to about 20 m "
    f"and filtered to those within {MATCH_KM:.0f} km of a facility in this dataset."
)

Ring = list[tuple[float, float]]


# ----------------------------------------------------------------- geometry


def read_polygons(blob: bytes) -> list[list[Ring]]:
    """Polygons (each a list of rings, outer first) from a GeoPackage geometry blob."""
    if blob[:2] != b"GP":
        raise ValueError("not a GeoPackage geometry")
    flags = blob[3]
    envelope_size = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[(flags >> 1) & 7]
    return _read_wkb(blob, 8 + envelope_size)[0]


def _read_wkb(buf: bytes, pos: int) -> tuple[list[list[Ring]], int]:
    order = "<" if buf[pos] == 1 else ">"
    (kind,) = struct.unpack_from(order + "I", buf, pos + 1)
    pos += 5
    if kind == 3:
        (n_rings,) = struct.unpack_from(order + "I", buf, pos)
        pos += 4
        rings: list[Ring] = []
        for _ in range(n_rings):
            (n,) = struct.unpack_from(order + "I", buf, pos)
            pos += 4
            coords = struct.unpack_from(f"{order}{2 * n}d", buf, pos)
            pos += 16 * n
            rings.append(list(zip(coords[0::2], coords[1::2], strict=True)))
        return [rings], pos
    if kind == 6:
        (n,) = struct.unpack_from(order + "I", buf, pos)
        pos += 4
        out: list[list[Ring]] = []
        for _ in range(n):
            polys, pos = _read_wkb(buf, pos)
            out.extend(polys)
        return out, pos
    raise ValueError(f"unsupported geometry type {kind}")


def km_per_degree(lat: float) -> tuple[float, float]:
    """Kilometres per degree of longitude and of latitude at this latitude."""
    return 111.320 * math.cos(math.radians(lat)), 110.574


def point_in_ring(x: float, y: float, ring: Ring) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def point_in_polygon(x: float, y: float, rings: list[Ring]) -> bool:
    """Inside the outer ring and not inside a hole."""
    if not rings or not point_in_ring(x, y, rings[0]):
        return False
    return not any(point_in_ring(x, y, hole) for hole in rings[1:])


def distance_to_ring_km(x: float, y: float, ring: Ring) -> float:
    """Shortest distance from a point to a ring's edge, in kilometres."""
    kx, ky = km_per_degree(y)
    best = math.inf
    px, py = x * kx, y * ky
    for i in range(len(ring) - 1):
        ax, ay = ring[i][0] * kx, ring[i][1] * ky
        bx, by = ring[i + 1][0] * kx, ring[i + 1][1] * ky
        dx, dy = bx - ax, by - ay
        length2 = dx * dx + dy * dy
        t = 0.0 if length2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length2))
        best = min(best, math.hypot(px - (ax + t * dx), py - (ay + t * dy)))
    return best


def distance_to_polygon_km(x: float, y: float, rings: list[Ring]) -> float:
    """Zero inside the polygon, otherwise the distance to its nearest edge."""
    if point_in_polygon(x, y, rings):
        return 0.0
    return min(distance_to_ring_km(x, y, r) for r in rings)


def simplify(ring: Ring, tolerance: float) -> Ring:
    """Douglas-Peucker on a closed ring, keeping it closed and at least a triangle."""
    if len(ring) <= 4:
        return ring
    open_ring = ring[:-1] if ring[0] == ring[-1] else ring
    keep = [False] * len(open_ring)
    keep[0] = keep[-1] = True
    stack = [(0, len(open_ring) - 1)]
    while stack:
        lo, hi = stack.pop()
        ax, ay = open_ring[lo]
        bx, by = open_ring[hi]
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy)
        far, far_i = -1.0, -1
        for i in range(lo + 1, hi):
            px, py = open_ring[i]
            d = (
                math.hypot(px - ax, py - ay)
                if length == 0
                else abs(dy * px - dx * py + bx * ay - by * ax) / length
            )
            if d > far:
                far, far_i = d, i
        if far > tolerance and far_i > 0:
            keep[far_i] = True
            stack.append((lo, far_i))
            stack.append((far_i, hi))
    out = [p for p, k in zip(open_ring, keep, strict=True) if k]
    if len(out) < 3:
        return ring
    return [*out, out[0]]


def area_km2(rings: list[Ring]) -> float:
    """Planar area of the outer ring less holes, in square kilometres."""

    def one(ring: Ring) -> float:
        lat = sum(p[1] for p in ring) / max(1, len(ring))
        kx, ky = km_per_degree(lat)
        s = 0.0
        for i in range(len(ring) - 1):
            s += ring[i][0] * kx * ring[i + 1][1] * ky - ring[i + 1][0] * kx * ring[i][1] * ky
        return abs(s) / 2

    return one(rings[0]) - sum(one(h) for h in rings[1:])


# ------------------------------------------------------------------ matching


def match(gpkg: Path, facilities: list[dict]) -> dict:
    """The outlines GeoJSON for `facilities` (GeoJSON features with Point geometry)."""
    db = sqlite3.connect(f"file:{gpkg.as_posix()}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    pad = MATCH_KM / 80.0  # degrees; generous, the exact test follows
    found: dict[int, dict] = {}

    for f in facilities:
        x, y = f["geometry"]["coordinates"]
        fid = f["properties"]["id"]
        pad_x = pad / max(0.2, math.cos(math.radians(y)))
        rows = db.execute(
            "SELECT m.fid, m.geom, m.ISO3_CODE FROM mining_polygons m "
            "JOIN rtree_mining_polygons_geom r ON r.id = m.fid "
            "WHERE r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?",
            (x - pad_x, x + pad_x, y - pad, y + pad),
        ).fetchall()
        for row in rows:
            polys = read_polygons(row["geom"])
            if min(distance_to_polygon_km(x, y, rings) for rings in polys) > MATCH_KM:
                continue
            entry = found.get(row["fid"])
            if entry is None:
                entry = found[row["fid"]] = {
                    "polys": polys,
                    "iso3": row["ISO3_CODE"],
                    "facilities": [],
                }
            entry["facilities"].append(fid)

    features = []
    for pid, entry in sorted(found.items()):
        polys = []
        for rings in entry["polys"]:
            out = []
            for ring in rings:
                s = simplify(ring, SIMPLIFY_DEG)
                out.append([[round(px, DECIMALS), round(py, DECIMALS)] for px, py in s])
            polys.append(out)
        geometry = (
            {"type": "Polygon", "coordinates": polys[0]}
            if len(polys) == 1
            else {"type": "MultiPolygon", "coordinates": polys}
        )
        area = sum(area_km2(r) for r in entry["polys"])
        features.append(
            {
                "type": "Feature",
                "geometry": geometry,
                "properties": {
                    "id": pid,
                    "iso3": entry["iso3"],
                    "area_km2": round(area, 3),
                    "facility_ids": sorted(set(entry["facilities"])),
                },
            }
        )
    return {
        "type": "FeatureCollection",
        "source": SOURCE,
        "note": LICENCE_NOTE,
        "features": features,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--gpkg", required=True, type=Path, help="global_mining_polygons_v2.gpkg")
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args(argv)

    facilities = json.loads(FACILITIES.read_text(encoding="utf-8"))["features"]
    result = match(args.gpkg, facilities)
    args.out.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
    matched = {fid for f in result["features"] for fid in f["properties"]["facility_ids"]}
    size = args.out.stat().st_size
    print(
        f"{len(result['features'])} outlines for {len(matched)} of {len(facilities)} facilities; "
        f"{args.out.name} is {size / 1000:.0f} kB"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
