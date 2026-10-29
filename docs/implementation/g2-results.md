# Results of gate G2 (tests on a real GitHub runner)

- Date: 2026-10-29
- Where: throwaway public repositories of the `borbiuk` account (`git-coin-pilot`, `git-coin-throwaway`, `git-coin-canary-a`, `-b`, `-c`). The workflows are the templates in [throwaway/](throwaway/README.md).
- Runner: `ubuntu-26.04`, OS "Ubuntu 26.04.1 LTS", image `ubuntu26/20261026.180.1` (probe) and `20261025.179.1` (bot push test), runner version 2.338.0, Node.js `v24.22.1`, Azure regions West US, South Central US and Central US. This confirms ADR 0003: the pinned label exists and Node 24.22.1 is the default.
- Status: some checks are finished. The rest wait for time (pilot 72 hours, scheduled runs, canary 61 days) or for an email that only the owner can see.

## Item 4: schedule pilot (running)

- Repo `borbiuk/git-coin-pilot`, pushed 2026-10-29T17:36:05Z. This time is the `--from` value of `analyze-pilot.mjs`. Three workflows (`pilot-5m`, `pilot-15m`, `pilot-30m`) are active. One manual run of each wrote a row to its branch (`pilot-5m`, `pilot-15m`, `pilot-30m`). Manual rows are ignored by the analysis.
- Read the result after 2026-11-01T17:36Z (72 hours), better after a weekend. Steps: [throwaway/README.md](throwaway/README.md), "Read the pilot result".

## Item 3: source probe (first sample)

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

- No block, no HTTP 403, 451 or 429 in this run. All sources sit behind Cloudflare. This is one sample from one runner at one time. The probe also runs on a schedule (12 times a day, three of them at minute 0) in the throwaway repo, so the 200 and 429 rates need that data before the item is closed.
- Kraken result keys from the runner: `ADAUSD BNBUSD LINKUSD SOLUSD XDGUSD XETHZUSD XLTCZUSD XXBTZUSD XXLMZUSD XXRPZUSD`. They match the ADR 0002 table.
- Coin Metrics rate limit headers on the runner: `x-ratelimit-plan: download`, `x-ratelimit-limit: 6000, 6000;w=20;comment="sliding window"`. That is 6,000 requests per 20-second window, not the "10 requests per 6 seconds" of the docs.
- Coin Metrics returned all ten assets in one request, without `next_page_url`.

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
- Open: a scheduled run (every 3 hours) must deploy too. Check the page text `event: schedule` after the next scheduled run.

## Item 5: Issue email (waiting for the owner)

Run in `git-coin-throwaway`, times in UTC on 2026-10-29. The owner reads the inbox and records the answers here:

| Variant | Issue                                   | Created  | Email arrived? When? |
| ------- | --------------------------------------- | -------- | -------------------- |
| (a)     | `[email test] plain at 17:53:47Z`       | 17:53:48 | open                 |
| (b)     | `[email test] mention at 17:54:08Z`     | 17:54:08 | open                 |
| (c)     | `[email test] assignee at 17:54:29Z`    | 17:54:29 | open                 |
| fail    | manual run of `issue-email-test` failed | 17:55:16 | open                 |

- Scheduled failure: the repository variable `EMAIL_TEST_FAIL=true` is set, so the next scheduled run (every 3 hours) fails on purpose. The email should go to the account that last edited the cron line (`borbiuk`). After the first scheduled failure delete the flag: `gh variable delete EMAIL_TEST_FAIL --repo borbiuk/git-coin-throwaway`.

## Item 9: 60-day canary (running)

- Repos `git-coin-canary-a`, `-b` and `-c` with the repository variable `CANARY_VARIANT` set to `A`, `B` and `C`. Started 2026-10-29. Make no commit by hand in them. Read the workflow state after 61 days (2026-12-29).

## Defects found by running the templates

- `probe.yml`, `issue-email-test.yml` and `bot-push-test.yml` did not turn off `bash -e`. A `grep` without a match ended the probe after the first request. Fixed.
- The `borbiuk` token of `gh` has the scopes `repo`, `gist`, `read:org` and `admin:public_key`, but not `workflow`. Pushing worked because `git` used SSH with `~/.ssh/id_rsa` (the default SSH key belongs to the work account `nborbiuk_coral`). The three throwaway repos use a local `core.sshCommand` for this. No global setting was changed.
