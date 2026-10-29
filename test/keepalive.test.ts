import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { keepaliveIfStale } from '../src/keepalive.ts';

// The tests must not read or change the global or the system git config.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
delete process.env.GIT_DIR;
delete process.env.GIT_WORK_TREE;
delete process.env.GIT_INDEX_FILE;

const roots: string[] = [];

after(() => {
	for (const root of roots) {
		rmSync(root, { recursive: true, force: true });
	}
});

function git(cwd: string, args: string[], date?: string): string {
	const env =
		date === undefined
			? process.env
			: {
					...process.env,
					GIT_AUTHOR_DATE: date,
					GIT_COMMITTER_DATE: date,
				};
	return execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();
}

const AUTHOR = { name: 'Test Bot', email: 'bot@example.test' };

/** A bare remote with one commit on `main` made at `commitDate`, and a clone of it. */
function makeFixture(commitDate: string): { remote: string; main: string } {
	const root = mkdtempSync(join(tmpdir(), 'git-coin-keepalive-'));
	roots.push(root);
	const remote = join(root, 'remote.git');
	const seed = join(root, 'seed');
	const main = join(root, 'main');
	git(root, ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
	git(root, ['init', '--quiet', '--initial-branch=main', seed]);
	git(seed, ['config', 'user.name', 'Seed']);
	git(seed, ['config', 'user.email', 'seed@example.test']);
	writeFileSync(join(seed, 'README.md'), 'seed\n');
	git(seed, ['add', '-A']);
	git(seed, ['commit', '--quiet', '-m', 'Seed'], commitDate);
	git(seed, ['push', '--quiet', remote, 'main']);
	git(root, ['clone', '--quiet', remote, main]);
	return { remote, main };
}

const NOW = new Date('2026-10-29T12:00:00Z');

test('keepaliveIfStale pushes an empty commit when the last commit is too old', async () => {
	const { remote, main } = makeFixture('2026-09-01T12:00:00Z');
	const oldHead = git(main, ['rev-parse', 'HEAD']);

	const result = await keepaliveIfStale({
		mainDir: main,
		now: NOW,
		maxAgeDays: 30,
		author: AUTHOR,
	});

	assert.equal(result, true);
	const head = git(remote, ['rev-parse', 'main']);
	assert.notEqual(head, oldHead);
	assert.equal(git(remote, ['rev-parse', `${head}^`]), oldHead);
	assert.equal(
		git(remote, ['log', '-1', '--format=%s|%an <%ae>', 'main']),
		'Keep schedule active|Test Bot <bot@example.test>'
	);
	assert.equal(
		git(remote, ['diff-tree', '--no-commit-id', '--name-only', '-r', head]),
		''
	);
});

test('keepaliveIfStale does nothing when the last commit is recent', async () => {
	const { remote, main } = makeFixture('2026-10-20T12:00:00Z');
	const head = git(remote, ['rev-parse', 'main']);

	const result = await keepaliveIfStale({
		mainDir: main,
		now: NOW,
		maxAgeDays: 30,
		author: AUTHOR,
	});

	assert.equal(result, false);
	assert.equal(git(remote, ['rev-parse', 'main']), head);
	assert.equal(git(main, ['rev-parse', 'HEAD']), head);
});

test('keepaliveIfStale treats a commit of exactly maxAgeDays as recent', async () => {
	const { remote, main } = makeFixture('2026-09-29T12:00:00Z');
	const head = git(remote, ['rev-parse', 'main']);

	const result = await keepaliveIfStale({
		mainDir: main,
		now: NOW,
		maxAgeDays: 30,
		author: AUTHOR,
	});

	assert.equal(result, false);
	assert.equal(git(remote, ['rev-parse', 'main']), head);
});

test('keepaliveIfStale throws and removes its commit when the push is rejected', async () => {
	const { remote, main } = makeFixture('2026-09-01T12:00:00Z');
	const hook = join(remote, 'hooks/pre-receive');
	writeFileSync(hook, '#!/bin/sh\nexit 1\n');
	chmodSync(hook, 0o755);
	const head = git(main, ['rev-parse', 'HEAD']);

	await assert.rejects(
		keepaliveIfStale({
			mainDir: main,
			now: NOW,
			maxAgeDays: 30,
			author: AUTHOR,
		}),
		/git push failed/
	);
	assert.equal(git(main, ['rev-parse', 'HEAD']), head);
	assert.equal(git(remote, ['rev-parse', 'main']), head);
});
