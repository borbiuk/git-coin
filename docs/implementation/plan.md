# Implementation plan: git-coin

- Date: 2026-10-29
- Status: Proposed (waiting for the owner's approval of the gates in section 7)
- Orchestrator: Claude in the main session. Agents: at most 15 in total (A1 to A15).
- Inputs: `docs/adr/0000-index.md` to `0009`, `docs/adr/pre-implementation-checklist.md`. The ADRs say what to build and why. This plan says who builds which part, in which order, and how the parts fit without blocking each other.

## 1. Goals and non-goals

Goal: the collector, the tests, the workflows and the dashboard described in the ADRs, built in parallel by many agents, merged without conflicts, verified locally, and ready for the owner to push.

In scope: code and files in the repo (`src/`, `tools/`, `test/`, `config/`, `site/`, `.github/`, `docs/implementation/`, `README.md`), small ADR updates that the contracts force (listed in section 3.6).

Out of scope for agents: pushing, creating GitHub repos, changing GitHub settings, running anything on GitHub, creating API keys, sending emails to sources. These are the owner's gates (section 7). Agents prepare everything so each gate takes minutes.

## 2. Phases and parallelism

| Phase | Who                                          | What                                                                  | Blocks                           |
| ----- | -------------------------------------------- | --------------------------------------------------------------------- | -------------------------------- |
| P0    | Orchestrator only                            | Prepare the repo: Node check, scaffold, contracts, first local commit | everything                       |
| P1    | A1 to A8, A10 to A14 (13 agents in parallel) | Build the modules, each in its own file area                          | nothing between them             |
| P2    | Orchestrator, then A9                        | Merge P1 branches into `integration`, then A9 wires the collector     | A9 needs the P1 merge            |
| P3    | A15                                          | End-to-end tests, ADR conformity review, security review              | needs P2                         |
| P4    | Owner (with prepared files)                  | Gates G1 to G4: push, throwaway tests, start the 14-day test          | needs P1 (A14) for G2, P3 for G3 |
| P5    | Orchestrator, reusing agents by message      | After 14 days: analysis, choice, ADR Revision 3, switch to production | needs the test                   |

Rules that keep P1 non-blocking:

1. In P1 every agent depends only on files made in P0 (`src/types.ts`, `src/time.ts`, `package.json`, `tsconfig.json`, the lint and format configs) and on the ADRs. No agent imports another agent's code. Modules talk through the interfaces in section 3.
2. File ownership is disjoint (section 4). An agent edits only its own paths.
3. Each agent works in its own git worktree on its own branch `impl/<id>`. No agent touches `main` or `integration`.
4. No agent adds a dependency. Dev tools are fixed in P0. Tests are found by a glob, so nobody edits `package.json` to add a test.
5. A needed contract change is never made by an agent. The agent uses a local workaround, and writes the change request in its final report. The orchestrator applies it during P2.

Start order inside P1: spawn A14 first, because the owner can start the 72-hour schedule pilot and the runner probe (gate G2) as soon as the throwaway templates exist. Then spawn the rest in the same message. If the platform limits concurrent agents, run two batches: batch 1 = A14, A13, A1 to A5; batch 2 = A6, A7, A8, A10, A11, A12. The batches do not depend on each other.

## 3. Contracts (frozen in P0)

### 3.1 Tooling (done in P0; the tool set is the one of the owner's Hyperfriend repository)

- Node.js 24.22.1 (ADR 0003). The machine default is Node 26.12.1, so every npm command and every commit runs through `./scripts/with-node24.sh` (it uses `npx -p node@24.22.1`; checked on this machine, no global install). `package.json` has `"engines": {"node": ">=24.22.1 <25"}` and `.npmrc` has `engine-strict=true`.
- `package.json`: `"type": "module"`, no runtime dependencies, exact dev dependency versions only (`save-exact`, `scripts/check-versions.mjs`): `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-config-prettier`, `eslint-plugin-import-x`, `globals`, `prettier`, `knip`, `markdownlint-cli2`, `husky`, `@types/node` (Node 24 line), `typescript` (alias of the TypeScript 6 compat package, needed by `typescript-eslint`) and `typescript7` (alias of `typescript` 7.0.2, the type checker).
- Scripts: `format` and `format:check` (Prettier), `lint` (ESLint and the type check), `lint:docs` (markdownlint and relative links), `lint:unused` (knip), `check:versions`, `test` (`node --test "test/**/*.test.ts"`), and `check`, which runs all of them in order. `npm run check` is the gate of every agent. The test runner stays `node:test` (ADR 0003). Hyperfriend's Playwright setup is not used.
- Format: Prettier with tabs, width 4, single quotes, `es5` trailing commas, LF. `.editorconfig` matches. ESLint: `curly: all` (block `if`, no one-line `if`), single quotes, semicolons, import order with blank lines between groups and alphabetical order inside a group, and type-aware `no-floating-promises` and `no-misused-promises` in `src`, `tools` and `test`.
- Config files (`eslint.config.mjs`, `knip.jsonc`, `.prettierrc.json`, `.markdownlint-cli2.jsonc`, `tsconfig.json`) belong to the orchestrator. An agent that needs a change asks for it in its report.
- `tsconfig.json`: `strict`, `noEmit`, `nodenext`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax`. It includes `src`, `tools` and `test`. The `site/` JavaScript is linted with browser globals and is not type-checked.
- Husky pre-commit hook: `npm run format` and `git add -u`. Every commit is formatted, and all modified tracked files are staged (partial commits are not supported).
- Code rules for everyone (ADR 0003, `AGENTS.md`): erasable TypeScript only (no `enum`, no `namespace`, no parameter properties), `import type` for types, `.ts` extensions in relative imports, no runtime dependencies, built-in `fetch`, `node:test` and `node:assert/strict`, block `if` statements.

### 3.2 Shared types (`src/types.ts`, types and constants only, no logic)

```ts
export type SourceId = 'kraken' | 'coinbase' | 'bitstamp' | 'coinmetrics';
export type SrcCode = 'kr' | 'cb' | 'bs' | 'cm' | 'kr-ohlc';
export const SRC_CODE = {
	kraken: 'kr',
	coinbase: 'cb',
	bitstamp: 'bs',
	coinmetrics: 'cm',
} as const;
export type Phase = 'test' | 'production';
export type ErrorCode =
	'timeout' | 'http_429' | 'http_other' | 'parse' | 'unmapped';
export type HttpErrorCode = Exclude<ErrorCode, 'unmapped'>;

// config (ADR 0007, extended in 3.6)
export interface CoinSources {
	kraken_pair?: string;
	coinbase_product?: string;
	bitstamp_market?: string;
	coinmetrics_asset?: string;
	coingecko_id?: string;
}
export interface AlertParams {
	window_minutes: number;
	threshold_percent: number;
	ref_tolerance_minutes: number;
}
export interface AlertOverrides {
	enabled?: boolean;
	direction?: 'up' | 'down' | 'both';
	cooldown_hours?: number;
	daily_issue_cap?: number;
	auto_close_hours?: number;
	move_1h?: Partial<AlertParams>;
	move_24h?: Partial<AlertParams>;
}
export interface AlertDefaults {
	enabled: boolean;
	direction: 'up' | 'down' | 'both';
	cooldown_hours: number;
	daily_issue_cap: number;
	auto_close_hours: number;
	move_1h: AlertParams;
	move_24h: AlertParams;
}
export interface CoinConfig {
	id: string;
	name: string;
	enabled: boolean;
	added: string;
	sources: CoinSources;
	alerts?: AlertOverrides;
	note?: string;
}
export interface Settings {
	quote: 'USD';
	stored_sources: SourceId[]; // first entry is the "primary source" for alerts and the site
	phase: Phase; // new in this plan
	features: { alerts: boolean; publish: boolean }; // new in this plan
	min_spacing_seconds: number;
	max_step_move_percent: number;
	crosscheck_max_diff_percent: number;
	publish_min_interval_minutes: number;
	stale_warn_minutes: number;
	stale_stop_minutes: number;
	alert_defaults: AlertDefaults;
}
export interface Config {
	schema_version: 1;
	settings: Settings;
	coins: CoinConfig[];
}

// http
export interface HttpRequest {
	url: string;
	headers?: Record<string, string>;
	timeoutMs?: number;
}
export interface HttpResult {
	status: number;
	ms: number;
	json?: unknown;
	error?: HttpErrorCode;
} // status 0 = no response
export interface HttpClient {
	getJson(req: HttpRequest): Promise<HttpResult>;
}

// rows
export interface PriceRow {
	ts: string;
	coin: string;
	price: string;
	src: SrcCode;
	age_s: number | null;
}
export interface PricePoint {
	ts: string;
	price: string;
	src: SrcCode;
	age_s: number | null;
}
export interface RequestLogRow {
	ts: string;
	src: SrcCode;
	http: number;
	ms: number;
	coins_ok: number;
	error: ErrorCode | '';
}
export interface SourceRun {
	src: SrcCode;
	rows: PriceRow[];
	log: RequestLogRow;
}
export interface SourceAdapter {
	readonly id: SourceId;
	readonly src: SrcCode;
	fetchPrices(
		coins: CoinConfig[],
		http: HttpClient,
		now: () => Date
	): Promise<SourceRun>;
}
export interface SeriesReader {
	// rows of one coin and one src, sorted by ts, from inclusive, to exclusive
	readSeries(
		coin: string,
		fromIso: string,
		toIso: string,
		src: SrcCode
	): Promise<PricePoint[]>;
}

// status (state/status.json on the data branch)
export interface SourceStatus {
	requests: number;
	failures: number;
	failures_by_error: Partial<Record<ErrorCode, number>>;
	consecutive_failures: number;
	last_ok_at: string | null;
}
export interface CoinStatus {
	last_point_at: string | null;
	status: 'ok' | 'source_missing' | 'disabled';
	rejected_count: number;
	last_reject_reason: string | null;
}
export interface Status {
	schema_version: 1;
	phase: Phase;
	last_run_at: string | null;
	last_point_at: string | null;
	consecutive_failures: number;
	last_publish_at: string | null;
	sources: Partial<Record<SrcCode, SourceStatus>>;
	coins: Record<string, CoinStatus>;
}

// derived JSON for the dashboard (ADR 0008 D2). Time `t` is epoch seconds. Prices are numbers.
export interface PeriodStats {
	change_pct: number | null;
	high: number | null;
	low: number | null;
}
export interface DerivedLatest {
	generated_at: string;
	quote: 'USD';
	src: SrcCode;
	coins: Record<
		string,
		{
			name: string;
			price: number;
			ts: string;
			periods: Record<'24h' | '7d' | '30d', PeriodStats>;
		}
	>;
}
export interface DerivedStatus extends Status {
	generated_at: string;
}
export interface DerivedAlerts {
	generated_at: string;
	alerts: Array<{
		coin: string;
		ts: string;
		direction: 'up' | 'down';
		severity: 'high' | 'extreme';
		issue: number;
	}>;
}
export interface SeriesPoints {
	coin: string;
	src: SrcCode;
	t: number[];
	p: number[];
} // 7d and 90d
export interface SeriesDaily {
	coin: string;
	src: SrcCode;
	t: number[];
	o: number[];
	h: number[];
	l: number[];
	c: number[];
}
```

`src/time.ts` (P0, small): `isoSeconds(d: Date): string` (UTC, second precision, `Z`), `utcDay(ts: string): string` (`YYYY-MM-DD`), `parseIso(ts: string): number` (epoch ms, throws on bad input).

### 3.3 Module exports (names are fixed, bodies are free)

| Module (owner)                                               | Exports                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/config.ts` (A1)                                         | `loadConfig(path: string): Promise<Config>` (throws `ConfigError`), `enabledCoins(config: Config, source: SourceId): CoinConfig[]`, `ConfigError` (an `Error` subclass; classes are fine, only enums, namespaces and parameter properties are banned)                                                                                      |
| `src/http.ts` (A2)                                           | `createHttpClient(opts?: { userAgent?: string; fetchImpl?: typeof fetch; retryDelayMs?: number }): HttpClient`                                                                                                                                                                                                                             |
| `src/sources/kraken.ts` (A3)                                 | `krakenAdapter: SourceAdapter`                                                                                                                                                                                                                                                                                                             |
| `src/sources/coinbase.ts` (A4)                               | `coinbaseAdapter: SourceAdapter`                                                                                                                                                                                                                                                                                                           |
| `src/sources/bitstamp.ts`, `src/sources/coinmetrics.ts` (A5) | `bitstampAdapter`, `coinmetricsAdapter: SourceAdapter`                                                                                                                                                                                                                                                                                     |
| `src/csv.ts` (A6)                                            | `dailyPath(dataRoot, coin, ts)`, `appendRows(dataRoot, rows, opts: { minSpacingSeconds: number }): Promise<{ written: PriceRow[]; skipped: Array<{ row: PriceRow; reason: 'spacing' \| 'clock' }> }>`, `appendRequestLog(dataRoot, rows: RequestLogRow[]): Promise<void>`, `readLastRow(dataRoot, coin, src): Promise<PricePoint \| null>` |
| `src/series.ts` (A6)                                         | `createSeriesReader(dataRoot: string): SeriesReader`                                                                                                                                                                                                                                                                                       |
| `src/validate.ts` (A7)                                       | `validatePrice(raw: string): { ok: true; value: number } \| { ok: false; reason: string }`, `validateRow(row: PriceRow, ctx: { phase: Phase; previous: number \| null; crosscheck?: number \| null; maxStepPercent: number; crosscheckMaxDiffPercent: number }): { ok: true } \| { ok: false; reason: string }`                            |
| `src/status.ts` (A7)                                         | `emptyStatus(phase: Phase): Status`, `readStatus(path): Promise<Status>`, `writeStatus(path, s: Status): Promise<void>`, `applyRun(prev: Status, run: RunSummary, now: Date): Status`, `needsNoDataIssue(s: Status): boolean` (4 or more consecutive failures), `RunSummary` type (defined in this file)                                   |
| `src/gitdata.ts` (A8)                                        | `commitAndPush(opts: GitOpts, message: string, write: () => Promise<void>): Promise<{ pushed: boolean; commit: string \| null; tries: number }>`, `appendOnlyGuard(repoDir: string): Promise<{ ok: boolean; deleted: number }>`                                                                                                            |
| `src/keepalive.ts` (A8)                                      | `keepaliveIfStale(opts: { mainDir: string; now: Date; maxAgeDays: number; author: GitAuthor }): Promise<boolean>`                                                                                                                                                                                                                          |
| `src/alerts/index.ts` (A10)                                  | `runAlerts(ctx: AlertContext): Promise<AlertSummary>`, `createGitHubIssueClient(env: NodeJS.ProcessEnv): IssueClient`, `syncNoDataIssue(client: IssueClient, needed: boolean, dryRun: boolean): Promise<void>`                                                                                                                             |
| `src/build-site.ts` (A11)                                    | `buildSite(opts: { dataRoot: string; config: Config; outDir: string; now: Date }): Promise<void>`, plus a CLI (3.4)                                                                                                                                                                                                                        |
| `src/collect.ts` (A9)                                        | `runCollect(deps: CollectDeps): Promise<{ exitCode: 0 \| 1; shouldPublish: boolean; rowsWritten: number }>`, plus a CLI (3.4)                                                                                                                                                                                                              |

The module owner defines the helper types (`GitOpts`, `GitAuthor`, `AlertContext`, `AlertSummary`, `IssueClient`, `CollectDeps`) in its own file and exports them. A9 reads them in P2.

### 3.4 Command line, environment and outputs

- Collector: `node code/src/collect.ts --config code/config/coins.json --data-root data [--code-root code] [--keepalive] [--dry-run] [--now <iso>]`. `--now` is only a test hook. Layout in the workflow follows ADR 0005 D3: the `main` checkout is `code/`, the `data` branch checkout is `data/` (so rows are in `data/data/raw/...`; `--data-root data` points at the checkout root).
- Exit codes: 0 for success and for expected data failures, 1 for unexpected exceptions and invalid config (ADR 0004 D4).
- Workflow outputs (written to the file in `$GITHUB_OUTPUT`): `should_publish=true|false`, `rows_written=<n>`.
- Environment: `GITHUB_TOKEN` (alerts and the `no data` Issue only), `GITHUB_REPOSITORY`, `GITHUB_OUTPUT`. No other variables. No secrets in v1 (ADR 0009 D2).
- Site builder: `node code/src/build-site.ts --config code/config/coins.json --data-root data --out out/data`. The `publish` job copies `code/site/*` to `out/` and the derived JSON to `out/data/`.
- Phase behaviour (ADR 0002 Revision 2): `settings.phase = "test"` stores all `stored_sources`, applies only structural price validation, writes the request log, and runs no alerts. `"production"` applies the step check and uses `features.alerts`. `features.publish` decides `should_publish` in both phases (changed on 2026-10-29: the site shows the primary source only, so it can be published during the test).
- The primary source for alerts and the site is `settings.stored_sources[0]`. Both filter rows by its `src` code.

### 3.5 Test conventions

- Tests live in `test/` and are named `*.test.ts`. One directory per owner: `test/<module>/...` or `test/<name>.test.ts`, and fixtures in `test/fixtures/<owner-dir>/`.
- No network in tests. Use `node:http` on `127.0.0.1` with a random port, an injected fake `HttpClient`, or temp directories (`fs.mkdtemp`). Git tests use temp bare repos.
- Fixtures are hand-made (synthetic) with the shape of the real response and made-up prices such as `100.00`. An agent may call a public endpoint once with `curl` to learn the shape, but never commits a raw response. This avoids copying Coinbase data into the public repo (ADR 0009 D6, risk 24).

### 3.6 Contract changes that need ADR edits (orchestrator, in P0)

1. ADR 0007 D2/D3: add `settings.phase` and `settings.features` to the shape and the field list.
2. ADR 0003: note that the local machine has Node 26 and checks run under 24.22.1 with `n run`.
3. ADR 0005 D3: the collector CLI, the output names and the `--keepalive` flag are in this plan. Add a one-line pointer.

## 4. File ownership (disjoint)

| Agent                        | Owns (create and edit only these paths)                                                                                                                                                                                                                                                                                                                                                                       | Phase |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| A1 config                    | `config/coins.json`, `config/coins.schema.json`, `src/config.ts`, `tools/check-symbols.ts`, `test/config.test.ts`, `test/fixtures/config/**`                                                                                                                                                                                                                                                                  | P1    |
| A2 http                      | `src/http.ts`, `test/http.test.ts`                                                                                                                                                                                                                                                                                                                                                                            | P1    |
| A3 kraken and analysis       | `src/sources/kraken.ts`, `test/sources/kraken.test.ts`, `test/fixtures/kraken/**`, `tools/analyze-sources.ts`, `test/tools/analyze-sources.test.ts`, `test/fixtures/analyze/**`                                                                                                                                                                                                                               | P1    |
| A4 coinbase                  | `src/sources/coinbase.ts`, `test/sources/coinbase.test.ts`, `test/fixtures/coinbase/**`                                                                                                                                                                                                                                                                                                                       | P1    |
| A5 bitstamp and coin metrics | `src/sources/bitstamp.ts`, `src/sources/coinmetrics.ts`, `test/sources/bitstamp.test.ts`, `test/sources/coinmetrics.test.ts`, `test/fixtures/bitstamp/**`, `test/fixtures/coinmetrics/**`                                                                                                                                                                                                                     | P1    |
| A6 storage                   | `src/csv.ts`, `src/series.ts`, `test/csv.test.ts`, `test/series.test.ts`, `test/fixtures/csv/**`                                                                                                                                                                                                                                                                                                              | P1    |
| A7 validation and status     | `src/validate.ts`, `src/status.ts`, `test/validate.test.ts`, `test/status.test.ts`                                                                                                                                                                                                                                                                                                                            | P1    |
| A8 git and keepalive         | `src/gitdata.ts`, `src/keepalive.ts`, `test/gitdata.test.ts`, `test/keepalive.test.ts`                                                                                                                                                                                                                                                                                                                        | P1    |
| A9 collector                 | `src/collect.ts`, `src/sources/index.ts`, `test/collect.test.ts`, `test/fixtures/e2e/**`                                                                                                                                                                                                                                                                                                                      | P2    |
| A10 alerts                   | `src/alerts/**`, `test/alerts/**`, `test/fixtures/alerts/**`                                                                                                                                                                                                                                                                                                                                                  | P1    |
| A11 site builder             | `src/build-site.ts`, `src/site/**`, `test/site/**`, `test/fixtures/site/**`                                                                                                                                                                                                                                                                                                                                   | P1    |
| A12 dashboard                | `site/**` (including `site/vendor/**`), `test/ui/**`, `test/fixtures/ui/**`                                                                                                                                                                                                                                                                                                                                   | P1    |
| A13 workflows                | `.github/workflows/**`, `.github/dependabot.yml`, `.github/codeql/**`, `.github/actionlint.yaml`                                                                                                                                                                                                                                                                                                              | P1    |
| A14 throwaway ops and docs   | `docs/implementation/throwaway/**`, `docs/implementation/runbook.md`, `README.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `.github/CONTRIBUTING.md`, `.github/SUPPORT.md`, `.github/CODEOWNERS`, `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/**`                                                                                                                                                | P1    |
| A15 QA and review            | `test/e2e/**`, `test/fixtures/e2e-qa/**`, `docs/implementation/qa-report.md`                                                                                                                                                                                                                                                                                                                                  | P3    |
| Orchestrator                 | `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.mjs`, `knip.jsonc`, `.prettierrc.json`, `.prettierignore`, `.editorconfig`, `.gitattributes`, `.npmrc`, `.gitignore`, `.markdownlint-cli2.jsonc`, `.husky/**`, `scripts/**`, `LICENSE`, `CLAUDE.md`, `AGENTS.md`, `.claude/**`, `src/types.ts`, `src/time.ts`, `test/time.test.ts`, `docs/implementation/plan.md`, ADR edits, all merges | all   |

No path appears twice. A9 is the only importer of all modules.

Root-level files exist because the tooling and the repository conventions need them. All of them are copied or adapted from Hyperfriend: `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.mjs`, `knip.jsonc`, `.prettierrc.json`, `.prettierignore`, `.editorconfig`, `.gitattributes`, `.npmrc`, `.gitignore`, `.markdownlint-cli2.jsonc`, `.husky/`, `scripts/`, `CLAUDE.md`, `AGENTS.md`, `LICENSE` (MIT, as in Hyperfriend), `README.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`. The owner can veto any of them.

## 5. Agent briefs

Every agent prompt is built from: the rules in 5.1, the agent section below, and sections 3 and 4 of this plan. Prompts are in English. The agent writes its final report in English (the orchestrator reads it, not the owner).

### 5.1 Rules for every agent

1. Read `docs/adr/0000-index.md`, the ADR sections named in your brief, `AGENTS.md` and sections 3 and 4 of `docs/implementation/plan.md`. Work only in your own worktree and branch (the tool makes both and names the branch; keep that name and report it). Run `./scripts/with-node24.sh npm ci --ignore-scripts` once, then `./scripts/with-node24.sh npm run prepare` (it installs the Husky hook in your worktree, so every commit is formatted).
2. Edit only the paths you own (section 4). Do not edit ADRs, `src/types.ts`, `package.json`, config files or other agents' files. If you need a change there, do not make it: use a local workaround and write a change request in your report.
3. Node 24.22.1 only, through `./scripts/with-node24.sh`. Erasable TypeScript, no runtime dependencies, no new dev dependencies. Format with `npm run format`. The ESLint rules apply (block `if`, import order). Match the style of the existing files. Comments only where the reason is not obvious. Simple English in code comments and commit messages.
4. Tests use `node:test`, have no network access and use synthetic fixtures (3.5). Cover the failure paths, not only the happy path.
5. Never log response bodies, never put untrusted text into shell commands, never use secrets or keys. Do not run anything against GitHub. Do not run `git push`, `git merge`, `git rebase` or `git reset --hard`. Do not touch `main` or `integration`.
6. You are done only when `./scripts/with-node24.sh npm run check` passes in your worktree. Run it yourself and read the output.
7. Commit on your branch in small commits with `./scripts/with-node24.sh git commit -m "<title>"`. The repository git config already sets the author `borbiuk`: never pass `--author`, never change the git config, never add `Co-Authored-By` or "generated by" lines. The title starts with an upper case letter, has at most 72 characters, has no trailing period and is in the imperative mood (`Add the CSV writer`). The pre-commit hook formats and stages everything. Do not use `--no-verify`.
8. Final report (short, English): files created, exports, the exact check command and its result, deviations from the contract, change requests, open questions, anything UNVERIFIED. Do not claim more than you ran.

### A1. config

- Read: ADR 0007 D1 to D7, ADR 0002 "Starting coins" and "Per-source identifiers", ADR 0006 D3 (alert defaults).
- Build:
    - `config/coins.json`: the 10 coins with every per-source id from the ADR 0002 table. `settings`: `phase: "test"`, `stored_sources: ["kraken","coinbase","bitstamp","coinmetrics"]`, `features: { alerts: false, publish: false }`, the other numbers from ADR 0007 D2. Alert overrides: BTC 3% and 8%, ETH 4% and 12%, the rest use the defaults (5% and 15%) (ADR 0006 D3).
    - `config/coins.schema.json`: strict JSON Schema (`additionalProperties: false`), usable by `check-jsonschema`.
    - `src/config.ts`: `loadConfig` with plain-code checks (unique ids, numbers in range, known keys only, every enabled coin has an id for each source in `stored_sources`, `features` and `phase` valid) and `enabledCoins`. Invalid config throws `ConfigError` with a clear message.
    - `tools/check-symbols.ts`: a network script (not part of tests) that checks each enabled coin's ids against the live catalogues of the four sources and prints a table. Exit code 1 if a pair is missing. Used by the non-required CI job (ADR 0007 D4.2).
- Tests: valid config, each failure mode, a test that the sample invalid configs are rejected by both the loader and the schema logic (schema validated by a small in-test check of required keys; full schema validation runs in CI).
- Done when: the checks pass and `coins.json` loads.

### A2. http

- Read: ADR 0005 D5, ADR 0002 decision point 6, ADR 0001 (User-Agent, politeness).
- Build `src/http.ts`: `createHttpClient`. Defaults: timeout 10 s per request, one retry after 2 s (only for timeout and network or 5xx errors, never for 429), `User-Agent: git-coin (+https://github.com/borbiuk/git-coin)`, JSON parse with `parse` error code, response body size cap (5 MB), `ms` measured for the whole call including the retry. HTTP 429 returns `http_429` at once. No logging of bodies.
- Tests with a local `node:http` server: 200, 429 (no retry), 500 then 200 (retry), timeout (use a short `timeoutMs`), invalid JSON, oversize body, injected `retryDelayMs: 0`.

### A3. kraken adapter and analysis tool

- Read: ADR 0002 (Kraken row, "Symbol mapping", Revision 2 points 4 and 6, per-source identifiers), ADR 0004 D7.
- Build `src/sources/kraken.ts` (`krakenAdapter`): one `Ticker?pair=A,B,...` request for the enabled coins with `kraken_pair`. Map result keys to coin ids with the `AssetPairs?pair=...` catalogue (`altname`, `wsname`), not with hard-coded keys. One extra `AssetPairs` request per run is allowed, and both count in the one request-log row (`ms` is the total, `http` is the first non-200 status or 200). If the multi-pair form fails, fall back to `Ticker` without `pair` and filter. Price is the `c[0]` string of the ticker. `age_s` is `null` (Kraken has no timestamp). A pair missing in the result gives `unmapped` for that coin and no row. Unknown shapes give `parse`. The adapter never throws for expected failures.
- Build `tools/analyze-sources.ts`: reads `data/raw/**` and `data/meta/**/requests.csv` from a data root and prints the gate and score tables from ADR 0002 Revision 2 points 7 and 8: availability, 429 or block share, longest failure streak, coins mapped per tick, deviation from the consensus of the other sources (median of the others, same coin, `ts` within 5 minutes; p50, p95, max per coin; count of points more than 1% off), freshness from `age_s`, latency p50 and p95 from `ms`, requests per run. Markdown output, plus `--json`. Gate thresholds are options with the ADR defaults.
- Tests: adapter with fake `HttpClient` (all ten coins, one missing coin, 429, bad shape, fallback path). Analysis tool with small synthetic CSV sets that have known answers (a source with a planted 2% outlier, a source with a 3-failure streak).

### A4. coinbase adapter

- Read: ADR 0002 (Coinbase row, Revision 2 point 4, per-source identifiers), ADR 0004 D7.
- Build `src/sources/coinbase.ts` (`coinbaseAdapter`): `GET https://api.exchange.coinbase.com/products/{coinbase_product}/ticker` for each enabled coin, at most 4 in flight (the limit is 10 per second per IP). `price` string as given. `age_s` from the response `time` (seconds, never negative). Each row's `ts` is taken right after its own response. One request-log row for the whole source: `http` is 200 if all requests succeeded, otherwise the first non-200 status (0 if none), `ms` is the wall time, `coins_ok` the number of rows, `error` the first error code. Partial failure keeps the rows that worked.
- Tests: all ten ok, one 404, one 429, timeout on one, concurrency never above 4 (count in the fake client), `age_s` maths. Fixtures are synthetic. No real Coinbase response may be committed.

### A5. bitstamp and coin metrics adapters

- Read: ADR 0002 (Bitstamp row, Addendum A3, Revision 2, per-source identifiers), ADR 0004 D7.
- Build `src/sources/bitstamp.ts`: `GET https://www.bitstamp.net/api/v2/ticker/` (all markets, one request). Match `bitstamp_market` (for example `btcusd`) to the `pair` field (`BTC/USD`) by normalising. Price is `last`, `age_s` from `timestamp`.
- Build `src/sources/coinmetrics.ts`: `GET https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=<ids>&metrics=ReferenceRateUSD&frequency=1m&limit_per_asset=1&paging_from=end`. Price is `ReferenceRateUSD`, `age_s` from `time`. Handle missing assets (coverage for all ten is UNVERIFIED), `next_page_url`, and the rate limit (HTTP 429 as `http_429`).
- Both adapters follow the same request-log rules as A4. Tests as for A4. Synthetic fixtures.

### A6. storage

- Read: ADR 0004 D1, D3, D6, D7 (D7 describes the request log and the four-column header).
- Build `src/csv.ts`: `dailyPath` (`data/raw/YYYY/MM/DD/<ID>.csv`), `appendRows` (creates the file with header `ts,price,src,age_s`; the `min_spacing` guard works per coin and per `src`; skip a row whose `ts` is earlier than the last stored `ts` of that coin and `src` with reason `clock`; never rewrites an existing line; the price string is written byte for byte; empty `age_s` for `null`), `appendRequestLog` (`data/meta/YYYY/MM/DD/requests.csv`, header `ts,src,http,ms,coins_ok,error`), `readLastRow`.
- Build `src/series.ts`: `createSeriesReader` that reads the daily files for a range, filters by `src`, sorts by `ts`, skips and counts malformed lines.
- Tests: new file and header, append to an existing file, per-`src` independence in one file, spacing skip, clock skip, midnight rollover, malformed lines, price strings such as `0.00001234` and `81232.79000` unchanged, a property-style test that an append never changes bytes already in the file.

### A7. validation and status

- Read: ADR 0004 D4, ADR 0005 D6, ADR 0006 D7, ADR 0002 Revision 2 point 6.
- Build `src/validate.ts`: `validatePrice` (strict decimal pattern, finite, above 0, below 1,000,000,000, the original string is what gets stored), `validateRow` (phase `test`: structural checks only; phase `production`: plus the step check against `previous` with `maxStepPercent`, accepted only when `crosscheck` agrees within `crosscheckMaxDiffPercent`; reasons are short stable codes).
- Build `src/status.ts`: `emptyStatus`, `readStatus` (missing file gives an empty status), `writeStatus` (stable key order, trailing newline), `applyRun`, `needsNoDataIssue`. `RunSummary` carries, per source, the request-log row, rows written, rows rejected with reasons, and the coins missing. Rules: a run that writes no rows increments `consecutive_failures`; a run that writes at least one row resets it and updates `last_point_at`; per-source counters follow the log rows.
- Tests: every reject case (zero, negative, null, text, NaN, huge, `1e5`, leading plus, comma decimal, 50% step with and without cross-check), the streak thresholds, JSON round-trip.

### A8. git writer and keepalive

- Read: ADR 0004 D2 and D6, ADR 0005 D3 and D7, ADR 0009 D1 and D4, ADR 0001 (6 pushes per minute guidance).
- Build `src/gitdata.ts`: `commitAndPush`: run `write()`, run the append-only guard (`git diff --numstat` shows 0 deleted lines under `data/raw` and `data/meta`, otherwise abort without committing), commit as `github-actions[bot]` (noreply email from a constant marked UNVERIFIED until checklist item 6f), push. On a rejected push: fetch, `reset --hard` to the remote branch, run `write()` again, push again, at most 3 tries. No commit when nothing changed. Uses `node:child_process` and the `git` binary only, with argument arrays (no shell strings).
- Build `src/keepalive.ts`: `keepaliveIfStale`: if the last commit on `main` is older than `maxAgeDays`, make an empty commit `Keep schedule active` and push.
- Tests with temp bare repos and clones: normal push, conflict retry (a second clone pushes first, check that `write()` ran again and no row was lost or doubled), guard abort on a deleted line, no commit when there is no change, push failure after 3 tries (returns `pushed: false`), keepalive both branches.

### A9. collector (wave 2, starts after the P1 merge)

- Read: ADR 0005 D3 to D8, ADR 0004 D2 to D4 and D7, ADR 0002 Revision 2, ADR 0006 D7, ADR 0009 D1 and D5, plus every exported module in `src/`.
- Build `src/sources/index.ts` (adapter registry by `SourceId`) and `src/collect.ts`: `runCollect(deps)` where `deps` carries the config, the clock, the `HttpClient`, the adapters, the data root, the git options, the Issue client and flags, so tests can inject everything. Flow: load config; call the adapters for `stored_sources` in parallel; validate rows (phase rules); append rows and the request log in the `write` closure given to `commitAndPush`, together with the status update and, when `features.alerts` is true, the alert step and the `no data` Issue sync; write outputs; handle `--dry-run` (print what would be written, no files, no Issues, no commit); optional `--keepalive`. A failing source does not stop the others. Expected data failure: exit 0, no commit, `consecutive_failures` up. Unexpected exception or invalid config: exit 1. The CLI part only wires real dependencies and parses flags.
- Tests: full runs with fakes and temp git repos: all four sources ok; one source down; all down (no commit, streak up, `no data` Issue after 4); dry run writes nothing; test phase vs production phase; push conflict; idempotent re-run; invalid config exit code.

### A10. alerts

- Read: all of ADR 0006, ADR 0007 D3, ADR 0004 D3.
- Build `src/alerts/**`: pure logic (reference sample choice with tolerance, rolling 1 h and 24 h percentage moves, severity at 1x and 2x, no alert on the first run or across a gap, per-coin and direction state machine with dedup, cooldown, daily cap, auto-close, comment on repeat), the state file `state/alerts.json`, Issue text templates from ADR 0006 D5 using only numbers and our own labels (never untrusted source text), an `IssueClient` interface, a real client over `fetch` (create, comment, close, list; labels; assignee and mention `borbiuk`), and `syncNoDataIssue` for the `[collector] no data` Issue. Rows are read through `SeriesReader` for the primary source (3.4).
- Tests: every row of the ADR 0006 D6 summary as a scenario, tolerance edges, gap handling, cap and cooldown, auto-close, opposite direction, dry run makes no client calls, the real client against a local fake server.

### A11. site builder

- Read: ADR 0008 D1 to D4, ADR 0004 D5, ADR 0005 D3 (publish job).
- Build `src/build-site.ts` and `src/site/**`: from the data checkout, write `status.json`, `latest.json`, `alerts.json`, `coins/<ID>.7d.json`, `coins/<ID>.90d.json`, `coins/<ID>.daily.json` in the shapes of section 3.2. Use only rows of the primary source. 7 days at full resolution, 90 days as hourly last-price points, daily OHLC on UTC days. Gaps stay gaps. Handle an empty data root (first run), a coin with no rows, and coins with `enabled: false`. Prices go to numbers only in the output. CLI as in 3.4.
- Tests with synthetic CSV trees: downsampling, daily OHLC, period stats, gaps, empty data, a disabled coin, deterministic output for a fixed `now`.

### A12. dashboard

- Read: all of ADR 0008, ADR 0009 D7 (disclaimer), ADR 0005 D2 and D6 (stale banners).
- Build `site/index.html`, `site/app.js`, `site/style.css`, `site/lib.js` (pure functions: formatting, stale state from `last_point_at` against the browser clock with 120 minute and 6 hour limits from the status file or defaults, gap breaking at 3 times the median spacing, source label from `src`), `site/vendor/` with uPlot 1.6.32 (minified JS, CSS and the MIT licence text; download it once from a pinned URL on a CDN allowed by ADR 0008, check that the file is the expected version, record the version in a comment at the top of `app.js`). No build step, no frameworks, no third-party requests at run time, same-origin data, `fetch` with `cache: 'no-cache'`. Required: visible disclaimer, "last updated" from `last_point_at`, source and quote label (Kraken, Coinbase, Bitstamp or Coin Metrics, with a link; Coin Metrics also shows the CC BY-NC 4.0 credit), stale and stopped banners, light and dark mode, 375 px mobile layout, keyboard focus, text alternatives.
- Test: `node --test` for `lib.js`. Preview by copying the fixtures in `test/fixtures/ui/data/` next to the page in a temp folder and opening it through any static server. Take screenshots at 375 px and desktop width, light and dark, with the built-in browser. Report what you saw. Do not commit the temp folder.

### A13. workflows

- Read: ADR 0005 D1 to D8, ADR 0009 D1 and D3, ADR 0003, ADR 0007 D4, ADR 0008 D1, ADR 0001, checklist items 8 and 12, and these Hyperfriend files (read them from `~/projects/hyperfriend`): `.github/workflows/{build,pr-title,codeql,dependency-review,scorecard}.yml`, `.github/dependabot.yml`, `.github/codeql/codeql-config.yml`, `.claude/rules/docs-and-ci.md`. They show the job shapes, permissions and pinning style to follow.
- Build `.github/workflows/collect.yml`: cron `3,18,33,48 * * * *` and `workflow_dispatch` (inputs `dry_run`, `mode`), `permissions: {}` at the top, `concurrency: collect` with `cancel-in-progress: false`, `if: github.repository == 'borbiuk/git-coin'` on every job, runner `ubuntu-26.04` with a step that checks `node --version` is major 24, job `collect` (contents write, issues write, `timeout-minutes: 10`: checkout `main` to `code/`, checkout `data` to `data/` with credentials, run the collector with `--keepalive`, expose `should_publish`; set `HUSKY=0`), job `publish` (`needs: collect`, only if `should_publish == 'true'`, contents read, pages write, id-token write, environment `github-pages`: build the site data, copy `code/site`, upload the Pages artifact, deploy). Pin first-party actions by full SHA with a `# vX.Y.Z` comment, resolved from the GitHub API with read-only calls (`GH_TOKEN=$(gh auth token --user borbiuk) gh api ...`; never `gh auth switch`). Start from the SHAs in ADR 0009 D3 and re-resolve them.
- Build the CI set by adapting the Hyperfriend files, with this repo's branch `main` and without extension builds, Playwright, markup or release jobs: `build.yml` (job `build`: `npm ci --ignore-scripts`, `npm audit signatures`, `check:versions`, `format:check`, `lint`, `test` on Node 24, plus a non-required Node 22 run; job `checks`: `lint:docs` and `lint:unused`; job `config`: `check-jsonschema` 0.39.0 pinned for `config/coins.json`, then `actionlint` and `zizmor` on the workflows; job `symbols` (not required): `tools/check-symbols.ts`; `concurrency` per ref, `persist-credentials: false` on every checkout that does not push), `pr-title.yml` (calls `scripts/check-pr-title.mjs`, the title goes in through `env`), `codeql.yml` with `.github/codeql/codeql-config.yml` (`javascript-typescript` and `actions`), `dependency-review.yml`, `scorecard.yml`, and `.github/dependabot.yml` (npm and github-actions weekly, 7-day cooldown, groups as in Hyperfriend, `typescript` never gets a major update).
- Validate: `actionlint` and `zizmor` if installed locally. If not, say so in the report (UNVERIFIED until CI runs). Do not install tools globally without asking.

### A14. throwaway ops, community files and docs

- Read: `docs/adr/pre-implementation-checklist.md` (items 2 to 6, 8, 9), ADR 0005 (pilot decision rule), ADR 0006 D7, ADR 0009 D1 and D7, ADR 0001, and these Hyperfriend files (read them from `~/projects/hyperfriend`): `README.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `.github/{CONTRIBUTING.md,SUPPORT.md,CODEOWNERS,pull_request_template.md}`, `.github/ISSUE_TEMPLATE/*`, `docs/development.md`.
- Build in `docs/implementation/throwaway/` ready-to-copy workflows and short instructions for a throwaway public repo: `pages-test.yml` (item 2), `probe.yml` (item 3: the four sources and keyless CoinGecko, the exact endpoints of ADR 0002, prints status, milliseconds, size and the first 300 characters, `workflow_dispatch` plus a schedule for runs spread over a day), `pilot-5m.yml`, `pilot-15m.yml`, `pilot-30m.yml` (item 4: log timestamps and expected ticks, no price data) with a small analysis script for the delivery table, `issue-email-test.yml` (item 5: three Issue variants and a failing run), `bot-push-test.yml` (item 6 a to f), `canary.yml` (item 9). Each file has a header comment: purpose, how to run, what to record, how to read the result.
- Build `docs/implementation/runbook.md`: the owner's gates G1 to G4 (section 7) as numbered steps with exact commands (make the repo public, first push, create the orphan `data` branch, repository settings, enabling Pages, rulesets, first `dry_run`, starting the test, reading the analysis).
- Build `README.md` with the sections of ADR 0009 D7 (what it is, link to the dashboard, how it works, data sources and attribution, how to add a coin, tests and dry run, known limits, disclaimer, licence, link to `docs/adr/`), in the style of the Hyperfriend README. It must say that the data of the test period is test data provided as is, name the four sources and credit Coin Metrics with a link to CC BY-NC 4.0 (ADR 0002 Revision 2 point 5).
- Build the community files by adapting the Hyperfriend ones: `.github/CONTRIBUTING.md` (setup with `./scripts/with-node24.sh`, `npm run check`, code rules, commit and pull request title rules, no attribution lines), `.github/SUPPORT.md`, `.github/CODEOWNERS` (`* @borbiuk`, plus `/.github/`, `/scripts/`, `/.husky/`, `/config/`), `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/bug_report.md`, `feature_request.md` (add a coin or a source) and `config.yml`, `SECURITY.md` (private vulnerability reporting), `CODE_OF_CONDUCT.md` (copy). Do not create `PRIVACY.md`, `FUNDING.yml`, `LISTING.md` or `RELEASE_NOTES.md` (store and release files that git-coin does not need). `LICENSE` already exists.

### A15. QA and review (wave 3, starts after A9 and the P2 merge)

- Read: everything in `src/`, `site/`, `.github/`, `test/`, all ADRs.
- Do:
    1. Run `npm ci --ignore-scripts` and `npm run check` under Node 24.22.1 from a clean clone of `integration`.
    2. Write end-to-end tests in `test/e2e/` that run `runCollect` against a local bare repo with a fake `HttpClient` for several consecutive runs (day rollover, a source outage, a push conflict, restart in the middle) and then run the site builder and the analysis tool on the result.
    3. Write `docs/implementation/qa-report.md`: a matrix of every ADR decision against the code and tests that implement it (done, partly, missing), the security review (permissions, pinned actions, untrusted strings, secrets, logs), the list of UNVERIFIED items that only a real runner can settle, and the defects found with the owning agent for each.
- Do not fix other agents' files. List the defects. The orchestrator routes them back.

## 6. Orchestrator procedure

P0 (done on 2026-10-29 after the owner's approval, G0):

1. Local git identity set to `Nazariy Borbiuk <41112208+borbiuk@users.noreply.github.com>` in the repository config (the noreply address of the `borbiuk` account, so the public history does not expose an email). The author of every commit is borbiuk. There are no co-author lines.
2. Branch `main`. Tooling files, `CLAUDE.md`, `AGENTS.md` and `.claude/` written from the Hyperfriend set. `src/types.ts`, `src/time.ts`, `test/time.test.ts`. ADR 0003 and related text updated. `npm install` under Node 24.22.1 made `package-lock.json`. `npm run check` passes. First local commit on `main`, then the branch `integration`.

P1:

3. Spawn A14, then A13, A1 to A8, A10, A11, A12 with the Agent tool (`subagent_type: general-purpose`, `isolation: "worktree"`, base `integration`). Each prompt = rules 5.1 + the agent section + sections 3 and 4. All in one message so they run concurrently, or in the two batches of section 2.
4. When an agent reports, do not trust the report. In its worktree run `./scripts/with-node24.sh npm run check` and read the result. If it fails, send the output back to the same agent with `SendMessage`. Also check the author of its commits (`git log --format='%an <%ae>%n%b'`): it must be borbiuk and have no trailers.

P2:

5. Merge verified branches into `integration` with `git merge --no-ff`, in any order (paths are disjoint). After each batch run `npm run check`. Apply contract change requests to `src/types.ts` and the ADRs (one commit each). If a merge conflicts, that is an ownership bug: fix it and note it in the final report.
6. Spawn A9 from `integration`. Verify and merge as in steps 4 and 5.

P3:

7. Spawn A15 from `integration`. Route its defects to the owning agents by `SendMessage`. Re-run until `npm run check` and the e2e tests pass.
8. Write `.claude/rules/docs-and-ci.md`, `.claude/skills/verify/SKILL.md` and the `code-reviewer` and `qa-engineer` agents from the final scripts and workflows (as in Hyperfriend). Update the ADRs for anything the implementation learned. Fast-forward `main` to `integration`. Do not push.

P4 to P5: see section 7. After the 14 days: run `tools/analyze-sources.ts`, put the table in ADR 0002 as Revision 3 together with the owner's choice, then change the config (`stored_sources`, `phase: "production"`, `features`), and use `SendMessage` to the existing agents for any rework. No new agents are spawned after A15, so the limit of 15 holds.

Agent count: A1 to A15 = 15 spawned. Peak parallelism: 13 (P1).

## 7. Owner gates (agents cannot do these)

| Gate | What the owner does                                                                                                                                                                                                                                                                                         | Needs                                             | Unblocks              |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------- |
| G0   | Approves local commits, local branches and git worktrees on this machine. No push.                                                                                                                                                                                                                          | the plan                                          | P0                    |
| G1   | Makes `borbiuk/git-coin` public (it is private on GitHub today, and the design needs a public repo), pushes `main`, sets repository settings (Pages source "GitHub Actions", secret scanning, push protection, rulesets for `main` and `data`, Actions notifications), see the runbook and checklist item 8 | P3 done, A14 runbook                              | G3                    |
| G2   | In a throwaway public repo: runs `pages-test`, `probe`, `issue-email-test`, `bot-push-test`, starts the 72-hour `pilot` and the 60-day `canary` (checklist items 2 to 6 and 9). The orchestrator may create the throwaway repo with the `borbiuk` token only if the owner says yes.                         | A14 templates (early in P1)                       | G3                    |
| G3   | Creates the orphan `data` branch, runs `collect.yml` once by hand with `dry_run`, then once for real, then lets the schedule run in `phase: "test"` for 14 days                                                                                                                                             | G1, G2 results (probe and bot push pass), P3 done | P5                    |
| G4   | Reviews the analysis, chooses the source, approves ADR Revision 3 and the switch to production                                                                                                                                                                                                              | the 14-day data                                   | production            |
| G5   | Confirms the licence (MIT, copied from Hyperfriend; `LICENSE` is already in the repo) and accepts the Actions grey-area risk in writing                                                                                                                                                                     | ADR 0001, 0009                                    | the first public push |

G2 can run in parallel with P1 to P3. The 72-hour pilot is the longest wait before G3, so G2 should start as soon as A14 reports.

## 8. Coverage of the ADRs

| ADR                        | Built by                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| 0001 policy                | A2 (User-Agent, politeness), A14 (README disclaimers), A13 (workflow limits), A15 (review) |
| 0002 sources               | A3, A4, A5, A9 (parallel run), A1 (identifiers), A3 (analysis)                             |
| 0003 runtime               | P0, A13 (CI), every agent (code rules)                                                     |
| 0004 data                  | A6, A7, A8, A9                                                                             |
| 0005 schedule and workflow | A13, A9, A14 (pilot templates)                                                             |
| 0006 alerts                | A10, A9 (wiring)                                                                           |
| 0007 config                | A1                                                                                         |
| 0008 dashboard             | A11, A12, A13 (publish job)                                                                |
| 0009 security and testing  | A13 (permissions, pins, CI), A15 (review), every agent (tests)                             |

## 9. Risks of this plan

| #   | Risk                                                                                                    | Mitigation                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | Local Node 26 hides a Node 24 problem                                                                   | every check runs under 24.22.1 (P0 step 1); CI also runs on 24                                                                |
| 2   | Agents drift from the contract and the merge fails type checks                                          | the contract is typed; `tsc` runs in every worktree and after every merge; A9 and A15 catch the rest                          |
| 3   | 13 parallel agents hit a rate limit or cost too much                                                    | two-batch start (section 2); the owner can lower the number, with no change to ownership                                      |
| 4   | An adapter works against fixtures but not against the real API                                          | fixtures are shaped from one live call; the runner probe (G2) and the dry run (G3) are the real test                          |
| 5   | The real Coinbase or Coin Metrics response differs (for example Coin Metrics coverage of all ten coins) | adapters return `unmapped` or `parse` and keep the other coins; the probe lists the catalogues; ADR 0002 open items stay open |
| 6   | The collector's `AssetPairs` call counts against the single request budget of Kraken                    | it is one extra call per run, inside the same log row; the probe measures it                                                  |
| 7   | An agent edits a file it does not own                                                                   | disjoint table (section 4); the orchestrator reviews each diff against the owner list before merging                          |
| 8   | Vendoring uPlot needs network and a checksum                                                            | A12 downloads once, checks the version string in the file, records it; Dependabot cannot update it (ADR 0008 D1)              |
| 9   | Actions code cannot be run locally                                                                      | `actionlint` and `zizmor` locally if present; the throwaway repo and G3 dry run do the real check                             |
| 10  | The test phase puts real data from four sources into the public `data` branch                           | decided by the owner (ADR 0002 Revision 2, point 9)                                                                           |
