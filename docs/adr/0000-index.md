# ADR index: git-coin

- Date: 2026-10-29
- Repository: github.com/borbiuk/git-coin (public, personal account `borbiuk`)
- All ADRs have the status "Proposed". Nothing has been tested on a real runner yet. The checklist in `pre-implementation-checklist.md` turns the guesses into measurements.

## Owner decisions so far

- 2026-10-29: the owner asks Kraken in writing about public use of its data. Gate: no real price data in the public repo until Kraken answers (ADR 0002, checklist item 7). Replaced by the last bullet below.
- 2026-10-29 (later): four sources are tested at once (Kraken, Coinbase Exchange, Bitstamp, Coin Metrics), then one is chosen. CoinGecko Demo, CoinMarketCap Basic and Coinranking are reserves. The other usable APIs are documented as potential. Storage terms are not scored in the test (ADR 0002 Revision 2 and Addendum B).
- 2026-10-29 (even later): the owner decided to run everything in the public repo with real data, without waiting for Kraken. This replaces the gate in the first bullet. The request to Kraken stays open. The test rows go straight to the `data` branch (no separate test branch), so the rows of the non-chosen sources stay in its history (ADR 0004 D7, ADR 0002 open question 9). Known conflict: Coinbase's terms forbid display of its data (ADR 0002 Revision 2 point 9).
- 2026-10-31: the owner changed the coin list to 27 coins and disabled DOGE and LTC. A coin may be missing on some sources, and its history comes from candles (ADR 0007 D8).

## Summary of the architecture

A scheduled GitHub Actions workflow on `main` runs every 15 minutes at off-peak minutes (fallback: every 30 minutes). A Node.js 24 collector (TypeScript run natively, no runtime dependencies) fetches USD prices for 27 coins from one chosen source, validates them, and appends one CSV row per coin to a per-day file on a separate `data` branch. The source is chosen by a 14-day test of four candidates in the public repo, straight into `data` (Kraken, Coinbase Exchange, Bitstamp, Coin Metrics, ADR 0002 Revision 2). Kraken is the working assumption until then. Each successful run makes one small commit there. When a price moves more than a per-coin threshold over 1 hour or 24 hours, the same job opens (or comments on) one GitHub Issue per coin and direction, assigns and mentions the owner, and applies a cooldown and a daily cap. At most every 30 minutes the workflow builds small downsampled JSON files from the `data` branch and deploys a static GitHub Pages dashboard (plain HTML, one vendored chart library, no build tool) in the same workflow. The dashboard shows how old the data is and warns when it is stale. GitHub delivers scheduled runs far less reliably than the cron says, so every part of the design treats gaps and delays as normal.

## ADRs

| #                                               | Title                                                 | Status   | One-line decision                                                                                                                                                                                                                          |
| ----------------------------------------------- | ----------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [0001](0001-github-policy-compliance.md)        | GitHub policy compliance and public-repo implications | Proposed | No rule bans this design. The rules about "excessive" use have no number, so stay small, polite and documented. Public repo: no secrets, no personal data, Pages and Actions are free.                                                     |
| [0002](0002-data-sources.md)                    | Data sources and exchanges                            | Proposed | Test four sources (Kraken, Coinbase, Bitstamp, Coin Metrics) for 14 days in the public repo (straight into `data`), then store one. Three keyed reserves and 15 more APIs are documented (Addendum B). Ten coins. Data-terms risk is open. |
| [0003](0003-language-and-runtime.md)            | Language and runtime                                  | Proposed | Node.js 24 with native TypeScript, no runtime dependencies, no setup step. Pinned runner `ubuntu-26.04`. Prettier, ESLint, knip, `node --test`, Dependabot (the Hyperfriend tool set).                                                     |
| [0004](0004-data-model-storage-retention.md)    | Data model, storage and retention                     | Proposed | CSV, one file per day per coin, on an orphan `data` branch, one commit per successful run. About 27 MB per year upper bound. Real fetch times in UTC.                                                                                      |
| [0005](0005-schedule-and-workflow-design.md)    | Schedule and workflow design                          | Proposed | Default `3,18,33,48 * * * *`. Fallback `7,37 * * * *`. One concurrency group, idempotent writes, Pages deploy in the same workflow, dashboard-side stale banner. A 72-hour pilot confirms the interval.                                    |
| [0006](0006-alert-rules-and-issue-behaviour.md) | Alert rules and Issue behaviour                       | Proposed | Rolling 1h and 24h percentage move with per-coin thresholds. One open Issue per coin and direction. Cooldown, daily cap, auto-close. The email path must be tested.                                                                        |
| [0007](0007-configuration-and-adding-coins.md)  | Configuration and adding coins                        | Proposed | `config/coins.json` plus a JSON Schema checked in CI. Add a coin by pull request. Disable instead of delete.                                                                                                                               |
| [0008](0008-dashboard-stack-and-metrics.md)     | Dashboard stack and metrics                           | Proposed | Static HTML and vanilla JS with vendored uPlot. No build tool. Same-origin derived JSON. Visible disclaimer and freshness.                                                                                                                 |
| [0009](0009-security-reliability-testing.md)    | Security, reliability and testing                     | Proposed | `permissions: {}` plus per-job grants, no secrets, SHA-pinned first-party actions, append-only guard, unit tests without network, risk register.                                                                                           |

## The interval, in one place

- Default: `3,18,33,48 * * * *` (every 15 minutes). Fallback: `7,37 * * * *` (every 30 minutes).
- Evidence: the documented minimum is 5 minutes. The delivered rate is much lower. Healthy 5-minute workflows delivered about one run per 12 to 13 minutes. For any cron shorter than 6 hours, the most common daily result in a one-day sample was 5 runs. See ADR 0005 for the numbers and the decision rule.
- Policy text it relies on: see ADR 0001 (minimum interval, delay warning, push guidance of 6 per minute, "excessive automated bulk activity", free standard runners in public repos).

## The data sources in one place

- Test now (no key): Kraken, Coinbase Exchange, Bitstamp, Coin Metrics Community. All four are called in every run of the test and stored under their own `src` code.
- Reserves (free key needed, not created): CoinGecko Demo, CoinMarketCap Basic, Coinranking. Used only if fewer than two test sources pass the gate.
- Potential (documented only): Bitfinex, Crypto.com, CoinPaprika and twelve more (ADR 0002 Addendum B, ranks 8 to 22).
- Gate and score: ADR 0002 Revision 2, points 7 and 8. The test is checklist item 15.
- ADR 0006 and ADR 0008 name Kraken and CoinGecko in their examples and labels. Those names follow the choice made after the test.

## Known gaps in verification

- Nothing was tested from a real GitHub runner. Every exchange "reachable from runners" claim is UNVERIFIED except secondary reports of Binance and Bybit blocks.
- Policy pages were read through a text extractor. Quotes must be checked on the live pages.
- Whether bot commits count as "repository activity" for the 60-day rule is UNVERIFIED.
- Whether a bot-created Issue emails the owner is UNVERIFIED.
- The size model comes from local `git gc` runs, not from GitHub servers.
- Price-move statistics come from one 180-day Binance window (USDT quote).
- No free source with a clear written right to store and publish prices was found, after checking about 40 exchanges, aggregators, oracles and free-tier APIs (ADR 0002 and Addendum A).
- The ranking of usable APIs (Addendum B) is my judgement. It is replaced by measured numbers after the four-source test.

## Out of scope / follow-ups (listed, not decided)

1. An outside dead-man's switch or an outside scheduler (calling `workflow_dispatch`) if GitHub keeps throttling schedules. Needs a service and a token.
2. A second notification channel (ntfy or Telegram) if the Issue email test fails. Needs a secret.
3. Asking Kraken (and GitHub Support, optionally) for written confirmation. A person must do this.
4. A second source after the test, stored or only as a run-time cross-check (ADR 0002 open question 8). Terms of Coinbase, Bitstamp and Coin Metrics still need clarifying before any public use.
5. Backfill implementation (design is in ADR 0005).
6. Committed daily rollups, hourly batching, or squashing old data (triggers in ADR 0004).
7. EUR or other quote currencies. More than 30 coins.
8. Custom domain, analytics, SEO.
9. Issue Form or dispatch input for adding coins (only if outside contributors appear).
10. Keeping the measurement scripts used for these ADRs. They were temporary and are not in the repo.
11. A private repo, which would change the cost model (fixed decision says public).

## How to read the sources

Every ADR ends with a source list with URLs. Access date is 2026-10-29 for all of them unless a different date is written next to the entry. Each source is graded:

- [A] official documentation, terms, changelog or repo
- [B] my own measurement or calculation (method written in the ADR)
- [C] first-hand report (community thread, issue, README, forum)
- [D] blog, vendor marketing or news. Never used alone for a decision.

Facts are separated from opinion. In the ADRs, "Facts" and "Decision Outcome" are different sections. Anything I could not verify is marked UNVERIFIED.
