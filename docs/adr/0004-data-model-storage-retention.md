# ADR 0004: Data model, storage and retention

- Status: Proposed
- Date: 2026-10-29
- Scope: file format, file layout, branch for data, commit policy, repo growth, retention, time handling, idempotency, validation.

Source grades: [A] official docs, [B] own measurement or calculation, [C] first-hand report, [D] blog or news.

## Context

Git history is the price history. A collector appends one price per coin per run. The platform delivers runs at an uneven rate (ADR 0005). Timestamps must be real fetch times. The repo is public and must stay small and cheap to clone. The dashboard reads derived JSON, not the raw files (ADR 0008).

## Decision Drivers

1. Repo size far below the 1 GB recommendation for many years.
2. Git history stays usable (no noise in the code history).
3. Append-only writes. Safe to re-run. Hard to corrupt.
4. Readable diffs and files. No new dependencies.
5. Simple to downsample for the dashboard.

## Facts

### GitHub limits [A]

- Repos "ideally less than 1 GB, and less than 5 GB is strongly recommended". Files over 50 MiB warn, over 100 MiB are blocked. Repository limits page: `.git` recommended 10 GB, push size enforced at 2 GB, recommended 6 pushes per minute. The two pages disagree. We use 1 GB / 5 GB as targets.
- The Commits tab shows at most 10,000 commits. No commit-count limit is stated.
- Real examples: nytimes/covid-19-data about 10.2 GB and CSSEGISandData/COVID-19 about 8.7 GB (GitHub API `size`) [B]. A QuantEcon repo grew to 4.2 GB from 193 Pages deployments and was fixed with an orphan commit [C]. The Rust crates.io index squashed 100k+ commits into one in 2018 [C].
- Simon Willison on Hacker News: soft limit about 1 GB; above 5 GB support may send a polite email [C].

### My size measurement [B]

Method: a scratch git repo, git 2.56.0 (same as the runner image). Synthetic prices for 10 coins (geometric random walk, 0.15% sigma per 5 minutes, which matches the real 5-minute standard deviation of 0.12 to 0.20% I measured on Binance data). One real `git commit` per tick. Then `git gc` with default settings. Size = sum of pack files. Scripts were in the scratchpad (not kept in the repo).

| Layout                       | Interval | Commit policy | Days | Pack size | Per day |
| ---------------------------- | -------- | ------------- | ---- | --------- | ------- |
| single file, `ts,coin,price` | 5 min    | every run     | 10   | 2.23 MB   | 223 KB  |
| single file, `ts,coin,price` | 5 min    | every run     | 30   | 7.74 MB   | 258 KB  |
| one file per coin            | 5 min    | every run     | 30   | 7.23 MB   | 241 KB  |
| one file per day per coin    | 5 min    | every run     | 5    | 1.13 MB   | 225 KB  |
| one file per day per coin    | 5 min    | every run     | 30   | 6.76 MB   | 225 KB  |
| one file per day per coin    | 10 min   | every run     | 30   | 3.36 MB   | 112 KB  |
| one file per day per coin    | 15 min   | every run     | 30   | 2.24 MB   | 75 KB   |
| one file per day per coin    | 30 min   | every run     | 30   | 1.13 MB   | 37.5 KB |
| one file per day per coin    | 5 min    | hourly batch  | 30   | 0.95 MB   | 31.8 KB |
| one file per day per coin    | 5 min    | daily batch   | 30   | 0.45 MB   | 15.0 KB |
| single JSONL                 | 5 min    | every run     | 10   | 2.34 MB   | 234 KB  |
| SQLite (10 rows per commit)  | 5 min    | every run     | 5    | 3.05 MB   | 610 KB  |

Findings:

1. Per-day files grow linearly (225 KB per day at 5 minutes at both 5 and 30 days). A single growing file grows faster than linearly (10 days 2.23 MB, 30 days 7.74 MB, 3.47x for 3x data). Git keeps a full copy of the file at the start of each delta chain, and chains are capped at depth 50. In the single-file run, 19 full copies took 5.1 MB of 7.7 MB. A crude fit gives about 300 MB after one year and about 6 GB after five years for one growing file with a commit per run. That is a warning, not a forecast.
2. Cost per commit is mostly hashes that do not compress. Fit for the per-day layout: about 732 bytes per commit plus about 14.2 KB per day of real data (10 coins at 288 ticks per day, about 4.95 bytes per row). The model predicted 31,821 bytes per day for the hourly batch. Measured: 31,786. It matches the 10, 15 and 30 minute runs within 3%.
3. Batching commits is the largest lever: hourly is 7x smaller than every-run; daily is 15x smaller.
4. SQLite costs about 2.7x more history than CSV for append-only data over 5 days and gives no readable diffs. Not measured for longer.
5. CSV, JSON and JSONL differ by under 10% after gzip. After gzip all row formats cost about 0.7 MB per coin per year at 5-minute data.
6. A shallow clone (`--depth 1`) plus a push works. When two writers append to the same file, `git pull --rebase` stops with a conflict. One writer at a time is required.
7. Limits of the measurement: local `git gc` is not GitHub's server-side packing (undocumented). Random-walk digits may be as incompressible as real prices, but real alt-coin prices may have more digits. Only 10 coins were measured. The tests used `ts,price` rows without a `src` column. A constant column compresses well, but this is UNVERIFIED. Re-measure after 4 weeks of live data.

## Considered Options

### Storage format

| Option       | Pros                                                           | Cons                                             |
| ------------ | -------------------------------------------------------------- | ------------------------------------------------ |
| CSV (chosen) | line-based diffs, append-only, no parser package needed, small | needs a header per file; no types                |
| JSONL        | typed, one object per line                                     | larger raw (about +10 to 40%), same gzip size    |
| JSON array   | easy for browsers                                              | rewritten on every commit; bad diffs             |
| SQLite       | queries                                                        | binary, 2.7x history growth (measured), no diffs |
| Parquet      | compact for analytics                                          | needs `pyarrow`; overkill                        |

### File layout

| Option                             | Pros                                                                         | Cons                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| one file total                     | simplest                                                                     | grows super-linearly in git (measured); one huge file; rebase conflicts on every concurrent write |
| one file per coin                  | simple names                                                                 | same super-linear growth                                                                          |
| one file per day per coin (chosen) | linear growth (measured); files bounded; small diffs; old files never change | more files (10 per day, 3,650 per year, well under 3,000 per directory because of the Y/M/D tree) |
| one file per day, all coins        | fewer files                                                                  | not measured; fewer files per commit may be cheaper (UNVERIFIED)                                  |

### Where to commit

| Option                            | Pros                                                                                                             | Cons                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `main`                            | simplest; bot commits are on the default branch                                                                  | 96 bot commits per day bury code history; code clones fetch all data; branch rules mix code and data |
| long-lived `data` branch (chosen) | clean code history; data branch can be squashed or archived without touching code; no branch protection conflict | second branch to checkout; 60-day rule effect unknown (see ADR 0005)                                 |
| orphan branch squashed often      | smallest clone                                                                                                   | loses history unless archived; destructive                                                           |
| separate repo                     | total isolation                                                                                                  | two repos to run; Pages repo link; out of scope                                                      |

### Commit policy (E in the brief)

| Option                                                                        | Effect                                                                                                                                                                                       | Verdict                      |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| a) commit every successful run                                                | 27 MB per year at 15 minutes; 96 commits per day; simple; no state; no data loss if a run dies                                                                                               | chosen, on the `data` branch |
| b) commit only if the price changed by more than epsilon                      | prices change on nearly every tick; saves little; adds a rule that makes gaps look like "no change"                                                                                          | rejected                     |
| c) buffer several points and commit in batches                                | 3 to 7x smaller; needs a buffer (cache, artifact or file) and publishes late; with throttled schedules (as few as 5 runs per day) a batch may never fill; data is lost if the buffer is lost | rejected for v1              |
| d) raw points on a `data` branch, only compact aggregates on the Pages branch | raw commits do not touch code history; Pages artifact carries aggregates only                                                                                                                | chosen together with (a)     |

Why (a) with (d): at 15 minutes the size is small (table below). The real problem of every-run commits is history noise, and (d) removes it. Batching (c) saves megabytes but adds failure modes. Trigger to switch to hourly batching: see Decision Outcome.

### Growth estimates

Model: 10 coins, per-day-per-coin files, bytes per day = 732 x commits per day + 14.2 KB x (ticks per day / 288). Validated against runs at 10, 15 and 30 minutes (within 3%). [B] Assumes every tick is delivered. Delivered ticks are fewer (ADR 0005), so these are upper bounds.

| Interval | Commit policy | Commits per day | KB per day | 1 year  | 3 years | 5 years |
| -------- | ------------- | --------------- | ---------- | ------- | ------- | ------- |
| 5 min    | every run     | 288             | 220        | 82 MB   | 247 MB  | 411 MB  |
| 5 min    | hourly        | 24              | 31         | 11.6 MB | 34.8 MB | 58 MB   |
| 10 min   | every run     | 144             | 110        | 41 MB   | 123 MB  | 206 MB  |
| 10 min   | hourly        | 24              | 24         | 9.0 MB  | 27 MB   | 45 MB   |
| 15 min   | every run     | 96              | 73         | 27 MB   | 82 MB   | 137 MB  |
| 15 min   | hourly        | 24              | 22         | 8.1 MB  | 24 MB   | 41 MB   |
| 30 min   | every run     | 48              | 37         | 13.7 MB | 41 MB   | 68 MB   |
| 30 min   | hourly        | 24              | 19.5       | 7.3 MB  | 22 MB   | 36 MB   |

Commit counts per year at 100% delivery: 105,120 (5 min), 52,560 (10 min), 35,040 (15 min), 17,520 (30 min). All sizes are far below 1 GB. Coins scale the data part about linearly (not measured for N other than 10; UNVERIFIED).

## Decision Outcome

### D1. Format and layout

- CSV, one file per day per coin, append-only.
- Branch `data`, an orphan branch created once. The collector checks it out with `fetch-depth: 1`.
- Paths on `data`:
    - `data/raw/YYYY/MM/DD/<ID>.csv` (UTC date of `ts`; `<ID>` is the upper-case ticker, for example `BTC.csv`)
    - `state/status.json` (last run, last point, failures, last publish time)
    - `state/alerts.json` (alert cooldowns, open Issue numbers, daily counter; see ADR 0006)
- Header line of each daily file: `ts,price,src,age_s`.
- Row examples (shape only): `2026-10-29T14:03:12Z,81232.79,kr,` and `2026-10-29T14:03:13Z,81230.10,cb,2`.
- `age_s` is the age of the source's own timestamp at fetch time, in seconds. It is empty when the source gives none (Kraken). Details in D7.
- `ts` is the real fetch time in UTC, ISO 8601, second precision, always with `Z`. It is never the scheduled time and never a grid time.
- `price` is the source string, copied as is. No float formatting. Quote currency is USD for all coins (ADR 0002), so it is not a column. Quote is written in the config and in `status.json`.
- `src` is a short source code: `kr` Kraken, `cb` Coinbase Exchange, `bs` Bitstamp, `cm` Coin Metrics. Backfill rows use `kr-ohlc` (Kraken, see ADR 0005) or `bs-ohlc` (Bitstamp 15-minute candles from 2024-01-01 to 2026-10-28, `ts` is the candle close time, `age_s` is empty; written once by `tools/backfill-bitstamp.ts`). The four-source test stores all four in the same files (D7). After the choice, new rows carry the chosen `src` only, and the old rows of the other sources stay.

### D2. Commit policy

- One commit per run, on `data`. Commit message: `data: 2026-10-29T14:03Z 10 rows` (simple English, no personal data). A run where every source failed appends no price rows but still commits `state/status.json` and the request log (D7), so the dashboard and the source analysis see the failure (decided while building the collector, ADR 0005 and `src/collect.ts`). The alert state goes into its own commit `state: alerts <ts>` after the data push, only when it changed.
- No commit of error bodies, and no commit when the run did not change any tracked file.
- The first commit of the day is not special.
- Switch trigger: if the pack size on GitHub exceeds 500 MB, or the `data` branch exceeds 250,000 commits, change to hourly batching or squash old data (see D5).

### D3. Time handling, missed runs, duplicates

- All times are UTC. No local time anywhere.
- Missed runs are not repaired. A gap stays a gap. Charts show gaps (ADR 0008). Alerts do not use data across a gap longer than the window (ADR 0006).
- Duplicate runs: the concurrency group prevents overlap (ADR 0005). As a second guard, before appending a row for a coin, read the last row of today's file. Skip the row if `now - last_ts < min_spacing` (default 300 seconds, configurable). `last_ts` is the last row of the same `src`, so several sources can share one file. This is the idempotency rule. Re-running the same job after a push conflict will skip rows that were already written.
- The exchange timestamp itself is not stored, only its age in `age_s` (D7). Kraken's `Ticker` has none. CoinGecko's `last_updated_at` is used only for the cross-check (reject if older than 15 minutes).
- A clock check: if `ts` is earlier than the last stored `ts` for that coin, do not write the row and log an error.

### D4. Validation (reject, never repair)

A row is written only if all checks pass:

1. The price string matches a strict decimal pattern, converts to a finite number greater than 0 and below 1,000,000,000. The original string is what gets stored.
2. The response HTTP status was 200 and the pair key was present and mapped (ADR 0002).
3. The cross-check, if available, agrees within 2%.
4. The move since the previous stored row is at most 50%. If it is larger, accept it only if the cross-check agrees within 2%. Without a cross-check, reject.
5. The row is not a duplicate (D3).

Four-source test (ADR 0002 Revision 2): checks 3 and 4 are off. Rows are stored as received, and deviations are measured offline.

On a rejected value: write nothing for that coin, count it in `status.json` (`rejected_count`, `last_reject_reason`), and print a log line. When all sources fail, the run writes no price rows, commits only the status file and the request log (D2), exits with code 0 (an expected data failure), and increments `consecutive_failures` in `status.json`. After 4 consecutive failed runs the collector opens one deduplicated Issue `[collector] no data` (label `collector`) and closes it when data returns. An unexpected exception (a bug) exits non-zero so the Actions failure email fires (ADR 0009).

### D5. Retention and downsampling

- Raw rows stay in git (the `data` branch) with no deletion. At the measured rates the size is small.
- The Pages artifact does not carry all raw data. The build step makes (ADR 0008):
    - the last 7 days at full resolution,
    - the last 90 days as hourly last-price points,
    - all history as daily candles (open, high, low, close) per coin.
- The build step reads raw files in memory. If the build takes over 60 seconds, add committed daily rollups on `data` as a follow-up.
- To shrink history later: squash old data into one commit on a new orphan branch and keep a tag snapshot (the Cargo method). Use `git filter-repo` only if something must be removed. Both rewrite history. Do this by hand, once, and only after the owner decides.
- If a coin is removed from config, its history stays (ADR 0007).

### D6. Protection against a bad write

- The data writer is append-only. Before the commit, `git diff --numstat` for `data/raw` must show 0 deleted lines. If not, abort without committing.
- A repo ruleset on `data` blocks force pushes and branch deletion. It does not block normal bot pushes. (Branch protection with required pull requests would block the bot, and `github-actions[bot]` cannot be added to a bypass list. See ADR 0009.)
- Push conflicts: on rejection, reset to `origin/data`, redo the append, push again (at most 3 tries). Do not hand-merge CSV.

### D7. Four-source test on `data` (ADR 0002 Revision 2)

- The test writes to the `data` branch like production: same paths, same append-only rules, no separate test branch (owner decision, 2026-10-29).
- The four-column header of D1 is used from the first commit, so the format does not change after the choice.
- A run appends up to four rows per coin (`kr`, `cb`, `bs`, `cm`). Each row has its own `ts`, taken right after that source's response.
- `age_s` is the number of seconds between the source's own time field and `ts`: Coinbase `time`, Bitstamp `timestamp`, Coin Metrics `time`. It is empty for Kraken, which gives none.
- After the choice, the rows of the non-chosen sources stay in the files and in git history. The writer is append-only, and the rulesets block force pushes, so removing them would need a history rewrite that the owner would have to allow. Readers (dashboard builder, alerts, status) must filter by the chosen `src`.
- A request log is needed because a failed request leaves no price row, and availability cannot be measured from gaps alone. Path: `data/meta/YYYY/MM/DD/requests.csv`, header `ts,src,http,ms,coins_ok,error`. One row per source per run, failures included. `error` is a short code (`timeout`, `http_429`, `http_other`, `parse`, `unmapped`). No response bodies.
- Size estimate: about 4 times one source, so about 290 KB per day and about 4 MB for 14 days (local estimate from the measured 73 KB per day, not a GitHub measurement).

## Consequences

- Good: growth is linear and small. About 27 MB per year at the default (upper bound), 137 MB over five years.
- Good: `main` history stays about the code. `data` can be squashed without touching code.
- Good: each daily file is small, so diffs and the Pages build are cheap.
- Bad: up to 35,000 commits per year on `data`. The Commits tab shows only the latest 10,000. `git rev-list --count` gives the real number.
- Bad: two branches to checkout. A `data` branch commit may not count for the 60-day rule (ADR 0005 has a mitigation).
- Bad: all sizes are local measurements. Real GitHub size may differ.
- Follow-up: re-measure with real data after 4 weeks.

## Sources (access date for all: 2026-10-29)

- https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github [A]
- https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits [A]
- https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits [A]
- https://news.ycombinator.com/item?id=37082289 [C]
- https://simonwillison.net/2020/Oct/9/git-scraping/ [C]
- https://github.com/QuantEcon/lecture-python.myst/issues/647 [C]
- https://internals.rust-lang.org/t/cargos-crate-index-upcoming-squash-into-one-commit/8440 [C]
- GitHub API `size` for nytimes/covid-19-data and CSSEGISandData/COVID-19 [B]
- Own simulations (git 2.56.0, local `git gc`), Binance 5-minute volatility check for the sigma [B]

## Open Questions

1. Real server-side size of the `data` branch after 4 weeks versus the model.
2. Does a commit on a non-default branch count as repository activity for the 60-day rule? (ADR 0005, checklist.)
3. Is `min_spacing` of 300 seconds right when the platform delivers two runs a few minutes apart?
4. Should daily rollups be committed (not only built) once history is long?
5. A single per-day file for all coins may be cheaper than ten files. Not measured. Test if the tree cost looks high.
