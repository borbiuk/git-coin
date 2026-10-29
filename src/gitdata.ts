// Commits and pushes the data branch (ADR 0004 D2 and D6, ADR 0005 D3).
// Uses the `git` binary only, with argument arrays and no shell.

import { execFile } from 'node:child_process';

export interface GitAuthor {
	name: string;
	email: string;
}

export interface GitOpts {
	/** The checkout of the data branch. */
	repoDir: string;
	/** The branch to push to, for example `data`. */
	branch: string;
	/** Defaults to `origin`. */
	remote?: string;
	/** Defaults to `BOT_AUTHOR`. */
	author?: GitAuthor;
}

// The noreply email of `github-actions[bot]` is UNVERIFIED on a primary GitHub page until checklist item 6f.
export const BOT_AUTHOR: GitAuthor = {
	name: 'github-actions[bot]',
	email: '41898282+github-actions[bot]@users.noreply.github.com',
};

const MAX_TRIES = 3;
const GIT_TIMEOUT_MS = 60_000;
// The append-only rule covers the CSV data. `state/` is rewritten on purpose.
const GUARDED_PATHS = ['data/raw', 'data/meta'];

interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

// Never rejects. A failed command gives `ok: false`.
function git(cwd: string, args: string[]): Promise<GitResult> {
	return new Promise((resolve) => {
		execFile(
			'git',
			args,
			{
				cwd,
				timeout: GIT_TIMEOUT_MS,
				maxBuffer: 16 * 1024 * 1024,
				env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
			},
			(error, stdout, stderr) => {
				resolve({ ok: error === null, stdout, stderr });
			}
		);
	});
}

async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
	const result = await git(cwd, args);
	if (!result.ok) {
		throw new Error(
			`git ${args[0]} failed: ${result.stderr.trim().split('\n')[0]}`
		);
	}
	return result.stdout;
}

/** Counts the lines that the working tree removes from the data files, compared with HEAD. */
export async function appendOnlyGuard(
	repoDir: string
): Promise<{ ok: boolean; deleted: number }> {
	const out = await gitOrThrow(repoDir, [
		'diff',
		'HEAD',
		'--numstat',
		'--no-renames',
		'--',
		...GUARDED_PATHS,
	]);
	let deleted = 0;
	for (const line of out.split('\n')) {
		if (line === '') {
			continue;
		}
		const removed = line.split('\t')[1];
		// A binary file shows `-`. It is not CSV, so count it as a violation.
		deleted += removed === '-' ? 1 : Number(removed);
	}
	return { ok: deleted === 0, deleted };
}

/**
 * Runs `write()`, checks the guard, commits and pushes.
 * A rejected push resets to the remote branch, runs `write()` again and pushes again, up to 3 tries.
 * Throws if the guard fails (nothing is committed). Returns `commit: null` when nothing changed or the push failed.
 */
export async function commitAndPush(
	opts: GitOpts,
	message: string,
	write: () => Promise<void>
): Promise<{ pushed: boolean; commit: string | null; tries: number }> {
	const { repoDir, branch } = opts;
	const remote = opts.remote ?? 'origin';
	const author = opts.author ?? BOT_AUTHOR;
	const base = (await gitOrThrow(repoDir, ['rev-parse', 'HEAD'])).trim();

	let tries = 0;
	while (tries < MAX_TRIES) {
		tries += 1;
		await write();

		const guard = await appendOnlyGuard(repoDir);
		if (!guard.ok) {
			throw new Error(
				`Append-only guard failed: ${guard.deleted} deleted lines under ${GUARDED_PATHS.join(', ')}`
			);
		}

		await gitOrThrow(repoDir, ['add', '-A', '--', '.']);
		const staged = await gitOrThrow(repoDir, [
			'diff',
			'--cached',
			'--name-only',
		]);
		if (staged.trim() === '') {
			return { pushed: false, commit: null, tries };
		}

		await gitOrThrow(repoDir, [
			'-c',
			`user.name=${author.name}`,
			'-c',
			`user.email=${author.email}`,
			'-c',
			'commit.gpgsign=false',
			'commit',
			'--quiet',
			'-m',
			message,
		]);
		const commit = (
			await gitOrThrow(repoDir, ['rev-parse', 'HEAD'])
		).trim();

		const push = await git(repoDir, [
			'push',
			'--quiet',
			remote,
			`HEAD:refs/heads/${branch}`,
		]);
		if (push.ok) {
			return { pushed: true, commit, tries };
		}

		// Drop our commit and the files of `write()`. Start from the remote branch, or from the old HEAD if the fetch fails.
		const fetch = await git(repoDir, [
			'fetch',
			'--quiet',
			remote,
			`+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
		]);
		const target = fetch.ok ? `refs/remotes/${remote}/${branch}` : base;
		await gitOrThrow(repoDir, ['reset', '--hard', '--quiet', target]);
	}
	return { pushed: false, commit: null, tries };
}
