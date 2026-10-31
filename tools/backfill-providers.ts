// The candle providers of tools/backfill.ts: Coinbase, Kraken (built from trades) and OKX.
// Each one turns the answers of an exchange into candle closes: the candle end time and the close price
// as the exchange wrote it. Nothing here writes a file. Prices stay text, so no digit is changed.

import type { HttpClient } from '../src/types.ts';

export const STEP_SECONDS = 900;

/** A candle close: `endSec` is the end of the candle (epoch seconds), `close` the price as text. */
export interface CandleClose {
	endSec: number;
	close: string;
	volume: string;
}

export interface FetchContext {
	http: HttpClient;
	/** Waits until the next request of this provider may start (one shared pace for all coins). */
	pace: () => Promise<void>;
	sleep: (ms: number) => Promise<void>;
	log: (line: string) => void;
}

/** Waits after a 429, a 5xx, a network error or a rate limit text. After the last wait the run stops. */
const RETRY_WAITS_MS = [30_000, 60_000, 120_000];
const DECIMAL = /^\d+(\.\d+)?$/;

/** A JSON number as plain text. An exponent form is refused, because it would change the digits. */
function plainNumber(value: unknown): string {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		throw new Error('A price is not a positive number');
	}
	const text = String(value);
	if (/e/i.test(text)) {
		throw new Error('A price is in exponent form');
	}
	return text;
}

function plainVolume(value: unknown): string {
	if (typeof value === 'string' && DECIMAL.test(value)) {
		return value;
	}
	if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
		return /e/i.test(String(value)) ? '0.000001' : String(value);
	}
	throw new Error('A volume is not a plain number');
}

/** The pace of one provider: the starts of two requests are at least `gapMs` apart, whoever asks. */
export function createPace(
	gapMs: number,
	sleep: (ms: number) => Promise<void>,
	now: () => number = Date.now
): () => Promise<void> {
	let next = 0;
	return async () => {
		const at = Math.max(now(), next);
		next = at + gapMs;
		const wait = at - now();
		if (wait > 0) {
			await sleep(wait);
		}
	};
}

/** One request with the waits of RETRY_WAITS_MS. `read` throws a message with "Rate limit" to ask for a wait. */
async function request<T>(
	url: string,
	ctx: FetchContext,
	read: (json: unknown) => T
): Promise<T> {
	for (let attempt = 0; ; attempt += 1) {
		await ctx.pace();
		const result = await ctx.http.getJson({ url, timeoutMs: 20_000 });
		let reason = `HTTP ${result.status} (${result.error ?? 'no body'})`;
		let retryable =
			result.status === 429 ||
			result.status >= 500 ||
			result.status === 0;
		if (result.status === 200 && result.error === undefined) {
			try {
				return read(result.json);
			} catch (error) {
				reason = (error as Error).message;
				retryable = reason.includes('Rate limit');
			}
		}
		const wait = RETRY_WAITS_MS[attempt];
		if (!retryable || wait === undefined) {
			throw new Error(`${reason} for ${url.split('?')[0]}`);
		}
		ctx.log(
			`${reason}, waiting ${wait / 1000} s before try ${attempt + 2}`
		);
		await ctx.sleep(wait);
	}
}

// ---------------------------------------------------------------- Coinbase

/** 288 candles of 15 minutes, below the 300 that one request can return. */
export const COINBASE_WINDOW_SECONDS = 288 * STEP_SECONDS;

/** The answer of `candles`: `[time, low, high, open, close, volume]` rows, newest first. */
export function parseCoinbaseCandles(json: unknown): CandleClose[] {
	if (!Array.isArray(json)) {
		throw new Error('The answer is not a list of candles');
	}
	const out = json.map((item: unknown) => {
		const entry = Array.isArray(item) ? item : [];
		const [time, , , , close, volume] = entry as unknown[];
		if (typeof time !== 'number' || !Number.isInteger(time)) {
			throw new Error('A candle has no time');
		}
		return {
			endSec: time + STEP_SECONDS,
			close: plainNumber(close),
			volume: plainVolume(volume),
		};
	});
	return out.sort((a, b) => a.endSec - b.endSec);
}

export function coinbaseUrl(
	product: string,
	startSec: number,
	endSec: number
): string {
	const iso = (sec: number) => new Date(sec * 1000).toISOString();
	return `https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/candles?granularity=${STEP_SECONDS}&start=${iso(startSec)}&end=${iso(endSec)}`;
}

/**
 * The candle closes of one product from `fromSec` up to `untilSec`, window by window, oldest first.
 * `emit` gets each window, so a stop loses at most one window.
 */
export async function fetchCoinbase(
	product: string,
	fromSec: number,
	untilSec: number,
	ctx: FetchContext,
	emit: (candles: CandleClose[]) => Promise<void>
): Promise<number> {
	let requests = 0;
	for (
		let start = fromSec;
		start < untilSec;
		start += COINBASE_WINDOW_SECONDS
	) {
		const end = Math.min(start + COINBASE_WINDOW_SECONDS, untilSec);
		const candles = await request(
			coinbaseUrl(product, start, end),
			ctx,
			parseCoinbaseCandles
		);
		requests += 1;
		// Both ends of a window can hold a candle, so the next window repeats one: `emit` skips it by time
		await emit(candles.filter((item) => item.endSec <= untilSec));
	}
	return requests;
}

// ---------------------------------------------------------------- OKX

/** The answer of `history-candles`: `[ts, open, high, low, close, volume, ...]` rows, newest first. */
export function parseOkxCandles(json: unknown): CandleClose[] {
	const body = json as {
		code?: unknown;
		msg?: unknown;
		data?: unknown;
	} | null;
	if (body === null || typeof body !== 'object' || body.code !== '0') {
		throw new Error(`OKX answered code ${String(body?.code)}`);
	}
	if (!Array.isArray(body.data)) {
		throw new Error('The answer has no candle list');
	}
	return body.data
		.map((item: unknown) => {
			const entry = Array.isArray(item) ? item : [];
			const [ts, , , , close, volume] = entry as unknown[];
			if (typeof ts !== 'string' || !/^\d{13}$/.test(ts)) {
				throw new Error('A candle has no time');
			}
			if (typeof close !== 'string' || !DECIMAL.test(close)) {
				throw new Error('A candle has a close that is not plain');
			}
			return {
				endSec: Number(ts) / 1000 + STEP_SECONDS,
				close,
				volume: plainVolume(volume),
			};
		})
		.sort((a, b) => a.endSec - b.endSec);
}

export function okxUrl(market: string, afterMs: number): string {
	return `https://www.okx.com/api/v5/market/history-candles?instId=${encodeURIComponent(market)}&bar=15m&after=${afterMs}&limit=100`;
}

/**
 * The candle closes of one market from `fromSec` up to `untilSec`. OKX pages go from new to old, so all
 * pages are read first and the result is in time order. One page is up to 100 candles.
 */
export async function fetchOkx(
	market: string,
	fromSec: number,
	untilSec: number,
	ctx: FetchContext
): Promise<{ candles: CandleClose[]; requests: number }> {
	const found = new Map<number, CandleClose>();
	let requests = 0;
	// `after` returns candles that started before it
	let after = (untilSec - STEP_SECONDS) * 1000 + 1;
	for (;;) {
		const page = await request(okxUrl(market, after), ctx, parseOkxCandles);
		requests += 1;
		if (page.length === 0) {
			break;
		}
		for (const item of page) {
			if (item.endSec > fromSec && item.endSec <= untilSec) {
				found.set(item.endSec, item);
			}
		}
		const oldest = page[0];
		if (oldest === undefined || oldest.endSec - STEP_SECONDS <= fromSec) {
			break;
		}
		after = (oldest.endSec - STEP_SECONDS) * 1000;
	}
	return {
		candles: [...found.values()].sort((a, b) => a.endSec - b.endSec),
		requests,
	};
}

// ---------------------------------------------------------------- Kraken trades

export interface Trade {
	/** Seconds, with a fraction. */
	time: number;
	price: string;
	volume: string;
}

/** Builds 15-minute candle closes from trades in time order. A candle is complete when a later one starts. */
export function createCandleBuilder(): {
	push: (trade: Trade) => CandleClose[];
	flush: (limitSec: number) => CandleClose[];
} {
	let open: { endSec: number; close: string; volume: number } | null = null;
	function emitOpen(): CandleClose[] {
		if (open === null) {
			return [];
		}
		const done = {
			endSec: open.endSec,
			close: open.close,
			volume: String(open.volume),
		};
		open = null;
		return [done];
	}
	return {
		push(trade) {
			const endSec =
				(Math.floor(trade.time / STEP_SECONDS) + 1) * STEP_SECONDS;
			const volume = Number(trade.volume);
			let done: CandleClose[] = [];
			if (open !== null && open.endSec !== endSec) {
				done = emitOpen();
			}
			if (open === null) {
				open = { endSec, close: trade.price, volume: 0 };
			}
			open.close = trade.price;
			open.volume += Number.isFinite(volume) ? volume : 0;
			return done;
		},
		/** The open candle is complete when its end is at or before `limitSec`. */
		flush(limitSec) {
			return open !== null && open.endSec <= limitSec ? emitOpen() : [];
		},
	};
}

/** The answer of `Trades`: the trades `[price, volume, time, side, type, misc, id]` and the cursor `last`. */
export function parseKrakenTrades(json: unknown): {
	trades: Trade[];
	last: string;
} {
	const body = json as { error?: unknown; result?: unknown } | null;
	if (Array.isArray(body?.error) && body.error.length > 0) {
		throw new Error(`Kraken answered: ${body.error.join(', ')}`);
	}
	const result = body?.result as Record<string, unknown> | undefined;
	if (typeof result !== 'object' || result === null) {
		throw new Error('The answer has no result');
	}
	const key = Object.keys(result).find((name) => name !== 'last');
	const list = key === undefined ? undefined : result[key];
	const last = result.last;
	if (
		!Array.isArray(list) ||
		typeof last !== 'string' ||
		!/^\d+$/.test(last)
	) {
		throw new Error('The answer has no trade list');
	}
	const trades = list.map((item: unknown) => {
		const entry = Array.isArray(item) ? item : [];
		const [price, volume, time] = entry as unknown[];
		if (
			typeof price !== 'string' ||
			!DECIMAL.test(price) ||
			Number(price) <= 0 ||
			typeof volume !== 'string' ||
			!DECIMAL.test(volume) ||
			typeof time !== 'number' ||
			!Number.isFinite(time)
		) {
			throw new Error('A trade has a field that is not a plain number');
		}
		return { time, price, volume };
	});
	return { trades, last };
}

export function krakenTradesUrl(pair: string, sinceNs: string): string {
	return `https://api.kraken.com/0/public/Trades?pair=${pair}&since=${sinceNs}&count=1000`;
}

/**
 * The 15-minute candle closes of one pair from `fromSec` up to `untilSec`, built from its trades. Each page
 * of up to 1000 trades goes to `emit` as soon as its candles are complete, oldest first.
 */
export async function fetchKrakenTrades(
	pair: string,
	fromSec: number,
	untilSec: number,
	ctx: FetchContext,
	emit: (candles: CandleClose[]) => Promise<void>
): Promise<number> {
	const builder = createCandleBuilder();
	let since = `${fromSec}000000000`;
	let requests = 0;
	for (;;) {
		const page = await request(
			krakenTradesUrl(pair, since),
			ctx,
			parseKrakenTrades
		);
		requests += 1;
		const done: CandleClose[] = [];
		let reached = false;
		for (const trade of page.trades) {
			if (trade.time >= untilSec) {
				reached = true;
				break;
			}
			done.push(...builder.push(trade));
		}
		if (done.length > 0) {
			await emit(done);
		}
		if (reached || page.trades.length === 0 || page.last === since) {
			break;
		}
		since = page.last;
	}
	const rest = builder.flush(untilSec);
	if (rest.length > 0) {
		await emit(rest);
	}
	return requests;
}
