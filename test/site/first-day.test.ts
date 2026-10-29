import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, test } from 'node:test';

import { findFirstDay } from '../../src/site/first-day.ts';

import { makeTempDir, removeDir, writeDay } from './tree.ts';

let root = '';

beforeEach(async () => {
	root = await makeTempDir();
});

afterEach(async () => {
	await removeDir(root);
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

test('findFirstDay returns null when the data directory is a file', async () => {
	await writeFile(`${root}/data`, 'not a directory');
	assert.equal(await findFirstDay(root), null);
});
