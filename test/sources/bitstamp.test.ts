import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { bitstampAdapter } from '../../src/sources/bitstamp.ts';
import type {
	CoinConfig,
	HttpClient,
	HttpRequest,
	HttpResult,
} from '../../src/types.ts';

const ticker: unknown = JSON.parse(
	readFileSync(
		new URL('../fixtures/bitstamp/ticker.json', import.meta.url),
		'utf8'
	)
);

const MARKETS: Record<string, string> = {
	BTC: 'btcusd',
	ETH: 'ethusd',
	BNB: 'bnbusd',
	XRP: 'xrpusd',
	SOL: 'solusd',
	DOGE: 'dogeusd',
	LINK: 'linkusd',
	ADA: 'adausd',
	XLM: 'xlmusd',
	LTC: 'ltcusd',
};

function coin(id: string, market: string | undefined): CoinConfig {
	return {
		id,
		name: id,
		enabled: true,
		added: '2026-10-29',
		sources: market === undefined ? {} : { bitstamp_market: market },
	};
}

const allCoins = Object.entries(MARKETS).map(([id, market]) =>
	coin(id, market)
);

// The fixture timestamps are 1793284845 (2026-10-29T14:40:45Z). "now" is 3 seconds later.
const NOW_MS = 1793284848_000;
const now = (): Date => new Date(NOW_MS);

function fakeHttp(
	result: HttpResult
): HttpClient & { requests: HttpRequest[] } {
	const requests: HttpRequest[] = [];
	return {
		requests,
		getJson(req: HttpRequest): Promise<HttpResult> {
			requests.push(req);
			return Promise.resolve(result);
		},
	};
}

test('all ten coins are read with one request', async () => {
	const http = fakeHttp({ status: 200, ms: 120, json: ticker });
	const run = await bitstampAdapter.fetchPrices(allCoins, http, now);

	assert.equal(http.requests.length, 1);
	assert.equal(
		http.requests[0]?.url,
		'https://www.bitstamp.net/api/v2/ticker/'
	);
	assert.equal(run.src, 'bs');
	assert.equal(run.rows.length, 10);
	assert.deepEqual(run.log, {
		ts: '2026-10-29T14:40:48Z',
		src: 'bs',
		http: 200,
		ms: 120,
		coins_ok: 10,
		error: '',
	});
	assert.deepEqual(run.rows[0], {
		ts: '2026-10-29T14:40:48Z',
		coin: 'BTC',
		price: '100.00',
		src: 'bs',
		age_s: 3,
	});
});

test('the price string is kept as the source gave it', async () => {
	const http = fakeHttp({ status: 200, ms: 1, json: ticker });
	const run = await bitstampAdapter.fetchPrices(allCoins, http, now);
	const prices = Object.fromEntries(run.rows.map((r) => [r.coin, r.price]));
	assert.equal(prices.ETH, '20.50');
	assert.equal(prices.DOGE, '0.105');
	assert.equal(prices.LTC, '58.30');
});

test('the USD market is picked, not the EUR or USDT market of the same coin', async () => {
	const http = fakeHttp({ status: 200, ms: 1, json: ticker });
	const run = await bitstampAdapter.fetchPrices(
		[coin('BTC', 'btcusd')],
		http,
		now
	);
	assert.equal(run.rows.length, 1);
	assert.equal(run.rows[0]?.price, '100.00');
});

test('the market id matches the pair after normalising case and the slash', async () => {
	const http = fakeHttp({ status: 200, ms: 1, json: ticker });
	const run = await bitstampAdapter.fetchPrices(
		[coin('BTC', 'BTC/USD'), coin('ETH', 'EthUsd')],
		http,
		now
	);
	assert.deepEqual(
		run.rows.map((r) => r.coin),
		['BTC', 'ETH']
	);
});

test('age_s is never negative', async () => {
	const http = fakeHttp({ status: 200, ms: 1, json: ticker });
	const early = (): Date => new Date(1793284800_000);
	const run = await bitstampAdapter.fetchPrices(allCoins, http, early);
	assert.ok(run.rows.every((row) => row.age_s === 0));
});

test('a bad timestamp gives age_s null and keeps the row', async () => {
	const json = [
		{ pair: 'BTC/USD', last: '100.00', timestamp: 'soon' },
		{ pair: 'ETH/USD', last: '20.50' },
	];
	const http = fakeHttp({ status: 200, ms: 1, json });
	const run = await bitstampAdapter.fetchPrices(
		[coin('BTC', 'btcusd'), coin('ETH', 'ethusd')],
		http,
		now
	);
	assert.deepEqual(
		run.rows.map((r) => r.age_s),
		[null, null]
	);
	assert.equal(run.log.error, '');
});

test('a coin missing in the response is unmapped and the others stay', async () => {
	const http = fakeHttp({ status: 200, ms: 50, json: ticker });
	const run = await bitstampAdapter.fetchPrices(
		[coin('BTC', 'btcusd'), coin('TON', 'tonusd')],
		http,
		now
	);
	assert.deepEqual(
		run.rows.map((r) => r.coin),
		['BTC']
	);
	assert.equal(run.log.http, 200);
	assert.equal(run.log.coins_ok, 1);
	assert.equal(run.log.error, 'unmapped');
});

test('a coin without a Bitstamp id is unmapped and is not requested by name', async () => {
	const http = fakeHttp({ status: 200, ms: 1, json: ticker });
	const run = await bitstampAdapter.fetchPrices(
		[coin('BTC', 'btcusd'), coin('XYZ', undefined)],
		http,
		now
	);
	assert.equal(run.rows.length, 1);
	assert.equal(run.log.error, 'unmapped');
});

test('an entry without a usable last price is a parse error for that coin', async () => {
	const json = [
		{ pair: 'BTC/USD', last: 100, timestamp: '1793284845' },
		{ pair: 'ETH/USD', last: '20.50', timestamp: '1793284845' },
	];
	const http = fakeHttp({ status: 200, ms: 1, json });
	const run = await bitstampAdapter.fetchPrices(
		[coin('BTC', 'btcusd'), coin('ETH', 'ethusd')],
		http,
		now
	);
	assert.deepEqual(
		run.rows.map((r) => r.coin),
		['ETH']
	);
	assert.equal(run.log.error, 'parse');
	assert.equal(run.log.coins_ok, 1);
});

test('HTTP 429 gives no rows and the http_429 code', async () => {
	const http = fakeHttp({ status: 429, ms: 30, error: 'http_429' });
	const run = await bitstampAdapter.fetchPrices(allCoins, http, now);
	assert.deepEqual(run.rows, []);
	assert.deepEqual(run.log, {
		ts: '2026-10-29T14:40:48Z',
		src: 'bs',
		http: 429,
		ms: 30,
		coins_ok: 0,
		error: 'http_429',
	});
});

test('a timeout gives status 0 and the timeout code', async () => {
	const http = fakeHttp({ status: 0, ms: 10000, error: 'timeout' });
	const run = await bitstampAdapter.fetchPrices(allCoins, http, now);
	assert.deepEqual(run.rows, []);
	assert.equal(run.log.http, 0);
	assert.equal(run.log.ms, 10000);
	assert.equal(run.log.error, 'timeout');
});

test('another HTTP error gives http_other', async () => {
	const http = fakeHttp({ status: 503, ms: 40, error: 'http_other' });
	const run = await bitstampAdapter.fetchPrices(allCoins, http, now);
	assert.equal(run.log.http, 503);
	assert.equal(run.log.error, 'http_other');
	assert.equal(run.log.coins_ok, 0);
});

test('a status outside 2xx without an error code is still an error', async () => {
	const http = fakeHttp({ status: 404, ms: 40 });
	const run = await bitstampAdapter.fetchPrices(allCoins, http, now);
	assert.equal(run.log.http, 404);
	assert.equal(run.log.error, 'http_other');
});

test('a client parse error is passed on', async () => {
	const http = fakeHttp({ status: 200, ms: 10, error: 'parse' });
	const run = await bitstampAdapter.fetchPrices(allCoins, http, now);
	assert.equal(run.log.http, 200);
	assert.equal(run.log.error, 'parse');
	assert.deepEqual(run.rows, []);
});

test('a body that is not a list is a parse error', async () => {
	for (const json of [{ error: 'nope' }, 'text', null, undefined, 42]) {
		const http = fakeHttp({ status: 200, ms: 10, json });
		const run = await bitstampAdapter.fetchPrices(allCoins, http, now);
		assert.deepEqual(run.rows, []);
		assert.equal(run.log.error, 'parse');
		assert.equal(run.log.http, 200);
	}
});

test('list items of the wrong shape are skipped', async () => {
	const json = [
		null,
		'x',
		{ last: '1' },
		{ pair: 5 },
		...(ticker as unknown[]),
	];
	const http = fakeHttp({ status: 200, ms: 1, json });
	const run = await bitstampAdapter.fetchPrices(allCoins, http, now);
	assert.equal(run.rows.length, 10);
});

test('with no coins there is no request', async () => {
	const http = fakeHttp({ status: 200, ms: 1, json: ticker });
	const run = await bitstampAdapter.fetchPrices([], http, now);
	assert.equal(http.requests.length, 0);
	assert.deepEqual(run.rows, []);
	assert.equal(run.log.coins_ok, 0);
	assert.equal(run.log.error, '');
});

test('the adapter identifies itself', () => {
	assert.equal(bitstampAdapter.id, 'bitstamp');
	assert.equal(bitstampAdapter.src, 'bs');
});
