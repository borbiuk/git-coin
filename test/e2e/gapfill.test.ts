import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
	T0,
	assertFileInvariants,
	assertInSync,
	cleanUpWorlds,
	makeWorld,
	plusMinutes,
	remoteLog,
	rowsOf,
	runAt,
} from './harness.ts';

cleanUpWorlds();

const FILL = { gapFill: { pauseMs: 0 } };

test('a missed run is filled with candles before the rows of the run', async () => {
	const world = await makeWorld();
	await runAt(world, T0, FILL);
	const before = rowsOf(world.data, 'BTC').length;

	// 95 minutes later: the candles that closed at 10:15, 10:30, 10:45, 11:00, 11:15 and 11:30 are missing
	const result = await runAt(world, plusMinutes(T0, 95), FILL);
	assert.equal(result.exitCode, 0);
	assert.equal(result.rowsWritten, 44);

	const rows = rowsOf(world.data, 'BTC');
	const candles = rows.filter((row) => row.src === 'bs-ohlc');
	assert.deepEqual(
		candles.map((row) => row.ts.slice(11, 16)),
		['10:15', '10:30', '10:45', '11:00', '11:15', '11:30']
	);
	assert.ok(candles.every((row) => row.age === ''));
	// The candles sit between the live rows of the two runs, so the file stays in time order
	const times = rows.map((row) => row.ts);
	assert.deepEqual(times, [...times].sort());
	assert.equal(rows.length, before + 4 + 6);
	// The USDT rate entry is filled too
	assert.equal(
		rowsOf(world.data, 'USDT').filter((row) => row.src === 'bs-ohlc')
			.length,
		6
	);
	assertFileInvariants(world.data, world.config.settings.min_spacing_seconds);
	assertInSync(world.data, world.dataRemote, 'data');
	assert.equal(
		remoteLog(world.dataRemote, 'data')[0]?.subject,
		'data: 2026-10-29T11:38Z 44 rows, 66 gap fill'
	);
	assert.ok(world.logs.includes('gap fill: 66 candle rows written'));
});

test('a normal delay is not a gap and a second run does not write the candles again', async () => {
	const world = await makeWorld();
	await runAt(world, T0, FILL);
	await runAt(world, plusMinutes(T0, 17), FILL);
	assert.equal(
		rowsOf(world.data, 'BTC').filter((row) => row.src === 'bs-ohlc').length,
		0
	);

	await runAt(world, plusMinutes(T0, 95), FILL);
	const once = rowsOf(world.data, 'BTC').filter(
		(row) => row.src === 'bs-ohlc'
	).length;
	await runAt(world, plusMinutes(T0, 96), FILL);
	assert.equal(
		rowsOf(world.data, 'BTC').filter((row) => row.src === 'bs-ohlc').length,
		once
	);
});

test('a failing Bitstamp does not fail the run and the gap is filled by a later run', async () => {
	const world = await makeWorld();
	await runAt(world, T0, FILL);

	world.market.down.set('bitstamp', 'http_429');
	const failed = await runAt(world, plusMinutes(T0, 95), FILL);
	assert.equal(failed.exitCode, 0);
	assert.ok(world.logs.some((line) => line.startsWith('gap fill: HTTP 429')));
	assert.equal(
		rowsOf(world.data, 'BTC').filter((row) => row.src === 'bs-ohlc').length,
		0
	);

	// The open gap is kept in the data branch, so the next run knows where to start
	assert.deepEqual(
		JSON.parse(
			readFileSync(join(world.data, 'state', 'gapfill.json'), 'utf8')
		).pending.BTC,
		'2026-10-29T10:03:12Z'
	);

	world.market.down.delete('bitstamp');
	await runAt(world, plusMinutes(T0, 110), FILL);
	assert.equal(
		rowsOf(world.data, 'BTC').filter((row) => row.src === 'bs-ohlc').length,
		7
	);
	assert.deepEqual(
		JSON.parse(
			readFileSync(join(world.data, 'state', 'gapfill.json'), 'utf8')
		).pending,
		{}
	);
});

test('the gap fill is off when the deps say so', async () => {
	const world = await makeWorld();
	await runAt(world, T0);
	await runAt(world, plusMinutes(T0, 95));
	assert.equal(
		rowsOf(world.data, 'BTC').filter((row) => row.src === 'bs-ohlc').length,
		0
	);
});
