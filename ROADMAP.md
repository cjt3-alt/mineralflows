# MineralFlows roadmap

What to build next, and why. The direction (set 10 November 2026): MineralFlows is a map people can
wander in, closer to Google Maps than a slide deck. Anything that gives someone another reason to
zoom, click or scrub belongs here. See `HANDOFF.md` section 0e for what exists today.

Ground rules that still apply: source and cite every figure (never hard-code from memory), label
estimates as estimates, and keep to `DESIGN.md`.

## A. Make uncertainty part of the product

Most mines have no public capacity or output figure, and 551 of our 1,229 sites are low confidence.
Instead of hiding that, show it, and where a defensible estimate can be made, make one and say how.

1. **A "how well do we know this?" layer.** Every site gets a visible tier:
   - **Reported:** a figure from the operator's own filing, with a link.
   - **Estimated:** modelled by us, shown as a range, with the method one click away.
   - **Unknown:** drawn as unknown, not left blank.
   A map lens (or filter) that colours sites by tier makes the gaps themselves something to explore.
2. **Estimates, honestly built.** Candidate method: take a country's published mine output (USGS,
   already in `production.json`) and spread it across that country's mines in proportion to a proxy
   (open-pit area from the mining polygons in B1, plus operator and known filings), then check the
   total still equals the published figure. Output is a range with the assumptions listed, never a
   single confident number. Reported figures always override the model.
3. **Where the model and the filings disagree** is itself a finding worth surfacing.
4. Needs a short methods write-up in the Sources dialog and tests that pin the shape of the model
   (totals reconcile, reported beats estimated), as `chokepoint.test.ts` does for the shares.

## B. Data to add, roughly in priority order

| # | Data | What it adds | Where from (to verify before use) |
| --- | --- | --- | --- |
| B1 | **Mine outlines** (done, November 2026: `etl/outlines.py`, 902 of 1,229 sites matched) | Real pit and footprint shapes on the satellite view, and a size proxy for A2 | Maus et al. global mining areas (*Scientific Data* 2020 and its update), about 45,000 polygons, open licence; match to our mines |
| B2 | **Production history** (done to 2020: `etl/history.py`; deeper years still open) | A year slider: China's refining share over time | USGS Mineral Commodity Summaries back-issues, BGS World Mineral Statistics, World Mining Data |
| B3 | **Site capacity and detail** for the top 40 to 60 mines, smelters and refineries | Output, grade, reserves, mine life, opening year, owner | Company technical reports: SEC EDGAR (S-K 1300), SEDAR+ (NI 43-101); ICSG for smelter and refinery capacity (also fills the smelting gap); Wikidata for operators and dates |
| B4 | **Tailings dams** | A striking, visible layer | Global Tailings Portal (GRID-Arendal) |
| B5 | **Ports** | Routes drawn port to port, not capital to capital | NGA World Port Index, Natural Earth |
| B6 | **Imagery history** | Watch a pit grow | Esri Wayback archive of World Imagery |
| B7 | **Trade history** | Time slider on routes | CEPII BACI, or UN Comtrade (needs `COMTRADE_KEY`, see `etl/AUTOMATION.md`) |
| B8 | **Price history** (done, 2000 to 2025: `etl/price_history.py`) | Price beside the timeline | World Bank Pink Sheet monthly series |
| B9 | **Risk lens** | A fourth lens: where supply is exposed | OECD export-restriction inventory, World Bank governance indicators, ACLED (licence permitting), EITI |
| B10 | **Environment and people** | Water stress, protected areas, forest loss near mines | WRI Aqueduct, WDPA, Global Forest Watch |
| B11 | **Demand and recycling** | Where the metal goes, and how much comes back | IEA critical minerals outlook (already in the pipeline), International Copper Association, scrap trade (HS 7404) |

B3 is slow, hand-curated work: do the biggest sites first and record the source for each figure.

## C. Experience

- **Curated tours** for "Take me somewhere": the biggest pits, the largest smelter, one route end to
  end, each with a sourced caption.
- **A second mineral** (cobalt and rare earths need a refinery table that is not USGS; the IEA outlook
  is the likely source). The lenses, panels and search are already mineral-generic.
- **Basemap detail:** town and road names, or a vector basemap.

## D. Carried over from earlier handoffs

Social card image (`public/og.png`), a custom wordmark, a light method page, tablet-width check, axe
pass, real-device touch testing, and a performance look on a slow phone.

## Suggested first slice

B1 (mine outlines) and B2 (production history) together, then A1 (the knowledge-tier layer) on top of
what we already have. That gives a visible, explorable result before the slower B3 work starts.
