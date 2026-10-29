import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { coinbaseAdapter } from '../../src/sources/coinbase.ts';
import type {
	CoinConfig,
	HttpClient,
	HttpRequest,
	HttpResult,
} from '../../src/types.ts';

const IDS = [
	'BTC',
	'ETH',
	'BNB',
	'XRP',
	'SOL',
	'DOGE',
	'LINK',
	'ADA',
	'XLM',
	'LTC',
];

function makeCoin(id: string): CoinConfig {
	return {
		id,
		name: id,
		enabled: true,
		added: '2026-10-29',
		sources: { coinbase_product: `${id}-USD` },
	};
}

const COINS = IDS.map(makeCoin);

async function loadTicker(): Promise<Record<string, unknown>> {
	const text = await readFile(
		new URL('../fixtures/coinbase/ticker.json', import.meta.url),
		'utf8'
	);
	return JSON.parse(text) as Record<string, unknown>;
}

// 2.377 seconds after the fixture time.
const FIXED_NOW = new Date('2026-10-29T14:03:12.500Z');
const fixedClock = (): Date => FIXED_NOW;

interface FakeOptions {
	respond?: (product: string, ticker: Record<string, unknown>) => HttpResult;
	delayMs?: number;
}

function fakeClient(
	ticker: Record<string, unknown>,
	options: FakeOptions = {}
): { client: HttpClient; requests: HttpRequest[]; maxInFlight: () => number } {
	const requests: HttpRequest[] = [];
	let inFlight = 0;
	let peak = 0;
	const client: HttpClient = {
		async getJson(req: HttpRequest): Promise<HttpResult> {
			requests.push(req);
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => {
				setTimeout(resolve, options.delayMs ?? 2);
			});
			inFlight -= 1;
			const match = /\/products\/([^/]+)\/ticker$/.exec(req.url);
			const product = match === null ? '' : match[1];
			if (options.respond !== undefined) {
				return options.respond(product, ticker);
			}
			return { status: 200, ms: 5, json: ticker };
		},
	};
	return { client, requests, maxInFlight: () => peak };
}

test('all ten coins give a row and an ok log row', async () => {
	const ticker = await loadTicker();
	const { client, requests } = fakeClient(ticker, {
		respond: (product, base) => ({
			status: 200,
			ms: 5,
			json: { ...base, price: `${product.length}00.00` },
		}),
	});
	const run = await coinbaseAdapter.fetchPrices(COINS, client, fixedClock);

	assert.equal(run.src, 'cb');
	assert.equal(coinbaseAdapter.id, 'coinbase');
	assert.equal(coinbaseAdapter.src, 'cb');
	assert.equal(run.rows.length, 10);
	assert.deepEqual(
		run.rows.map((row) => row.coin),
		IDS
	);
	assert.deepEqual(run.rows[0], {
		ts: '2026-10-29T14:03:12Z',
		coin: 'BTC',
		price: '700.00',
		src: 'cb',
		age_s: 2,
	});
	assert.deepEqual(run.log, {
		ts: '2026-10-29T14:03:12Z',
		src: 'cb',
		http: 200,
		ms: 0,
		coins_ok: 10,
		error: '',
	});
	assert.equal(requests.length, 10);
	assert.equal(
		requests[0].url,
		'https://api.exchange.coinbase.com/products/BTC-USD/ticker'
	);
});

test('the price string is kept exactly as the source gave it', async () => {
	const ticker = await loadTicker();
	ticker.price = '0.10000';
	const { client } = fakeClient(ticker);
	const run = await coinbaseAdapter.fetchPrices(
		[makeCoin('XRP')],
		client,
		fixedClock
	);
	assert.equal(run.rows[0].price, '0.10000');
});

test('one 404 keeps the other rows and reports http_other', async () => {
	const ticker = await loadTicker();
	const { client } = fakeClient(ticker, {
		respond: (product, base) =>
			product === 'SOL-USD'
				? { status: 404, ms: 5, error: 'http_other' }
				: { status: 200, ms: 5, json: base },
	});
	const run = await coinbaseAdapter.fetchPrices(COINS, client, fixedClock);

	assert.equal(run.rows.length, 9);
	assert.ok(!run.rows.some((row) => row.coin === 'SOL'));
	assert.equal(run.log.http, 404);
	assert.equal(run.log.error, 'http_other');
	assert.equal(run.log.coins_ok, 9);
});

test('a 404 without an error code from the client is still http_other', async () => {
	const ticker = await loadTicker();
	const { client } = fakeClient(ticker, {
		respond: () => ({ status: 404, ms: 5, json: { message: 'NotFound' } }),
	});
	const run = await coinbaseAdapter.fetchPrices(
		[makeCoin('BTC')],
		client,
		fixedClock
	);
	assert.equal(run.rows.length, 0);
	assert.equal(run.log.http, 404);
	assert.equal(run.log.error, 'http_other');
});

test('one 429 keeps the other rows and reports http_429', async () => {
	const ticker = await loadTicker();
	const { client } = fakeClient(ticker, {
		respond: (product, base) =>
			product === 'ETH-USD'
				? { status: 429, ms: 5, error: 'http_429' }
				: { status: 200, ms: 5, json: base },
	});
	const run = await coinbaseAdapter.fetchPrices(COINS, client, fixedClock);

	assert.equal(run.rows.length, 9);
	assert.equal(run.log.http, 429);
	assert.equal(run.log.error, 'http_429');
});

test('a timeout on one coin gives http 0 and the timeout code', async () => {
	const ticker = await loadTicker();
	const { client } = fakeClient(ticker, {
		respond: (product, base) =>
			product === 'ADA-USD'
				? { status: 0, ms: 10000, error: 'timeout' }
				: { status: 200, ms: 5, json: base },
	});
	const run = await coinbaseAdapter.fetchPrices(COINS, client, fixedClock);

	assert.equal(run.rows.length, 9);
	assert.equal(run.log.http, 0);
	assert.equal(run.log.error, 'timeout');
	assert.equal(run.log.coins_ok, 9);
});

test('the log reports the first failure in coin order', async () => {
	const ticker = await loadTicker();
	const { client } = fakeClient(ticker, {
		respond: (product, base) => {
			if (product === 'BTC-USD') {
				return { status: 429, ms: 5, error: 'http_429' };
			}
			if (product === 'LTC-USD') {
				return { status: 0, ms: 5, error: 'timeout' };
			}
			return { status: 200, ms: 5, json: base };
		},
	});
	const run = await coinbaseAdapter.fetchPrices(COINS, client, fixedClock);
	assert.equal(run.log.http, 429);
	assert.equal(run.log.error, 'http_429');
});

test('a bad body shape gives parse and keeps http 200', async () => {
	const ticker = await loadTicker();
	const bodies: Record<string, unknown> = {
		'BTC-USD': { ...ticker, price: 100 },
		'ETH-USD': { ...ticker, price: '' },
		'BNB-USD': 'text',
		'XRP-USD': null,
		'SOL-USD': { ...ticker, price: undefined },
	};
	const { client } = fakeClient(ticker, {
		respond: (product, base) => ({
			status: 200,
			ms: 5,
			json: product in bodies ? bodies[product] : base,
		}),
	});
	const run = await coinbaseAdapter.fetchPrices(COINS, client, fixedClock);

	assert.equal(run.rows.length, 5);
	assert.equal(run.log.http, 200);
	assert.equal(run.log.error, 'parse');
	assert.equal(run.log.coins_ok, 5);
});

test('a coin without a Coinbase product is unmapped and sends no request', async () => {
	const ticker = await loadTicker();
	const { client, requests } = fakeClient(ticker);
	const noProduct: CoinConfig = { ...makeCoin('BTC'), sources: {} };
	const run = await coinbaseAdapter.fetchPrices(
		[noProduct, makeCoin('ETH')],
		client,
		fixedClock
	);

	assert.equal(requests.length, 1);
	assert.deepEqual(
		run.rows.map((row) => row.coin),
		['ETH']
	);
	assert.equal(run.log.error, 'unmapped');
	assert.equal(run.log.http, 200);
});

test('no coins give an empty run without requests', async () => {
	const ticker = await loadTicker();
	const { client, requests } = fakeClient(ticker);
	const run = await coinbaseAdapter.fetchPrices([], client, fixedClock);

	assert.equal(requests.length, 0);
	assert.deepEqual(run.rows, []);
	assert.equal(run.log.http, 0);
	assert.equal(run.log.coins_ok, 0);
	assert.equal(run.log.error, '');
});

test('never more than 4 requests are in flight', async () => {
	const ticker = await loadTicker();
	const { client, requests, maxInFlight } = fakeClient(ticker, {
		delayMs: 10,
	});
	const run = await coinbaseAdapter.fetchPrices(COINS, client, fixedClock);

	assert.equal(requests.length, 10);
	assert.equal(run.rows.length, 10);
	assert.equal(maxInFlight(), 4);
});

test('age_s is whole seconds and never negative', async () => {
	const ticker = await loadTicker();
	const cases: Array<[unknown, number | null]> = [
		['2026-10-29T14:03:10.123456Z', 2],
		['2026-10-29T14:03:12.400Z', 0],
		['2026-10-29T14:03:12Z', 1],
		['2026-10-29T14:03:00Z', 13],
		// The exchange time is ahead of our clock.
		['2026-10-29T14:03:20Z', 0],
		['not a date', null],
		[undefined, null],
		[1761746590, null],
	];
	for (const [time, expected] of cases) {
		const { client } = fakeClient(ticker, {
			respond: (_product, base) => ({
				status: 200,
				ms: 5,
				json: { ...base, time },
			}),
		});
		const run = await coinbaseAdapter.fetchPrices(
			[makeCoin('BTC')],
			client,
			fixedClock
		);
		assert.equal(run.rows[0].age_s, expected, `time ${String(time)}`);
	}
});

test('each row ts is taken after its own response and ms is the wall time', async () => {
	const ticker = await loadTicker();
	const { client } = fakeClient(ticker);
	let calls = 0;
	const base = Date.parse('2026-10-29T14:03:00Z');
	// Every call to the clock is 1.5 seconds later than the one before.
	const clock = (): Date => {
		const value = new Date(base + calls * 1500);
		calls += 1;
		return value;
	};
	const run = await coinbaseAdapter.fetchPrices(
		[makeCoin('BTC'), makeCoin('ETH')],
		client,
		clock
	);

	// Call 0 is the start. Rows are stamped by calls 1 and 2. The last call (3) ends the wall time.
	assert.equal(run.log.ts, '2026-10-29T14:03:00Z');
	assert.deepEqual(
		run.rows.map((row) => row.ts),
		['2026-10-29T14:03:01Z', '2026-10-29T14:03:03Z']
	);
	assert.equal(run.log.ms, 4500);
});
