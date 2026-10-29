import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	T0,
	assertFileInvariants,
	assertInSync,
	cleanUpWorlds,
	makeWorld,
	plusMinutes,
	readLogLines,
	readPriceFiles,
	readStatus,
	remoteCount,
	remoteLog,
	rowsOf,
	runAt,
} from './harness.ts';

cleanUpWorlds();

test('one source down for five runs: the others go on, the failures are counted, then it recovers', async () => {
	const world = await makeWorld();
	for (let run = 0; run < 12; run += 1) {
		if (run === 3) {
			world.market.down.set('coinbase', 'timeout');
		}
		if (run === 8) {
			world.market.down.delete('coinbase');
		}
		const result = await runAt(world, plusMinutes(T0, run * 15));
		assert.equal(result.exitCode, 0);
		assert.equal(
			result.rowsWritten,
			run >= 3 && run < 8 ? 33 : 44,
			`run ${run}`
		);
		assertInSync(world.data, world.dataRemote, 'data');
	}

	for (const coin of world.config.coins) {
		const own = rowsOf(world.data, coin.id).filter(
			(row) => row.src === 'cb'
		);
		// Runs 0 to 2 and 8 to 11
		assert.equal(own.length, 7, coin.id);
		const kraken = rowsOf(world.data, coin.id).filter(
			(row) => row.src === 'kr'
		);
		assert.equal(kraken.length, 12, coin.id);
	}
	assertFileInvariants(world.data, 300);

	const status = readStatus(world.data);
	assert.equal(status.consecutive_failures, 0, 'the run as a whole is fine');
	assert.equal(status.sources.cb?.requests, 12);
	assert.equal(status.sources.cb?.failures, 5);
	assert.deepEqual(status.sources.cb?.failures_by_error, { timeout: 5 });
	assert.equal(status.sources.cb?.consecutive_failures, 0, 'recovered');
	assert.equal(status.sources.cb?.last_ok_at, plusMinutes(T0, 11 * 15));
	assert.equal(status.sources.kr?.failures, 0);

	// The request log shows each failed tick, with the code and no rows
	const lines = [...readLogLines(world.data).values()].flat();
	const failed = lines.filter((line) => /,cb,0,\d+,0,timeout$/.test(line));
	assert.equal(failed.length, 5);
	assert.equal(lines.filter((line) => line.includes(',cb,')).length, 12);
});

test('every kind of failure is told apart in the log, the status and the rows', async () => {
	const world = await makeWorld();
	world.market.down.set('kraken', 'http_429');
	world.market.down.set('coinbase', 'http_500');
	world.market.down.set('bitstamp', 'bad_json');
	// Coin Metrics answers, but leaves one asset out
	world.market.missing.set('coinmetrics', new Set(['DOGE']));
	const result = await runAt(world, T0);
	assert.deepEqual(result, {
		exitCode: 0,
		shouldPublish: false,
		rowsWritten: 10,
	});

	const lines = [...readLogLines(world.data).values()].flat().slice(1);
	assert.match(
		lines.find((line) => line.includes(',kr,')) ?? '',
		/,kr,429,\d+,0,http_429$/
	);
	assert.match(
		lines.find((line) => line.includes(',cb,')) ?? '',
		/,cb,500,\d+,0,http_other$/
	);
	assert.match(
		lines.find((line) => line.includes(',bs,')) ?? '',
		/,bs,200,\d+,0,parse$/
	);
	assert.match(
		lines.find((line) => line.includes(',cm,')) ?? '',
		/,cm,200,\d+,10,unmapped$/
	);

	const status = readStatus(world.data);
	assert.deepEqual(status.sources.kr?.failures_by_error, { http_429: 1 });
	assert.deepEqual(status.sources.cb?.failures_by_error, { http_other: 1 });
	assert.deepEqual(status.sources.bs?.failures_by_error, { parse: 1 });
	assert.deepEqual(status.sources.cm?.failures_by_error, { unmapped: 1 });
	// DOGE came from nobody. Every other coin came from Coin Metrics.
	assert.equal(status.coins.DOGE?.status, 'source_missing');
	assert.equal(status.coins.BTC?.status, 'ok');
	assert.equal(rowsOf(world.data, 'DOGE').length, 0);
	assert.equal(rowsOf(world.data, 'BTC').length, 1);

	// Next run everything is back: DOGE is ok again
	world.market.down.clear();
	world.market.missing.clear();
	await runAt(world, plusMinutes(T0, 15));
	assert.equal(readStatus(world.data).coins.DOGE?.status, 'ok');
	assertFileInvariants(world.data, 300);
});

test('a source that gets one wrong-shaped answer does not spoil the next run', async () => {
	const world = await makeWorld();
	world.market.down.set('kraken', 'wrong_shape');
	await runAt(world, T0);
	world.market.down.clear();
	const result = await runAt(world, plusMinutes(T0, 15));
	assert.equal(result.rowsWritten, 44);
	assert.equal(readStatus(world.data).sources.kr?.failures_by_error.parse, 1);
});

test('all sources down: status and request log are committed every run and the streak grows', async () => {
	const world = await makeWorld();
	for (const source of [
		'kraken',
		'coinbase',
		'bitstamp',
		'coinmetrics',
	] as const) {
		world.market.down.set(source, 'timeout');
	}
	const before = remoteCount(world.dataRemote, 'data');
	for (let run = 0; run < 6; run += 1) {
		const result = await runAt(world, plusMinutes(T0, run * 15));
		assert.deepEqual(result, {
			exitCode: 0,
			shouldPublish: false,
			rowsWritten: 0,
		});
		assertInSync(world.data, world.dataRemote, 'data');
		assert.equal(readStatus(world.data).consecutive_failures, run + 1);
	}
	assert.equal(remoteCount(world.dataRemote, 'data'), before + 6);
	assert.equal(
		remoteLog(world.dataRemote, 'data')[0]?.subject,
		'data: 2026-10-29T11:18Z 0 rows'
	);
	assert.equal(readPriceFiles(world.data).size, 0, 'no price file');
	const lines = [...readLogLines(world.data).values()].flat();
	assert.equal(lines.length, 1 + 24 + 1);
	assert.equal(
		lines.filter((line) => line.endsWith(',0,timeout')).length,
		24
	);
	assertFileInvariants(world.data, 300);

	const status = readStatus(world.data);
	assert.equal(status.last_point_at, null);
	assert.equal(status.sources.kr?.consecutive_failures, 6);
	assert.equal(status.sources.cb?.failures_by_error.timeout, 6);
});

test('production: one no data Issue after four failed runs, none after more, closed when data returns', async () => {
	const world = await makeWorld({
		patch: (config) => {
			config.settings.phase = 'production';
			config.settings.stored_sources = ['kraken'];
			config.settings.features.alerts = true;
		},
	});
	world.market.down.set('kraken', 'timeout');
	const options = { issueClient: world.issues.client };
	for (let run = 0; run < 6; run += 1) {
		const result = await runAt(world, plusMinutes(T0, run * 15), options);
		assert.equal(result.exitCode, 0);
		assert.equal(
			world.issues.created.length,
			run >= 3 ? 1 : 0,
			`run ${run}`
		);
	}
	assert.equal(world.issues.created[0]?.title, '[collector] no data');
	assert.deepEqual(world.issues.created[0]?.labels, ['collector']);
	assert.equal(world.issues.closed.length, 0);

	world.market.down.clear();
	const back = await runAt(world, plusMinutes(T0, 6 * 15), options);
	assert.equal(back.rowsWritten, 11);
	assert.deepEqual(world.issues.closed, [1]);
	assert.equal(readStatus(world.data).consecutive_failures, 0);
	assert.equal(world.issues.created.length, 1);
	assertInSync(world.data, world.dataRemote, 'data');
});

test('production: a failing Issue API does not fail the run or lose the data', async () => {
	const world = await makeWorld({
		patch: (config) => {
			config.settings.phase = 'production';
			config.settings.stored_sources = ['kraken'];
			config.settings.features.alerts = true;
		},
	});
	const broken = {
		listOpenIssues: () => Promise.reject(new Error('API down')),
		createIssue: () => Promise.reject(new Error('API down')),
		addComment: () => Promise.reject(new Error('API down')),
		closeIssue: () => Promise.reject(new Error('API down')),
	};
	world.market.down.set('kraken', 'timeout');
	for (let run = 0; run < 5; run += 1) {
		const result = await runAt(world, plusMinutes(T0, run * 15), {
			issueClient: broken,
		});
		assert.equal(result.exitCode, 0);
	}
	assert.ok(
		world.logs.some((line) =>
			line.startsWith('no data Issue: failed: Error: API down')
		)
	);
	assert.equal(readStatus(world.data).consecutive_failures, 5);
	assertInSync(world.data, world.dataRemote, 'data');
});
