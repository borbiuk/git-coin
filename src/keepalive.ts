// Keeps the schedule alive (ADR 0005 D7): GitHub disables scheduled workflows of a public repository
// after 60 days without repository activity. An empty commit on `main` counts as activity (assumption).

import { execFile } from 'node:child_process';

export interface GitAuthor {
	name: string;
	email: string;
}

const KEEPALIVE_TITLE = 'Keep schedule active';
const DEFAULT_BRANCH = 'main';
const DAY_MS = 24 * 60 * 60 * 1000;
const GIT_TIMEOUT_MS = 60_000;

function git(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			'git',
			args,
			{
				cwd,
				timeout: GIT_TIMEOUT_MS,
				env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
			},
			(error, stdout, stderr) => {
				if (error !== null) {
					reject(
						new Error(
							`git ${args[0]} failed: ${stderr.trim().split('\n')[0]}`
						)
					);
					return;
				}
				resolve(stdout);
			}
		);
	});
}

/**
 * Makes an empty commit on `main` and pushes it when the last commit is older than `maxAgeDays`.
 * Returns true when it pushed a commit and false when the last commit is recent enough.
 * Throws when git fails, including a rejected push (the local commit is removed first).
 */
export async function keepaliveIfStale(opts: {
	mainDir: string;
	now: Date;
	maxAgeDays: number;
	author: GitAuthor;
}): Promise<boolean> {
	const { mainDir, now, maxAgeDays, author } = opts;
	const lastSeconds = Number(
		(await git(mainDir, ['log', '-1', '--format=%ct', 'HEAD'])).trim()
	);
	if (!Number.isFinite(lastSeconds)) {
		throw new Error('Cannot read the date of the last commit');
	}
	if (now.getTime() - lastSeconds * 1000 <= maxAgeDays * DAY_MS) {
		return false;
	}

	const base = (await git(mainDir, ['rev-parse', 'HEAD'])).trim();
	await git(mainDir, [
		'-c',
		`user.name=${author.name}`,
		'-c',
		`user.email=${author.email}`,
		'-c',
		'commit.gpgsign=false',
		'commit',
		'--quiet',
		'--allow-empty',
		'-m',
		KEEPALIVE_TITLE,
	]);
	try {
		await git(mainDir, [
			'push',
			'--quiet',
			'origin',
			`HEAD:refs/heads/${DEFAULT_BRANCH}`,
		]);
	} catch (error) {
		await git(mainDir, ['reset', '--soft', '--quiet', base]);
		throw error;
	}
	return true;
}
