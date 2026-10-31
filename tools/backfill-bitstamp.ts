// One-off backfill of 15-minute Bitstamp candles into a data checkout (ADR 0004 D1, ADR 0005 D8).
// Writes rows with `src=bs-ohlc`: the candle close as the price, the candle close time as `ts`.
// Only new daily files are written (days before the first live row), so no stored line is touched.
// Safe to run again: it continues after the last stored `bs-ohlc` row of each coin.
// Run: node tools/backfill-bitstamp.ts --data-root <checkout of the data branch> [--dry-run]

import { setTimeout as sleepMs } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { loadConfig } from '../src/config.ts';
import { appendRows, readLastRow } from '../src/csv.ts';
import { LIMIT, STEP_SECONDS, parseCandles } from '../src/gapfill.ts';
import type { Candle } from '../src/gapfill.ts';
import { createHttpClient } from '../src/http.ts';
import { isoSeconds, parseIso } from '../src/time.ts';
import type { HttpClient, PriceRow } from '../src/types.ts';

const BASE_URL = 'https://www.bitstamp.net/api/v2/ohlc';
const SRC = 'bs-ohlc';
const WINDOW_SECONDS = STEP_SECONDS * LIMIT;
const MIN_SPACING_SECONDS = 300;
/** Less than this pause between two requests is refused (the published limit is thousands per 10 minutes). */
const MIN_PAUSE_MS = 500;
const DEFAULT_PAUSE_MS = 1000;
/** Waits after a 429, a 5xx or a network error. After the last wait the run stops. */
const RETRY_WAITS_MS = [30_000, 60_000, 120_000];

const DEFAULT_FROM = '2024-01-01T00:00:00Z';
/** The first day of the live data is not touched: its file is written by the collector. */
const DEFAULT_UNTIL = '2026-10-29T00:00:00Z';

export interface Market {
	coin: string;
	market: string;
}

export interface BackfillOptions {
	dataRoot: string;
	http: HttpClient;
	fromSec: number;
	/** Candles that close at this time or later are not written. */
	untilSec: number;
	pauseMs: number;
	sleep: (ms: number) => Promise<void>;
	log: (line: string) => void;
}

export interface MarketResult {
	requests: number;
	written: number;
	skipped: number;
}

export { parseCandles };
export type { Candle };

/** The number of requests a market needs from `fromSec` up to `untilSec`. */
export function requestCount(fromSec: number, untilSec: number): number {
	return Math.max(0, Math.ceil((untilSec - fromSec) / WINDOW_SECONDS));
}

async function fetchWindow(
	market: string,
	startSec: number,
	opts: BackfillOptions
): Promise<Candle[]> {
	const url = `${BASE_URL}/${market}/?step=${STEP_SECONDS}&limit=${LIMIT}&start=${startSec}`;
	for (let attempt = 0; ; attempt += 1) {
		const result = await opts.http.getJson({ url, timeoutMs: 20_000 });
		if (result.status === 200 && result.error === undefined) {
			return parseCandles(result.json);
		}
		const wait = RETRY_WAITS_MS[attempt];
		const retryable =
			result.status === 429 ||
			result.status >= 500 ||
			result.status === 0;
		if (!retryable || wait === undefined) {
			throw new Error(
				`Bitstamp answered HTTP ${result.status} (${result.error ?? 'no body'}) for ${market} at ${isoSeconds(new Date(startSec * 1000))}`
			);
		}
		opts.log(
			`${market}: HTTP ${result.status}, waiting ${wait / 1000} s before try ${attempt + 2}`
		);
		await opts.sleep(wait);
	}
}

/** Walks one market window by window and appends the candles, so a stop loses at most one window. */
export async function backfillMarket(
	target: Market,
	opts: BackfillOptions
): Promise<MarketResult> {
	const last = await readLastRow(opts.dataRoot, target.coin, SRC);
	// A stored row has the close time as `ts`, so its candle started one step earlier
	let start =
		last === null
			? opts.fromSec
			: Math.max(opts.fromSec, parseIso(last.ts) / 1000 - STEP_SECONDS);
	const result: MarketResult = { requests: 0, written: 0, skipped: 0 };
	let lastStart = -1;
	while (start < opts.untilSec) {
		if (result.requests > 0) {
			await opts.sleep(opts.pauseMs);
		}
		const candles = await fetchWindow(target.market, start, opts);
		result.requests += 1;
		const rows: PriceRow[] = [];
		for (const candle of candles) {
			const closeSec = candle.start + STEP_SECONDS;
			if (
				candle.start < opts.fromSec ||
				candle.start <= lastStart ||
				closeSec >= opts.untilSec ||
				Number(candle.volume) === 0
			) {
				continue;
			}
			lastStart = candle.start;
			rows.push({
				ts: isoSeconds(new Date(closeSec * 1000)),
				coin: target.coin,
				price: candle.close,
				src: SRC,
				age_s: null,
			});
		}
		const appended = await appendRows(opts.dataRoot, rows, {
			minSpacingSeconds: MIN_SPACING_SECONDS,
		});
		result.written += appended.written.length;
		result.skipped += appended.skipped.length;
		start += WINDOW_SECONDS;
	}
	opts.log(
		`${target.coin} (${target.market}): ${result.requests} requests, ${result.written} rows written, ${result.skipped} skipped`
	);
	return result;
}

const USAGE = `Usage: node tools/backfill-bitstamp.ts --data-root <dir> [options]
  --data-root <dir>   checkout of the data branch (required)
  --config <file>     default config/coins.json
  --from <iso>        first candle start, default ${DEFAULT_FROM}
  --until <iso>       candles closing at this time or later are left out, default ${DEFAULT_UNTIL}
  --only <ids>        only these coins, for example BTC,ETH (default: every enabled coin with a Bitstamp market)
  --pause-ms <ms>     pause between two requests, default ${DEFAULT_PAUSE_MS}, at least ${MIN_PAUSE_MS}
  --dry-run           print the plan and the number of requests, call nothing
`;

export interface Io {
	out: (text: string) => void;
	err: (text: string) => void;
	http?: HttpClient;
	sleep?: (ms: number) => Promise<void>;
}

/** Runs the tool. Returns the exit code: 0 on success, 1 on bad input or a failed request. */
export async function main(argv: string[], io: Io): Promise<number> {
	let values: Record<string, string | boolean | undefined>;
	try {
		values = parseArgs({
			args: argv,
			options: {
				'data-root': { type: 'string' },
				config: { type: 'string' },
				from: { type: 'string' },
				until: { type: 'string' },
				only: { type: 'string' },
				'pause-ms': { type: 'string' },
				'dry-run': { type: 'boolean' },
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
	const pauseMs =
		typeof values['pause-ms'] === 'string'
			? Number(values['pause-ms'])
			: DEFAULT_PAUSE_MS;
	if (!Number.isFinite(pauseMs) || pauseMs < MIN_PAUSE_MS) {
		io.err(`--pause-ms must be a number of ${MIN_PAUSE_MS} or more\n`);
		return 1;
	}

	let fromSec: number;
	let untilSec: number;
	try {
		fromSec =
			parseIso(
				typeof values.from === 'string' ? values.from : DEFAULT_FROM
			) / 1000;
		untilSec =
			parseIso(
				typeof values.until === 'string' ? values.until : DEFAULT_UNTIL
			) / 1000;
	} catch (error) {
		io.err(`${(error as Error).message}\n`);
		return 1;
	}
	if (fromSec % STEP_SECONDS !== 0 || untilSec <= fromSec) {
		io.err(
			'--from must be on a 15 minute mark and --until must be after it\n'
		);
		return 1;
	}

	const config = await loadConfig(
		typeof values.config === 'string' ? values.config : 'config/coins.json'
	);
	const only =
		typeof values.only === 'string' ? values.only.split(',') : null;
	const markets: Market[] = [];
	for (const coin of config.coins) {
		const market = coin.sources.bitstamp_market;
		if (only !== null && !only.includes(coin.id)) {
			continue;
		}
		if (coin.enabled && market !== undefined) {
			markets.push({ coin: coin.id, market });
		}
	}

	const perMarket = requestCount(fromSec, untilSec);
	const total = perMarket * markets.length;
	io.out(
		`${markets.length} markets, up to ${perMarket} requests each, up to ${total} in all, ` +
			`one every ${pauseMs} ms (about ${Math.round((total * pauseMs) / 60_000)} minutes).\n`
	);
	if (values['dry-run'] === true) {
		io.out(`${markets.map((item) => item.market).join(' ')}\n`);
		return 0;
	}

	const opts: BackfillOptions = {
		dataRoot: values['data-root'],
		http: io.http ?? createHttpClient(),
		fromSec,
		untilSec,
		pauseMs,
		sleep: io.sleep ?? sleepMs,
		log: (line) => io.out(`${line}\n`),
	};
	try {
		for (const [index, market] of markets.entries()) {
			if (index > 0) {
				await opts.sleep(pauseMs);
			}
			await backfillMarket(market, opts);
		}
	} catch (error) {
		io.err(`stopped: ${(error as Error).message}\n`);
		return 1;
	}
	return 0;
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2), {
		out: (text) => process.stdout.write(text),
		err: (text) => process.stderr.write(text),
	});
}
