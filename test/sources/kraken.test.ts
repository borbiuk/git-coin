import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { krakenAdapter } from '../../src/sources/kraken.ts';
import type {
	CoinConfig,
	HttpClient,
	HttpRequest,
	HttpResult,
} from '../../src/types.ts';

function fixture(name: string): Record<string, unknown> {
	const text = readFileSync(
		new URL(`../fixtures/kraken/${name}.json`, import.meta.url),
		'utf8'
	);
	return JSON.parse(text) as Record<string, unknown>;
}

function coin(
	id: string,
	pair: string | undefined,
	enabled = true
): CoinConfig {
	return {
		id,
		name: id,
		enabled,
		added: '2026-10-29',
		sources: pair === undefined ? {} : { kraken_pair: pair },
	};
}

const COINS: CoinConfig[] = [
	coin('BTC', 'XBTUSD'),
	coin('ETH', 'ETHUSD'),
	coin('BNB', 'BNBUSD'),
	coin('XRP', 'XRPUSD'),
	coin('SOL', 'SOLUSD'),
	coin('DOGE', 'XDGUSD'),
	coin('LINK', 'LINKUSD'),
	coin('ADA', 'ADAUSD'),
	coin('XLM', 'XLMUSD'),
	coin('LTC', 'LTCUSD'),
];

const EXPECTED_PRICES: Record<string, string> = {
	BTC: '100.00000',
	ETH: '50.50',
	BNB: '20.1',
	XRP: '0.5000',
	SOL: '10.25',
	DOGE: '0.01000000',
	LINK: '7.5',
	ADA: '0.30000',
	XLM: '0.1200',
	LTC: '60.00',
};

const NOW = () => new Date('2026-11-01T10:00:07.400Z');

function ok(json: unknown, ms = 100): HttpResult {
	return { status: 200, ms, json };
}

/** A fake client. The handler gets the URL path (for example `/0/public/Ticker`) and the `pair` value. */
function fakeHttp(
	handler: (endpoint: string, pair: string | null) => HttpResult
): HttpClient & { urls: string[] } {
	const urls: string[] = [];
	return {
		urls,
		getJson(req: HttpRequest): Promise<HttpResult> {
			urls.push(req.url);
			const url = new URL(req.url);
			const endpoint = url.pathname.split('/').pop() ?? '';
			return Promise.resolve(
				handler(endpoint, url.searchParams.get('pair'))
			);
		},
	};
}

function normalHandler(endpoint: string): HttpResult {
	if (endpoint === 'AssetPairs') {
		return ok(fixture('asset-pairs'), 120);
	}
	return ok(fixture('ticker'), 80);
}

describe('krakenAdapter', () => {
	test('has the Kraken ids', () => {
		assert.equal(krakenAdapter.id, 'kraken');
		assert.equal(krakenAdapter.src, 'kr');
	});

	test('returns a row for each of ten coins and one log row', async () => {
		const http = fakeHttp(normalHandler);
		const run = await krakenAdapter.fetchPrices(COINS, http, NOW);

		assert.equal(run.src, 'kr');
		assert.equal(run.rows.length, 10);
		for (const row of run.rows) {
			assert.equal(row.price, EXPECTED_PRICES[row.coin]);
			assert.equal(row.src, 'kr');
			assert.equal(row.age_s, null);
			assert.equal(row.ts, '2026-11-01T10:00:07Z');
		}
		assert.deepEqual(
			run.rows.map((row) => row.coin),
			COINS.map((c) => c.id)
		);
		assert.deepEqual(run.log, {
			ts: '2026-11-01T10:00:07Z',
			src: 'kr',
			http: 200,
			ms: 200,
			coins_ok: 10,
			error: '',
		});
	});

	test('asks for the catalogue and then the prices, one pair list each', async () => {
		const http = fakeHttp(normalHandler);
		await krakenAdapter.fetchPrices(COINS, http, NOW);

		const pairList =
			'XBTUSD,ETHUSD,BNBUSD,XRPUSD,SOLUSD,XDGUSD,LINKUSD,ADAUSD,XLMUSD,LTCUSD';
		assert.deepEqual(http.urls, [
			`https://api.kraken.com/0/public/AssetPairs?pair=${pairList}`,
			`https://api.kraken.com/0/public/Ticker?pair=${pairList}`,
		]);
	});

	test('ignores pairs that no coin asked for', async () => {
		const http = fakeHttp(normalHandler);
		const run = await krakenAdapter.fetchPrices(
			[coin('BTC', 'XBTUSD')],
			http,
			NOW
		);
		assert.deepEqual(
			run.rows.map((row) => row.coin),
			['BTC']
		);
		assert.equal(run.log.coins_ok, 1);
	});

	test('skips coins that are disabled or have no Kraken pair', async () => {
		const http = fakeHttp(normalHandler);
		const run = await krakenAdapter.fetchPrices(
			[
				coin('BTC', 'XBTUSD'),
				coin('ETH', 'ETHUSD', false),
				coin('DOT', undefined),
			],
			http,
			NOW
		);
		assert.deepEqual(
			run.rows.map((row) => row.coin),
			['BTC']
		);
		assert.equal(run.log.error, '');
		assert.match(http.urls[0] ?? '', /pair=XBTUSD$/);
	});

	test('makes no request when there is nothing to fetch', async () => {
		const http = fakeHttp(normalHandler);
		const run = await krakenAdapter.fetchPrices(
			[coin('DOT', undefined)],
			http,
			NOW
		);
		assert.equal(http.urls.length, 0);
		assert.deepEqual(run.rows, []);
		assert.deepEqual(run.log, {
			ts: '2026-11-01T10:00:07Z',
			src: 'kr',
			http: 200,
			ms: 0,
			coins_ok: 0,
			error: '',
		});
	});

	test('maps a pair by its wsname when the altname differs', async () => {
		const http = fakeHttp((endpoint) => {
			const body = fixture(
				endpoint === 'AssetPairs' ? 'asset-pairs' : 'ticker'
			);
			if (endpoint === 'AssetPairs') {
				const result = body.result as Record<
					string,
					Record<string, unknown>
				>;
				result.XXBTZUSD = { ...result.XXBTZUSD, altname: 'BTCUSD' };
			}
			return ok(body);
		});
		const run = await krakenAdapter.fetchPrices(
			[coin('BTC', 'XBTUSD')],
			http,
			NOW
		);
		assert.equal(run.rows.length, 1);
		assert.equal(run.rows[0]?.price, '100.00000');
	});

	test('reports unmapped for a coin that is missing in the ticker result', async () => {
		const http = fakeHttp((endpoint) => {
			const body = fixture(
				endpoint === 'AssetPairs' ? 'asset-pairs' : 'ticker'
			);
			if (endpoint === 'Ticker') {
				delete (body.result as Record<string, unknown>).XXRPZUSD;
			}
			return ok(body);
		});
		const run = await krakenAdapter.fetchPrices(COINS, http, NOW);

		assert.equal(run.rows.length, 9);
		assert.ok(run.rows.every((row) => row.coin !== 'XRP'));
		assert.equal(run.log.coins_ok, 9);
		assert.equal(run.log.http, 200);
		assert.equal(run.log.error, 'unmapped');
	});

	test('reports unmapped for a pair that is not in the catalogue', async () => {
		const http = fakeHttp(normalHandler);
		const run = await krakenAdapter.fetchPrices(
			[coin('BTC', 'XBTUSD'), coin('NEW', 'NEWUSD')],
			http,
			NOW
		);
		assert.deepEqual(
			run.rows.map((row) => row.coin),
			['BTC']
		);
		assert.equal(run.log.error, 'unmapped');
	});

	test('reports unmapped for a pair that is not online', async () => {
		const http = fakeHttp((endpoint) => {
			const body = fixture(
				endpoint === 'AssetPairs' ? 'asset-pairs' : 'ticker'
			);
			if (endpoint === 'AssetPairs') {
				const result = body.result as Record<
					string,
					Record<string, unknown>
				>;
				result.XETHZUSD = { ...result.XETHZUSD, status: 'cancel_only' };
			}
			return ok(body);
		});
		const run = await krakenAdapter.fetchPrices(
			COINS.slice(0, 2),
			http,
			NOW
		);
		assert.deepEqual(
			run.rows.map((row) => row.coin),
			['BTC']
		);
		assert.equal(run.log.error, 'unmapped');
	});

	test('reports parse for a coin whose ticker entry has no last price', async () => {
		const http = fakeHttp((endpoint) => {
			const body = fixture(
				endpoint === 'AssetPairs' ? 'asset-pairs' : 'ticker'
			);
			if (endpoint === 'Ticker') {
				const result = body.result as Record<
					string,
					Record<string, unknown>
				>;
				result.XETHZUSD = { c: [50.5] };
			}
			return ok(body);
		});
		const run = await krakenAdapter.fetchPrices(
			COINS.slice(0, 3),
			http,
			NOW
		);
		assert.deepEqual(
			run.rows.map((row) => row.coin),
			['BTC', 'BNB']
		);
		assert.equal(run.log.error, 'parse');
	});

	test('maps HTTP 429 to http_429 and stops after the first request', async () => {
		const http = fakeHttp(() => ({
			status: 429,
			ms: 30,
			error: 'http_429',
		}));
		const run = await krakenAdapter.fetchPrices(COINS, http, NOW);

		assert.equal(http.urls.length, 1);
		assert.deepEqual(run.rows, []);
		assert.deepEqual(run.log, {
			ts: '2026-11-01T10:00:07Z',
			src: 'kr',
			http: 429,
			ms: 30,
			coins_ok: 0,
			error: 'http_429',
		});
	});

	test('maps the Kraken rate limit message to http_429 without a fallback', async () => {
		const http = fakeHttp((endpoint) =>
			endpoint === 'AssetPairs'
				? ok(fixture('asset-pairs'))
				: ok(fixture('error-rate-limit'))
		);
		const run = await krakenAdapter.fetchPrices(COINS, http, NOW);

		assert.equal(http.urls.length, 2);
		assert.deepEqual(run.rows, []);
		assert.equal(run.log.http, 200);
		assert.equal(run.log.error, 'http_429');
	});

	test('maps a timeout to timeout', async () => {
		const http = fakeHttp(() => ({
			status: 0,
			ms: 10000,
			error: 'timeout',
		}));
		const run = await krakenAdapter.fetchPrices(COINS, http, NOW);

		assert.equal(http.urls.length, 1);
		assert.equal(run.log.http, 0);
		assert.equal(run.log.ms, 10000);
		assert.equal(run.log.error, 'timeout');
		assert.deepEqual(run.rows, []);
	});

	test('keeps the first non-200 status and the total time when the ticker fails', async () => {
		const http = fakeHttp((endpoint) =>
			endpoint === 'AssetPairs'
				? ok(fixture('asset-pairs'), 120)
				: { status: 503, ms: 50, error: 'http_other' }
		);
		const run = await krakenAdapter.fetchPrices(COINS, http, NOW);

		assert.equal(http.urls.length, 2);
		assert.deepEqual(run.log, {
			ts: '2026-11-01T10:00:07Z',
			src: 'kr',
			http: 503,
			ms: 170,
			coins_ok: 0,
			error: 'http_other',
		});
	});

	test('treats a status that is not 200 as http_other even without an error code', async () => {
		const http = fakeHttp(() => ({ status: 502, ms: 20 }));
		const run = await krakenAdapter.fetchPrices(COINS, http, NOW);
		assert.equal(run.log.http, 502);
		assert.equal(run.log.error, 'http_other');
	});

	test('reports parse for bodies of an unknown shape', async () => {
		const shapes: unknown[] = [
			[],
			'text',
			{ result: {} },
			{ error: [], result: [] },
			{ error: 'none', result: {} },
		];
		for (const shape of shapes) {
			const http = fakeHttp(() => ok(shape));
			const run = await krakenAdapter.fetchPrices(COINS, http, NOW);
			assert.deepEqual(run.rows, []);
			assert.equal(run.log.error, 'parse');
			assert.equal(run.log.http, 200);
		}
	});

	test('reports parse when the client could not read the JSON', async () => {
		const http = fakeHttp(() => ({ status: 200, ms: 5, error: 'parse' }));
		const run = await krakenAdapter.fetchPrices(COINS, http, NOW);
		assert.equal(run.log.error, 'parse');
	});

	test('falls back to a ticker request without pair when the pair list is refused', async () => {
		const http = fakeHttp((endpoint, pair) => {
			if (endpoint === 'AssetPairs') {
				return ok(fixture('asset-pairs'), 120);
			}
			if (pair !== null) {
				return ok(fixture('error-unknown-pair'), 40);
			}
			return ok(fixture('ticker'), 90);
		});
		const run = await krakenAdapter.fetchPrices(COINS, http, NOW);

		assert.equal(http.urls.length, 3);
		assert.equal(http.urls[2], 'https://api.kraken.com/0/public/Ticker');
		assert.equal(run.rows.length, 10);
		assert.equal(run.log.coins_ok, 10);
		assert.equal(run.log.ms, 250);
		assert.equal(run.log.http, 200);
		assert.equal(run.log.error, '');
	});

	test('falls back to a catalogue request without pair too', async () => {
		const http = fakeHttp((endpoint, pair) => {
			if (pair !== null) {
				return ok(fixture('error-unknown-pair'));
			}
			return ok(
				fixture(endpoint === 'AssetPairs' ? 'asset-pairs' : 'ticker')
			);
		});
		const run = await krakenAdapter.fetchPrices(COINS, http, NOW);

		assert.equal(http.urls.length, 4);
		assert.equal(run.rows.length, 10);
		assert.equal(run.log.error, '');
	});

	test('does not fall back after a server error', async () => {
		const http = fakeHttp(() => ({
			status: 500,
			ms: 10,
			error: 'http_other',
		}));
		const run = await krakenAdapter.fetchPrices(COINS, http, NOW);
		assert.equal(http.urls.length, 1);
		assert.equal(run.log.http, 500);
		assert.equal(run.log.error, 'http_other');
	});

	test('reports the error when the fallback fails too', async () => {
		const http = fakeHttp((endpoint, pair) => {
			if (endpoint === 'AssetPairs') {
				return ok(fixture('asset-pairs'));
			}
			return pair === null
				? { status: 500, ms: 10, error: 'http_other' }
				: ok(fixture('error-unknown-pair'));
		});
		const run = await krakenAdapter.fetchPrices(COINS, http, NOW);
		assert.equal(http.urls.length, 3);
		assert.deepEqual(run.rows, []);
		assert.equal(run.log.http, 500);
		assert.equal(run.log.error, 'http_other');
	});
});
