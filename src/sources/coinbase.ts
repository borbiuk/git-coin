import { isoSeconds } from '../time.ts';
import type {
	CoinConfig,
	ErrorCode,
	HttpClient,
	PriceRow,
	SourceAdapter,
	SourceRun,
} from '../types.ts';
import { SRC_CODE } from '../types.ts';

// Coinbase Exchange: one ticker request per coin, at most 4 in flight (the limit is 10 per second per IP).
const BASE_URL = 'https://api.exchange.coinbase.com/products';
const MAX_IN_FLIGHT = 4;

interface CoinOutcome {
	row?: PriceRow;
	status: number;
	error?: ErrorCode;
}

/** The age of the exchange time at `at`, in whole seconds, never negative. `null` if there is no usable time. */
function ageSeconds(time: unknown, at: Date): number | null {
	if (typeof time !== 'string') {
		return null;
	}
	const sourceMs = Date.parse(time);
	if (Number.isNaN(sourceMs)) {
		return null;
	}
	return Math.max(0, Math.round((at.getTime() - sourceMs) / 1000));
}

async function fetchCoin(
	coin: CoinConfig,
	http: HttpClient,
	now: () => Date
): Promise<CoinOutcome> {
	const product = coin.sources.coinbase_product;
	if (product === undefined || product === '') {
		return { status: 200, error: 'unmapped' };
	}
	const result = await http.getJson({
		url: `${BASE_URL}/${encodeURIComponent(product)}/ticker`,
	});
	// The row time is taken right after this coin's own response.
	const fetchedAt = now();
	if (result.error !== undefined) {
		return { status: result.status, error: result.error };
	}
	if (result.status !== 200) {
		return { status: result.status, error: 'http_other' };
	}
	const body = result.json;
	if (typeof body !== 'object' || body === null) {
		return { status: result.status, error: 'parse' };
	}
	const { price, time } = body as { price?: unknown; time?: unknown };
	if (typeof price !== 'string' || price === '') {
		return { status: result.status, error: 'parse' };
	}
	return {
		status: result.status,
		row: {
			ts: isoSeconds(fetchedAt),
			coin: coin.id,
			price,
			src: SRC_CODE.coinbase,
			age_s: ageSeconds(time, fetchedAt),
		},
	};
}

export const coinbaseAdapter: SourceAdapter = {
	id: 'coinbase',
	src: SRC_CODE.coinbase,
	async fetchPrices(coins, http, now): Promise<SourceRun> {
		const startedAt = now();
		const outcomes = new Array<CoinOutcome>(coins.length);
		let next = 0;
		async function worker(): Promise<void> {
			while (next < coins.length) {
				const index = next;
				next += 1;
				outcomes[index] = await fetchCoin(coins[index], http, now);
			}
		}
		const workers: Array<Promise<void>> = [];
		for (let i = 0; i < Math.min(MAX_IN_FLIGHT, coins.length); i += 1) {
			workers.push(worker());
		}
		await Promise.all(workers);

		// Outcomes are in coin order, so "first" is stable and does not depend on timing.
		const rows: PriceRow[] = [];
		let httpStatus = coins.length === 0 ? 0 : 200;
		let statusSet = false;
		let error: ErrorCode | '' = '';
		for (const outcome of outcomes) {
			if (outcome.row !== undefined) {
				rows.push(outcome.row);
			}
			if (outcome.error === undefined) {
				continue;
			}
			if (error === '') {
				error = outcome.error;
			}
			if (!statusSet && outcome.status !== 200) {
				httpStatus = outcome.status;
				statusSet = true;
			}
		}
		return {
			src: SRC_CODE.coinbase,
			rows,
			log: {
				ts: isoSeconds(startedAt),
				src: SRC_CODE.coinbase,
				http: httpStatus,
				ms: Math.max(0, now().getTime() - startedAt.getTime()),
				coins_ok: rows.length,
				error,
			},
		};
	},
};
