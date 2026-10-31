import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
	main,
	renderText,
	summarizeRuns,
	type WorkflowRun,
} from '../../tools/run-status.ts';

const NOW_MS = Date.parse('2026-11-01T01:00:00Z');

function run(
	id: number,
	createdAt: string,
	conclusion = 'success',
	event = 'schedule'
): WorkflowRun {
	return {
		databaseId: id,
		event,
		status: conclusion === '' ? 'in_progress' : 'completed',
		conclusion,
		createdAt,
	};
}

describe('summarizeRuns', () => {
	test('measures the gaps between scheduled runs', () => {
		const summary = summarizeRuns(
			[
				run(3, '2026-11-01T00:50:00Z'),
				run(1, '2026-11-01T00:00:00Z'),
				run(2, '2026-11-01T00:20:00Z'),
			],
			NOW_MS
		);
		assert.equal(summary.runs, 3);
		assert.equal(summary.scheduled, 3);
		assert.equal(summary.gap_median_min, 25);
		assert.equal(summary.gap_max_min, 30);
		assert.equal(summary.last_run_at, '2026-11-01T00:50:00Z');
		assert.equal(summary.last_run_age_min, 10);
		assert.equal(summary.scheduled_per_hour, 3);
		assert.equal(summary.last_scheduled_at, '2026-11-01T00:50:00Z');
	});

	test('counts a run without a conclusion under its status and skips manual runs in the gaps', () => {
		const summary = summarizeRuns(
			[
				run(1, '2026-11-01T00:00:00Z', 'failure'),
				run(2, '2026-11-01T00:10:00Z', 'success', 'workflow_dispatch'),
				run(3, '2026-11-01T00:30:00Z', ''),
			],
			NOW_MS
		);
		assert.deepEqual(summary.conclusions, {
			failure: 1,
			success: 1,
			in_progress: 1,
		});
		assert.equal(summary.scheduled, 2);
		assert.equal(summary.gap_max_min, 30);
	});

	test('a manual run does not move the last scheduled run', () => {
		const summary = summarizeRuns(
			[
				run(1, '2026-11-01T00:00:00Z'),
				run(2, '2026-11-01T00:40:00Z', 'success', 'workflow_dispatch'),
			],
			NOW_MS
		);
		assert.equal(summary.last_run_at, '2026-11-01T00:40:00Z');
		assert.equal(summary.last_scheduled_at, '2026-11-01T00:00:00Z');
		assert.equal(summary.last_scheduled_age_min, 60);
	});

	test('returns empty values when there are no runs', () => {
		const summary = summarizeRuns([], NOW_MS);
		assert.equal(summary.runs, 0);
		assert.equal(summary.last_run_at, null);
		assert.equal(summary.gap_median_min, null);
		assert.equal(summary.scheduled_per_hour, null);
	});
});

describe('renderText', () => {
	test('prints n/a for missing values', () => {
		const text = renderText(summarizeRuns([], NOW_MS));
		assert.match(text, /0 runs \(0 scheduled\), last run n\/a/);
		assert.match(text, /Conclusions: none/);
	});
});

describe('main', () => {
	function capture(): {
		out: string[];
		err: string[];
		io: { out: (t: string) => void; err: (t: string) => void };
	} {
		const out: string[] = [];
		const err: string[] = [];
		return {
			out,
			err,
			io: { out: (t) => out.push(t), err: (t) => err.push(t) },
		};
	}

	test('prints the summary as JSON', async () => {
		const { out, io } = capture();
		const code = await main(
			['--json', '--limit', '5'],
			io,
			async (repo, limit) => {
				assert.equal(repo, 'borbiuk/git-coin');
				assert.equal(limit, 5);
				return [run(1, '2026-11-01T00:00:00Z')];
			},
			() => NOW_MS
		);
		assert.equal(code, 0);
		assert.equal(JSON.parse(out.join('')).runs, 1);
	});

	test('rejects a bad limit and an unknown flag', async () => {
		const bad = capture();
		assert.equal(await main(['--limit', '0'], bad.io), 1);
		assert.match(bad.err.join(''), /--limit/);
		const unknown = capture();
		assert.equal(await main(['--nope'], unknown.io), 1);
	});

	test('reports a failed fetch with exit code 1', async () => {
		const { err, io } = capture();
		const code = await main(
			[],
			io,
			async () => {
				throw new Error('gh is not logged in');
			},
			() => NOW_MS
		);
		assert.equal(code, 1);
		assert.match(err.join(''), /gh is not logged in/);
	});
});
