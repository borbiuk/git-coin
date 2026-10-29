import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildSite } from '../../src/build-site.ts';

import {
	T0,
	assertFileInvariants,
	assertInSync,
	cleanUpWorlds,
	makeWorld,
	plusMinutes,
	rejectPushes,
	remoteLog,
	remoteShow,
	rowsOf,
	runAt,
} from './harness.ts';

cleanUpWorlds();

function productionWorld(): ReturnType<typeof makeWorld> {
	return makeWorld({
		patch: (config) => {
			config.settings.phase = 'production';
			config.settings.stored_sources = ['kraken'];
			config.settings.features.alerts = true;
			config.settings.features.publish = true;
		},
	});
}

test('production: one source is stored, publishing follows the 30 minute rule', async () => {
	const world = await productionWorld();
	const flags: boolean[] = [];
	for (let run = 0; run < 6; run += 1) {
		const result = await runAt(world, plusMinutes(T0, run * 15), {
			issueClient: world.issues.client,
		});
		assert.equal(result.rowsWritten, 10);
		flags.push(result.shouldPublish);
	}
	// A publish at 0 minutes, none at 15, one at 30, none at 45, one at 60, none at 75
	assert.deepEqual(flags, [true, false, true, false, true, false]);
	for (const coin of world.config.coins) {
		const rows = rowsOf(world.data, coin.id);
		assert.equal(rows.length, 6);
		assert.ok(rows.every((row) => row.src === 'kr'));
	}
	assert.equal(world.market.requests.coinbase, 0);
	assert.equal(world.market.requests.bitstamp, 0);
	assertFileInvariants(world.data, 300);
	assertInSync(world.data, world.dataRemote, 'data');
});

test('production: a sharp move opens one Issue, the alert state is its own commit after the data commit, and the rest follows ADR 0006', async () => {
	const world = await productionWorld();
	const options = { issueClient: world.issues.client };
	for (let run = 0; run < 5; run += 1) {
		await runAt(world, plusMinutes(T0, run * 15), options);
	}
	assert.equal(
		world.issues.created.length,
		0,
		'a quiet market opens nothing'
	);

	// ETH jumps 7 percent. The reference is the run one hour earlier. The threshold of ETH is 4 percent.
	world.market.scale.set('ETH', 1.07);
	const result = await runAt(world, plusMinutes(T0, 75), options);
	assert.equal(result.exitCode, 0);
	assert.equal(world.issues.created.length, 1);
	const issue = world.issues.created[0];
	assert.match(
		issue?.title ?? '',
		/^\[ALERT\] ETH up \d\.\d% in 1h \(3,\d{3}\.\d{2,} USD\)$/
	);
	assert.deepEqual(issue?.labels, [
		'alert',
		'coin:ETH',
		'dir:up',
		'window:1h',
		'severity:warning',
	]);
	assert.deepEqual(issue?.assignees, ['borbiuk']);
	assert.match(issue?.body ?? '', /^Coin: ETH \(Ethereum\)$/m);
	assert.match(issue?.body ?? '', /^Source: Kraken\. Quote: USD\.$/m);
	assert.match(
		issue?.body ?? '',
		/^Dashboard: https:\/\/example\.test\/git-coin\/$/m
	);
	assert.match(issue?.body ?? '', /^@borbiuk$/m);
	assert.match(issue?.body ?? '', /Not financial advice/);

	// Two commits for this run: the data first, the alert state on top
	const [state, data] = remoteLog(world.dataRemote, 'data');
	assert.equal(state?.subject, 'state: alerts 2026-10-29T11:18Z');
	assert.equal(state?.name, 'github-actions[bot]');
	assert.match(data?.subject ?? '', /^data: 2026-10-29T11:18Z 10 rows$/);
	const saved = JSON.parse(
		remoteShow(world.dataRemote, 'data', 'state/alerts.json')
	) as {
		keys: Record<string, { issue: number }>;
		daily: { created: number };
		recent: Array<{ coin: string; severity: string }>;
	};
	assert.equal(saved.keys['ETH:up']?.issue, 1);
	assert.equal(saved.daily.created, 1);
	assert.equal(saved.recent[0]?.severity, 'warning');
	assertInSync(world.data, world.dataRemote, 'data');

	// Next tick, same high price: inside the cooldown, so no new Issue and no comment
	await runAt(world, plusMinutes(T0, 90), options);
	assert.equal(world.issues.created.length, 1);
	assert.equal(world.issues.comments.length, 0);

	// The site builder turns the state into the list of the dashboard
	const out = join(world.root, 'site-out');
	await buildSite({
		dataRoot: world.data,
		config: world.config,
		outDir: out,
		now: new Date(plusMinutes(T0, 91)),
	});
	const alerts = JSON.parse(
		readFileSync(join(out, 'alerts.json'), 'utf8')
	) as {
		alerts: Array<Record<string, unknown>>;
	};
	assert.equal(alerts.alerts.length, 1);
	assert.deepEqual(alerts.alerts[0], {
		coin: 'ETH',
		ts: plusMinutes(T0, 75),
		direction: 'up',
		severity: 'high',
		issue: 1,
	});

	// 24 hours with no new trigger: the Issue is closed with a comment, and the state commit says so
	world.market.scale.set('ETH', 1);
	const late = await runAt(world, plusMinutes(T0, 90 + 24 * 60 + 1), options);
	assert.equal(late.exitCode, 0);
	assert.deepEqual(world.issues.closed, [1]);
	assert.match(
		world.issues.comments.at(-1)?.body ?? '',
		/^No new trigger in 24 hours\. Closing\.$/
	);
	assert.equal(
		(
			JSON.parse(
				remoteShow(world.dataRemote, 'data', 'state/alerts.json')
			) as { keys: Record<string, { issue: number | null }> }
		).keys['ETH:up']?.issue,
		null
	);
	assertInSync(world.data, world.dataRemote, 'data');
});

test('production: a rejected push of the alert state commit is retried from the remote tip', async () => {
	const world = await productionWorld();
	const options = { issueClient: world.issues.client };
	for (let run = 0; run < 5; run += 1) {
		await runAt(world, plusMinutes(T0, run * 15), options);
	}
	// The data push of the next run passes, the alert state push is rejected once
	rejectPushes(world.dataRemote, 1, 1);
	world.market.scale.set('ETH', 1.07);
	await runAt(world, plusMinutes(T0, 75), options);
	assert.equal(world.issues.created.length, 1);
	assert.equal(
		remoteLog(world.dataRemote, 'data')[0]?.subject,
		'state: alerts 2026-10-29T11:18Z'
	);
	assert.ok(
		!world.logs.some((line) =>
			line.includes('the state commit was not pushed')
		)
	);
	assert.equal(
		(
			JSON.parse(
				remoteShow(world.dataRemote, 'data', 'state/alerts.json')
			) as { keys: Record<string, { issue: number }> }
		).keys['ETH:up']?.issue,
		1
	);
	assertInSync(world.data, world.dataRemote, 'data');
});

test('production: an Issue is not lost when the state commit cannot be pushed, and the next run does not open a second one', async () => {
	const world = await productionWorld();
	const options = { issueClient: world.issues.client };
	for (let run = 0; run < 5; run += 1) {
		await runAt(world, plusMinutes(T0, run * 15), options);
	}
	// The data push passes. All three tries of the state push fail.
	rejectPushes(world.dataRemote, 3, 1);
	world.market.scale.set('ETH', 1.07);
	await runAt(world, plusMinutes(T0, 75), options);
	assert.equal(world.issues.created.length, 1);
	assert.ok(
		world.logs.some((line) =>
			line.includes('the state commit was not pushed')
		)
	);

	// The state file is not on the remote, so the next run does not know about the Issue.
	// It must adopt the open Issue by its labels and add a comment, not open a second Issue.
	await runAt(world, plusMinutes(T0, 90), options);
	assert.equal(world.issues.created.length, 1, 'still one Issue');
	assert.equal(world.issues.comments.length, 1);
});
