import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { readLastRow } from '../../src/csv.ts';
import type { HttpClient, HttpRequest, HttpResult } from '../../src/types.ts';
import {
	backfillMarket,
	main,
	parseCandles,
	requestCount,
} from '../../tools/backfill-bitstamp.ts';
import type { BackfillOptions } from '../../tools/backfill-bitstamp.ts';

const STEP = 900;
const WINDOW = STEP * 1000;
// 2026-01-01T00:00:00Z, a multiple of 15 minutes
const FROM = 1_767_225_600;
const CONFIG = join(import.meta.dirname, '..', '..', 'config', 'coins.json');

let root = '';

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'git-coin-backfill-'));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function candle(start: number, close: string, volume = '1.5') {
	return {
		timestamp: String(start),
		open: close,
		high: close,
		low: close,
		close,
		volume,
	};
}

/** Answers like the endpoint: the candles from `start` on, at most one window of time. */
function fakeHttp(
	candles: Array<ReturnType<typeof candle>>,
	script: HttpResult[] = []
): HttpClient & { urls: string[] } {
	const urls: string[] = [];
	return {
		urls,
		async getJson(req: HttpRequest): Promise<HttpResult> {
			urls.push(req.url);
			const next = script.shift();
			if (next !== undefined) {
				return next;
			}
			const start = Number(new URL(req.url).searchParams.get('start'));
			const ohlc = candles.filter(
				(item) =>
					Number(item.timestamp) >= start &&
					Number(item.timestamp) < start + WINDOW
			);
			return { status: 200, ms: 1, json: { data: { pair: 'X', ohlc } } };
		},
	};
}

function options(
	http: HttpClient,
	patch: Partial<BackfillOptions> = {}
): BackfillOptions & { waits: number[]; lines: string[] } {
	const waits: number[] = [];
	const lines: string[] = [];
	return {
		dataRoot: root,
		http,
		fromSec: FROM,
		untilSec: FROM + 3 * WINDOW,
		pauseMs: 1000,
		sleep: async (ms) => {
			waits.push(ms);
		},
		log: (line) => lines.push(line),
		waits,
		lines,
		...patch,
	};
}

async function file(day: string, coin: string): Promise<string> {
	const [y, m, d] = day.split('-');
	return readFile(
		join(root, 'data', 'raw', y ?? '', m ?? '', d ?? '', `${coin}.csv`),
		'utf8'
	);
}

describe('parseCandles', () => {
	test('reads the candles in time order and keeps the close as text', () => {
		const out = parseCandles({
			data: {
				ohlc: [candle(1800, '2.50000'), candle(900, '2.4', '0')],
			},
		});
		assert.deepEqual(out, [
			{ start: 900, close: '2.4', volume: '0' },
			{ start: 1800, close: '2.50000', volume: '1.5' },
		]);
	});

	test('rejects a missing list and a field that is not a plain number', () => {
		assert.throws(() => parseCandles({}), /no data.ohlc list/);
		assert.throws(() => parseCandles(null), /no data.ohlc list/);
		for (const bad of [
			{ ...candle(900, '1'), close: '1e5' },
			{ ...candle(900, '1'), close: '0' },
			{ ...candle(900, '1'), close: 5 },
			{ ...candle(900, '1'), timestamp: 'x' },
			{ ...candle(900, '1'), volume: '-1' },
		]) {
			assert.throws(
				() => parseCandles({ data: { ohlc: [bad] } }),
				/plain number/
			);
		}
	});
});

test('requestCount is one request per 1000 candles of 15 minutes', () => {
	assert.equal(requestCount(FROM, FROM), 0);
	assert.equal(requestCount(FROM, FROM + 1), 1);
	assert.equal(requestCount(FROM, FROM + WINDOW), 1);
	assert.equal(requestCount(FROM, FROM + WINDOW + 900), 2);
	// 2024-01-01 to 2026-10-29 is 99.07 windows, so 100 requests per market
	assert.equal(requestCount(1_704_067_200, 1_793_232_000), 100);
});

describe('backfillMarket', () => {
	test('writes the close price at the close time, skips zero volume and the open end, and pauses between requests', async () => {
		const http = fakeHttp([
			candle(FROM, '100.10'),
			candle(FROM + STEP, '100.20', '0'),
			candle(FROM + 2 * STEP, '100.30'),
			// next window, after a gap of many empty candles
			candle(FROM + WINDOW + 5 * STEP, '101.00'),
			// the last candle closes exactly at `until`: not written
			candle(FROM + 3 * WINDOW - STEP, '102.00'),
		]);
		const opts = options(http);
		const result = await backfillMarket(
			{ coin: 'BTC', market: 'btcusd' },
			opts
		);
		assert.equal(result.requests, 3);
		assert.equal(result.written, 3);
		assert.deepEqual(opts.waits, [1000, 1000]);
		const starts = http.urls.map((url) =>
			new URL(url).searchParams.get('start')
		);
		assert.deepEqual(
			starts,
			[FROM, FROM + WINDOW, FROM + 2 * WINDOW].map(String)
		);
		assert.match(
			http.urls[0] ?? '',
			/^https:\/\/www\.bitstamp\.net\/api\/v2\/ohlc\/btcusd\/\?step=900&limit=1000&start=/
		);
		assert.equal(
			await file('2026-01-01', 'BTC'),
			'ts,price,src,age_s\n' +
				'2026-01-01T00:15:00Z,100.10,bs-ohlc,\n' +
				'2026-01-01T00:45:00Z,100.30,bs-ohlc,\n'
		);
		// Day 11 of the window: 1000 candles of 15 minutes are 10 days and 10 hours
		const later = await readLastRow(root, 'BTC', 'bs-ohlc');
		assert.equal(later?.price, '101.00');
		assert.equal(later?.age_s, null);
	});

	test('a candle that comes twice, because the answer starts before the window, is written once', async () => {
		const http = fakeHttp([]);
		http.getJson = async (req) => {
			const start = Number(new URL(req.url).searchParams.get('start'));
			const ohlc = [candle(FROM, '1'), candle(FROM + STEP, '2')].filter(
				(item) => Number(item.timestamp) < start + WINDOW
			);
			return { status: 200, ms: 1, json: { data: { ohlc } } };
		};
		const result = await backfillMarket(
			{ coin: 'ETH', market: 'ethusd' },
			options(http)
		);
		assert.equal(result.written, 2);
		assert.equal((await file('2026-01-01', 'ETH')).split('\n').length, 4);
	});

	test('a second run continues after the last stored row and writes nothing twice', async () => {
		const all = [candle(FROM, '1'), candle(FROM + WINDOW + STEP, '2')];
		const first = await backfillMarket(
			{ coin: 'BTC', market: 'btcusd' },
			options(fakeHttp(all), { untilSec: FROM + WINDOW + 3 * STEP })
		);
		assert.equal(first.written, 2);
		const http = fakeHttp(all);
		const second = await backfillMarket(
			{ coin: 'BTC', market: 'btcusd' },
			options(http, { untilSec: FROM + 3 * WINDOW })
		);
		// It starts one step before the last stored candle, so the window after the first one is not asked again
		assert.equal(
			new URL(http.urls[0] ?? '').searchParams.get('start'),
			String(FROM + WINDOW + STEP)
		);
		assert.equal(second.written, 0);
		const text = await file('2026-01-01', 'BTC');
		assert.equal(
			text.split('\n').filter((line) => line.includes('bs-ohlc')).length,
			1
		);
	});

	test('waits and tries again after a 429, and stops after the last wait', async () => {
		const ok = fakeHttp(
			[candle(FROM, '1')],
			[{ status: 429, ms: 1, error: 'http_429' }]
		);
		const opts = options(ok, { untilSec: FROM + WINDOW });
		const result = await backfillMarket(
			{ coin: 'BTC', market: 'btcusd' },
			opts
		);
		assert.equal(result.written, 1);
		assert.deepEqual(opts.waits, [30_000]);

		const limited = fakeHttp(
			[],
			[
				{ status: 429, ms: 1, error: 'http_429' },
				{ status: 429, ms: 1, error: 'http_429' },
				{ status: 429, ms: 1, error: 'http_429' },
				{ status: 429, ms: 1, error: 'http_429' },
			]
		);
		const stopped = options(limited, { untilSec: FROM + WINDOW });
		await assert.rejects(
			backfillMarket({ coin: 'ETH', market: 'ethusd' }, stopped),
			/HTTP 429/
		);
		assert.deepEqual(stopped.waits, [30_000, 60_000, 120_000]);
		assert.equal(limited.urls.length, 4);
	});

	test('a client error that is not a rate limit stops at once', async () => {
		const http = fakeHttp(
			[],
			[{ status: 404, ms: 1, error: 'http_other' }]
		);
		const opts = options(http);
		await assert.rejects(
			backfillMarket({ coin: 'BTC', market: 'nopeusd' }, opts),
			/HTTP 404/
		);
		assert.deepEqual(opts.waits, []);
		assert.equal(http.urls.length, 1);
	});
});

describe('main', () => {
	async function run(argv: string[], http?: HttpClient) {
		let out = '';
		let err = '';
		const code = await main(argv, {
			out: (text) => {
				out += text;
			},
			err: (text) => {
				err += text;
			},
			http,
			sleep: async () => {},
		});
		return { code, out, err };
	}

	test('a dry run prints the plan for the config markets and calls nothing', async () => {
		const http = fakeHttp([]);
		const { code, out } = await run(
			['--data-root', root, '--config', CONFIG, '--dry-run'],
			http
		);
		assert.equal(code, 0);
		assert.match(
			out,
			/^11 markets, up to 100 requests each, up to 1100 in all, one every 1000 ms/
		);
		assert.match(out, /btcusd .*usdtusd/);
		assert.equal(http.urls.length, 0);
	});

	test('refuses a missing data root, a too short pause and a start that is off the grid', async () => {
		assert.equal((await run(['--config', CONFIG])).code, 1);
		const fast = await run([
			'--data-root',
			root,
			'--config',
			CONFIG,
			'--pause-ms',
			'100',
		]);
		assert.equal(fast.code, 1);
		assert.match(fast.err, /500 or more/);
		const off = await run([
			'--data-root',
			root,
			'--config',
			CONFIG,
			'--from',
			'2026-01-01T00:07:00Z',
		]);
		assert.equal(off.code, 1);
		assert.match(off.err, /15 minute mark/);
	});

	test('runs every market in turn and reports a stop with exit code 1', async () => {
		const http = fakeHttp(
			[],
			[{ status: 404, ms: 1, error: 'http_other' }]
		);
		const { code, err } = await run(
			[
				'--data-root',
				root,
				'--config',
				CONFIG,
				'--from',
				'2026-01-01T00:00:00Z',
				'--until',
				'2026-01-02T00:00:00Z',
			],
			http
		);
		assert.equal(code, 1);
		assert.match(err, /^stopped: Bitstamp answered HTTP 404/);
	});
});
