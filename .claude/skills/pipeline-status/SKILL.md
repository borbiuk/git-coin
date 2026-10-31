---
name: pipeline-status
description: Reports how the scheduled collector runs on GitHub and how complete the data branch is (run delivery rate, gaps, failures, newest price per coin). Use when asked about the pipelines, how often GitHub runs them, or whether data is missing.
---

# Pipeline status

Read-only. Nothing is pushed or changed on GitHub. Do the checks, do not offer them.

1. Run `./scripts/with-node24.sh node tools/run-status.ts`. It reads the latest `collect.yml` runs with `./scripts/gh-borbiuk.sh`. If `gh` fails, report the error and go on with steps 2 and 3.
2. Get a copy of the `data` branch in a scratch directory (never in the repo): `git fetch origin data`, then `mkdir -p <scratchpad>/data-checkout` and `git archive origin/data | tar -x -C <scratchpad>/data-checkout`.
3. Run `./scripts/with-node24.sh node tools/data-health.ts --data-root <scratchpad>/data-checkout`.
4. Report in Ukrainian: scheduled runs per hour against the 4 the cron asks for (ADR 0005), the age of the last scheduled run, the longest gaps, failed ticks per source, and any coin whose newest price is older than the longest normal gap. Gaps are normal, so call something a problem only when a source has no tick for hours or fails in most ticks.
5. Say clearly what was not checked: Pages deploy state and the Issue alert path. A tick counts as failed only by HTTP status and error code, not by a partial answer (`coins_ok`).
