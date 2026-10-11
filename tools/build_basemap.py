"""Build the map's terrain base layers into public/basemap/.

Run once, by hand, whenever the look or the sources change:

    python tools/build_basemap.py

Writes three files the app fetches lazily:

  relief.webp   Shaded relief of land and sea floor, tinted to the app's palette,
                in Web Mercator (the map's own projection), longitude -180..180,
                cropped to the map's latitudes. Built from the open Terrain
                Tiles on AWS (Mapzen/Tilezen; sources include SRTM, GMTED2010
                and ETOPO1), zoom 4, so 4096 px per world.
  plates.json   Tectonic plate boundaries, PB2002 (Bird, 2003), from the
                fraxen/tectonicplates GeoJSON (ODC-BY 1.0), coordinates rounded.
  ranges.json   Named mountain ranges from Natural Earth's physical regions
                (public domain), as label points.

Needs numpy and Pillow; neither is a runtime dependency of the app or the ETL.
"""

from __future__ import annotations

import http.client
import io
import json
import math
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "public" / "basemap"
ZOOM = 4
TILE = 256
LAT_TOP = 80.0
LAT_BOTTOM = -58.0
TILES_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
PLATES_URL = "https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_boundaries.json"
REGIONS_URL = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"
    "ne_50m_geography_regions_polys.geojson"
)


def fetch(url: str, attempts: int = 4) -> bytes:
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                return response.read()
        except (OSError, http.client.HTTPException):
            if attempt == attempts - 1:
                raise
            time.sleep(2**attempt)
    raise AssertionError("unreachable")


def mercator_row(lat: float, size: int) -> int:
    phi = math.radians(lat)
    return round((1 - math.log(math.tan(math.pi / 4 + phi / 2)) / math.pi) / 2 * size)


def elevation() -> np.ndarray:
    n = 2**ZOOM
    size = n * TILE

    def tile(xy: tuple[int, int]) -> tuple[int, int, np.ndarray]:
        x, y = xy
        img = Image.open(io.BytesIO(fetch(TILES_URL.format(z=ZOOM, x=x, y=y)))).convert(
            "RGB"
        )
        a = np.asarray(img, dtype=np.float32)
        return x, y, a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768

    grid = np.zeros((size, size), dtype=np.float32)
    jobs = [(x, y) for x in range(n) for y in range(n)]
    with ThreadPoolExecutor(max_workers=16) as pool:
        for x, y, e in pool.map(tile, jobs):
            grid[y * TILE : (y + 1) * TILE, x * TILE : (x + 1) * TILE] = e
    return grid


def shade(e: np.ndarray, top: int) -> np.ndarray:
    """Hillshade with a light from the north-west, corrected for Mercator scale."""
    size = e.shape[1]
    rows = np.arange(e.shape[0]) + top
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (rows + 0.5) / size))))
    metres = 2 * np.pi * 6_378_137 * np.cos(np.radians(lat)) / size
    dy, dx = np.gradient(e)
    dx = dx / metres[:, None]
    dy = dy / metres[:, None]
    # World-scale relief is subtle at one pixel per ~10 km; exaggerate it.
    z = 18.0
    slope = np.arctan(z * np.hypot(dx, dy))
    aspect = np.arctan2(-dx, dy)
    azimuth = math.radians(315)
    altitude = math.radians(40)
    hs = np.sin(altitude) * np.cos(slope) + np.cos(altitude) * np.sin(slope) * np.cos(
        azimuth - aspect
    )
    return np.clip(hs, 0, 1)


def colourise(e: np.ndarray, hs: np.ndarray) -> np.ndarray:
    """The app's palette: deep navy sea, cool slate land, relief in the light."""
    land = e > 0
    out = np.zeros(e.shape + (3,), dtype=np.float32)

    # Sea: darker with depth, with the sea floor's own relief kept faint.
    depth = np.clip(-e / 6000, 0, 1)[..., None]
    shallow = np.array([12, 26, 40], dtype=np.float32)
    deep = np.array([4, 9, 16], dtype=np.float32)
    sea = shallow * (1 - depth) + deep * depth
    sea = sea * (0.82 + 0.36 * hs[..., None])

    # Land: slate that lifts toward a cool steel with height, lit by the shade.
    # Height lifts the colour only gently, so high plateaus and ice sheets
    # (Tibet, Greenland) do not outshine the data drawn on top.
    height = np.clip(e / 5000, 0, 1)[..., None] ** 0.8
    low = np.array([19, 33, 47], dtype=np.float32)
    high = np.array([58, 82, 106], dtype=np.float32)
    ground = low * (1 - height) + high * height
    # Strong light/shadow contrast, so ranges read at world scale while flat
    # land (hillshade ~0.64) stays close to the base colour.
    ground = ground * (0.3 + 1.15 * hs[..., None])

    out = np.where(land[..., None], ground, sea)
    return np.clip(out, 0, 255).astype(np.uint8)


def rounded(coords, places: int = 2):
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], places), round(coords[1], places)]
    return [rounded(c, places) for c in coords]


def plates() -> dict:
    data = json.loads(fetch(PLATES_URL))
    features = [
        {
            "type": "Feature",
            "properties": {},
            "geometry": {
                **f["geometry"],
                "coordinates": rounded(f["geometry"]["coordinates"]),
            },
        }
        for f in data["features"]
    ]
    return {"type": "FeatureCollection", "features": features}


def centroid(ring: list[list[float]]) -> tuple[float, float, float]:
    """Area-weighted centroid of a ring, and its area (shoelace)."""
    a = cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
        cross = x0 * y1 - x1 * y0
        a += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    if abs(a) < 1e-12:
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        return sum(xs) / len(xs), sum(ys) / len(ys), 0.0
    return cx / (3 * a), cy / (3 * a), abs(a) / 2


def ranges() -> list[dict]:
    """Named mountain ranges, labelled at the centroid of their largest part."""
    data = json.loads(fetch(REGIONS_URL))
    out = []
    for f in data["features"]:
        p = f["properties"]
        if p.get("FEATURECLA") != "Range/mtn" or not p.get("NAME"):
            continue
        g = f["geometry"]
        polygons = (
            g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        )
        x, y, _ = max((centroid(poly[0]) for poly in polygons), key=lambda c: c[2])
        out.append(
            {
                "name": p["NAME"].title().replace("Mts.", "Mts"),
                "rank": int(p.get("SCALERANK") or 9),
                "lng": round(x, 2),
                "lat": round(y, 2),
            }
        )
    out.sort(key=lambda r: r["rank"])
    return out


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    size = 2**ZOOM * TILE
    top = mercator_row(LAT_TOP, size)
    bottom = mercator_row(LAT_BOTTOM, size)

    print("fetching elevation tiles...", file=sys.stderr)
    e = elevation()[top:bottom]
    rgb = colourise(e, shade(e, top))
    Image.fromarray(rgb).save(OUT / "relief.webp", quality=80, method=6)
    print(f"relief.webp {rgb.shape[1]}x{rgb.shape[0]}", file=sys.stderr)

    (OUT / "plates.json").write_text(json.dumps(plates(), separators=(",", ":")))
    (OUT / "ranges.json").write_text(json.dumps(ranges(), separators=(",", ":")))
    for name in ("relief.webp", "plates.json", "ranges.json"):
        print(name, (OUT / name).stat().st_size, file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
