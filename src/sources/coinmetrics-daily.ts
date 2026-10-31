// Daily Coin Metrics Community metrics (ADR 0004 D8): market capitalisation, volume, supply and network activity.
// The API refuses a whole request when one asset lacks one metric (HTTP 403), so the catalogue is read first
// and each metric is asked only for the assets that have it. Metrics with the same assets share a request.

import { isoSeconds } from '../time.ts';
import type {
	CoinConfig,
	HttpClient,
	HttpResult,
	MarketRow,
} from '../types.ts';
import { SRC_CODE } from '../types.ts';

const API_BASE = 'https://community-api.coinmetrics.io/v4';

/** The metric of Coin Metrics and the field of the market row that holds it. */
const METRIC_FIELD = {
	CapMrktEstUSD: 'market_cap',
	volume_reported_spot_usd_1d: 'volume_usd',
	SplyCur: 'supply',
	TxCnt: 'tx_count',
	AdrActCnt: 'active_addresses',
	HashRate: 'hash_rate',
} as const;

type Metric = keyof typeof METRIC_FIELD;
type Field = (typeof METRIC_FIELD)[Metric];

const METRICS = Object.keys(METRIC_FIELD) as Metric[];
const DAY_TIME = /^(\d{4}-\d{2}-\d{2})T/;

export interface DailyResult {
	rows: MarketRow[];
	/** True when the catalogue and at least one metric request worked and there is a row to store. */
	ok: boolean;
	/** Short notes about the requests that failed. Never holds text from a response. */
	problems: string[];
}

interface AssetValues {
	fields: Partial<Record<Field, string>>;
	/** The newest day of the records of the asset. */
	asOf?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failed(result: HttpResult): string | null {
	if (result.error !== undefined) {
		return result.error;
	}
	if (result.status < 200 || result.status >= 300) {
		return `http ${result.status}`;
	}
	return null;
}

function isMetric(name: string): name is Metric {
	return name in METRIC_FIELD;
}

/** The assets (lower case) that have a daily value of each metric, from the catalogue answer. */
function readCatalogue(json: unknown): Map<Metric, Set<string>> | null {
	if (!isRecord(json) || !Array.isArray(json.data)) {
		return null;
	}
	const result = new Map<Metric, Set<string>>();
	for (const item of json.data as unknown[]) {
		if (
			!isRecord(item) ||
			typeof item.metric !== 'string' ||
			!isMetric(item.metric) ||
			!Array.isArray(item.frequencies)
		) {
			continue;
		}
		for (const entry of item.frequencies as unknown[]) {
			if (
				!isRecord(entry) ||
				entry.frequency !== '1d' ||
				!Array.isArray(entry.assets)
			) {
				continue;
			}
			result.set(
				item.metric,
				new Set(
					(entry.assets as unknown[])
						.filter(
							(asset): asset is string =>
								typeof asset === 'string'
						)
						.map((asset) => asset.toLowerCase())
				)
			);
		}
	}
	return result;
}

/** Keeps the newest non-empty value of each metric per asset. Returns false when the body has no `data` list. */
function collectValues(
	json: unknown,
	metrics: Metric[],
	values: Map<string, AssetValues>
): boolean {
	if (!isRecord(json) || !Array.isArray(json.data)) {
		return false;
	}
	for (const item of json.data as unknown[]) {
		if (!isRecord(item) || typeof item.asset !== 'string') {
			continue;
		}
		const asset = item.asset.toLowerCase();
		const entry = values.get(asset) ?? { fields: {} };
		values.set(asset, entry);
		const day =
			typeof item.time === 'string'
				? DAY_TIME.exec(item.time)?.[1]
				: undefined;
		for (const metric of metrics) {
			const value = item[metric];
			if (typeof value === 'string' && value !== '') {
				entry.fields[METRIC_FIELD[metric]] = value;
			}
		}
		if (
			day !== undefined &&
			(entry.asOf === undefined || day > entry.asOf)
		) {
			entry.asOf = day;
		}
	}
	return true;
}

/** Metrics that are asked for the same assets, so one request can carry them all. */
function groupByAssets(
	wanted: Set<string>,
	catalogue: Map<Metric, Set<string>>
): Array<{ assets: string[]; metrics: Metric[] }> {
	const groups = new Map<string, { assets: string[]; metrics: Metric[] }>();
	for (const metric of METRICS) {
		const have = catalogue.get(metric);
		if (have === undefined) {
			continue;
		}
		const assets = [...wanted].filter((asset) => have.has(asset)).sort();
		if (assets.length === 0) {
			continue;
		}
		const key = assets.join(',');
		const group = groups.get(key) ?? { assets, metrics: [] };
		group.metrics.push(metric);
		groups.set(key, group);
	}
	return [...groups.values()];
}

/**
 * The daily metrics of the given coins (`coinmetrics_asset` of each). One `cm` row per coin that got at
 * least one value. A request that fails leaves its metrics out. Never throws for a bad answer.
 */
export async function fetchDailyMetrics(
	coins: CoinConfig[],
	http: HttpClient,
	now: () => Date
): Promise<DailyResult> {
	const assetOf = new Map<string, string[]>();
	for (const coin of coins) {
		const asset = coin.sources.coinmetrics_asset?.toLowerCase();
		if (asset === undefined) {
			continue;
		}
		assetOf.set(asset, [...(assetOf.get(asset) ?? []), coin.id]);
	}
	if (assetOf.size === 0) {
		return { rows: [], ok: false, problems: [] };
	}

	const problems: string[] = [];
	const catalogueResult = await http.getJson({
		url: `${API_BASE}/catalog/asset-metrics?metrics=${METRICS.join(',')}`,
	});
	const catalogueFailure = failed(catalogueResult);
	if (catalogueFailure !== null) {
		return {
			rows: [],
			ok: false,
			problems: [`catalogue: ${catalogueFailure}`],
		};
	}
	const catalogue = readCatalogue(catalogueResult.json);
	if (catalogue === null) {
		return { rows: [], ok: false, problems: ['catalogue: parse'] };
	}

	const values = new Map<string, AssetValues>();
	let worked = 0;
	for (const group of groupByAssets(new Set(assetOf.keys()), catalogue)) {
		const list = group.assets.map(encodeURIComponent).join(',');
		const result = await http.getJson({
			url: `${API_BASE}/timeseries/asset-metrics?assets=${list}&metrics=${group.metrics.join(',')}&frequency=1d&limit_per_asset=1&paging_from=end`,
		});
		const failure = failed(result);
		if (failure !== null) {
			problems.push(`${group.metrics.join('+')}: ${failure}`);
			continue;
		}
		if (!collectValues(result.json, group.metrics, values)) {
			problems.push(`${group.metrics.join('+')}: parse`);
			continue;
		}
		worked += 1;
	}

	const ts = isoSeconds(now());
	const rows: MarketRow[] = [];
	for (const [asset, ids] of assetOf) {
		const entry = values.get(asset);
		if (entry === undefined || Object.keys(entry.fields).length === 0) {
			continue;
		}
		for (const id of ids) {
			const row: MarketRow = {
				ts,
				coin: id,
				src: SRC_CODE.coinmetrics,
				...entry.fields,
			};
			if (entry.asOf !== undefined) {
				row.as_of = entry.asOf;
			}
			rows.push(row);
		}
	}
	return { rows, ok: worked > 0 && rows.length > 0, problems };
}
