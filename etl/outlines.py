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

POSITIONS = ROOT / "public" / "data" / "site_positions.json"
REVIEWED = ROOT / "etl" / "reviewed_positions.json"

MATCH_KM = 3.0
SNAP_MAX_KM = 3.0  # a dot is only moved onto an outline this close; further out is a doubtful match
# Between SNAP_CLEAR_KM and SNAP_MAX_KM a snap is allowed only when the outline is clearly the
# nearest (the runner-up at least SNAP_RATIO times farther, or none within reach) and it is flagged
# `far_snap`: the calibration only covers offsets up to 3 km and is optimistic for a lone outline.
SNAP_CLEAR_KM = 2.0
# The nearest outline must be this many times closer than the runner-up, or it may be the wrong
# mine. Calibrated in etl/snap_calibration.py: at 2 the snap lands on the right outline in 99% of
# trials; below 1.5 it is closer to a coin flip.
SNAP_RATIO = 2.0
# A close call is still snapped when the outline is this near, and flagged. The nearest outline is
# then probably within a mine complex even when it is not the exact pit, and the dot ends up
# closer to the truth in 84 to 90% of calibration trials; the flag keeps it on the list to check.
CLOSE_CALL_MAX_KM = 2.0
# Mining outlines are pits, dumps and tailings; a smelter or refinery's buildings are often not
# inside one. Looking at 21 plant snaps on imagery, the 7 wrong ones had moved the plant 0.87 to
# 1.9 km onto a tailings outline and the 13 good ones 0.8 km or less, so plants snap only short.
PLANT_SNAP_MAX_KM = 0.8
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


# ------------------------------------------------------------------ snapping


def interior_point(rings: list[Ring]) -> tuple[float, float]:
    """A point well inside a polygon: the spot furthest from every edge, found by a coarse grid
    search that is refined twice. Always inside the polygon (a centroid can fall outside a
    crescent), and the same answer on every run."""
    xs = [p[0] for p in rings[0]]
    ys = [p[1] for p in rings[0]]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    best: tuple[float, float, float] | None = None  # clearance, x, y
    steps = 24
    for _ in range(3):
        for i in range(steps + 1):
            for j in range(steps + 1):
                x = x0 + (x1 - x0) * i / steps
                y = y0 + (y1 - y0) * j / steps
                if not point_in_polygon(x, y, rings):
                    continue
                clearance = min(distance_to_ring_km(x, y, r) for r in rings)
                if best is None or clearance > best[0]:
                    best = (clearance, x, y)
        if best is None:
            break
        # Search again in a window around the best cell.
        wx, wy = (x1 - x0) / steps * 1.5, (y1 - y0) / steps * 1.5
        x0, x1, y0, y1 = best[1] - wx, best[1] + wx, best[2] - wy, best[2] + wy
    if best is None:  # a sliver too thin for the grid: fall back to a ring vertex
        return rings[0][0]
    return best[1], best[2]


def nearest_inside_point(x: float, y: float, rings: list[Ring]) -> tuple[float, float]:
    """The smallest move that puts (x, y) inside the polygon: the nearest point on its edge,
    stepped inward just far enough that it is not sitting on the line."""
    kx, ky = km_per_degree(y)
    best = (math.inf, x, y)
    for ring in rings:
        for i in range(len(ring) - 1):
            ax, ay = ring[i]
            bx, by = ring[i + 1]
            dx, dy = (bx - ax) * kx, (by - ay) * ky
            length2 = dx * dx + dy * dy
            t = (
                0.0
                if length2 == 0
                else max(0.0, min(1.0, (((x - ax) * kx) * dx + ((y - ay) * ky) * dy) / length2))
            )
            qx, qy = ax + t * (bx - ax), ay + t * (by - ay)
            d = math.hypot((x - qx) * kx, (y - qy) * ky)
            if d < best[0]:
                best = (d, qx, qy)
    _, qx, qy = best
    cx, cy = interior_point(rings)
    # Step inward from the edge point toward the polygon's interior by a few tens of metres, then
    # a little more if that is still on the line. The step is an absolute distance: a fraction of
    # the way to the middle of a large outline would be kilometres.
    dx, dy = (cx - qx) * kx, (cy - qy) * ky
    length = math.hypot(dx, dy)
    if length > 0:
        for step_km in (0.02, 0.05, 0.1, 0.2, 0.4):
            t = min(1.0, step_km / length)
            px, py = qx + (cx - qx) * t, qy + (cy - qy) * t
            if point_in_polygon(px, py, rings):
                return px, py
    # No small step inward lands inside (a thin or ragged outline): stay on the nearest edge rather
    # than jump to a distant interior point, so a snap never moves farther than the outline is.
    return qx, qy


def _parts(geometry: dict) -> list[list[Ring]]:
    return [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]


def site_of(facility_id: str) -> str:
    """The physical site behind a facility id: ids end in the stage (`icmm.icmm00056.mine`), and
    the records for one site's stages share everything before it."""
    return facility_id.rsplit(".", 1)[0]


def snap_positions(facilities: list[dict], outline_features: list[dict]) -> dict:
    """Where each facility's dot should sit so it is on the outline it was matched to.

    Only facilities whose reported point is outside every outline matched to them are moved, to
    an interior point of the nearest outline, and only when that is a clean match: the outline is
    within `SNAP_MAX_KM` and no other site claims it (two dots snapped to one outline would
    stack). Everything else is listed under `review` with the reason, and left where it was.
    Facilities already inside an outline are not touched.
    """
    coords = {f["properties"]["id"]: tuple(f["geometry"]["coordinates"]) for f in facilities}
    by_id = {f["properties"]["id"]: f for f in facilities}
    candidates: dict[str, list[tuple[float, dict, list[list[Ring]]]]] = {}
    for feature in outline_features:
        parts = _parts(feature["geometry"])
        for fid in feature["properties"]["facility_ids"]:
            if fid not in coords:
                continue
            x, y = coords[fid]
            d = min(distance_to_polygon_km(x, y, rings) for rings in parts)
            candidates.setdefault(fid, []).append((d, feature, parts))

    positions: dict[str, dict] = {}
    review: dict[str, str] = {}
    for fid, options in sorted(candidates.items()):
        options.sort(key=lambda o: o[0])
        d, feature, parts = options[0]
        if d == 0.0:
            continue
        if d > SNAP_MAX_KM:
            review[fid] = f"nearest outline is {d:.1f} km away"
            continue
        is_plant = by_id[fid]["properties"].get("stage") in ("process", "refine")
        if is_plant and d > PLANT_SNAP_MAX_KM:
            review[fid] = f"plant: nearest mining outline is {d:.1f} km away"
            continue
        close_call = len(options) > 1 and options[1][0] < SNAP_RATIO * d
        if close_call and d > CLOSE_CALL_MAX_KM:
            review[fid] = (
                f"another outline is nearly as close ({d:.1f} km and {options[1][0]:.1f} km)"
            )
            continue
        if len({site_of(x) for x in feature["properties"]["facility_ids"]}) > 1:
            review[fid] = "nearest outline is shared with another site"
            continue
        # Of the polygon's parts, the one the dot is nearest to.
        near = min(parts, key=lambda rings: distance_to_polygon_km(*coords[fid], rings))
        x, y = nearest_inside_point(*coords[fid], near)
        positions[fid] = {
            "lng": round(x, 5),
            "lat": round(y, 5),
            "from": [round(coords[fid][0], 5), round(coords[fid][1], 5)],
            "moved_km": round(distance_km(coords[fid], (x, y)), 2),
            "outline_id": feature["properties"]["id"],
            "method": "snapped_to_outline",
            **({"close_call": True, "runner_up_km": round(options[1][0], 2)} if close_call else {}),
            **({"far_snap": True} if d > SNAP_CLEAR_KM else {}),
        }
    return {
        "note": (
            "Dot positions moved onto the mining outline each site was matched to. "
            "`from` is the position the source reported; a position is only applied while the "
            "facility still reports that point. Sites listed in `review` were left where they were."
        ),
        "max_snap_km": SNAP_MAX_KM,
        "positions": positions,
        "review": review,
        "hidden": {},
        "doubtful": {},
        "verified": {},
    }


def merge_reviewed(
    snapped: dict,
    reviewed: dict,
    facilities: list[dict],
) -> dict:
    """Overlay hand-reviewed positions (`etl/reviewed_positions.json`) on the outline snaps.

    A reviewed position wins over a snap, and takes the site off the review list. It applies only
    while the facility still reports the point it was reviewed at, so a refreshed source cannot
    leave a stale correction behind.
    """
    coords = {f["properties"]["id"]: f["geometry"]["coordinates"] for f in facilities}
    for fid, entry in reviewed.get("reviewed", {}).items():
        here = coords.get(fid)
        if (
            here is None
            or abs(here[0] - entry["from"][0]) > 1e-4
            or abs(here[1] - entry["from"][1]) > 1e-4
        ):
            continue
        snapped["positions"][fid] = {
            "lng": entry["lng"],
            "lat": entry["lat"],
            "from": entry["from"],
            "moved_km": round(distance_km(tuple(here), (entry["lng"], entry["lat"])), 2),
            "method": entry["method"],
            "source": entry["source"],
            **({"source_url": entry["source_url"]} if entry.get("source_url") else {}),
        }
        snapped["review"].pop(fid, None)
    for fid, check in reviewed.get("outline_checks", {}).get("records", {}).items():
        here = coords.get(fid)
        if here is None or abs(here[0] - check["from"][0]) > 1e-4:
            continue
        if abs(here[1] - check["from"][1]) > 1e-4:
            continue
        if check["decision"] == "unresolved" and fid in snapped["review"]:
            snapped["review"][fid] = f"unresolved after review: {check['note']}"
            continue
        moved = snapped["positions"].get(fid)
        if moved is None or moved["method"] != "snapped_to_outline":
            continue
        if check["decision"] == "confirmed" and moved.get("close_call"):
            moved.pop("close_call")
            moved.pop("runner_up_km", None)
            moved["checked"] = True
        elif check["decision"] == "reverted":
            del snapped["positions"][fid]
            snapped["review"][fid] = (
                "checked on imagery: the reported point is on the plant, "
                "and the nearest outline is not it"
            )
    snapped["doubtful"] = {}
    for fid, entry in reviewed.get("doubtful_positions", {}).get("records", {}).items():
        here = coords.get(fid)
        if here is None or abs(here[0] - entry["from"][0]) > 1e-4:
            continue
        if abs(here[1] - entry["from"][1]) > 1e-4:
            continue
        snapped["doubtful"][fid] = {"reason": entry["reason"]}
    snapped["verified"] = {}
    for fid, entry in reviewed.get("verified_in_place", {}).get("records", {}).items():
        here = coords.get(fid)
        if here is None or abs(here[0] - entry["from"][0]) > 1e-4:
            continue
        if abs(here[1] - entry["from"][1]) > 1e-4:
            continue
        snapped["verified"][fid] = {"note": entry["note"]}
        snapped["review"].pop(fid, None)
        snapped["doubtful"].pop(fid, None)
    for fid in list(snapped["doubtful"]):
        if fid in snapped["positions"]:  # placed since it was flagged
            del snapped["doubtful"][fid]
    names = {f["properties"]["id"]: f["properties"].get("name") for f in facilities}
    snapped["hidden"] = {
        fid: {
            "name": entry["name"],
            "duplicate_of": entry["duplicate_of"],
            "reason": entry["reason"],
        }
        for fid, entry in reviewed.get("duplicates", {}).get("records", {}).items()
        if names.get(fid) == entry["name"]
    }
    for fid in snapped["hidden"]:
        snapped["positions"].pop(fid, None)
        snapped["review"].pop(fid, None)
    return snapped


def distance_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    kx, ky = km_per_degree((a[1] + b[1]) / 2)
    return math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * ky)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument(
        "--gpkg", type=Path, help="global_mining_polygons_v2.gpkg (omit to only re-snap)"
    )
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--positions", type=Path, default=POSITIONS)
    args = ap.parse_args(argv)

    facilities = json.loads(FACILITIES.read_text(encoding="utf-8"))["features"]
    if args.gpkg:
        result = match(args.gpkg, facilities)
        args.out.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
        matched = {fid for f in result["features"] for fid in f["properties"]["facility_ids"]}
        size = args.out.stat().st_size
        print(
            f"{len(result['features'])} outlines for {len(matched)} of "
            f"{len(facilities)} facilities; {args.out.name} is {size / 1000:.0f} kB"
        )
    else:
        result = json.loads(args.out.read_text(encoding="utf-8"))

    snapped = snap_positions(facilities, result["features"])
    if REVIEWED.exists():
        snapped = merge_reviewed(
            snapped, json.loads(REVIEWED.read_text(encoding="utf-8")), facilities
        )
    args.positions.write_text(json.dumps(snapped, separators=(",", ":")), encoding="utf-8")
    print(
        f"{len(snapped['positions'])} dots moved, "
        f"{len(snapped.get('hidden', {}))} duplicates hidden, "
        f"{len(snapped.get('doubtful', {}))} positions flagged doubtful, "
        f"{len(snapped.get('verified', {}))} verified in place, "
        f"{len(snapped['review'])} left for review; {args.positions.name}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
