import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import {
	T0,
	assertInSync,
	cleanUpWorlds,
	git,
	makeWorld,
	plusMinutes,
	remoteCount,
	remoteLog,
	remoteTip,
	runAt,
} from './harness.ts';

cleanUpWorlds();

const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

// The keepalive commit gets its date from git, which reads these two variables. The tests set them to
// the injected clock, so "now" and the commit date agree.
afterEach(() => {
	delete process.env.GIT_COMMITTER_DATE;
	delete process.env.GIT_AUTHOR_DATE;
});

function useGitDate(iso: string): void {
	process.env.GIT_COMMITTER_DATE = iso;
	process.env.GIT_AUTHOR_DATE = iso;
}

test('a stale shallow main gets one empty bot commit, and the data run is not affected', async () => {
	const world = await makeWorld({ mainDate: '2026-08-01T00:00:00Z' });
	useGitDate(T0);
	const options = { keepalive: { mainDir: world.code, maxAgeDays: 30 } };

	const result = await runAt(world, T0, options);
	assert.equal(result.rowsWritten, 44);
	assert.ok(world.logs.includes('keepalive: pushed an empty commit to main'));

	assert.equal(remoteCount(world.mainRemote, 'main'), 2);
	const [latest, seed] = remoteLog(world.mainRemote, 'main');
	assert.equal(latest?.subject, 'Keep schedule active');
	assert.equal(latest?.name, 'github-actions[bot]');
	assert.equal(latest?.email, BOT_EMAIL);
	assert.equal(seed?.subject, 'Seed');
	// Empty means the same tree as the parent
	assert.equal(
		git(world.mainRemote, 'rev-parse', 'refs/heads/main^{tree}'),
		git(world.mainRemote, 'rev-parse', 'refs/heads/main~1^{tree}')
	);
	assertInSync(world.code, world.mainRemote, 'main');
	assertInSync(world.data, world.dataRemote, 'data');

	// The next tick: main is fresh now, so no second commit
	world.logs.length = 0;
	const again = await runAt(world, plusMinutes(T0, 15), options);
	assert.equal(again.rowsWritten, 44);
	assert.ok(world.logs.includes('keepalive: not needed'));
	assert.equal(remoteCount(world.mainRemote, 'main'), 2);
});

test('a recent main is left alone', async () => {
	const world = await makeWorld({ mainDate: '2026-10-20T00:00:00Z' });
	const tip = remoteTip(world.mainRemote, 'main');
	await runAt(world, T0, {
		keepalive: { mainDir: world.code, maxAgeDays: 30 },
	});
	assert.equal(remoteTip(world.mainRemote, 'main'), tip);
	assert.ok(world.logs.includes('keepalive: not needed'));
});

test('a detached shallow checkout of main works the same', async () => {
	const world = await makeWorld({ mainDate: '2026-08-01T00:00:00Z' });
	git(world.code, 'checkout', '--quiet', '--detach');
	useGitDate(T0);
	await runAt(world, T0, {
		keepalive: { mainDir: world.code, maxAgeDays: 30 },
	});
	assert.equal(remoteCount(world.mainRemote, 'main'), 2);
});

test('a rejected keepalive push is logged, the local commit is removed, and the data run still succeeds', async () => {
	const world = await makeWorld({ mainDate: '2026-08-01T00:00:00Z' });
	useGitDate(T0);
	// The owner pushes to main between the checkout and the keepalive step
	const owner = join(world.root, 'owner-main');
	git(world.root, 'clone', '--quiet', `file://${world.mainRemote}`, owner);
	git(owner, 'config', 'user.name', 'Owner');
	git(owner, 'config', 'user.email', 'owner@example.test');
	git(owner, 'commit', '--quiet', '--allow-empty', '-m', 'Owner commit');
	git(owner, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
	const base = git(world.code, 'rev-parse', 'HEAD');

	const result = await runAt(world, T0, {
		keepalive: { mainDir: world.code, maxAgeDays: 30 },
	});
	assert.equal(result.exitCode, 0);
	assert.equal(result.rowsWritten, 44);
	assert.ok(
		world.logs.some((line) =>
			line.startsWith('keepalive: failed: Error: git push failed')
		)
	);
	assert.equal(
		git(world.code, 'rev-parse', 'HEAD'),
		base,
		'the local keepalive commit is gone'
	);
	assert.equal(
		remoteCount(world.mainRemote, 'main'),
		2,
		'only the owner commit is on main'
	);
	assertInSync(world.data, world.dataRemote, 'data');
});

test('the keepalive does not run in a dry run', async () => {
	const world = await makeWorld({ mainDate: '2026-08-01T00:00:00Z' });
	const tip = remoteTip(world.mainRemote, 'main');
	await runAt(world, T0, {
		dryRun: true,
		keepalive: { mainDir: world.code, maxAgeDays: 30 },
	});
	assert.equal(remoteTip(world.mainRemote, 'main'), tip);
});
