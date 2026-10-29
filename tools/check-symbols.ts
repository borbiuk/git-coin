// Checks the ids of every enabled coin against the live catalogues of the four sources (ADR 0007 D4.2).
// Uses the network, so it is not part of the tests or of `npm run check`.
// Run: node tools/check-symbols.ts [--config config/coins.json]
// Exit code 1 when an id is missing, a catalogue cannot be read, or the config is invalid.

import { parseArgs } from 'node:util';

import { loadConfig } from '../src/config.ts';
import type { CoinSources, SourceId } from '../src/types.ts';

const CATALOGUE_URL: Record<SourceId, string> = {
	kraken: 'https://api.kraken.com/0/public/AssetPairs',
	coinbase: 'https://api.exchange.coinbase.com/products',
	bitstamp: 'https://www.bitstamp.net/api/v2/trading-pairs-info/',
	coinmetrics:
		'https://community-api.coinmetrics.io/v4/catalog/asset-metrics?metrics=ReferenceRateUSD',
};

const SOURCE_FIELD: Record<SourceId, keyof CoinSources> = {
	kraken: 'kraken_pair',
	coinbase: 'coinbase_product',
	bitstamp: 'bitstamp_market',
	coinmetrics: 'coinmetrics_asset',
};

function records(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) {
		throw new Error('unexpected catalogue shape');
	}
	return value.filter(
		(item): item is Record<string, unknown> =>
			typeof item === 'object' && item !== null
	);
}

function field(value: unknown, key: string): unknown {
	if (typeof value !== 'object' || value === null) {
		throw new Error('unexpected catalogue shape');
	}
	return (value as Record<string, unknown>)[key];
}

/** The ids a source lists as tradable (or, for Coin Metrics, as priced every minute). */
export function usableIds(source: SourceId, json: unknown): Set<string> {
	const ids = new Set<string>();
	if (source === 'kraken') {
		const result = field(json, 'result');
		if (typeof result !== 'object' || result === null) {
			throw new Error('unexpected catalogue shape');
		}
		for (const pair of Object.values(result)) {
			if (
				field(pair, 'status') === 'online' &&
				typeof field(pair, 'altname') === 'string'
			) {
				ids.add(field(pair, 'altname') as string);
			}
		}
	} else if (source === 'coinbase') {
		for (const product of records(json)) {
			if (
				product.status === 'online' &&
				product.trading_disabled !== true &&
				typeof product.id === 'string'
			) {
				ids.add(product.id);
			}
		}
	} else if (source === 'bitstamp') {
		for (const market of records(json)) {
			if (
				market.trading === 'Enabled' &&
				typeof market.url_symbol === 'string'
			) {
				ids.add(market.url_symbol);
			}
		}
	} else {
		for (const metric of records(field(json, 'data'))) {
			for (const frequency of records(metric.frequencies)) {
				if (frequency.frequency !== '1m') {
					continue;
				}
				const assets = Array.isArray(frequency.assets)
					? (frequency.assets as unknown[])
					: [];
				for (const asset of assets) {
					if (typeof asset === 'string') {
						ids.add(asset);
					}
				}
			}
		}
	}
	return ids;
}

async function fetchCatalogue(source: SourceId): Promise<Set<string>> {
	const response = await fetch(CATALOGUE_URL[source], {
		headers: {
			'User-Agent':
				'git-coin-check-symbols (+https://github.com/borbiuk/git-coin)',
		},
		signal: AbortSignal.timeout(20_000),
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}
	return usableIds(source, await response.json());
}

async function main(): Promise<number> {
	const { values } = parseArgs({
		options: { config: { type: 'string', default: 'config/coins.json' } },
	});
	const config = await loadConfig(values.config);

	const catalogues = new Map<SourceId, Set<string> | string>();
	for (const source of config.settings.stored_sources) {
		try {
			catalogues.set(source, await fetchCatalogue(source));
		} catch (error) {
			const reason =
				error instanceof Error ? error.message : 'unknown error';
			catalogues.set(source, `catalogue unavailable (${reason})`);
		}
	}

	let problems = 0;
	const rows: string[][] = [['coin', ...config.settings.stored_sources]];
	for (const item of config.coins.filter((coin) => coin.enabled)) {
		const cells = [item.id];
		for (const source of config.settings.stored_sources) {
			const id = item.sources[SOURCE_FIELD[source]] ?? '';
			const catalogue = catalogues.get(source);
			if (typeof catalogue === 'string' || catalogue === undefined) {
				cells.push(`${id} ERROR`);
				problems += 1;
			} else if (catalogue.has(id)) {
				cells.push(`${id} ok`);
			} else {
				cells.push(`${id} MISSING`);
				problems += 1;
			}
		}
		rows.push(cells);
	}

	const widths = rows[0].map((_, column) =>
		Math.max(...rows.map((row) => row[column].length))
	);
	for (const row of rows) {
		console.log(
			row.map((cell, column) => cell.padEnd(widths[column])).join('  ')
		);
	}
	for (const [source, catalogue] of catalogues) {
		if (typeof catalogue === 'string') {
			console.error(`${source}: ${catalogue}`);
		}
	}
	if (problems > 0) {
		console.error(`${problems} id(s) are missing or could not be checked.`);
		return 1;
	}
	console.log('All ids are listed.');
	return 0;
}

if (import.meta.main) {
	try {
		process.exitCode = await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
