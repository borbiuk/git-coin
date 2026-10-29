# Pre-implementation checklist

- Date: 2026-10-29
- Rule: do these before writing the real collector. "Blocking" means do not start coding the affected part until it is done. "Non-blocking" can run in parallel with coding.
- Use a throwaway public repo on the `borbiuk` account for tests 2 to 7, so the real repo stays clean. Delete it after the pilot. Scripts for the probes are throwaway too.
- Every test records: date, what was run, result, and a link to the run. Keep the results in the throwaway repo or in your notes. Update the ADRs with what you learn.

| #   | Item                                                                                                  | Blocking?                                                                                 | Affects                    |
| --- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------- |
| 1   | Re-read the key policy pages live                                                                     | Non-blocking (do first, it is cheap)                                                      | ADR 0001                   |
| 2   | Pages on the Free plan, public repo, deploy from a scheduled workflow                                 | Blocking                                                                                  | ADR 0005, 0008             |
| 3   | Runner probe of the four test sources (and keyless CoinGecko, optional)                               | Blocking                                                                                  | ADR 0002                   |
| 4   | 72-hour schedule pilot at 5, 15 and 30 minutes                                                        | Blocking (for the interval)                                                               | ADR 0005                   |
| 5   | Issue email test (three variants) and failed-run email                                                | Blocking (for alerts)                                                                     | ADR 0006                   |
| 6   | Bot push to an orphan `data` branch with rulesets, concurrency and push race                          | Blocking                                                                                  | ADR 0004, 0005, 0009       |
| 7   | Kraken written answer on public use of its data                                                       | Non-blocking since 2026-10-29 (the owner proceeds with real data; the request stays open) | ADR 0002                   |
| 7b  | Coin Metrics written answer (a test source, earlier plan B)                                           | Non-blocking (becomes blocking if Coin Metrics wins the test, or if Kraken says no)       | ADR 0002 Addendum A        |
| 8   | Repository settings: secret scanning, push protection, email privacy, Actions notifications           | Non-blocking                                                                              | ADR 0001, 0009             |
| 9   | 60-day canary                                                                                         | Non-blocking (runs 60+ days)                                                              | ADR 0005                   |
| 10  | Re-check coin list and Kraken result keys                                                             | Non-blocking                                                                              | ADR 0002, 0007             |
| 11  | Phone check of uPlot (touch, dark mode, 2,200 points)                                                 | Non-blocking                                                                              | ADR 0008                   |
| 12  | Runner image and action versions on the day of coding                                                 | Non-blocking                                                                              | ADR 0003, 0009             |
| 13  | Real repo size after 4 weeks                                                                          | Non-blocking (after launch)                                                               | ADR 0004                   |
| 14  | Owner decisions: licence, risk acceptance, test gate and rows of non-chosen sources staying in `data` | Non-blocking                                                                              | ADR 0001, 0002, 0009       |
| 15  | Four-source test (14 days, public repo, branch `data`) and the choice of one stored source            | Blocking (for the stored source; needs items 3 and 6 first)                               | ADR 0002, 0004, 0005, 0007 |

## Details

### 1. Re-read the key policy pages live (non-blocking)

- Why: the pages were read through a text extractor. Quotes may be slightly off.
- Check: ToS, AUP (sections 4 and 9), Additional Product Terms (Actions and Pages), events page (`schedule`), Pages limits, repository limits, rate limits for the REST API.
- Done when: every quote used in ADR 0001 and 0005 matches the live page, or the ADR is corrected.

### 2. Pages works on the public repo, deployed from a scheduled workflow (blocking)

- Why: the whole dashboard depends on it. The docs say Free plan needs a public repo. We have not seen it work from a scheduled run.
- Do: in the throwaway repo, set Pages source to "GitHub Actions". Add a workflow with `schedule` and `workflow_dispatch` that uploads a one-file site and deploys with `actions/deploy-pages` (permissions `pages: write`, `id-token: write`, environment `github-pages`).
- Check: the manual run deploys. A scheduled run deploys too (the `github-pages` environment allows the default branch). The page opens. Response headers show gzip and `max-age=600`.
- Done when: both runs are green and the page is live.

### 3. Runner probe of data sources (blocking)

- Why: nothing was tested from a runner. Binance and Bybit are reported as blocked. Kraken, Coinbase, Bitstamp and Coin Metrics are unverified. The CoinGecko keyless pool is shared.
- Do: a `workflow_dispatch` workflow that, once per source, calls the exact endpoints from ADR 0002 (Kraken `Ticker` with the 10 pairs, Coinbase `products/{id}/ticker` for the 10 product ids, Bitstamp `ticker/`, Coin Metrics `asset-metrics` with `ReferenceRateUSD`, and optionally CoinGecko `simple/price` for the 10 ids) and prints HTTP status, time in milliseconds, response size, and the first 300 characters. Run it about 10 times spread over a day, at different hours, including near :00 (to see 429 patterns).
- Also check: Kraken `Ticker?pair=A,B,C` returns all pairs; what the result keys are for all 10 coins (ADR 0002 mapping table); `AssetPairs` returns `altname` and `wsname`.
- Pass: for each test source, record the 200 rate and the 429 rate, and confirm that all 10 coins come back. A source that is blocked from the runner drops out of the test. If fewer than two of the four work, stop and reopen ADR 0002 (reserves, Revision 2 point 2).
- Do not print secrets (none are used).

### 4. 72-hour schedule pilot (blocking for the interval)

- Why: the evidence about delivery is thin and from other people's repos. We need numbers from this account.
- Do: in the throwaway public repo, create three workflows with off-peak minutes: `*/5` at minutes `2,7,12,...`, `3,18,33,48`, and `7,37`. Each appends `now` (UTC) and the expected tick to a log file on a `pilot` branch (or posts it to the job summary), and does nothing else. Leave it for 72 hours (a longer run that includes a weekend is better).
- Measure: runs per day per workflow; gap median, p90 and maximum; share of ticks delivered; whether any workflow shows the "about 5 runs per day" pattern; whether a pending run replaced by concurrency shows as "cancelled" (add `concurrency` to one workflow).
- Decision rule (ADR 0005 D1): keep `*/15` if at least 70% of ticks are delivered and the median gap is 20 minutes or less; revise to `*/10` or `*/5` if `*/5` delivers at least 1.5 times more points per day than `*/15`; use `*/30` if `*/15` is under 50% but stable; if all three show about 5 runs per day, stop and ask the owner about an outside trigger.
- Done when: the table of results is added to ADR 0005 and the default interval is confirmed or changed.

### 5. Issue email test (blocking for alerts)

- Why: Issues are the only alert channel in v1. The docs do not say whether a bot-created Issue emails the owner.
- Do: from a workflow using `GITHUB_TOKEN` (`issues: write`), create three Issues in the throwaway repo: (a) plain; (b) with `@borbiuk` in the body; (c) with `assignees: [borbiuk]` and a mention. Use the real notification settings of the account (Watching and Participating email on). Run each variant, record the time of creation and the time the email arrives. Also force one scheduled run to `exit 1` and check the failed-run email (Settings, Notifications, Actions, "Only notify for failed workflows"), and which user gets it (the one who last edited the cron line).
- Pass: variant (c) arrives within a few minutes. Note which variants fail.
- If none arrive: do not code the alert step as designed. Reopen ADR 0006 for a second channel (needs an owner decision and a secret).

### 6. Bot push, rulesets, concurrency and push race (blocking)

- Why: the design pushes to an orphan `data` branch with `GITHUB_TOKEN`, under rulesets, from one concurrency group.
- Do in the throwaway repo: create an orphan `data` branch. Add a ruleset that blocks force pushes and deletion on `data` and the default branch (no required pull requests). From a workflow with `contents: write`, check out `data` with `fetch-depth: 1`, append a line, commit as `github-actions[bot]`, push. Then: (a) check the push works under the ruleset; (b) start two overlapping runs and confirm the concurrency group keeps one running and one pending; (c) force a non-fast-forward push from a second clone and confirm the "reset, redo the append, push again" retry works; (d) confirm a force push is blocked; (e) make an empty commit on the default branch from the workflow (the keepalive step) and confirm it is allowed; (f) check the commit author email shown on GitHub for the bot and write it into ADR 0001 open question 4.
- Done when: all six checks behave as designed, or the ADRs are changed.

### 7. Kraken written answer (non-blocking since 2026-10-29)

- Why: Kraken's terms do not say whether public use of its public ticker is allowed (ADR 0002). Coinbase, OKX, KuCoin and Bitfinex say no. A public repo exposes every committed price at once.
- Do: the owner asks Kraken support in writing: "May I store prices from the public REST `Ticker` endpoint in a public GitHub repository and show them on a non-commercial public web page, with attribution?" Keep the answer. Do not rely on the address `marketdata@kraken.com` from a search snippet. UNVERIFIED. Use the support form listed on a Kraken page.
- Options if no answer or "no": the owner decides to accept the risk in writing (ADR 0001 open question 3), to pick another source with a clear licence, or to change the plan. This checklist does not choose.
- Meanwhile: the owner has decided to proceed with real data (see the last bullet of this item).
- Owner decision (2026-10-29): the owner sends the written request to Kraken first. No real price data is committed to the public repo until Kraken answers. Status: request sent. Kraken support sent an automated reply only (it asks for company, reason for a partnership and country, and says the request goes to the business development team). This is not an answer and not permission. (The gate was replaced by the owner decision in the last bullet.) Record the date of the human answer and its text here.
- Owner decision (2026-10-29, later): everything runs in the public repo with real data, without waiting for Kraken. The gate above no longer blocks. The request to Kraken stays open. An answer of "no" would be a reason to review the choice (ADR 0002 Revision 2, point 9).

### 7b. Coin Metrics written answer (non-blocking; a test source)

- Why: a second round of research found no clearly permissive free source. Coin Metrics has the most open licence (CC BY-NC 4.0 on the data) but its Terms of Use bar publishing without written approval (ADR 0002 Addendum A).
- Do: the owner asks Coin Metrics in writing whether a non-commercial public dashboard and a public history of its Community API Reference Rates (USD) are allowed, with attribution. Their terms page now redirects to Talos, so use the contact form on the live site. Keep the answer. Record the date sent, the date of the answer and the answer here.
- Also: add the Coin Metrics endpoint to the runner probe (item 3): one call for the 10 assets with `ReferenceRateUSD`, and record the HTTP status and rate-limit headers.
- Done when: an answer is recorded. It becomes blocking if Coin Metrics wins the test, or if Kraken answers "no" or never answers and the owner still wants a public repo.

### 8. Repository settings (non-blocking)

- On the real repo: confirm secret scanning and push protection are on. Turn on "Keep my email addresses private" and "Block command line pushes that expose my email". Set Actions notifications to "Only notify for failed workflows". Turn on the Actions policy that requires full-SHA pinning. Add the rulesets from test 6.
- Done when: a screenshot or note shows each setting.

### 9. 60-day canary (non-blocking, long)

- Why: the keepalive step rests on an assumption (ADR 0005 D7).
- Do: at the start of the pilot, add a second throwaway public repo with a daily cron and no human commits. Variant A: bot commits to the default branch. Variant B: bot commits only to a non-default branch. Variant C: no commits at all. Note the dates. Check after 61 days whether each workflow is disabled.
- Done when: results are added to ADR 0005. Until then, keep the keepalive step in the design.

### 10. Re-check the coin list and Kraken result keys (non-blocking)

- Run the catalogue check again just before coding: CoinGecko top 25, USD pairs and `online` status on Kraken. Confirm the ten coins and the result keys for BNB, SOL, DOGE, LINK and ADA (ADR 0002 table, partly from convention). Also confirm the Coinbase product ids, Bitstamp markets and Coin Metrics assets for all ten coins (ADR 0002 per-source table; Coin Metrics was tested only for btc, eth and sol).

### 11. Phone check of the dashboard (non-blocking)

- After the first page exists: open it on a real phone in light and dark mode. Check the uPlot tooltip on touch, a 90-day hourly series (about 2,200 points), the banners, and keyboard focus. Fix or switch library (ADR 0008).

### 12. Versions on the day of coding (non-blocking)

- Check the runner image state (`ubuntu-latest` migration ends 2026-11-19), the latest first-party action majors and their SHAs (ADR 0009 D3), the Node version on the image (`node --version`, expected 24.22.x) and tool versions (typescript, eslint, prettier, knip, markdownlint-cli2, check-jsonschema, actionlint, zizmor). Update the ADR text if they changed.

### 13. Real repo size after 4 weeks (non-blocking)

- Compare the GitHub API `size` and a fresh clone with the model in ADR 0004 (about 73 KB per day at 15 minutes with 10 coins). Re-fit if it is more than 30% off.

### 14. Owner decisions (non-blocking)

- Confirm the code licence (MIT proposed). Write down the risk acceptance for the Actions grey area (ADR 0001). Decide who watches the dashboard banner.
- Confirm the gate thresholds and the 14-day length of the source test, and that the rows of the non-chosen sources stay in `data` for good (ADR 0002 Revision 2, open questions 7, 9 and 11).

### 15. Four-source test and the choice of one source (blocking for the stored source)

- Why: the owner wants to choose the stored source by measurement, not by reading terms (ADR 0002 Revision 2).
- Needs first: item 3 (runner probe) and item 6 (bot push) done, and the collector in test mode (code, outside these ADRs).
- Do: use the `data` branch from item 6 (standard runners are free in a public repo). Run a `dry_run` of all four sources. Then run the collector with `stored_sources` set to Kraken, Coinbase, Bitstamp and Coin Metrics at the default cron for 14 days (ADR 0005 D10; file layout in ADR 0004 D7).
- Measure: the gate and the score of ADR 0002 Revision 2, points 7 and 8: availability, share of 429 or block responses, longest failure streak, deviation from the consensus of the other sources per coin (p50, p95, maximum, points more than 1% off), freshness where the source gives a time, latency p50 and p95, requests per run. Build the results table with a throwaway analysis script and keep it in your notes.
- Pass: at least one source passes the gate. If fewer than two pass, activate the reserves in order: CoinGecko Demo, CoinMarketCap Basic, Coinranking. The owner creates the keys and secrets (ADR 0009 D2).
- Terms: write each source's terms status next to its result (ADR 0002 Revision 2, point 9). A source with an explicit prohibition needs the owner's decision before it goes to production.
- Done when: the owner picks one source, ADR 0002 gets a Revision 3 with the numbers, and ADR 0004, 0005, 0007, 0009 and the index are updated for that single source.

## Results so far (2026-10-29)

Details, tables and run links are in [g2-results.md](../implementation/g2-results.md).

| Item | Status                                                                                                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2    | Partly done: a manual run deployed Pages from a public Free-plan repo. A scheduled run is still open.                                                                   |
| 3    | First sample done: Kraken, Coinbase, Bitstamp, Coin Metrics and CoinGecko all answered HTTP 200 with 10 of 10 coins from a real runner. Rates need the scheduled probe. |
| 4    | Running since 2026-10-29T17:36:05Z. Read the result after 72 hours.                                                                                                     |
| 5    | Issues created and a run failed on purpose. The owner must record which emails arrived.                                                                                 |
| 6    | Done: all six checks behave as designed. The bot email is `41898282+github-actions[bot]@users.noreply.github.com`.                                                      |
| 9    | Running since 2026-10-29. Read the workflow state after 61 days.                                                                                                        |
| 12   | Runner image `ubuntu26/20261025.179.1` (and `20261026.180.1`) with Node `v24.22.1`. The pinned label `ubuntu-26.04` exists.                                             |
