// Gap fill (ADR 0005 D8). When scheduled runs are missed, the collector asks one candle source per coin for the
// 15-minute candles of the time since the last stored row and returns them as candle rows: Coinbase (`cb-ohlc`)
// when the coin has a product there, else Bitstamp (`bs-ohlc`), else Kraken (`kr-ohlc`, only the newest 720
// candles), else OKX (`ok-ohlc`, quoted in USDT).
// The caller only appends these rows, so no stored line is touched (ADR 0004 D6). A long gap is filled from its
// start forward, a few requests per run. A coin that is not filled up to now stays in `state/gapfill.json` with
// the time where its missing part starts, so a later run goes on from there even after the rows of this run
// were stored.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isoSeconds } from './time.ts';
import type { HttpClient, PriceRow } from './types.ts';

const BASE_URL = 'https://www.bitstamp.net/api/v2/ohlc';
const KRAKEN_URL = 'https://api.kraken.com/0/public/OHLC';
const COINBASE_URL = 'https://api.exchange.coinbase.com/products';
const OKX_URL = 'https://www.okx.com/api/v5/market/history-candles';
export type CandleSrc = 'cb-ohlc' | 'bs-ohlc' | 'kr-ohlc' | 'ok-ohlc';
export const STEP_SECONDS = 900;
/** The largest `limit` of the endpoint. One request covers this many candles (10.4 days). */
export const LIMIT = 1000;
/** Kraken returns at most this many of the newest candles (7.5 days), whatever `since` says. */
export const KRAKEN_LIMIT = 720;
/** Coinbase returns at most 300 candles per request. A smaller window keeps a margin. */
export const COINBASE_LIMIT = 288;
/** OKX `history-candles` returns at most 100 candles per request. */
export const OKX_LIMIT = 100;
/** The most requests of one run, for all coins together. A longer gap goes on in the next run. */
export const MAX_REQUESTS = 40;
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

/** The candles one request of the source can return. */
export function sourceLimit(src: CandleSrc): number {
	if (src === 'cb-ohlc') {
		return COINBASE_LIMIT;
	}
	if (src === 'kr-ohlc') {
		return KRAKEN_LIMIT;
	}
	if (src === 'ok-ohlc') {
		return OKX_LIMIT;
	}
	return LIMIT;
}

/** One market to fill. `fromSec` is where the missing time starts: an open gap of an earlier run, else the newest stored row. */
export interface GapTarget {
	coin: string;
	market: string;
	/** The candle source of the market. */
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
	/** Pause between two requests, so the requests of a run are spread out. */
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

/** A JSON number as plain text. An exponent form is refused, because it would change the digits. */
function plainNumber(value: unknown, positive: boolean): string {
	if (
		typeof value !== 'number' ||
		!Number.isFinite(value) ||
		value < 0 ||
		(positive && value === 0)
	) {
		throw new Error('A candle has a field that is not a plain number');
	}
	const text = String(value);
	if (/e/i.test(text)) {
		throw new Error('A candle has a number in exponent form');
	}
	return text;
}

/** Reads one answer of the Coinbase `candles` endpoint: `[time, low, high, open, close, volume]` rows. */
export function parseCoinbaseCandles(json: unknown): Candle[] {
	if (!Array.isArray(json)) {
		throw new Error('The answer is not a list of candles');
	}
	const candles = json.map((item: unknown) => {
		const entry = Array.isArray(item) ? item : [];
		const [time, , , , close, volume] = entry as unknown[];
		if (typeof time !== 'number' || !Number.isInteger(time)) {
			throw new Error('A candle has a field that is not a plain number');
		}
		return {
			start: time,
			close: plainNumber(close, true),
			volume: plainNumber(volume, false),
		};
	});
	return candles.sort((a, b) => a.start - b.start);
}

/** Reads one answer of the OKX `history-candles` endpoint: `[ts, open, high, low, close, volume, ...]` rows. */
export function parseOkxCandles(json: unknown): Candle[] {
	const body = json as { code?: unknown; data?: unknown } | null;
	if (body === null || typeof body !== 'object' || body.code !== '0') {
		throw new Error(`OKX answered code ${String(body?.code)}`);
	}
	if (!Array.isArray(body.data)) {
		throw new Error('The answer has no candle list');
	}
	const candles = body.data.map((item: unknown) => {
		const entry = Array.isArray(item) ? item : [];
		const [ts, , , , close, volume] = entry as unknown[];
		if (
			typeof ts !== 'string' ||
			!/^\d{13}$/.test(ts) ||
			typeof close !== 'string' ||
			!DECIMAL.test(close) ||
			Number(close) <= 0 ||
			typeof volume !== 'string' ||
			!DECIMAL.test(volume)
		) {
			throw new Error('A candle has a field that is not a plain number');
		}
		return { start: Number(ts) / 1000, close, volume };
	});
	return candles.sort((a, b) => a.start - b.start);
}

/**
 * The request that covers the gap, or null when there is no gap. The first candle is the one that holds
 * the last stored row. A gap longer than one request is filled from its newest part only, unless `forward`
 * is set: then the request starts at the gap and the caller asks again for the rest.
 */
export function planRequest(
	fromSec: number,
	nowSec: number,
	maxCandles = LIMIT,
	forward = false
): { startSec: number; limit: number } | null {
	if (nowSec - fromSec < MIN_GAP_SECONDS) {
		return null;
	}
	const newest = Math.floor(nowSec / STEP_SECONDS) * STEP_SECONDS;
	const first = Math.floor(fromSec / STEP_SECONDS) * STEP_SECONDS;
	const startSec = forward
		? first
		: Math.max(first, newest - (maxCandles - 1) * STEP_SECONDS);
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

/** The URL of one request for the candles `startSec` up to `startSec + (limit - 1) * STEP_SECONDS`. */
export function candleUrl(
	src: CandleSrc,
	market: string,
	startSec: number,
	limit: number
): string {
	const iso = (sec: number) => new Date(sec * 1000).toISOString();
	if (src === 'cb-ohlc') {
		const end = startSec + (limit - 1) * STEP_SECONDS;
		return `${COINBASE_URL}/${encodeURIComponent(market)}/candles?granularity=${STEP_SECONDS}&start=${iso(startSec)}&end=${iso(end)}`;
	}
	if (src === 'kr-ohlc') {
		return `${KRAKEN_URL}?pair=${market}&interval=15&since=${startSec - 1}`;
	}
	if (src === 'ok-ohlc') {
		// `after` returns the candles that start before it, newest first
		const after = (startSec + limit * STEP_SECONDS) * 1000;
		return `${OKX_URL}?instId=${encodeURIComponent(market)}&bar=15m&after=${after}&limit=${OKX_LIMIT}`;
	}
	return `${BASE_URL}/${market}/?step=${STEP_SECONDS}&limit=${limit}&start=${startSec}`;
}

function parseFor(src: CandleSrc, json: unknown): Candle[] {
	if (src === 'cb-ohlc') {
		return parseCoinbaseCandles(json);
	}
	if (src === 'kr-ohlc') {
		return parseKrakenCandles(json);
	}
	if (src === 'ok-ohlc') {
		return parseOkxCandles(json);
	}
	return parseCandles(json);
}

/**
 * The rows that fill the gaps of all targets. Never throws: a market that fails is logged and its gap stays
 * open for the next run. A long gap is filled forward, one request after the other (Kraken: one request with
 * the newest candles). After `MAX_REQUESTS` requests the rest waits for the next run. A 429 or a rate limit
 * text stops the remaining requests of that source; their gaps stay open too.
 */
export async function fetchGapRows(
	targets: GapTarget[],
	opts: GapFillOptions
): Promise<GapResult> {
	const result: GapResult = { rows: [], pending: {} };
	let requests = 0;
	const stopped = new Set<CandleSrc>();
	for (const target of targets) {
		const forward = target.src !== 'kr-ohlc';
		let fromSec = target.fromSec;
		for (;;) {
			const plan = planRequest(
				fromSec,
				opts.nowSec,
				sourceLimit(target.src),
				forward
			);
			if (plan === null) {
				break;
			}
			const open = isoSeconds(new Date(fromSec * 1000));
			if (stopped.has(target.src) || requests >= MAX_REQUESTS) {
				result.pending[target.coin] = open;
				break;
			}
			if (requests > 0) {
				await opts.sleep(opts.pauseMs);
			}
			requests += 1;
			const url = candleUrl(
				target.src,
				target.market,
				plan.startSec,
				plan.limit
			);
			const answer = await opts.http.getJson({ url, timeoutMs: 20_000 });
			if (answer.status === 429) {
				opts.log(
					`gap fill: HTTP 429 from ${target.src}, its other markets wait for the next run`
				);
				stopped.add(target.src);
				result.pending[target.coin] = open;
				break;
			}
			if (answer.status !== 200 || answer.error !== undefined) {
				opts.log(
					`gap fill: ${target.coin}: HTTP ${answer.status} ${answer.error ?? ''}`.trimEnd()
				);
				result.pending[target.coin] = open;
				break;
			}
			// The end of the window: the close of its last candle. Nothing after it is taken from this answer.
			const windowEnd = Math.min(
				opts.nowSec,
				plan.startSec + plan.limit * STEP_SECONDS
			);
			let found: PriceRow[];
			try {
				found = candleRows(
					target.coin,
					parseFor(target.src, answer.json),
					fromSec,
					forward ? windowEnd : opts.nowSec,
					target.src
				);
			} catch (error) {
				const reason = describeError(error);
				opts.log(`gap fill: ${target.coin}: ${reason}`);
				result.pending[target.coin] = open;
				// Kraken reports a rate limit as an error text inside a 200 answer
				if (reason.includes('Rate limit')) {
					stopped.add(target.src);
				}
				break;
			}
			result.rows.push(...found);
			opts.log(
				`gap fill: ${target.coin}: ${found.length} candles from ${isoSeconds(new Date(plan.startSec * 1000))} (${target.src})`
			);
			if (!forward || windowEnd >= opts.nowSec) {
				break;
			}
			fromSec = windowEnd;
		}
	}
	return result;
}
