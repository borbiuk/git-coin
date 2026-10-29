# ADR 0005: Schedule and workflow design

- Status: Proposed (the interval must be confirmed by the pilot in the checklist)
- Date: 2026-10-29
- Scope: cron interval, run reliability, concurrency, idempotency, timeouts, heartbeat, manual trigger, backfill, Pages deploy wiring, 60-day rule.

Source grades: [A] official docs, [B] own measurement, [C] first-hand report, [D] blog or vendor.

## Context

The owner wants collection "as often as possible" inside GitHub's rules. The policy side is in ADR 0001. This ADR finds the interval from evidence, not from a guess. The main finding is that the documented minimum (5 minutes) is not a delivery rate. As of 2026-10-29 GitHub often delivers far fewer scheduled runs than the cron asks for.

## Decision Drivers

1. Stay inside policy (ADR 0001) with a margin.
2. Get the most real data points per day that the platform actually delivers.
3. Keep commits, repo growth and Issues manageable.
4. Detect silent stops. Scheduled runs that never start create no failure and no email.
5. Free plan.

## Facts

### Documentation [A]

- Minimum interval: "once every 5 minutes". Runs in UTC by default (an IANA time zone key is now supported). Only on the default branch. Not supported: `@hourly` and similar aliases.
- "The `schedule` event can be delayed during periods of high loads of GitHub Actions workflow runs. High load times include the start of every hour." and "If the load is sufficiently high enough, some queued jobs may be dropped. To decrease the chance of delay, schedule your workflow to run at a different time of the hour."
- No timing guarantee or SLA is stated.
- Scheduled workflows in a public repo are disabled after 60 days without "repository activity" (undefined).
- Failed-run emails for a scheduled workflow go to the user who last modified (or initially created; the docs differ) the cron line. A run that never starts creates nothing, so there is no email.
- The GitHub status feed listed 11 Actions-related incidents between 2026-10-01 and 2026-10-26 (feed covers 2026-09-20 to 2026-10-28). The 2026-10-28 changelog says Linux jobs now spread over more cloud providers to reduce queue times. It does not mention the `schedule` event. No changelog announces a change to schedule throttling.

### Measured delivery (public API, 2026-10-27 to 2026-10-29) [B]

Method: `gh api repos/OWNER/REPO/actions/runs?event=schedule` (read-only). The list does not say which cron tick a run belongs to, so I measured gaps between runs and runs per day versus ticks per day. Dropped ticks are invisible. Repos found by code search for cron strings; the sample is biased (small hobby repos, one day, a Tuesday). Do not read the percentages as population statistics.

Two long-running `*/5` git-scraper repos (last 1,000 scheduled runs each, about 10 days):

| Repo                                 | Median gap | p90  | p99  | Max   | Gaps of 30 min or more | Runs per day                 |
| ------------------------------------ | ---------- | ---- | ---- | ----- | ---------------------- | ---------------------------- |
| jxeeno/nsw-livetraffic-historical    | 11.9 min   | 22.6 | 38.0 | 115.7 | 29                     | 96 to 99 typical (66 to 139) |
| jxeeno/nsw-service-alerts-historical | 12.7 min   | 24.4 | 46.8 | 107.8 | 40                     | 84 to 91 typical (65 to 123) |

Shortest gap seen: 7 minutes. Delay is before the run is created, not in runner allocation (job queue median 2 seconds).

One-day sample of public workflows (runs created on 2026-10-27 per workflow):

| Cron          | Ticks per day | Workflows with runs (of 60) | Median runs per day | Most common  | Best seen     |
| ------------- | ------------- | --------------------------- | ------------------- | ------------ | ------------- |
| `*/5`         | 288           | 14                          | 5.5                 | 5 (5 of 14)  | 123, 113, 106 |
| `*/10`        | 144           | 22                          | 5                   | 5 (15 of 22) | 91, 86        |
| `*/15`        | 96            | 26                          | 5                   | 5 (18 of 26) | 32, 14        |
| `*/30`        | 48            | 28                          | 5                   | 5 (20 of 28) | 51, 47, 47    |
| `0 * * * *`   | 24            | 26                          | 5                   | 5 (18 of 26) | 47, 25, 24    |
| `0 */6 * * *` | 4             | 31                          | 4                   | 4 (29 of 31) | 8, 5          |

Reading: for any cron shorter than 6 hours, the most common result was exactly 5 runs per day (one every 4.8 hours). Only a minority got near their ticks. I could not find what separates the two groups (owner type, stars, age and pushes were mixed). The cause is UNVERIFIED. A 15-minute cron's best case in this sample (32 of 96) was lower than the healthy 5-minute repos (about 96 to 99 of 288). Two popular repos that commit every run (barry-far/V2ray-Config `*/15`, vakhov/fresh-proxy-list `*/10`) dropped from about 280 runs per week to 31 to 50 per week after 2026-08-26.

### Community evidence [C]

- Discussion 207346 (opened 2026-09-09): runs dropped and delayed by hours since 2026-08-26. After the change, typical delays were 1h42m to 8h. No GitHub staff reply, no resolution as of 2026-10-25. Manually dispatched runs started within seconds.
- Discussion 206019: same symptom, 15 to 41 minutes late before 2026-08-26, then 3 to 10 hours late.
- Discussion 185355 (2026-01-26): the only staff statement found says a related change was rolled back and "Any commit pushed to the default branch will resync the impacted scheduled workflows." Users later report a `*/5` cron running every 40 to 50 minutes. One user moved to an external scheduler calling the dispatch API and got every slot within about 35 seconds.
- a-novel-kit/.github issue 288 (2026-10-12): `*/15` produced 11 runs in 48 hours instead of about 192. Closed as not planned.
- Moving the minute away from :00 did not help in the August reports. It did help in a one-repo daily-cron report. [C]/[D]

### Cost of one run [B]

- Minimal job (checkout, small script, push): 6 to 26 seconds in total, 2 to 6 seconds waiting for a runner. A job that checks out full history (`fetch-depth: 0`) of a repo that commits every run took a median of 404 seconds for checkout alone. Use shallow checkout.
- Standard runners are free in public repos [A]. For a private repo each job is rounded up to a whole minute and the Free plan gives about 2,000 Linux 2-core minutes (my arithmetic from $12 and $0.006 per minute).

## Considered Options (candidate intervals)

Monthly minutes assume one billed minute per run and one job per run, 30-day month. In a public repo they cost nothing. Our design has two jobs, so the private-repo figure would be up to twice as large for runs that publish.

| Interval | Ticks per day | Billed min per month (private equivalent) | Commits per day (if all delivered) | Growth 1 / 3 / 5 years, every run | Delivery evidence                                                                       | Skipped-run risk                                                                 |
| -------- | ------------- | ----------------------------------------- | ---------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 5 min    | 288           | 8,640                                     | 288                                | 82 / 247 / 411 MB                 | healthy repos about 96 to 99 runs per day (33%); median 5 per day in the one-day sample | high; 3 times more ticks than 15 min for at most about 20% more delivered points |
| 10 min   | 144           | 4,320                                     | 144                                | 41 / 123 / 206 MB                 | best seen 91 of 144 (63%)                                                               | high                                                                             |
| 15 min   | 96            | 2,880                                     | 96                                 | 27 / 82 / 137 MB                  | best seen 32 of 96 in the sample; a known healthy workflow was not found                | high in the throttled group; medium otherwise                                    |
| 30 min   | 48            | 1,440                                     | 48                                 | 13.7 / 41 / 68 MB                 | 3 of 28 got 47 to 51 of 48; about 98% in healthy repos                                  | lowest of the sub-hourly choices                                                 |

The "at most 20% more points" is my estimate: healthy `*/5` repos delivered about one run per 12 to 13 minutes (median gap) while a perfect `*/15` would deliver one per 15 minutes. The sample is two repos by one author, so treat it as a rough bound, not a rule. It is the only evidence on the delivered cadence, and it says the delivered cadence saturates near one run per 10 to 15 minutes even for healthy repos.

## Decision Outcome

### D1. Interval

- Default: every 15 minutes at off-peak minutes: `cron: '3,18,33,48 * * * *'` (96 ticks per day).
- Fallback: every 30 minutes at off-peak minutes: `cron: '7,37 * * * *'` (48 ticks per day).
- Never use minute 0 or 30, which GitHub names as high-load times (it names "the start of every hour").

Why 15 minutes, in numbers and sources:

1. Policy floor is 5 minutes (documentation). Policy ceiling is vague: "excessive automated bulk activity" has no number (ADR 0001). At 15 minutes we make 0.07 pushes per minute against a recommended maximum of 6.
2. Delivery: healthy 5-minute workflows delivered about one run per 12 to 13 minutes. A 15-minute schedule gives up to 20% fewer points than the best case, and 3 times fewer ticks, commits and chances to look excessive. In the throttled case (5 runs per day) all intervals give the same, so a smaller interval buys nothing.
3. Size: 27 MB per year at 15 minutes versus 82 MB at 5 minutes (upper bounds, ADR 0004).
4. Cost: free in a public repo. If the repo ever became private, 15 minutes (2,880 min per month) exceeds the 2,000-minute allowance. Only 30 minutes (1,440) fits. That is why 30 minutes is the safe fallback.
5. The fallback `*/30` is the sub-hourly cron that was delivered most reliably in the sample (about 98% in healthy repos), and it is the only one that fits the private allowance.

Honesty note: this is a decision from thin evidence. The pilot in the checklist replaces the guess with a measurement on the real account. Decision rule after a 72-hour pilot of three throwaway workflows (`*/5`, `*/15`, `*/30`, each at off-peak minutes) in a throwaway public repo on the same account:

- If `*/15` delivers at least 70% of ticks with a median gap of 20 minutes or less, keep `*/15`.
- If `*/5` delivers at least 1.5 times more points per day than `*/15`, revise this ADR to `*/10` or `*/5`.
- If `*/15` delivers under 50% of ticks but gaps are stable, switch to the fallback `*/30`.
- If all three show the "about 5 runs per day" pattern, no cron value fixes it. Do not choose a smaller number. Escalate: ask the owner whether to accept about 5 hours of freshness or to add an external trigger (see Escalation).

### D2. What the dashboard promises

- No promise of minute-level freshness. The page states "Data is updated about every 15 to 30 minutes when GitHub runs on time. Runs can be late by hours."
- No alert can be promised within minutes either (ADR 0006).

### D3. Workflow shape

One workflow file `collect.yml` on the default branch:

- Triggers: `schedule` (default cron above) and `workflow_dispatch`.
- Top-level `concurrency: group: collect`, `cancel-in-progress: false`. With the default queue, at most one run is running and one is pending. A newer tick replaces a pending tick. A running job is never killed in the middle of a push. This is the "skip if previous run is still active" rule. A tick replaced while pending leaves no data, which is fine. [A] Whether a pending-replaced scheduled run shows as "cancelled" is UNVERIFIED for scheduled runs (checked only for pull request runs). The pilot checks it.
- Top-level `permissions: {}`. Each job asks for what it needs (ADR 0009).
- Guard on every job: `if: github.repository == 'borbiuk/git-coin'` (forks).
- Job `collect` (`timeout-minutes: 10`, normally under 60 seconds):
    1. Checkout `main` (shallow) to `code/`. Checkout `data` (shallow) to `data/` with credentials kept for the push.
    2. Run the collector (fetch the sources in parallel, validate, append rows and the request log, update `state/status.json`). The collector is `src/collect.ts` (CLI in `docs/implementation/plan.md`, section 3.4).
    3. Check the append-only guard, commit on `data`, push with up to 3 retries (ADR 0004). A rejected push redoes the append and the commit message is built after the last write.
    4. After the data push, run the alert step (ADR 0006) and the `no data` Issue sync. They may create or comment on Issues. The alert state goes into its own commit `state: alerts <ts>`, only when it changed. A failure here never blocks the price commit (Issue calls inside the retried write could be doubled, so they come after the push).
    5. Set a job output `should_publish` if the last publish was 30 minutes ago or more (from `status.json`), the phase is production and `features.publish` is on.
- Job `publish` (`needs: collect`, only if `should_publish`; `permissions: contents: read, pages: write, id-token: write`; `environment: github-pages`): build the site data from `data` (ADR 0008), upload the Pages artifact, deploy.
- Pages is deployed inside the same workflow. A push made with `GITHUB_TOKEN` does not trigger other workflows (docs: "events triggered by the `GITHUB_TOKEN` will not create a new workflow run", with `workflow_dispatch` and `repository_dispatch` as exceptions) and does not trigger a Pages build ("Commits pushed by a GitHub Actions workflow that uses the `GITHUB_TOKEN` do not trigger a GitHub Pages build"). So a separate push-triggered deploy would never fire. [A]
- The Pages setting must be "GitHub Actions" as the source. The `github-pages` environment default rule allows the default branch, and scheduled runs run on the default branch. [A]
- The 10-builds-per-hour soft limit "does not apply" to custom workflow deploys. No deploy-rate cap is documented. We deploy at most once per 30 minutes to stay polite. [A]

### D4. Idempotency and timestamps

- Rows carry the real fetch time (ADR 0004). The grid of the cron is not used. Two runs a few minutes apart are both valid. The `min_spacing` guard (300 seconds) skips only near-duplicates.
- A re-run, a retry after a push conflict, or a manual dispatch does not create duplicate rows.

### D5. Timeouts, retries, failure behaviour

- HTTP: 10-second timeout, one retry after 2 seconds, never more than one retry. Total network budget per run: about 45 seconds. HTTP 429 means skip that source for this run.
- Job `timeout-minutes: 10` (default is 360, too long).
- Expected data failure: exit 0, write nothing, count the failure (ADR 0004 D4).
- Unexpected exception: exit non-zero. The owner gets a failed-run email if the notification setting is on (below).

### D6. Heartbeat: how to detect silent stops

Scheduled runs that never start create no failure. Defences, in order:

1. `state/status.json` carries `last_point_at`, `last_run_at`, `consecutive_failures`, `last_publish_at`. It goes into the Pages artifact.
2. The dashboard compares `last_point_at` with the browser clock. It shows a visible banner (ADR 0008): "delayed" if older than 120 minutes, "stopped" if older than 6 hours. 120 minutes comes from the longest gap of 116 minutes seen in healthy repos. This works even when Actions is down, because it does not depend on Actions.
3. Failed-run emails: the owner sets Settings, Notifications, Actions to "Only notify for failed workflows" (this covers script errors, not silent drops). Notifications go to the user who last edited the cron line. Commit the cron line as the owner (not by a bot).
4. A second scheduled "watchdog" workflow is rejected. It has the same throttle (my measurements show no exception).
5. An outside dead-man's switch (a free external ping monitor) is the strongest detector, but it is a new service and is out of scope (see Out of scope in the index).

### D7. 60-day auto-disable

- GitHub does not define "repository activity". Whether a bot commit with `GITHUB_TOKEN` counts is UNVERIFIED, and so is whether a commit on a non-default branch counts.
- Mitigation: the `collect` job checks the last commit date on `main`. If it is older than 30 days, it makes an empty bot commit on `main` (`Keep schedule active` (same title rules as pull request titles, see AGENTS.md)) and pushes. This relies on one assumption only: a bot commit on the default branch counts. This is cheap (about 12 commits per year). It requires that `main` is not protected with required pull requests (ADR 0009).
- Do not use the blocked keepalive action. If the workflow is ever disabled: Actions tab, select the workflow, "Enable workflow" (or `gh workflow enable`).
- The checklist starts a canary at the start of the pilot to learn the truth after 60 days.

### D8. Manual trigger and backfill

- `workflow_dispatch` inputs: `dry_run` (boolean, default false) and `mode` (`collect` or `backfill`, default `collect`).
- Dry run: fetch and validate, print what would be written, write nothing, create no Issue, do not publish.
- Backfill is manual only and is a later feature. Design: for each coin, find the gap since the last stored row. Fetch Kraken `OHLC` with 15-minute candles (at most 720 candles, 7.5 days). Insert candle-close rows with `src=kr-ohlc` and the candle close time as `ts`. Merge in sorted order, skip timestamps within `min_spacing` of an existing row. Gaps older than 7.5 days stay gaps. This is the only path that is not append-only, so it is never scheduled, and the append-only guard is relaxed only for this mode.
- Backfill uses Kraken data, so it carries the same terms question as ADR 0002.

### D9. Escalation if the platform stays throttled

If the pilot or live data shows far fewer runs than the schedule asks, the choices are (decide with the owner, not here): accept the freshness; trigger `workflow_dispatch` from an outside scheduler (user reports show on-time starts; it needs a token as a secret and an outside service); or move the collector off GitHub Actions. This ADR does not decide that.

### D10. Source test phase (ADR 0002 Revision 2)

- The test uses the same workflow shape as D3 with these changes: it runs on the real public repo and commits to `data` like production; the collector fetches four sources in parallel (13 requests per run); there is no alert step; the `publish` job and Pages work as in production when `features.publish` is on (the page shows the primary source only); each run also writes the request log (ADR 0004 D7).
- The network budget of D5 stays at about 45 seconds because the sources run in parallel. Each source has its own timeout, one retry and no tight loops. Coinbase requests run at most 4 at a time.
- Cadence: the default cron of D1, for 14 days. A tick that GitHub drops or delays is simply a missing sample. The test measures the sources, not the schedule.
- The schedule pilot (checklist item 4) stays separate. It runs in a public throwaway repo, writes no price data (only timestamps) and compares 5, 15 and 30 minutes. The source test runs the default cron on the real repo, so it also shows the delivery of that cron. Use it to cross-check the pilot, not to replace it (open question 7).
- `workflow_dispatch` with `dry_run` works as in D8 for a quick check of all four sources before the 14 days start.

## Consequences

- Good: the schedule is justified from sources and measurements, and it says openly that the delivered rate may be lower than asked.
- Good: runs are short, single-writer, idempotent and polite to GitHub.
- Bad: if `*/15` is throttled like other repos, the owner gets about 5 points per day. The dashboard will show it honestly.
- Bad: alert latency may be hours (ADR 0006).
- Bad: two jobs per run double the private-repo minutes (not a cost in a public repo).
- Open: the 60-day rule and the empty-commit mitigation rest on an assumption.

## Sources (access date for all: 2026-10-29)

- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule [A]
- https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows [A]
- https://docs.github.com/en/actions/concepts/security/github_token [A]
- https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow [A]
- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency [A]
- https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs [A]
- https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications [A]
- https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages [A]
- https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits [A]
- https://docs.github.com/en/billing/concepts/product-billing/github-actions and https://docs.github.com/en/billing/reference/actions-runner-pricing [A]
- https://docs.github.com/en/actions/reference/limits [A]
- https://www.githubstatus.com/history.atom (parsed locally) [A]
- https://github.blog/changelog/2026-10-28-github-actions-adds-multi-cloud-compute-to-improve-reliability [A]
- https://github.com/orgs/community/discussions/207346, /206019, /185355 [C]
- https://github.com/a-novel-kit/.github/issues/288 [C]
- https://github.com/tamucsa/points/issues/34 [C]
- https://upptime.js.org/blog/2021/01/22/github-actions-schedule-not-working/ [D] (old)
- https://dev.to/ji_ai/github-actions-cron-was-late-30-nights-straight-then-skipped-one-4751 [D] (one repo)
- GitHub REST API run lists for jxeeno/nsw-livetraffic-historical, jxeeno/nsw-service-alerts-historical and about 180 other public workflows, 2026-10-27 to 2026-10-29 [B]
- https://docs.kraken.com/api/docs/rest-api/get-ohlc-data [A]

## Open Questions

1. What delivery rate does a new workflow on this account get at 5, 15 and 30 minutes? (Pilot.) The pilot started on 2026-10-29T17:36:05Z in `borbiuk/git-coin-pilot`. Read it after 72 hours (`docs/implementation/g2-results.md`).
2. Do bot commits (default branch, and the `data` branch) count as repository activity?
3. Does a pending run replaced by concurrency appear as "cancelled" for a scheduled workflow? Seen on 2026-10-29 for `workflow_dispatch` runs: three starts in a row gave one running, one cancelled and one pending run. Not yet seen for a scheduled run.
4. Does an Issue created by `GITHUB_TOKEN` email the owner? (ADR 0006, checklist.) It decides whether the alert path works at all.
5. If delivery stays at about 5 runs per day, does the owner want an external trigger or accept the freshness?
6. The workflow is pinned to `ubuntu-26.04` (ADR 0003). Does the pilot show any difference in start time or delivery against `ubuntu-24.04`?
7. Does the delivery of the source test (real repo, default cron) match the pilot's numbers? A cross-check only (D10).
