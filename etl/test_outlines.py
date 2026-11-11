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


def main() -> int:
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            print("\n" + name)
            fn()
    print(f"\n{len(FAILURES)} failures")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    raise SystemExit(main())
