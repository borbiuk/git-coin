// Backfill of 15-minute candle closes into a data checkout (ADR 0004 D1, ADR 0007 D8). Run it when the history
// of a coin is too thin, and after a new coin was added to config/coins.json. It is safe to run again: it
// continues after the last stored row of each coin and source, and it only appends.
//
// Providers (the `src` of the rows): `coinbase` (`cb-ohlc`), `kraken-trades` (`kt-ohlc`, candles built from the
// trades, because Kraken keeps only 720 candles) and `okx` (`ok-ohlc`, prices in USDT). Bitstamp has its own tool:
// tools/backfill-bitstamp.ts. Daily Kraken closes: tools/backfill-kraken.ts.
// The providers run side by side, each at its own pace. Coins of one provider run in turn or in a few lanes.
//
// Guards: a close is not written when it is more than `crosscheck_max_diff_percent` away from the close of
// another source at the same time, or more than `max_step_move_percent` away from the close before it.
// Run: node tools/backfill.ts --data-root <checkout of the data branch> [--dry-run]

import { setTimeout as sleepMs } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { loadConfig } from '../src/config.ts';
import { appendRows, readLastRow } from '../src/csv.ts';
import { createHttpClient } from '../src/http.ts';
import { createSeriesReader } from '../src/series.ts';
import { isoSeconds, parseIso } from '../src/time.ts';
import type {
	CoinConfig,
	Config,
	HttpClient,
	PriceRow,
	SrcCode,
} from '../src/types.ts';

import { coverageOf } from './audit-coverage.ts';
import {
	COINBASE_WINDOW_SECONDS,
	STEP_SECONDS,
	createPace,
	fetchCoinbase,
	fetchKrakenTrades,
	fetchOkx,
} from './backfill-providers.ts';
import type { CandleClose, FetchContext } from './backfill-providers.ts';

export type ProviderName = 'coinbase' | 'kraken-trades' | 'okx';

interface ProviderInfo {
	src: SrcCode;
	/** The field of `CoinConfig.sources` with the market of the coin. */
	field: 'coinbase_product' | 'kraken_pair' | 'okx_market';
	/** Milliseconds between two request starts. The limits: Coinbase 10 a second, Kraken about 1, OKX 20 in 2 s. */
	paceMs: number;
	/** Coins that run at once. */
	lanes: number;
}

export const PROVIDERS: Record<ProviderName, ProviderInfo> = {
	coinbase: {
		src: 'cb-ohlc',
		field: 'coinbase_product',
		paceMs: 125,
		lanes: 4,
	},
	'kraken-trades': {
		src: 'kt-ohlc',
		field: 'kraken_pair',
		paceMs: 1100,
		lanes: 1,
	},
	okx: { src: 'ok-ohlc', field: 'okx_market', paceMs: 150, lanes: 2 },
};

/** The order in which a provider is picked for a coin that has the market on several of them. */
const PRIORITY: ProviderName[] = ['coinbase', 'kraken-trades', 'okx'];

const DEFAULT_FROM = '2024-01-01T00:00:00Z';
const DEFAULT_MIN_COVERAGE = 0.8;
/** Sources whose closes are compared with a new close of the same time. OKX is in USDT, so it is left out. */
const COMPARE_SRCS: SrcCode[] = ['cb-ohlc', 'kt-ohlc', 'bs-ohlc', 'kr-ohlc'];

export interface Task {
	coin: string;
	provider: ProviderName;
	market: string;
}

export interface TaskResult {
	requests: number;
	written: number;
	skipped: number;
	flagged: number;
}

export interface RunOptions {
	dataRoot: string;
	config: Config;
	http: HttpClient;
	fromSec: number;
	untilSec: number;
	sleep: (ms: number) => Promise<void>;
	log: (line: string) => void;
}

/** The provider of a coin: the first of PRIORITY that has a market for it. */
export function providerFor(coin: CoinConfig): ProviderName | null {
	return (
		PRIORITY.find(
			(name) => coin.sources[PROVIDERS[name].field] !== undefined
		) ?? null
	);
}

function percentDiff(a: number, b: number): number {
	return Math.abs(a / b - 1) * 100;
}

/** The closes of the other sources of one coin by candle end time, for the cross-check. */
async function otherCloses(
	opts: RunOptions,
	coin: string,
	own: SrcCode
): Promise<Map<number, number>> {
	const reader = createSeriesReader(opts.dataRoot, () => {});
	const from = isoSeconds(new Date(opts.fromSec * 1000));
	const to = isoSeconds(new Date(opts.untilSec * 1000));
	const map = new Map<number, number>();
	for (const src of COMPARE_SRCS) {
		if (src === own) {
			continue;
		}
		for (const point of await reader.readSeries(coin, from, to, src)) {
			map.set(parseIso(point.ts) / 1000, Number(point.price));
		}
	}
	return map;
}

/** Backfills one coin from one provider. */
export async function runTask(
	task: Task,
	opts: RunOptions,
	pace: () => Promise<void>
): Promise<TaskResult> {
	const info = PROVIDERS[task.provider];
	const settings = opts.config.settings;
	const last = await readLastRow(opts.dataRoot, task.coin, info.src);
	const lastSec = last === null ? 0 : parseIso(last.ts) / 1000;
	const startSec = Math.max(opts.fromSec, lastSec);
	const result: TaskResult = {
		requests: 0,
		written: 0,
		skipped: 0,
		flagged: 0,
	};
	if (startSec >= opts.untilSec) {
		opts.log(`${task.coin} (${task.provider}): nothing to do`);
		return result;
	}
	const others = await otherCloses(opts, task.coin, info.src);
	const ctx: FetchContext = {
		http: opts.http,
		pace,
		sleep: opts.sleep,
		log: (line) => opts.log(`${task.coin}: ${line}`),
	};
	let written = lastSec;
	let previous: number | null = last === null ? null : Number(last.price);
	const reasons = { cross: 0, step: 0 };

	async function emit(candles: CandleClose[]): Promise<void> {
		const rows: PriceRow[] = [];
		for (const candle of candles) {
			if (
				candle.endSec <= written ||
				candle.endSec > opts.untilSec ||
				Number(candle.volume) === 0
			) {
				continue;
			}
			const price = Number(candle.close);
			const other = others.get(candle.endSec);
			if (
				other !== undefined &&
				info.src !== 'ok-ohlc' &&
				percentDiff(price, other) > settings.crosscheck_max_diff_percent
			) {
				reasons.cross += 1;
				opts.log(
					`${task.coin}: ${isoSeconds(new Date(candle.endSec * 1000))} ${candle.close} differs from another source (${other}), left out`
				);
				written = candle.endSec;
				continue;
			}
			if (
				previous !== null &&
				percentDiff(price, previous) > settings.max_step_move_percent
			) {
				reasons.step += 1;
				opts.log(
					`${task.coin}: ${isoSeconds(new Date(candle.endSec * 1000))} ${candle.close} is a step of more than ${settings.max_step_move_percent}% from ${previous}, left out`
				);
				written = candle.endSec;
				continue;
			}
			previous = price;
			written = candle.endSec;
			rows.push({
				ts: isoSeconds(new Date(candle.endSec * 1000)),
				coin: task.coin,
				price: candle.close,
				src: info.src,
				age_s: null,
			});
		}
		const appended = await appendRows(opts.dataRoot, rows, {
			minSpacingSeconds: settings.min_spacing_seconds,
		});
		result.written += appended.written.length;
		result.skipped += appended.skipped.length;
	}

	if (task.provider === 'coinbase') {
		result.requests = await fetchCoinbase(
			task.market,
			startSec,
			opts.untilSec,
			ctx,
			emit
		);
	} else if (task.provider === 'kraken-trades') {
		result.requests = await fetchKrakenTrades(
			task.market,
			startSec,
			opts.untilSec,
			ctx,
			emit
		);
	} else {
		const found = await fetchOkx(task.market, startSec, opts.untilSec, ctx);
		result.requests = found.requests;
		await emit(found.candles);
	}
	result.flagged = reasons.cross + reasons.step;
	opts.log(
		`${task.coin} (${task.provider}, ${task.market}): ${result.requests} requests, ${result.written} rows written, ${result.skipped} skipped by the spacing or clock rule, ${reasons.cross} left out by the cross-check, ${reasons.step} left out by the step check`
	);
	return result;
}

/** Runs the tasks: the providers side by side, and in each provider `lanes` coins at once. */
export async function runAll(
	tasks: Task[],
	opts: RunOptions
): Promise<{ failed: Task[]; written: number }> {
	const failed: Task[] = [];
	let written = 0;
	const names = [...new Set(tasks.map((task) => task.provider))];
	await Promise.all(
		names.map(async (name) => {
			const info = PROVIDERS[name];
			const queue = tasks.filter((task) => task.provider === name);
			const pace = createPace(info.paceMs, opts.sleep);
			let next = 0;
			async function lane(): Promise<void> {
				while (next < queue.length) {
					const task = queue[next];
					next += 1;
					if (task === undefined) {
						return;
					}
					try {
						const done = await runTask(task, opts, pace);
						written += done.written;
					} catch (error) {
						failed.push(task);
						opts.log(
							`${task.coin} (${task.provider}): stopped: ${(error as Error).message}`
						);
					}
				}
			}
			await Promise.all(
				Array.from({ length: Math.min(info.lanes, queue.length) }, lane)
			);
		})
	);
	return { failed, written };
}

export interface Comparison {
	a: SrcCode;
	b: SrcCode;
	count: number;
	median: number;
	p99: number;
	max: number;
	over: number;
}

/** How far the closes of two sources are apart where both have a close at the same time (in percent). */
export function compareCloses(
	a: Map<number, number>,
	b: Map<number, number>,
	limitPercent: number
): Omit<Comparison, 'a' | 'b'> {
	const diffs: number[] = [];
	for (const [time, price] of a) {
		const other = b.get(time);
		if (other !== undefined && price > 0 && other > 0) {
			diffs.push(percentDiff(price, other));
		}
	}
	diffs.sort((x, y) => x - y);
	const at = (share: number) =>
		diffs[Math.min(diffs.length - 1, Math.floor(diffs.length * share))] ??
		0;
	return {
		count: diffs.length,
		median: at(0.5),
		p99: at(0.99),
		max: diffs[diffs.length - 1] ?? 0,
		over: diffs.filter((diff) => diff > limitPercent).length,
	};
}

/** Compares every pair of candle sources of the coins. Only pairs with common times are returned. */
export async function verifyCoins(
	coins: string[],
	opts: RunOptions
): Promise<Array<Comparison & { coin: string }>> {
	const reader = createSeriesReader(opts.dataRoot, () => {});
	const from = isoSeconds(new Date(opts.fromSec * 1000));
	const to = isoSeconds(new Date(opts.untilSec * 1000));
	const out: Array<Comparison & { coin: string }> = [];
	for (const coin of coins) {
		const closes = new Map<SrcCode, Map<number, number>>();
		for (const src of COMPARE_SRCS) {
			const map = new Map<number, number>();
			for (const point of await reader.readSeries(coin, from, to, src)) {
				map.set(parseIso(point.ts) / 1000, Number(point.price));
			}
			closes.set(src, map);
		}
		for (const [i, a] of COMPARE_SRCS.entries()) {
			for (const b of COMPARE_SRCS.slice(i + 1)) {
				const stats = compareCloses(
					closes.get(a) ?? new Map(),
					closes.get(b) ?? new Map(),
					opts.config.settings.crosscheck_max_diff_percent
				);
				if (stats.count > 0) {
					out.push({ coin, a, b, ...stats });
				}
			}
		}
	}
	return out;
}

function formatComparison(item: Comparison & { coin: string }): string {
	const f = (value: number) => value.toFixed(3);
	return `${item.coin.padEnd(6)} ${item.a} vs ${item.b}: ${item.count} common closes, median ${f(item.median)}%, 99th ${f(item.p99)}%, max ${f(item.max)}%, ${item.over} over the limit`;
}

const USAGE = `Usage: node tools/backfill.ts --data-root <dir> [options]
  --data-root <dir>     checkout of the data branch (required)
  --config <file>       default config/coins.json
  --coins <ids>         only these coins, for example ATOM,KSM (default: the coins below --min-coverage)
  --provider <name>     coinbase, kraken-trades or okx (default: the first that has a market for the coin)
  --from <iso>          first candle, default ${DEFAULT_FROM}
  --until <iso>         last candle end, default the last 15 minute mark
  --min-coverage <n>    with no --coins: coins whose share of 15 minute intervals with a price is below n
                        (0 to 1) are filled, default ${DEFAULT_MIN_COVERAGE}
  --dry-run             print the plan, call nothing
  --verify              after the run (or with --dry-run alone), compare the closes of the sources
`;

export interface Io {
	out: (text: string) => void;
	err: (text: string) => void;
	http?: HttpClient;
	sleep?: (ms: number) => Promise<void>;
	now?: () => Date;
}

/** Runs the tool. Returns the exit code: 0 on success, 1 on bad input or a failed task. */
export async function main(argv: string[], io: Io): Promise<number> {
	let values: Record<string, string | boolean | undefined>;
	try {
		values = parseArgs({
			args: argv,
			options: {
				'data-root': { type: 'string' },
				config: { type: 'string' },
				coins: { type: 'string' },
				provider: { type: 'string' },
				from: { type: 'string' },
				until: { type: 'string' },
				'min-coverage': { type: 'string' },
				'dry-run': { type: 'boolean' },
				verify: { type: 'boolean' },
				help: { type: 'boolean' },
			},
		}).values;
	} catch (error) {
		io.err(`${(error as Error).message}\n\n${USAGE}`);
		return 1;
	}
	if (values.help === true) {
		io.out(USAGE);
		return 0;
	}
	if (typeof values['data-root'] !== 'string') {
		io.err(`--data-root is required\n\n${USAGE}`);
		return 1;
	}
	const provider = values.provider;
	if (
		provider !== undefined &&
		(typeof provider !== 'string' || !Object.hasOwn(PROVIDERS, provider))
	) {
		io.err('--provider must be coinbase, kraken-trades or okx\n');
		return 1;
	}
	const minCoverage =
		typeof values['min-coverage'] === 'string'
			? Number(values['min-coverage'])
			: DEFAULT_MIN_COVERAGE;
	if (!Number.isFinite(minCoverage) || minCoverage < 0 || minCoverage > 1) {
		io.err('--min-coverage must be a number from 0 to 1\n');
		return 1;
	}

	const nowSec = Math.floor(
		(io.now ?? (() => new Date()))().getTime() / 1000
	);
	let fromSec: number;
	let untilSec: number;
	try {
		fromSec =
			parseIso(
				typeof values.from === 'string' ? values.from : DEFAULT_FROM
			) / 1000;
		untilSec =
			typeof values.until === 'string'
				? parseIso(values.until) / 1000
				: Math.floor(nowSec / STEP_SECONDS) * STEP_SECONDS;
	} catch (error) {
		io.err(`${(error as Error).message}\n`);
		return 1;
	}
	if (
		fromSec % STEP_SECONDS !== 0 ||
		untilSec % STEP_SECONDS !== 0 ||
		untilSec <= fromSec
	) {
		io.err(
			'--from and --until must be on a 15 minute mark, and --until after --from\n'
		);
		return 1;
	}

	const config = await loadConfig(
		typeof values.config === 'string' ? values.config : 'config/coins.json'
	);
	const dataRoot = values['data-root'];
	const only =
		typeof values.coins === 'string' ? values.coins.split(',') : null;
	const candidates = config.coins.filter(
		(coin) =>
			coin.enabled &&
			coin.role !== 'rate' &&
			(only === null || only.includes(coin.id))
	);

	const tasks: Task[] = [];
	for (const coin of candidates) {
		const name =
			provider === undefined
				? providerFor(coin)
				: (provider as ProviderName);
		const market =
			name === null ? undefined : coin.sources[PROVIDERS[name].field];
		if (name === null || market === undefined) {
			if (only !== null) {
				io.err(`${coin.id}: no market for the provider, skipped\n`);
			}
			continue;
		}
		if (only === null) {
			const coverage = await coverageOf(
				dataRoot,
				coin.id,
				fromSec,
				untilSec
			);
			if (coverage.share15 >= minCoverage) {
				continue;
			}
		}
		tasks.push({ coin: coin.id, provider: name, market });
	}

	io.out(
		`${tasks.length} tasks from ${isoSeconds(new Date(fromSec * 1000))} to ${isoSeconds(new Date(untilSec * 1000))}.\n`
	);
	for (const task of tasks) {
		let estimate = 'about one request per 1000 trades';
		const spanSec = untilSec - fromSec;
		if (task.provider === 'coinbase') {
			estimate = `up to ${Math.ceil(spanSec / COINBASE_WINDOW_SECONDS)} requests`;
		} else if (task.provider === 'okx') {
			estimate = `up to ${Math.ceil(spanSec / (STEP_SECONDS * 100))} requests`;
		}
		io.out(
			`  ${task.coin.padEnd(6)} ${task.provider} ${task.market}: ${estimate}\n`
		);
	}

	const opts: RunOptions = {
		dataRoot,
		config,
		http: io.http ?? createHttpClient(),
		fromSec,
		untilSec,
		sleep: io.sleep ?? sleepMs,
		log: (line) => io.out(`${line}\n`),
	};
	let code = 0;
	if (values['dry-run'] !== true) {
		const run = await runAll(tasks, opts);
		io.out(`${run.written} rows written.\n`);
		if (run.failed.length > 0) {
			io.err(
				`stopped: ${run.failed.map((task) => `${task.coin} (${task.provider})`).join(', ')}. Run again to continue.\n`
			);
			code = 1;
		}
	}
	if (values.verify === true) {
		const list = (only ?? tasks.map((task) => task.coin)).filter((id) =>
			candidates.some((coin) => coin.id === id)
		);
		for (const item of await verifyCoins(list, opts)) {
			io.out(`${formatComparison(item)}\n`);
		}
	}
	return code;
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2), {
		out: (text) => process.stdout.write(text),
		err: (text) => process.stderr.write(text),
	});
}
