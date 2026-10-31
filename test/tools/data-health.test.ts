import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { PriceRow, RequestLogRow, SrcCode } from '../../src/types.ts';
import type { AnalysisData } from '../../tools/analyze-sources.ts';
import { analyzeHealth, main, renderText } from '../../tools/data-health.ts';

const FIXTURE_ROOT = fileURLToPath(
	new URL('../fixtures/analyze/small', import.meta.url)
);
const NOW_MS = Date.parse('2026-11-02T12:00:00Z');

function tick(ts: string, src: SrcCode, http = 200): RequestLogRow {
	return { ts, src, http, ms: 100, coins_ok: 2, error: '' };
}

function price(ts: string, coin: string): PriceRow {
	return { ts, coin, price: '1', src: 'kr', age_s: null };
}

const DATA: AnalysisData = {
	log: [
		tick('2026-10-20T00:00:00Z', 'kr'),
		tick('2026-11-01T00:00:00Z', 'kr'),
		tick('2026-11-01T00:15:00Z', 'kr', 429),
		tick('2026-11-02T10:00:00Z', 'kr'),
		tick('2026-11-02T11:00:00Z', 'cb'),
	],
	rows: [
		price('2026-11-02T10:00:00Z', 'BTC'),
		price('2026-11-02T09:00:00Z', 'BTC'),
		price('2026-11-02T08:00:00Z', 'ETH'),
	],
	skipped_lines: 0,
};

describe('analyzeHealth', () => {
	const report = analyzeHealth(DATA, NOW_MS, 3);
	const kraken = report.sources.find((source) => source.src === 'kr');

	test('counts ticks and failures inside the window only', () => {
		assert.equal(kraken?.ticks, 3);
		assert.equal(kraken?.failed, 1);
		assert.deepEqual(kraken?.per_day, [
			{ day: '2026-11-01', ticks: 2, failed: 1 },
			{ day: '2026-11-02', ticks: 1, failed: 0 },
		]);
	});

	test('measures the longest gap and the age of the last tick', () => {
		assert.equal(kraken?.longest_gap_min, 2025);
		assert.equal(kraken?.last_tick, '2026-11-02T10:00:00Z');
		assert.equal(kraken?.last_tick_age_min, 120);
	});

	test('ignores ticks after now and counts the silence since the last tick as a gap', () => {
		const later = analyzeHealth(
			{
				...DATA,
				log: [
					tick('2026-11-02T06:00:00Z', 'kr'),
					tick('2026-11-02T07:00:00Z', 'kr'),
					tick('2026-11-02T13:00:00Z', 'kr'),
				],
			},
			NOW_MS,
			1
		);
		const source = later.sources.find((item) => item.src === 'kr');
		assert.equal(source?.ticks, 2);
		assert.equal(source?.last_tick, '2026-11-02T07:00:00Z');
		assert.equal(source?.longest_gap_min, 300);
	});

	test('reports a source without ticks and the newest price per coin', () => {
		const bitstamp = report.sources.find((source) => source.src === 'bs');
		assert.equal(bitstamp?.last_tick, null);
		assert.equal(bitstamp?.longest_gap_min, null);
		assert.deepEqual(
			report.coins.map((coin) => [coin.coin, coin.last_price_at]),
			[
				['BTC', '2026-11-02T10:00:00Z'],
				['ETH', '2026-11-02T08:00:00Z'],
			]
		);
	});

	test('renders text with every source and coin', () => {
		const text = renderText(report);
		assert.match(text, /Data health at 2026-11-02T12:00:00Z/);
		assert.match(text, /kr {6}2026-11-02T10:00:00Z \(120\)/);
		assert.match(text, /BTC {5}2026-11-02T10:00:00Z/);
	});
});

describe('main', () => {
	function capture(): {
		out: string[];
		err: string[];
		io: { out: (t: string) => void; err: (t: string) => void };
	} {
		const out: string[] = [];
		const err: string[] = [];
		return {
			out,
			err,
			io: { out: (t) => out.push(t), err: (t) => err.push(t) },
		};
	}

	test('reads a data checkout and prints JSON', async () => {
		const { out, io } = capture();
		const code = await main(
			[
				'--data-root',
				FIXTURE_ROOT,
				'--now',
				'2026-11-02T12:00:00Z',
				'--json',
			],
			io
		);
		assert.equal(code, 0);
		const parsed = JSON.parse(out.join(''));
		assert.equal(parsed.days, 3);
		assert.ok(parsed.sources[0].ticks > 0);
	});

	test('fails on an empty data root, a bad --days and a bad --now', async () => {
		const empty = capture();
		assert.equal(
			await main(['--data-root', '/nonexistent-dir'], empty.io),
			1
		);
		assert.match(empty.err.join(''), /No price rows/);
		const days = capture();
		assert.equal(await main(['--days', '0'], days.io), 1);
		const now = capture();
		assert.equal(await main(['--now', 'soon'], now.io), 1);
	});
});
