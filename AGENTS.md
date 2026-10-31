# Repository agents (git-coin)

This file orients human and AI contributors to **git-coin**. Prefer **small, focused changes**; do not refactor unless asked. The reasons behind every choice are in [docs/adr/](docs/adr/0000-index.md).

## Product

- A scheduled GitHub Actions workflow fetches USD prices of ten coins from public APIs, appends them to CSV files on the orphan `data` branch (one commit per run), and publishes a static dashboard to GitHub Pages. A sharp price move opens a GitHub Issue (alerts). The git history is the price history.
- During the first 14 days four sources are stored and compared (Kraken, Coinbase Exchange, Bitstamp, Coin Metrics; ADR 0002 Revision 2). After that one source is chosen.
- GitHub delivers scheduled runs late or not at all, so every part treats gaps as normal (ADR 0005).

## Architecture

| Area      | Path                                                 | Role                                                                                                                                             |
| --------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Collector | `src/collect.ts`                                     | Fetches the sources in parallel, validates, appends rows, writes status, commits to `data`.                                                      |
| Sources   | `src/sources/*.ts`                                   | One adapter per source (`SourceAdapter` in `src/types.ts`).                                                                                      |
| Storage   | `src/csv.ts`, `src/series.ts`, `src/market-state.ts` | Daily CSV files `data/raw/YYYY/MM/DD/<ID>.csv` and `<ID>.market.csv` (bid, ask, volume, daily Coin Metrics metrics), request log, series reader. |
| Alerts    | `src/alerts/`                                        | Rolling 1 h and 24 h moves, Issue dedup and cooldown (ADR 0006).                                                                                 |
| Site      | `src/build-site.ts`, `site/`                         | Derived JSON from the data branch, and the static dashboard (plain HTML and JS, no bundler).                                                     |
| Config    | `config/coins.json`                                  | Coins, sources, thresholds. Validated by `config/coins.schema.json` and by `src/config.ts`.                                                      |
| Workflows | `.github/workflows/`                                 | `collect.yml` (schedule, publish) and CI.                                                                                                        |

The shared types are in `src/types.ts` (the contract of [docs/implementation/plan.md](docs/implementation/plan.md), section 3). Modules import only `src/types.ts` and `src/time.ts` from each other, and only `src/collect.ts` wires them together.

## Code rules (ADR 0003)

- Node.js 24, TypeScript run natively (`node src/collect.ts`, type stripping). Erasable syntax only: no `enum`, no `namespace`, no parameter properties. `import type` for types. `.ts` extensions in relative imports.
- No runtime dependencies. Use the built-in `fetch`, `node:test` and `node:assert/strict`.
- Prices are strings. They are written to the CSV exactly as the source gave them. Numbers are used only for comparisons and percentages.
- Format with Prettier (tabs, width 4, single quotes, trailing commas `es5`). ESLint and Prettier settings come from the Hyperfriend repository.

## Dependency policy

- **Only exact versions** in `package.json`. `.npmrc` sets `save-exact=true` and `engine-strict=true`.
- Update with `npm install -E <package>@latest` (add `-D` for dev dependencies), then run `npm run check:versions`. Details: [npm-versions.md](.claude/rules/npm-versions.md).
- `typescript7` (alias of TypeScript 7) is the type checker. `typescript` is the TypeScript 6 compat package that `typescript-eslint` needs.

## Commands

- `npm run check` runs everything below in order. It is the gate for every change.
- `npm run format` / `npm run format:check`: Prettier. `npm run lint`: ESLint and the TypeScript 7 type check. `npm run lint:docs`: markdownlint and relative links. `npm run lint:unused`: knip. `npm run check:versions`: exact versions. `npm test`: `node --test` on `test/**/*.test.ts` (no network).
- On a machine whose default Node is not 24, prefix with `./scripts/with-node24.sh`, for example `./scripts/with-node24.sh npm run check`.
- `npm run site:preview -- [--data-root data] [--port 8765]` builds the dashboard from a checkout of the `data` branch into `out/` and serves it on localhost.
- `node tools/run-status.ts` summarizes the latest `collect.yml` runs (delivery rate and gaps). `node tools/data-health.ts --data-root <dir>` shows the last tick, failures and gaps per source in a data checkout.

## Git hooks and commits

- The Husky pre-commit hook runs `npm run format` and `git add -u`, so it stages every modified tracked file. Partial commits are not supported.
- Commit titles follow the pull request title rules ([check-pr-title.mjs](scripts/check-pr-title.mjs)): start with an upper case letter, at most 72 characters, no trailing period, imperative mood, no `WIP`, `fixup!` or `squash!`.
- No attribution lines and no co-author trailers. The commit author is `borbiuk`.

## Rules of engagement

- Contributors: [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md) (checks, commits, pull requests). Security: [SECURITY.md](SECURITY.md).
- English for code comments and technical docs in the repo.
- Follow the working rules in [CLAUDE.md](CLAUDE.md).
