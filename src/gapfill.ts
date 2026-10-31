// Gap fill (ADR 0005 D8). When scheduled runs are missed, the collector asks Bitstamp for the 15-minute
// candles of the time since the last stored row and returns them as rows with `src=bs-ohlc`.
// A coin with no Bitstamp market is filled from Kraken in the same way (`src=kr-ohlc`, at most 720 candles).
// The caller only appends these rows, so no stored line is touched (ADR 0004 D6).
// A coin that could not be filled stays in `state/gapfill.json` with the start of its gap, so a later run
// fills it even after the rows of the failed run were stored.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isoSeconds } from './time.ts';
import type { HttpClient, PriceRow } from './types.ts';

const BASE_URL = 'https://www.bitstamp.net/api/v2/ohlc';
const KRAKEN_URL = 'https://api.kraken.com/0/public/OHLC';
export type CandleSrc = 'bs-ohlc' | 'kr-ohlc';
export const STEP_SECONDS = 900;
/** The largest `limit` of the endpoint. One request covers this many candles (10.4 days). */
export const LIMIT = 1000;
/** Kraken returns at most this many of the newest candles (7.5 days), whatever `since` says. */
export const KRAKEN_LIMIT = 720;
/** A gap shorter than this is a normal delay of a run, not a missed one. */
export const MIN_GAP_SECONDS = 1200;
const DECIMAL = /^\d+(\.\d+)?$/;
const INTEGER = /^\d+$/;

export interface Candle {
	/** Start of the candle, epoch seconds. */
	start: number;
	close: string;
	volume: string;
}

/** One market to fill. `fromSec` is where the missing time starts: an open gap of an earlier run, else the newest stored row. */
export interface GapTarget {
	coin: string;
	market: string;
	/** The candle source of the market: Bitstamp `ohlc` or Kraken `OHLC`. */
	src: CandleSrc;
	fromSec: number;
}

export interface GapResult {
	rows: PriceRow[];
	/** Coins that still have a gap, with its start (ISO). They are tried again in the next run. */
	pending: Record<string, string>;
}

export interface GapFillOptions {
	http: HttpClient;
	nowSec: number;
	/** Pause between two requests, so the 11 requests of a run are spread out. */
	pauseMs: number;
	sleep: (ms: number) => Promise<void>;
	log: (line: string) => void;
}

/** Reads one answer of the OHLC endpoint. Throws when the shape is not the expected one. */
export function parseCandles(json: unknown): Candle[] {
	const data = (json as { data?: { ohlc?: unknown } } | null)?.data;
	const list = data?.ohlc;
	if (!Array.isArray(list)) {
		throw new Error('The answer has no data.ohlc list');
	}
	const candles = list.map((item: unknown) => {
		const entry = item as Record<string, unknown> | null;
		const timestamp = entry?.timestamp;
		const close = entry?.close;
		const volume = entry?.volume;
		if (
			typeof timestamp !== 'string' ||
			!INTEGER.test(timestamp) ||
			typeof close !== 'string' ||
			!DECIMAL.test(close) ||
			Number(close) <= 0 ||
			typeof volume !== 'string' ||
			!DECIMAL.test(volume)
		) {
			throw new Error('A candle has a field that is not a plain number');
		}
		return { start: Number(timestamp), close, volume };
	});
	return candles.sort((a, b) => a.start - b.start);
}

/** Reads one answer of the Kraken `OHLC` endpoint. Throws when it holds an error or has not the expected shape. */
export function parseKrakenCandles(json: unknown): Candle[] {
	const body = json as { error?: unknown; result?: unknown } | null;
	if (Array.isArray(body?.error) && body.error.length > 0) {
		throw new Error(`Kraken answered: ${body.error.join(', ')}`);
	}
	const result = body?.result;
	if (typeof result !== 'object' || result === null) {
		throw new Error('The answer has no result');
	}
	const key = Object.keys(result).find((name) => name !== 'last');
	const list =
		key === undefined
			? undefined
			: (result as Record<string, unknown>)[key];
	if (!Array.isArray(list)) {
		throw new Error('The answer has no candle list');
	}
	const candles = list.map((item: unknown) => {
		const entry = Array.isArray(item) ? item : [];
		const [time, , , , close, , volume] = entry as unknown[];
		if (
			typeof time !== 'number' ||
			!Number.isInteger(time) ||
			typeof close !== 'string' ||
			!DECIMAL.test(close) ||
			Number(close) <= 0 ||
			typeof volume !== 'string' ||
			!DECIMAL.test(volume)
		) {
			throw new Error('A candle has a field that is not a plain number');
		}
		return { start: time, close, volume };
	});
	return candles.sort((a, b) => a.start - b.start);
}

/**
 * The request that covers the gap, or null when there is no gap. The first candle is the one that holds
 * the last stored row. A gap longer than one request (10.4 days) is filled from its newest part only.
 */
export function planRequest(
	fromSec: number,
	nowSec: number,
	maxCandles = LIMIT
): { startSec: number; limit: number } | null {
	if (nowSec - fromSec < MIN_GAP_SECONDS) {
		return null;
	}
	const newest = Math.floor(nowSec / STEP_SECONDS) * STEP_SECONDS;
	const startSec = Math.max(
		Math.floor(fromSec / STEP_SECONDS) * STEP_SECONDS,
		newest - (maxCandles - 1) * STEP_SECONDS
	);
	const limit = Math.min(
		maxCandles,
		Math.ceil((nowSec - startSec) / STEP_SECONDS) + 1
	);
	return { startSec, limit };
}

/**
 * Rows for the candles that closed after `fromSec` and not after `nowSec`. The candle close is the price and
 * the candle close time is `ts`. A candle with no trades is left out, so the chart shows that time as a gap.
 */
export function candleRows(
	coin: string,
	candles: Candle[],
	fromSec: number,
	nowSec: number,
	src: CandleSrc
): PriceRow[] {
	const rows: PriceRow[] = [];
	for (const candle of candles) {
		const closeSec = candle.start + STEP_SECONDS;
		if (
			closeSec <= fromSec ||
			closeSec > nowSec ||
			Number(candle.volume) === 0
		) {
			continue;
		}
		rows.push({
			ts: isoSeconds(new Date(closeSec * 1000)),
			coin,
			price: candle.close,
			src,
			age_s: null,
		});
	}
	return rows;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : 'unknown error';
}

/** The open gaps of the earlier runs: coin id to the start of the gap. A missing or bad file is no open gap. */
export async function readPending(
	file: string
): Promise<Record<string, string>> {
	let json: unknown;
	try {
		json = JSON.parse(await readFile(file, 'utf8'));
	} catch {
		return {};
	}
	const pending: Record<string, string> = {};
	const source = (json as { pending?: unknown } | null)?.pending;
	if (typeof source === 'object' && source !== null) {
		for (const [coin, ts] of Object.entries(source)) {
			if (typeof ts === 'string' && !Number.isNaN(Date.parse(ts))) {
				pending[coin] = ts;
			}
		}
	}
	return pending;
}

/** Writes the open gaps. Nothing is written when they did not change, and no file is made for an empty list. */
export async function writePending(
	file: string,
	pending: Record<string, string>
): Promise<void> {
	const before = await readPending(file);
	if (JSON.stringify(before) === JSON.stringify(pending)) {
		return;
	}
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify({ pending }, null, '\t')}\n`);
}

/**
 * The rows that fill the gaps of all targets. Never throws: a market that fails is logged and its gap stays
 * open for the next run. A 429 stops the remaining requests; their gaps stay open too.
 */
export async function fetchGapRows(
	targets: GapTarget[],
	opts: GapFillOptions
): Promise<GapResult> {
	const result: GapResult = { rows: [], pending: {} };
	let requests = 0;
	let stopped = false;
	for (const target of targets) {
		const kraken = target.src === 'kr-ohlc';
		const plan = planRequest(
			target.fromSec,
			opts.nowSec,
			kraken ? KRAKEN_LIMIT : LIMIT
		);
		if (plan === null) {
			continue;
		}
		const open = isoSeconds(new Date(target.fromSec * 1000));
		if (stopped) {
			result.pending[target.coin] = open;
			continue;
		}
		if (requests > 0) {
			await opts.sleep(opts.pauseMs);
		}
		requests += 1;
		const url = kraken
			? `${KRAKEN_URL}?pair=${target.market}&interval=15&since=${plan.startSec - 1}`
			: `${BASE_URL}/${target.market}/?step=${STEP_SECONDS}&limit=${plan.limit}&start=${plan.startSec}`;
		const answer = await opts.http.getJson({ url, timeoutMs: 20_000 });
		if (answer.status === 429) {
			opts.log(
				'gap fill: HTTP 429, the other markets wait for the next run'
			);
			stopped = true;
			result.pending[target.coin] = open;
			continue;
		}
		if (answer.status !== 200 || answer.error !== undefined) {
			opts.log(
				`gap fill: ${target.coin}: HTTP ${answer.status} ${answer.error ?? ''}`.trimEnd()
			);
			result.pending[target.coin] = open;
			continue;
		}
		try {
			const found = candleRows(
				target.coin,
				kraken
					? parseKrakenCandles(answer.json)
					: parseCandles(answer.json),
				target.fromSec,
				opts.nowSec,
				target.src
			);
			result.rows.push(...found);
			opts.log(
				`gap fill: ${target.coin}: ${found.length} candles from ${isoSeconds(new Date(plan.startSec * 1000))}`
			);
		} catch (error) {
			const reason = describeError(error);
			opts.log(`gap fill: ${target.coin}: ${reason}`);
			result.pending[target.coin] = open;
			// Kraken reports a rate limit as an error text inside a 200 answer
			if (reason.includes('Rate limit')) {
				stopped = true;
			}
		}
	}
	return result;
}
