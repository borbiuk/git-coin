import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	T0,
	assertInSync,
	cleanUpWorlds,
	makeWorld,
	plusMinutes,
	remoteLog,
	runAt,
} from './harness.ts';
import type { World } from './harness.ts';

cleanUpWorlds();

function allDown(world: World): void {
	for (const source of [
		'kraken',
		'coinbase',
		'bitstamp',
		'coinmetrics',
	] as const) {
		world.market.down.set(source, 'timeout');
	}
}

// Defect D-04, fixed: the `no data` Issue is a health signal, so it works in the test phase too.
test('test phase: four failed runs open the no data Issue, one healthy run closes it, and a healthy run makes no Issue call', async () => {
	const world = await makeWorld();
	assert.equal(world.config.settings.phase, 'test');
	assert.equal(world.config.settings.features.alerts, false);
	const options = { issueClient: world.issues.client };

	// Healthy runs with no open Issue make no client call at all
	await runAt(world, T0, options);
	await runAt(world, plusMinutes(T0, 15), options);
	assert.equal(world.issues.calls, 0);

	allDown(world);
	for (let run = 0; run < 6; run += 1) {
		await runAt(world, plusMinutes(T0, 30 + run * 15), options);
		assert.equal(
			world.issues.created.length,
			run >= 3 ? 1 : 0,
			`run ${run}`
		);
	}
	assert.equal(world.issues.created[0]?.title, '[collector] no data');
	assert.deepEqual(world.issues.created[0]?.labels, ['collector']);
	assert.deepEqual(world.issues.created[0]?.assignees, ['borbiuk']);
	assert.equal(world.issues.closed.length, 0);

	// One healthy run closes it with a comment
	world.market.down.clear();
	const back = await runAt(world, plusMinutes(T0, 30 + 6 * 15), options);
	assert.equal(back.rowsWritten, 40);
	assert.deepEqual(world.issues.closed, [1]);
	assert.equal(world.issues.comments.length, 1);

	// The next healthy run has nothing to do for the Issue
	const calls = world.issues.calls;
	await runAt(world, plusMinutes(T0, 30 + 7 * 15), options);
	assert.equal(world.issues.calls, calls);

	// The test phase still runs no alert step: there is no alert state commit
	assert.deepEqual(
		remoteLog(world.dataRemote, 'data').filter((entry) =>
			entry.subject.startsWith('state:')
		),
		[]
	);
	assertInSync(world.data, world.dataRemote, 'data');
});

test('test phase: idle restarts do not open the no data Issue', async () => {
	const world = await makeWorld();
	const options = { issueClient: world.issues.client };
	await runAt(world, T0, options);
	for (let minute = 1; minute <= 5; minute += 1) {
		await runAt(world, plusMinutes(T0, minute), options);
	}
	assert.equal(world.issues.calls, 0);
});

test('test phase: a dry run never touches the Issue client, even after four failed runs', async () => {
	const world = await makeWorld();
	allDown(world);
	for (let run = 0; run < 4; run += 1) {
		await runAt(world, plusMinutes(T0, run * 15));
	}
	await runAt(world, plusMinutes(T0, 60), {
		dryRun: true,
		issueClient: world.issues.client,
	});
	assert.equal(world.issues.calls, 0);
});
