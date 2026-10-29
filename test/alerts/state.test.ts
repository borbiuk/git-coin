import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
	emptyAlertState,
	emptyKeyState,
	readAlertState,
	serializeAlertState,
	writeAlertState,
} from '../../src/alerts/state.ts';

const FIXTURES = new URL('../fixtures/alerts/', import.meta.url);

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), 'git-coin-alerts-'));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test('a missing state file gives an empty state', async () => {
	await withTempDir(async (dir) => {
		const state = await readAlertState(join(dir, 'state', 'alerts.json'));
		assert.deepEqual(state, emptyAlertState());
	});
});

test('write creates the folder and read gives the same state back', async () => {
	await withTempDir(async (dir) => {
		const path = join(dir, 'state', 'alerts.json');
		const state = emptyAlertState();
		state.keys['ETH:up'] = { ...emptyKeyState(), issue: 12 };
		state.keys['BTC:down'] = {
			...emptyKeyState(),
			last_alert_at: '2026-10-29T08:00:00Z',
		};
		state.daily = { day: '2026-10-29', created: 2, suppressed: 1 };
		state.recent.push({
			coin: 'ETH',
			ts: '2026-10-29T08:00:00Z',
			direction: 'up',
			window: '24h',
			severity: 'critical',
			issue: 12,
			suppressed: false,
		});
		await writeAlertState(path, state);
		assert.deepEqual(await readAlertState(path), state);
	});
});

test('the text is stable: keys are sorted and there is a trailing newline', () => {
	const state = emptyAlertState();
	state.keys['ETH:up'] = emptyKeyState();
	state.keys['BTC:down'] = emptyKeyState();
	const text = serializeAlertState(state);
	assert.ok(text.endsWith('}\n'));
	assert.ok(text.indexOf('BTC:down') < text.indexOf('ETH:up'));
	assert.equal(serializeAlertState(JSON.parse(text)), text);
});

test('reads a state with an open Issue', async () => {
	const state = await readAlertState(
		new URL('state-open-issue.json', FIXTURES).pathname
	);
	assert.equal(state.keys['BTC:down']?.issue, 7);
	assert.equal(state.daily.created, 1);
	assert.equal(state.recent.length, 1);
});

test('a state with a wrong shape throws', async () => {
	await assert.rejects(
		readAlertState(new URL('state-bad-shape.json', FIXTURES).pathname),
		/Invalid alert state/
	);
});

test('a file that is not JSON throws without echoing the content', async () => {
	await assert.rejects(
		readAlertState(new URL('state-not-json.txt', FIXTURES).pathname),
		(error: Error) =>
			/Invalid alert state/.test(error.message) &&
			!error.message.includes('this is not json')
	);
});

test('a wrong schema version or top level throws', async () => {
	await withTempDir(async (dir) => {
		const path = join(dir, 'alerts.json');
		await writeFile(path, JSON.stringify({ schema_version: 2 }));
		await assert.rejects(readAlertState(path), /schema_version/);
		await writeFile(path, JSON.stringify({ schema_version: 1, keys: [] }));
		await assert.rejects(readAlertState(path), /top level/);
		await writeFile(
			path,
			JSON.stringify({
				schema_version: 1,
				keys: {},
				daily: { day: null, created: -1, suppressed: 0 },
				recent: [],
			})
		);
		await assert.rejects(readAlertState(path), /daily.created/);
		await writeFile(
			path,
			JSON.stringify({
				schema_version: 1,
				keys: {},
				daily: { day: null, created: 0, suppressed: 0 },
				recent: [{ coin: 'BTC' }],
			})
		);
		await assert.rejects(readAlertState(path), /recent/);
	});
});
