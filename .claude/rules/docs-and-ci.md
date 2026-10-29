---
paths:
    - 'README.md'
    - 'docs/**'
    - '.github/**'
    - 'SECURITY.md'
    - '.editorconfig'
    - 'scripts/*.mjs'
    - '.markdownlint-cli2.jsonc'
    - 'knip.jsonc'
---

# Docs, CI and workflows

> Conventions for the docs and the GitHub automation. The reasons are in the ADRs ([ADR 0005](../../docs/adr/0005-schedule-and-workflow-design.md), [ADR 0009](../../docs/adr/0009-security-reliability-testing.md)).

## Docs

- Describe the code as it is: read `package.json`, `src/**` and `.github/**` before writing about them. Every command, script name, path and flag must match the code. `npm run lint:docs` (markdownlint with `.markdownlint-cli2.jsonc`, plus `scripts/check-docs.mjs` for relative links) fails on a broken link.
- `README.md` is the front page. The decisions are in `docs/adr/` (start at `0000-index.md`). The build plan, the contracts between modules and the QA report are in `docs/implementation/`. The owner's steps (gates) are in `docs/implementation/runbook.md`.
- ADR text and code must agree. When the code changes a decision, edit the ADR in the same change and say so.
- `.editorconfig` matches `.prettierrc.json`. Prettier formats Markdown too, so run `npm run format` before a commit.

## Workflows

- [collect.yml](../../.github/workflows/collect.yml) is the scheduled collector (cron `3,18,33,48 * * * *`, `workflow_dispatch` with `dry_run` and `mode`). Job `collect` runs `src/collect.ts` and pushes to the `data` branch. Job `publish` builds `out/` and deploys Pages, only when `should_publish` is true. The CLI contract (flags, outputs, exit codes) is in `docs/implementation/plan.md`, section 3.4. Keep the workflow and `src/collect.ts` in step.
- [build.yml](../../.github/workflows/build.yml) runs on pushes and pull requests to `main`. Jobs: `build` (Node 24: `npm ci`, `check:versions`, `format:check`, `lint`, `test`), `node22` (not required), `checks` (`lint:docs`, `lint:unused`), `config` (`check-jsonschema`, `actionlint`, `zizmor`), `symbols` (not required: `tools/check-symbols.ts` over the network). Do not add `check:outdated` (new upstream releases would break CI at random).
- `pr-title.yml` calls `scripts/check-pr-title.mjs`. The title goes in through `env`, never into the `run:` text. Commit titles on `main` follow the same rules by hand.
- `codeql.yml` (`javascript-typescript` and `actions`), `dependency-review.yml` and `scorecard.yml` are adapted from the Hyperfriend repository. `scorecard.yml` keeps its job shape (read-only top level, `security-events` and `id-token` on the job) or publishing is refused.
- Every `uses:` is a full commit SHA with the tag in a comment. [dependabot.yml](../../.github/dependabot.yml) opens weekly pull requests for `npm` and `github-actions` (7-day cooldown). It does not update the vendored uPlot, `check-jsonschema`, `zizmor` or `actionlint`: bump those by hand.
- Least privilege: top-level `permissions: {}` in `collect.yml`, write scopes only on the job that needs them (`collect`: `contents` and `issues`; `publish`: `pages` and `id-token`), `persist-credentials: false` on every checkout that does not push, every job has `timeout-minutes`, and every job of `collect.yml` has the guard `if: github.repository == 'borbiuk/git-coin'`.
- Never put response text from a data source into a `run:` line, a log line, an Issue body or HTML. The data collector only writes numbers and its own labels.
- The throwaway test workflows for the owner (`docs/implementation/throwaway/`) are not part of this repository's CI. They are copied into a separate public repo.
