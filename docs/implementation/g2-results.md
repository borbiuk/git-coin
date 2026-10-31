# Results of gate G2 (tests on a real GitHub runner)

- Date: 2026-10-29
- Where: throwaway public repositories of the `borbiuk` account (`git-coin-pilot`, `git-coin-throwaway`, `git-coin-canary-a`, `-b`, `-c`). The workflows are the templates in [throwaway/](throwaway/README.md).
- Runner: `ubuntu-26.04`, OS "Ubuntu 26.04.1 LTS", image `ubuntu26/20261026.180.1` (probe) and `20261025.179.1` (bot push test), runner version 2.338.0, Node.js `v24.22.1`, Azure regions West US, South Central US and Central US. This confirms ADR 0003: the pinned label exists and Node 24.22.1 is the default.
- Status: some checks are finished. The rest wait for time (pilot 72 hours, canary 61 days).

## Item 4: schedule pilot (running)

- Repo `borbiuk/git-coin-pilot`, pushed 2026-10-29T17:36:05Z. This time is the `--from` value of `analyze-pilot.mjs`. Three workflows (`pilot-5m`, `pilot-15m`, `pilot-30m`) are active. One manual run of each wrote a row to its branch (`pilot-5m`, `pilot-15m`, `pilot-30m`). Manual rows are ignored by the analysis.
- Read the result after 2026-11-01T17:36Z (72 hours), better after a weekend. Steps: [throwaway/README.md](throwaway/README.md), "Read the pilot result".

## Item 3: source probe (15 runs)

One run at 2026-10-29T17:44:57Z (workflow `probe`, run 40924247149 in `git-coin-throwaway`). The first three runs failed because of a script defect (GitHub starts steps with `bash -e`; fixed by `set +e` in the three throwaway workflows, commit "Turn off bash -e in the throwaway probe, email and push tests").

| Request                                              | HTTP | ms (this run) | Coins found |
| ---------------------------------------------------- | ---- | ------------- | ----------- |
| Kraken `Ticker?pair=` (10 pairs in one call)         | 200  | 223           | 10 of 10    |
| Kraken `AssetPairs` (`altname` and `wsname` present) | 200  | 218           | 10 of 10    |
| Kraken `Ticker` without `pair` (fallback)            | 200  | 203           | n/a         |
| Coinbase `products/{id}/ticker` (10 calls)           | 200  | 45 to 107     | 10 of 10    |
| Bitstamp `ticker/` (all markets)                     | 200  | 201           | 10 of 10    |
| Coin Metrics `asset-metrics` (10 assets, one call)   | 200  | 316           | 10 of 10    |
| CoinGecko keyless `simple/price`                     | 200  | 167           | 10 of 10    |

- No block, no HTTP 403, 451 or 429 in this run. All sources sit behind Cloudflare. This is one sample from one runner at one time. The scheduled runs are in the next block.
- Kraken result keys from the runner: `ADAUSD BNBUSD LINKUSD SOLUSD XDGUSD XETHZUSD XLTCZUSD XXBTZUSD XXLMZUSD XXRPZUSD`. They match the ADR 0002 table.
- Coin Metrics rate limit headers on the runner: `x-ratelimit-plan: download`, `x-ratelimit-limit: 6000, 6000;w=20;comment="sliding window"`. That is 6,000 requests per 20-second window, not the "10 requests per 6 seconds" of the docs.
- Coin Metrics returned all ten assets in one request, without `next_page_url`.

Result of all successful runs, read on 2026-10-31: 15 runs (14 scheduled and the manual run above) from 2026-10-29T17:44Z to 2026-10-31T10:12Z, including runs at minute 0 and minute 58. The three failed runs are the `bash -e` defect above.

| Request                                    | Calls | HTTP 200 | HTTP 429 | Average ms |
| ------------------------------------------ | ----- | -------- | -------- | ---------- |
| Kraken `Ticker?pair=`                      | 15    | 15       | 0        | 201        |
| Kraken `AssetPairs`                        | 15    | 15       | 0        | 191        |
| Kraken `Ticker` without `pair` (fallback)  | 15    | 15       | 0        | 132        |
| Coinbase `products/{id}/ticker` (10 coins) | 150   | 150      | 0        | 52 to 98   |
| Bitstamp `ticker/`                         | 15    | 15       | 0        | 317        |
| Coin Metrics `asset-metrics`               | 15    | 15       | 0        | 210        |
| CoinGecko keyless `simple/price`           | 15    | 15       | 0        | 200        |

- No HTTP 403, 451 or 429 in any run. All ten coins came back from every source in every run, with one exception.
- The exception: in the run of 2026-10-30T02:29:47Z Kraken answered HTTP 200 with `{"error":["EGeneral:No data"],"result":{}}` for `Ticker?pair=` and with `{"error":[],"result":{}}` for `Ticker` without `pair`. `AssetPairs` in the same run was normal. An HTTP 200 alone does not show a good Kraken answer: read the `error` array and the `result`.

## Item 6: bot push, rulesets, concurrency (done)

Repo `git-coin-throwaway`, orphan branch `data`, ruleset `protect-data-and-default` (deletion and non-fast-forward blocked on `data` and the default branch, no required pull requests).

| Check           | Result | Note                                                                                                                                                                                                          |
| --------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a-push`        | PASS   | The bot pushes to `data` under the ruleset (`GITHUB_TOKEN`, `contents: write`).                                                                                                                               |
| `c-race`        | PASS   | A second writer pushed first. Reset, redo and push worked: no line lost, none doubled.                                                                                                                        |
| `e-keepalive`   | PASS   | An empty bot commit on the default branch is allowed.                                                                                                                                                         |
| `f-author`      | PASS   | `github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>`, login `github-actions[bot]`, id 41898282. This is the constant in `src/gitdata.ts`.                                            |
| `d-force-push`  | PASS   | The force push was rejected.                                                                                                                                                                                  |
| `b-concurrency` | PASS   | Three starts in a row (`workflow_dispatch`): the first ran, the second was cancelled, the third stayed pending. A pending run replaced by a newer one shows as `cancelled`. Not yet seen for a scheduled run. |

## Item 2: Pages (partly done)

- Pages source "GitHub Actions" was set through the API. A manual run deployed in 9 seconds. The page answered HTTP 200 with `cache-control: max-age=600` and an `etag`. `content-encoding: gzip` was not present, because the page is only 228 bytes. Check gzip with a larger file before the dashboard goes live.
- A scheduled run (every 3 hours) deployed too: run 41189353689 (2026-10-31T09:35Z). The page shows `event: schedule`, answers HTTP 200 and has `cache-control: max-age=600`. Only the gzip check is open.

## Item 5: Issue email (done)

Run in `git-coin-throwaway`, times in UTC on 2026-10-29. The owner read the inbox on 2026-10-31. The mail client shows minutes only, so "same minute" is the finest delay known. The owner's real notification settings were used; the exact settings were not written down.

| Variant | Issue                                   | Created  | Email                                                                              |
| ------- | --------------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| (a)     | `[email test] plain at 17:53:47Z`       | 17:53:48 | No. Nothing found in the inbox by title.                                           |
| (b)     | `[email test] mention at 17:54:08Z`     | 17:54:08 | Yes, 17:54. Reason "Mention".                                                      |
| (c)     | `[email test] assignee at 17:54:29Z`    | 17:54:29 | Yes, 17:54, two emails: "Assigned to and mentioned" and "Assigned #3 to @borbiuk". |
| fail    | manual run of `issue-email-test` failed | 17:55:16 | Yes, 17:55.                                                                        |

- Pass: variant (c), the shape of the real alerts (ADR 0006), arrived in the same minute. A plain Issue does not email the owner, so the alert step must always set the mention and the assignee.
- Scheduled failures: the repository variable `EMAIL_TEST_FAIL=true` made six scheduled runs fail on purpose. All six failed-run emails reached `borbiuk`, the account that last edited the cron line (commits b08233a and f435c7f), within 7 minutes of the run being created. Runs (UTC): 10-29 23:00, 10-30 06:31, 13:38, 20:10, 10-31 01:05, 09:58. Emails (UTC): 23:00, 06:32, 13:41, 20:17, 01:05, 09:58. The variable was deleted on 2026-10-31.
- Delivery of this schedule, a side note: the cron `47 */3 * * *` ticks 13 times between 2026-10-29T20:47Z and 2026-10-31T08:47Z. Six runs started, the first at 23:00. The pilot (item 4) gives the proper numbers.

## Item 9: 60-day canary (running)

- Repos `git-coin-canary-a`, `-b` and `-c` with the repository variable `CANARY_VARIANT` set to `A`, `B` and `C`. Started 2026-10-29. Make no commit by hand in them. Read the workflow state after 61 days (2026-12-29).

## Defects found by running the templates

- `probe.yml`, `issue-email-test.yml` and `bot-push-test.yml` did not turn off `bash -e`. A `grep` without a match ended the probe after the first request. Fixed.
- The `borbiuk` token of `gh` has the scopes `repo`, `gist`, `read:org` and `admin:public_key`, but not `workflow`. Pushing worked because `git` used SSH with the key of the `borbiuk` account. The three throwaway repos use a local `core.sshCommand` for this. No global setting was changed.

## Gate G1 and the first real run (2026-10-29, later)

- `borbiuk/git-coin` was made public, `main` and the orphan `data` branch were pushed, Pages source was set to "GitHub Actions", the ruleset `protect-data-and-main` (deletion and non-fast-forward blocked, no required pull requests) was added, and secret scanning and push protection were turned on (the API showed both as disabled right after the repo became public).
- First CI on a real runner: `build` (jobs `build`, `checks`, `config`, `symbols`, `node22`) and `codeql` passed. This is the first time `actionlint`, `zizmor` and `check-jsonschema` ran. `scorecard` failed because of the default branch (see below).
- `collect.yml`: a manual dry run reported "40 rows would be written" (four sources, ten coins) on the runner. The real run wrote the first bot commit to `data` (`data: 2026-10-29T20:46Z 40 rows`, author `github-actions[bot]`). The schedule is active, so the 14-day source test has started.
- The dashboard is live at https://borbiuk.github.io/git-coin/ with real Kraken prices (primary source). The charts need more points: the 7-day file had one point after the first run.

### Two traps found (add to the runbook order)

1. **The first pushed branch became the default branch.** The repository was empty, so pushing `data` first made `data` the default branch. Scorecard failed ("only the default branch is supported"), and scheduled workflows and Pages deploy only from the default branch. Fix: `gh repo edit borbiuk/git-coin --default-branch main`. Next time push `main` first, or set the default branch before anything else.
2. **The `github-pages` environment allowed only the old default branch.** GitHub created the environment when Pages was enabled and allowed deployment from the then default branch (`data`). The `publish` job failed before its first step with: Branch "main" is not allowed to deploy to github-pages due to environment protection rules. Fix: add the policy for `main` (`gh api -X POST repos/borbiuk/git-coin/environments/github-pages/deployment-branch-policies -f name=main -f type=branch`) and remove the one for `data`. Then `gh run rerun <id> --failed`.
