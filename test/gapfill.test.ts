import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
	COINBASE_LIMIT,
	KRAKEN_LIMIT,
	LIMIT,
	MAX_REQUESTS,
	MIN_GAP_SECONDS,
	STEP_SECONDS,
	candleRows,
	candleUrl,
	fetchGapRows,
	parseCoinbaseCandles,
	parseKrakenCandles,
	parseOkxCandles,
	planRequest,
	readPending,
	writePending,
} from '../src/gapfill.ts';
import type { Candle, GapFillOptions } from '../src/gapfill.ts';
import type { HttpClient, HttpResult } from '../src/types.ts';

const NOW = Date.parse('2026-10-30T12:07:00Z') / 1000;

function candle(startIso: string, close: string, volume = '1.5'): Candle {
	return { start: Date.parse(startIso) / 1000, close, volume };
}

function answer(candles: Candle[]): HttpResult {
	return {
		status: 200,
		ms: 5,
		json: {
			data: {
				pair: 'btcusd',
				ohlc: candles.map((item) => {
					return {
						timestamp: String(item.start),
						open: '1',
						high: '1',
						low: '1',
						close: item.close,
						volume: item.volume,
					};
				}),
			},
		},
	};
}

function options(
	results: HttpResult[],
	urls: string[],
	logs: string[]
): GapFillOptions {
	const http: HttpClient = {
		getJson(req) {
			urls.push(req.url);
			return Promise.resolve(
				results.shift() ?? { status: 500, ms: 1, error: 'http_other' }
			);
		},
	};
	return {
		http,
		nowSec: NOW,
		pauseMs: 0,
		sleep: () => Promise.resolve(),
		log: (line) => {
			logs.push(line);
		},
	};
}

test('planRequest sees no gap below the limit and starts at the candle of the last row', () => {
	assert.equal(planRequest(NOW - (MIN_GAP_SECONDS - 1), NOW), null);
	const plan = planRequest(Date.parse('2026-10-30T10:03:12Z') / 1000, NOW);
	assert.equal(plan?.startSec, Date.parse('2026-10-30T10:00:00Z') / 1000);
	// 10:00 up to 12:07: the candles of 10:00, 10:15 ... 12:00
	assert.equal(plan?.limit, 10);
});

test('planRequest fills only the newest 1000 candles of a very long gap', () => {
	const plan = planRequest(NOW - 30 * 86_400, NOW);
	assert.equal(plan?.limit, LIMIT);
	const newest = Math.floor(NOW / STEP_SECONDS) * STEP_SECONDS;
	assert.equal(plan?.startSec, newest - (LIMIT - 1) * STEP_SECONDS);
});

test('candleRows uses the close time and the close price, and leaves out old, future and empty candles', () => {
	const from = Date.parse('2026-10-30T10:03:12Z') / 1000;
	const rows = candleRows(
		'BTC',
		[
			// closes at 10:00, before the gap starts
			candle('2026-10-30T09:45:00Z', '1'),
			// closes at 10:15
			candle('2026-10-30T10:00:00Z', '78000.5'),
			// no trades
			candle('2026-10-30T10:15:00Z', '2', '0'),
			// closes at 12:00
			candle('2026-10-30T11:45:00Z', '78100'),
			// closes at 12:15, after now
			candle('2026-10-30T12:00:00Z', '3'),
		],
		from,
		NOW,
		'bs-ohlc'
	);
	assert.deepEqual(rows, [
		{
			ts: '2026-10-30T10:15:00Z',
			coin: 'BTC',
			price: '78000.5',
			src: 'bs-ohlc',
			age_s: null,
		},
		{
			ts: '2026-10-30T12:00:00Z',
			coin: 'BTC',
			price: '78100',
			src: 'bs-ohlc',
			age_s: null,
		},
	]);
});

test('fetchGapRows asks one market for the gap and leaves a market with no gap alone', async () => {
	const urls: string[] = [];
	const logs: string[] = [];
	const result = await fetchGapRows(
		[
			{
				coin: 'BTC',
				market: 'btcusd',
				src: 'bs-ohlc',
				fromSec: Date.parse('2026-10-30T11:00:00Z') / 1000,
			},
			{
				coin: 'ETH',
				market: 'ethusd',
				src: 'bs-ohlc',
				fromSec: NOW - 60,
			},
		],
		options([answer([candle('2026-10-30T11:15:00Z', '5')])], urls, logs)
	);
	assert.equal(urls.length, 1);
	assert.match(
		urls[0] ?? '',
		/\/api\/v2\/ohlc\/btcusd\/\?step=900&limit=\d+&start=\d+$/
	);
	assert.deepEqual(
		result.rows.map((row) => [row.coin, row.ts, row.price]),
		[['BTC', '2026-10-30T11:30:00Z', '5']]
	);
	assert.deepEqual(result.pending, {});
});

test('fetchGapRows keeps a failed market open, goes on with the next and stops after a 429', async () => {
	const from = Date.parse('2026-10-30T11:00:00Z') / 1000;
	const targets = ['BTC', 'ETH', 'XRP', 'ADA'].map((coin) => {
		return {
			coin,
			market: `${coin.toLowerCase()}usd`,
			src: 'bs-ohlc' as const,
			fromSec: from,
		};
	});
	const urls: string[] = [];
	const logs: string[] = [];
	const result = await fetchGapRows(
		targets,
		options(
			[
				{ status: 200, ms: 5, json: { unexpected: true } },
				answer([candle('2026-10-30T11:15:00Z', '7')]),
				{ status: 429, ms: 5, error: 'http_429' },
			],
			urls,
			logs
		)
	);
	// BTC had a bad shape, ETH worked, XRP got a 429, ADA was not asked
	assert.equal(urls.length, 3);
	assert.deepEqual(
		result.rows.map((row) => row.coin),
		['ETH']
	);
	assert.deepEqual(Object.keys(result.pending), ['BTC', 'XRP', 'ADA']);
	assert.equal(result.pending.BTC, '2026-10-30T11:00:00Z');
	assert.ok(logs.some((line) => line.startsWith('gap fill: HTTP 429')));
});

test('the open gaps are kept in a file that is only written when it changes', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'gapfill-'));
	try {
		const file = join(dir, 'state', 'gapfill.json');
		assert.deepEqual(await readPending(file), {});
		await writePending(file, { BTC: '2026-10-30T11:00:00Z' });
		assert.deepEqual(await readPending(file), {
			BTC: '2026-10-30T11:00:00Z',
		});
		const text = await readFile(file, 'utf8');
		assert.ok(text.endsWith('\n'));
		await writePending(file, { BTC: '2026-10-30T11:00:00Z' });
		assert.equal(await readFile(file, 'utf8'), text);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('readPending ignores a file that is not the expected shape', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'gapfill-'));
	try {
		const file = join(dir, 'gapfill.json');
		const { writeFile } = await import('node:fs/promises');
		await writeFile(
			file,
			JSON.stringify({
				pending: { BTC: 5, ETH: 'nope', XRP: '2026-10-30T11:00:00Z' },
			})
		);
		assert.deepEqual(await readPending(file), {
			XRP: '2026-10-30T11:00:00Z',
		});
		await writeFile(file, 'not json');
		assert.deepEqual(await readPending(file), {});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

function krakenAnswer(): HttpResult {
	const start = Date.parse('2026-10-30T11:15:00Z') / 1000;
	return {
		status: 200,
		ms: 5,
		json: {
			error: [],
			result: {
				KSMUSD: [
					[start, '1', '2', '0.5', '3.51', '3', '10', 4],
					[start + 900, '1', '2', '0.5', '3.52', '3', '0.0', 0],
				],
				last: start,
			},
		},
	};
}

test('parseKrakenCandles reads the close and the volume, and rejects an error or a bad shape', () => {
	const candles = parseKrakenCandles(krakenAnswer().json);
	assert.deepEqual(candles[0], {
		start: Date.parse('2026-10-30T11:15:00Z') / 1000,
		close: '3.51',
		volume: '10',
	});
	assert.throws(
		() => parseKrakenCandles({ error: ['EAPI:Rate limit exceeded'] }),
		/Rate limit/
	);
	assert.throws(
		() => parseKrakenCandles({ error: [], result: {} }),
		/no candle list/
	);
	assert.throws(
		() =>
			parseKrakenCandles({
				error: [],
				result: { KSMUSD: [[1, '1', '1', '1', 'x', '1', '1', 1]] },
			}),
		/plain number/
	);
});

test('planRequest takes the limit of the source', () => {
	const plan = planRequest(NOW - 30 * 86_400, NOW, KRAKEN_LIMIT);
	assert.equal(plan?.limit, KRAKEN_LIMIT);
	const newest = Math.floor(NOW / STEP_SECONDS) * STEP_SECONDS;
	assert.equal(plan?.startSec, newest - (KRAKEN_LIMIT - 1) * STEP_SECONDS);
});

test('fetchGapRows fills a Kraken market with kr-ohlc rows and stops at a rate limit in a 200 answer', async () => {
	const urls: string[] = [];
	const logs: string[] = [];
	const from = Date.parse('2026-10-30T11:00:00Z') / 1000;
	const result = await fetchGapRows(
		[
			{ coin: 'KSM', market: 'KSMUSD', src: 'kr-ohlc', fromSec: from },
			{ coin: 'SC', market: 'SCUSD', src: 'kr-ohlc', fromSec: from },
			{ coin: 'MINA', market: 'MINAUSD', src: 'kr-ohlc', fromSec: from },
		],
		options(
			[
				krakenAnswer(),
				{
					status: 200,
					ms: 5,
					json: { error: ['EAPI:Rate limit exceeded'] },
				},
			],
			urls,
			logs
		)
	);
	assert.equal(urls.length, 2);
	assert.match(
		urls[0] ?? '',
		/^https:\/\/api\.kraken\.com\/0\/public\/OHLC\?pair=KSMUSD&interval=15&since=\d+$/
	);
	// The candle with no trades is left out
	assert.deepEqual(
		result.rows.map((row) => [row.coin, row.ts, row.price, row.src]),
		[['KSM', '2026-10-30T11:30:00Z', '3.51', 'kr-ohlc']]
	);
	assert.deepEqual(Object.keys(result.pending), ['SC', 'MINA']);
});

/** A Coinbase answer: `[time, low, high, open, close, volume]`, newest first, prices as JSON numbers. */
function coinbaseAnswer(rows: Array<[string, number, number]>): HttpResult {
	return {
		status: 200,
		ms: 5,
		json: rows
			.map(([startIso, close, volume]) => [
				Date.parse(startIso) / 1000,
				1,
				2,
				1,
				close,
				volume,
			])
			.reverse(),
	};
}

test('parseCoinbaseCandles reads numbers as plain text and rejects an exponent or a bad shape', () => {
	assert.deepEqual(
		parseCoinbaseCandles([
			[1792800900, 1, 2, 1, 9.102, 12.5],
			[1792800000, 1, 2, 1, 9.1, 0],
		]),
		[
			{ start: 1792800000, close: '9.1', volume: '0' },
			{ start: 1792800900, close: '9.102', volume: '12.5' },
		]
	);
	assert.throws(() => parseCoinbaseCandles({ message: 'NotFound' }));
	assert.throws(() => parseCoinbaseCandles([[1792800000, 1, 2, 1, 1e-7, 1]]));
	assert.throws(() => parseCoinbaseCandles([[1792800000, 1, 2, 1, 0, 1]]));
	assert.throws(() => parseCoinbaseCandles([['x', 1, 2, 1, 1, 1]]));
});

test('parseOkxCandles reads the close and the volume, and rejects an error code or a bad shape', () => {
	assert.deepEqual(
		parseOkxCandles({
			code: '0',
			data: [
				[
					'1792800900000',
					'1',
					'2',
					'1',
					'0.00512',
					'300',
					'1',
					'1',
					'1',
				],
				['1792800000000', '1', '2', '1', '0.0051', '0', '1', '1', '1'],
			],
		}),
		[
			{ start: 1792800000, close: '0.0051', volume: '0' },
			{ start: 1792800900, close: '0.00512', volume: '300' },
		]
	);
	assert.throws(() => parseOkxCandles({ code: '50011', data: [] }), /50011/);
	assert.throws(() =>
		parseOkxCandles({
			code: '0',
			data: [['1792800000000', '1', '2', '1', '-1', '1']],
		})
	);
});

test('planRequest with forward starts at the gap and takes the limit of one request', () => {
	const from = NOW - 30 * 86_400;
	const plan = planRequest(from, NOW, COINBASE_LIMIT, true);
	assert.equal(
		plan?.startSec,
		Math.floor(from / STEP_SECONDS) * STEP_SECONDS
	);
	assert.equal(plan?.limit, COINBASE_LIMIT);
	assert.equal(planRequest(NOW - 60, NOW, COINBASE_LIMIT, true), null);
});

test('candleUrl builds the request of each source', () => {
	const start = Date.parse('2026-10-30T10:00:00Z') / 1000;
	assert.equal(
		candleUrl('cb-ohlc', 'BTC-USD', start, 3),
		'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=900&start=2026-10-30T10:00:00.000Z&end=2026-10-30T10:30:00.000Z'
	);
	assert.equal(
		candleUrl('ok-ohlc', 'ZIL-USDT', start, 3),
		`https://www.okx.com/api/v5/market/history-candles?instId=ZIL-USDT&bar=15m&after=${(start + 3 * STEP_SECONDS) * 1000}&limit=100`
	);
	assert.equal(
		candleUrl('bs-ohlc', 'btcusd', start, 3),
		`https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=900&limit=3&start=${start}`
	);
	assert.equal(
		candleUrl('kr-ohlc', 'XBTUSD', start, 3),
		`https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=15&since=${start - 1}`
	);
});

test('fetchGapRows fills a long gap forward, window after window, with cb-ohlc rows', async () => {
	const urls: string[] = [];
	const logs: string[] = [];
	// 3.5 days: one window of 288 candles and a short second one
	const from = NOW - 84 * 3600;
	const firstStart = Math.floor(from / STEP_SECONDS) * STEP_SECONDS;
	const iso = (sec: number) => new Date(sec * 1000).toISOString();
	const result = await fetchGapRows(
		[{ coin: 'DOT', market: 'DOT-USD', src: 'cb-ohlc', fromSec: from }],
		options(
			[
				coinbaseAnswer([
					[iso(firstStart), 1.25, 10],
					// The last candle of the first window: it closes at the end of the window
					[
						iso(firstStart + (COINBASE_LIMIT - 1) * STEP_SECONDS),
						1.5,
						3,
					],
				]),
				coinbaseAnswer([
					// Repeated by the next window: it is taken once
					[
						iso(firstStart + (COINBASE_LIMIT - 1) * STEP_SECONDS),
						1.5,
						3,
					],
					[iso(firstStart + COINBASE_LIMIT * STEP_SECONDS), 1.75, 2],
				]),
			],
			urls,
			logs
		)
	);
	assert.equal(urls.length, 2);
	assert.ok(urls.every((url) => url.includes('/products/DOT-USD/candles?')));
	assert.deepEqual(
		result.rows.map((row) => [row.price, row.src]),
		[
			['1.25', 'cb-ohlc'],
			['1.5', 'cb-ohlc'],
			['1.75', 'cb-ohlc'],
		]
	);
	assert.deepEqual(result.pending, {});
});

test('fetchGapRows stops after MAX_REQUESTS and keeps the rest open from where it stopped', async () => {
	const urls: string[] = [];
	const from = NOW - 150 * 86_400;
	const result = await fetchGapRows(
		[
			{ coin: 'DOT', market: 'DOT-USD', src: 'cb-ohlc', fromSec: from },
			{ coin: 'BTC', market: 'btcusd', src: 'bs-ohlc', fromSec: from },
		],
		options(
			Array.from({ length: MAX_REQUESTS }, () => coinbaseAnswer([])),
			urls,
			[]
		)
	);
	assert.equal(urls.length, MAX_REQUESTS);
	const firstStart = Math.floor(from / STEP_SECONDS) * STEP_SECONDS;
	const reached = firstStart + MAX_REQUESTS * COINBASE_LIMIT * STEP_SECONDS;
	assert.deepEqual(result.pending, {
		DOT: new Date(reached * 1000).toISOString().replace('.000Z', 'Z'),
		BTC: new Date(from * 1000).toISOString().replace('.000Z', 'Z'),
	});
});

test('fetchGapRows stops only the source that answered 429', async () => {
	const urls: string[] = [];
	const from = Date.parse('2026-10-30T11:00:00Z') / 1000;
	const result = await fetchGapRows(
		[
			{ coin: 'DOT', market: 'DOT-USD', src: 'cb-ohlc', fromSec: from },
			{ coin: 'ETC', market: 'ETC-USD', src: 'cb-ohlc', fromSec: from },
			{ coin: 'BTC', market: 'btcusd', src: 'bs-ohlc', fromSec: from },
		],
		options(
			[
				{ status: 429, ms: 5, error: 'http_429' },
				answer([candle('2026-10-30T11:15:00Z', '5')]),
			],
			urls,
			[]
		)
	);
	// ETC is not asked after the 429 of Coinbase, Bitstamp is
	assert.equal(urls.length, 2);
	assert.deepEqual(
		result.rows.map((row) => [row.coin, row.src]),
		[['BTC', 'bs-ohlc']]
	);
	assert.deepEqual(Object.keys(result.pending), ['DOT', 'ETC']);
});
