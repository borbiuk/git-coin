import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { loadConfig } from '../../src/config.ts';
import { readLastRow } from '../../src/csv.ts';
import type { HttpClient, HttpRequest, HttpResult } from '../../src/types.ts';
import { createPace } from '../../tools/backfill-providers.ts';
import {
	compareCloses,
	main,
	providerFor,
	runAll,
	runTask,
	verifyCoins,
} from '../../tools/backfill.ts';
import type { RunOptions } from '../../tools/backfill.ts';

const CONFIG_PATH = join(
	import.meta.dirname,
	'..',
	'..',
	'config',
	'coins.json'
);
// 2026-10-01T00:00:00Z
const START = 1_790_812_800;
const DAY = 86_400;

let root = '';

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'git-coin-backfill-all-'));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function iso(sec: number): string {
	return new Date(sec * 1000).toISOString().replace('.000Z', 'Z');
}

async function writeRows(coin: string, lines: string[]): Promise<void> {
	const day = lines[0]?.slice(0, 10) ?? '';
	const file = join(
		root,
		'data',
		'raw',
		day.slice(0, 4),
		day.slice(5, 7),
		day.slice(8, 10),
		`${coin}.csv`
	);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `ts,price,src,age_s\n${lines.join('\n')}\n`);
}

/** A Coinbase answer with one candle per entry: `[start time, close]`. */
function coinbase(rows: Array<[number, number, number?]>): HttpResult {
	return {
		status: 200,
		ms: 1,
		json: rows.map(([time, close, volume = 5]) => [
			time,
			1,
			1,
			1,
			close,
			volume,
		]),
	};
}

function fakeHttp(
	answer: (url: string) => HttpResult
): HttpClient & { urls: string[] } {
	const urls: string[] = [];
	return {
		urls,
		async getJson(req: HttpRequest): Promise<HttpResult> {
			urls.push(req.url);
			return answer(req.url);
		},
	};
}

async function options(
	http: HttpClient,
	patch: Partial<RunOptions> = {}
): Promise<RunOptions & { lines: string[] }> {
	const lines: string[] = [];
	return {
		dataRoot: root,
		config: await loadConfig(CONFIG_PATH),
		http,
		fromSec: START,
		untilSec: START + DAY,
		sleep: async () => {},
		log: (line) => lines.push(line),
		...patch,
		lines,
	};
}

const noPace = async () => {};

test('providerFor picks Coinbase, else Kraken, else OKX', async () => {
	const config = await loadConfig(CONFIG_PATH);
	const pick = (id: string) => {
		const coin = config.coins.find((item) => item.id === id);
		assert.ok(coin);
		return providerFor(coin);
	};
	assert.equal(pick('KSM'), 'coinbase');
	assert.equal(pick('RUNE'), 'kraken-trades');
	assert.equal(pick('ZIL'), 'okx');
});

test('runTask writes the close and the end time of each candle, and leaves out empty candles', async () => {
	const http = fakeHttp(() =>
		coinbase([
			[START, 3.5],
			[START + 900, 3.6, 0],
			[START + 1800, 3.7],
		])
	);
	const opts = await options(http);
	const result = await runTask(
		{ coin: 'KSM', provider: 'coinbase', market: 'KSM-USD' },
		opts,
		noPace
	);
	assert.equal(result.written, 2);
	const file = await readFile(
		join(root, 'data', 'raw', '2026', '10', '01', 'KSM.csv'),
		'utf8'
	);
	assert.match(file, /2026-10-01T00:15:00Z,3\.5,cb-ohlc,\n/);
	assert.match(file, /2026-10-01T00:45:00Z,3\.7,cb-ohlc,\n/);
	assert.ok(!file.includes('3.6,'));
});

test('a close that differs from another source at the same time, or jumps, is left out', async () => {
	await writeRows('KSM', [
		`${iso(START + 900)},3.50,bs-ohlc,`,
		`${iso(START + 3600)},3.50,bs-ohlc,`,
	]);
	const http = fakeHttp(() =>
		coinbase([
			// 5% from Bitstamp at the same time: left out by the cross-check
			[START, 3.7],
			// a normal close
			[START + 900, 3.5],
			// 60% from the close before: left out by the step check
			[START + 1800, 5.6],
			[START + 2700, 3.55],
		])
	);
	const opts = await options(http);
	const result = await runTask(
		{ coin: 'KSM', provider: 'coinbase', market: 'KSM-USD' },
		opts,
		noPace
	);
	assert.equal(result.written, 2);
	assert.equal(result.flagged, 2);
	assert.ok(
		opts.lines.some((line) => line.includes('differs from another source'))
	);
	assert.ok(
		opts.lines.some((line) => line.includes('is a step of more than 50%'))
	);
});

test('a second run continues after the last stored row and writes nothing twice', async () => {
	const answer = () =>
		coinbase([
			[START, 1.5],
			[START + 900, 1.6],
		]);
	await runTask(
		{ coin: 'ATOM', provider: 'coinbase', market: 'ATOM-USD' },
		await options(fakeHttp(answer)),
		noPace
	);
	const again = await runTask(
		{ coin: 'ATOM', provider: 'coinbase', market: 'ATOM-USD' },
		await options(fakeHttp(answer)),
		noPace
	);
	assert.equal(again.written, 0);
	const last = await readLastRow(root, 'ATOM', 'cb-ohlc');
	assert.equal(last?.ts, iso(START + 1800));
});

test('OKX closes are stored as they are, in USDT, and are not cross-checked against USD sources', async () => {
	await writeRows('ZIL', [`${iso(START + 900)},0.0100,kr-ohlc,`]);
	const http = fakeHttp(() => ({
		status: 200,
		ms: 1,
		json: {
			code: '0',
			data: [[String(START * 1000), '1', '1', '1', '0.00192', '9']],
		},
	}));
	const result = await runTask(
		{ coin: 'ZIL', provider: 'okx', market: 'ZIL-USDT' },
		await options(http),
		noPace
	);
	assert.equal(result.written, 1);
	assert.equal((await readLastRow(root, 'ZIL', 'ok-ohlc'))?.price, '0.00192');
});

test('runAll runs the providers side by side and reports a failed task without stopping the others', async () => {
	const http = fakeHttp((url) =>
		url.includes('KSM')
			? { status: 404, ms: 1, error: 'http_other' }
			: url.includes('okx')
				? {
						status: 200,
						ms: 1,
						json: {
							code: '0',
							data: [
								[
									String(START * 1000),
									'1',
									'1',
									'1',
									'0.002',
									'9',
								],
							],
						},
					}
				: coinbase([[START, 1.5]])
	);
	const opts = await options(http);
	const run = await runAll(
		[
			{ coin: 'KSM', provider: 'coinbase', market: 'KSM-USD' },
			{ coin: 'ATOM', provider: 'coinbase', market: 'ATOM-USD' },
			{ coin: 'ZIL', provider: 'okx', market: 'ZIL-USDT' },
		],
		opts
	);
	assert.deepEqual(
		run.failed.map((task) => task.coin),
		['KSM']
	);
	assert.equal(run.written, 2);
	assert.ok(
		opts.lines.some((line) => line.startsWith('KSM (coinbase): stopped'))
	);
});

test('compareCloses gives the spread of the closes at common times', () => {
	const a = new Map([
		[1, 100],
		[2, 100],
		[3, 100],
		[4, 100],
	]);
	const b = new Map([
		[1, 100],
		[2, 100.1],
		[3, 103],
		[9, 1],
	]);
	const stats = compareCloses(a, b, 2);
	assert.equal(stats.count, 3);
	assert.equal(stats.over, 1);
	assert.ok(stats.median > 0.05 && stats.median < 0.2);
	assert.ok(stats.max > 2.9 && stats.max < 3.1);
	assert.deepEqual(compareCloses(new Map(), b, 2).count, 0);
});

test('verifyCoins compares the sources that have the same times', async () => {
	await writeRows('KSM', [
		`${iso(START + 900)},3.50,bs-ohlc,`,
		`${iso(START + 1800)},3.60,bs-ohlc,`,
		`${iso(START + 900)},3.51,cb-ohlc,`,
		`${iso(START + 1800)},3.60,cb-ohlc,`,
	]);
	const found = await verifyCoins(
		['KSM'],
		await options(fakeHttp(() => coinbase([])))
	);
	assert.equal(found.length, 1);
	assert.deepEqual(
		[found[0]?.a, found[0]?.b, found[0]?.count],
		['cb-ohlc', 'bs-ohlc', 2]
	);
});

async function run(
	argv: string[],
	http: HttpClient = fakeHttp(() => coinbase([]))
) {
	let out = '';
	let err = '';
	const code = await main(argv, {
		out: (text) => (out += text),
		err: (text) => (err += text),
		http,
		sleep: async () => {},
		now: () => new Date('2026-10-02T00:07:00Z'),
	});
	return { code, out, err };
}

test('a dry run with --coins lists the provider of each coin and calls nothing', async () => {
	const http = fakeHttp(() => coinbase([]));
	const { code, out } = await run(
		[
			'--data-root',
			root,
			'--config',
			CONFIG_PATH,
			'--coins',
			'ATOM,RUNE,ZIL',
			'--from',
			'2026-10-01T00:00:00Z',
			'--dry-run',
		],
		http
	);
	assert.equal(code, 0);
	assert.match(
		out,
		/^3 tasks from 2026-10-01T00:00:00Z to 2026-10-02T00:00:00Z/
	);
	assert.match(out, /ATOM\s+coinbase ATOM-USD: up to 1 requests/);
	assert.match(
		out,
		/RUNE\s+kraken-trades RUNEUSD: about one request per 1000 trades/
	);
	assert.match(out, /ZIL\s+okx ZIL-USDT: up to 1 requests/);
	assert.equal(http.urls.length, 0);
});

test('without --coins the coins that have enough 15 minute closes are left out', async () => {
	const lines = Array.from(
		{ length: 96 },
		(_, i) => `${iso(START + (i + 1) * 900)},100,bs-ohlc,`
	);
	await writeRows('BTC', lines.slice(0, 95));
	await writeFile(
		join(root, 'data', 'raw', '2026', '10', '02', 'BTC.csv').replace(
			'02/BTC',
			'02/BTC'
		),
		'',
		{ flag: 'a' }
	).catch(() => {});
	const { out } = await run([
		'--data-root',
		root,
		'--config',
		CONFIG_PATH,
		'--from',
		'2026-10-01T00:00:00Z',
		'--until',
		'2026-10-02T00:00:00Z',
		'--min-coverage',
		'0.9',
		'--dry-run',
	]);
	assert.ok(!/\bBTC\b/.test(out), 'BTC has 95 of 96 closes');
	assert.match(out, /ETH\s+coinbase/);
	assert.ok(
		!/USDT\s/.test(out.split('\n').slice(1).join('\n')),
		'the rate entry is not filled'
	);
});

test('--provider limits the run to the coins that have its market', async () => {
	const { out } = await run([
		'--data-root',
		root,
		'--config',
		CONFIG_PATH,
		'--provider',
		'okx',
		'--from',
		'2026-10-01T00:00:00Z',
		'--dry-run',
	]);
	assert.match(out, /^1 tasks/);
	assert.match(out, /ZIL\s+okx/);
});

test('bad input is refused with exit code 1', async () => {
	assert.equal((await run([])).code, 1);
	assert.equal(
		(await run(['--data-root', root, '--provider', 'binance'])).code,
		1
	);
	assert.equal(
		(await run(['--data-root', root, '--min-coverage', '2'])).code,
		1
	);
	const off = await run([
		'--data-root',
		root,
		'--from',
		'2026-10-01T00:07:00Z',
	]);
	assert.equal(off.code, 1);
	assert.match(off.err, /15 minute mark/);
});

test('a failed task gives exit code 1 and the message to run again', async () => {
	const { code, err } = await run(
		[
			'--data-root',
			root,
			'--config',
			CONFIG_PATH,
			'--coins',
			'KSM',
			'--from',
			'2026-10-01T00:00:00Z',
		],
		fakeHttp(() => ({ status: 404, ms: 1, error: 'http_other' }))
	);
	assert.equal(code, 1);
	assert.match(err, /stopped: KSM \(coinbase\)\. Run again/);
});

test('createPace is used with a plain sleep', async () => {
	const pace = createPace(0, async () => {});
	await pace();
});
