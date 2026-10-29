// Kraken adapter (ADR 0002). One `AssetPairs` request maps our pair names to result keys,
// one `Ticker` request gives the prices. Both count in one request-log row.
import { isoSeconds } from '../time.ts';
import {
	SRC_CODE,
	type CoinConfig,
	type ErrorCode,
	type HttpClient,
	type HttpResult,
	type PriceRow,
	type SourceAdapter,
	type SourceRun,
} from '../types.ts';

const BASE_URL = 'https://api.kraken.com/0/public';

// Kraken answers HTTP 200 with these messages in `error` when it limits a client
const RATE_LIMIT_PREFIXES = ['EAPI:Rate limit', 'EGeneral:Temporary lockout'];

type Reply =
	| { ok: true; result: Record<string, unknown> }
	// `pairRejected` is true when Kraken refused the `pair` list itself (bad request or an error message)
	| {
			ok: false;
			error: Exclude<ErrorCode, 'unmapped'>;
			pairRejected: boolean;
	  };

interface Tally {
	ms: number;
	/** 200, or the first status that was not 200. */
	http: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readReply(res: HttpResult): Reply {
	if (res.error === 'http_429' || res.status === 429) {
		return { ok: false, error: 'http_429', pairRejected: false };
	}
	if (res.error === 'timeout') {
		return { ok: false, error: 'timeout', pairRejected: false };
	}
	if (res.error === 'http_other' || res.status !== 200) {
		return {
			ok: false,
			error: 'http_other',
			pairRejected: res.status >= 400 && res.status < 500,
		};
	}
	if (res.error === 'parse' || !isRecord(res.json)) {
		return { ok: false, error: 'parse', pairRejected: false };
	}
	const errors = res.json.error;
	if (!Array.isArray(errors)) {
		return { ok: false, error: 'parse', pairRejected: false };
	}
	if (errors.length > 0) {
		const limited = errors.some(
			(message) =>
				typeof message === 'string' &&
				RATE_LIMIT_PREFIXES.some((prefix) => message.startsWith(prefix))
		);
		return {
			ok: false,
			error: limited ? 'http_429' : 'http_other',
			pairRejected: !limited,
		};
	}
	if (!isRecord(res.json.result)) {
		return { ok: false, error: 'parse', pairRejected: false };
	}
	return { ok: true, result: res.json.result };
}

async function request(
	http: HttpClient,
	tally: Tally,
	url: string
): Promise<Reply> {
	const res = await http.getJson({ url });
	tally.ms += res.ms;
	if (res.status !== 200 && tally.http === 200) {
		tally.http = res.status;
	}
	return readReply(res);
}

/** Asks for the given pairs. If Kraken refuses the list, asks for all pairs (the caller filters). */
async function requestPairs(
	http: HttpClient,
	tally: Tally,
	endpoint: string,
	pairs: string[]
): Promise<Reply> {
	const list = pairs.map(encodeURIComponent).join(',');
	const reply = await request(
		http,
		tally,
		`${BASE_URL}/${endpoint}?pair=${list}`
	);
	if (reply.ok || !reply.pairRejected) {
		return reply;
	}
	return request(http, tally, `${BASE_URL}/${endpoint}`);
}

/** Maps `altname` and `wsname` (without the slash) of every online pair to its result key. */
function indexCatalogue(
	catalogue: Record<string, unknown>
): Map<string, string> {
	const index = new Map<string, string>();
	for (const [key, entry] of Object.entries(catalogue)) {
		if (!isRecord(entry)) {
			continue;
		}
		if (typeof entry.status === 'string' && entry.status !== 'online') {
			continue;
		}
		if (typeof entry.altname === 'string') {
			index.set(entry.altname.toUpperCase(), key);
		}
		if (typeof entry.wsname === 'string') {
			index.set(entry.wsname.replace('/', '').toUpperCase(), key);
		}
	}
	return index;
}

function readPrice(entry: unknown): string | null {
	if (!isRecord(entry) || !Array.isArray(entry.c)) {
		return null;
	}
	const last: unknown = entry.c[0];
	return typeof last === 'string' && last !== '' ? last : null;
}

export const krakenAdapter: SourceAdapter = {
	id: 'kraken',
	src: SRC_CODE.kraken,
	async fetchPrices(
		coins: CoinConfig[],
		http: HttpClient,
		now: () => Date
	): Promise<SourceRun> {
		const wanted = coins.filter(
			(coin) => coin.enabled && coin.sources.kraken_pair !== undefined
		);
		const tally: Tally = { ms: 0, http: 200 };
		const finish = (
			rows: PriceRow[],
			error: ErrorCode | '',
			ts: string = isoSeconds(now())
		): SourceRun => ({
			src: SRC_CODE.kraken,
			rows,
			log: {
				ts,
				src: SRC_CODE.kraken,
				http: tally.http,
				ms: tally.ms,
				coins_ok: rows.length,
				error,
			},
		});

		if (wanted.length === 0) {
			return finish([], '');
		}
		const pairs = wanted.map((coin) => coin.sources.kraken_pair ?? '');

		const catalogue = await requestPairs(http, tally, 'AssetPairs', pairs);
		if (!catalogue.ok) {
			return finish([], catalogue.error);
		}
		const ticker = await requestPairs(http, tally, 'Ticker', pairs);
		if (!ticker.ok) {
			return finish([], ticker.error);
		}

		// One timestamp for the run, taken right after the last response
		const ts = isoSeconds(now());
		const index = indexCatalogue(catalogue.result);
		const rows: PriceRow[] = [];
		let error: ErrorCode | '' = '';
		for (const coin of wanted) {
			const pair = (coin.sources.kraken_pair ?? '').toUpperCase();
			const key = index.get(pair);
			if (key === undefined || !Object.hasOwn(ticker.result, key)) {
				error ||= 'unmapped';
				continue;
			}
			const price = readPrice(ticker.result[key]);
			if (price === null) {
				error ||= 'parse';
				continue;
			}
			rows.push({
				ts,
				coin: coin.id,
				price,
				src: SRC_CODE.kraken,
				age_s: null,
			});
		}
		return finish(rows, error, ts);
	},
};
