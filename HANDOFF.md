# MineralFlows — where things stand

Written 1 September 2026, at the end of the build session that completed phases 4 and 5.
**Updated 13 September 2026** — see the section directly below for what changed since; the original
write-up follows it unchanged as a record of that first session, with two pointers added where its
numbers are now stale.

Repo: <https://github.com/cjt3-alt/mineralflows> (public)
Live: <https://cjt3-alt.github.io/mineralflows/>

---

## 0. Update, 13 September 2026 — copper-only, real data, and a rebuilt globe

Start here; this supersedes the counts in sections 3 and 6 below. Everything in this section is
committed on `main`, typechecked, linted, and passing all 67 tests.

### The scope call: copper only, for now

On the plan-vs-build tradeoff, the call was to **stop tracking all four minerals at once and scope
down to copper**, to get a real critique of the app on one commodity before re-expanding. This did
**not** simplify the app or the ETL — the architecture was already built so a mineral is a config
edit, not a code change — what it did was let us sidestep the two genuinely hard data problems
(rare earths' missing mine-stage HS code, and the shaky NdPr price-proxy) while judging the design.

**To bring a mineral back**: flip its `"active"` field to `true` in
[`etl/config/minerals.json`](etl/config/minerals.json) (lithium, cobalt, and rare earths are
currently `false`), then re-run `python etl/pipeline.py`. Nothing else changes — the frontend, the
filters, and the ETL merge logic all already key off that flag.

### Real ETL data is now what's committed, not the seed

`public/data/` is no longer the 30-facility seed set — a full pipeline run for copper was executed
and committed:

| | Before (seed) | Now (real, copper only) |
| --- | --- | --- |
| Facilities | 30 (all 4 minerals) | 1,229 |
| Flows | 28 | 500 extracted, top 300 drawn |
| Countries | 17 | 99 |
| Data payload | 38 kB | ~960 kB |

Sources: ICMM v1.5 (facilities), ADB-WTO TiCM 2024 (flows), World Bank Pink Sheet (price),
World Bank country API (centroids). Section 6 below, about shipping real data, is now moot — it's
done — but the reasoning in it about the ICMM-coverage caveat and the TiCM raw-file decision (repo
visibility) still applies and hasn't been acted on.

### New: a value-threshold slider

`Filters` gained `minValueUsd` ([derive.ts](src/data/derive.ts)), round-tripping through the URL
like the other filters. A new "Value" control in [FilterRail.tsx](src/components/FilterRail.tsx)
(both the desktop rail and the mobile strip) filters flows below a dollar threshold, scaled on the
same square-root curve arc width already uses so the slider isn't wasted on the bottom 1% of a
$1k–$21B range. Facility points are deliberately **not** filtered by it — a flow only records
origin/destination country, not which specific mine or refinery it moved through, so there's no
honest way to tie a dollar threshold to one dot.

One interaction worth knowing about: the value slider and the existing 300-arc render cap can fight
each other. If the threshold you pick still leaves more than 300 flows, the globe won't visibly
change at all until the threshold climbs past the value of the current 300th-ranked flow, because
the cap was already dropping everything below that. The "N of M" numbers in the filter rail and
legend update immediately regardless, so the feedback isn't silent — but the globe itself can lag
behind what the slider says.

### The globe was substantially rebuilt

This was the bulk of the session, done in response to live feedback while looking at the running
app, ending in a deliberate rebuild to match **criticalatlas.com**'s globe (a competitor/reference
site — its actual JS bundle was read to reverse-engineer the technique, not guessed from
screenshots). Full detail is in the git history and in [GlobeCanvas.tsx](src/components/GlobeCanvas.tsx)'s
own comments; the short version:

- **Country borders and arcs are no longer a globe.gl layer.** They're raw Three.js objects (a
  `LineSegments` for borders, one `TubeGeometry` mesh per arc) with hand-written shaders, added
  directly into `globe.scene()`. The reason: globe.gl's declarative layers only support depth-buffer
  occlusion for "hide the far side of the globe," which hard-clips at the horizon. The shaders
  instead compute per-fragment whether a point faces the camera (`dot(surfaceNormal, viewDirection)`)
  and fade alpha smoothly between a dim floor and full strength — so the far hemisphere fades
  gracefully at any rotation instead of snapping off.
- **Arcs stay copper-colored**, not the rainbow criticalatlas.com uses, per instruction. Each arc
  shader does a one-time "grow" reveal plus a continuously traveling brightness band (replacing the
  old two-layer base/pulse dash trick from earlier in the session with one shader doing both jobs).
  Low-confidence flows get a dashed look and no traveling band instead.
- **Facility points are untouched** — still globe.gl's own `pointsData`/`ringsData` layers, per
  instruction, including the low-confidence dimming and ring treatment from earlier in the session.
- **The mouse-following "spotlight" highlight** criticalatlas.com has was deliberately left out, per
  instruction.
- **Camera**: `OrbitControls.autoRotate` + `enableDamping` are now on, giving a slow continuous idle
  turn and a momentum coast after a drag — matching criticalatlas.com's feel without hand-rolling a
  physics loop. It pauses automatically whenever something is selected or keyboard navigation is
  active, so the globe doesn't carry what you're looking at out of view.
- **Clicking an arc now needs a hand-built `Raycaster`**, since arcs aren't a globe.gl layer
  globe.gl's own click handling doesn't see. Confirmed working, including correctly resolving to
  whichever arc is geometrically nearest when two overlap on screen.

### Rough edges and tuning knobs, if you pick this back up

- **Two overexposure bugs were found and fixed by eye, not by a formula.** Both the border shader and
  the arc shader initially blew out to solid white at full density, because turning off depth testing
  (needed for the smooth far-side fade) also means overlapping objects can no longer occlude each
  other — every border segment or arc behind another one in screen space stacks additively instead.
  The alpha constants (`BORDER_BASE_ALPHA`, `BORDER_FAR_FLOOR` and the arc shader's `baseAlpha`
  values, all in GlobeCanvas.tsx) are tuned for the current density (full country topology, up to 300
  arcs) — revisit them if the arc cap or the topology resolution ever changes materially.
  `BORDER_FAR_FLOOR` was lowered again (0.16 → 0.07) on 13 September after CJ found the far-side
  countries too visible; the same knob if it ever needs to go the other way.
- **`ARC_RADIUS_SCALE` (currently `1`) was originally wrong by ~100x** — tubes were being built with a
  sub-pixel radius and were invisible until this was caught by inspecting the live Three.js scene
  graph directly, not by looking at screenshots. If arcs ever look wrong again after a change near
  the tube-geometry code, check this first.
- **No hover tooltip on arcs anymore.** globe.gl used to give this for free; supporting it now would
  mean raycasting on every `pointermove`, which wasn't judged worth the per-frame cost for
  information the detail panel already shows on click. Click and keyboard nav both still work fully.
- **Facility points also got the same facing-based dim-near-the-edge treatment** on 13 September
  (CJ: "dim the dots on the far side too"), by patching globe.gl's own point materials to a small
  `ShaderMaterial` with the same formula, rather than replacing the points layer entirely. Real depth
  testing stays on, so the existing far-side hide (proven working — confirmed a genuinely far-side
  point renders at zero alpha) is untouched; this only adds a graceful fade for points that already
  pass that test but sit near the horizon, so they stop looking untouched next to lines that were
  already fading.

  **Getting this to actually run took a real bug fix, worth remembering if you patch globe.gl
  internals again.** A dependency-array `useEffect` keyed on `[points, ...]` looked reasonable but
  never fired once the globe was actually ready: `GlobeCanvas` only mounts after the dataset has
  already loaded, so `points` is populated on the very first render and never changes identity again
  — there is no later render where the effect's dependencies change to give it a second chance, and
  `globeRef.current` was still `undefined` on that first render. The fix was to stop depending on
  React's dependency array for this at all: the effect now polls every frame via
  `requestAnimationFrame`, checking whether the globe exists yet and applying the patch when it does.
  It's cheap to run forever afterward, since an already-patched material fails the "is this a plain
  MeshLambertMaterial" check immediately. The arc-mesh-building effect nearby looks similar but
  doesn't have this bug, because `arcs` is read the same way and would have the identical problem if
  its one-extra-`requestAnimationFrame` retry hadn't happened to land after the globe ref populated —
  worth switching that one to the same polling pattern if it ever misbehaves.
- **This session's own sandboxed browser preview could not show live animation at all** — it reports
  its tab as backgrounded to the page's Visibility API even when active, which throttles
  `requestAnimationFrame` (confirmed via direct GPU pixel-diffing: zero change across several
  seconds). Everything animated — the arc grow/band, the ring pulse, the camera auto-rotate — was
  verified by code review and by reading real values back out of the live Three.js scene, not by
  watching it move. Worth a real look in an actual focused browser tab.

### What I'd do next

**⚠ Before you next push to `main`: CI's ETL job will fail as-is.** It runs
`python etl/pipeline.py --offline --no-manual --check`, which compares the committed `public/data/`
against the offline/seed-fallback output — and now that `public/data/` is a full real run instead
(see the data section in README.md), that check fails on all five files, confirmed locally. Either
the check needs to validate against a full run instead, or it needs a documented reason to keep
comparing against the fallback path while the two are expected to diverge. Not yet reconciled.

0. **Keep iterating on how the arcs look.** CJ's read after the rebuild (13 September): better than
   before, but still not landed — no specifics on what's wrong yet, just that the look isn't there.
   Worth revisiting the tube radius scale, the traveling-band width/speed, and the base/highlight
   colour before adding anything new to the globe.
1. **Judge the copper-only result, then decide on re-expanding** to lithium/cobalt/rare earths — see
   the scope-call note above; it's a config edit away.
2. **The TiCM raw-file decision** (section 7, item 3 below) is now more pressing than it was — real
   trade data is shipping and shown, which was one of the three trigger conditions for stripping the
   raw extracts out of the repo.
3. **Re-tune the arc cap** (currently 300, in `derive.ts`) now that you're looking at a real 500-flow
   extract instead of the seed's 28 — see if 300 is still the right density judgement.
4. **Incorporate Mindat data** — flagged by CJ on 13 September as something to work on. Mindat is
   already named in section 8 below as a candidate for facility coverage beyond ICMM's
   member-reported large-scale operations, especially rare earths. No design work has started on
   this yet — it would need a new source module under `etl/sources/` (see `icmm_mining.py` for the
   shape one takes) and a look at Mindat's actual data access terms and format before anything else.

---

## 1. The short version

All six planned phases are built, committed, pushed, and deploying green. The app works, the data
contract holds, the ETL runs end to end against six real public sources, and both GitHub workflows
are live.

**The one thing that is not done is the thing that will most change how the app feels: the site is
still running on the 30-facility hand-authored seed dataset, not on real extracted data.** That was
deliberate, it is one workflow run away, and section 6 explains the choice and how to undo it.

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Repo, tooling, CI, Pages deploy | Complete |
| 1 | Data contract, schema validation, seed dataset, loader | Complete |
| 2 | Globe canvas: points, arcs, bloom, interaction | Complete |
| 3 | Dashboard shell: top bar, filter rail, detail panel, legend | Complete |
| 4 | ETL skeleton and refresh workflow | Complete |
| 5 | Polish: responsive, keyboard, reduced motion, states, README | Complete |

Health: 63 frontend tests, 48 ETL assertions, TypeScript, ESLint, Ruff check, Ruff format and the
production build all clean. Three CI jobs (`build`, `etl`, `deploy`) green on the latest push.
Roughly 6,200 lines of TypeScript and Python.

---

## 2. What was built this session

Five commits, on top of phases 0–3 which were already done.

| Commit | What it did |
| --- | --- |
| `27fc26b` | Phase 4 — ETL skeleton, six source modules, refresh workflow |
| `0b78d07` | Phase 5 — responsive layout, keyboard access to the globe, README rewrite |
| `02e0430` | Attribution: full source names in the legend, TiCM terms recorded |
| `d02a8c7` | CI fix — deterministic provenance dates, a working reproducibility check |
| `5a21280` | Recorded the TiCM raw-file decision and when to revisit it |

### Phase 4: the ETL

`etl/` reads six public sources through one uniform interface and writes the six files in
`public/data/` that the browser loads. No database, no service. It runs on a laptop or in a GitHub
Action.

| Source | Type | Writes | Note |
| --- | --- | --- | --- |
| World Bank country API | auto-fetch | `countries.json` | Capital-city coordinates as arc endpoints |
| World Bank Pink Sheet | auto-fetch | `prices.json` | Copper only — it carries nothing else we track |
| USGS Mineral Commodity Summaries | auto-fetch | `prices.json` | Prices for the other three, plus country production |
| ICMM Global Mining Dataset | manual drop | `facilities.geojson` | Geocoded sites with confidence ratings |
| ADB-WTO TiCM | manual drop | `flows.json` | Bilateral trade by HS code, 2024 |
| IEA Critical Minerals | manual drop | nothing | Mine-vs-refine supply, cross-check only |
| UN Comtrade | manual drop | nothing | Deliberately inert — needs a key a workflow cannot hold |

Auto sources fetch over the network and treat failure as a skip, not a crash. Manual sources read a
file a human dropped into `etl/raw/manual/<source>/`, and a missing file is the normal case. The
pipeline runs to a valid result with all of them absent.

**The design decision that mattered most**: seed data is a *fallback*, not a layer. When a real
source produces facilities or flows, the seed rows for that file are dropped whole rather than added
to — because the seed's Escondida and ICMM's Escondida are one mine with two ids, and mixing them
double-counts. Prices and country centroids merge key-by-key instead, because a price is identified
by mineral and year and a centroid by ISO3, so a real row displaces exactly the row it replaces.
That asymmetry matters: no single price source covers all four minerals, so dropping the whole
prices file the moment copper arrived from the Pink Sheet would leave three minerals unpriced.

Also: `etl/config/` holds everything that is a judgement rather than a fact — which HS codes are
active and what stage each represents, how each source spells our minerals, which USGS price series
to use and why, country name aliases, and unit conversions. Adding a fifth mineral is an edit to
those files. No component branches on a mineral id and no source module knows what copper is.

### Phase 5: polish

- **The globe is now keyboard-operable.** A WebGL canvas is normally unreachable by keyboard, which
  meant the detail panel — the only place a source, a confidence rating or an estimated-value
  warning appears — was openable by mouse alone. Tab to the globe, arrow keys walk the visible flows
  and sites with the camera following, Enter opens, Escape clears. Each move is announced to a
  screen reader.
- **Responsive below 768px.** The filter rail becomes a horizontal strip under the top bar and the
  detail panel becomes a sheet over the globe. Both are variants of the same components — nothing is
  hidden on a small screen. Bloom switches off there on cost grounds.
- **Camera altitude is computed from viewport aspect** rather than fixed. globe.gl's field of view
  is vertical, so a tall phone viewport cropped the sphere at any fixed distance.
- **Contrast fix**: the muted text colour was 4.2:1 on the page ground, under AA for the 10–11px
  sizes it is mostly used at. Now 4.9:1.

Verified in a real browser at desktop, tablet and mobile sizes, on both the dev server and the
production bundle, with no console errors.

---

## 3. What the app shows right now

> **Superseded — see section 0.** This describes the seed-data state as of 1 September; the app now
> runs on real copper data. Left as-is below as a record of that session.

Every bit of the seed dataset, with nothing filtered or capped. The arc cap is 300 and the seed has
28 flows, so it never fires.

| Mineral | Arcs (flows) | Points (facilities) |
| --- | --- | --- |
| Copper | 10 | 14 |
| Lithium | 7 | 6 |
| Cobalt | 6 | 6 |
| Rare earths | 5 | 6 |
| **Total** | **28** | **30** |

Plus 8 prices and 17 country centroids. The whole data payload is 38 kB.

**Why it looks sparser than 28 arcs.** The globe is a sphere, so you see about half at once. At the
opening camera position over Africa, only 6 arcs have both endpoints facing you and 5 are entirely
round the back. That skew is not random: China, Japan and Korea are the destination for 21 of the 28
flows, and they are all on the far side when you are looking at the Atlantic. Dragging east fills
the picture in noticeably.

### What a full data run produces, for comparison

| | Seed (live now) | Full ETL run |
| --- | --- | --- |
| Facilities | 30 | 1,364 |
| Flows | 2,000 (top 300 drawn) | 2,000 |
| Countries | 17 | 138 |
| Data payload | 38 kB | ~1.5 MB |

At that density the legend reports "showing the top 300 of 2,000 flows by value", which is a
visibly different picture. This has been run and verified to validate against the app's own schema —
it just has not been committed. See section 6.

---

## 4. Data gaps and honesty caveats you should know

This is the section to read before you go hunting for more data or judge what the app is telling
you. Every item here is a real limitation, not a bug.

### Rare earths have no mine-stage trade, and cannot

**There is no 6-digit HS code for rare earth ore or concentrate.** Customs authorities do not have a
box to tick for it. It ends up buried inside `253090`, "mineral substances not elsewhere specified",
which is a grab-bag that also carries spodumene — which is exactly why we already use that code for
*lithium's* mine stage. There is no way to split the rare-earth share out of it without inventing
the split.

Consequences you will notice:

- Rare-earth arcs are all `refine → refine`. All five of them.
- With the mine-stage filter on, rare earths contribute no flows at all. The stage filter was
  deliberately built to match on *either* arc endpoint so a refine-only mineral does not vanish
  entirely, and a test asserts this.
- Rare-earth *mines* do show as points — Bayan Obo, Mountain Pass, Mount Weld, and the
  low-confidence Kachin State district. It is only the arcs that are missing.

This is a hole in world trade statistics, not in our seed dataset. No source fixes it.

### We have rare-earth mining data we are throwing away

The USGS publishes rare-earth mine production by country and the pipeline reads it on every single
run: 18 countries for 2024, China 270,000 t, US 45,500 t, Australia 29,000 t, Myanmar 27,000 t. The
IEA gives the same shape for magnet rare earths.

**None of it reaches the interface**, because the data contract has no production table — the brief
specified facilities, flows, prices, countries and meta, and nothing else. The figures are read
purely to sanity-check flow volumes and then discarded.

This is the single highest-value upgrade available. Adding a production table would give rare-earth
mining, and every other mineral's country-level output, somewhere to land. See section 7.

### ICMM will not fill the rare-earth gap either

Their entire dataset carries 17 sites with any rare-earth token, 14 with a mine component. That is
up from 4, not up to hundreds. ICMM is built around large-scale operations reported by its members,
and most rare-earth capacity is not.

### Prices are thinner than they look

- The **World Bank Pink Sheet** is the reference series for exchange-traded metals, but it carries
  copper and nothing else we track. No lithium, no cobalt, no rare earths.
- The **USGS** fills the other three, but each needs a judgement about *which* published series to
  use. Those judgements are documented with reasoning in `etl/config/usgs_price_series.json`.
- **The rare-earth price is the least comfortable number in the project.** There is no published
  price for a mixed rare-earth oxide basket. The two USGS series are a cheap cerium-lanthanum
  mischmetal and an expensive NdPr oxide. We use NdPr, because it drives the economics of the magnet
  supply chain this app is about — but using it as a basket proxy *overstates* the value of
  low-value rare-earth trade. Every value derived from it is tagged `estimated` and labelled as such
  in the UI. Worth revisiting if you find a better series.

### Trade values and estimated values are different things, deliberately

A value that came from trade statistics is a traded value. A value that came from
`volume × average price` is an estimate, and the app never lets the two look alike: it gets a badge,
a plain-language warning, and the arithmetic that produced it shown in the detail panel.

Note a consequence of moving to real data: **TiCM reports values but not volumes**, so real trade
flows arrive with a real traded value and no estimate. The estimated-value code path currently runs
on the seed data's 14 estimated flows. After a full data run there would be zero estimated flows
until a volume-carrying source is added. The code path stays alive and tested regardless — the seed
now stores estimated flows with a null value and the pipeline derives it on every run.

### Choices made about trade direction that you may want to revisit

Each country pair appears twice in TiCM, once as the exporter's `Export` row and once as the
importer's `Import` row, and **the two disagree** — sometimes wildly. Chile to China under one code
reads $21.0bn as an export and $2,554 as an import, because they describe different physical
shipments.

We use exports: reporter as origin, partner as destination. Import rows only fill pairs that have no
export row at all, and those flows are marked low confidence. On the 2024 data that mirror fill
covered 3,799 country pairs — a meaningful share, so the low-confidence marking matters.

### Other things the raw data does that the pipeline has to handle

All confirmed by reading the actual files, and all things that would silently corrupt output if
missed:

- **A TiCM file holds far more HS codes than its filename says.** The 740100 extract carries 42
  codes. Every file is read whole and filtered on the codes the config marks active.
- **The same code appears in several files.** 4,676 duplicate rows in the 2024 extracts. Without
  deduplication, rare earths get counted three times.
- **Aggregate partners sit alongside real ones.** 6,609 rows had "World" or "European Union" on one
  side. Summing those with their members doubles the total.
- **Lithium units differ by a factor of 5.3.** The USGS reports contained lithium; our flow volumes
  are lithium carbonate equivalent. The cross-check caught this by flagging Australia as exporting
  five times what it mines.

### Country coordinates are capitals, not centroids

They come from the World Bank country API — an official, versioned, no-auth list. It means
Australia's arcs land on Canberra rather than in the middle of the continent. Recorded in
`meta.json` and the README because a coordinate that looks like a centroid and is not should not be
quiet. Four places the list omits (Taiwan, French Guiana, Montserrat, the Holy See) are hand-added.

### Low confidence is visible without reading anything

Low-confidence facilities are drawn faint and flush against the sphere while verified ones stand
proud of it. Low-confidence flows are dashed. The difference survives greyscale and colourblindness,
and does not disappear under reduced motion. ICMM rates sites High, Moderate or Very Low; only High
maps to our `high`. Moderate and Very Low both map to `low`, so a moderately-sourced point is never
promoted to look verified.

### The country name resolver refuses to guess

A name it cannot match to an ISO3 code is counted, reported in the run log, and its rows dropped —
never fuzzy-matched to the nearest neighbour, because a trade flow attributed to the wrong country
is worse than a missing one. On the 2024 data this drops a handful of rows. Watch the run log after
any source update; a new spelling shows up there.

### UN Comtrade is wired in but deliberately inert

Its API needs a subscription key, and the pipeline runs unattended in a public GitHub Action where a
committed key is a leaked key. The module reports a skip on every run naming what it would need,
rather than pretending to be implemented. TiCM's gaps stay gaps.

---

## 5. Things you may want to change, and how hard each is

Roughly ordered by effort. This is aimed at UI feedback — knowing what is a config edit versus an
architecture change should help you aim.

### Data edits, no code

- **Mineral colours, glow intensity, display order, names** — `etl/config/minerals.json`, then
  re-run the pipeline. The whole UI reads from this.
- **Which HS codes count, and what stage each represents** — same file. Codes marked inactive are
  retained deliberately (copper semis, alloys, batteries) so switching one on later is a data edit.
- **Adding a fifth mineral** — a row in `minerals.json`, source spellings in
  `commodity_aliases.json`, a price series in `usgs_price_series.json`. No component changes.
- **Which USGS price series to use** — `usgs_price_series.json`, which carries the reasoning for
  each current choice.
- **How many flows survive per mineral** — currently the top 500 by value, in
  `etl/sources/ticm_trade.py`.

### Single-file CSS or component changes

- **Colours, type scale, spacing, border radius** — all in `src/styles/tokens.css`. There are no
  hardcoded hex values in components. The palette is deliberately near-monochrome so that every
  saturated pixel on screen is a mineral; if you want the chrome to carry its own accent colour,
  that is a token change but it is also a reversal of the design's central idea.
- **Arc width scale** — square root today, in `src/data/derive.ts`. Linear makes copper a solid band
  and everything else a hairline. The legend reads the same function, so the swatches and the arcs
  cannot drift apart.
- **How many arcs are drawn before the cap** — `DEFAULT_ARC_CAP` in `derive.ts`, currently 300. Past
  a few hundred the frame rate suffers.
- **Point size by stage, colours, bloom strength and threshold** — `src/components/GlobeCanvas.tsx`.
- **What the detail panel shows** — `src/components/DetailPanel.tsx`.

### New feature, but the seam already exists

- **Year, region or confidence filters.** `FilterRail` and the `Filters` type in `derive.ts` were
  built for this: a new filter is a field on the type, a clause in two match functions, and a block
  in the rail. Not a layout change.

### Architecture change

- **A production table** (see section 7). Touches the schema, the loader, the ETL and the UI.
- **Time series / animating a year slider.** The contract carries a year per flow, so the data
  supports it, but the app currently has no concept of a time axis.

---

## 6. The seed-versus-real-data decision

> **Superseded — see section 0.** Real data shipped on 13 September. Left as-is below because the
> reasoning (and the ICMM-coverage caveat at the end) is still worth knowing.

`public/data/` is still the seed dataset. This was a deliberate call, and the reasoning is worth
knowing because it is the first thing you may want to reverse.

**Why it was left:** swapping 30 checkable facilities for 1,364 and 28 flows for 2,000 is a change
worth reading a diff for, and the brief scoped this session as a scaffold rather than a data
project. The `refresh-data.yml` workflow exists precisely to deliver that change as a reviewable
pull request rather than a commit nobody looked at.

**What is committed is exactly what `python etl/pipeline.py --offline --no-manual` produces**, and
CI asserts that on every push. So `public/data/` is genuinely generated output, not a hand-edited
file nobody can reproduce.

**To ship real data**, either:

- Run `refresh-data.yml` from the Actions tab (`workflow_dispatch`), review the PR it opens, merge.
- Or locally: `python etl/pipeline.py && npm test`, then commit.

Expect: 1,364 facilities, 2,000 flows, 138 countries, ~1.5 MB of data. The globe draws the top 300
arcs and says so in the legend.

### One caveat before you merge it

The full run's facilities come from ICMM, whose coverage is uneven by mineral — 1,054 copper sites
but 17 rare-earth ones. The globe will look dramatically denser around copper and barely changed
around rare earths. That is real, not a bug, but it is worth expecting so it does not read as a
failure.

---

## 7. Next steps, in the order I would do them

### 1. ~~Ship the real data — one workflow run~~ Done, 13 September

Shipped locally rather than via the workflow PR this described, but the outcome is the same — see
section 0.

### 2. Add a production table to the contract — the biggest single upgrade

We are currently reading country-level mine and refinery production from the USGS and the IEA on
every run and discarding it. A production table would:

- Give rare-earth mining a visible presence for the first time.
- Show the mine-versus-refine concentration story directly — that the DRC mines the cobalt and China
  refines it — which is arguably the single most important fact in critical minerals and which the
  app currently cannot state.
- Give the globe something to draw for stages and minerals that have no trade data.

Scope: a seventh file and schema, loader changes, an ETL merge path (the extract logic already
exists and works), and a UI decision about how to render it — country-level choropleth, sized
markers at country centroids, or a panel figure. Probably the largest remaining piece of work, and
the one that most changes what the app can say.

### 3. Take the raw TiCM extracts out of the repo — once real data is shipping

Deferred deliberately, with the full reasoning in the README under "Before this runs on real data".
Short version: ADB-WTO permit non-commercial reuse with attribution, which we do. But TiCM is a
middleman for UN Comtrade data, and its terms pass Comtrade's bulk-redistribution limits through to
us. 24 MB of raw bilateral rows in a public repo looks more like mirroring than using. The derived
`flows.json` is unaffected — it is aggregated, capped and credited.

**Order matters**: run the refresh and merge its PR *first*, so the derived data is banked, then
`git rm -r --cached etl/raw/manual/adb-wto-ticm/` and gitignore it. Do it the other way round and
you are stuck on seed flows until someone re-downloads by hand.

### 4. Custom domain

DNS records are in the README. Three steps, all in a browser: add the records at your registrar, set
the custom domain in repo settings, tick Enforce HTTPS once the certificate issues.

### 5. Filters the rail was built for

Year, region, confidence. The seam exists; each is a small piece of work.

---

## 8. Where to hunt for more data

Concrete candidates, with what each would actually add. Ordered by what I would chase first.

### Fills a real gap

- **UN Comtrade direct** (<https://comtradeplus.un.org>) — a subscription key would let us fill the
  pairs TiCM does not cover and reduce reliance on mirrored import rows. The module is already
  wired; it needs a key and a fetch implementation. Note the key cannot live in the public workflow.
- **A volume-carrying trade source.** TiCM gives values, not tonnages. Anything that reports trade
  in tonnes would let the estimated-value path work on real data and let you compare physical flows
  rather than dollar flows — which behave very differently when prices swing, as lithium did.
- **S&P Global Market Intelligence / Mining Intelligence, or Mindat** — for facility coverage beyond
  ICMM's member-reported large-scale operations, especially rare earths. Commercial, but the gap
  they would fill is the one most visible in the app.
- **A rare-earth basket price index.** Argus, Fastmarkets and Asian Metal all publish REO basket
  prices commercially. Any of them would replace the NdPr proxy that is currently the weakest number
  in the project.

### Would deepen what exists

- **USGS Mineral Industry Surveys** — monthly and annual commodity detail beyond the Mineral
  Commodity Summaries we already read. Same publisher, same no-auth access, more granularity.
- **IEA Critical Minerals Data Explorer, refreshed annually** — we hold the 2026 workbook; it is a
  manual download each year.
- **BGS World Mineral Statistics** (<https://www2.bgs.ac.uk/mineralsuk/statistics/>) — long
  historical production series, which would support a time axis.
- **Company disclosures** for facility capacity. `capacity_tonnes_per_year` is nullable and
  currently null for every ICMM record, because ICMM v1.5 publishes no capacity column. The detail
  panel renders it as "not recorded". Filling it would make facility points meaningful in size, not
  just position.

### Worth knowing about, lower priority

- **EITI** (<https://eiti.org>) for governance and payment data by country.
- **World Bank Pink Sheet** already integrated; watch whether they ever add lithium or cobalt, at
  which case the pipeline picks it up with no code change because it matches on mineral name.
- **Natural Earth / geoBoundaries** if you ever want real polygon centroids instead of capital
  cities, or country polygons for a choropleth.

---

## 9. Open questions for you

1. **Ship the real data now, or keep the seed while iterating on UI?** The seed is easier to reason
   about while making design changes; the real data is more honest about what the app is for.
2. **Is the density right at 300 arcs?** That cap is a frame-rate judgement made before real data
   existed. Worth re-judging once you see 2,000 flows.
3. **Does the near-monochrome chrome work for you?** The design's central idea is that every
   saturated pixel is a mineral. It is defensible but it is a strong constraint, and reversing it is
   a token-file change.
4. **Is the production table worth the work?** It is the biggest remaining piece and the one that
   most changes what the app can say. It is also not in the original brief.
5. **Repo visibility.** It is public now, which is fine, but section 4 and step 3 of section 7 are
   both about consequences of that.

---

## 10. Reference

### Commands

```bash
npm install
npm run dev          # dev server
npm run build        # static bundle into dist/
npm run preview      # serve the built bundle
npm run typecheck
npm run lint
npm test

pip install -r etl/requirements.txt
python etl/pipeline.py                         # everything reachable
python etl/pipeline.py --offline               # no network
python etl/pipeline.py --no-manual             # ignore the manual drops
python etl/pipeline.py --offline --no-manual   # what a bare CI runner sees
python etl/pipeline.py --dry-run               # validate and report, write nothing
python etl/pipeline.py --check                 # fail if the run would change public/data
python etl/test_pipeline.py
python -m ruff check etl/ && python -m ruff format --check etl/
```

### Where things live

| Path | What |
| --- | --- |
| `src/data/schema.ts` | The data contract. Single source of truth for all six files. |
| `src/data/load.ts` | Fetch, validate, join, and check references between files. |
| `src/data/derive.ts` | Filtering, value resolution, arc geometry, the width scale. |
| `src/components/GlobeCanvas.tsx` | The globe. Presentational — props in, callbacks out. |
| `src/components/AppShell.tsx` | Owns all state and data loading. |
| `src/styles/tokens.css` | Every colour, size and spacing value. |
| `etl/pipeline.py` | The orchestrator. |
| `etl/contract.py` | Python mirror of `schema.ts`. |
| `etl/sources/` | One module per source, all satisfying `base.py`. |
| `etl/config/` | Everything that is a judgement rather than a fact. |
| `etl/seed/` | The hand-authored fallback dataset. |
| `etl/raw/manual/` | Committed human-dropped source files. |
| `public/data/` | Generated output. What the browser loads. |
| `README.md` | Setup, deployment, DNS, sources, licences. |
| `etl/README.md` | How the pipeline works and how to refresh each source. |
| `PROGRESS.md` | Phase-by-phase log and every assumption made without asking. |

### Documents worth reading next

- `README.md`, section "Before this runs on real data" — the TiCM decision in full.
- `etl/README.md`, section "Seed data is a fallback, not a layer" — why the merge rules are what
  they are.
- `PROGRESS.md`, "Assumptions and deferred items" — every call made without asking, listed so it can
  be reversed cheaply.

### Licences

MIT for the code. Data carries its sources' licences: ICMM Global Mining Dataset and IEA Critical
Minerals Data Explorer are CC BY 4.0; USGS is public domain; World Bank data is CC BY 4.0; ADB-WTO
TiCM permits non-commercial reuse with attribution. Commercial use of any of it needs clearance from
the publishers.
