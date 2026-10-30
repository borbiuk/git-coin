// The collector (ADR 0005 D3, plan section 3.4). Fetches the sources in parallel, validates the rows,
// appends rows, the request log and the status to the `data` checkout, commits and pushes.
// This is the only module that wires the others together.

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleepMs } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import {
	createGitHubIssueClient,
	runAlerts,
	syncNoDataIssue,
} from './alerts/index.ts';
import type { IssueClient } from './alerts/index.ts';
import { ConfigError, enabledCoins, loadConfig } from './config.ts';
import { appendRequestLog, appendRows, readLastRow } from './csv.ts';
import { fetchGapRows, readPending, writePending } from './gapfill.ts';
import type { GapResult, GapTarget } from './gapfill.ts';
import { BOT_AUTHOR, commitAndPush } from './gitdata.ts';
import type { GitOpts } from './gitdata.ts';
import { createHttpClient } from './http.ts';
import { keepaliveIfStale } from './keepalive.ts';
import { createSeriesReader } from './series.ts';
import { ADAPTERS } from './sources/index.ts';
import {
	applyRun,
	needsNoDataIssue,
	readStatus,
	writeStatus,
} from './status.ts';
import type { RunSummary } from './status.ts';
import { isoSeconds, parseIso } from './time.ts';
import { SRC_CODE } from './types.ts';
import type {
	Config,
	HttpClient,
	PriceRow,
	SourceAdapter,
	SourceId,
	SourceRun,
	Status,
} from './types.ts';
import { validateRow } from './validate.ts';

// The 60 day rule of GitHub is handled with a margin (ADR 0005 D7)
const KEEPALIVE_MAX_AGE_DAYS = 30;
const DATA_BRANCH = 'data';
const DEFAULT_DASHBOARD_URL = 'https://borbiuk.github.io/git-coin/';
const REPOSITORY_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const MINUTE_MS = 60_000;
/** Pause between two requests of the gap fill (11 markets, one request each). */
const GAP_FILL_PAUSE_MS = 500;

export interface CollectDeps {
	config: Config;
	/** The clock. The adapters take their row times from it too. */
	now: () => Date;
	http: HttpClient;
	/** The adapter of each source. A source in `stored_sources` without an adapter is a bug (exit 1). */
	adapters: Partial<Record<SourceId, SourceAdapter>>;
	/** The checkout of the `data` branch. Rows go to `<dataRoot>/data/...`, state to `<dataRoot>/state/...`. */
	dataRoot: string;
	git: GitOpts;
	/** Used only by the alert step and the `no data` Issue. `null` skips both. */
	issueClient: IssueClient | null;
	dryRun: boolean;
	/** The public address of the dashboard, for the Issue text. */
	dashboardUrl: string;
	/** The checkout of `main`. `null` turns the keepalive step off. */
	keepalive: { mainDir: string; maxAgeDays: number } | null;
	/** Fills the time of missed runs with Bitstamp candles (ADR 0005 D8). `null` turns it off. */
	gapFill: { pauseMs: number } | null;
	log: (line: string) => void;
}

interface CollectResult {
	exitCode: 0 | 1;
	shouldPublish: boolean;
	rowsWritten: number;
}

/** What one source gave, after validation. */
interface Checked {
	run: SourceRun;
	valid: PriceRow[];
	rejected: Array<{ coin: string; reason: string }>;
	/** Enabled coins of the source that came back without a row. */
	missing: string[];
	/** Valid rows that the spacing guard is expected to accept. */
	appendable: number;
}

interface Applied {
	written: PriceRow[];
	/** Candle rows of the gap fill that were written before the rows of the run. */
	gapWritten: number;
	skipped: number;
	previousStatus: Status;
	status: Status;
	shouldPublish: boolean;
}

function describeError(error: unknown): string {
	const text =
		error instanceof Error
			? `${error.name}: ${error.message}`
			: 'unknown error';
	return (text.split('\n')[0] ?? '').slice(0, 200);
}

function minuteOf(date: Date): string {
	return `${isoSeconds(date).slice(0, 16)}Z`;
}

async function readTextOrNull(file: string): Promise<string | null> {
	try {
		return await readFile(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return null;
		}
		throw error;
	}
}

/** An unexpected throw of an adapter becomes a failed log row. The other sources go on. */
async function callAdapter(
	deps: CollectDeps,
	adapter: SourceAdapter
): Promise<SourceRun> {
	const coins = enabledCoins(deps.config, adapter.id);
	const started = deps.now();
	try {
		return await adapter.fetchPrices(coins, deps.http, deps.now);
	} catch (error) {
		deps.log(`${adapter.src}: the adapter threw: ${describeError(error)}`);
		const finished = deps.now();
		return {
			src: adapter.src,
			rows: [],
			log: {
				ts: isoSeconds(finished),
				src: adapter.src,
				http: 0,
				ms: Math.max(0, finished.getTime() - started.getTime()),
				coins_ok: 0,
				error: 'parse',
			},
		};
	}
}

/** A row that the CSV writer would refuse is rejected here, so it cannot stop the other rows. */
function shapeProblem(row: PriceRow): string | null {
	if (!ISO_SECONDS.test(row.ts) || Number.isNaN(Date.parse(row.ts))) {
		return 'bad_ts';
	}
	if (row.age_s !== null && !Number.isInteger(row.age_s)) {
		return 'bad_age';
	}
	return null;
}

/**
 * Validates the rows of every source (phase rules) and counts the rows the spacing guard will accept.
 * Reads the data files, never writes. `appendRows` stays the judge of the spacing.
 */
async function checkRuns(
	deps: CollectDeps,
	runs: SourceRun[],
	now: Date
): Promise<Checked[]> {
	const settings = deps.config.settings;
	const spacingMs = settings.min_spacing_seconds * 1000;
	const checked: Checked[] = [];
	for (const [index, run] of runs.entries()) {
		const sourceId = settings.stored_sources[index];
		const valid: PriceRow[] = [];
		const rejected: Array<{ coin: string; reason: string }> = [];
		let appendable = 0;
		for (const row of run.rows) {
			const shape = shapeProblem(row);
			if (shape !== null) {
				rejected.push({ coin: row.coin, reason: shape });
				continue;
			}
			const last = await readLastRow(deps.dataRoot, row.coin, row.src);
			const verdict = validateRow(row, {
				phase: settings.phase,
				previous: last === null ? null : Number(last.price),
				previousAgeSeconds:
					last === null
						? null
						: (now.getTime() - parseIso(last.ts)) / 1000,
				maxStepPercent: settings.max_step_move_percent,
				crosscheckMaxDiffPercent: settings.crosscheck_max_diff_percent,
			});
			if (!verdict.ok) {
				rejected.push({ coin: row.coin, reason: verdict.reason });
				continue;
			}
			valid.push(row);
			if (last === null) {
				appendable += 1;
				continue;
			}
			const gap = parseIso(row.ts) - parseIso(last.ts);
			if (gap >= 0 && gap >= spacingMs) {
				appendable += 1;
			}
		}
		const have = new Set(run.rows.map((row) => row.coin));
		const missing =
			sourceId === undefined
				? []
				: enabledCoins(deps.config, sourceId)
						.map((coin) => coin.id)
						.filter((id) => !have.has(id));
		checked.push({ run, valid, rejected, missing, appendable });
	}
	return checked;
}

function logSources(deps: CollectDeps, checked: Checked[]): void {
	for (const item of checked) {
		const log = item.run.log;
		deps.log(
			`${log.src}: http ${log.http}, ${log.ms} ms, ${log.coins_ok} coins ok, ${item.missing.length} missing, error ${log.error === '' ? 'none' : log.error}`
		);
		for (const reject of item.rejected) {
			deps.log(`${log.src}: rejected ${reject.coin}: ${reject.reason}`);
		}
	}
}

/**
 * True when the dashboard should be published after this run (ADR 0005 D3).
 * The phase does not matter: the site shows the rows of the primary source only,
 * so it can be published while several sources are stored (owner decision, 2026-10-29).
 */
function decidePublish(config: Config, prev: Status, now: Date): boolean {
	const { features, publish_min_interval_minutes } = config.settings;
	if (!features.publish) {
		return false;
	}
	if (prev.last_publish_at === null) {
		return true;
	}
	return (
		now.getTime() - parseIso(prev.last_publish_at) >=
		publish_min_interval_minutes * MINUTE_MS
	);
}

/**
 * The part that can run again after a rejected push: it appends the rows and the request log and
 * writes the status. It reads the files it needs from the checkout, so a re-run after a reset is safe.
 */
async function applyToCheckout(
	deps: CollectDeps,
	checked: Checked[],
	gapFill: GapResult | null,
	now: Date
): Promise<Applied> {
	const settings = deps.config.settings;
	// The candles come first, so the rows of every source stay in time order
	const gap = await appendRows(deps.dataRoot, gapFill?.rows ?? [], {
		minSpacingSeconds: settings.min_spacing_seconds,
	});
	if (gapFill !== null) {
		await writePending(
			path.join(deps.dataRoot, 'state', 'gapfill.json'),
			gapFill.pending
		);
	}
	const { written, skipped } = await appendRows(
		deps.dataRoot,
		checked.flatMap((item) => item.valid),
		{ minSpacingSeconds: settings.min_spacing_seconds }
	);
	await appendRequestLog(
		deps.dataRoot,
		checked.map((item) => item.run.log)
	);

	const summary: RunSummary = {
		phase: settings.phase,
		sources: checked.map((item) => {
			return {
				log: item.run.log,
				written: written.filter((row) => row.src === item.run.src),
				rejected: item.rejected,
				missingCoins: item.missing,
				skipped: skipped.filter(
					(entry) => entry.row.src === item.run.src
				).length,
			};
		}),
	};
	const statusPath = path.join(deps.dataRoot, 'state', 'status.json');
	const prev = await readStatus(statusPath);
	let status = applyRun(prev, summary, now);
	const shouldPublish = decidePublish(deps.config, prev, now);
	if (shouldPublish) {
		status = { ...status, last_publish_at: isoSeconds(now) };
	}
	await writeStatus(statusPath, status);
	for (const item of skipped) {
		deps.log(`skipped ${item.row.coin} ${item.row.src}: ${item.reason}`);
	}
	return {
		written,
		gapWritten: gap.written.length,
		skipped: skipped.length,
		previousStatus: prev,
		status,
		shouldPublish,
	};
}

/**
 * Alerts run after the data push, so an Issue never points at data that was not pushed, and a
 * rejected push cannot run the Issue calls twice. The alert state is committed on its own, and
 * only when it changed. Nothing here may fail the run (ADR 0006).
 */
async function alertStep(deps: CollectDeps, now: Date): Promise<void> {
	const client = deps.issueClient;
	if (client === null) {
		deps.log('alerts: skipped, there is no Issue client');
		return;
	}
	const statePath = path.join(deps.dataRoot, 'state', 'alerts.json');
	try {
		const before = await readTextOrNull(statePath);
		const summary = await runAlerts({
			config: deps.config,
			reader: createSeriesReader(deps.dataRoot, (file, count) => {
				deps.log(`Skipped ${count} malformed line(s) in ${file}`);
			}),
			client,
			now,
			statePath,
			dashboardUrl: deps.dashboardUrl,
			dryRun: false,
		});
		deps.log(
			`alerts: checked ${summary.checked}, created ${summary.created}, commented ${summary.commented}, closed ${summary.closed}, suppressed ${summary.suppressed}, errors ${summary.errors.length}`
		);
		for (const message of summary.errors) {
			deps.log(`alerts: ${message}`);
		}
		const after = await readTextOrNull(statePath);
		if (after !== null && after !== before) {
			const saved = await commitAndPush(
				deps.git,
				`state: alerts ${minuteOf(now)}`,
				async () => {
					await mkdir(path.dirname(statePath), { recursive: true });
					await writeFile(statePath, after, 'utf8');
				}
			);
			if (!saved.pushed) {
				deps.log('alerts: the state commit was not pushed');
			}
		}
	} catch (error) {
		deps.log(`alerts: failed: ${describeError(error)}`);
	}
}

/**
 * Keeps the `[collector] no data` Issue in step with the status, in both phases. A healthy run
 * (before and after) makes no API call. A failure here never fails the run.
 */
async function noDataStep(
	deps: CollectDeps,
	previous: Status,
	status: Status
): Promise<void> {
	const client = deps.issueClient;
	if (
		client === null ||
		deps.dryRun ||
		(!needsNoDataIssue(previous) && !needsNoDataIssue(status))
	) {
		return;
	}
	try {
		await syncNoDataIssue(client, needsNoDataIssue(status), deps.dryRun);
	} catch (error) {
		deps.log(`no data Issue: failed: ${describeError(error)}`);
	}
}

/**
 * The candle rows for the missing time of every coin that has a Bitstamp market. The missing time starts
 * at an open gap of an earlier run, else at the newest stored row. Reads the data files and calls
 * Bitstamp, never writes. A failure gives fewer rows and an open gap, never an error. `null`: off.
 */
async function gapStep(
	deps: CollectDeps,
	now: Date
): Promise<GapResult | null> {
	if (deps.gapFill === null) {
		return null;
	}
	try {
		const open = await readPending(
			path.join(deps.dataRoot, 'state', 'gapfill.json')
		);
		const codes = [
			...deps.config.settings.stored_sources.map((id) => SRC_CODE[id]),
			'bs-ohlc' as const,
		];
		const targets: GapTarget[] = [];
		for (const coin of deps.config.coins) {
			const market = coin.sources.bitstamp_market;
			if (!coin.enabled || market === undefined) {
				continue;
			}
			let fromSec: number | null = null;
			const earlier = open[coin.id];
			if (earlier !== undefined) {
				fromSec = parseIso(earlier) / 1000;
			} else {
				for (const code of codes) {
					const last = await readLastRow(
						deps.dataRoot,
						coin.id,
						code
					);
					if (last !== null) {
						fromSec = Math.max(
							fromSec ?? 0,
							parseIso(last.ts) / 1000
						);
					}
				}
			}
			if (fromSec !== null) {
				targets.push({ coin: coin.id, market, fromSec });
			}
		}
		return await fetchGapRows(targets, {
			http: deps.http,
			nowSec: Math.floor(now.getTime() / 1000),
			pauseMs: deps.gapFill.pauseMs,
			sleep: sleepMs,
			log: deps.log,
		});
	} catch (error) {
		deps.log(`gap fill: failed: ${describeError(error)}`);
		return null;
	}
}

async function collect(deps: CollectDeps): Promise<CollectResult> {
	const settings = deps.config.settings;
	const adapters = settings.stored_sources.map((id) => {
		const adapter = deps.adapters[id];
		if (adapter === undefined) {
			throw new Error(`There is no adapter for the source ${id}`);
		}
		return adapter;
	});

	const runs = await Promise.all(
		adapters.map((adapter) => callAdapter(deps, adapter))
	);
	const now = deps.now();
	const checked = await checkRuns(deps, runs, now);
	logSources(deps, checked);

	const appendable = checked.reduce((sum, item) => sum + item.appendable, 0);
	if (deps.dryRun) {
		deps.log(
			`dry run: ${appendable} rows would be written, nothing was written, no Issue was touched`
		);
		return { exitCode: 0, shouldPublish: false, rowsWritten: 0 };
	}

	const gapFill = await gapStep(deps, now);
	const box: { applied?: Applied } = {};
	const result = await commitAndPush(
		deps.git,
		// Built after each try's write(), from the rows that try really appended
		() => {
			const count = box.applied?.written.length ?? 0;
			const gap = box.applied?.gapWritten ?? 0;
			return `data: ${minuteOf(now)} ${count} ${count === 1 ? 'row' : 'rows'}${gap > 0 ? `, ${gap} gap fill` : ''}`;
		},
		async () => {
			box.applied = await applyToCheckout(deps, checked, gapFill, now);
		}
	);
	const applied = box.applied;
	if (!result.pushed || applied === undefined) {
		deps.log(
			`error: the data commit was not pushed (${result.tries} tries)`
		);
		return { exitCode: 1, shouldPublish: false, rowsWritten: 0 };
	}
	deps.log(
		`pushed after ${result.tries} ${result.tries === 1 ? 'try' : 'tries'}: ${applied.written.length} rows written, ${applied.skipped} skipped, consecutive failures ${applied.status.consecutive_failures}`
	);

	if (applied.gapWritten > 0) {
		deps.log(`gap fill: ${applied.gapWritten} candle rows written`);
	}
	if (settings.phase === 'production' && settings.features.alerts) {
		await alertStep(deps, now);
	}
	await noDataStep(deps, applied.previousStatus, applied.status);
	return {
		exitCode: 0,
		shouldPublish: applied.shouldPublish,
		rowsWritten: applied.written.length,
	};
}

async function keepaliveStep(deps: CollectDeps): Promise<void> {
	if (deps.keepalive === null || deps.dryRun) {
		return;
	}
	try {
		const pushed = await keepaliveIfStale({
			mainDir: deps.keepalive.mainDir,
			now: deps.now(),
			maxAgeDays: deps.keepalive.maxAgeDays,
			author: BOT_AUTHOR,
		});
		deps.log(
			pushed
				? 'keepalive: pushed an empty commit to main'
				: 'keepalive: not needed'
		);
	} catch (error) {
		deps.log(`keepalive: failed: ${describeError(error)}`);
	}
}

/**
 * One collector run. Expected data failures give exit code 0. An unexpected exception gives 1.
 * An all-failed run still commits the request log and the status: the dashboard and the analysis need them.
 */
export async function runCollect(deps: CollectDeps): Promise<CollectResult> {
	try {
		return await collect(deps);
	} catch (error) {
		deps.log(`error: ${describeError(error)}`);
		return { exitCode: 1, shouldPublish: false, rowsWritten: 0 };
	} finally {
		await keepaliveStep(deps);
	}
}

/** `https://<owner>.github.io/<repo>/` from `GITHUB_REPOSITORY`, or the default. */
function dashboardUrlFor(repository: string | undefined): string {
	const match =
		repository === undefined ? null : REPOSITORY_PATTERN.exec(repository);
	if (match === null) {
		return DEFAULT_DASHBOARD_URL;
	}
	return `https://${(match[1] ?? '').toLowerCase()}.github.io/${match[2] ?? ''}/`;
}

interface CliOverrides {
	http?: HttpClient;
	adapters?: CollectDeps['adapters'];
	issueClient?: IssueClient | null;
	log?: (line: string) => void;
}

/** The command line (plan section 3.4). Returns the exit code. `overrides` is for tests. */
export async function runCli(
	argv: string[],
	env: NodeJS.ProcessEnv,
	overrides: CliOverrides = {}
): Promise<number> {
	const log =
		overrides.log ??
		((line: string): void => {
			console.log(line);
		});
	let deps: CollectDeps;
	try {
		const { values } = parseArgs({
			args: argv,
			options: {
				config: { type: 'string' },
				'data-root': { type: 'string' },
				'code-root': { type: 'string' },
				keepalive: { type: 'boolean', default: false },
				'dry-run': { type: 'boolean', default: false },
				now: { type: 'string' },
			},
			strict: true,
			allowPositionals: false,
		});
		if (values.config === undefined || values['data-root'] === undefined) {
			throw new Error('Both --config and --data-root are required');
		}
		if (values.keepalive && values['code-root'] === undefined) {
			throw new Error('--keepalive needs --code-root');
		}
		let now = (): Date => new Date();
		if (values.now !== undefined) {
			const fixed = new Date(parseIso(values.now));
			now = (): Date => new Date(fixed);
		}
		const config = await loadConfig(values.config);
		const dryRun = values['dry-run'];
		// Both phases may need the client (the `no data` Issue). Without a token there is none.
		const clientWanted =
			!dryRun &&
			env.GITHUB_TOKEN !== undefined &&
			env.GITHUB_TOKEN !== '';
		const dataRoot = path.resolve(values['data-root']);
		deps = {
			config,
			now,
			http: overrides.http ?? createHttpClient(),
			adapters: overrides.adapters ?? ADAPTERS,
			dataRoot,
			git: { repoDir: dataRoot, branch: DATA_BRANCH },
			issueClient:
				overrides.issueClient !== undefined
					? overrides.issueClient
					: clientWanted
						? createGitHubIssueClient(env)
						: null,
			dryRun,
			dashboardUrl: dashboardUrlFor(env.GITHUB_REPOSITORY),
			keepalive:
				values.keepalive && values['code-root'] !== undefined
					? {
							mainDir: path.resolve(values['code-root']),
							maxAgeDays: KEEPALIVE_MAX_AGE_DAYS,
						}
					: null,
			gapFill: { pauseMs: GAP_FILL_PAUSE_MS },
			log,
		};
	} catch (error) {
		const kind = error instanceof ConfigError ? 'invalid config' : 'error';
		log(`${kind}: ${describeError(error)}`);
		return 1;
	}

	const result = await runCollect(deps);
	const outputPath = env.GITHUB_OUTPUT;
	if (outputPath !== undefined && outputPath !== '') {
		try {
			await appendFile(
				outputPath,
				`should_publish=${result.shouldPublish}\nrows_written=${result.rowsWritten}\n`,
				'utf8'
			);
		} catch (error) {
			log(`error: cannot write the outputs: ${describeError(error)}`);
			return 1;
		}
	}
	return result.exitCode;
}

if (import.meta.main) {
	process.exitCode = await runCli(process.argv.slice(2), process.env);
}
