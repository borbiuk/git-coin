// One-off backfill of daily Kraken candles into a data checkout (ADR 0004 D1, ADR 0005 D8).
// It is for the coins that have no Bitstamp market. Kraken keeps only the newest 720 candles, so the
// history of these coins is daily and about two years long. A Bitstamp coin is skipped.
// Writes rows with `src=kr-ohlc`: the candle close as the price, the candle close time as `ts`.
// Safe to run again: it continues after the last stored `kr-ohlc` row of each coin.
// Run: node tools/backfill-kraken.ts --data-root <checkout of the data branch> [--dry-run]

import { setTimeout as sleepMs } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { candleSource, loadConfig } from '../src/config.ts';
import { appendRows, readLastRow } from '../src/csv.ts';
import { parseKrakenCandles } from '../src/gapfill.ts';
import type { Candle } from '../src/gapfill.ts';
import { createHttpClient } from '../src/http.ts';
import { isoSeconds, parseIso } from '../src/time.ts';
import type { HttpClient, PriceRow } from '../src/types.ts';

const BASE_URL = 'https://api.kraken.com/0/public/OHLC';
const SRC = 'kr-ohlc';
const DAY_SECONDS = 86_400;
const MIN_SPACING_SECONDS = 300;
/** Less than this pause between two requests is refused. */
const MIN_PAUSE_MS = 500;
const DEFAULT_PAUSE_MS = 1000;
/** Waits after a 429, a 5xx, a network error or a rate limit text. After the last wait the run stops. */
const RETRY_WAITS_MS = [30_000, 60_000, 120_000];

export interface Market {
	coin: string;
	market: string;
}

export interface BackfillOptions {
	dataRoot: string;
	http: HttpClient;
	/** Candles that close after this time are not written. The default is the start of today (UTC). */
	untilSec: number;
	pauseMs: number;
	sleep: (ms: number) => Promise<void>;
	log: (line: string) => void;
}

export interface MarketResult {
	written: number;
	skipped: number;
}

export { parseKrakenCandles };
export type { Candle };

async function fetchCandles(
	market: string,
	opts: BackfillOptions
): Promise<Candle[]> {
	const url = `${BASE_URL}?pair=${market}&interval=1440`;
	for (let attempt = 0; ; attempt += 1) {
		const result = await opts.http.getJson({ url, timeoutMs: 20_000 });
		let reason = `HTTP ${result.status} (${result.error ?? 'no body'})`;
		let retryable =
			result.status === 429 ||
			result.status >= 500 ||
			result.status === 0;
		if (result.status === 200 && result.error === undefined) {
			try {
				return parseKrakenCandles(result.json);
			} catch (error) {
				reason = (error as Error).message;
				// Kraken reports a rate limit as an error text inside a 200 answer
				retryable = reason.includes('Rate limit');
			}
		}
		const wait = RETRY_WAITS_MS[attempt];
		if (!retryable || wait === undefined) {
			throw new Error(`Kraken answered ${reason} for ${market}`);
		}
		opts.log(
			`${market}: ${reason}, waiting ${wait / 1000} s before try ${attempt + 2}`
		);
		await opts.sleep(wait);
	}
}

/** Appends the daily candles of one market that are newer than its last stored `kr-ohlc` row. */
export async function backfillMarket(
	target: Market,
	opts: BackfillOptions
): Promise<MarketResult> {
	const last = await readLastRow(opts.dataRoot, target.coin, SRC);
	const lastSec = last === null ? 0 : parseIso(last.ts) / 1000;
	const candles = await fetchCandles(target.market, opts);
	const rows: PriceRow[] = [];
	for (const candle of candles) {
		const closeSec = candle.start + DAY_SECONDS;
		if (
			closeSec <= lastSec ||
			closeSec > opts.untilSec ||
			Number(candle.volume) === 0
		) {
			continue;
		}
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
	const result = {
		written: appended.written.length,
		skipped: appended.skipped.length,
	};
	opts.log(
		`${target.coin} (${target.market}): ${result.written} rows written, ${result.skipped} skipped`
	);
	return result;
}

const USAGE = `Usage: node tools/backfill-kraken.ts --data-root <dir> [options]
  --data-root <dir>   checkout of the data branch (required)
  --config <file>     default config/coins.json
  --only <ids>        only these coins, for example TRX,ATOM. They may have a Bitstamp market: use --until to stop
                      where their Bitstamp candles start (default: the coins that have no Bitstamp market)
  --until <iso>       candles closing after this time are left out, default the start of today (UTC)
  --pause-ms <ms>     pause between two requests, default ${DEFAULT_PAUSE_MS}, at least ${MIN_PAUSE_MS}
  --dry-run           print the plan, call nothing
`;

export interface Io {
	out: (text: string) => void;
	err: (text: string) => void;
	http?: HttpClient;
	sleep?: (ms: number) => Promise<void>;
	now?: () => Date;
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

	let untilSec: number;
	try {
		untilSec =
			typeof values.until === 'string'
				? parseIso(values.until) / 1000
				: Math.floor(
						(io.now ?? (() => new Date()))().getTime() /
							1000 /
							DAY_SECONDS
					) * DAY_SECONDS;
	} catch (error) {
		io.err(`${(error as Error).message}\n`);
		return 1;
	}

	const config = await loadConfig(
		typeof values.config === 'string' ? values.config : 'config/coins.json'
	);
	const only =
		typeof values.only === 'string' ? values.only.split(',') : null;
	const markets: Market[] = [];
	for (const coin of config.coins) {
		if (!coin.enabled) {
			continue;
		}
		if (only !== null) {
			const pair = coin.sources.kraken_pair;
			if (only.includes(coin.id) && pair !== undefined) {
				markets.push({ coin: coin.id, market: pair });
			}
			continue;
		}
		const candles = candleSource(coin);
		if (candles?.src === SRC) {
			markets.push({ coin: coin.id, market: candles.market });
		}
	}

	io.out(
		`${markets.length} markets, one request each, one every ${pauseMs} ms, up to ${isoSeconds(new Date(untilSec * 1000))}.\n`
	);
	if (values['dry-run'] === true) {
		io.out(`${markets.map((item) => item.market).join(' ')}\n`);
		return 0;
	}

	const opts: BackfillOptions = {
		dataRoot: values['data-root'],
		http: io.http ?? createHttpClient(),
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
