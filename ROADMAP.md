# MineralFlows roadmap

What to build next, and why. The direction (set 10 November 2026): MineralFlows is a map people can
wander in, closer to Google Maps than a slide deck. Anything that gives someone another reason to
zoom, click or scrub belongs here. See `HANDOFF.md` section 0e for what exists today.

Ground rules that still apply: source and cite every figure (never hard-code from memory), label
estimates as estimates, and keep to `DESIGN.md`.

## Notes for CJ, written the night of 14 November 2026

**Where things stand.** The map is live with mine footprints, a year slider, price history and, new
today, a position layer: 238 dots snapped onto their mining outline, 9 placed by hand or from
published coordinates, 38 verified on a plant, 18 flagged "position may be wrong", 4 duplicate records
hidden, and 35 sites left as reported. Nothing is half-built or unmerged (PRs 5 to 11). `HANDOFF.md`
section 0f is the full account: rules, numbers, what each card says, and what was tried.

**The next thing to build, and why it is ready.** Section A below (the "how well do we know this?"
layer) is now the obvious next step. Every site already carries a tier in `site_positions.json`:
plain snap, checked, close call, far snap, verified, doubtful, or reported. What remains is the map
lens or filter that colours by tier, the method page, and (optionally) modelled output estimates.
Still untouched: capacity or output figures (no site has one), which the footprint areas could feed.

**Honest limits to keep in mind**
- The far and wider close-call snaps rest on a calibration that keeps the true mine within 3 km, so it
  is optimistic. The plant cap of 0.8 km is tuned on 21 sites.
- 18 doubtful sites and 35 review sites need coordinates that only company reports or national
  registers hold.
- Phones get no year slider; tablet width, axe, slow-phone performance and real touch were never tested.

**Decisions that are yours**
- Whether the next month leans on rigour (the uncertainty layer, sourced captions) or wander-ability
  (tours, before and after imagery), as below.
- Whether to keep going on copper until it is excellent, or add cobalt to show the pattern generalises.

(The notes from 10 November follow; the ideas in them still stand.)

## Notes for CJ, written the night of 10 November 2026

**Where things stand.** Live on the site: the explorable map (three lenses, guided opening, satellite
imagery, search, "Take me somewhere"), mine footprints on 902 sites, a 2020 to 2025 year slider, and
copper price history. Nothing is half-built or uncommitted. The monthly data refresh is working again.

**Small things I know about and did not fix**
- No year slider or lens summary on phones (they get a one-line summary only). A bottom sheet with the
  slider would fix it.
- Not checked: real-device touch, tablet width, axe accessibility pass, performance on a slow phone,
  and the intro's pacing at real frame rates (my test browser pauses animation, so I judged flights from
  state, not by watching).
- The selected site's outline highlight (champagne) is subtle against satellite imagery. Worth a look.
- Esri's tile servers are a third party. Fine for now, credited on the map; if they ever block us the
  swap is one source in `ExploreMap.tsx`.
- 551 sites are low confidence and none has a capacity figure. (Position accuracy was worked on on
  14 November: see `HANDOFF.md` 0f. Capacity is still the biggest gap.)
- `outlines.geojson` is 952 kB and loads after the map appears. If it ever feels slow, split it by
  region and load only what is on screen.

**Where I think we can go deeper (my picks, most interesting first)**

1. **The "how well do we know this?" layer plus honest estimates (section A).** Your instinct about the
   uncertainty is the most distinctive idea here: almost every map in this space hides what it does not
   know. A lens that colours sites reported, estimated or unknown, with a method page, is something
   specialists would find credible and nobody else has. Mine footprints are now the size proxy to
   estimate output from. Start with a clean method write-up and one country (Chile, where the data is
   best) before doing all of them, and always let a company-reported figure override the model.
2. **A "this mine, over time" view.** Esri's Wayback archive has older imagery, and we have a footprint
   for each mine. A before/after slider on a pit (2014 against now) is exactly the Street View feeling:
   you watch a hole in the desert grow. Footprint area measured on old imagery would be new data we
   could publish. Check the Wayback terms first.
3. **Tell the story of a single mine or route end to end.** Pick Escondida and Chuquicamata: show the
   pit, the concentrator, the port it ships from, the smelter it reaches, with a sourced caption at each
   stop and the map flying between them. Curated tours (section C) are cheap once ports (B5) are in
   and make good shareable moments for your portfolio.
4. **Ports and real routes.** Draw trade routes port to port instead of capital to capital, then add
   shipping distance. It makes the trade lens feel physical, and Chile to China becomes a visible
   Pacific crossing.
5. **Another dimension of concentration.** The company layer: how much of the world's copper sits
   under a handful of operators (Codelco, BHP, Freeport and so on), and which countries own the
   operators. We have operator names for 1,000 of the 1,229 sites. Ownership is a different chokepoint
   from geography and a very "critical minerals" question.
6. **A second mineral, probably cobalt.** DR Congo at roughly three quarters of mine output and China
   refining most of it is the other famous chokepoint, and the lenses already work for it. It needs a
   refinery table that is not USGS (IEA is the likely source).
7. **Risk lens.** Export restrictions, governance scores and conflict near sites, as a fourth button.
   Interesting, but check data licences first (ACLED needs one).

**Smaller ideas worth trying**
- A "compare two countries" mode (Chile against China across mined, refined and trade).
- Sound-free polish: a subtle intro for first-time visitors on how to use the map ("drag, scroll,
  click") that stays out of the way, and keyboard shortcuts for the three lenses (1, 2, 3).
- Shareable views: the URL already holds the lens and country; add year and map position so a link can
  open on a specific mine in satellite.
- A social card image for link previews (needs Pillow, ask first), and a light method page.

**Questions that are yours to decide**
- Is the audience hiring managers and specialists (then lean on rigour: the uncertainty layer, sourced
  captions) or the curious public (then lean on wander-ability: tours, before and after imagery)?
  Both work, but they pull the next month in different directions.
- Whether to keep going on copper alone until it is excellent, or add cobalt soon to show the pattern
  generalises.

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
| B1 | **Mine outlines** (done, November 2026: `etl/outlines.py`, 902 of 1,229 sites matched; dots snapped onto them, see `HANDOFF.md` 0f) | Real pit and footprint shapes on the satellite view, and a size proxy for A2 | Maus et al. global mining areas (*Scientific Data* 2020 and its update), about 45,000 polygons, open licence; match to our mines |
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
