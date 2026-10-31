import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { HttpClient, HttpRequest, HttpResult } from '../../src/types.ts';
import {
	COINBASE_WINDOW_SECONDS,
	coinbaseUrl,
	createCandleBuilder,
	createPace,
	fetchCoinbase,
	fetchKrakenTrades,
	fetchOkx,
	krakenTradesUrl,
	okxUrl,
	parseCoinbaseCandles,
	parseKrakenTrades,
	parseOkxCandles,
} from '../../tools/backfill-providers.ts';
import type {
	CandleClose,
	FetchContext,
} from '../../tools/backfill-providers.ts';

// 2026-10-01T00:00:00Z
const START = 1_790_812_800;

function context(script: HttpResult[], urls: string[] = []): FetchContext {
	const http: HttpClient = {
		async getJson(req: HttpRequest): Promise<HttpResult> {
			urls.push(req.url);
			return script.shift() ?? { status: 200, ms: 1, json: [] };
		},
	};
	return {
		http,
		pace: async () => {},
		sleep: async () => {},
		log: () => {},
	};
}

function json(body: unknown): HttpResult {
	return { status: 200, ms: 1, json: body };
}

test('parseCoinbaseCandles takes the close and the end time, oldest first, and refuses an exponent price', () => {
	const candles = parseCoinbaseCandles([
		[START + 900, 1, 3, 2, 2.5, 10],
		[START, 1, 3, 2, 0.000754, 4],
	]);
	assert.deepEqual(candles, [
		{ endSec: START + 900, close: '0.000754', volume: '4' },
		{ endSec: START + 1800, close: '2.5', volume: '10' },
	]);
	assert.throws(
		() => parseCoinbaseCandles([[START, 1, 1, 1, 1e-7, 1]]),
		/exponent/
	);
	assert.throws(() => parseCoinbaseCandles({}), /not a list/);
	assert.throws(
		() => parseCoinbaseCandles([['x', 1, 1, 1, 1, 1]]),
		/no time/
	);
});

test('fetchCoinbase asks window by window up to the end and passes each window on', async () => {
	const urls: string[] = [];
	const got: CandleClose[][] = [];
	const until = START + 2 * COINBASE_WINDOW_SECONDS + 3600;
	const requests = await fetchCoinbase(
		'KSM-USD',
		START,
		until,
		context(
			[
				json([[START, 1, 1, 1, 5, 1]]),
				json([[START + COINBASE_WINDOW_SECONDS, 1, 1, 1, 6, 1]]),
				json([[until - 900, 1, 1, 1, 7, 1]]),
			],
			urls
		),
		async (candles) => {
			got.push(candles);
		}
	);
	assert.equal(requests, 3);
	assert.equal(urls.length, 3);
	assert.equal(
		urls[0],
		coinbaseUrl('KSM-USD', START, START + COINBASE_WINDOW_SECONDS)
	);
	assert.match(urls[2] ?? '', /end=2026-10-07T01:/);
	assert.deepEqual(
		got.map((window) => window.map((item) => item.close)),
		[['5'], ['6'], ['7']]
	);
});

test('parseOkxCandles reads text prices and refuses an error code', () => {
	const candles = parseOkxCandles({
		code: '0',
		data: [
			['1790813700000', '1', '2', '1', '0.00192', '5', '0', '0', '1'],
			['1790812800000', '1', '2', '1', '0.00191', '0', '0', '0', '1'],
		],
	});
	assert.deepEqual(candles, [
		{ endSec: START + 900, close: '0.00191', volume: '0' },
		{ endSec: START + 1800, close: '0.00192', volume: '5' },
	]);
	assert.throws(
		() => parseOkxCandles({ code: '51001', data: [] }),
		/code 51001/
	);
	assert.throws(
		() =>
			parseOkxCandles({
				code: '0',
				data: [['1', '1', '1', '1', '1', '1']],
			}),
		/no time/
	);
});

test('fetchOkx pages back in time, stops at the start and returns the candles in time order', async () => {
	const urls: string[] = [];
	const page = (from: number, count: number) => ({
		code: '0',
		data: Array.from({ length: count }, (_, i) => [
			String((from + (count - 1 - i) * 900) * 1000),
			'1',
			'1',
			'1',
			String(1 + i),
			'3',
		]),
	});
	const until = START + 200 * 900;
	const found = await fetchOkx(
		'ZIL-USDT',
		START,
		until,
		context(
			[json(page(START + 100 * 900, 100)), json(page(START, 100))],
			urls
		)
	);
	assert.equal(found.requests, 2);
	assert.equal(found.candles.length, 200);
	assert.equal(found.candles[0]?.endSec, START + 900);
	assert.equal(found.candles[199]?.endSec, until);
	assert.equal(urls[0], okxUrl('ZIL-USDT', (until - 900) * 1000 + 1));
});

test('createCandleBuilder closes a candle with the last trade of its 15 minutes', () => {
	const builder = createCandleBuilder();
	assert.deepEqual(
		builder.push({ time: START + 10, price: '1', volume: '2' }),
		[]
	);
	assert.deepEqual(
		builder.push({ time: START + 800, price: '2', volume: '3' }),
		[]
	);
	const done = builder.push({ time: START + 1000, price: '9', volume: '1' });
	assert.deepEqual(done, [{ endSec: START + 900, close: '2', volume: '5' }]);
	// The open candle is complete only when its end is at or before the limit
	assert.deepEqual(builder.flush(START + 1000), []);
	assert.deepEqual(builder.flush(START + 1800), [
		{ endSec: START + 1800, close: '9', volume: '1' },
	]);
	assert.deepEqual(builder.flush(START + 9000), []);
});

test('parseKrakenTrades reads the price text and the cursor, and refuses an error', () => {
	const trades = parseKrakenTrades({
		error: [],
		result: {
			RUNEUSD: [['0.650', '12.5', START + 1.5, 'b', 'l', '', 1]],
			last: '1790812801500000000',
		},
	});
	assert.deepEqual(trades, {
		trades: [{ time: START + 1.5, price: '0.650', volume: '12.5' }],
		last: '1790812801500000000',
	});
	assert.throws(
		() => parseKrakenTrades({ error: ['EAPI:Rate limit exceeded'] }),
		/Rate limit/
	);
	assert.throws(
		() => parseKrakenTrades({ error: [], result: {} }),
		/no trade list/
	);
});

test('fetchKrakenTrades builds candles from pages and flushes the last one at the end', async () => {
	const urls: string[] = [];
	const got: CandleClose[] = [];
	const page = (rows: Array<[string, number]>, last: string): HttpResult =>
		json({
			error: [],
			result: {
				RUNEUSD: rows.map(([price, time]) => [
					price,
					'1',
					time,
					'b',
					'l',
					'',
					1,
				]),
				last,
			},
		});
	const requests = await fetchKrakenTrades(
		'RUNEUSD',
		START,
		START + 2700,
		context(
			[
				page(
					[
						['1', START + 10],
						['2', START + 800],
					],
					'111'
				),
				page(
					[
						['3', START + 1000],
						['4', START + 1700],
					],
					'222'
				),
				// a trade at the end time is not used
				page([['9', START + 2700]], '333'),
			],
			urls
		),
		async (candles) => {
			got.push(...candles);
		}
	);
	assert.equal(requests, 3);
	assert.equal(urls[0], krakenTradesUrl('RUNEUSD', `${START}000000000`));
	assert.equal(urls[1], krakenTradesUrl('RUNEUSD', '111'));
	assert.deepEqual(
		got.map((item) => [item.endSec - START, item.close]),
		[
			[900, '2'],
			[1800, '4'],
		]
	);
});

test('createPace spaces the starts of the requests whoever asks', async () => {
	let clock = 1000;
	const waits: number[] = [];
	const pace = createPace(
		100,
		async (ms) => {
			waits.push(ms);
			clock += ms;
		},
		() => clock
	);
	await Promise.all([pace(), pace(), pace()]);
	// The starts are at 1000, 1100 and 1200
	assert.deepEqual(waits, [100, 100]);
	assert.equal(clock, 1200);
});
