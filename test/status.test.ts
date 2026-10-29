import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
	applyRun,
	emptyStatus,
	needsNoDataIssue,
	readStatus,
	type RunSummary,
	writeStatus,
} from '../src/status.ts';
import type { ErrorCode, PriceRow, SrcCode, Status } from '../src/types.ts';

const T0 = new Date('2026-10-29T14:03:12Z');
const T0_ISO = '2026-10-29T14:03:12Z';

function minutes(n: number): Date {
	return new Date(T0.getTime() + n * 60_000);
}

function priceRow(coin: string, src: SrcCode): PriceRow {
	return { ts: T0_ISO, coin, price: '100.00', src, age_s: null };
}

function source(
	src: SrcCode,
	opts: {
		error?: ErrorCode | '';
		coins?: string[];
		rejected?: Array<{ coin: string; reason: string }>;
		missing?: string[];
		skipped?: number;
	} = {}
): RunSummary['sources'][number] {
	const coins = opts.coins ?? [];
	return {
		log: {
			ts: T0_ISO,
			src,
			http: opts.error ? 500 : 200,
			ms: 120,
			coins_ok: coins.length,
			error: opts.error ?? '',
		},
		written: coins.map((coin) => priceRow(coin, src)),
		rejected: opts.rejected ?? [],
		missingCoins: opts.missing ?? [],
		...(opts.skipped === undefined ? {} : { skipped: opts.skipped }),
	};
}

function run(sources: RunSummary['sources']): RunSummary {
	return { phase: 'test', sources };
}

function failedRun(): RunSummary {
	return run([source('kr', { error: 'timeout' })]);
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), 'status-'));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test('emptyStatus has no data and no failures', () => {
	assert.deepEqual(emptyStatus('production'), {
		schema_version: 1,
		phase: 'production',
		last_run_at: null,
		last_point_at: null,
		consecutive_failures: 0,
		last_publish_at: null,
		sources: {},
		coins: {},
	});
});

test('a run that writes rows updates the run and point times', () => {
	const next = applyRun(
		emptyStatus('test'),
		run([source('kr', { coins: ['BTC', 'ETH'] })]),
		T0
	);
	assert.equal(next.last_run_at, T0_ISO);
	assert.equal(next.last_point_at, T0_ISO);
	assert.equal(next.consecutive_failures, 0);
	assert.deepEqual(next.coins.BTC, {
		last_point_at: T0_ISO,
		status: 'ok',
		rejected_count: 0,
		last_reject_reason: null,
	});
	assert.deepEqual(next.sources.kr, {
		requests: 1,
		failures: 0,
		failures_by_error: {},
		consecutive_failures: 0,
		last_ok_at: T0_ISO,
	});
});

test('applyRun does not change the previous status', () => {
	const prev = emptyStatus('test');
	const copy = structuredClone(prev);
	applyRun(prev, run([source('kr', { coins: ['BTC'] })]), T0);
	assert.deepEqual(prev, copy);
});

test('a run that writes nothing counts as a failure and keeps last_point_at', () => {
	let status = applyRun(
		emptyStatus('test'),
		run([source('kr', { coins: ['BTC'] })]),
		T0
	);
	status = applyRun(status, failedRun(), minutes(15));
	assert.equal(status.consecutive_failures, 1);
	assert.equal(status.last_run_at, '2026-10-29T14:18:12Z');
	assert.equal(status.last_point_at, T0_ISO);
});

test('a run with a good request but no rows still counts as a failure', () => {
	const status = applyRun(
		emptyStatus('test'),
		run([
			source('kr', {
				rejected: [{ coin: 'BTC', reason: 'not_positive' }],
			}),
		]),
		T0
	);
	assert.equal(status.consecutive_failures, 1);
});

test('one written row from any source resets the run failure streak', () => {
	let status = emptyStatus('test');
	for (let i = 0; i < 3; i += 1) {
		status = applyRun(status, failedRun(), minutes(i));
	}
	assert.equal(status.consecutive_failures, 3);
	status = applyRun(
		status,
		run([
			source('kr', { error: 'http_429' }),
			source('cb', { coins: ['BTC'] }),
		]),
		minutes(4)
	);
	assert.equal(status.consecutive_failures, 0);
	assert.equal(status.last_point_at, '2026-10-29T14:07:12Z');
});

test('needsNoDataIssue turns on at 4 failed runs in a row', () => {
	let status = emptyStatus('test');
	const seen: boolean[] = [];
	for (let i = 0; i < 5; i += 1) {
		status = applyRun(status, failedRun(), minutes(i));
		seen.push(needsNoDataIssue(status));
	}
	assert.deepEqual(seen, [false, false, false, true, true]);
	status = applyRun(
		status,
		run([source('kr', { coins: ['BTC'] })]),
		minutes(6)
	);
	assert.equal(needsNoDataIssue(status), false);
});

test('source counters follow the log rows', () => {
	let status = emptyStatus('test');
	status = applyRun(status, run([source('kr', { error: 'timeout' })]), T0);
	status = applyRun(
		status,
		run([source('kr', { error: 'timeout' })]),
		minutes(1)
	);
	status = applyRun(
		status,
		run([source('kr', { error: 'http_429' })]),
		minutes(2)
	);
	assert.deepEqual(status.sources.kr, {
		requests: 3,
		failures: 3,
		failures_by_error: { timeout: 2, http_429: 1 },
		consecutive_failures: 3,
		last_ok_at: null,
	});
	status = applyRun(
		status,
		run([source('kr', { coins: ['BTC'] })]),
		minutes(3)
	);
	assert.equal(status.sources.kr?.requests, 4);
	assert.equal(status.sources.kr?.failures, 3);
	assert.equal(status.sources.kr?.consecutive_failures, 0);
	assert.equal(status.sources.kr?.last_ok_at, T0_ISO);
});

test('sources are counted separately', () => {
	const status = applyRun(
		emptyStatus('test'),
		run([
			source('kr', { coins: ['BTC'] }),
			source('cb', { error: 'parse' }),
		]),
		T0
	);
	assert.equal(status.sources.kr?.failures, 0);
	assert.equal(status.sources.cb?.failures, 1);
	assert.deepEqual(status.sources.cb?.failures_by_error, { parse: 1 });
	assert.equal(status.sources.bs, undefined);
});

test('rejected rows are counted per coin with the last reason', () => {
	let status = applyRun(
		emptyStatus('production'),
		run([
			source('kr', {
				coins: ['ETH'],
				rejected: [{ coin: 'BTC', reason: 'step_no_crosscheck' }],
			}),
		]),
		T0
	);
	status = applyRun(
		status,
		run([
			source('kr', {
				rejected: [{ coin: 'BTC', reason: 'not_positive' }],
			}),
		]),
		minutes(15)
	);
	assert.equal(status.coins.BTC?.rejected_count, 2);
	assert.equal(status.coins.BTC?.last_reject_reason, 'not_positive');
	assert.equal(status.coins.BTC?.last_point_at, null);
	assert.equal(status.coins.ETH?.rejected_count, 0);
});

test('a missing coin becomes source_missing and a later row makes it ok again', () => {
	let status = applyRun(
		emptyStatus('test'),
		run([source('kr', { coins: ['BTC'], missing: ['DOGE'] })]),
		T0
	);
	assert.equal(status.coins.DOGE?.status, 'source_missing');
	assert.equal(status.coins.DOGE?.last_point_at, null);
	status = applyRun(
		status,
		run([source('kr', { coins: ['BTC', 'DOGE'] })]),
		minutes(15)
	);
	assert.equal(status.coins.DOGE?.status, 'ok');
	assert.equal(status.coins.DOGE?.last_point_at, '2026-10-29T14:18:12Z');
});

test('a coin missing in one source but written by another stays ok', () => {
	const status = applyRun(
		emptyStatus('test'),
		run([
			source('kr', { coins: ['BTC'] }),
			source('cb', { missing: ['BTC'], error: 'unmapped' }),
		]),
		T0
	);
	assert.equal(status.coins.BTC?.status, 'ok');
});

test('applyRun takes the phase from the run', () => {
	const status = applyRun(
		emptyStatus('test'),
		{ phase: 'production', sources: [] },
		T0
	);
	assert.equal(status.phase, 'production');
	assert.equal(status.consecutive_failures, 1);
});

test('readStatus gives an empty status when the file is missing', async () => {
	await withTempDir(async (dir) => {
		assert.deepEqual(
			await readStatus(join(dir, 'state', 'status.json')),
			emptyStatus('test')
		);
	});
});

test('writeStatus then readStatus round-trips', async () => {
	await withTempDir(async (dir) => {
		const path = join(dir, 'state', 'status.json');
		let status = applyRun(
			emptyStatus('test'),
			run([
				source('kr', { coins: ['BTC'] }),
				source('cb', { error: 'timeout', missing: ['ETH'] }),
			]),
			T0
		);
		status = applyRun(
			status,
			run([
				source('kr', {
					rejected: [{ coin: 'BTC', reason: 'not_positive' }],
				}),
			]),
			minutes(15)
		);
		await writeStatus(path, status);
		assert.deepEqual(await readStatus(path), status);
	});
});

test('writeStatus uses a stable key order and a trailing newline', async () => {
	await withTempDir(async (dir) => {
		const path = join(dir, 'status.json');
		const status: Status = {
			...emptyStatus('test'),
			sources: {
				kr: {
					last_ok_at: null,
					consecutive_failures: 2,
					failures_by_error: { timeout: 1, http_429: 1 },
					failures: 2,
					requests: 2,
				},
				bs: {
					requests: 1,
					failures: 0,
					failures_by_error: {},
					consecutive_failures: 0,
					last_ok_at: T0_ISO,
				},
			},
			coins: {
				ETH: {
					status: 'ok',
					rejected_count: 0,
					last_reject_reason: null,
					last_point_at: null,
				},
				BTC: {
					status: 'ok',
					rejected_count: 0,
					last_reject_reason: null,
					last_point_at: null,
				},
			},
		};
		await writeStatus(path, status);
		const text = await readFile(path, 'utf8');
		assert.ok(text.endsWith('}\n'));
		assert.ok(!text.endsWith('\n\n'));
		const parsed = JSON.parse(text) as Status;
		assert.deepEqual(Object.keys(parsed), [
			'schema_version',
			'phase',
			'last_run_at',
			'last_point_at',
			'consecutive_failures',
			'last_publish_at',
			'sources',
			'coins',
		]);
		assert.deepEqual(Object.keys(parsed.sources), ['bs', 'kr']);
		assert.deepEqual(Object.keys(parsed.coins), ['BTC', 'ETH']);
		assert.deepEqual(
			Object.keys(parsed.sources.kr?.failures_by_error ?? {}),
			['http_429', 'timeout']
		);
		assert.deepEqual(Object.keys(parsed.sources.kr ?? {}), [
			'requests',
			'failures',
			'failures_by_error',
			'consecutive_failures',
			'last_ok_at',
		]);
		// The same input always gives the same bytes.
		await writeStatus(path, structuredClone(status));
		assert.equal(await readFile(path, 'utf8'), text);
	});
});

test('readStatus throws on a file that is not valid status JSON', async () => {
	await withTempDir(async (dir) => {
		const path = join(dir, 'status.json');
		await writeFile(path, '{not json', 'utf8');
		await assert.rejects(readStatus(path), /not valid JSON/);
		await writeFile(path, '{"schema_version":2}', 'utf8');
		await assert.rejects(readStatus(path), /unexpected shape/);
		await writeFile(path, '[]', 'utf8');
		await assert.rejects(readStatus(path), /unexpected shape/);
	});
});

test('a run that only skipped rows is idle and keeps the failure streak', () => {
	let status = emptyStatus('test');
	status = applyRun(status, failedRun(), minutes(0));
	status = applyRun(status, failedRun(), minutes(1));
	const before = status.last_point_at;
	const idle = run([source('kr', { skipped: 10 })]);
	status = applyRun(status, idle, minutes(2));
	assert.equal(status.consecutive_failures, 2);
	assert.equal(status.last_point_at, before);
	assert.equal(status.last_run_at, '2026-10-29T14:05:12Z');
	assert.equal(status.sources.kr?.requests, 3);
	assert.equal(status.sources.kr?.consecutive_failures, 0);
});

test('many idle runs never reach the no data limit', () => {
	let status = applyRun(
		emptyStatus('test'),
		run([source('kr', { coins: ['BTC'] })]),
		T0
	);
	for (let i = 1; i <= 6; i += 1) {
		status = applyRun(
			status,
			run([source('kr', { skipped: 10 })]),
			minutes(i)
		);
	}
	assert.equal(status.consecutive_failures, 0);
	assert.equal(needsNoDataIssue(status), false);
	assert.equal(status.last_point_at, T0_ISO);
});

test('an error run with skipped rows is still a failure', () => {
	const status = applyRun(
		emptyStatus('test'),
		run([source('kr', { skipped: 5 }), source('cb', { error: 'timeout' })]),
		T0
	);
	assert.equal(status.consecutive_failures, 1);
});

test('skipped: 0 or no field keeps the old failure behaviour', () => {
	let status = applyRun(
		emptyStatus('test'),
		run([source('kr', { skipped: 0 })]),
		T0
	);
	assert.equal(status.consecutive_failures, 1);
	status = applyRun(status, run([source('kr')]), minutes(1));
	assert.equal(status.consecutive_failures, 2);
});

test('a run with written rows and skipped rows is a success', () => {
	let status = applyRun(emptyStatus('test'), failedRun(), T0);
	status = applyRun(
		status,
		run([source('kr', { coins: ['BTC'], skipped: 9 })]),
		minutes(1)
	);
	assert.equal(status.consecutive_failures, 0);
	assert.equal(status.last_point_at, '2026-10-29T14:04:12Z');
});
