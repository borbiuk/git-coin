// Bitstamp adapter (ADR 0002 Revision 2, ADR 0004 D7). One request returns all markets.

import { isoSeconds } from '../time.ts';
import type {
	CoinConfig,
	ErrorCode,
	HttpClient,
	MarketRow,
	PriceRow,
	SourceAdapter,
	SourceRun,
} from '../types.ts';
import { SRC_CODE } from '../types.ts';

const TICKER_URL = 'https://www.bitstamp.net/api/v2/ticker/';

interface TickerEntry {
	last: unknown;
	timestamp: unknown;
	bid: unknown;
	ask: unknown;
	volume: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `BTC/USD` and `btcusd` both become `btcusd`. */
function normalizeMarket(value: string): string {
	return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/** Whole seconds between the source time (epoch seconds as text) and now. Never negative. */
function ageSeconds(timestamp: unknown, nowMs: number): number | null {
	if (typeof timestamp !== 'string' || !/^\d{1,12}$/.test(timestamp)) {
		return null;
	}
	return Math.max(0, Math.floor(nowMs / 1000) - Number(timestamp));
}

/** Maps the normalised pair to its entry. Returns null when the body is not a list. */
function indexTicker(json: unknown): Map<string, TickerEntry> | null {
	if (!Array.isArray(json)) {
		return null;
	}
	const index = new Map<string, TickerEntry>();
	for (const item of json as unknown[]) {
		if (!isRecord(item) || typeof item.pair !== 'string') {
			continue;
		}
		const key = normalizeMarket(item.pair);
		if (!index.has(key)) {
			index.set(key, {
				last: item.last,
				timestamp: item.timestamp,
				bid: item.bid,
				ask: item.ask,
				volume: item.volume,
			});
		}
	}
	return index;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Bid, ask and the 24 hour volume of one market. Null when it has none of them. */
function readMarket(
	ts: string,
	coin: string,
	entry: TickerEntry
): MarketRow | null {
	const row: MarketRow = { ts, coin, src: SRC_CODE.bitstamp };
	const bid = text(entry.bid);
	const ask = text(entry.ask);
	const volume = text(entry.volume);
	if (bid !== undefined) {
		row.bid = bid;
	}
	if (ask !== undefined) {
		row.ask = ask;
	}
	if (volume !== undefined) {
		row.volume = volume;
	}
	return bid === undefined && ask === undefined && volume === undefined
		? null
		: row;
}

export const bitstampAdapter: SourceAdapter = {
	id: 'bitstamp',
	src: SRC_CODE.bitstamp,
	async fetchPrices(
		coins: CoinConfig[],
		http: HttpClient,
		now: () => Date
	): Promise<SourceRun> {
		const src = SRC_CODE.bitstamp;
		if (coins.length === 0) {
			const ts = isoSeconds(now());
			return {
				src,
				rows: [],
				log: { ts, src, http: 0, ms: 0, coins_ok: 0, error: '' },
			};
		}

		const result = await http.getJson({ url: TICKER_URL });
		const at = now();
		const ts = isoSeconds(at);
		const fail = (error: ErrorCode): SourceRun => ({
			src,
			rows: [],
			log: {
				ts,
				src,
				http: result.status,
				ms: result.ms,
				coins_ok: 0,
				error,
			},
		});

		if (result.error !== undefined) {
			return fail(result.error);
		}
		if (result.status < 200 || result.status >= 300) {
			return fail(result.status === 429 ? 'http_429' : 'http_other');
		}
		const index = indexTicker(result.json);
		if (index === null) {
			return fail('parse');
		}

		const rows: PriceRow[] = [];
		const extras: MarketRow[] = [];
		let error: ErrorCode | '' = '';
		for (const coin of coins) {
			const market = coin.sources.bitstamp_market;
			const entry =
				market === undefined
					? undefined
					: index.get(normalizeMarket(market));
			if (entry === undefined) {
				error = error === '' ? 'unmapped' : error;
				continue;
			}
			if (typeof entry.last !== 'string' || entry.last === '') {
				error = error === '' ? 'parse' : error;
				continue;
			}
			rows.push({
				ts,
				coin: coin.id,
				price: entry.last,
				src,
				age_s: ageSeconds(entry.timestamp, at.getTime()),
			});
			const extra = readMarket(ts, coin.id, entry);
			if (extra !== null) {
				extras.push(extra);
			}
		}

		return {
			src,
			rows,
			log: {
				ts,
				src,
				http: result.status,
				ms: result.ms,
				coins_ok: rows.length,
				error,
			},
			...(extras.length > 0 ? { market: extras } : {}),
		};
	},
};
