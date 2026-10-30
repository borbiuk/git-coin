import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	RATE_MAX_GAP_SECONDS,
	clipSpans,
	convertSamples,
	dailyCandles,
	hourlyPoints,
	loadSamples,
	periodStats,
	recentPoints,
	toSamples,
	joinHistory,
} from '../../src/site/derive.ts';
import type { Sample } from '../../src/site/derive.ts';
import type { PricePoint, SeriesReader } from '../../src/types.ts';

import { epoch } from './tree.ts';

function sample(ts: string, p: number): Sample {
	return { t: epoch(ts), p, ts };
}

function point(ts: string, price: string): PricePoint {
	return { ts, price, src: 'kr', age_s: null };
}

test('toSamples converts prices to numbers and drops values that are not numbers', () => {
	const samples = toSamples([
		point('2026-10-29T10:00:00Z', '0.00001234'),
		point('2026-10-29T10:05:00Z', ''),
		point('2026-10-29T10:10:00Z', 'abc'),
		point('2026-10-29T10:15:00Z', '81232.79000'),
	]);
	assert.deepEqual(
		samples.map((s) => s.p),
		[0.00001234, 81232.79]
	);
	assert.equal(samples[1].t, epoch('2026-10-29T10:15:00Z'));
});

test('loadSamples asks the reader for the range up to now, inclusive', async () => {
	const calls: unknown[][] = [];
	const reader: SeriesReader = {
		readSeries(...args) {
			calls.push(args);
			return Promise.resolve([point('2026-10-29T12:00:00Z', '5')]);
		},
	};
	const samples = await loadSamples(
		reader,
		'BTC',
		'2026-10-01T00:00:00Z',
		new Date('2026-10-29T12:00:00.400Z'),
		'kr'
	);
	assert.deepEqual(calls, [
		['BTC', '2026-10-01T00:00:00Z', '2026-10-29T12:00:01Z', 'kr'],
	]);
	assert.equal(samples.length, 1);
});

test('recentPoints keeps full resolution from the start time on', () => {
	const samples = [
		sample('2026-10-20T10:00:00Z', 1),
		sample('2026-10-28T10:00:00Z', 2),
		sample('2026-10-28T10:05:00Z', 3),
	];
	const out = recentPoints(
		'BTC',
		'kr',
		samples,
		epoch('2026-10-28T10:00:00Z')
	);
	assert.deepEqual(out, {
		coin: 'BTC',
		src: 'kr',
		t: [epoch('2026-10-28T10:00:00Z'), epoch('2026-10-28T10:05:00Z')],
		p: [2, 3],
	});
});

test('hourlyPoints keeps the last sample of each UTC hour and leaves empty hours out', () => {
	const samples = [
		sample('2026-10-29T08:10:00Z', 1),
		sample('2026-10-29T08:55:00Z', 2),
		sample('2026-10-29T09:05:00Z', 3),
		// 10:00 to 10:59 has no sample
		sample('2026-10-29T11:00:00Z', 4),
		sample('2026-10-29T11:30:00Z', 5),
	];
	const out = hourlyPoints('BTC', 'kr', samples, 0);
	assert.deepEqual(out.p, [2, 3, 5]);
	assert.deepEqual(out.t, [
		epoch('2026-10-29T08:55:00Z'),
		epoch('2026-10-29T09:05:00Z'),
		epoch('2026-10-29T11:30:00Z'),
	]);
});

test('hourlyPoints drops samples before the start time', () => {
	const samples = [
		sample('2026-10-29T08:10:00Z', 1),
		sample('2026-10-29T09:05:00Z', 2),
	];
	const out = hourlyPoints(
		'BTC',
		'kr',
		samples,
		epoch('2026-10-29T09:00:00Z')
	);
	assert.deepEqual(out.p, [2]);
});

test('dailyCandles builds open, high, low and close on UTC days', () => {
	const samples = [
		sample('2026-10-27T23:59:59Z', 10),
		sample('2026-10-28T00:00:00Z', 20),
		sample('2026-10-28T06:00:00Z', 35),
		sample('2026-10-28T12:00:00Z', 15),
		sample('2026-10-28T23:59:59Z', 25),
		// 2026-10-29 has no sample, 2026-10-30 has one
		sample('2026-10-30T00:00:01Z', 30),
	];
	assert.deepEqual(dailyCandles('BTC', 'kr', samples), {
		coin: 'BTC',
		src: 'kr',
		t: [
			epoch('2026-10-27T00:00:00Z'),
			epoch('2026-10-28T00:00:00Z'),
			epoch('2026-10-30T00:00:00Z'),
		],
		o: [10, 20, 30],
		h: [10, 35, 30],
		l: [10, 15, 30],
		c: [10, 25, 30],
	});
});

test('dailyCandles of no samples is empty', () => {
	assert.deepEqual(dailyCandles('BTC', 'kr', []), {
		coin: 'BTC',
		src: 'kr',
		t: [],
		o: [],
		h: [],
		l: [],
		c: [],
	});
});

const DAY = 86_400;
const NOW = epoch('2026-10-29T12:00:00Z');

test('periodStats gives the change, the high and the low of a full window', () => {
	const samples = [
		sample('2026-10-28T11:30:00Z', 90),
		sample('2026-10-28T12:00:00Z', 100),
		sample('2026-10-29T06:00:00Z', 130),
		sample('2026-10-29T09:00:00Z', 80),
		sample('2026-10-29T12:00:00Z', 110),
	];
	assert.deepEqual(periodStats(samples, NOW, DAY), {
		change_pct: 10,
		high: 130,
		low: 80,
	});
});

test('periodStats takes the sample nearest to the period start as the reference', () => {
	const samples = [
		sample('2026-10-28T11:00:00Z', 50),
		sample('2026-10-28T12:20:00Z', 200),
		sample('2026-10-29T12:00:00Z', 250),
	];
	// 12:20 is 20 minutes from the start, 11:00 is 60 minutes
	assert.equal(periodStats(samples, NOW, DAY).change_pct, 25);
});

test('periodStats has no change when the data starts after the period start', () => {
	const samples = [
		sample('2026-10-29T06:00:00Z', 100),
		sample('2026-10-29T12:00:00Z', 110),
	];
	assert.deepEqual(periodStats(samples, NOW, DAY), {
		change_pct: null,
		high: 110,
		low: 100,
	});
});

test('periodStats accepts a reference at the edge of the tolerance and rejects one just past it', () => {
	// 5% of 24 hours is 72 minutes
	const edge = [
		sample('2026-10-28T13:12:00Z', 100),
		sample('2026-10-29T12:00:00Z', 150),
	];
	assert.equal(periodStats(edge, NOW, DAY).change_pct, 50);
	const past = [
		sample('2026-10-28T13:13:00Z', 100),
		sample('2026-10-29T12:00:00Z', 150),
	];
	assert.equal(periodStats(past, NOW, DAY).change_pct, null);
});

test('periodStats has no change when the last sample is too old', () => {
	const samples = [
		sample('2026-10-28T10:00:00Z', 100),
		sample('2026-10-29T08:00:00Z', 150),
	];
	const stats = periodStats(samples, NOW, DAY);
	assert.equal(stats.change_pct, null);
	assert.equal(stats.high, 150);
});

test('periodStats of one sample or no samples has no change', () => {
	assert.deepEqual(
		periodStats([sample('2026-10-29T12:00:00Z', 7)], NOW, DAY),
		{ change_pct: null, high: 7, low: 7 }
	);
	assert.deepEqual(periodStats([], NOW, DAY), {
		change_pct: null,
		high: null,
		low: null,
	});
});

test('periodStats has no change when the reference price is zero', () => {
	const samples = [
		sample('2026-10-28T12:00:00Z', 0),
		sample('2026-10-29T12:00:00Z', 5),
	];
	assert.equal(periodStats(samples, NOW, DAY).change_pct, null);
});

test('periodStats rounds the change to four decimals', () => {
	const samples = [
		sample('2026-10-28T12:00:00Z', 3),
		sample('2026-10-29T12:00:00Z', 4),
	];
	assert.equal(periodStats(samples, NOW, DAY).change_pct, 33.3333);
});

test('convertSamples divides by the rate nearest in time and keeps the order and the times', () => {
	const rates = [
		sample('2026-10-29T10:00:00Z', 0.5),
		sample('2026-10-29T11:00:00Z', 0.25),
	];
	const prices = [
		sample('2026-10-29T10:10:00Z', 10),
		sample('2026-10-29T10:40:00Z', 10),
		sample('2026-10-29T10:30:00Z', 10),
	];
	assert.deepEqual(convertSamples(prices.slice(0, 2), rates), [
		sample('2026-10-29T10:10:00Z', 20),
		sample('2026-10-29T10:40:00Z', 40),
	]);
	// Equally near: the earlier rate
	assert.equal(convertSamples(prices.slice(2), rates)[0]?.p, 20);
});

test('convertSamples uses the first rate for a price before it, and the last one for a price after it', () => {
	const rates = [sample('2026-10-29T10:00:00Z', 2)];
	assert.deepEqual(
		convertSamples(
			[
				sample('2026-10-29T09:00:00Z', 10),
				sample('2026-10-29T12:00:00Z', 10),
			],
			rates
		).map((item) => item.p),
		[5, 5]
	);
});

test('convertSamples drops a price that has no rate within the limit, and ignores rates that are not positive', () => {
	const far = RATE_MAX_GAP_SECONDS + 1;
	const rates = [
		sample('2026-10-29T10:00:00Z', 0),
		sample('2026-10-29T10:05:00Z', 2),
	];
	const late = new Date(epoch('2026-10-29T10:05:00Z') * 1000 + far * 1000);
	const lateIso = `${late.toISOString().slice(0, 19)}Z`;
	const out = convertSamples(
		[sample('2026-10-29T10:00:00Z', 10), sample(lateIso, 10)],
		rates
	);
	assert.deepEqual(
		out.map((item) => item.p),
		[5]
	);
	assert.deepEqual(convertSamples([sample(lateIso, 10)], []), []);
});

test('convertSamples rounds the result to 12 significant digits', () => {
	const out = convertSamples(
		[sample('2026-10-29T10:00:00Z', 78774)],
		[sample('2026-10-29T10:00:00Z', 0.99885)]
	);
	assert.equal(out[0]?.p, Number((78774 / 0.99885).toPrecision(12)));
	assert.ok(String(out[0]?.p).length <= 14);
});

test('joinHistory keeps the history before the first live sample and drops a candle next to a live one', () => {
	const history = [
		sample('2026-10-28T10:00:00Z', 1),
		sample('2026-10-28T10:15:00Z', 2),
		sample('2026-10-29T10:00:00Z', 3),
		sample('2026-10-29T10:15:00Z', 4),
	];
	const live = [
		sample('2026-10-29T10:15:00Z', 40),
		sample('2026-10-29T11:00:00Z', 50),
	];
	const joined = joinHistory(history, live);
	assert.deepEqual(
		joined.samples.map((item) => item.p),
		[1, 2, 3, 40, 50]
	);
	assert.deepEqual(joined.filled, []);
	assert.deepEqual(joinHistory(history, []), {
		samples: history,
		filled: [],
	});
	assert.deepEqual(joinHistory([], live), { samples: live, filled: [] });
});

test('joinHistory keeps the candles of a missed run and reports their span', () => {
	const live = [
		sample('2026-10-29T10:00:00Z', 10),
		sample('2026-10-29T10:15:00Z', 11),
		sample('2026-10-29T16:15:00Z', 30),
		sample('2026-10-29T16:30:00Z', 31),
	];
	const history = [
		sample('2026-10-29T09:45:00Z', 1),
		// Within 5 minutes of the live sample at 10:15
		sample('2026-10-29T10:16:00Z', 99),
		sample('2026-10-29T10:30:00Z', 20),
		sample('2026-10-29T10:45:00Z', 21),
		sample('2026-10-29T16:00:00Z', 29),
		// Within 5 minutes of the live sample at 16:15
		sample('2026-10-29T16:14:00Z', 98),
	];
	const joined = joinHistory(history, live);
	assert.deepEqual(
		joined.samples.map((item) => item.p),
		[1, 10, 11, 20, 21, 29, 30, 31]
	);
	assert.deepEqual(joined.filled, [[live[1]?.t, live[2]?.t]]);
});

test('joinHistory closes the last span at the newest candle when no live sample follows', () => {
	const live = [sample('2026-10-29T10:00:00Z', 10)];
	const history = [
		sample('2026-10-29T10:30:00Z', 20),
		sample('2026-10-29T10:45:00Z', 21),
	];
	const joined = joinHistory(history, live);
	assert.deepEqual(joined.filled, [[live[0]?.t, history[1]?.t]]);
});

test('clipSpans drops the spans before the start and cuts the one that crosses it', () => {
	assert.deepEqual(
		clipSpans(
			[
				[10, 20],
				[30, 50],
				[60, 70],
			],
			40
		),
		[
			[40, 50],
			[60, 70],
		]
	);
});
