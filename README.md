<img src="site/logo.svg" alt="git-coin logo" width="72" height="72" />

# git-coin

**Prices of 27 coins, collected on a schedule by GitHub Actions. The git history is the price history.**

[![build](https://github.com/borbiuk/git-coin/actions/workflows/build.yml/badge.svg)](https://github.com/borbiuk/git-coin/actions/workflows/build.yml)
[![license](https://img.shields.io/github/license/borbiuk/git-coin)](LICENSE)

git-coin is a small project with no server. A scheduled GitHub Actions workflow fetches the USD prices of 27 coins from public APIs and appends them to CSV files on a separate `data` branch, one commit per run. A static dashboard on GitHub Pages shows the prices. A sharp price move opens a GitHub Issue.

> **Test period.** The first 14 days compare four price sources, and all of them are stored. The data of this period is **test data, provided as is**. It can be late, missing or wrong, and it is not financial advice. After the test one source is chosen and the dashboard and the alerts go live. Until then the dashboard is not published.

## Dashboard

<https://borbiuk.github.io/git-coin/>

The dashboard shows the latest price, the change over 24 hours, 7 days and 30 days, and a chart for each coin. It also says how old the data is, and shows a banner when the data is late. It is published only after the source test.

## How it works

Every 15 minutes (at off-peak minutes) a workflow on `main` runs a Node.js 24 collector, written in TypeScript with no runtime dependencies. The collector fetches the prices, checks them, appends one row per coin and source to a daily CSV file and commits the result to the orphan `data` branch. When a price moves more than a per-coin limit over 1 hour or 24 hours, it opens one GitHub Issue for that coin and direction. About every 30 minutes the workflow builds small JSON files from the `data` branch and deploys the dashboard (plain HTML and JavaScript, one chart library, no build tool) to GitHub Pages.

GitHub delivers scheduled runs late, and sometimes not at all. So every part of git-coin treats gaps and delays as normal, and the dashboard shows an honest "last updated" time.

The reasons behind every choice are in the [decision records](docs/adr/0000-index.md). The build plan is in [docs/implementation/plan.md](docs/implementation/plan.md).

## Coins

BTC, ETH, BNB, XRP, SOL, DOGE, LINK, ADA, XLM and LTC, stored in USD. The dashboard shows them in USDT, converted with the USDT/USD price (the `USDT` entry with `"role": "rate"`, [ADR 0008](docs/adr/0008-dashboard-stack-and-metrics.md) D7). The list is in `config/coins.json`.

## Data sources and attribution

During the test period all four sources are called in every run, and each row has a `src` code. No source needs an API key.

| Source                                                                                                                   | Code | What it gives                                     |
| ------------------------------------------------------------------------------------------------------------------------ | ---- | ------------------------------------------------- |
| [Kraken](https://www.kraken.com/)                                                                                        | `kr` | Last trade price of the USD pairs                 |
| [Coinbase Exchange](https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits)                                         | `cb` | Last trade price of the USD products              |
| [Bitstamp](https://www.bitstamp.net/api/)                                                                                | `bs` | Last trade price of the USD markets               |
| [Coin Metrics](https://gitbook-docs.coinmetrics.io/packages/coin-metrics-community-data) Community API (Reference Rates) | `cm` | A USD reference rate, calculated from many venues |

Prices come from the public APIs of these services and are subject to their terms. Coin Metrics data is available under the [Creative Commons Attribution-NonCommercial 4.0 licence (CC BY-NC 4.0)](https://creativecommons.org/licenses/by-nc/4.0/). This project is non-commercial, and credits Coin Metrics for the reference rates.

After the test one source is kept for new rows. The rows of the other sources stay in the history of the `data` branch, so filter by `src` when you read the files. The terms of the sources are recorded in [ADR 0002](docs/adr/0002-data-sources.md).

## Data files

On the `data` branch, `data/raw/YYYY/MM/DD/<ID>.csv` has one file per day and coin with the header `ts,price,src,age_s`. `ts` is the real fetch time in UTC. `price` is copied from the source as text. `age_s` is the age of the source's own timestamp, empty when the source gives none. `state/status.json` has the last run and the failure counters. The details are in [ADR 0004](docs/adr/0004-data-model-storage-retention.md).

## Add a coin

1. Open `config/coins.json` on a branch (the GitHub web editor works) and add an object to `coins`.
2. Fill `id`, `name`, `added`, and the id of each stored source that lists the coin (for example `kraken_pair`, `coinbase_product`, `bitstamp_market`, `coinmetrics_asset`). At least one is needed; a coin can be missing on some sources. A disabled coin keeps `enabled: false` instead of being deleted.
3. Open a pull request. CI checks the file against `config/coins.schema.json`, and a non-required job checks that the symbols exist at the sources.
4. After the merge the coin starts at the next run. Its history begins with its first row. Older prices come from a backfill that the owner runs (next section).

The rules are in [ADR 0007](docs/adr/0007-configuration-and-adding-coins.md).

## Backfill the history

Run this after a coin was added (or when `node tools/audit-coverage.ts` shows a low share for a coin). The tools only append, and they continue after the last stored row, so they are safe to run again. They work in a checkout of the `data` branch, and the owner pushes the result.

```bash
git clone --branch data --single-branch --depth 1 git@github.com:borbiuk/git-coin.git ../git-coin-data
node tools/audit-coverage.ts --data-root ../git-coin-data                  # share of 15 minute intervals with a price, per coin
node tools/backfill.ts --data-root ../git-coin-data --dry-run              # the coins and providers it would use
node tools/backfill.ts --data-root ../git-coin-data --verify               # run, then compare the sources at equal times
```

- `tools/backfill.ts` picks the coins whose share is below `--min-coverage` (0.8) and fills them from Coinbase, else Kraken trades, else OKX. The providers run side by side. `--coins ATOM,KSM` and `--provider kraken-trades` choose by hand, `--from` and `--until` set the range.
- A close is left out when it is more than 2% away from another source at the same time, or more than 50% away from the close before it. `--verify` prints the spread between the sources.
- Bitstamp candles: `tools/backfill-bitstamp.ts --only <ids>`. Daily Kraken closes for a coin with no Bitstamp market: `tools/backfill-kraken.ts`.
- Then commit in the checkout with the repository identity and push `data`. If the backfill uses a `src` code that `main` does not know yet, push `main` first.

## Develop and test

You need Node.js 24.22.1 (see `engines` in `package.json`). If your default Node is another version, put `./scripts/with-node24.sh` in front of every command.

```bash
npm ci --ignore-scripts
npm run prepare        # installs the Git hook that formats every commit
npm run check          # format, versions, lint and type check, docs, unused code, tests
```

The tests use `node --test`, need no network and use synthetic fixtures. A dry run calls the real sources (this needs a network), prints what it would write, and writes no file, no Issue and no commit:

```bash
node src/collect.ts --config config/coins.json --data-root data --dry-run
```

On GitHub, the same dry run is the `collect` workflow started by hand with the input `dry_run`. More in [CONTRIBUTING.md](.github/CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). The steps for the repository owner (settings, first run, the source test) are in the [runbook](docs/implementation/runbook.md).

## Known limits

- **Freshness.** GitHub documents a 5-minute minimum for scheduled workflows, but delivers far fewer runs, and late. Expect gaps. The dashboard does not promise minute-level data and shows a banner when the data is late or stopped.
- **Alerts are late too.** An alert needs a run, so it can come hours late. A fast spike that reverses between two samples is not seen. Do not use the alerts for trading.
- **Prices are exchange prices.** They are last trade prices or reference rates in USD (shown in USDT on the page), and they differ a little between sources.
- **History.** Prices before 2026-10-29 are candle closes from the exchanges (Bitstamp, Coinbase, Kraken, OKX), not live prices. They are every 15 minutes where the market had trades. Thin markets have gaps.
- **Missed runs.** When GitHub skips runs, the next run fills the missing time with 15-minute Bitstamp candles (up to 10 days back). The chart shades that time ("No scheduled run") and hatches time with no data at all.
- **Test data.** The first 14 days store four sources side by side. See the test period note above.
- **Terms of the sources.** Some sources do not clearly allow storing or showing their data in public. Coinbase's market data terms forbid display and redistribution. This was a known and accepted risk of the test ([ADR 0002](docs/adr/0002-data-sources.md), Revision 2).
- **No history rewrite.** The `data` branch is append-only. Rows that were committed stay in the history, and forks and clones keep copies.

## Disclaimer

Prices come from the public APIs of Kraken, Coinbase Exchange, Bitstamp and Coin Metrics, and are subject to their terms. They are provided as is, may be delayed, missing or wrong, and are not financial advice. No licence to the price data is granted by this repository. Do not use it to make trading decisions.

## Contributing and support

Bug reports, ideas and pull requests are welcome. Read [CONTRIBUTING.md](.github/CONTRIBUTING.md) first. For questions see [SUPPORT.md](.github/SUPPORT.md), for security problems [SECURITY.md](SECURITY.md). Everyone follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licence

The code is under the [MIT licence](LICENSE). The price data is not licensed by this repository (see the disclaimer).
