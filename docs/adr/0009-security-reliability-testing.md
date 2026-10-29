# ADR 0009: Security, reliability and testing

- Status: Proposed
- Date: 2026-10-29
- Scope: workflow permissions, secrets, action pinning, protection of data, logging and retries, failure behaviour, testing strategy, licence and README, and a risk register of things that were not in the original list.

Source grades: [A] official docs, [B] own measurement, [C] first-hand report, [D] blog or vendor.

## Context

The repo is public and runs a scheduled bot with write access. Nothing in the design needs a secret. The main risks are supply chain (actions and tools), accidental data loss, silent failure, and leaking something into public history.

## Decision Drivers

1. Least privilege for `GITHUB_TOKEN`.
2. No secrets needed in v1.
3. Pinned, reviewed third-party code.
4. Data cannot be overwritten by a bad run.
5. Tests catch logic errors without network access.

## Facts

- When a workflow specifies any permission, all unspecified permissions become `none`. New personal repos default to read-only `contents` and `packages`. [A]
- Pushing needs `contents: write`. Creating Issues needs `issues: write`. Deploying Pages needs `pages: write` and `id-token: write`. [A]
- GitHub recommends pinning actions to full commit SHAs. Tags can be moved (tj-actions/changed-files, CVE-2025-30066, March 2025: tags were moved to a malicious commit that printed secrets into public workflow logs; more than 23,000 repos used it). [A]
- Dependabot opens version-update PRs for pinned actions and updates the trailing `# vX.Y.Z` comment. Dependabot does not create security alerts for actions pinned to SHAs. Default cooldown is 3 days for version updates. [A]
- GitHub can enforce SHA pinning with an Actions policy checkbox. [A]
- The built-in `github-actions[bot]` cannot be added to a ruleset or branch-protection bypass list (community answer from staff, 2019; still open in 2026). Branch protection that requires pull requests blocks bot pushes. [A]/[C]
- Secret scanning and push protection are on by default for public repos. [A]
- Latest first-party action majors on 2026-10-29: checkout v7.0.1, deploy-pages v5.0.1, upload-pages-artifact v5.0.0 (composite). Tag to SHA from the GitHub API: checkout v7.0.1 is `3d3c42e5aac5ba805825da76410c181273ba90b1`; deploy-pages v5.0.1 is `368f82528645a54fb793d4d04e342629a3f51346`. Re-resolve every SHA at implementation time. [B]
- Run history, logs and artifacts are kept 90 days by default. [A]

## Considered Options

| Topic               | Options                                                                             | Pick                                                                            |
| ------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Action pinning      | tags; major tags; full SHAs                                                         | full SHAs with `# vX.Y.Z` comments                                              |
| Bot push protection | required PRs on `data`; rulesets blocking force-push and deletion only; no rules    | rulesets blocking force-push and deletion on `data` and `main`; no required PRs |
| Third-party actions | use helpers for commit and Pages; plain `git` and first-party only                  | plain `git`, first-party only                                                   |
| Dependency updates  | Dependabot; Renovate (AGPL-3.0 package; hosted terms for public repos not verified) | Dependabot                                                                      |

## Decision Outcome

### D1. Workflow permissions (least privilege)

| Workflow / job                              | Permissions                                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `collect.yml` top level                     | `permissions: {}`                                                                                   |
| job `collect`                               | `contents: write` (push to `data`, keepalive commit on `main`), `issues: write` (alerts and labels) |
| job `publish`                               | `contents: read`, `pages: write`, `id-token: write`                                                 |
| `ci.yml` (pull requests and push to `main`) | `contents: read`                                                                                    |

- No other scopes. No `actions: write`, no `pull-requests: write`.
- `persist-credentials: true` only on the checkouts that push. Other checkouts use `false`.
- Every job has `if: github.repository == 'borbiuk/git-coin'`, `timeout-minutes`, and uses the concurrency group from ADR 0005.
- Untrusted text (exchange error strings, response fields) is never placed inside `run:` with `${{ }}` and never into Issue text. It goes through the script's own variables and is validated first (secure-use guidance).

### D2. Secrets

- None in v1. The repo has no repository secrets. The four test sources (Kraken, Coinbase Exchange, Bitstamp, Coin Metrics) need no keys (ADR 0002 Revision 2). The reserve sources (CoinGecko Demo, CoinMarketCap Basic, Coinranking) need a free key each. Activating one adds a repository secret and ends the "no secrets" rule, so the owner records that in ADR 0002 first.
- If a secret is ever added (a CoinGecko Demo key, an ntfy topic, a Telegram token), it goes into repository secrets only. It is never printed and never written into a file. The ADR that adds it must say so.
- Never commit anything from the list in ADR 0001 ("What must never be committed").

### D3. Action pinning and updates

- Use only `actions/checkout`, `actions/upload-pages-artifact` and `actions/deploy-pages`. Pin each by full SHA with the version in a comment.
- `.github/dependabot.yml`: ecosystem `github-actions` weekly; ecosystem `npm` (dev dependencies in `package.json`) also weekly, with a 7-day cooldown, as in Hyperfriend (ADR 0003 Revision 2). `check-jsonschema` is run with a pinned version in CI, so Dependabot does not update it. Bump it by hand.
- Enable the repo setting that requires actions to be pinned to a full SHA.
- CI runs `actionlint` and `zizmor` on the workflow files.
- When Node or runner images change (for example the end of the Node 20 removal and the `ubuntu-latest` change on 2026-11-19), Dependabot PRs and a manual `workflow_dispatch` dry run check the result.

### D4. Protection of data and branches

- Rulesets on `data` and `main`: block force pushes, block deletion. No "require pull request" rule on `main` or `data`, so the bot can push (this is needed for the data commits and the keepalive commit, ADR 0005 D7).
- Append-only guard and push-retry rule: ADR 0004 D6.
- The owner pushes code to `main` by pull request by habit. This is a habit, not a rule enforced by GitHub.
- Squash or rewrite of `data` is a manual, one-off action by the owner (ADR 0004 D5).

### D5. Logging, retries, outages

- The collector prints one structured line per coin and per run (coin, status, price, reason if rejected) and a short summary in the job summary. It never prints headers, tokens or response bodies. Redaction is the default: the script has no path that logs a token.
- Retries: one retry with a 2-second backoff for network errors and HTTP 5xx. HTTP 429: no retry; skip the source for this run. Timeouts: 10 seconds per request.
- When every source fails: no rows, no commit, exit 0, increment `consecutive_failures` (ADR 0004 D4). After 4 failures in a row, one deduplicated Issue `[collector] no data`.
- When the config or the code is broken: exit non-zero, so the owner gets the failed-run email (set Settings, Notifications, Actions, "Only notify for failed workflows").

### D6. Testing strategy

Unit tests (`node --test`, no network):

- parse a real Kraken `Ticker` response and a real CoinGecko `simple/price` response (saved as small fixtures, 2 to 3 coins each; real responses, kept minimal; they are public price facts, still subject to ADR 0002 terms). For the other test sources (Coinbase, Bitstamp, Coin Metrics) write parsing tests with hand-made fixtures of the same shape. Coinbase's terms forbid display, so no real Coinbase response goes into the public repo.
- map Kraken result keys to ids (`XXBTZUSD`, `XDGUSD`, `SOLUSD`)
- validation rules: zero, negative, null, text, NaN, huge, 50% step with and without cross-check
- idempotent append (re-run, `min_spacing`, earlier timestamp)
- reference-sample selection and percentage math for both windows, gaps, first run, added coin
- alert state machine: new Issue, comment on repeat, cooldown, opposite direction, daily cap, auto-close
- config checks and config schema edge cases

Other checks:

- Dry run mode (`workflow_dispatch` input and a command-line flag): everything except writes, Issues and publish.
- A small integration test with a local bare git repo: two writers, push rejection, the append-only guard.
- CI (`build.yml`, the job layout of Hyperfriend): `npm ci --ignore-scripts`, `npm run check:versions`, `npm run format:check`, `npm run lint` (ESLint and the TypeScript 7 type check), `npm test` (`node --test`) on Node 24 (and on Node 22 as a non-required job), plus a `checks` job with `npm run lint:docs` and `npm run lint:unused` (knip). Also `pr-title.yml`, `codeql.yml` (`javascript-typescript` and `actions`), `dependency-review.yml` and `scorecard.yml`, adapted from Hyperfriend, `check-jsonschema` for the config, `actionlint`, `zizmor`. The non-required job checks Kraken symbols over the network (ADR 0007).
- Fixture refresh: when a source changes its format, re-record the fixture by hand.

### D7. Licence and README

- Code licence: MIT (proposal, owner to confirm).
- Data: no open licence is granted. Prices come from third parties (ADR 0002). The README says (the source name follows the choice in ADR 0002 Revision 3; Kraken is the example): "Prices come from Kraken's public API and are subject to Kraken's terms. They are provided as is, may be delayed, missing or wrong, and are not financial advice. No licence to the price data is granted by this repo." Do not put CC0 or an open data licence on the data.
- README sections: what it is; live dashboard link; how it works (one paragraph and a diagram link to the ADR index); data sources and attribution; how to add a coin; how to run tests and a dry run; known limits (freshness, gaps, throttled schedules); disclaimer; licence; link to `docs/adr/`.
- A `SECURITY.md` is not needed (nothing to protect). A short `CONTRIBUTING` line in the README is enough.

## Risk register (J in the brief: things that were not in the original list)

| #   | Risk                                                                                                                                                          | Why it matters                                                                                                | Mitigation or owner                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Scheduled runs delivered far below the cron rate (about 5 per day in much of a one-day sample); no GitHub explanation                                         | freshness and alerts can be hours late                                                                        | ADR 0005 pilot, decision rule, banners                                                                                                  |
| 2   | Data terms of exchanges and aggregators (Coinbase, OKX, KuCoin forbid; Kraken and Bitstamp unclear; CoinGecko treats storage as a 24-hour cache)              | a public history may be a licence breach                                                                      | ADR 0002 Revision 2: four sources tested in a private repo, one chosen; written questions to Kraken and Coin Metrics                    |
| 3   | Actions terms: "unrelated to the production, testing, deployment, or publication of the software project"                                                     | grey area for git scraping                                                                                    | ADR 0001: accept and document; keep jobs small                                                                                          |
| 4   | 60-day auto-disable; bot commits probably count but undocumented                                                                                              | silent stop without any error                                                                                 | ADR 0005 D7 keepalive commit and canary                                                                                                 |
| 5   | `ubuntu-latest` moves to 26.04 between 2026-10-19 and 2026-11-19; Node 20 removed 2026-09-23                                                                  | unattended repos break                                                                                        | pinned runner, Dependabot, dry run                                                                                                      |
| 6   | Forks run their own collectors if their owners enable schedules                                                                                               | wasted runs, exchange rate limits                                                                             | repository guard on every job                                                                                                           |
| 7   | Append conflicts between writers (shallow clone test: conflict on rebase)                                                                                     | failed pushes, lost rows                                                                                      | single concurrency group, retry by redoing the append                                                                                   |
| 8   | History noise: up to 35,000 commits per year on `data`                                                                                                        | unreadable history, 10,000-commit tab limit                                                                   | separate `data` branch                                                                                                                  |
| 9   | Stale dashboard hidden by the 10-minute Pages cache and failed runs                                                                                           | misleading users                                                                                              | `no-cache` fetch, "last updated", banners                                                                                               |
| 10  | Pages bandwidth soft limit 100 GB per month                                                                                                                   | viral link                                                                                                    | small derived files; same-origin, gzip                                                                                                  |
| 11  | Secret leak (workflow log leak like tj-actions; accidental `.env`)                                                                                            | permanent in public history                                                                                   | no secrets, SHA pins, push protection                                                                                                   |
| 12  | Cloudflare or the exchange blocks GitHub IP ranges (Simon Willison hit this in February 2025 on another site)                                                 | collector stops                                                                                               | runner probe, stale banner, source change by ADR                                                                                        |
| 13  | A venue shows a wrong price for minutes (Binance, October 2025, non-USD assets)                                                                               | false alerts, bad history                                                                                     | USD only, cross-check, step check                                                                                                       |
| 14  | Issue emails may not arrive for bot-created Issues                                                                                                            | the alert path is silent                                                                                      | blocking test; second channel decision                                                                                                  |
| 15  | GitHub retires a product (Flat Data is archived)                                                                                                              | platform changes break assumptions                                                                            | keep the design on basic features only                                                                                                  |
| 16  | Dependabot does not alert on SHA-pinned actions                                                                                                               | vulnerabilities in a pinned action go unnoticed                                                               | weekly version PRs, `zizmor`, manual review                                                                                             |
| 17  | Run history is deleted after 90 days                                                                                                                          | no long-term proof of schedule delivery                                                                       | the data itself and `status.json` are the record                                                                                        |
| 18  | uPlot has no npm release for 19 months                                                                                                                        | maintenance risk                                                                                              | replacement path in ADR 0008                                                                                                            |
| 19  | Commit author email in public history                                                                                                                         | privacy                                                                                                       | bot noreply email; owner's "block pushes that expose my email"                                                                          |
| 20  | Finance rules or perception: a price page can look like advice                                                                                                | trust and legal risk                                                                                          | visible disclaimer; no calls to action                                                                                                  |
| 21  | Hidden failures: all sources fail but runs are green                                                                                                          | long gaps                                                                                                     | `consecutive_failures`, Issue after 4, banner                                                                                           |
| 22  | Four-source test with real data in the public repo: Coinbase's terms forbid display, Coin Metrics wants a written permission, Bitstamp and Kraken are unclear | a known conflict with Coinbase's terms and an open risk for the rest; a public history cannot be fully erased | the owner accepted the risk on 2026-10-29; README names the sources and credits Coin Metrics; short test (ADR 0002 Revision 2, point 9) |
| 23  | Rows of the three non-chosen sources stay in `data` history (append-only, no history rewrite)                                                                 | the data cannot be withdrawn if a source objects; a rewrite would need lifting the force-push block           | keep the test to 14 days; readers filter by `src`; record the owner decision                                                            |
| 24  | Public fixtures hold real responses of a source whose terms forbid display                                                                                    | the repo shows that source's data                                                                             | for Coinbase use hand-written synthetic fixtures with the same shape; keep real fixtures tiny (ADR 0009 D6)                             |

## Consequences

- Good: no secrets, minimal tokens, pinned code, append-only data, tests that run without network.
- Good: the risks are listed with owners. None is hidden.
- Bad: no PR requirement on `main` and `data` is a trade-off for bot pushes. Mistakes by the owner on `main` are possible.
- Bad: SHA pinning adds weekly Dependabot PRs.
- Bad: fixtures are copies of third-party responses. Keep them tiny.

## Sources (access date for all: 2026-10-29)

- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions [A]
- https://docs.github.com/en/actions/reference/security/secure-use [A]
- https://docs.github.com/en/actions/concepts/security/github_token [A]
- https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference [A]
- https://github.blog/changelog/2025-08-15-github-actions-policy-now-supports-blocking-and-sha-pinning-actions/ [A]
- https://github.blog/changelog/2022-10-31-dependabot-now-updates-comments-in-github-actions-workflows-referencing-action-versions/ [A]
- https://github.com/advisories/GHSA-mrrh-fwg8-r2c3 (tj-actions/changed-files) [A]
- https://github.com/orgs/community/discussions/25305 (bot in bypass list) [C]
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches [A]
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository [A]
- https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection [A]
- https://simonwillison.net/2025/Feb/23/tailscale-github-actions [C]
- https://github.com/actions/checkout and https://github.com/actions/deploy-pages releases and tag refs (GitHub API) [B]
- https://news.ycombinator.com/item?id=24732943 (HN thread on git scraping risks) [C]

## Open Questions

1. Does the owner confirm the MIT licence for the code?
2. Should a required-PR rule ever protect `main`? It would break the keepalive commit. A different keepalive would then be needed.
3. Is it acceptable to rely on `persist-credentials: true` in the push checkouts?
4. Should the Kraken symbol check in CI be dropped if Kraken terms forbid automated calls from CI? Decide with the answer to ADR 0002 question 1.
5. `zizmor` and `actionlint` may flag the keepalive and push steps. Review the findings at implementation.
