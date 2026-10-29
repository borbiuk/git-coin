# ADR 0006: Alert rules and Issue behaviour

- Status: Proposed (the email path must be tested first; see Open Questions)
- Date: 2026-10-29
- Scope: what a "sharp change" is, parameters, Issue deduplication, behaviour after missing data, notification channel, and how the owner learns that the system itself is broken.

Source grades: [A] official docs, [B] own measurement or calculation, [C] first-hand report, [D] blog or vendor.

## Context

When a price moves sharply, the collector opens a GitHub Issue. The owner gets an email. The platform delivers runs unevenly (ADR 0005), so an alert may come hours late. Issues in a public repo are public. Prices stored in the repo are the only input (ADR 0004).

## Decision Drivers

1. Few false alarms. Target: at most 1 to 2 new Issues per day across all coins.
2. Easy to explain ("BTC down 3.4% in 1 hour").
3. Works with sparse and uneven data.
4. No secrets and no extra service in v1.
5. Cannot flood the owner or the repo.

## Facts

### Measured price moves [B]

Method: Binance spot market-data endpoint `https://data-api.binance.vision/api/v3/klines?interval=5m`. Pairs BTCUSDT, ETHUSDT, SOLUSDT, DOGEUSDT. Last 180 days up to 2026-10-29 (51,840 candles per pair, no gaps), close prices only. "1h" is a rolling 12 candles, "24h" is 288 candles. "Events per day" counts distinct episodes (rising-edge crossings of the threshold) divided by 180. One 6-month regime, one exchange, USDT quote. No second source was found, so these numbers are UNVERIFIED by a third party. Our data is Kraken USD at 15-minute sampling, so counts will differ a little.

| Pair | 1h move p50 / p90 / p99 / p99.9 (%) | 24h move p50 / p90 / p99 (%) | Std of 5-min return (%) |
| ---- | ----------------------------------- | ---------------------------- | ----------------------- |
| BTC  | 0.17 / 0.58 / 1.46 / 2.60           | 0.97 / 2.93 / 6.73           | 0.116                   |
| ETH  | 0.22 / 0.74 / 1.97 / 3.89           | 1.21 / 3.94 / 9.40           | 0.155                   |
| SOL  | 0.28 / 0.92 / 2.21 / 3.81           | 1.60 / 4.70 / 10.11          | 0.184                   |
| DOGE | 0.28 / 0.96 / 2.32 / 4.66           | 1.52 / 4.72 / 10.11          | 0.195                   |

Episodes per day:

| Pair | 1h >= 2% | 1h >= 3% | 1h >= 5% | 24h >= 5% | 24h >= 10% |
| ---- | -------- | -------- | -------- | --------- | ---------- |
| BTC  | 0.28     | 0.05     | 0.00     | 0.38      | 0.02       |
| ETH  | 0.58     | 0.28     | 0.03     | 1.03      | 0.12       |
| SOL  | 1.19     | 0.36     | 0.04     | 1.43      | 0.18       |
| DOGE | 1.45     | 0.36     | 0.10     | 1.29      | 0.28       |

Z-score rule (absolute 5-minute return divided by the standard deviation of the previous 288 returns), episodes per day for z >= 3 / 4 / 5: BTC 4.85 / 2.04 / 1.00; ETH 4.51 / 2.12 / 1.17; SOL 4.24 / 1.73 / 0.87; DOGE 4.03 / 1.73 / 0.88. Tails are fat: a "4-sigma" rule fires about twice per day per coin, where a normal distribution predicts about 0.02.

### Platform facts [A]

- Content-creating REST requests are limited to 80 per minute and 500 per hour. `GITHUB_TOKEN` has 1,000 requests per hour per repo. We make a handful per day.
- Events made with `GITHUB_TOKEN` do not start other workflows.
- The owner automatically watches repos they own. Notification triggers include being assigned and being @mentioned. Email delivery depends on the owner's notification settings. There is also a setting for "your own updates". A bot-created Issue is not the owner's own update. The docs do not say whether a bot-created Issue emails a watching owner with no mention and no assignee. UNVERIFIED. Needs a test.
- Failed-run emails for scheduled workflows go to the user who last edited the cron line. A run that never starts creates no email.

## Considered Options

### Definition of "sharp change"

| Rule                                                                                 | Pros                                                                                                       | Cons                                                                                                       |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| % change vs previous point                                                           | trivial, stateless                                                                                         | depends on the interval (15 vs 30 min vs a gap); one bad tick fires it; misses slow grinds                 |
| % change over a time window (1h, 24h), versus the price at the window start (chosen) | independent of the interval; easy to explain; matches how people talk; needs history (already in the repo) | one threshold for all coins is wrong, so per-coin thresholds are needed                                    |
| vs rolling baseline (24h mean or median)                                             | catches "far from normal"                                                                                  | lags; the baseline is polluted by the move itself                                                          |
| z-score / volatility-adjusted                                                        | adapts to each coin and regime                                                                             | tails are fat (about 2 per day at 4 sigma, measured); needs warm-up; harder to explain; one more parameter |

### Notification channel

| Channel               | Cost and limits                                                                                                                                        | Needs                            | Verdict                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ------------------------------ |
| GitHub Issue (chosen) | free; 80 content requests per minute                                                                                                                   | no secrets                       | primary                        |
| Actions failure email | free; goes to the user who last edited the cron line                                                                                                   | owner setting                    | used only for collector health |
| GitHub Discussions    | not checked (UNVERIFIED); needs GraphQL                                                                                                                | -                                | no advantage                   |
| ntfy.sh public server | free; 250 messages per day, 5 emails per day, 4,096-byte messages; the topic name is the password; best-effort uptime; "as long as you don't abuse it" | a secret topic                   | optional later                 |
| Telegram bot          | free; about 1 message per second per chat                                                                                                              | bot token and chat id as secrets | optional later                 |
| SMTP                  | depends on provider; not researched (UNVERIFIED)                                                                                                       | app password as a secret         | most secrets and setup; skip   |

Why Issues are enough for v1: they need no secret and leave a public, searchable record with labels. They are not enough if the owner wants a phone push within a minute, or if the email test fails. Then add ntfy or Telegram through a repo secret (a follow-up decision, not made here).

## Decision Outcome

### D1. Rule

Rolling-window percentage move. For each coin, after each run that wrote a row, compare the new price with the price at the start of the window.

Two rules per coin by default:

| Rule       | Window        | Default threshold | Per-coin defaults |
| ---------- | ------------- | ----------------- | ----------------- |
| `move_1h`  | 60 minutes    | 5%                | BTC 3%, ETH 4%    |
| `move_24h` | 1,440 minutes | 15%               | BTC 8%, ETH 12%   |

Where the numbers come from: BTC 1h >= 3% is 0.05 episodes per day (about once per 20 days). ETH 1h >= 3% is 0.28 per day, so 4% is chosen to be calmer. SOL and DOGE 1h >= 5% are 0.04 and 0.10 per day. 24h >= 10% is 0.02 per day for BTC and 0.12 to 0.28 for ETH, SOL and DOGE, so the alt default is raised to 15% (not measured at 15%). Thresholds for BNB, XRP, LINK, ADA, XLM and LTC were not measured at all. All values are starting guesses from one 180-day window. Tune after 2 to 4 weeks of real alerts. Target: at most 1 to 2 new Issues per day across all coins. My estimate for the start is 0.5 to 1.5 per day (UNVERIFIED).

### D2. Reference price and missing data

- Reference sample: the latest stored sample with `ts <= now - window`, from today's and yesterday's files. It must be no older than `window + ref_tolerance`. `ref_tolerance` is 30 minutes for `move_1h` and 120 minutes for `move_24h`. The 120 minutes come from the longest gap (116 minutes) seen in healthy repos (ADR 0005).
- If no reference exists, do not alert. This covers the first run, a coin added recently, and a gap longer than the window.
- After downtime: no alert from data across the gap. The alert logic resumes when a reference exists again. Moves that happened during the gap are not reported. (Accepted: a false alarm after a long gap is worse.)
- `min_points` (default 2: reference and current) is a parameter. Do not raise it above what the schedule delivers.
- Only validated, stored rows are used (ADR 0004). A bad tick that was rejected cannot alert. No second confirmation delay is added. The CoinGecko cross-check already runs before the write.

### D3. Parameters (all in config, ADR 0007)

- `enabled` (global and per coin)
- `threshold_percent` and `window_minutes` per rule, with per-coin override
- `direction`: `up`, `down`, or `both` (default `both`)
- `cooldown_hours` (default 6)
- `min_points` (default 2)
- `ref_tolerance_minutes` per rule
- `daily_issue_cap` (default 5)
- `auto_close_hours` (default 24)
- severity: `warning` at the threshold, `critical` at 2 times the threshold

### D4. Deduplication and anti-spam

- One open Issue per (coin, direction). The Issue carries labels `alert`, `coin:BTC`, `dir:down`, `window:1h`, `severity:warning`.
- Before creating, list open Issues with those labels using the REST list endpoint (not the Search API, which is not consistent right after a write). If one is open, add a comment with the new price instead of a new Issue. A comment is added at most once per `cooldown_hours` for that key.
- A move in the opposite direction opens a separate Issue.
- `state/alerts.json` on the `data` branch stores, per key: last alert time, last comment time, open Issue number, and a per-UTC-day counter of new Issues. It avoids extra API reads.
- Daily cap: after 5 new Issues in one UTC day, create no more. Record the rest in `alerts.json` as `suppressed` so the dashboard can show them.
- Auto-close: if an open alert Issue has had no trigger for 24 hours, the collector comments "No new trigger in 24 hours. Closing." and closes it. This runs in the same job. No extra workflow.
- Labels are created on first use if missing.

### D5. Issue content

- Title template: `[ALERT] BTC down 3.4% in 1h (81,232.79 USD)`.
- Body template (simple English):
    - coin, direction, window, threshold, severity
    - reference time and price, current time and price, source (`Kraken`), quote (`USD`)
    - detected at (UTC). Include "Detected at the time of the run. The move happened between the reference time and this time. Runs can be late."
    - link to the dashboard
    - the line: "Not financial advice. Data may be delayed or wrong."
    - `@borbiuk`
- Assignee: `borbiuk`. Both the mention and the assignment are used to give the email the best chance (see Open Questions). Only values from our own data go into the text. No exchange error strings (ADR 0009).

### D6. Behaviour summary

- First run: no alerts.
- After downtime or when data is missing: no alerts until a reference exists.
- No alert for coins with `enabled: false`.
- Permissions: the alert step needs `issues: write`.

### D7. Failure alerting (the system itself)

See ADR 0005 D6. In short: the dashboard banner (delayed after 120 minutes, stopped after 6 hours), the failed-run email for script errors, and a deduplicated `[collector] no data` Issue after 4 consecutive failed runs. A silent stop of the schedule is not announced by GitHub. An outside dead-man's switch is out of scope.

## Consequences

- Good: simple, explainable rule. One Issue per coin and direction. A daily cap and a cooldown bound the volume.
- Good: no secrets.
- Bad: alerts need a run, and runs can be hours late. Do not use these alerts for trading decisions.
- Bad: a fast spike and reversal inside one gap, or between samples, is invisible.
- Bad: the email path is unproven. If it fails, the alert design needs a second channel.
- Bad: thresholds for six coins are blind guesses.

## Sources (access date for all: 2026-10-29)

- https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api [A]
- https://docs.github.com/en/actions/reference/limits [A]
- https://docs.github.com/en/actions/concepts/security/github_token [A]
- https://docs.github.com/en/subscriptions-and-notifications/concepts/about-notifications [A]
- https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications [A]
- https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications [A]
- https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs [A]
- https://developers.binance.com/docs/binance-spot-api-docs/rest-api/general-api-information (market-data-only base `data-api.binance.vision`) [A]
- https://docs.ntfy.sh/publish/ and https://docs.ntfy.sh/faq/ [A]; ntfy Terms of Service not read (UNVERIFIED)
- https://core.telegram.org/bots/faq [A]
- Own calculation on Binance 5-minute candles, 180 days [B]

## Open Questions

1. Does an Issue created by `GITHUB_TOKEN` email the owner? Test three variants: plain; with `@borbiuk`; with an assignee and a mention. Check both "Watching" and "Participating" email settings. Measure the delay. (Checklist, blocking.)
2. Do failed scheduled runs email the right user, and who is it after the cron line is edited by the owner?
3. Are the default thresholds right for the six unmeasured coins? Tune after 2 to 4 weeks.
4. If the email test fails, which second channel (ntfy or Telegram)? This needs a secret and an owner decision.
5. Should alerts for moves during a long gap be reported when the collector resumes? Current answer: no.
