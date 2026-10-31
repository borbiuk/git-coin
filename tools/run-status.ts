// Summary of the scheduled collector runs (ADR 0005): how many runs GitHub delivered and how long the gaps were.
// Reads the run list with `gh`. If the local, gitignored wrapper scripts/gh-borbiuk.sh exists, it runs `gh` as the borbiuk account.
// Run: node tools/run-status.ts [--repo borbiuk/git-coin] [--limit 100] [--json]
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

import { isoSeconds } from '../src/time.ts';

const execFileAsync = promisify(execFile);

/** Runs per hour that the cron of `collect.yml` asks for (`3,18,33,48 * * * *`). */
const CRON_RUNS_PER_HOUR = 4;

export interface WorkflowRun {
	databaseId: number;
	event: string;
	status: string;
	conclusion: string;
	createdAt: string;
}

export interface RunSummary {
	runs: number;
	scheduled: number;
	/** Count per conclusion. A run without a conclusion is counted under its status. */
	conclusions: Record<string, number>;
	last_run_at: string | null;
	last_run_age_min: number | null;
	/** The newest scheduled run. A manual run does not move it, so it shows a schedule that has stopped. */
	last_scheduled_at: string | null;
	last_scheduled_age_min: number | null;
	scheduled_per_hour: number | null;
	gap_median_min: number | null;
	gap_p90_min: number | null;
	gap_max_min: number | null;
}

export type FetchRuns = (repo: string, limit: number) => Promise<WorkflowRun[]>;

interface Io {
	out: (text: string) => void;
	err: (text: string) => void;
}

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

/** Nearest rank percentile of a sorted list. `p` is 0 to 100. */
function percentile(sorted: number[], p: number): number {
	const rank = Math.ceil((p * sorted.length) / 100);
	return sorted[Math.max(rank, 1) - 1] ?? 0;
}

/** Median of a sorted list: the mean of the two middle values when the length is even. */
function median(sorted: number[]): number {
	const middle = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) {
		return sorted[middle] ?? 0;
	}
	return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Counts the runs and measures the gaps between the scheduled ones. `nowMs` is the current time. */
export function summarizeRuns(runs: WorkflowRun[], nowMs: number): RunSummary {
	const ordered = runs
		.map((run) => ({ run, ms: Date.parse(run.createdAt) }))
		.filter((item) => !Number.isNaN(item.ms))
		.sort((a, b) => a.ms - b.ms);

	const conclusions: Record<string, number> = {};
	for (const { run } of ordered) {
		const key = run.conclusion === '' ? run.status : run.conclusion;
		conclusions[key] = (conclusions[key] ?? 0) + 1;
	}

	const scheduled = ordered.filter(({ run }) => run.event === 'schedule');
	const gaps: number[] = [];
	for (let i = 1; i < scheduled.length; i++) {
		const current = scheduled[i]?.ms ?? 0;
		const previous = scheduled[i - 1]?.ms ?? 0;
		gaps.push((current - previous) / 60000);
	}
	gaps.sort((a, b) => a - b);

	const last = ordered[ordered.length - 1];
	const firstScheduled = scheduled[0];
	const lastScheduled = scheduled[scheduled.length - 1];
	const spanHours =
		firstScheduled !== undefined && lastScheduled !== undefined
			? (nowMs - firstScheduled.ms) / 3600000
			: 0;

	return {
		runs: ordered.length,
		scheduled: scheduled.length,
		conclusions,
		last_run_at: last === undefined ? null : isoSeconds(new Date(last.ms)),
		last_run_age_min:
			last === undefined ? null : round1((nowMs - last.ms) / 60000),
		last_scheduled_at:
			lastScheduled === undefined
				? null
				: isoSeconds(new Date(lastScheduled.ms)),
		last_scheduled_age_min:
			lastScheduled === undefined
				? null
				: round1((nowMs - lastScheduled.ms) / 60000),
		// From the first scheduled run to now, so a long silence after the last run lowers the rate
		scheduled_per_hour:
			spanHours > 0 ? round1(scheduled.length / spanHours) : null,
		gap_median_min: gaps.length === 0 ? null : round1(median(gaps)),
		gap_p90_min: gaps.length === 0 ? null : round1(percentile(gaps, 90)),
		gap_max_min:
			gaps.length === 0 ? null : round1(gaps[gaps.length - 1] ?? 0),
	};
}

function minutes(value: number | null): string {
	return value === null ? 'n/a' : `${value}`;
}

export function renderText(summary: RunSummary): string {
	const conclusions = Object.entries(summary.conclusions)
		.map(([name, count]) => `${name} ${count}`)
		.join(', ');
	return [
		`collect.yml: ${summary.runs} runs (${summary.scheduled} scheduled), last run ${summary.last_run_at ?? 'n/a'} (${minutes(summary.last_run_age_min)} min ago)`,
		`Last scheduled run: ${summary.last_scheduled_at ?? 'n/a'} (${minutes(summary.last_scheduled_age_min)} min ago)`,
		`Conclusions: ${conclusions === '' ? 'none' : conclusions}`,
		`Scheduled runs per hour: ${summary.scheduled_per_hour ?? 'n/a'} (the cron asks for ${CRON_RUNS_PER_HOUR})`,
		`Gap between scheduled runs, minutes: median ${minutes(summary.gap_median_min)}, p90 ${minutes(summary.gap_p90_min)}, max ${minutes(summary.gap_max_min)}`,
	].join('\n');
}

function isRun(value: unknown): value is WorkflowRun {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const run = value as Record<string, unknown>;
	return (
		typeof run.databaseId === 'number' &&
		typeof run.event === 'string' &&
		typeof run.status === 'string' &&
		typeof run.conclusion === 'string' &&
		typeof run.createdAt === 'string'
	);
}

/** Reads the runs of `collect.yml` with `gh`, as the borbiuk account. */
export async function fetchRunsWithGh(
	repo: string,
	limit: number
): Promise<WorkflowRun[]> {
	const wrapper = fileURLToPath(
		new URL('../scripts/gh-borbiuk.sh', import.meta.url)
	);
	const { stdout } = await execFileAsync(
		existsSync(wrapper) ? wrapper : 'gh',
		[
			'run',
			'list',
			'--workflow',
			'collect.yml',
			'--repo',
			repo,
			'--limit',
			String(limit),
			'--json',
			'databaseId,event,status,conclusion,createdAt',
		]
	);
	const parsed: unknown = JSON.parse(stdout);
	if (!Array.isArray(parsed) || !parsed.every(isRun)) {
		throw new Error('gh returned an unexpected run list');
	}
	return parsed;
}

const USAGE = `Usage: node tools/run-status.ts [--repo <owner/name>] [--limit <runs>] [--json]

  --repo <owner/name>   default borbiuk/git-coin
  --limit <runs>        how many of the latest runs to read, default 100
  --json                print JSON instead of text
  --help                print this text
`;

/** Runs the tool. Returns the exit code: 0 on success, 1 on bad input or when `gh` fails. */
export async function main(
	argv: string[],
	io: Io,
	fetchRuns: FetchRuns = fetchRunsWithGh,
	now: () => number = Date.now
): Promise<number> {
	let values: Record<string, string | boolean | undefined>;
	try {
		values = parseArgs({
			args: argv,
			options: {
				repo: { type: 'string' },
				limit: { type: 'string' },
				json: { type: 'boolean' },
				help: { type: 'boolean' },
			},
		}).values;
	} catch (error) {
		io.err(`${(error as Error).message}\n\n${USAGE}`);
		return 1;
	}
	if (values.help === true) {
		io.out(USAGE);
		return 0;
	}

	const repo =
		typeof values.repo === 'string' ? values.repo : 'borbiuk/git-coin';
	const limit = typeof values.limit === 'string' ? Number(values.limit) : 100;
	if (!Number.isInteger(limit) || limit < 1) {
		io.err('--limit needs a whole number of one or more\n');
		return 1;
	}

	let runs: WorkflowRun[];
	try {
		runs = await fetchRuns(repo, limit);
	} catch (error) {
		io.err(`Could not read the runs: ${(error as Error).message}\n`);
		return 1;
	}
	const summary = summarizeRuns(runs, now());
	io.out(
		values.json === true
			? `${JSON.stringify(summary, null, 2)}\n`
			: `${renderText(summary)}\n`
	);
	return 0;
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2), {
		out: (text) => process.stdout.write(text),
		err: (text) => process.stderr.write(text),
	});
}
