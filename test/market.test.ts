import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { appendMarketRows, marketPath, readMarketRows } from '../src/csv.ts';
import {
	dailyDue,
	dailyStored,
	emptyMarketState,
	readMarketState,
	writeMarketState,
} from '../src/market-state.ts';
import { bitstampAdapter } from '../src/sources/bitstamp.ts';
import { coinbaseAdapter } from '../src/sources/coinbase.ts';
import { fetchDailyMetrics } from '../src/sources/coinmetrics-daily.ts';
import { krakenAdapter } from '../src/sources/kraken.ts';
import type {
	CoinConfig,
	HttpClient,
	HttpRequest,
	HttpResult,
} from '../src/types.ts';

function readFixture(name: string): unknown {
	return JSON.parse(
		readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
	) as unknown;
}

function coin(id: string, sources: CoinConfig['sources']): CoinConfig {
	return { id, name: id, enabled: true, added: '2026-10-29', sources };
}

function ok(json: unknown): HttpResult {
	return { status: 200, ms: 5, json };
}

const NOW = (): Date => new Date('2026-10-29T14:03:12.500Z');

describe('the exchange adapters give bid, ask and 24 hour volume', () => {
	test('Kraken reads bid, ask and the 24 hour volume of the entry', async () => {
		const client: HttpClient = {
			getJson(req: HttpRequest): Promise<HttpResult> {
				const endpoint = new URL(req.url).pathname.split('/').pop();
				return Promise.resolve(
					ok(
						readFixture(
							endpoint === 'AssetPairs'
								? 'kraken/asset-pairs.json'
								: 'kraken/ticker.json'
						)
					)
				);
			},
		};
		const run = await krakenAdapter.fetchPrices(
			[coin('BTC', { kraken_pair: 'XBTUSD' })],
			client,
			NOW
		);
		assert.deepEqual(run.market, [
			{
				ts: '2026-10-29T14:03:12Z',
				coin: 'BTC',
				src: 'kr',
				bid: '100.00000',
				ask: '100.00000',
				volume: '2',
			},
		]);
	});

	test('Coinbase reads bid, ask and volume, and gives none when the ticker has none', async () => {
		const ticker = readFixture('coinbase/ticker.json') as Record<
			string,
			unknown
		>;
		const client = (body: unknown): HttpClient => ({
			getJson: () => Promise.resolve(ok(body)),
		});
		const btc = [coin('BTC', { coinbase_product: 'BTC-USD' })];
		const run = await coinbaseAdapter.fetchPrices(btc, client(ticker), NOW);
		assert.deepEqual(run.market, [
			{
				ts: '2026-10-29T14:03:12Z',
				coin: 'BTC',
				src: 'cb',
				bid: '99.98',
				ask: '100.02',
				volume: '1234.5',
			},
		]);
		const bare = { price: ticker.price, time: ticker.time };
		const without = await coinbaseAdapter.fetchPrices(
			btc,
			client(bare),
			NOW
		);
		assert.equal(without.rows.length, 1);
		assert.equal('market' in without, false);
	});

	test('Bitstamp reads bid, ask and volume of the market', async () => {
		const client: HttpClient = {
			getJson: () =>
				Promise.resolve(ok(readFixture('bitstamp/ticker.json'))),
		};
		const run = await bitstampAdapter.fetchPrices(
			[coin('BTC', { bitstamp_market: 'btcusd' })],
			client,
			NOW
		);
		assert.deepEqual(run.market, [
			{
				ts: '2026-10-29T14:03:12Z',
				coin: 'BTC',
				src: 'bs',
				bid: '99.99',
				ask: '100.01',
				volume: '10.5',
			},
		]);
	});
});

describe('market files', () => {
	let dir = '';

	before(async () => {
		dir = await mkdtemp(join(tmpdir(), 'git-coin-market-'));
	});

	after(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test('the market file sits next to the price file of the same day', () => {
		assert.equal(
			marketPath('/d', 'btc', '2026-10-29T14:03:12Z'),
			'/d/data/raw/2026/10/29/BTC.market.csv'
		);
	});

	test('rows are appended with a header, empty cells for missing fields, and read back', async () => {
		const ts = '2026-10-29T14:03:12Z';
		const written = await appendMarketRows(dir, [
			{
				ts,
				coin: 'BTC',
				src: 'kr',
				bid: '99.9',
				ask: '100.1',
				volume: '20',
			},
			{
				ts: '2026-10-30T00:20:00Z',
				coin: 'BTC',
				src: 'cm',
				market_cap: '1.5e12',
				volume_usd: '13260626425.3036',
				as_of: '2026-10-29',
			},
		]);
		assert.equal(written, 2);
		const first = await readFile(marketPath(dir, 'BTC', ts), 'utf8');
		assert.equal(
			first,
			[
				'ts,src,bid,ask,volume,market_cap,volume_usd,supply,tx_count,active_addresses,hash_rate,as_of',
				`${ts},kr,99.9,100.1,20,,,,,,,`,
				'',
			].join('\n')
		);
		assert.deepEqual(
			await readMarketRows(
				marketPath(dir, 'BTC', '2026-10-30T00:20:00Z')
			),
			[
				{
					ts: '2026-10-30T00:20:00Z',
					coin: 'BTC',
					src: 'cm',
					market_cap: '1.5e12',
					volume_usd: '13260626425.3036',
					as_of: '2026-10-29',
				},
			]
		);
		// Prices live in their own file, which this module never creates
		await assert.rejects(stat(join(dir, 'data/raw/2026/10/29/BTC.csv')));
		// A second write only adds a line
		await appendMarketRows(dir, [
			{ ts: '2026-10-29T14:18:12Z', coin: 'BTC', src: 'kr', bid: '1' },
		]);
		assert.equal(
			(await readMarketRows(marketPath(dir, 'BTC', ts))).length,
			2
		);
	});

	test('a field that is not a plain number is left empty, and a row with no number is skipped', async () => {
		const ts = '2026-10-31T01:00:00Z';
		const written = await appendMarketRows(dir, [
			{
				ts,
				coin: 'ETH',
				src: 'cb',
				bid: '1,5',
				ask: '2.5',
				volume: '-3',
			},
			{ ts, coin: 'ETH', src: 'bs', bid: 'NaN', ask: '\n9' },
		]);
		assert.equal(written, 1);
		const rows = await readMarketRows(marketPath(dir, 'ETH', ts));
		assert.deepEqual(rows, [{ ts, coin: 'ETH', src: 'cb', ask: '2.5' }]);
	});

	test('a missing file reads as empty, and malformed lines are skipped', async () => {
		assert.deepEqual(
			await readMarketRows(join(dir, 'nothing.market.csv')),
			[]
		);
		const file = join(dir, 'XRP.market.csv');
		await writeFile(
			file,
			[
				'ts,src,bid,ask,volume,market_cap,volume_usd,supply,tx_count,active_addresses,hash_rate,as_of',
				'not a line',
				'2026-10-29T14:03:12Z,zz,1,,,,,,,,,',
				'2026-10-29T14:03:12Z,kr,1,2,3,,,,,,,',
				'',
			].join('\n')
		);
		assert.deepEqual(await readMarketRows(file), [
			{
				ts: '2026-10-29T14:03:12Z',
				coin: 'XRP',
				src: 'kr',
				bid: '1',
				ask: '2',
				volume: '3',
			},
		]);
	});
});

describe('market state', () => {
	let dir = '';

	before(async () => {
		dir = await mkdtemp(join(tmpdir(), 'git-coin-market-state-'));
	});

	after(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test('a missing or broken file counts as never updated', async () => {
		assert.deepEqual(
			await readMarketState(join(dir, 'missing.json')),
			emptyMarketState()
		);
		const broken = join(dir, 'broken.json');
		await writeFile(broken, '{ not json');
		assert.deepEqual(await readMarketState(broken), emptyMarketState());
		const odd = join(dir, 'odd.json');
		await writeFile(odd, JSON.stringify({ daily_updated_at: 5 }));
		assert.deepEqual(await readMarketState(odd), emptyMarketState());
	});

	test('the state is written and read back', async () => {
		const file = join(dir, 'state', 'market.json');
		await writeMarketState(
			file,
			dailyStored(new Date('2026-10-31T00:20:00Z'))
		);
		assert.deepEqual(await readMarketState(file), {
			schema_version: 1,
			daily_updated_at: '2026-10-31T00:20:00Z',
		});
	});

	test('the daily update is due when never stored or after 24 hours', () => {
		assert.equal(dailyDue(emptyMarketState(), new Date()), true);
		const state = dailyStored(new Date('2026-10-31T00:20:00Z'));
		assert.equal(dailyDue(state, new Date('2026-10-31T00:35:00Z')), false);
		assert.equal(dailyDue(state, new Date('2026-11-01T00:19:59Z')), false);
		assert.equal(dailyDue(state, new Date('2026-11-01T00:20:00Z')), true);
	});
});

describe('fetchDailyMetrics', () => {
	const DAY = '2026-10-30T00:00:00.000000000Z';
	const CATALOGUE = {
		data: [
			{
				metric: 'CapMrktEstUSD',
				frequencies: [
					{ frequency: '1d', assets: ['btc', 'eth', 'zil'] },
				],
			},
			{
				metric: 'volume_reported_spot_usd_1d',
				frequencies: [
					{ frequency: '1d', assets: ['btc', 'eth', 'zil'] },
				],
			},
			{
				metric: 'SplyCur',
				frequencies: [{ frequency: '1d', assets: ['btc'] }],
			},
			{
				metric: 'HashRate',
				frequencies: [{ frequency: '1h', assets: ['btc'] }],
			},
		],
	};
	const VALUES: Record<string, Record<string, string>> = {
		btc: {
			CapMrktEstUSD: '1550316466975.2038650805',
			volume_reported_spot_usd_1d: '13260626425.3036',
			SplyCur: '20105365.5',
		},
		eth: {
			CapMrktEstUSD: '400000000000.5',
			volume_reported_spot_usd_1d: '9000000000.25',
		},
		zil: {
			CapMrktEstUSD: '38475580.26',
			volume_reported_spot_usd_1d: '2481837.65',
		},
	};
	const COINS = [
		coin('BTC', { coinmetrics_asset: 'btc' }),
		coin('ETH', { coinmetrics_asset: 'ETH' }),
		coin('ZIL', { coinmetrics_asset: 'zil' }),
		coin('NOCM', { kraken_pair: 'NOCMUSD' }),
	];

	function fakeClient(
		options: { catalogue?: HttpResult; failMetric?: string } = {}
	): HttpClient & { urls: string[] } {
		const urls: string[] = [];
		return {
			urls,
			getJson(req: HttpRequest): Promise<HttpResult> {
				urls.push(req.url);
				const url = new URL(req.url);
				if (url.pathname.endsWith('/catalog/asset-metrics')) {
					return Promise.resolve(options.catalogue ?? ok(CATALOGUE));
				}
				const metrics = (url.searchParams.get('metrics') ?? '').split(
					','
				);
				if (
					options.failMetric !== undefined &&
					metrics.includes(options.failMetric)
				) {
					return Promise.resolve({
						status: 403,
						ms: 5,
						error: 'http_other',
					});
				}
				const assets = (url.searchParams.get('assets') ?? '').split(
					','
				);
				return Promise.resolve(
					ok({
						data: assets.map((asset) => {
							const record: Record<string, string> = {
								asset,
								time: DAY,
							};
							for (const metric of metrics) {
								record[metric] = VALUES[asset]?.[metric] ?? '';
							}
							return record;
						}),
					})
				);
			},
		};
	}

	test('asks each metric only for the assets that have it and builds one row per coin', async () => {
		const client = fakeClient();
		const result = await fetchDailyMetrics(COINS, client, NOW);

		assert.equal(result.ok, true);
		assert.deepEqual(result.problems, []);
		const base = 'https://community-api.coinmetrics.io/v4';
		assert.deepEqual(client.urls, [
			`${base}/catalog/asset-metrics?metrics=CapMrktEstUSD,volume_reported_spot_usd_1d,SplyCur,TxCnt,AdrActCnt,HashRate`,
			`${base}/timeseries/asset-metrics?assets=btc,eth,zil&metrics=CapMrktEstUSD,volume_reported_spot_usd_1d&frequency=1d&limit_per_asset=1&paging_from=end`,
			`${base}/timeseries/asset-metrics?assets=btc&metrics=SplyCur&frequency=1d&limit_per_asset=1&paging_from=end`,
		]);
		const ts = '2026-10-29T14:03:12Z';
		assert.deepEqual(result.rows, [
			{
				ts,
				coin: 'BTC',
				src: 'cm',
				market_cap: '1550316466975.2038650805',
				volume_usd: '13260626425.3036',
				supply: '20105365.5',
				as_of: '2026-10-30',
			},
			{
				ts,
				coin: 'ETH',
				src: 'cm',
				market_cap: '400000000000.5',
				volume_usd: '9000000000.25',
				as_of: '2026-10-30',
			},
			{
				ts,
				coin: 'ZIL',
				src: 'cm',
				market_cap: '38475580.26',
				volume_usd: '2481837.65',
				as_of: '2026-10-30',
			},
		]);
	});

	test('a failed request leaves its metrics out and is reported without response text', async () => {
		const result = await fetchDailyMetrics(
			COINS,
			fakeClient({ failMetric: 'SplyCur' }),
			NOW
		);
		assert.equal(result.ok, true);
		assert.deepEqual(result.problems, ['SplyCur: http_other']);
		assert.equal(result.rows[0]?.supply, undefined);
		assert.equal(result.rows[0]?.market_cap, '1550316466975.2038650805');
	});

	test('a refused catalogue stops before any metric request', async () => {
		const client = fakeClient({
			catalogue: { status: 403, ms: 5, error: 'http_other' },
		});
		const result = await fetchDailyMetrics(COINS, client, NOW);
		assert.deepEqual(result, {
			rows: [],
			ok: false,
			problems: ['catalogue: http_other'],
		});
		assert.equal(client.urls.length, 1);
	});

	test('a catalogue of the wrong shape is a parse problem', async () => {
		const result = await fetchDailyMetrics(
			COINS,
			fakeClient({ catalogue: ok({ nothing: true }) }),
			NOW
		);
		assert.deepEqual(result.problems, ['catalogue: parse']);
		assert.equal(result.ok, false);
	});

	test('coins without a Coin Metrics asset make no request', async () => {
		const client = fakeClient();
		const result = await fetchDailyMetrics(
			[coin('NOCM', { kraken_pair: 'NOCMUSD' })],
			client,
			NOW
		);
		assert.deepEqual(result, { rows: [], ok: false, problems: [] });
		assert.equal(client.urls.length, 0);
	});

	test('an asset that is not in the catalogue gets no row and no request', async () => {
		const client = fakeClient();
		const result = await fetchDailyMetrics(
			[coin('NEW', { coinmetrics_asset: 'newcoin' })],
			client,
			NOW
		);
		assert.equal(result.ok, false);
		assert.deepEqual(result.rows, []);
		assert.equal(client.urls.length, 1);
	});
});
