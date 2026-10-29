// Coin Metrics Community adapter (ADR 0002 Revision 2 and Addendum A3, ADR 0004 D7).
// One request returns the newest `ReferenceRateUSD` of every asset.

import { isoSeconds } from '../time.ts';
import type {
	CoinConfig,
	ErrorCode,
	HttpClient,
	HttpResult,
	PriceRow,
	SourceAdapter,
	SourceRun,
} from '../types.ts';
import { SRC_CODE } from '../types.ts';

const API_HOST = 'community-api.coinmetrics.io';
const BASE_URL = `https://${API_HOST}/v4/timeseries/asset-metrics`;
// One page holds one value per asset, so more than one page is a rare case.
const MAX_PAGES = 3;

interface Sample {
	timeSeconds: number | null;
	value: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Epoch seconds of a time like `2026-10-29T14:40:00.000000000Z` (nanoseconds are dropped). */
function parseSourceTime(value: unknown): number | null {
	if (typeof value !== 'string') {
		return null;
	}
	const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z$/.exec(
		value
	);
	if (match === null) {
		return null;
	}
	const ms = Date.parse(`${match[1]}Z`);
	return Number.isNaN(ms) ? null : ms / 1000;
}

function buildUrl(assets: string[]): string {
	const list = assets.map((asset) => encodeURIComponent(asset)).join(',');
	return `${BASE_URL}?assets=${list}&metrics=ReferenceRateUSD&frequency=1m&limit_per_asset=1&paging_from=end`;
}

/** The next page is followed only when it stays on the Coin Metrics host. */
function nextPageUrl(json: Record<string, unknown>): string | null {
	const next = json.next_page_url;
	if (typeof next !== 'string') {
		return null;
	}
	try {
		const url = new URL(next);
		return url.protocol === 'https:' && url.hostname === API_HOST
			? url.href
			: null;
	} catch {
		return null;
	}
}

function failureCode(result: HttpResult): ErrorCode | null {
	if (result.error !== undefined) {
		return result.error;
	}
	if (result.status < 200 || result.status >= 300) {
		return result.status === 429 ? 'http_429' : 'http_other';
	}
	return null;
}

/** Keeps the newest sample of each asset. Returns false when the body has no `data` list. */
function collectSamples(json: unknown, samples: Map<string, Sample>): boolean {
	if (!isRecord(json) || !Array.isArray(json.data)) {
		return false;
	}
	for (const item of json.data as unknown[]) {
		if (!isRecord(item) || typeof item.asset !== 'string') {
			continue;
		}
		const asset = item.asset.toLowerCase();
		const timeSeconds = parseSourceTime(item.time);
		const known = samples.get(asset);
		if (
			known === undefined ||
			(timeSeconds !== null &&
				(known.timeSeconds === null || timeSeconds > known.timeSeconds))
		) {
			samples.set(asset, { timeSeconds, value: item.ReferenceRateUSD });
		}
	}
	return true;
}

export const coinmetricsAdapter: SourceAdapter = {
	id: 'coinmetrics',
	src: SRC_CODE.coinmetrics,
	async fetchPrices(
		coins: CoinConfig[],
		http: HttpClient,
		now: () => Date
	): Promise<SourceRun> {
		const src = SRC_CODE.coinmetrics;
		const assets = [
			...new Set(
				coins.flatMap((coin) => {
					const asset = coin.sources.coinmetrics_asset;
					return asset === undefined ? [] : [asset.toLowerCase()];
				})
			),
		];
		if (assets.length === 0) {
			const ts = isoSeconds(now());
			return {
				src,
				rows: [],
				log: {
					ts,
					src,
					http: 0,
					ms: 0,
					coins_ok: 0,
					error: coins.length > 0 ? 'unmapped' : '',
				},
			};
		}

		const samples = new Map<string, Sample>();
		let url: string | null = buildUrl(assets);
		let totalMs = 0;
		// The first non-200 status of the pages, or 200 when every page answered 200.
		let httpStatus = 200;
		let error: ErrorCode | '' = '';
		for (let page = 0; page < MAX_PAGES && url !== null; page += 1) {
			const result = await http.getJson({ url });
			totalMs += result.ms;
			const failure =
				failureCode(result) ??
				(collectSamples(result.json, samples) ? null : 'parse');
			if (failure !== null) {
				if (result.status !== 200 && httpStatus === 200) {
					httpStatus = result.status;
				}
				error = failure;
				break;
			}
			const stillMissing = assets.some((asset) => !samples.has(asset));
			url =
				stillMissing && isRecord(result.json)
					? nextPageUrl(result.json)
					: null;
		}

		const at = now();
		const ts = isoSeconds(at);
		const rows: PriceRow[] = [];
		for (const coin of coins) {
			const asset = coin.sources.coinmetrics_asset?.toLowerCase();
			const sample = asset === undefined ? undefined : samples.get(asset);
			if (sample === undefined) {
				if (error === '') {
					error = 'unmapped';
				}
				continue;
			}
			if (typeof sample.value !== 'string' || sample.value === '') {
				if (error === '') {
					error = 'parse';
				}
				continue;
			}
			rows.push({
				ts,
				coin: coin.id,
				price: sample.value,
				src,
				age_s:
					sample.timeSeconds === null
						? null
						: Math.max(
								0,
								Math.floor(at.getTime() / 1000) -
									sample.timeSeconds
							),
			});
		}

		return {
			src,
			rows,
			log: {
				ts,
				src,
				http: httpStatus,
				ms: totalMs,
				coins_ok: rows.length,
				error,
			},
		};
	},
};
