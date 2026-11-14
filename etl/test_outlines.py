"""Tests for the mine-outline geometry. Run with `python etl/test_outlines.py`.

No network and no raw GeoPackage needed: these pin the small pieces of geometry where a slip
(a flipped hole test, a degrees-for-kilometres mix-up) would quietly attach the wrong outline
to a mine.
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import outlines

FAILURES: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(("  ok   " if ok else "  FAIL ") + name + ("" if ok else f"  {detail}"))
    if not ok:
        FAILURES.append(name)


SQUARE = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0), (0.0, 0.0)]
HOLE = [(0.4, 0.4), (0.6, 0.4), (0.6, 0.6), (0.4, 0.6), (0.4, 0.4)]


def test_point_in_polygon() -> None:
    check("inside", outlines.point_in_polygon(0.2, 0.2, [SQUARE]))
    check("outside", not outlines.point_in_polygon(1.5, 0.5, [SQUARE]))
    check("a hole is not inside", not outlines.point_in_polygon(0.5, 0.5, [SQUARE, HOLE]))
    check("beside a hole is inside", outlines.point_in_polygon(0.2, 0.5, [SQUARE, HOLE]))


def test_distance() -> None:
    check("zero inside", outlines.distance_to_polygon_km(0.5, 0.5, [SQUARE]) == 0.0)
    # 0.1 degrees of longitude east of the edge at the equator is about 11.1 km.
    d = outlines.distance_to_polygon_km(1.1, 0.5, [SQUARE])
    check("a tenth of a degree is about 11 km", 10.9 < d < 11.3, str(d))
    # At 60 degrees north a degree of longitude is about half as long.
    ring = [(10.0, 60.0), (11.0, 60.0), (11.0, 61.0), (10.0, 61.0), (10.0, 60.0)]
    d = outlines.distance_to_polygon_km(11.1, 60.5, [ring])
    check("longitude shrinks with latitude", 5.0 < d < 6.5, str(d))


def test_simplify() -> None:
    # A straight edge with a tiny wobble collapses; a real corner survives.
    ring = [(0, 0), (0.5, 0.00001), (1, 0), (1, 1), (0, 1), (0, 0)]
    out = outlines.simplify([(float(a), float(b)) for a, b in ring], 0.0002)
    check("the wobble goes", (0.5, 0.00001) not in out)
    check("corners stay", (1.0, 1.0) in out and (0.0, 1.0) in out)
    check("stays closed", out[0] == out[-1])


def test_area() -> None:
    a = outlines.area_km2([SQUARE])
    check("one degree square at the equator is about 12,300 km2", 12000 < a < 12500, str(a))
    check("a hole is taken off", outlines.area_km2([SQUARE, HOLE]) < a)


def test_read_polygons() -> None:
    wkb = struct.pack("<BII", 1, 3, 1) + struct.pack("<I", 5)
    for x, y in SQUARE:
        wkb += struct.pack("<dd", x, y)
    envelope = struct.pack("<4d", 0, 1, 0, 1)
    blob = b"GP" + bytes([0, 3]) + struct.pack("<i", 4326) + envelope + wkb
    polys = outlines.read_polygons(blob)
    check("one polygon, one ring", len(polys) == 1 and len(polys[0]) == 1)
    check("coordinates read back", polys[0][0][2] == (1.0, 1.0))


def _facility(fid: str, x: float, y: float) -> dict:
    return {"properties": {"id": fid}, "geometry": {"type": "Point", "coordinates": [x, y]}}


def _outline(oid: int, ring: list, ids: list[str]) -> dict:
    return {
        "geometry": {"type": "Polygon", "coordinates": [ring]},
        "properties": {"id": oid, "facility_ids": ids},
    }


def test_nearest_inside_point() -> None:
    x, y = outlines.nearest_inside_point(1.01, 0.5, [SQUARE])
    check("lands inside", outlines.point_in_polygon(x, y, [SQUARE]))
    check("a small miss is a small move", outlines.distance_km((1.01, 0.5), (x, y)) < 5.0)
    # With a hole in the way the point still ends up on solid ground.
    x, y = outlines.nearest_inside_point(0.5, 0.45, [SQUARE, HOLE])
    check("not left in the hole", outlines.point_in_polygon(x, y, [SQUARE, HOLE]))


def test_snap_positions() -> None:
    # 0.001 degrees is about 110 m: a dot just outside a one-degree outline.
    square = [(0.0, 0.0), (0.1, 0.0), (0.1, 0.1), (0.0, 0.1), (0.0, 0.0)]
    facilities = [
        _facility("inside", 0.05, 0.05),
        _facility("near", 0.101, 0.05),
        _facility("far", 0.2, 0.05),
        _facility("a", 0.2995, 0.305),
        _facility("b", 0.3105, 0.305),
    ]
    shared = [(0.3, 0.3), (0.31, 0.3), (0.31, 0.31), (0.3, 0.31), (0.3, 0.3)]
    features = [
        _outline(1, square, ["inside"]),
        _outline(3, square, ["near"]),
        _outline(4, square, ["far"]),
        _outline(2, shared, ["a", "b"]),
    ]
    out = outlines.snap_positions(facilities, features)
    moved, review = out["positions"], out["review"]
    check("a dot already inside is left alone", "inside" not in moved and "inside" not in review)
    check("a near miss is snapped", "near" in moved)
    check("snapped dot is inside the outline", outlines.point_in_polygon(moved["near"]["lng"], moved["near"]["lat"], [square]))
    check("the reported position is kept", moved["near"]["from"] == [0.101, 0.05])
    check("the move is small", moved["near"]["moved_km"] < 1.0, str(moved["near"]["moved_km"]))
    check("a distant outline is not trusted", "far" in review and "far" not in moved)
    check("a shared outline is not snapped", "a" in review and "b" in review and not ({"a", "b"} & moved.keys()))


def test_merge_reviewed() -> None:
    facilities = [_facility("p", 10.0, 20.0), _facility("q", 30.0, 40.0)]
    snapped = {"positions": {"p": {"method": "snapped_to_outline"}}, "review": {"p": "x", "q": "y"}}
    entry = {"lng": 10.05, "lat": 20.0, "from": [10.0, 20.0], "method": "published_coordinates", "source": "s", "source_url": "u"}
    stale = {**entry, "from": [31.0, 40.0]}
    out = outlines.merge_reviewed(snapped, {"reviewed": {"p": entry, "q": stale}}, facilities)
    check("a reviewed position replaces a snap", out["positions"]["p"]["method"] == "published_coordinates")
    check("it records the source", out["positions"]["p"]["source"] == "s")
    check("the move is measured", 4.0 < out["positions"]["p"]["moved_km"] < 6.0, str(out["positions"]["p"]["moved_km"]))
    check("it leaves the review list", "p" not in out["review"])
    check("a stale review is ignored", "q" not in out["positions"] and "q" in out["review"])
    named = [{"properties": {"id": "d", "name": "Dup"}, "geometry": {"type": "Point", "coordinates": [1.0, 2.0]}}]
    dup = {"duplicates": {"records": {"d": {"name": "Dup", "duplicate_of": "x", "reason": "r"}}}}
    out = outlines.merge_reviewed({"positions": {"d": {}}, "review": {"d": "z"}, "hidden": {}}, dup, named)
    check("a duplicate is hidden", "d" in out["hidden"] and out["hidden"]["d"]["duplicate_of"] == "x")
    check("a hidden record is not also moved or reviewed", "d" not in out["positions"] and "d" not in out["review"])
    renamed = {"duplicates": {"records": {"d": {"name": "Other", "duplicate_of": "x", "reason": "r"}}}}
    out = outlines.merge_reviewed({"positions": {}, "review": {}, "hidden": {}}, renamed, named)
    check("a renamed record is not hidden", out["hidden"] == {})


def main() -> int:
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            print("\n" + name)
            fn()
    print(f"\n{len(FAILURES)} failures")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    raise SystemExit(main())
