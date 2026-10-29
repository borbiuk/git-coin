import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
	appendOnlyGuard,
	BOT_AUTHOR,
	commitAndPush,
	type GitOpts,
} from '../src/gitdata.ts';

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

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const CSV = 'data/raw/2026/10/29/BTC.csv';
const HEADER = 'ts,price,src,age_s';

interface Fixture {
	root: string;
	remote: string;
	a: string;
	b: string;
}

/** A bare remote with one commit on `data`, and two clones of it with a local identity. */
function makeFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), 'git-coin-gitdata-'));
	roots.push(root);
	const remote = join(root, 'remote.git');
	const seed = join(root, 'seed');
	git(root, 'init', '--quiet', '--bare', '--initial-branch=data', remote);
	git(root, 'init', '--quiet', '--initial-branch=data', seed);
	git(seed, 'config', 'user.name', 'Seed');
	git(seed, 'config', 'user.email', 'seed@example.test');
	mkdirSync(join(seed, 'data/raw/2026/10/29'), { recursive: true });
	writeFileSync(join(seed, CSV), `${HEADER}\n`);
	mkdirSync(join(seed, 'state'));
	writeFileSync(join(seed, 'state/status.json'), '{"n":1}\n');
	git(seed, 'add', '-A');
	git(seed, 'commit', '--quiet', '-m', 'Seed');
	git(seed, 'push', '--quiet', remote, 'data');
	const a = join(root, 'a');
	const b = join(root, 'b');
	for (const dir of [a, b]) {
		git(root, 'clone', '--quiet', remote, dir);
		git(dir, 'config', 'user.name', 'Clone');
		git(dir, 'config', 'user.email', 'clone@example.test');
	}
	return { root, remote, a, b };
}

function opts(dir: string, extra: Partial<GitOpts> = {}): GitOpts {
	return { repoDir: dir, branch: 'data', ...extra };
}

function appendLine(dir: string, line: string): void {
	const path = join(dir, CSV);
	writeFileSync(path, `${readFileSync(path, 'utf8')}${line}\n`);
}

function remoteCsv(remote: string): string {
	return git(remote, 'show', `data:${CSV}`);
}

test('commitAndPush pushes one commit made by the bot', async () => {
	const { remote, a } = makeFixture();
	let writes = 0;
	const result = await commitAndPush(
		opts(a),
		'data: 2026-10-29T14:03Z 1 rows',
		async () => {
			writes += 1;
			appendLine(a, '2026-10-29T14:03:12Z,100.00,kr,');
			return Promise.resolve();
		}
	);
	assert.equal(result.pushed, true);
	assert.equal(result.tries, 1);
	assert.equal(writes, 1);
	assert.equal(result.commit, git(remote, 'rev-parse', 'data'));
	assert.equal(
		remoteCsv(remote),
		`${HEADER}\n2026-10-29T14:03:12Z,100.00,kr,`
	);
	assert.equal(
		git(remote, 'log', '-1', '--format=%an <%ae>|%cn|%s', 'data'),
		`${BOT_AUTHOR.name} <${BOT_AUTHOR.email}>|${BOT_AUTHOR.name}|data: 2026-10-29T14:03Z 1 rows`
	);
});

test('commitAndPush uses the author from the options', async () => {
	const { remote, a } = makeFixture();
	const author = { name: 'Test Bot', email: 'bot@example.test' };
	await commitAndPush(opts(a, { author }), 'data: test', () => {
		appendLine(a, 'row');
		return Promise.resolve();
	});
	assert.equal(
		git(remote, 'log', '-1', '--format=%an <%ae>', 'data'),
		'Test Bot <bot@example.test>'
	);
});

test('commitAndPush also commits a rewrite of the state file', async () => {
	const { remote, a } = makeFixture();
	const result = await commitAndPush(opts(a), 'data: state', () => {
		writeFileSync(join(a, 'state/status.json'), '{"n":2}\n');
		return Promise.resolve();
	});
	assert.equal(result.pushed, true);
	assert.equal(git(remote, 'show', 'data:state/status.json'), '{"n":2}');
});

test('commitAndPush retries after a rejected push without losing or doubling a row', async () => {
	const { remote, a, b } = makeFixture();
	// Clone b pushes first, so the push of clone a is rejected
	const first = await commitAndPush(opts(b), 'data: b', () => {
		appendLine(b, 'row-b');
		return Promise.resolve();
	});
	assert.equal(first.pushed, true);

	let writes = 0;
	const result = await commitAndPush(opts(a), 'data: a', () => {
		writes += 1;
		appendLine(a, 'row-a');
		return Promise.resolve();
	});
	assert.equal(result.pushed, true);
	assert.equal(result.tries, 2);
	assert.equal(writes, 2);
	assert.equal(remoteCsv(remote), `${HEADER}\nrow-b\nrow-a`);
	assert.equal(git(a, 'status', '--porcelain'), '');
	assert.equal(git(remote, 'rev-list', '--count', 'data'), '3');
});

test('commitAndPush aborts without a commit when the write removes a line', async () => {
	const { remote, a } = makeFixture();
	const head = git(a, 'rev-parse', 'HEAD');
	const remoteHead = git(remote, 'rev-parse', 'data');
	await assert.rejects(
		commitAndPush(opts(a), 'data: bad', () => {
			writeFileSync(join(a, CSV), 'ts,price,src\n');
			return Promise.resolve();
		}),
		/Append-only guard failed: 1 deleted lines/
	);
	assert.equal(git(a, 'rev-parse', 'HEAD'), head);
	assert.equal(git(remote, 'rev-parse', 'data'), remoteHead);
});

test('commitAndPush makes no commit when nothing changed', async () => {
	const { remote, a } = makeFixture();
	const remoteHead = git(remote, 'rev-parse', 'data');
	let writes = 0;
	const result = await commitAndPush(opts(a), 'data: none', () => {
		writes += 1;
		return Promise.resolve();
	});
	assert.deepEqual(result, { pushed: false, commit: null, tries: 1 });
	assert.equal(writes, 1);
	assert.equal(git(remote, 'rev-parse', 'data'), remoteHead);
	assert.equal(git(a, 'rev-parse', 'HEAD'), remoteHead);
});

test('commitAndPush gives up after 3 tries when the remote rejects every push', async () => {
	const { remote, a } = makeFixture();
	const hook = join(remote, 'hooks/pre-receive');
	writeFileSync(hook, '#!/bin/sh\nexit 1\n');
	chmodSync(hook, 0o755);
	const head = git(a, 'rev-parse', 'HEAD');

	let writes = 0;
	const result = await commitAndPush(opts(a), 'data: rejected', () => {
		writes += 1;
		appendLine(a, 'row');
		return Promise.resolve();
	});
	assert.deepEqual(result, { pushed: false, commit: null, tries: 3 });
	assert.equal(writes, 3);
	assert.equal(git(remote, 'rev-parse', 'data'), head);
	// The working tree is back to the remote state, so a later run does not double the row
	assert.equal(git(a, 'rev-parse', 'HEAD'), head);
	assert.equal(git(a, 'status', '--porcelain'), '');
});

test('commitAndPush returns pushed false when the remote cannot be reached', async () => {
	const { root, a } = makeFixture();
	git(a, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
	const head = git(a, 'rev-parse', 'HEAD');

	let writes = 0;
	const result = await commitAndPush(opts(a), 'data: offline', () => {
		writes += 1;
		appendLine(a, 'row');
		return Promise.resolve();
	});
	assert.deepEqual(result, { pushed: false, commit: null, tries: 3 });
	assert.equal(writes, 3);
	assert.equal(git(a, 'rev-parse', 'HEAD'), head);
	assert.equal(git(a, 'status', '--porcelain'), '');
});

test('appendOnlyGuard accepts appended lines and new files', async () => {
	const { a } = makeFixture();
	appendLine(a, 'row');
	mkdirSync(join(a, 'data/meta/2026/10/29'), { recursive: true });
	writeFileSync(join(a, 'data/meta/2026/10/29/requests.csv'), 'ts\n');
	assert.deepEqual(await appendOnlyGuard(a), { ok: true, deleted: 0 });
});

test('appendOnlyGuard counts a changed line, a deleted file and ignores state', async () => {
	const { a } = makeFixture();
	// Replacing the header removes one line and adds one
	writeFileSync(join(a, CSV), 'other\n');
	writeFileSync(join(a, 'state/status.json'), '{"n":9}\n');
	assert.deepEqual(await appendOnlyGuard(a), { ok: false, deleted: 1 });

	rmSync(join(a, CSV));
	assert.deepEqual(await appendOnlyGuard(a), { ok: false, deleted: 1 });
});

/** Commits and pushes `content` as the daily file, so HEAD holds it exactly (for example without a final line break). */
function commitCsv(dir: string, content: string): void {
	writeFileSync(join(dir, CSV), content);
	git(dir, 'add', '-A');
	git(dir, 'commit', '--quiet', '-m', 'Set the file');
	git(dir, 'push', '--quiet', 'origin', 'data');
}

test('commitAndPush writes the message function after the redone write', async () => {
	const { remote, a, b } = makeFixture();
	// An overlapping run (clone b) already pushed rows 1 and 2
	await commitAndPush(opts(b), 'data: b', () => {
		appendLine(b, 'row-1');
		appendLine(b, 'row-2');
		return Promise.resolve();
	});

	// The write skips the rows that the file already has, like the spacing guard of the collector
	let count = 0;
	const result = await commitAndPush(
		opts(a),
		() => `data: ${count} rows`,
		() => {
			const existing = readFileSync(join(a, CSV), 'utf8').split('\n');
			count = 0;
			for (const row of ['row-1', 'row-2', 'row-3']) {
				if (!existing.includes(row)) {
					appendLine(a, row);
					count += 1;
				}
			}
			return Promise.resolve();
		}
	);
	assert.equal(result.pushed, true);
	assert.equal(result.tries, 2);
	assert.equal(
		git(remote, 'log', '-1', '--format=%s', 'data'),
		'data: 1 rows'
	);
	assert.equal(remoteCsv(remote), `${HEADER}\nrow-1\nrow-2\nrow-3`);
});

test('appendOnlyGuard accepts closing a half line', async () => {
	const { a } = makeFixture();
	commitCsv(a, `${HEADER}\nrow-1,100.5`);
	writeFileSync(join(a, CSV), `${HEADER}\nrow-1,100.5\nrow-2,101.5\n`);
	assert.deepEqual(await appendOnlyGuard(a), { ok: true, deleted: 0 });
});

test('appendOnlyGuard accepts closing a half line in the meta folder', async () => {
	const { a } = makeFixture();
	const meta = join(a, 'data/meta/2026/10/29');
	mkdirSync(meta, { recursive: true });
	writeFileSync(join(meta, 'requests.csv'), 'ts,src\nrow-1');
	git(a, 'add', '-A');
	git(a, 'commit', '--quiet', '-m', 'Add the log');
	writeFileSync(join(meta, 'requests.csv'), 'ts,src\nrow-1\nrow-2\n');
	assert.deepEqual(await appendOnlyGuard(a), { ok: true, deleted: 0 });
});

test('commitAndPush commits a closed half line', async () => {
	const { remote, a } = makeFixture();
	commitCsv(a, `${HEADER}\nrow-1,100.5`);
	const result = await commitAndPush(opts(a), 'data: close', () => {
		writeFileSync(join(a, CSV), `${HEADER}\nrow-1,100.5\nrow-2,101.5\n`);
		return Promise.resolve();
	});
	assert.equal(result.pushed, true);
	assert.equal(remoteCsv(remote), `${HEADER}\nrow-1,100.5\nrow-2,101.5`);
});

test('appendOnlyGuard rejects a changed digit in an old line', async () => {
	const { a } = makeFixture();
	commitCsv(a, `${HEADER}\nrow-1,100.5\nrow-2,101.5\n`);
	writeFileSync(join(a, CSV), `${HEADER}\nrow-1,100.6\nrow-2,101.5\nrow-3\n`);
	assert.deepEqual(await appendOnlyGuard(a), { ok: false, deleted: 1 });
});

test('appendOnlyGuard rejects a change of a half line that is not a line break', async () => {
	const { a } = makeFixture();
	commitCsv(a, `${HEADER}\nrow-1,100.5`);
	writeFileSync(join(a, CSV), `${HEADER}\nrow-1,100.55\n`);
	assert.deepEqual(await appendOnlyGuard(a), { ok: false, deleted: 1 });
});

test('appendOnlyGuard rejects a deleted line', async () => {
	const { a } = makeFixture();
	commitCsv(a, `${HEADER}\nrow-1,100.5\nrow-2,101.5\n`);
	writeFileSync(join(a, CSV), `${HEADER}\nrow-2,101.5\n`);
	assert.deepEqual(await appendOnlyGuard(a), { ok: false, deleted: 1 });
});

test('appendOnlyGuard rejects a deleted file that has no final line break', async () => {
	const { a } = makeFixture();
	commitCsv(a, `${HEADER}\nrow-1,100.5`);
	rmSync(join(a, CSV));
	assert.deepEqual(await appendOnlyGuard(a), { ok: false, deleted: 2 });
});
