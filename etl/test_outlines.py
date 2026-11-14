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


def test_snap_never_overshoots() -> None:
    # A thin sliver: a step inward from its edge may not land inside it. The dot must still end
    # within about the outline's distance of where it started, not at a far interior point.
    sliver = [(0.0, 0.0), (0.2, 0.0), (0.2, 0.00001), (0.0, 0.00001), (0.0, 0.0)]
    x, y = 0.1, 0.01  # about 1.1 km north of the sliver
    nx, ny = outlines.nearest_inside_point(x, y, [sliver])
    check("a sliver does not send the dot far away", outlines.distance_km((x, y), (nx, ny)) < 1.5)


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
    check(
        "snapped dot is inside the outline",
        outlines.point_in_polygon(moved["near"]["lng"], moved["near"]["lat"], [square]),
    )
    check("the reported position is kept", moved["near"]["from"] == [0.101, 0.05])
    check("the move is small", moved["near"]["moved_km"] < 1.0, str(moved["near"]["moved_km"]))
    check("a distant outline is not trusted", "far" in review and "far" not in moved)
    check(
        "a shared outline is not snapped",
        "a" in review and "b" in review and not ({"a", "b"} & moved.keys()),
    )


def test_sibling_stages_are_one_site() -> None:
    check("site_of drops the stage", outlines.site_of("icmm.icmm00056.mine") == "icmm.icmm00056")
    square = [(0.0, 0.0), (0.1, 0.0), (0.1, 0.1), (0.0, 0.1), (0.0, 0.0)]
    facilities = [
        _facility("icmm.icmm1.mine", 0.101, 0.05),
        _facility("icmm.icmm1.process", 0.101, 0.05),
    ]
    out = outlines.snap_positions(
        facilities, [_outline(1, square, [f["properties"]["id"] for f in facilities])]
    )
    check(
        "a mine and its plant record both snap",
        set(out["positions"]) == {f["properties"]["id"] for f in facilities},
    )
    check("to the same spot", len({(v["lng"], v["lat"]) for v in out["positions"].values()}) == 1)
    other = [_facility("icmm.icmm1.mine", 0.101, 0.05), _facility("icmm.icmm2.mine", 0.102, 0.05)]
    out = outlines.snap_positions(
        other, [_outline(2, square, [f["properties"]["id"] for f in other])]
    )
    check("two different sites still conflict", out["positions"] == {} and len(out["review"]) == 2)


def test_ambiguous_nearest_outline_is_not_trusted() -> None:
    # A dot between two outlines: about 2.1 km from the first, 2.2 km from the second (a close
    # call beyond the 2 km limit), or from the first and a distant third (a clear winner).
    first = [(0.0, 0.0), (0.01, 0.0), (0.01, 0.01), (0.0, 0.01), (0.0, 0.0)]
    second = [(0.0487, 0.0), (0.0587, 0.0), (0.0587, 0.01), (0.0487, 0.01), (0.0487, 0.0)]
    third = [(0.12, 0.0), (0.13, 0.0), (0.13, 0.01), (0.12, 0.01), (0.12, 0.0)]
    facility = [_facility("a.mine", 0.0289, 0.005)]
    close_call = outlines.snap_positions(
        facility, [_outline(1, first, ["a.mine"]), _outline(2, second, ["a.mine"])]
    )
    check("a close second outline beyond 2 km sends it to review", "a.mine" in close_call["review"])
    clear = outlines.snap_positions(
        facility, [_outline(1, first, ["a.mine"]), _outline(3, third, ["a.mine"])]
    )
    check("a clear winner is snapped", "a.mine" in clear["positions"])
    check("and flagged far, beyond 2 km", clear["positions"]["a.mine"].get("far_snap") is True)
    check("and not a close call", "close_call" not in clear["positions"]["a.mine"])
    # Nearer an outline (0.3 km) with a second one 0.4 km away: snapped, but flagged.
    tight = [_facility("b.mine", 0.0125, 0.005)]
    other = [(0.0165, 0.0), (0.0265, 0.0), (0.0265, 0.01), (0.0165, 0.01), (0.0165, 0.0)]
    flagged = outlines.snap_positions(
        tight, [_outline(1, first, ["b.mine"]), _outline(2, other, ["b.mine"])]
    )
    check("a near close call is snapped", "b.mine" in flagged["positions"])
    check("and flagged", flagged["positions"].get("b.mine", {}).get("close_call") is True)
    check("and not far", "far_snap" not in flagged["positions"]["b.mine"])


def test_plants_snap_only_short() -> None:
    # 0.0108 degrees east of the edge is about 0.09 km; 0.019 is about 1.0 km.
    square = [(0.0, 0.0), (0.01, 0.0), (0.01, 0.01), (0.0, 0.01), (0.0, 0.0)]

    def site(fid: str, stage: str, x: float) -> dict:
        return {
            "properties": {"id": fid, "stage": stage},
            "geometry": {"type": "Point", "coordinates": [x, 0.005]},
        }

    near_plant = site("a.process", "process", 0.0108)
    far_plant = site("b.refine", "refine", 0.019)
    far_mine = site("c.mine", "mine", 0.019)
    for f in (near_plant, far_plant, far_mine):
        out = outlines.snap_positions([f], [_outline(1, square, [f["properties"]["id"]])])
        fid = f["properties"]["id"]
        if f is near_plant:
            check("a plant just off an outline snaps", fid in out["positions"])
        elif f is far_plant:
            check("a plant 1 km off does not", fid in out["review"] and fid not in out["positions"])
            check("and says why", out["review"][fid].startswith("plant:"))
        else:
            check("a mine 1 km off still snaps", fid in out["positions"])


def test_merge_reviewed() -> None:
    facilities = [_facility("p", 10.0, 20.0), _facility("q", 30.0, 40.0)]
    snapped = {"positions": {"p": {"method": "snapped_to_outline"}}, "review": {"p": "x", "q": "y"}}
    entry = {
        "lng": 10.05,
        "lat": 20.0,
        "from": [10.0, 20.0],
        "method": "published_coordinates",
        "source": "s",
        "source_url": "u",
    }
    stale = {**entry, "from": [31.0, 40.0]}
    out = outlines.merge_reviewed(snapped, {"reviewed": {"p": entry, "q": stale}}, facilities)
    check(
        "a reviewed position replaces a snap",
        out["positions"]["p"]["method"] == "published_coordinates",
    )
    check("it records the source", out["positions"]["p"]["source"] == "s")
    check(
        "the move is measured",
        4.0 < out["positions"]["p"]["moved_km"] < 6.0,
        str(out["positions"]["p"]["moved_km"]),
    )
    check("it leaves the review list", "p" not in out["review"])
    check("a stale review is ignored", "q" not in out["positions"] and "q" in out["review"])
    named = [
        {
            "properties": {"id": "d", "name": "Dup"},
            "geometry": {"type": "Point", "coordinates": [1.0, 2.0]},
        }
    ]
    dup = {"duplicates": {"records": {"d": {"name": "Dup", "duplicate_of": "x", "reason": "r"}}}}
    out = outlines.merge_reviewed(
        {"positions": {"d": {}}, "review": {"d": "z"}, "hidden": {}}, dup, named
    )
    check(
        "a duplicate is hidden", "d" in out["hidden"] and out["hidden"]["d"]["duplicate_of"] == "x"
    )
    check(
        "a hidden record is not also moved or reviewed",
        "d" not in out["positions"] and "d" not in out["review"],
    )
    renamed = {
        "duplicates": {"records": {"d": {"name": "Other", "duplicate_of": "x", "reason": "r"}}}
    }
    out = outlines.merge_reviewed({"positions": {}, "review": {}, "hidden": {}}, renamed, named)
    check("a renamed record is not hidden", out["hidden"] == {})


def test_outline_checks() -> None:
    facilities = [
        _facility("a.mine", 1.0, 2.0),
        _facility("b.process", 3.0, 4.0),
        _facility("c.mine", 5.0, 6.0),
    ]
    close = {"method": "snapped_to_outline", "close_call": True, "runner_up_km": 0.5}
    snapped = {
        "positions": {"a.mine": dict(close), "b.process": dict(close), "c.mine": dict(close)},
        "review": {},
        "hidden": {},
    }
    checks = {
        "a.mine": {"decision": "confirmed", "from": [1.0, 2.0]},
        "b.process": {"decision": "reverted", "from": [3.0, 4.0]},
        "c.mine": {"decision": "confirmed", "from": [9.0, 9.0]},  # the source has since moved it
    }
    out = outlines.merge_reviewed(snapped, {"outline_checks": {"records": checks}}, facilities)
    check("a confirmed snap loses its flag", "close_call" not in out["positions"]["a.mine"])
    check("and is marked checked", out["positions"]["a.mine"].get("checked") is True)
    check(
        "a reverted snap goes back to review",
        "b.process" not in out["positions"] and "b.process" in out["review"],
    )
    check("a stale check is ignored", out["positions"]["c.mine"].get("close_call") is True)


def test_doubtful_positions() -> None:
    facilities = [_facility("a.process", 1.0, 2.0), _facility("b.process", 3.0, 4.0)]
    snapped = {"positions": {}, "review": {}, "hidden": {}}
    doubtful = {
        "a.process": {"name": "A", "from": [1.0, 2.0], "reason": "in a town"},
        "b.process": {"name": "B", "from": [9.0, 9.0], "reason": "stale"},  # source has moved it
    }
    out = outlines.merge_reviewed(
        snapped, {"doubtful_positions": {"records": doubtful}}, facilities
    )
    check("a doubtful position is carried", out["doubtful"]["a.process"]["reason"] == "in a town")
    check("a stale one is dropped", "b.process" not in out["doubtful"])
    check("the dot is not moved", out["positions"] == {})


def test_placed_verified_and_unresolved() -> None:
    facilities = [_facility(f"{i}.process", float(i), float(i) + 1.0) for i in (1, 2, 3, 4)]
    snapped = {
        "positions": {},
        "review": {"1.process": "x", "2.process": "y", "3.process": "z", "4.process": "w"},
        "hidden": {},
    }
    reviewed = {
        "reviewed": {
            "1.process": {
                "lng": 1.01,
                "lat": 2.0,
                "from": [1.0, 2.0],
                "method": "placed_on_imagery",
                "source": "the works",
            }
        },
        "verified_in_place": {
            "records": {"2.process": {"from": [2.0, 3.0], "note": "on the plant"}}
        },
        "outline_checks": {
            "records": {
                "3.process": {"decision": "unresolved", "from": [3.0, 4.0], "note": "unclear"}
            }
        },
        "doubtful_positions": {
            "records": {"2.process": {"name": "n", "from": [2.0, 3.0], "reason": "stale flag"}}
        },
    }
    out = outlines.merge_reviewed(snapped, reviewed, facilities)
    placed = out["positions"]["1.process"]
    check("a hand-placed dot has its method and source", placed["method"] == "placed_on_imagery")
    check("without a source url", "source_url" not in placed)
    check("and its original point", placed["from"] == [1.0, 2.0])
    check("a verified site is recorded", out["verified"]["2.process"]["note"] == "on the plant")
    check("and is no longer doubtful", "2.process" not in out["doubtful"])
    check(
        "an unresolved site keeps its place in review with the reason",
        out["review"]["3.process"].startswith("unresolved after review"),
    )
    check(
        "a placed or verified site leaves review",
        "1.process" not in out["review"] and "2.process" not in out["review"],
    )
    check("an untouched site stays in review", "4.process" in out["review"])
    final = set(out["positions"]) | set(out["verified"])
    check("no site is both in review and in a final state", not (final & set(out["review"])))


def main() -> int:
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            print("\n" + name)
            fn()
    print(f"\n{len(FAILURES)} failures")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    raise SystemExit(main())
