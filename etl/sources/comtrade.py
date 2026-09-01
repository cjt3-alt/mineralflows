"""UN Comtrade — the gap-filler for country pairs TiCM does not cover.

This source is deliberately inert. Comtrade's public API needs a subscription
key, and the pipeline is not allowed to carry one: it runs unattended in a
GitHub Action, and a key committed to a public repo is a key that has leaked.

So the module is wired into the pipeline exactly like every other source and
always reports a skip naming what it would need. That is not a placeholder for a
missing decision — it is the decision. Nothing here fabricates a flow, and the
skip line in every run's output is the reminder that TiCM's gaps are still gaps.

To turn it on, put a key in the `COMTRADE_KEY` environment variable and
implement `_fetch`. The interface it has to satisfy is the same one
`ticm_trade.py` already satisfies, and the two produce the same shape of flow, so
the merge rules in `pipeline.py` need no change.
"""

from __future__ import annotations

import os

from sources.base import MANUAL, ExtractContext, SourceResult, skipped

SOURCE_ID = "un-comtrade"
KIND = MANUAL

NAME = "UN Comtrade"
URL = "https://comtradeplus.un.org"
KEY_ENV = "COMTRADE_KEY"


def extract(ctx: ExtractContext) -> SourceResult:
    coverage = (
        "Bilateral trade for country pairs the TiCM extracts do not cover. Not currently "
        "used: the API needs a subscription key the unattended refresh cannot hold."
    )
    reason = (
        f"no {KEY_ENV} in the environment, and fetching without one is not implemented. "
        "TiCM gaps are left as gaps rather than filled from an unverified source."
    )
    if os.environ.get(KEY_ENV):
        reason = (
            f"{KEY_ENV} is set, but the Comtrade fetch is not implemented yet. Implement "
            "_fetch in etl/sources/comtrade.py; the flow shape and merge rules are already "
            "in place."
        )
    return skipped(SOURCE_ID, NAME, URL, str(ctx.year), coverage, reason)
