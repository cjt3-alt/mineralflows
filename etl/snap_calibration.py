"""How far can the outline snap be trusted? A calibration against mines whose position is known.

`outlines.snap_positions` moves a dot onto the nearest mining outline. That is safe when the
nearest outline is the mine's own and risky when a neighbour is nearer. To measure it, take the
mines whose reported point already sits inside an outline (their position is, in effect, known),
move each point away by a known distance in several directions, and ask the same question the
snap asks: which outline is nearest, and is it the one the point started in?

The answer is reported by the quantities the snap can actually observe (how far the nearest
outline is, and how much closer it is than the runner-up), not by the offset, which it cannot see.

Run:  python etl/snap_calibration.py --gpkg path/to/global_mining_polygons_v2.gpkg

Needs the raw GeoPackage (not committed). Standard library only. Slow (a few minutes).
"""

from __future__ import annotations

import argparse
import json
import math
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import outlines

OFFSETS_KM = (0.5, 1.0, 1.5, 2.0, 2.5, 3.0)
BEARINGS_DEG = (20, 110, 200, 290)  # not on the compass points, so no grid artefacts
MATCH_KM = outlines.MATCH_KM
PRELOAD_KM = 2 * MATCH_KM + 0.5  # an offset point can see MATCH_KM beyond an offset of MATCH_KM


def shifted(x: float, y: float, km: float, bearing_deg: float) -> tuple[float, float]:
    kx, ky = outlines.km_per_degree(y)
    b = math.radians(bearing_deg)
    return x + km * math.sin(b) / kx, y + km * math.cos(b) / ky


def bbox(parts: list[list[outlines.Ring]]) -> tuple[float, float, float, float]:
    xs = [p[0] for rings in parts for p in rings[0]]
    ys = [p[1] for rings in parts for p in rings[0]]
    return min(xs), min(ys), max(xs), max(ys)


def near_bbox(x: float, y: float, box: tuple[float, float, float, float], km: float) -> bool:
    kx, ky = outlines.km_per_degree(y)
    dx = max(box[0] - x, 0.0, x - box[2]) * kx
    dy = max(box[1] - y, 0.0, y - box[3]) * ky
    return math.hypot(dx, dy) <= km


def load_polygons(db: sqlite3.Connection, x: float, y: float) -> dict[int, dict]:
    pad = PRELOAD_KM / 80.0
    pad_x = pad / max(0.2, math.cos(math.radians(y)))
    rows = db.execute(
        "SELECT m.fid, m.geom FROM mining_polygons m "
        "JOIN rtree_mining_polygons_geom r ON r.id = m.fid "
        "WHERE r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?",
        (x - pad_x, x + pad_x, y - pad, y + pad),
    ).fetchall()
    out = {}
    for fid, blob in rows:
        parts = [
            [outlines.simplify(r, outlines.SIMPLIFY_DEG) for r in rings]
            for rings in outlines.read_polygons(blob)
        ]
        out[fid] = {"parts": parts, "box": bbox(parts)}
    return out


def edge_point(x: float, y: float, parts: list[list[outlines.Ring]]) -> tuple[float, float]:
    """The nearest point on any of the polygon's edges: where the snap would put the dot, give or
    take the few metres it steps inward."""
    kx, ky = outlines.km_per_degree(y)
    best = (math.inf, x, y)
    for rings in parts:
        for ring in rings:
            for i in range(len(ring) - 1):
                ax, ay = ring[i]
                bx, by = ring[i + 1]
                dx, dy = (bx - ax) * kx, (by - ay) * ky
                length2 = dx * dx + dy * dy
                t = 0.0
                if length2:
                    t = max(0.0, min(1.0, (((x - ax) * kx) * dx + ((y - ay) * ky) * dy) / length2))
                qx, qy = ax + t * (bx - ax), ay + t * (by - ay)
                d = math.hypot((x - qx) * kx, (y - qy) * ky)
                if d < best[0]:
                    best = (d, qx, qy)
    return best[1], best[2]


def candidates(x: float, y: float, polys: dict[int, dict]) -> list[tuple[float, int]]:
    """(distance km, polygon id) for polygons within MATCH_KM, nearest first."""
    found = []
    for pid, p in polys.items():
        if not near_bbox(x, y, p["box"], MATCH_KM):
            continue
        d = min(outlines.distance_to_polygon_km(x, y, rings) for rings in p["parts"])
        if d <= MATCH_KM:
            found.append((d, pid))
    return sorted(found)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--gpkg", required=True, type=Path)
    ap.add_argument("--out", type=Path, default=None, help="write the raw trials as JSON")
    args = ap.parse_args(argv)

    facilities = json.loads(outlines.FACILITIES.read_text(encoding="utf-8"))["features"]
    sites = {}
    for f in facilities:
        if f["properties"]["stage"] == "mine":
            sites[outlines.site_of(f["properties"]["id"])] = f["geometry"]["coordinates"]
    others = [(k, tuple(c)) for k, c in sites.items()]

    db = sqlite3.connect(f"file:{args.gpkg.as_posix()}?mode=ro", uri=True)
    trials = []
    used = 0
    for n, (site, (x, y)) in enumerate(sorted(sites.items())):
        polys = load_polygons(db, x, y)
        home = {
            pid
            for pid, p in polys.items()
            if any(outlines.point_in_polygon(x, y, rings) for rings in p["parts"])
        }
        if not home:
            continue  # only mines whose reported point is inside an outline
        used += 1
        # Which other sites would also claim each polygon (the snap refuses shared outlines).
        claim: dict[int, set[str]] = {}
        for pid, p in polys.items():
            claim[pid] = {
                o
                for o, (ox, oy) in others
                if o != site
                and near_bbox(ox, oy, p["box"], MATCH_KM)
                and min(outlines.distance_to_polygon_km(ox, oy, r) for r in p["parts"]) <= MATCH_KM
            }
        for off in OFFSETS_KM:
            for bearing in BEARINGS_DEG:
                px, py = shifted(x, y, off, bearing)
                c = candidates(px, py, polys)
                if not c:
                    trials.append({"offset": off, "found": False})
                    continue
                d1, p1 = c[0]
                d2 = c[1][0] if len(c) > 1 else None
                ex, ey = edge_point(px, py, polys[p1]["parts"])
                err = outlines.distance_km((ex, ey), (x, y))
                trials.append(
                    {
                        "offset": off,
                        "found": True,
                        "d": round(d1, 3),
                        "d2": None if d2 is None else round(d2, 3),
                        "n": len(c),
                        "correct": p1 in home,
                        "err": round(err, 3),
                        "claimed": bool(claim[p1]),
                    }
                )
        if n % 50 == 0:
            print(f"  {n}/{len(sites)} mines, {len(trials)} trials", flush=True)

    print(f"\n{used} mines with a known outline, {len(trials)} trials")
    if args.out:
        args.out.write_text(json.dumps(trials), encoding="utf-8")
    report(trials)
    return 0


def pct(part: int, whole: int) -> float:
    return part / whole * 100 if whole else float("nan")


def median(values: list[float]) -> float:
    values = sorted(values)
    return values[len(values) // 2] if values else float("nan")


def summarise(label: str, rows: list[dict]) -> None:
    """Did the snap bring the dot closer to the mine than it started?"""
    better = sum(1 for t in rows if t["err"] < t["offset"] - 0.05)
    worse = sum(1 for t in rows if t["err"] > t["offset"] + 0.25)
    near = sum(1 for t in rows if t["err"] <= 1.0)
    print(
        f"{label:<22}{len(rows):>6}  start {median([t['offset'] for t in rows]):>4.1f} km"
        f" -> {median([t['err'] for t in rows]):>4.1f} km   "
        f"closer {pct(better, len(rows)):>5.1f}%  worse {pct(worse, len(rows)):>5.1f}%"
        f"  within 1 km {pct(near, len(rows)):>5.1f}%"
    )


def report(trials: list[dict]) -> None:
    found = [t for t in trials if t["found"]]
    print(f"nearest outline found within {MATCH_KM:g} km in {len(found)}/{len(trials)} trials")
    print("\nSnapping to the nearest outline, by how far that outline is from the reported point")
    print("(median distance to the true position, before and after; unclaimed outlines only):")
    free = [t for t in found if not t["claimed"]]
    for lo, hi in ((0, 0.5), (0.5, 1), (1, 1.5), (1.5, 2), (2, 3.01)):
        summarise(f"outline {lo:g}-{hi:g} km away", [t for t in free if lo <= t["d"] < hi])
    print("\nBy whether a second outline is also close (runner-up distance / nearest distance):")
    for lo, hi in ((1, 1.5), (1.5, 2), (2, 4), (4, 1e9)):
        rows = [
            t for t in free if t["d2"] is not None and t["d"] > 0 and lo <= t["d2"] / t["d"] < hi
        ]
        summarise(f"ratio {lo:g}-{hi if hi < 1e9 else 'inf'}", rows)
    summarise("only one outline", [t for t in free if t["d2"] is None])
    print("\nBy the true offset (what the snap cannot see):")
    for off in OFFSETS_KM:
        summarise(f"offset {off:g} km", [t for t in free if t["offset"] == off])


if __name__ == "__main__":
    raise SystemExit(main())
