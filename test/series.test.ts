import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { appendRows, dailyPath } from '../src/csv.ts';
import { createSeriesReader } from '../src/series.ts';
import type { PriceRow, SrcCode } from '../src/types.ts';

const NO_WARNINGS = (): void => {};

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(path.join(tmpdir(), 'git-coin-series-'));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function row(
	ts: string,
	price: string,
	src: SrcCode = 'kr',
	coin = 'BTC'
): PriceRow {
	return { ts, coin, price, src, age_s: null };
}

test('readSeries returns an empty list when nothing is stored', async () => {
	await withRoot(async (root) => {
		const reader = createSeriesReader(root, NO_WARNINGS);
		assert.deepEqual(
			await reader.readSeries(
				'BTC',
				'2026-10-29T00:00:00Z',
				'2026-10-30T00:00:00Z',
				'kr'
			),
			[]
		);
	});
});

test('readSeries filters by src and coin and sorts by ts', async () => {
	await withRoot(async (root) => {
		await appendRows(
			root,
			[
				row('2026-10-29T10:00:00Z', '1.00', 'kr'),
				row('2026-10-29T10:00:01Z', '9.00', 'cb'),
				row('2026-10-29T10:10:00Z', '2.00', 'kr'),
				row('2026-10-29T10:10:00Z', '7.00', 'kr', 'ETH'),
			],
			{ minSpacingSeconds: 60 }
		);
		const reader = createSeriesReader(root, NO_WARNINGS);
		const points = await reader.readSeries(
			'BTC',
			'2026-10-29T00:00:00Z',
			'2026-10-30T00:00:00Z',
			'kr'
		);
		assert.deepEqual(
			points.map((p) => [p.ts, p.price]),
			[
				['2026-10-29T10:00:00Z', '1.00'],
				['2026-10-29T10:10:00Z', '2.00'],
			]
		);
	});
});

test('readSeries sorts rows that are out of order inside a file', async () => {
	await withRoot(async (root) => {
		const file = dailyPath(root, 'BTC', '2026-10-29T10:00:00Z');
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(
			file,
			'ts,price,src,age_s\n2026-10-29T10:10:00Z,2.00,kr,\n2026-10-29T10:00:00Z,1.00,kr,\n'
		);
		const points = await createSeriesReader(root, NO_WARNINGS).readSeries(
			'BTC',
			'2026-10-29T00:00:00Z',
			'2026-10-30T00:00:00Z',
			'kr'
		);
		assert.deepEqual(
			points.map((p) => p.price),
			['1.00', '2.00']
		);
	});
});

test('readSeries includes the from time and excludes the to time', async () => {
	await withRoot(async (root) => {
		await appendRows(
			root,
			[
				row('2026-10-29T10:00:00Z', '1.00'),
				row('2026-10-29T10:10:00Z', '2.00'),
				row('2026-10-29T10:20:00Z', '3.00'),
			],
			{ minSpacingSeconds: 60 }
		);
		const points = await createSeriesReader(root, NO_WARNINGS).readSeries(
			'BTC',
			'2026-10-29T10:00:00Z',
			'2026-10-29T10:20:00Z',
			'kr'
		);
		assert.deepEqual(
			points.map((p) => p.price),
			['1.00', '2.00']
		);
	});
});

test('readSeries reads across midnight and across a missing day', async () => {
	await withRoot(async (root) => {
		await appendRows(
			root,
			[
				row('2026-10-28T23:55:00Z', '1.00'),
				row('2026-10-30T00:05:00Z', '2.00'),
				row('2026-10-30T00:10:00Z', '3.00'),
			],
			{ minSpacingSeconds: 60 }
		);
		const points = await createSeriesReader(root, NO_WARNINGS).readSeries(
			'BTC',
			'2026-10-28T12:00:00Z',
			'2026-10-30T00:10:00Z',
			'kr'
		);
		assert.deepEqual(
			points.map((p) => p.price),
			['1.00', '2.00']
		);
	});
});

test('readSeries returns an empty list when from is not before to', async () => {
	await withRoot(async (root) => {
		await appendRows(root, [row('2026-10-29T10:00:00Z', '1.00')], {
			minSpacingSeconds: 60,
		});
		const reader = createSeriesReader(root, NO_WARNINGS);
		assert.deepEqual(
			await reader.readSeries(
				'BTC',
				'2026-10-29T12:00:00Z',
				'2026-10-29T10:00:00Z',
				'kr'
			),
			[]
		);
		assert.deepEqual(
			await reader.readSeries(
				'BTC',
				'2026-10-29T10:00:00Z',
				'2026-10-29T10:00:00Z',
				'kr'
			),
			[]
		);
	});
});

test('readSeries skips malformed lines and reports their count', async () => {
	await withRoot(async (root) => {
		const file = dailyPath(root, 'BTC', '2026-10-29T10:00:00Z');
		await mkdir(path.dirname(file), { recursive: true });
		await copyFile(
			path.join(import.meta.dirname, 'fixtures', 'csv', 'malformed.csv'),
			file
		);
		const reports: Array<[string, number]> = [];
		const reader = createSeriesReader(root, (reported, count) => {
			reports.push([reported, count]);
		});
		const points = await reader.readSeries(
			'BTC',
			'2026-10-29T00:00:00Z',
			'2026-10-30T00:00:00Z',
			'kr'
		);
		assert.deepEqual(
			points.map((p) => p.price),
			['100.00', '0.00001234', '105.00']
		);
		assert.deepEqual(reports, [[file, 5]]);
		const cb = await reader.readSeries(
			'BTC',
			'2026-10-29T00:00:00Z',
			'2026-10-30T00:00:00Z',
			'cb'
		);
		assert.deepEqual(cb, [
			{
				ts: '2026-10-29T10:15:00Z',
				price: '102.00',
				src: 'cb',
				age_s: 2,
			},
		]);
	});
});

test('readSeries keeps the price string and age_s as stored', async () => {
	await withRoot(async (root) => {
		await appendRows(
			root,
			[
				{
					ts: '2026-10-29T10:00:00Z',
					coin: 'SHIB',
					price: '0.00001234',
					src: 'cb',
					age_s: 2,
				},
			],
			{ minSpacingSeconds: 60 }
		);
		const points = await createSeriesReader(root, NO_WARNINGS).readSeries(
			'SHIB',
			'2026-10-29T00:00:00Z',
			'2026-10-30T00:00:00Z',
			'cb'
		);
		assert.deepEqual(points, [
			{
				ts: '2026-10-29T10:00:00Z',
				price: '0.00001234',
				src: 'cb',
				age_s: 2,
			},
		]);
	});
});

test('readSeries rejects a bad time', async () => {
	await withRoot(async (root) => {
		await assert.rejects(
			createSeriesReader(root, NO_WARNINGS).readSeries(
				'BTC',
				'yesterday',
				'2026-10-30T00:00:00Z',
				'kr'
			)
		);
	});
});
