"""One module per source, all satisfying the interface in `base.py`.

Order matters in exactly one place: `worldbank_countries` runs first, because it
is what the country-name resolver every other source needs is built from.
Everything after that is independent and could run in any order.
"""

from sources import (
    comtrade,
    icmm_mining,
    iea_critical_minerals,
    ticm_trade,
    usgs_nmic,
    worldbank_countries,
    worldbank_pinksheet,
)

#: Runs before the resolver exists. It supplies the names the resolver matches on.
CENTROID_SOURCE = worldbank_countries

#: Everything else, in the order their skip lines read best in the run log.
SOURCES = [
    worldbank_pinksheet,
    usgs_nmic,
    icmm_mining,
    ticm_trade,
    iea_critical_minerals,
    comtrade,
]

__all__ = ["CENTROID_SOURCE", "SOURCES"]
