import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { runCollect } from '../../src/collect.ts';

import {
	T0,
	assertFileInvariants,
	assertInSync,
	cleanUpWorlds,
	depsOf,
	makeWorld,
	otherCommit,
	plusMinutes,
	readLogLines,
	readStatus,
	remoteCount,
	remoteLog,
	remoteShow,
	rejectPushes,
	rowsOf,
	runAt,
} from './harness.ts';
import type { World } from './harness.ts';

cleanUpWorlds();

/** Runs a full second collector on the full clone `other`, as if two runs overlapped. */
async function runOtherCollector(world: World, iso: string): Promise<void> {
	await runCollect(
		depsOf(world, {
			dataRoot: world.other,
			git: { repoDir: world.other, branch: 'data' },
			now: () => new Date(iso),
			log: () => undefined,
		})
	);
}

test('a push conflict from a second writer in the middle of a run: the shallow checkout resets and redoes the write', async () => {
	const world = await makeWorld();
	await runAt(world, T0);
	const logsBefore = remoteCount(world.dataRemote, 'data');

	let fired = false;
	world.market.onRequest = (source) => {
		if (source === 'kraken' && !fired) {
			fired = true;
			// The owner edits the README and also touches the status file while the run is fetching
			otherCommit(world, 'Owner edit', (dir) => {
				writeFileSync(join(dir, 'README.md'), 'Edited by the owner.\n');
				const status = JSON.parse(
					readFileSync(join(dir, 'state', 'status.json'), 'utf8')
				);
				status.last_publish_at = '2026-10-29T09:00:00Z';
				writeFileSync(
					join(dir, 'state', 'status.json'),
					`${JSON.stringify(status, null, 2)}\n`
				);
			});
		}
	};
	const requestsBefore = { ...world.market.requests };
	const result = await runAt(world, plusMinutes(T0, 15));
	world.market.onRequest = null;

	assert.deepEqual(result, {
		exitCode: 0,
		shouldPublish: false,
		rowsWritten: 40,
	});
	assert.ok(
		world.logs.some((line) =>
			line.startsWith('pushed after 2 tries: 40 rows written, 0 skipped')
		)
	);
	// The sources were asked once, not again for the retry
	assert.equal(world.market.requests.kraken - requestsBefore.kraken, 2);
	assert.equal(world.market.requests.coinbase - requestsBefore.coinbase, 10);

	// History: the owner commit is kept, ours is on top, nothing was force pushed
	const log = remoteLog(world.dataRemote, 'data');
	assert.equal(log.length, logsBefore + 2);
	assert.equal(log[0]?.name, 'github-actions[bot]');
	assert.equal(log[1]?.subject, 'Owner edit');
	assert.equal(
		remoteShow(world.dataRemote, 'data', 'README.md'),
		'Edited by the owner.\n'
	);
	assertInSync(world.data, world.dataRemote, 'data');

	// No row lost, none doubled, every counter counts the run once
	for (const coin of world.config.coins) {
		assert.equal(rowsOf(world.data, coin.id).length, 8, coin.id);
	}
	assertFileInvariants(world.data, 300);
	const status = readStatus(world.data);
	assert.equal(status.sources.kr?.requests, 2);
	assert.equal(status.last_run_at, plusMinutes(T0, 15));
	assert.equal(
		(
			JSON.parse(
				remoteShow(world.dataRemote, 'data', 'state/status.json')
			) as { last_publish_at: string }
		).last_publish_at,
		'2026-10-29T09:00:00Z',
		'the owner change of the status file survived the reset'
	);
	const lines = [...readLogLines(world.data).values()].flat();
	assert.equal(
		lines.length,
		1 + 8 + 1,
		'the request log has one line per source and run'
	);
});

test('an overlapping run that pushed first with older rows: ours are kept once and the spacing guard decides', async () => {
	const world = await makeWorld();
	let fired = false;
	world.market.onRequest = async (source) => {
		if (source === 'kraken' && !fired) {
			fired = true;
			world.market.onRequest = null;
			// Another run, 6 minutes earlier, finishes and pushes first
			await runOtherCollector(world, plusMinutes(T0, -6));
		}
	};
	const result = await runAt(world, T0);
	assert.equal(result.exitCode, 0);
	assert.equal(result.rowsWritten, 40);
	for (const coin of world.config.coins) {
		const rows = rowsOf(world.data, coin.id);
		assert.equal(rows.length, 8, coin.id);
		assert.equal(
			new Set(rows.map((row) => `${row.src}|${row.ts}`)).size,
			8
		);
	}
	assertFileInvariants(world.data, 300);
	assertInSync(world.data, world.dataRemote, 'data');
	assert.equal(readStatus(world.data).sources.kr?.requests, 2);
});

test('an overlapping run that pushed first with rows 1 minute earlier: nothing is doubled', async () => {
	const world = await makeWorld();
	let fired = false;
	world.market.onRequest = async (source) => {
		if (source === 'kraken' && !fired) {
			fired = true;
			world.market.onRequest = null;
			await runOtherCollector(world, plusMinutes(T0, -1));
		}
	};
	const result = await runAt(world, T0);
	assert.equal(result.exitCode, 0);
	// The rows of the other run are inside the spacing, so ours are skipped
	assert.equal(result.rowsWritten, 0);
	for (const coin of world.config.coins) {
		assert.equal(rowsOf(world.data, coin.id).length, 4, coin.id);
	}
	assertFileInvariants(world.data, 300);
	assertInSync(world.data, world.dataRemote, 'data');
	// Both runs are in the request log, the rows once
	assert.equal(readStatus(world.data).sources.kr?.requests, 2);
});

// ADR 0004 D2 (defect D-02, fixed): the message counts the rows that the last write really appended.
test('after a push conflict the commit message counts the rows of the last write, not of the first try', async () => {
	const world = await makeWorld();
	let fired = false;
	world.market.onRequest = async (source) => {
		if (source === 'kraken' && !fired) {
			fired = true;
			world.market.onRequest = null;
			await runOtherCollector(world, plusMinutes(T0, -1));
		}
	};
	await runAt(world, T0);
	// The other run's rows are 1 minute older, so all 40 rows of ours are skipped: the commit holds none
	const [ours, theirs] = remoteLog(world.dataRemote, 'data');
	assert.equal(ours?.subject, 'data: 2026-10-29T10:03Z 0 rows');
	assert.equal(theirs?.subject, 'data: 2026-10-29T10:02Z 40 rows');
	assert.equal(readStatus(world.data).consecutive_failures, 0, 'an idle run');
});

test('after a push conflict where our rows still fit, the message says so', async () => {
	const world = await makeWorld();
	let fired = false;
	world.market.onRequest = async (source) => {
		if (source === 'kraken' && !fired) {
			fired = true;
			world.market.onRequest = null;
			await runOtherCollector(world, plusMinutes(T0, -6));
		}
	};
	await runAt(world, T0);
	assert.equal(
		remoteLog(world.dataRemote, 'data')[0]?.subject,
		'data: 2026-10-29T10:03Z 40 rows'
	);
});

test('a plain run with one rejected push keeps a correct message too', async () => {
	const world = await makeWorld();
	rejectPushes(world.dataRemote, 1);
	await runAt(world, T0);
	assert.equal(
		remoteLog(world.dataRemote, 'data')[0]?.subject,
		'data: 2026-10-29T10:03Z 40 rows'
	);
});

test('an overlapping run that pushed first with newer rows: our older rows are dropped by the clock rule, not written out of order', async () => {
	const world = await makeWorld();
	let fired = false;
	world.market.onRequest = async (source) => {
		if (source === 'kraken' && !fired) {
			fired = true;
			world.market.onRequest = null;
			await runOtherCollector(world, plusMinutes(T0, 6));
		}
	};
	const result = await runAt(world, T0);
	assert.equal(result.exitCode, 0);
	assert.equal(result.rowsWritten, 0);
	for (const coin of world.config.coins) {
		assert.equal(rowsOf(world.data, coin.id).length, 4, coin.id);
	}
	assertFileInvariants(world.data, 300);
	assert.ok(world.logs.some((line) => /^skipped BTC kr: clock$/.test(line)));
});

test('a rejected push without any new commit on the remote: fetch finds nothing, the write is redone and pushed', async () => {
	const world = await makeWorld();
	rejectPushes(world.dataRemote, 1);
	const result = await runAt(world, T0);
	assert.deepEqual(result, {
		exitCode: 0,
		shouldPublish: false,
		rowsWritten: 40,
	});
	assert.ok(
		world.logs.some((line) =>
			line.startsWith('pushed after 2 tries: 40 rows written')
		)
	);
	assert.equal(remoteCount(world.dataRemote, 'data'), 2);
	assertInSync(world.data, world.dataRemote, 'data');
	assertFileInvariants(world.data, 300);
	assert.equal(readStatus(world.data).sources.kr?.requests, 1);
	assert.equal(
		[...readLogLines(world.data).values()].flat().length,
		1 + 4 + 1
	);
});

test('two rejected pushes in a row still end well on the third try', async () => {
	const world = await makeWorld();
	rejectPushes(world.dataRemote, 2);
	const result = await runAt(world, T0);
	assert.equal(result.rowsWritten, 40);
	assert.ok(
		world.logs.some((line) => line.startsWith('pushed after 3 tries'))
	);
	assert.equal(remoteCount(world.dataRemote, 'data'), 2);
	assertInSync(world.data, world.dataRemote, 'data');
});

test('three rejected pushes: exit 1, the checkout is left clean at the remote tip, and the next run starts fresh', async () => {
	const world = await makeWorld();
	rejectPushes(world.dataRemote, 3);
	const failed = await runAt(world, T0);
	assert.deepEqual(failed, {
		exitCode: 1,
		shouldPublish: false,
		rowsWritten: 0,
	});
	assert.ok(
		world.logs.some((line) =>
			line.startsWith('error: the data commit was not pushed (3 tries)')
		)
	);
	assert.equal(remoteCount(world.dataRemote, 'data'), 1);
	assertInSync(world.data, world.dataRemote, 'data');

	// The hook accepts again
	const next = await runAt(world, plusMinutes(T0, 15));
	assert.equal(next.rowsWritten, 40);
	// The failed run left nothing behind: the counters count the one good run
	assert.equal(readStatus(world.data).sources.kr?.requests, 1);
	assertFileInvariants(world.data, 300);
});

test('the remote moved ahead by several commits before the run starts: a stale shallow checkout catches up', async () => {
	const world = await makeWorld();
	await runAt(world, T0);
	for (let n = 1; n <= 4; n += 1) {
		otherCommit(world, `Owner note ${n}`, (dir) => {
			writeFileSync(join(dir, `note-${n}.txt`), `${n}\n`);
		});
	}
	const result = await runAt(world, plusMinutes(T0, 15));
	assert.equal(result.rowsWritten, 40);
	assert.equal(remoteCount(world.dataRemote, 'data'), 1 + 1 + 4 + 1);
	assertInSync(world.data, world.dataRemote, 'data');
	for (const coin of world.config.coins) {
		assert.equal(rowsOf(world.data, coin.id).length, 8, coin.id);
	}
	assertFileInvariants(world.data, 300);
});

test('a second writer removes a data line: our append goes on top of the edited tip', async () => {
	const world = await makeWorld();
	await runAt(world, T0);
	// The remote data file loses its last line while our run is fetching. Our own write only appends.
	let fired = false;
	world.market.onRequest = (source) => {
		if (source === 'kraken' && !fired) {
			fired = true;
			otherCommit(world, 'Hand edit', (dir) => {
				const file = join(dir, 'data/raw/2026/10/29/BTC.csv');
				const lines = readFileSync(file, 'utf8').split('\n');
				lines.splice(lines.length - 2, 1);
				writeFileSync(file, lines.join('\n'));
			});
		}
	};
	const result = await runAt(world, plusMinutes(T0, 15));
	world.market.onRequest = null;
	// Our rows are appended on top of the edited file. The guard compares with the new tip, so it passes.
	assert.equal(result.exitCode, 0);
	assertInSync(world.data, world.dataRemote, 'data');
	assert.equal(rowsOf(world.data, 'BTC').length, 3 + 4);
});
