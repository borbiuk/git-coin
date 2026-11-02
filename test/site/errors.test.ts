import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { readErrorsFile } from '../../src/site/errors.ts';

import { makeTempDir, removeDir } from './tree.ts';

const NOW = new Date('2026-10-29T12:00:00Z');

let root = '';

beforeEach(async () => {
	root = await makeTempDir();
});

afterEach(async () => {
	await removeDir(root);
});

async function writeLog(day: string, lines: string[]): Promise<void> {
	const [year = '', month = '', date = ''] = day.split('-');
	const dir = join(root, 'data', 'meta', year, month, date);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, 'requests.csv'),
		['ts,src,http,ms,coins_ok,error', ...lines].join('\n') + '\n'
	);
}

test('a data root with no request log gives empty periods', async () => {
	const errors = await readErrorsFile(root, NOW);
	assert.deepEqual(errors.periods, { '24h': {}, '7d': {} });
	assert.deepEqual(errors.recent, []);
	assert.equal(errors.generated_at, '2026-10-29T12:00:00Z');
});

test('failures are counted by source, HTTP status and reason', async () => {
	await writeLog('2026-10-29', [
		'2026-10-29T10:00:00Z,kr,200,300,10,',
		'2026-10-29T10:05:00Z,kr,429,100,0,http_429',
		'2026-10-29T10:10:00Z,kr,0,10000,0,timeout',
		'2026-10-29T10:15:00Z,kr,503,200,0,http_other',
		'2026-10-29T10:15:00Z,cb,200,500,10,',
	]);
	const errors = await readErrorsFile(root, NOW);
	const kr = errors.periods['24h'].kr;
	assert.equal(kr?.requests, 4);
	assert.equal(kr?.failures, 3);
	assert.deepEqual(kr?.by_http, { '0': 1, '200': 1, '429': 1, '503': 1 });
	assert.deepEqual(kr?.failures_by_http, { '0': 1, '429': 1, '503': 1 });
	assert.deepEqual(kr?.failures_by_error, {
		http_429: 1,
		http_other: 1,
		timeout: 1,
	});
	assert.equal(kr?.median_ms, 250);
	assert.equal(kr?.last_failure_at, '2026-10-29T10:15:00Z');
	assert.equal(errors.periods['24h'].cb?.failures, 0);
	assert.equal(errors.periods['24h'].cb?.last_failure_at, null);
});

test('the 24 hour period leaves out older rows, the 7 day period keeps them', async () => {
	await writeLog('2026-10-27', [
		'2026-10-27T09:00:00Z,bs,500,100,0,http_other',
	]);
	await writeLog('2026-10-20', [
		'2026-10-20T09:00:00Z,bs,500,100,0,http_other',
	]);
	const errors = await readErrorsFile(root, NOW);
	assert.equal(errors.periods['24h'].bs, undefined);
	assert.equal(errors.periods['7d'].bs?.failures, 1);
	assert.equal(errors.recent.length, 1);
});

test('bad lines are skipped and recent failures are newest first and capped', async () => {
	const lines = ['not,a,row', '2026-10-29T10:00:00Z,xx,200,1,1,'];
	for (let minute = 0; minute < 60; minute += 1) {
		const mm = String(minute).padStart(2, '0');
		lines.push(`2026-10-29T11:${mm}:00Z,cm,500,1,0,http_other`);
	}
	await writeLog('2026-10-29', lines);
	const errors = await readErrorsFile(root, NOW);
	assert.equal(errors.periods['24h'].cm?.requests, 60);
	assert.equal(errors.recent.length, 50);
	assert.equal(errors.recent[0]?.ts, '2026-10-29T11:59:00Z');
});
