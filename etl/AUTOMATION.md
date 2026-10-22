# Automating the monthly data pull

Goal: every month, refresh `public/data/` — including the trade flows — without a human doing the
work, while keeping a human review step before anything ships.

## Why this is not just the GitHub Action

[`refresh-data.yml`](../.github/workflows/refresh-data.yml) already refreshes everything that can be
fetched by a machine on a runner: the World Bank country API and Pink Sheet, plus the committed ICMM
and IEA workbooks. It cannot refresh **trade flows**, for two reasons:

1. **ADB-WTO TiCM has no API.** critmin.org serves extracts through a query form, so someone (or
   something) has to run the query and download the CSVs.
2. **The CSVs are no longer in the repo.** The raw extracts (about 130,000 rows of third-party UN
   Comtrade data) were removed from version control and are gitignored
   (`etl/raw/manual/adb-wto-ticm/`). Only the derived, aggregated, credited `public/data/flows.json`
   is published. Do not re-commit them to make automation easier.

On a bare runner the pipeline therefore falls back to seed flows. The refresh workflow has a guard
that **fails the run** rather than open a PR that replaces real flows with seed ones.

So the monthly trade refresh runs **locally (or on an agent's machine)**, where the extracts can sit
on disk, and publishes only a pull request containing `public/data/`.

## The monthly loop

1. **Download** the TiCM extracts from <https://critmin.org> into `etl/raw/manual/adb-wto-ticm/`
   (gitignored), named `ticm-<mineral>-<hs>-<year>.csv`. For the current copper-only scope:
   - `ticm-copper-260300-<year>.csv`
   - `ticm-copper-740100-<year>.csv`

   Export CSV per commodity per year; see [`README.md`](README.md#adb-wto-ticm--rawmanualadb-wto-ticm)
   for the file properties the code depends on. Re-activated minerals need their own codes
   (`etl/config/minerals.json`).
2. **Run the pipeline**: `python etl/pipeline.py --year <year>`
3. **Verify**: `npm test` (runs the app's real schema over the new files) and read the run log. Check
   that `public/data/meta.json` lists `adb-wto-ticm` and no `seed-flows` / `seed-facilities`.
4. **Open a PR** from a branch containing only `public/data/` changes. Never push to `main`. The diff
   is the review.
5. **Merge** after reading the diff; the Deploy workflow publishes it.

## Handing it to an agent

A scheduled Claude task (Cowork / a scheduled Claude Code task) can run steps 1–4 on a machine
that has this repo checked out, Python and Node installed, and `gh` authenticated. Suggested prompt:

> In the mineralflows repo, refresh the data. Open critmin.org, run the TiCM queries for the active
> minerals in `etl/config/minerals.json` for the latest published trade year, and save the CSVs into
> `etl/raw/manual/adb-wto-ticm/` as `ticm-<mineral>-<hs>-<year>.csv`. Run
> `python etl/pipeline.py --year <year>` and `npm test`. Confirm `public/data/meta.json` has no
> `seed-flows` or `seed-facilities` source. Create a branch, commit **only** `public/data/`, push it,
> and open a pull request summarising the run log. Do not commit anything under `etl/raw/`, do not
> push to `main`, and stop and tell me if any step fails or the output fell back to seed data.

Guardrails that should stay true however this is set up:

- **PR, not push.** A silently auto-committed bad extract deploys straight to the site.
- **Only `public/data/` is committed.** The raw extracts stay local.
- **Fail closed.** Seed fallback in the output means stop, not "open the PR anyway".
- **Check critmin.org's terms for automated access** before scheduling unattended downloads. They were
  reviewed for reuse and attribution, not for scripted querying; confirm that before relying on it.

## Moving it fully into GitHub Actions later

The only thing blocking a fully hosted monthly run is step 1. If trade data could come from an API,
the extracts would never need to touch disk or the repo. The hook for that exists:
[`etl/sources/comtrade.py`](sources/comtrade.py) is wired into the pipeline but inert, because
UN Comtrade's API needs a subscription key. To turn it on, store the key as a GitHub Actions secret
named `COMTRADE_KEY`, expose it to the "Run the pipeline" step, and implement `_fetch` in that
module. It produces the same flow shape as the TiCM source, so no merge-rule changes are needed.
That route also sidesteps the redistribution concern, since nothing raw is stored.
