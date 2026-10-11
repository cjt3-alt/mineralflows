# MineralFlows

Start with `HANDOFF.md` section 0 for where things stand.

## Pending actions for CJ

Raise these at the start of every session until CJ confirms they are done, then delete the item.

- **Enable Actions to open PRs (added 11 October 2026).** In repo Settings → Actions → General →
  Workflow permissions, tick "Allow GitHub Actions to create and approve pull requests". Without
  it, `refresh-data.yml` runs but fails when it tries to open its PR, as it did on 3 Sept and 3 Oct.
  Afterwards, run "Refresh data" from the Actions tab to confirm a PR opens.
