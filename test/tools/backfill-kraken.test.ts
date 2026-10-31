import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { readLastRow } from '../../src/csv.ts';
import type { HttpClient, HttpRequest, HttpResult } from '../../src/types.ts';
import { backfillMarket, main } from '../../tools/backfill-kraken.ts';
import type { BackfillOptions } from '../../tools/backfill-kraken.ts';

const DAY = 86_400;
// 2026-10-01T00:00:00Z
const START = 1_790_812_800;
const CONFIG = join(import.meta.dirname, '..', '..', 'config', 'coins.json');

let root = '';

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'git-coin-backfill-kraken-'));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** A daily candle in the shape of the Kraken `OHLC` answer. */
function candle(day: number, close: string, volume = '5') {
	return [START + day * DAY, close, close, close, close, close, volume, 3];
}

function answer(candles: unknown[]): HttpResult {
	return {
		status: 200,
		ms: 1,
		json: { error: [], result: { KSMUSD: candles, last: START } },
	};
}

function fakeHttp(script: HttpResult[]): HttpClient & { urls: string[] } {
	const urls: string[] = [];
	return {
		urls,
		async getJson(req: HttpRequest): Promise<HttpResult> {
			urls.push(req.url);
			return script.shift() ?? answer([]);
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
		untilSec: START + 10 * DAY,
		pauseMs: 1000,
		sleep: async (ms) => {
			waits.push(ms);
		},
		log: (line) => lines.push(line),
		...patch,
		waits,
		lines,
	};
}

test('backfillMarket writes the close time and the close price, and leaves out empty and later candles', async () => {
	const http = fakeHttp([
		answer([
			candle(0, '3.1'),
			candle(1, '3.2', '0'),
			candle(2, '3.3'),
			// closes after the end of the range
			candle(10, '9'),
		]),
	]);
	const result = await backfillMarket(
		{ coin: 'KSM', market: 'KSMUSD' },
		options(http)
	);
	assert.deepEqual(result, { written: 2, skipped: 0 });
	assert.match(http.urls[0] ?? '', /OHLC\?pair=KSMUSD&interval=1440$/);
	const last = await readLastRow(root, 'KSM', 'kr-ohlc');
	assert.equal(last?.ts, '2026-10-04T00:00:00Z');
	assert.equal(last?.price, '3.3');
});

test('a second run continues after the last stored row and writes nothing twice', async () => {
	const candles = [candle(0, '1'), candle(1, '2'), candle(2, '3')];
	await backfillMarket(
		{ coin: 'KSM', market: 'KSMUSD' },
		options(fakeHttp([answer(candles.slice(0, 2))]))
	);
	const again = await backfillMarket(
		{ coin: 'KSM', market: 'KSMUSD' },
		options(fakeHttp([answer(candles)]))
	);
	assert.deepEqual(again, { written: 1, skipped: 0 });
});

test('a rate limit text in a 200 answer is waited out, and a bad answer stops the run', async () => {
	const limited: HttpResult = {
		status: 200,
		ms: 1,
		json: { error: ['EAPI:Rate limit exceeded'] },
	};
	const waiting = options(fakeHttp([limited, answer([candle(0, '1')])]));
	const result = await backfillMarket(
		{ coin: 'KSM', market: 'KSMUSD' },
		waiting
	);
	assert.equal(result.written, 1);
	assert.deepEqual(waiting.waits, [30_000]);

	const bad: HttpResult = {
		status: 200,
		ms: 1,
		json: { error: ['EQuery:Unknown asset pair'] },
	};
	await assert.rejects(
		backfillMarket(
			{ coin: 'KSM', market: 'KSMUSD' },
			options(fakeHttp([bad]))
		),
		/Unknown asset pair/
	);
});

test('main asks only the coins that have no Bitstamp market', async () => {
	const out: string[] = [];
	const code = await main(
		['--data-root', root, '--config', CONFIG, '--dry-run'],
		{
			out: (text) => out.push(text),
			err: (text) => out.push(text),
		}
	);
	assert.equal(code, 0);
	const text = out.join('');
	for (const market of [
		'TRXUSD',
		'ATOMUSD',
		'ETCUSD',
		'RUNEUSD',
		'KSMUSD',
		'SCUSD',
		'EGLDUSD',
		'MINAUSD',
		'CAKEUSD',
	]) {
		assert.ok(text.includes(market), market);
	}
	assert.ok(!text.includes('XBTUSD'));
	assert.match(text, /^9 markets/);
});

test('main refuses a missing data root and a too short pause', async () => {
	const errors: string[] = [];
	const io = { out: () => {}, err: (text: string) => errors.push(text) };
	assert.equal(await main([], io), 1);
	assert.equal(await main(['--data-root', root, '--pause-ms', '100'], io), 1);
	assert.equal(errors.length, 2);
});

test('--only takes the Kraken market of a coin that also has a Bitstamp market', async () => {
	const out: string[] = [];
	const code = await main(
		[
			'--data-root',
			root,
			'--config',
			CONFIG,
			'--only',
			'TRX,KSM',
			'--dry-run',
		],
		{ out: (text) => out.push(text), err: (text) => out.push(text) }
	);
	assert.equal(code, 0);
	assert.match(out.join(''), /^2 markets[\s\S]*TRXUSD KSMUSD/);
});
