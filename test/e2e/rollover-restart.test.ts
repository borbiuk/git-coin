import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { appendRequestLog, appendRows } from '../../src/csv.ts';
import { appendOnlyGuard } from '../../src/gitdata.ts';
import type { PriceRow } from '../../src/types.ts';

import {
	T0,
	assertFileInvariants,
	assertInSync,
	cleanUpWorlds,
	git,
	makeWorld,
	plusMinutes,
	readPriceFiles,
	readStatus,
	remoteCount,
	remoteShow,
	rowsOf,
	runAt,
} from './harness.ts';

cleanUpWorlds();

test('day rollover: rows follow the UTC day of their own time, also inside one run', async () => {
	const world = await makeWorld();
	const starts = [
		'2026-10-29T23:44:00Z',
		'2026-10-29T23:59:55Z',
		'2026-10-30T00:15:00Z',
		'2026-10-30T00:30:00Z',
	];
	for (const start of starts) {
		// In the second run the clock passes midnight while the Coinbase requests are in progress
		let coinbaseCalls = 0;
		world.market.onRequest =
			start === starts[1]
				? (source) => {
						if (source === 'coinbase') {
							coinbaseCalls += 1;
							if (coinbaseCalls === 6) {
								world.clock.iso = '2026-10-30T00:00:03Z';
							}
						}
					}
				: null;
		const result = await runAt(world, start);
		assert.equal(result.exitCode, 0, start);
		assert.equal(result.rowsWritten, 44, start);
		assertInSync(world.data, world.dataRemote, 'data');
	}

	const days = new Set(
		[...readPriceFiles(world.data).keys()].map((file) => file.slice(0, 10))
	);
	assert.deepEqual([...days].sort(), ['2026/10/29', '2026/10/30']);
	assertFileInvariants(world.data, 300);

	for (const coin of world.config.coins) {
		const rows = rowsOf(world.data, coin.id);
		assert.equal(rows.length, 16, coin.id);
		// Each source has its four rows, none doubled, none lost
		for (const src of ['kr', 'cb', 'bs', 'cm']) {
			const own = rows.filter((row) => row.src === src);
			assert.equal(own.length, 4, `${coin.id} ${src}`);
			assert.equal(new Set(own.map((row) => row.ts)).size, 4);
		}
	}
	// The second run really crossed midnight for Coinbase: some rows are in the old day, some in the new one
	const crossing = world.config.coins
		.flatMap((coin) => rowsOf(world.data, coin.id))
		.filter(
			(row) =>
				row.src === 'cb' &&
				row.ts >= '2026-10-29T23:59:00Z' &&
				row.ts < '2026-10-30T00:05:00Z'
		);
	assert.ok(crossing.some((row) => row.file.startsWith('2026/10/29/')));
	assert.ok(crossing.some((row) => row.file.startsWith('2026/10/30/')));
	assert.equal(crossing.length, 11);

	const status = readStatus(world.data);
	assert.equal(status.sources.cb?.requests, 4);
	assert.equal(status.consecutive_failures, 0);
	world.market.onRequest = null;
});

test('the spacing guard works across midnight, where the last row is in the file of the day before', async () => {
	const world = await makeWorld();
	await runAt(world, '2026-10-29T23:58:30Z');
	// Two minutes later it is the next day. The rows of the first run are in the old day files.
	const result = await runAt(world, '2026-10-30T00:00:30Z');
	assert.equal(result.rowsWritten, 0);
	assert.equal(remoteCount(world.dataRemote, 'data'), 3);
	assert.deepEqual(
		[...readPriceFiles(world.data).keys()].filter((file) =>
			file.startsWith('2026/10/30/')
		),
		[]
	);
	// Ten minutes later the rows go to the new day
	const next = await runAt(world, '2026-10-30T00:10:00Z');
	assert.equal(next.rowsWritten, 44);
	assertFileInvariants(world.data, 300);
});

test('a restart inside min_spacing adds no row and no double. The boundary is exactly 300 seconds', async () => {
	const world = await makeWorld();
	assert.equal((await runAt(world, T0)).rowsWritten, 44);
	assert.equal((await runAt(world, plusMinutes(T0, 1))).rowsWritten, 0);
	assert.equal((await runAt(world, '2026-10-29T10:08:11Z')).rowsWritten, 0);
	assert.equal((await runAt(world, '2026-10-29T10:08:12Z')).rowsWritten, 44);
	for (const coin of world.config.coins) {
		assert.equal(rowsOf(world.data, coin.id).length, 8, coin.id);
	}
	assertFileInvariants(world.data, 300);
	assertInSync(world.data, world.dataRemote, 'data');
	// The skipped runs are still in the request log: the analysis counts ticks from it
	const status = readStatus(world.data);
	assert.equal(status.sources.kr?.requests, 4);
});

// ADR 0004 D2 and D3 (defect D-01, fixed). A re-run that finds the rows already stored is idle:
// it is not a failure, and it is not a success either.
test('a run whose rows were all skipped for spacing is idle: the streak and the last point do not move', async () => {
	const world = await makeWorld();
	await runAt(world, T0);
	for (let minute = 1; minute <= 4; minute += 1) {
		const result = await runAt(world, plusMinutes(T0, minute));
		assert.equal(result.rowsWritten, 0);
		const status = readStatus(world.data);
		assert.equal(status.consecutive_failures, 0, `restart ${minute}`);
		assert.equal(
			status.last_point_at,
			T0,
			'an idle run is not a new point'
		);
		assert.equal(status.last_run_at, plusMinutes(T0, minute));
	}
	// The request counters still count every run
	assert.equal(readStatus(world.data).sources.kr?.requests, 5);
});

test('idle runs do not hide a real failure: the streak counts runs that wrote nothing because the sources failed', async () => {
	const world = await makeWorld();
	await runAt(world, T0);
	await runAt(world, plusMinutes(T0, 1));
	for (const source of [
		'kraken',
		'coinbase',
		'bitstamp',
		'coinmetrics',
	] as const) {
		world.market.down.set(source, 'timeout');
	}
	await runAt(world, plusMinutes(T0, 15));
	await runAt(world, plusMinutes(T0, 16));
	assert.equal(readStatus(world.data).consecutive_failures, 2);
	// One healthy run resets it
	world.market.down.clear();
	await runAt(world, plusMinutes(T0, 30));
	assert.equal(readStatus(world.data).consecutive_failures, 0);
});

test('a run that died after writing leaves rows in the working tree. The next run commits them once', async () => {
	const world = await makeWorld();
	// A killed run: the rows are on disk, nothing is committed
	const rows: PriceRow[] = world.config.coins.map((coin) => ({
		ts: T0,
		coin: coin.id,
		price: '1.00',
		src: 'kr',
		age_s: null,
	}));
	await appendRows(world.data, rows, { minSpacingSeconds: 300 });
	await appendRequestLog(world.data, [
		{ ts: T0, src: 'kr', http: 200, ms: 5, coins_ok: 10, error: '' },
	]);
	assert.notEqual(git(world.data, 'status', '--porcelain'), '');

	const result = await runAt(world, plusMinutes(T0, 2));
	assert.equal(result.exitCode, 0);
	// Kraken is skipped by the spacing guard against the dead run's rows. The other sources are written.
	assert.equal(result.rowsWritten, 33);
	for (const coin of world.config.coins) {
		const kraken = rowsOf(world.data, coin.id).filter(
			(row) => row.src === 'kr'
		);
		assert.equal(kraken.length, 1, coin.id);
		assert.equal(kraken[0]?.price, '1.00');
	}
	assertInSync(world.data, world.dataRemote, 'data');
});

/** A committed half line: a cut write that somebody committed. The file does not end with a line break. */
async function worldWithHalfLine(): Promise<
	Awaited<ReturnType<typeof makeWorld>>
> {
	const world = await makeWorld();
	await runAt(world, T0);
	appendFileSync(
		join(world.data, 'data/raw/2026/10/29/BTC.csv'),
		'2026-10-29T10:1'
	);
	git(world.data, 'add', '-A');
	git(world.data, 'commit', '--quiet', '-m', 'Cut write');
	git(world.data, 'push', '--quiet', 'origin', 'HEAD:refs/heads/data');
	return world;
}

// Defect D-03, fixed: the guard accepts a half line that is only closed by a line break.
test('a committed half line is closed with a line break, kept as it is, and the new rows follow it', async () => {
	const world = await worldWithHalfLine();
	const before = remoteShow(
		world.dataRemote,
		'data',
		'data/raw/2026/10/29/BTC.csv'
	);
	assert.ok(!before.endsWith('\n'));
	const result = await runAt(world, plusMinutes(T0, 15));
	assert.equal(result.exitCode, 0);
	assert.equal(result.rowsWritten, 44);
	assertInSync(world.data, world.dataRemote, 'data');

	const after = remoteShow(
		world.dataRemote,
		'data',
		'data/raw/2026/10/29/BTC.csv'
	);
	// The old bytes are untouched. Only a line break and the new rows were added.
	assert.ok(after.startsWith(`${before}\n`));
	const lines = after.split('\n');
	assert.equal(lines.filter((line) => line === '2026-10-29T10:1').length, 1);
	assert.equal(lines.at(-1), '');
	// The half line is still one malformed line, and every other line is a row
	assert.equal(rowsOf(world.data, 'BTC').length, 8 + 1);
	assert.ok(world.logs.every((line) => !line.includes('Append-only guard')));
});

test('the guard still stops a real change of a line in a file that has a half line, and a line added to the half line', async () => {
	const world = await worldWithHalfLine();
	const file = join(world.data, 'data/raw/2026/10/29/BTC.csv');
	const original = readFileSync(file, 'utf8');

	// A rewritten price is not an append
	writeFileSync(
		file,
		original.replace(/^(2026-10-29T10:03:12Z),[^,]+,kr/m, '$1,2.00,kr')
	);
	assert.deepEqual(await appendOnlyGuard(world.data), {
		ok: false,
		deleted: 1,
	});

	// Text that continues the half line (no line break first) changes that line
	writeFileSync(file, `${original}5:00Z,1.00,kr,\n`);
	assert.equal((await appendOnlyGuard(world.data)).ok, false);

	// Closing it with a line break and adding a row is an append
	writeFileSync(file, `${original}\n2026-10-29T10:15:00Z,1.00,kr,\n`);
	assert.equal((await appendOnlyGuard(world.data)).ok, true);
});
