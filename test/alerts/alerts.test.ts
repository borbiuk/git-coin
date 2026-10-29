import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { runAlerts } from '../../src/alerts/index.ts';
import type { AlertContext } from '../../src/alerts/index.ts';
import { readAlertState } from '../../src/alerts/state.ts';

import {
	makeCoin,
	makeConfig,
	fakeClient,
	fakeReader,
	failingReader,
	NOW,
} from './helpers.ts';
import type { FakeClient } from './helpers.ts';

const FIXTURES = new URL('../fixtures/alerts/', import.meta.url);

// BTC falls from 100 to 94 in one hour: 6 percent, a warning at the 5 percent default.
const BTC_DOWN: Array<[string, string]> = [
	['2026-10-29T13:00:00Z', '100'],
	['2026-10-29T14:00:00Z', '94'],
];

let dir: string;
let statePath: string;
let client: FakeClient;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'git-coin-run-alerts-'));
	statePath = join(dir, 'state', 'alerts.json');
	client = fakeClient();
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function context(over: Partial<AlertContext> = {}): AlertContext {
	return {
		config: makeConfig([makeCoin('BTC')]),
		reader: fakeReader({ BTC: BTC_DOWN }),
		client,
		now: NOW,
		statePath,
		dashboardUrl: 'https://borbiuk.github.io/git-coin/',
		dryRun: false,
		...over,
	};
}

function at(hoursAfterNow: number): Date {
	return new Date(NOW.getTime() + hoursAfterNow * 3_600_000);
}

/** Moves the BTC rows so that the same 6 percent fall ends at `now`. */
function btcDownEndingAt(now: Date): Array<[string, string]> {
	const iso = (d: Date): string => `${d.toISOString().slice(0, 19)}Z`;
	return [
		[iso(new Date(now.getTime() - 3_600_000)), '100'],
		[iso(now), '94'],
	];
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

describe('no alert', () => {
	test('first run: no rows at all', async () => {
		const summary = await runAlerts(context({ reader: fakeReader({}) }));
		assert.equal(summary.checked, 1);
		assert.equal(summary.created, 0);
		assert.deepEqual(client.calls, []);
		assert.equal(await exists(statePath), false);
	});

	test('first run: a coin with only the current row has no reference', async () => {
		const summary = await runAlerts(
			context({
				reader: fakeReader({ BTC: [['2026-10-29T14:00:00Z', '94']] }),
			})
		);
		assert.equal(summary.created, 0);
		assert.deepEqual(client.calls, []);
	});

	test('a move below the threshold', async () => {
		const reader = fakeReader({
			BTC: [
				['2026-10-29T13:00:00Z', '100'],
				['2026-10-29T14:00:00Z', '96'],
			],
		});
		const summary = await runAlerts(context({ reader }));
		assert.equal(summary.created, 0);
		assert.deepEqual(client.calls, []);
	});

	test('a gap longer than the window: the old row is no reference', async () => {
		const reader = fakeReader({
			BTC: [
				['2026-10-29T11:00:00Z', '100'],
				['2026-10-29T14:00:00Z', '94'],
			],
		});
		const summary = await runAlerts(context({ reader }));
		assert.equal(summary.created, 0);
		assert.deepEqual(client.calls, []);
	});

	test('after the gap the logic resumes when a reference exists again', async () => {
		const first = fakeReader({
			BTC: [
				['2026-10-29T11:00:00Z', '100'],
				['2026-10-29T14:00:00Z', '94'],
			],
		});
		assert.equal((await runAlerts(context({ reader: first }))).created, 0);
		const later = fakeReader({
			BTC: [
				['2026-10-29T11:00:00Z', '100'],
				['2026-10-29T14:00:00Z', '94'],
				['2026-10-29T15:00:00Z', '90'],
				['2026-10-29T16:00:00Z', '84'],
			],
		});
		const summary = await runAlerts(context({ reader: later, now: at(2) }));
		assert.equal(summary.created, 1);
	});

	test('the tolerance edge: a reference 30 minutes too old is used, 31 is not', async () => {
		const edge = fakeReader({
			BTC: [
				['2026-10-29T12:30:00Z', '100'],
				['2026-10-29T14:00:00Z', '94'],
			],
		});
		assert.equal((await runAlerts(context({ reader: edge }))).created, 1);
		await rm(statePath);
		client = fakeClient();
		const late = fakeReader({
			BTC: [
				['2026-10-29T12:29:59Z', '100'],
				['2026-10-29T14:00:00Z', '94'],
			],
		});
		assert.equal(
			(await runAlerts(context({ reader: late, client }))).created,
			0
		);
	});

	test('a coin with enabled false', async () => {
		const config = makeConfig([makeCoin('BTC', { enabled: false })]);
		const summary = await runAlerts(context({ config }));
		assert.equal(summary.checked, 0);
		assert.equal(summary.created, 0);
		assert.deepEqual(client.calls, []);
	});

	test('alerts switched off for one coin', async () => {
		const config = makeConfig([
			makeCoin('BTC', { alerts: { enabled: false } }),
		]);
		assert.equal((await runAlerts(context({ config }))).checked, 0);
	});

	test('a direction that is not allowed', async () => {
		const config = makeConfig([
			makeCoin('BTC', { alerts: { direction: 'up' } }),
		]);
		const summary = await runAlerts(context({ config }));
		assert.equal(summary.created, 0);
		assert.deepEqual(client.calls, []);
	});

	test('rows of another source are ignored and the reader asks for the primary source', async () => {
		const reader = fakeReader({
			BTC: [
				['2026-10-29T13:00:00Z', '100', 'cb'],
				['2026-10-29T14:00:00Z', '94', 'cb'],
			],
		});
		const summary = await runAlerts(context({ reader }));
		assert.equal(summary.created, 0);
		assert.equal(reader.calls[0]?.src, 'kr');
		assert.equal(reader.calls[0]?.coin, 'BTC');
	});

	test('the reader range covers the longest window plus tolerance and excludes the future', async () => {
		const reader = fakeReader({});
		await runAlerts(context({ reader }));
		assert.equal(reader.calls[0]?.from, '2026-10-28T12:00:00Z');
		assert.equal(reader.calls[0]?.to, '2026-10-29T14:00:01Z');
	});

	test('bad prices in the series are ignored', async () => {
		const reader = fakeReader({
			BTC: [
				['2026-10-29T13:00:00Z', '100'],
				['2026-10-29T13:30:00Z', 'NaN'],
				['2026-10-29T14:00:00Z', '1e2'],
			],
		});
		assert.equal((await runAlerts(context({ reader }))).created, 0);
	});
});

describe('a new alert', () => {
	test('creates one Issue with labels, assignee, title and body', async () => {
		const summary = await runAlerts(context());
		assert.equal(summary.created, 1);
		assert.deepEqual(summary.errors, []);
		const create = client.calls.find((call) => call.op === 'create');
		assert.ok(create && create.op === 'create');
		assert.equal(
			create.issue.title,
			'[ALERT] BTC down 6.0% in 1h (94.00 USD)'
		);
		assert.deepEqual(create.issue.labels, [
			'alert',
			'coin:BTC',
			'dir:down',
			'window:1h',
			'severity:warning',
		]);
		assert.deepEqual(create.issue.assignees, ['borbiuk']);
		assert.ok(create.issue.body.includes('@borbiuk'));
		assert.ok(create.issue.body.includes('Source: Kraken. Quote: USD.'));
		assert.ok(
			create.issue.body.includes(
				'Dashboard: https://borbiuk.github.io/git-coin/'
			)
		);
		const list = client.calls.find((call) => call.op === 'list');
		assert.deepEqual(list && list.op === 'list' ? list.labels : null, [
			'alert',
			'coin:BTC',
			'dir:down',
		]);
	});

	test('saves the state with the Issue number, the counter and the recent list', async () => {
		await runAlerts(context());
		const state = await readAlertState(statePath);
		assert.equal(state.keys['BTC:down']?.issue, 100);
		assert.equal(
			state.keys['BTC:down']?.last_alert_at,
			'2026-10-29T14:00:00Z'
		);
		assert.deepEqual(state.daily, {
			day: '2026-10-29',
			created: 1,
			suppressed: 0,
		});
		assert.deepEqual(state.recent, [
			{
				coin: 'BTC',
				ts: '2026-10-29T14:00:00Z',
				direction: 'down',
				window: '1h',
				severity: 'warning',
				issue: 100,
				suppressed: false,
			},
		]);
	});

	test('a fall of twice the threshold is critical', async () => {
		const reader = fakeReader({
			BTC: [
				['2026-10-29T13:00:00Z', '100'],
				['2026-10-29T14:00:00Z', '90'],
			],
		});
		await runAlerts(context({ reader }));
		const create = client.calls.find((call) => call.op === 'create');
		assert.ok(create && create.op === 'create');
		assert.ok(create.issue.labels.includes('severity:critical'));
	});

	test('a rise opens an up Issue', async () => {
		const reader = fakeReader({
			BTC: [
				['2026-10-29T13:00:00Z', '100'],
				['2026-10-29T14:00:00Z', '107'],
			],
		});
		await runAlerts(context({ reader }));
		const create = client.calls.find((call) => call.op === 'create');
		assert.ok(create && create.op === 'create');
		assert.ok(create.issue.title.startsWith('[ALERT] BTC up 7.0% in 1h'));
	});

	test('per-coin thresholds are used', async () => {
		const config = makeConfig([
			makeCoin('BTC', { alerts: { move_1h: { threshold_percent: 7 } } }),
		]);
		assert.equal((await runAlerts(context({ config }))).created, 0);
	});

	test('when both rules fire for one direction, the one further above its threshold wins', async () => {
		const reader = fakeReader({
			BTC: [
				['2026-10-28T14:00:00Z', '100'],
				['2026-10-29T13:00:00Z', '65'],
				['2026-10-29T14:00:00Z', '60'],
			],
		});
		const summary = await runAlerts(context({ reader }));
		assert.equal(summary.created, 1);
		const create = client.calls.find((call) => call.op === 'create');
		assert.ok(create && create.op === 'create');
		assert.ok(create.issue.title.includes('in 24h'));
		assert.ok(create.issue.labels.includes('window:24h'));
	});

	test('an existing open Issue for the key is adopted and gets a comment, not a new Issue', async () => {
		client = fakeClient([
			{
				number: 41,
				title: 'x',
				labels: ['alert', 'coin:BTC', 'dir:down'],
			},
			{
				number: 40,
				title: 'y',
				labels: ['alert', 'coin:BTC', 'dir:down'],
			},
		]);
		const summary = await runAlerts(context());
		assert.equal(summary.created, 0);
		assert.equal(summary.commented, 1);
		assert.ok(
			client.calls.some((c) => c.op === 'comment' && c.issue === 40)
		);
		assert.equal(
			(await readAlertState(statePath)).keys['BTC:down']?.issue,
			40
		);
	});
});

describe('dedup, cooldown and opposite direction', () => {
	test('a second run inside the cooldown makes no API call', async () => {
		await runAlerts(context());
		const callsAfterFirst = client.calls.length;
		const summary = await runAlerts(
			context({
				now: at(1),
				reader: fakeReader({ BTC: btcDownEndingAt(at(1)) }),
			})
		);
		assert.equal(client.calls.length, callsAfterFirst);
		assert.deepEqual(summary.actions, [
			{ kind: 'cooldown', key: 'BTC:down', issue: 100 },
		]);
		const state = await readAlertState(statePath);
		assert.equal(
			state.keys['BTC:down']?.last_trigger_at,
			'2026-10-29T15:00:00Z'
		);
	});

	test('after the cooldown a repeat adds a comment with the new price', async () => {
		await runAlerts(context());
		const later = at(6);
		const summary = await runAlerts(
			context({
				now: later,
				reader: fakeReader({ BTC: btcDownEndingAt(later) }),
			})
		);
		assert.equal(summary.created, 0);
		assert.equal(summary.commented, 1);
		const comment = client.calls.find((call) => call.op === 'comment');
		assert.ok(comment && comment.op === 'comment');
		assert.equal(comment.issue, 100);
		assert.ok(comment.body.includes('94.00 USD'));
		assert.equal(
			client.calls.filter((call) => call.op === 'create').length,
			1
		);
	});

	test('the cooldown counts from the last comment, not from the Issue', async () => {
		await runAlerts(context());
		for (const hours of [6, 9, 12]) {
			const now = at(hours);
			await runAlerts(
				context({
					now,
					reader: fakeReader({ BTC: btcDownEndingAt(now) }),
				})
			);
		}
		const comments = client.calls.filter((call) => call.op === 'comment');
		assert.equal(comments.length, 2);
	});

	test('the opposite direction opens a separate Issue', async () => {
		await runAlerts(context());
		const later = at(1);
		const reader = fakeReader({
			BTC: [
				['2026-10-29T14:00:00Z', '94'],
				['2026-10-29T15:00:00Z', '101'],
			],
		});
		const summary = await runAlerts(context({ now: later, reader }));
		assert.equal(summary.created, 1);
		const creates = client.calls.filter((call) => call.op === 'create');
		assert.equal(creates.length, 2);
		const state = await readAlertState(statePath);
		assert.equal(state.keys['BTC:down']?.issue, 100);
		assert.equal(state.keys['BTC:up']?.issue, 101);
	});

	test('an Issue the owner closed by hand is replaced after the cooldown, not before', async () => {
		await runAlerts(context());
		client.open = [];
		const early = at(2);
		await runAlerts(
			context({
				now: early,
				reader: fakeReader({ BTC: btcDownEndingAt(early) }),
			})
		);
		assert.equal(client.calls.filter((c) => c.op === 'create').length, 1);
		const later = at(6);
		const summary = await runAlerts(
			context({
				now: later,
				reader: fakeReader({ BTC: btcDownEndingAt(later) }),
			})
		);
		assert.equal(summary.created, 1);
		assert.equal(
			(await readAlertState(statePath)).keys['BTC:down']?.issue,
			101
		);
	});

	test('two coins do not share an Issue', async () => {
		const config = makeConfig([makeCoin('BTC'), makeCoin('ETH')]);
		const reader = fakeReader({ BTC: BTC_DOWN, ETH: BTC_DOWN });
		const summary = await runAlerts(context({ config, reader }));
		assert.equal(summary.created, 2);
		assert.equal(summary.checked, 2);
	});
});

describe('daily cap', () => {
	const coins = ['A', 'B', 'C', 'D'].map((id) => makeCoin(id));
	const data = Object.fromEntries(coins.map((coin) => [coin.id, BTC_DOWN]));

	test('after the cap no new Issue is created and the rest is recorded as suppressed', async () => {
		const config = makeConfig(coins, { daily_issue_cap: 2 });
		const summary = await runAlerts(
			context({ config, reader: fakeReader(data) })
		);
		assert.equal(summary.created, 2);
		assert.equal(summary.suppressed, 2);
		assert.equal(client.calls.filter((c) => c.op === 'create').length, 2);
		const state = await readAlertState(statePath);
		assert.deepEqual(state.daily, {
			day: '2026-10-29',
			created: 2,
			suppressed: 2,
		});
		assert.deepEqual(
			state.recent.map((item) => [
				item.coin,
				item.suppressed,
				item.issue,
			]),
			[
				['A', false, 100],
				['B', false, 101],
				['C', true, null],
				['D', true, null],
			]
		);
		assert.equal(state.keys['C:down']?.issue, null);
	});

	test('a suppressed key is not recorded again during its cooldown', async () => {
		const config = makeConfig(coins, { daily_issue_cap: 2 });
		await runAlerts(context({ config, reader: fakeReader(data) }));
		const later = at(1);
		const moved = Object.fromEntries(
			coins.map((coin) => [coin.id, btcDownEndingAt(later)])
		);
		const summary = await runAlerts(
			context({ config, reader: fakeReader(moved), now: later })
		);
		assert.equal(summary.suppressed, 0);
		assert.equal((await readAlertState(statePath)).recent.length, 4);
	});

	test('the counter starts again on the next UTC day', async () => {
		const config = makeConfig(coins, { daily_issue_cap: 2 });
		await runAlerts(context({ config, reader: fakeReader(data) }));
		const nextDay = new Date('2026-10-30T09:00:00Z');
		const moved = Object.fromEntries(
			coins.map((coin) => [coin.id, btcDownEndingAt(nextDay)])
		);
		const summary = await runAlerts(
			context({ config, reader: fakeReader(moved), now: nextDay })
		);
		// A and B have open Issues and get comments. C and D can now open their own.
		assert.equal(summary.commented, 2);
		assert.equal(summary.created, 2);
		const state = await readAlertState(statePath);
		assert.deepEqual(state.daily, {
			day: '2026-10-30',
			created: 2,
			suppressed: 0,
		});
	});

	test('a comment on an open Issue does not count against the cap', async () => {
		const config = makeConfig([makeCoin('A')], { daily_issue_cap: 1 });
		await runAlerts(
			context({ config, reader: fakeReader({ A: BTC_DOWN }) })
		);
		const later = at(6);
		const summary = await runAlerts(
			context({
				config,
				reader: fakeReader({ A: btcDownEndingAt(later) }),
				now: later,
			})
		);
		assert.equal(summary.commented, 1);
		assert.equal(summary.suppressed, 0);
	});

	test('the recent list keeps only the newest 50', async () => {
		const many = Array.from({ length: 60 }, (_, i) => makeCoin(`C${i}`));
		const config = makeConfig(many, { daily_issue_cap: 100 });
		const rows = Object.fromEntries(
			many.map((coin) => [coin.id, BTC_DOWN])
		);
		await runAlerts(context({ config, reader: fakeReader(rows) }));
		const state = await readAlertState(statePath);
		assert.equal(state.recent.length, 50);
		assert.equal(state.recent[49]?.coin, 'C59');
		assert.equal(state.recent[0]?.coin, 'C10');
	});
});

describe('auto-close', () => {
	test('closes an Issue with no trigger for 24 hours, with a comment', async () => {
		await runAlerts(context());
		const flat = (now: Date): ReturnType<typeof fakeReader> =>
			fakeReader({
				BTC: [
					[
						`${new Date(now.getTime() - 3_600_000).toISOString().slice(0, 19)}Z`,
						'94',
					],
					[`${now.toISOString().slice(0, 19)}Z`, '94'],
				],
			});
		const before = at(23);
		await runAlerts(context({ now: before, reader: flat(before) }));
		assert.equal(client.calls.filter((c) => c.op === 'close').length, 0);
		const due = at(24);
		const summary = await runAlerts(
			context({ now: due, reader: flat(due) })
		);
		assert.equal(summary.closed, 1);
		const comment = client.calls.filter((c) => c.op === 'comment').at(-1);
		assert.ok(comment && comment.op === 'comment');
		assert.equal(comment.body, 'No new trigger in 24 hours. Closing.');
		assert.deepEqual(client.calls.at(-1), { op: 'close', issue: 100 });
		assert.equal(
			(await readAlertState(statePath)).keys['BTC:down']?.issue,
			null
		);
	});

	test('a new trigger keeps the Issue open', async () => {
		await runAlerts(context());
		const later = at(23);
		await runAlerts(
			context({
				now: later,
				reader: fakeReader({ BTC: btcDownEndingAt(later) }),
			})
		);
		const due = at(30);
		const summary = await runAlerts(
			context({
				now: due,
				reader: fakeReader({ BTC: btcDownEndingAt(due) }),
			})
		);
		assert.equal(summary.closed, 0);
	});

	test('uses the auto close hours of the coin', async () => {
		const config = makeConfig([
			makeCoin('BTC', { alerts: { auto_close_hours: 2 } }),
		]);
		await runAlerts(context({ config }));
		const due = at(2);
		const summary = await runAlerts(
			context({ config, now: due, reader: fakeReader({ BTC: [] }) })
		);
		assert.equal(summary.closed, 1);
		assert.ok(
			client.calls.some(
				(c) =>
					c.op === 'comment' &&
					c.body === 'No new trigger in 2 hours. Closing.'
			)
		);
	});

	test('closes the Issue of a coin that is no longer in the config', async () => {
		await runAlerts(context());
		const due = at(25);
		const summary = await runAlerts(
			context({
				config: makeConfig([makeCoin('ETH')]),
				now: due,
				reader: fakeReader({}),
			})
		);
		assert.equal(summary.closed, 1);
	});

	test('reads the state of an earlier run from a fixture file', async () => {
		await mkdir(join(dir, 'state'), { recursive: true });
		await copyFile(new URL('state-open-issue.json', FIXTURES), statePath);
		client = fakeClient([
			{
				number: 7,
				title: 'x',
				labels: ['alert', 'coin:BTC', 'dir:down'],
			},
		]);
		// The fixture trigger was at 08:00. At 14:00 nothing new happened, so the Issue stays open.
		const summary = await runAlerts(context({ reader: fakeReader({}) }));
		assert.equal(summary.closed, 0);
		const next = new Date('2026-10-30T08:00:00Z');
		const closing = await runAlerts(
			context({ now: next, reader: fakeReader({}) })
		);
		assert.equal(closing.closed, 1);
		assert.deepEqual(client.calls.at(-1), { op: 'close', issue: 7 });
	});
});

describe('dry run', () => {
	test('makes no client call and writes no file, but reports what it would do', async () => {
		const summary = await runAlerts(context({ dryRun: true }));
		assert.deepEqual(client.calls, []);
		assert.equal(await exists(statePath), false);
		assert.equal(summary.created, 1);
		assert.deepEqual(summary.actions, [
			{ kind: 'create', key: 'BTC:down', issue: null },
		]);
	});

	test('does not change an existing state file', async () => {
		await runAlerts(context());
		const before = await readFile(statePath, 'utf8');
		client = fakeClient();
		const later = at(30);
		await runAlerts(
			context({
				dryRun: true,
				now: later,
				reader: fakeReader({ BTC: btcDownEndingAt(later) }),
			})
		);
		assert.deepEqual(client.calls, []);
		assert.equal(await readFile(statePath, 'utf8'), before);
	});
});

describe('failures', () => {
	test('a failed create is reported and retried on the next run', async () => {
		client.failOn.add('create');
		const summary = await runAlerts(context());
		assert.equal(summary.created, 0);
		assert.deepEqual(summary.errors, ['BTC:down: create failed']);
		client.failOn.clear();
		const retry = await runAlerts(context({ now: at(0) }));
		assert.equal(retry.created, 1);
		assert.equal((await readAlertState(statePath)).daily.created, 1);
	});

	test('a failed list is reported and the other coins still run', async () => {
		const config = makeConfig([makeCoin('BTC'), makeCoin('ETH')]);
		const reader = fakeReader({ BTC: BTC_DOWN, ETH: BTC_DOWN });
		client.failOn.add('list');
		const summary = await runAlerts(context({ config, reader }));
		assert.equal(summary.errors.length, 2);
		assert.equal(summary.created, 0);
	});

	test('a failed close keeps the Issue in the state', async () => {
		await runAlerts(context());
		client.failOn.add('close');
		const due = at(25);
		const summary = await runAlerts(
			context({ now: due, reader: fakeReader({}) })
		);
		assert.equal(summary.closed, 0);
		assert.equal(summary.errors.length, 1);
		assert.equal(
			(await readAlertState(statePath)).keys['BTC:down']?.issue,
			100
		);
	});

	test('a failing reader is reported for that coin only', async () => {
		const config = makeConfig([makeCoin('BTC'), makeCoin('ETH')]);
		const reader = {
			readSeries: (coin: string, from: string, to: string, src: 'kr') =>
				coin === 'BTC'
					? failingReader('disk error').readSeries(
							coin,
							from,
							to,
							src
						)
					: fakeReader({ ETH: BTC_DOWN }).readSeries(
							coin,
							from,
							to,
							src
						),
		};
		const summary = await runAlerts(context({ config, reader }));
		assert.deepEqual(summary.errors, ['BTC: read failed: disk error']);
		assert.equal(summary.created, 1);
	});

	test('a broken state file throws', async () => {
		await mkdir(join(dir, 'state'), { recursive: true });
		await copyFile(new URL('state-bad-shape.json', FIXTURES), statePath);
		await assert.rejects(runAlerts(context()), /Invalid alert state/);
		assert.deepEqual(client.calls, []);
	});

	test('an empty list of stored sources throws', async () => {
		const config = makeConfig([makeCoin('BTC')]);
		config.settings.stored_sources = [];
		await assert.rejects(runAlerts(context({ config })), /stored_sources/);
	});
});
