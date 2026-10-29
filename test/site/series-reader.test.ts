import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
	createFileSeriesReader,
	findFirstDay,
} from '../../src/site/series-reader.ts';

import { makeTempDir, removeDir, writeDay } from './tree.ts';

let root = '';

beforeEach(async () => {
	root = await makeTempDir();
});

afterEach(async () => {
	await removeDir(root);
});

test('the reader returns the rows of one source in time order across days', async () => {
	await writeDay(root, 'BTC', '2026-10-28', [
		'2026-10-28T23:50:00Z,101.50,kr,',
		'2026-10-28T23:50:01Z,999,cb,2',
	]);
	await writeDay(root, 'BTC', '2026-10-29', [
		'2026-10-29T00:10:00Z,102.25000,kr,3',
	]);
	const points = await createFileSeriesReader(root).readSeries(
		'BTC',
		'2026-10-28T00:00:00Z',
		'2026-10-30T00:00:00Z',
		'kr'
	);
	assert.deepEqual(points, [
		{ ts: '2026-10-28T23:50:00Z', price: '101.50', src: 'kr', age_s: null },
		{
			ts: '2026-10-29T00:10:00Z',
			price: '102.25000',
			src: 'kr',
			age_s: 3,
		},
	]);
});

test('the start is inclusive and the end is exclusive', async () => {
	await writeDay(root, 'BTC', '2026-10-29', [
		'2026-10-29T10:00:00Z,1,kr,',
		'2026-10-29T11:00:00Z,2,kr,',
		'2026-10-29T12:00:00Z,3,kr,',
	]);
	const points = await createFileSeriesReader(root).readSeries(
		'BTC',
		'2026-10-29T10:00:00Z',
		'2026-10-29T12:00:00Z',
		'kr'
	);
	assert.deepEqual(
		points.map((p) => p.price),
		['1', '2']
	);
});

test('the reader skips malformed lines, the header and bad prices', async () => {
	await writeDay(root, 'BTC', '2026-10-29', [
		'2026-10-29T10:00:00Z,1,kr,',
		'garbage',
		'2026-10-29T10:01:00Z,,kr,',
		'2026-10-29T10:02:00Z,abc,kr,',
		'yesterday,5,kr,',
		'2026-10-29T10:03:00Z,4',
		'2026-10-29T10:04:00Z,5,kr,x',
	]);
	const points = await createFileSeriesReader(root).readSeries(
		'BTC',
		'2026-10-29T00:00:00Z',
		'2026-10-30T00:00:00Z',
		'kr'
	);
	assert.deepEqual(
		points.map((p) => [p.price, p.age_s]),
		[
			['1', null],
			['5', null],
		]
	);
});

test('the reader sorts rows of a file that is out of order', async () => {
	await writeDay(root, 'BTC', '2026-10-29', [
		'2026-10-29T10:05:00Z,2,kr,',
		'2026-10-29T10:00:00Z,1,kr,',
	]);
	const points = await createFileSeriesReader(root).readSeries(
		'BTC',
		'2026-10-29T00:00:00Z',
		'2026-10-30T00:00:00Z',
		'kr'
	);
	assert.deepEqual(
		points.map((p) => p.price),
		['1', '2']
	);
});

test('a missing day, a missing coin and an empty range give no rows', async () => {
	await writeDay(root, 'BTC', '2026-10-29', ['2026-10-29T10:00:00Z,1,kr,']);
	const reader = createFileSeriesReader(root);
	assert.deepEqual(
		await reader.readSeries(
			'ETH',
			'2026-10-29T00:00:00Z',
			'2026-10-30T00:00:00Z',
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
	assert.deepEqual(
		await createFileSeriesReader(`${root}/nothing`).readSeries(
			'BTC',
			'2026-10-29T00:00:00Z',
			'2026-10-30T00:00:00Z',
			'kr'
		),
		[]
	);
});

test('findFirstDay returns the earliest day directory', async () => {
	await writeDay(root, 'BTC', '2026-10-29', ['2026-10-29T10:00:00Z,1,kr,']);
	await writeDay(root, 'ETH', '2025-12-31', ['2025-12-31T10:00:00Z,1,kr,']);
	await writeDay(root, 'BTC', '2026-01-05', ['2026-01-05T10:00:00Z,1,kr,']);
	assert.equal(await findFirstDay(root), '2025-12-31');
});

test('findFirstDay returns null when there is no data', async () => {
	assert.equal(await findFirstDay(root), null);
	assert.equal(await findFirstDay(`${root}/nothing`), null);
});
