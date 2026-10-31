import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isoSeconds } from '../../src/time.ts';
import type {
	ErrorCode,
	PriceRow,
	RequestLogRow,
	SrcCode,
} from '../../src/types.ts';
import {
	analyze,
	DEFAULT_THRESHOLDS,
	loadData,
	main,
	renderMarkdown,
	type AnalysisData,
	type Report,
} from '../../tools/analyze-sources.ts';

const FIXTURE_ROOT = fileURLToPath(
	new URL('../fixtures/analyze/small', import.meta.url)
);
const BASE_MS = Date.parse('2026-11-01T00:00:00Z');

/** The time `seconds` after the start of the test day. */
function at(seconds: number): string {
	return isoSeconds(new Date(BASE_MS + seconds * 1000));
}

function row(
	seconds: number,
	coin: string,
	price: string,
	src: SrcCode,
	age: number | null = null
): PriceRow {
	return { ts: at(seconds), coin, price, src, age_s: age };
}

function tick(
	seconds: number,
	src: SrcCode,
	overrides: Partial<RequestLogRow> = {}
): RequestLogRow {
	return {
		ts: at(seconds),
		src,
		http: 200,
		ms: 100,
		coins_ok: 2,
		error: '',
		...overrides,
	};
}

const FAILED: Partial<RequestLogRow> = {
	http: 500,
	coins_ok: 0,
	error: 'http_other' as ErrorCode,
};

const TWO_COINS = { ...DEFAULT_THRESHOLDS, expected_coins: 2 };

function dataOf(rows: PriceRow[], log: RequestLogRow[]): AnalysisData {
	return { rows, log, skipped_lines: 0 };
}

/** One source with 100 ticks, 15 minutes apart, where the ticks in `failing` fail. */
function hundredTicks(src: SrcCode, failing: number[]): AnalysisData {
	const log = Array.from({ length: 100 }, (_, i) =>
		tick(i * 900, src, failing.includes(i) ? FAILED : {})
	);
	return dataOf([], log);
}

function gateOf(report: Report, src: SrcCode) {
	const found = report.gate.find((g) => g.src === src);
	assert.ok(found, `no gate row for ${src}`);
	return found;
}

describe('loadData', () => {
	test('reads the daily files and the request logs of a data root', async () => {
		const data = await loadData(FIXTURE_ROOT);
		// 18 Kraken, 24 Coinbase, 22 Bitstamp and 23 Coin Metrics rows. The backfill row is not counted.
		assert.equal(data.rows.length, 87);
		assert.equal(data.log.length, 48);
		assert.ok(data.rows.every((r) => r.src !== ('kr-ohlc' as SrcCode)));
		const first = data.rows.find((r) => r.src === 'cb');
		assert.deepEqual(first, {
			ts: '2026-11-01T00:00:02Z',
			coin: 'BTC',
			price: '100.00',
			src: 'cb',
			age_s: 2,
		});
	});

	test('counts malformed lines and keeps reading', async () => {
		const data = await loadData(FIXTURE_ROOT);
		// "not a row", a row with the price "abc", and a request log row with three fields
		assert.equal(data.skipped_lines, 3);
	});

	test('leaves the market files out, so their lines are not counted as malformed prices', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'analyze-market-'));
		try {
			const day = join(dir, 'data', 'raw', '2026', '11', '01');
			await mkdir(day, { recursive: true });
			await writeFile(
				join(day, 'BTC.csv'),
				'ts,price,src,age_s\n2026-11-01T00:00:00Z,100.00,kr,\n'
			);
			await writeFile(
				join(day, 'BTC.market.csv'),
				'ts,src,bid,ask,volume,market_cap,volume_usd,supply,tx_count,active_addresses,hash_rate,as_of\n2026-11-01T00:00:00Z,kr,99.9,100.1,20,,,,,,,\n'
			);
			const data = await loadData(dir);
			assert.equal(data.rows.length, 1);
			assert.equal(data.skipped_lines, 0);
		} finally {
			await rm(dir, { recursive: true });
		}
	});

	test('returns nothing for a root without data files', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'analyze-empty-'));
		try {
			const data = await loadData(dir);
			assert.deepEqual(data, { rows: [], log: [], skipped_lines: 0 });
		} finally {
			await rm(dir, { recursive: true });
		}
	});
});

describe('analyze: the planted fixture', () => {
	let report: Report;
	before(async () => {
		report = analyze(await loadData(FIXTURE_ROOT), TWO_COINS);
	});

	test('lists the four sources and the period', () => {
		assert.deepEqual(
			report.gate.map((g) => g.src),
			['kr', 'cb', 'bs', 'cm']
		);
		assert.equal(report.period.from, '2026-11-01T00:00:01Z');
		assert.equal(report.period.to, '2026-11-02T00:15:04Z');
		assert.equal(report.skipped_lines, 3);
	});

	test('Kraken has a failure streak of 3 and misses the availability gate', () => {
		const g = gateOf(report, 'kr');
		assert.equal(g.ticks, 12);
		assert.equal(g.ok_ticks, 9);
		assert.equal(g.availability_percent, 75);
		assert.equal(g.availability_pass, false);
		assert.equal(g.longest_fail_streak, 3);
		assert.equal(g.streak_pass, true);
		assert.equal(g.min_coins_per_tick, 0);
		assert.equal(g.avg_coins_per_tick, 1.5);
		assert.equal(g.blocked_ticks, 0);
		assert.equal(g.eligible, false);
	});

	test('Coinbase passes every gate', () => {
		const g = gateOf(report, 'cb');
		assert.equal(g.availability_percent, 100);
		assert.equal(g.longest_fail_streak, 0);
		assert.equal(g.coins_seen, 2);
		assert.equal(g.avg_coins_per_tick, 2);
		assert.equal(g.eligible, true);
	});

	test('Bitstamp has one 429 tick, which is over the block share', () => {
		const g = gateOf(report, 'bs');
		assert.equal(g.ok_ticks, 11);
		assert.equal(g.availability_percent, 91.6667);
		assert.equal(g.longest_fail_streak, 1);
		assert.equal(g.blocked_ticks, 1);
		assert.equal(g.block_percent, 8.3333);
		assert.equal(g.block_pass, false);
		assert.equal(g.eligible, false);
	});

	test('Coin Metrics has one unmapped tick, which fails the mapping gate', () => {
		const g = gateOf(report, 'cm');
		assert.equal(g.unmapped_ticks, 1);
		assert.equal(g.coins_seen, 2);
		assert.equal(g.min_coins_per_tick, 1);
		assert.equal(g.avg_coins_per_tick, 1.9167);
		assert.equal(g.mapping_pass, false);
		assert.equal(g.eligible, false);
	});

	test('the planted 2% outlier shows up in Bitstamp BTC and nowhere else', () => {
		const planted = report.deviations.find(
			(d) => d.src === 'bs' && d.coin === 'BTC'
		);
		assert.deepEqual(planted, {
			src: 'bs',
			coin: 'BTC',
			points: 11,
			p50: 0,
			p95: 2,
			max: 2,
			over: 1,
			bias: 0,
			sd: 0.575,
		});
		const others = report.deviations.filter(
			(d) => !(d.src === 'bs' && d.coin === 'BTC')
		);
		assert.equal(others.length, 7);
		for (const d of others) {
			assert.equal(d.max, 0, `${d.src} ${d.coin}`);
			assert.equal(d.over, 0, `${d.src} ${d.coin}`);
		}
	});

	test('counts the points per source and coin', () => {
		const points = Object.fromEntries(
			report.deviations.map((d) => [`${d.src}-${d.coin}`, d.points])
		);
		assert.deepEqual(points, {
			'kr-BTC': 9,
			'kr-ETH': 9,
			'cb-BTC': 12,
			'cb-ETH': 12,
			'bs-BTC': 11,
			'bs-ETH': 11,
			'cm-BTC': 12,
			'cm-ETH': 11,
		});
	});

	test('score rows hold the freshness, latency and request counts', () => {
		const byId = Object.fromEntries(report.score.map((s) => [s.src, s]));
		assert.equal(byId.kr?.freshness, null);
		assert.deepEqual(byId.cb?.freshness, {
			rows: 24,
			p50: 2,
			p95: 12,
			max: 12,
		});
		assert.deepEqual(byId.bs?.freshness, {
			rows: 22,
			p50: 1,
			p95: 1,
			max: 1,
		});
		assert.deepEqual(byId.cm?.freshness, {
			rows: 23,
			p50: 60,
			p95: 60,
			max: 60,
		});
		// Failed ticks are left out of the latency
		assert.deepEqual(byId.kr?.latency, { ticks: 9, p50: 140, p95: 180 });
		assert.deepEqual(byId.cb?.latency, { ticks: 12, p50: 200, p95: 200 });
		assert.deepEqual(byId.bs?.latency, { ticks: 11, p50: 300, p95: 300 });
		assert.deepEqual(byId.cm?.latency, { ticks: 11, p50: 400, p95: 400 });
		assert.deepEqual(
			report.score.map((s) => s.requests_per_run),
			[2, 10, 1, 1]
		);
		// The combined row of Bitstamp: 22 points, one of them 2% off
		assert.deepEqual(byId.bs?.deviation, {
			src: 'bs',
			coin: 'ALL',
			points: 22,
			p50: 0,
			p95: 0,
			max: 2,
			over: 1,
			bias: 0,
			sd: 0.4166,
		});
	});
});

describe('analyze: gate rules', () => {
	test('98% availability passes and 97% fails', () => {
		const pass = analyze(hundredTicks('cb', [10, 50]), TWO_COINS);
		assert.equal(gateOf(pass, 'cb').availability_percent, 98);
		assert.equal(gateOf(pass, 'cb').availability_pass, true);
		const fail = analyze(hundredTicks('cb', [10, 50, 90]), TWO_COINS);
		assert.equal(gateOf(fail, 'cb').availability_percent, 97);
		assert.equal(gateOf(fail, 'cb').availability_pass, false);
	});

	test('a streak of 3 passes and a streak of 4 fails', () => {
		const three = gateOf(
			analyze(hundredTicks('cb', [20, 21, 22]), TWO_COINS),
			'cb'
		);
		assert.equal(three.longest_fail_streak, 3);
		assert.equal(three.streak_pass, true);
		const four = gateOf(
			analyze(hundredTicks('cb', [20, 21, 22, 23]), TWO_COINS),
			'cb'
		);
		assert.equal(four.longest_fail_streak, 4);
		assert.equal(four.streak_pass, false);
	});

	test('the streak is counted in time order, not in file order', () => {
		const log = [
			tick(1800, 'cb', FAILED),
			tick(0, 'cb', FAILED),
			tick(2700, 'cb'),
			tick(900, 'cb', FAILED),
		];
		const g = gateOf(analyze(dataOf([], log), TWO_COINS), 'cb');
		assert.equal(g.longest_fail_streak, 3);
	});

	test('a tick with too few coins counts as failed', () => {
		const log = [tick(0, 'cb'), tick(900, 'cb', { coins_ok: 1 })];
		const g = gateOf(analyze(dataOf([], log), TWO_COINS), 'cb');
		assert.equal(g.ok_ticks, 1);
		assert.equal(g.availability_percent, 50);
	});

	test('an error on an HTTP 200 tick counts as failed, and http_429 counts as a block', () => {
		const log = [
			tick(0, 'bs', { error: 'http_429' }),
			tick(900, 'bs', { http: 403, coins_ok: 0, error: 'http_other' }),
			tick(1800, 'bs', { http: 451, coins_ok: 0, error: 'http_other' }),
			tick(2700, 'bs', { http: 500, coins_ok: 0, error: 'http_other' }),
		];
		const g = gateOf(analyze(dataOf([], log), TWO_COINS), 'bs');
		assert.equal(g.ok_ticks, 0);
		assert.equal(g.blocked_ticks, 3);
		assert.equal(g.block_percent, 75);
	});

	test('mapping needs every expected coin in the data', () => {
		const rows = [row(0, 'BTC', '100.00', 'cb')];
		const log = [tick(0, 'cb', { coins_ok: 1 })];
		const g = gateOf(analyze(dataOf(rows, log), TWO_COINS), 'cb');
		assert.equal(g.coins_seen, 1);
		assert.equal(g.mapping_pass, false);
	});

	test('the thresholds are options', () => {
		const data = hundredTicks('cb', [10, 50, 90]);
		const strict = analyze(data, TWO_COINS);
		assert.equal(gateOf(strict, 'cb').availability_pass, false);
		const relaxed = analyze(data, {
			...TWO_COINS,
			min_availability_percent: 95,
		});
		assert.equal(gateOf(relaxed, 'cb').availability_pass, true);
	});

	test('rows of other sources are not analysed', () => {
		const data = dataOf(
			[row(0, 'BTC', '100.00', 'kr-ohlc')],
			[tick(0, 'kr-ohlc')]
		);
		assert.deepEqual(analyze(data, TWO_COINS).gate, []);
	});
});

describe('analyze: deviation from the consensus', () => {
	function threeAt100(seconds: number, krPrice: string): PriceRow[] {
		return [
			row(seconds, 'BTC', krPrice, 'kr'),
			row(seconds + 1, 'BTC', '100.00', 'cb'),
			row(seconds + 2, 'BTC', '100.00', 'bs'),
		];
	}

	function krBtc(report: Report) {
		return report.deviations.find(
			(d) => d.src === 'kr' && d.coin === 'BTC'
		);
	}

	test('uses the median of the others, so one wild source does not move it', () => {
		const rows = [
			row(0, 'BTC', '100.50', 'kr'),
			row(1, 'BTC', '100.00', 'cb'),
			row(2, 'BTC', '100.00', 'bs'),
			row(3, 'BTC', '130.00', 'cm'),
		];
		const report = analyze(dataOf(rows, []), TWO_COINS);
		assert.equal(krBtc(report)?.bias, 0.5);
		assert.equal(krBtc(report)?.max, 0.5);
	});

	test('counts only points more than the outlier percent off', () => {
		const report = analyze(
			dataOf(
				[
					...threeAt100(0, '101.00'),
					...threeAt100(900, '101.50'),
					...threeAt100(1800, '99.00'),
					...threeAt100(2700, '98.00'),
				],
				[]
			),
			TWO_COINS
		);
		// Exactly 1% is not over. 1.5% and 2% are over.
		assert.equal(krBtc(report)?.over, 2);
		assert.equal(krBtc(report)?.max, 2);
	});

	test('uses rows within the window and ignores rows outside it', () => {
		const inside = analyze(
			dataOf(
				[
					row(0, 'BTC', '101.00', 'kr'),
					row(300, 'BTC', '100.00', 'cb'),
				],
				[]
			),
			TWO_COINS
		);
		assert.equal(krBtc(inside)?.points, 1);
		assert.equal(krBtc(inside)?.max, 1);
		const outside = analyze(
			dataOf(
				[
					row(0, 'BTC', '101.00', 'kr'),
					row(301, 'BTC', '100.00', 'cb'),
				],
				[]
			),
			TWO_COINS
		);
		assert.equal(krBtc(outside), undefined);
		assert.equal(outside.score[0]?.deviation, null);
	});

	test('takes the closest row of each other source, one value per source', () => {
		const rows = [
			row(100, 'BTC', '100.00', 'kr'),
			// Two Coinbase rows: the closer one (101.00) counts, the farther one (200.00) does not
			row(90, 'BTC', '101.00', 'cb'),
			row(250, 'BTC', '200.00', 'cb'),
		];
		const report = analyze(dataOf(rows, []), TWO_COINS);
		const kr = krBtc(report);
		assert.equal(kr?.points, 1);
		assert.equal(kr?.bias, -0.9901);
	});

	test('keeps the coins apart', () => {
		const rows = [
			row(0, 'BTC', '100.00', 'kr'),
			row(1, 'ETH', '50.00', 'cb'),
		];
		const report = analyze(dataOf(rows, []), TWO_COINS);
		assert.deepEqual(report.deviations, []);
	});

	test('a steady offset has a bias and no spread, a noisy source has the opposite', () => {
		const rows: PriceRow[] = [];
		for (let i = 0; i < 10; i++) {
			const s = i * 900;
			rows.push(
				row(s, 'BTC', '100.00', 'kr'),
				row(s + 1, 'BTC', '100.00', 'cb'),
				row(s + 2, 'BTC', '100.00', 'bs'),
				row(s + 3, 'BTC', '100.50', 'cm'),
				row(s + 4, 'ETH', '50.00', 'kr'),
				row(s + 5, 'ETH', '50.00', 'cb'),
				row(s + 6, 'ETH', '50.00', 'bs'),
				row(s + 7, 'ETH', i % 2 === 0 ? '50.25' : '49.75', 'cm')
			);
		}
		const report = analyze(dataOf(rows, []), TWO_COINS);
		const cmBtc = report.deviations.find(
			(d) => d.src === 'cm' && d.coin === 'BTC'
		);
		const cmEth = report.deviations.find(
			(d) => d.src === 'cm' && d.coin === 'ETH'
		);
		assert.equal(cmBtc?.bias, 0.5);
		assert.equal(cmBtc?.sd, 0);
		assert.equal(cmBtc?.p50, 0.5);
		assert.equal(cmEth?.bias, 0);
		assert.equal(cmEth?.sd, 0.5);
		assert.equal(cmEth?.p50, 0.5);
		const krBtc2 = report.deviations.find(
			(d) => d.src === 'kr' && d.coin === 'BTC'
		);
		assert.equal(krBtc2?.max, 0);
	});

	test('the outlier percent is an option', () => {
		const data = dataOf(threeAt100(0, '100.50'), []);
		const strict = analyze(data, { ...TWO_COINS, outlier_percent: 0.1 });
		assert.equal(krBtc(strict)?.over, 1);
		const loose = analyze(data, { ...TWO_COINS, outlier_percent: 1 });
		assert.equal(krBtc(loose)?.over, 0);
	});
});

describe('renderMarkdown', () => {
	test('has the three tables with names and marks', async () => {
		const report = analyze(await loadData(FIXTURE_ROOT), TWO_COINS);
		const text = renderMarkdown(report);
		assert.match(text, /^# Source analysis/);
		assert.match(text, /## Gate \(ADR 0002 Revision 2, point 7\)/);
		assert.match(text, /## Score \(ADR 0002 Revision 2, point 8\)/);
		assert.match(text, /## Deviation per coin/);
		assert.match(text, /\| Kraken \| 12 \| 9 \| 75 FAIL \| 3 pass \|/);
		assert.match(
			text,
			/\| Coinbase Exchange \| 12 \| 12 \| 100 pass \| 0 pass \|/
		);
		// Kraken has no freshness
		assert.match(
			text,
			/\| Kraken \| 75 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| n\/a \| n\/a \| 140 \| 180 \| 2 \|/
		);
	});
});

describe('main', () => {
	function run(args: string[]) {
		let out = '';
		let err = '';
		const done = main(args, {
			out: (text) => {
				out += text;
			},
			err: (text) => {
				err += text;
			},
		});
		return done.then((code) => ({ code, out, err }));
	}

	test('prints Markdown by default', async () => {
		const result = await run([
			'--data-root',
			FIXTURE_ROOT,
			'--expected-coins',
			'2',
		]);
		assert.equal(result.code, 0);
		assert.match(result.out, /^# Source analysis/);
		assert.match(
			result.out,
			/\| Coinbase Exchange \| 12 \| 12 \| 100 pass \|/
		);
		assert.equal(result.err, '');
	});

	test('prints JSON with --json', async () => {
		const result = await run([
			'--data-root',
			FIXTURE_ROOT,
			'--expected-coins',
			'2',
			'--json',
		]);
		assert.equal(result.code, 0);
		const parsed = JSON.parse(result.out) as Report;
		assert.equal(parsed.thresholds.expected_coins, 2);
		assert.equal(parsed.thresholds.min_availability_percent, 98);
		assert.deepEqual(
			parsed.gate.map((g) => [g.src, g.eligible]),
			[
				['kr', false],
				['cb', true],
				['bs', false],
				['cm', false],
			]
		);
	});

	test('threshold options change the verdict', async () => {
		const result = await run([
			'--data-root',
			FIXTURE_ROOT,
			'--expected-coins',
			'2',
			'--min-availability',
			'70',
			'--max-block-percent',
			'10',
			'--json',
		]);
		const parsed = JSON.parse(result.out) as Report;
		assert.deepEqual(
			parsed.gate.map((g) => [g.src, g.eligible]),
			[
				['kr', true],
				['cb', true],
				['bs', true],
				['cm', false],
			]
		);
	});

	test('fails for a bad option, an unknown option and a missing value', async () => {
		const bad = await run(['--min-availability', 'lots']);
		assert.equal(bad.code, 1);
		assert.match(bad.err, /--min-availability needs a number/);
		const unknown = await run(['--nope']);
		assert.equal(unknown.code, 1);
		assert.match(unknown.err, /Usage:/);
		const negative = await run(['--max-fail-streak', '-1']);
		assert.equal(negative.code, 1);
	});

	test('fails when the data root has no data', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'analyze-main-'));
		try {
			const result = await run(['--data-root', dir]);
			assert.equal(result.code, 1);
			assert.match(result.err, /No price rows or request log rows/);
			assert.equal(result.out, '');
		} finally {
			await rm(dir, { recursive: true });
		}
	});

	test('prints the usage with --help', async () => {
		const result = await run(['--help']);
		assert.equal(result.code, 0);
		assert.match(result.out, /--min-availability/);
	});
});
