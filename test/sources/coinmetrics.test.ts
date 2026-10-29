import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { coinmetricsAdapter } from '../../src/sources/coinmetrics.ts';
import type {
	CoinConfig,
	HttpClient,
	HttpRequest,
	HttpResult,
} from '../../src/types.ts';

function fixture(name: string): unknown {
	return JSON.parse(
		readFileSync(
			new URL(`../fixtures/coinmetrics/${name}`, import.meta.url),
			'utf8'
		)
	);
}

const page1 = fixture('page1.json');

const ASSETS: Record<string, string> = {
	BTC: 'btc',
	ETH: 'eth',
	BNB: 'bnb',
	XRP: 'xrp',
	SOL: 'sol',
	DOGE: 'doge',
	LINK: 'link',
	ADA: 'ada',
	XLM: 'xlm',
	LTC: 'ltc',
};

function coin(id: string, asset: string | undefined): CoinConfig {
	return {
		id,
		name: id,
		enabled: true,
		added: '2026-10-29',
		sources: asset === undefined ? {} : { coinmetrics_asset: asset },
	};
}

const allCoins = Object.entries(ASSETS).map(([id, asset]) => coin(id, asset));

// The fixture time is 2026-10-29T14:40:00Z. "now" is 42 seconds later.
const now = (): Date => new Date('2026-10-29T14:40:42.900Z');

/** Answers the calls in order. A call after the last answer fails the test. */
function fakeHttp(
	...results: HttpResult[]
): HttpClient & { requests: HttpRequest[] } {
	const requests: HttpRequest[] = [];
	return {
		requests,
		getJson(req: HttpRequest): Promise<HttpResult> {
			requests.push(req);
			const result = results[requests.length - 1];
			if (result === undefined) {
				throw new Error('Unexpected extra request');
			}
			return Promise.resolve(result);
		},
	};
}

test('all ten assets are read with one request', async () => {
	const http = fakeHttp({ status: 200, ms: 200, json: page1 });
	const run = await coinmetricsAdapter.fetchPrices(allCoins, http, now);

	assert.equal(http.requests.length, 1);
	const url = new URL(http.requests[0]?.url ?? '');
	assert.equal(url.origin, 'https://community-api.coinmetrics.io');
	assert.equal(url.pathname, '/v4/timeseries/asset-metrics');
	assert.equal(
		url.searchParams.get('assets'),
		'btc,eth,bnb,xrp,sol,doge,link,ada,xlm,ltc'
	);
	assert.equal(url.searchParams.get('metrics'), 'ReferenceRateUSD');
	assert.equal(url.searchParams.get('frequency'), '1m');
	assert.equal(url.searchParams.get('limit_per_asset'), '1');
	assert.equal(url.searchParams.get('paging_from'), 'end');

	assert.equal(run.src, 'cm');
	assert.equal(run.rows.length, 10);
	assert.deepEqual(run.log, {
		ts: '2026-10-29T14:40:42Z',
		src: 'cm',
		http: 200,
		ms: 200,
		coins_ok: 10,
		error: '',
	});
	assert.deepEqual(run.rows[0], {
		ts: '2026-10-29T14:40:42Z',
		coin: 'BTC',
		price: '100.00',
		src: 'cm',
		age_s: 42,
	});
});

test('rows follow the order of the coins, not the order of the response', async () => {
	const http = fakeHttp({ status: 200, ms: 1, json: page1 });
	const run = await coinmetricsAdapter.fetchPrices(
		[coin('XRP', 'xrp'), coin('BTC', 'btc')],
		http,
		now
	);
	assert.deepEqual(
		run.rows.map((r) => [r.coin, r.price]),
		[
			['XRP', '1.05'],
			['BTC', '100.00'],
		]
	);
});

test('the asset id is matched without regard to case', async () => {
	const http = fakeHttp({ status: 200, ms: 1, json: page1 });
	const run = await coinmetricsAdapter.fetchPrices(
		[coin('BTC', 'BTC')],
		http,
		now
	);
	assert.equal(
		new URL(http.requests[0]?.url ?? '').searchParams.get('assets'),
		'btc'
	);
	assert.equal(run.rows.length, 1);
});

test('nanosecond times are read and age_s is never negative', async () => {
	const json = {
		data: [
			{
				asset: 'btc',
				time: '2026-10-29T14:41:00.123456789Z',
				ReferenceRateUSD: '100.00',
			},
		],
	};
	const http = fakeHttp({ status: 200, ms: 1, json });
	const run = await coinmetricsAdapter.fetchPrices(
		[coin('BTC', 'btc')],
		http,
		now
	);
	assert.equal(run.rows[0]?.age_s, 0);
});

test('a bad time gives age_s null and keeps the row', async () => {
	const json = {
		data: [{ asset: 'btc', time: 'noon', ReferenceRateUSD: '100.00' }],
	};
	const http = fakeHttp({ status: 200, ms: 1, json });
	const run = await coinmetricsAdapter.fetchPrices(
		[coin('BTC', 'btc')],
		http,
		now
	);
	assert.equal(run.rows[0]?.age_s, null);
	assert.equal(run.log.error, '');
});

test('the newest sample of an asset wins', async () => {
	const json = {
		data: [
			{
				asset: 'btc',
				time: '2026-10-29T14:39:00.000000000Z',
				ReferenceRateUSD: '99.00',
			},
			{
				asset: 'btc',
				time: '2026-10-29T14:40:00.000000000Z',
				ReferenceRateUSD: '100.00',
			},
			{
				asset: 'btc',
				time: '2026-10-29T14:38:00.000000000Z',
				ReferenceRateUSD: '98.00',
			},
		],
	};
	const http = fakeHttp({ status: 200, ms: 1, json });
	const run = await coinmetricsAdapter.fetchPrices(
		[coin('BTC', 'btc')],
		http,
		now
	);
	assert.equal(run.rows[0]?.price, '100.00');
});

test('an asset missing in the response is unmapped and the others stay', async () => {
	const json = {
		data: (page1 as { data: Array<{ asset: string }> }).data.filter(
			(item) => item.asset !== 'xlm'
		),
	};
	const http = fakeHttp({ status: 200, ms: 90, json });
	const run = await coinmetricsAdapter.fetchPrices(allCoins, http, now);
	assert.equal(run.rows.length, 9);
	assert.ok(run.rows.every((row) => row.coin !== 'XLM'));
	assert.equal(run.log.http, 200);
	assert.equal(run.log.coins_ok, 9);
	assert.equal(run.log.error, 'unmapped');
	assert.equal(http.requests.length, 1);
});

test('a coin without a Coin Metrics id is unmapped and is not requested', async () => {
	const http = fakeHttp({ status: 200, ms: 1, json: page1 });
	const run = await coinmetricsAdapter.fetchPrices(
		[coin('BTC', 'btc'), coin('XYZ', undefined)],
		http,
		now
	);
	assert.equal(run.rows.length, 1);
	assert.equal(run.log.error, 'unmapped');
	assert.equal(
		new URL(http.requests[0]?.url ?? '').searchParams.get('assets'),
		'btc'
	);
});

test('a null or missing value is a parse error for that coin', async () => {
	const json = {
		data: [
			{
				asset: 'btc',
				time: '2026-10-29T14:40:00.000000000Z',
				ReferenceRateUSD: null,
			},
			{ asset: 'eth', time: '2026-10-29T14:40:00.000000000Z' },
			{
				asset: 'sol',
				time: '2026-10-29T14:40:00.000000000Z',
				ReferenceRateUSD: '40.1',
			},
		],
	};
	const http = fakeHttp({ status: 200, ms: 1, json });
	const run = await coinmetricsAdapter.fetchPrices(
		[coin('BTC', 'btc'), coin('ETH', 'eth'), coin('SOL', 'sol')],
		http,
		now
	);
	assert.deepEqual(
		run.rows.map((r) => r.coin),
		['SOL']
	);
	assert.equal(run.log.error, 'parse');
	assert.equal(run.log.coins_ok, 1);
});

test('a next page is read when assets are still missing', async () => {
	const http = fakeHttp(
		{ status: 200, ms: 100, json: fixture('paged-first.json') },
		{ status: 200, ms: 80, json: fixture('paged-second.json') }
	);
	const run = await coinmetricsAdapter.fetchPrices(
		[coin('BTC', 'btc'), coin('ETH', 'eth'), coin('SOL', 'sol')],
		http,
		now
	);
	assert.equal(http.requests.length, 2);
	assert.equal(
		http.requests[1]?.url,
		'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?next_page_token=synthetic-token'
	);
	assert.deepEqual(
		run.rows.map((r) => [r.coin, r.age_s]),
		[
			['BTC', 42],
			['ETH', 42],
			['SOL', 102],
		]
	);
	assert.equal(run.log.ms, 180);
	assert.equal(run.log.http, 200);
	assert.equal(run.log.error, '');
});

test('a next page is not read when every asset is already there', async () => {
	const http = fakeHttp({
		status: 200,
		ms: 100,
		json: fixture('paged-first.json'),
	});
	const run = await coinmetricsAdapter.fetchPrices(
		[coin('BTC', 'btc'), coin('ETH', 'eth')],
		http,
		now
	);
	assert.equal(http.requests.length, 1);
	assert.equal(run.rows.length, 2);
});

test('a next page on another host is not followed', async () => {
	const first = fixture('paged-first.json') as Record<string, unknown>;
	const json = { ...first, next_page_url: 'https://evil.example/v4/x' };
	const http = fakeHttp({ status: 200, ms: 1, json });
	const run = await coinmetricsAdapter.fetchPrices(
		[coin('BTC', 'btc'), coin('SOL', 'sol')],
		http,
		now
	);
	assert.equal(http.requests.length, 1);
	assert.equal(run.rows.length, 1);
	assert.equal(run.log.error, 'unmapped');
});

test('paging stops after three pages', async () => {
	const endless = {
		data: [],
		next_page_url:
			'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?next_page_token=again',
	};
	const http = fakeHttp(
		{ status: 200, ms: 1, json: endless },
		{ status: 200, ms: 1, json: endless },
		{ status: 200, ms: 1, json: endless }
	);
	const run = await coinmetricsAdapter.fetchPrices(
		[coin('BTC', 'btc')],
		http,
		now
	);
	assert.equal(http.requests.length, 3);
	assert.deepEqual(run.rows, []);
	assert.equal(run.log.error, 'unmapped');
});

test('a failure on the second page keeps the rows of the first page', async () => {
	const http = fakeHttp(
		{ status: 200, ms: 100, json: fixture('paged-first.json') },
		{ status: 429, ms: 20, error: 'http_429' }
	);
	const run = await coinmetricsAdapter.fetchPrices(
		[coin('BTC', 'btc'), coin('SOL', 'sol')],
		http,
		now
	);
	assert.deepEqual(
		run.rows.map((r) => r.coin),
		['BTC']
	);
	assert.equal(run.log.http, 429);
	assert.equal(run.log.ms, 120);
	assert.equal(run.log.error, 'http_429');
	assert.equal(run.log.coins_ok, 1);
});

test('HTTP 429 gives no rows and the http_429 code', async () => {
	const http = fakeHttp({ status: 429, ms: 30, error: 'http_429' });
	const run = await coinmetricsAdapter.fetchPrices(allCoins, http, now);
	assert.deepEqual(run.rows, []);
	assert.deepEqual(run.log, {
		ts: '2026-10-29T14:40:42Z',
		src: 'cm',
		http: 429,
		ms: 30,
		coins_ok: 0,
		error: 'http_429',
	});
});

test('a timeout gives status 0 and the timeout code', async () => {
	const http = fakeHttp({ status: 0, ms: 10000, error: 'timeout' });
	const run = await coinmetricsAdapter.fetchPrices(allCoins, http, now);
	assert.deepEqual(run.rows, []);
	assert.equal(run.log.http, 0);
	assert.equal(run.log.ms, 10000);
	assert.equal(run.log.error, 'timeout');
});

test('another HTTP error gives http_other', async () => {
	const http = fakeHttp({ status: 400, ms: 40, error: 'http_other' });
	const run = await coinmetricsAdapter.fetchPrices(allCoins, http, now);
	assert.equal(run.log.http, 400);
	assert.equal(run.log.error, 'http_other');
	assert.equal(run.log.coins_ok, 0);
});

test('a status outside 2xx without an error code is still an error', async () => {
	const http = fakeHttp({ status: 404, ms: 40 });
	const run = await coinmetricsAdapter.fetchPrices(allCoins, http, now);
	assert.equal(run.log.http, 404);
	assert.equal(run.log.error, 'http_other');
});

test('a client parse error is passed on', async () => {
	const http = fakeHttp({ status: 200, ms: 10, error: 'parse' });
	const run = await coinmetricsAdapter.fetchPrices(allCoins, http, now);
	assert.equal(run.log.http, 200);
	assert.equal(run.log.error, 'parse');
	assert.deepEqual(run.rows, []);
});

test('a body without a data list is a parse error', async () => {
	for (const json of [
		{ error: { type: 'bad_parameter' } },
		{ data: 'x' },
		[],
		'text',
		null,
		undefined,
	]) {
		const http = fakeHttp({ status: 200, ms: 10, json });
		const run = await coinmetricsAdapter.fetchPrices(allCoins, http, now);
		assert.deepEqual(run.rows, []);
		assert.equal(run.log.error, 'parse');
		assert.equal(run.log.http, 200);
	}
});

test('data items of the wrong shape are skipped', async () => {
	const json = {
		data: [
			null,
			'x',
			{ time: 'x' },
			...(page1 as { data: unknown[] }).data,
		],
	};
	const http = fakeHttp({ status: 200, ms: 1, json });
	const run = await coinmetricsAdapter.fetchPrices(allCoins, http, now);
	assert.equal(run.rows.length, 10);
});

test('with no assets there is no request', async () => {
	const http = fakeHttp({ status: 200, ms: 1, json: page1 });
	const run = await coinmetricsAdapter.fetchPrices(
		[coin('XYZ', undefined)],
		http,
		now
	);
	assert.equal(http.requests.length, 0);
	assert.deepEqual(run.rows, []);
	assert.equal(run.log.error, 'unmapped');
	const none = await coinmetricsAdapter.fetchPrices([], http, now);
	assert.equal(http.requests.length, 0);
	assert.equal(none.log.error, '');
});

test('the adapter identifies itself', () => {
	assert.equal(coinmetricsAdapter.id, 'coinmetrics');
	assert.equal(coinmetricsAdapter.src, 'cm');
});
