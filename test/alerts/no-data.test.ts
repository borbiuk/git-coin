import assert from 'node:assert/strict';
import { test } from 'node:test';

import { syncNoDataIssue } from '../../src/alerts/index.ts';

import { fakeClient } from './helpers.ts';

const TITLE = '[collector] no data';

test('opens one Issue when it is needed and none is open', async () => {
	const client = fakeClient();
	await syncNoDataIssue(client, true, false);
	assert.deepEqual(client.calls[0], { op: 'list', labels: ['collector'] });
	const create = client.calls[1];
	assert.ok(create && create.op === 'create');
	assert.equal(create.issue.title, TITLE);
	assert.deepEqual(create.issue.labels, ['collector']);
	assert.deepEqual(create.issue.assignees, ['borbiuk']);
	assert.ok(create.issue.body.includes('@borbiuk'));
	assert.equal(client.calls.length, 2);
});

test('does not open a second Issue while one is open', async () => {
	const client = fakeClient([
		{ number: 5, title: TITLE, labels: ['collector'] },
	]);
	await syncNoDataIssue(client, true, false);
	assert.equal(client.calls.filter((c) => c.op === 'create').length, 0);
	assert.equal(client.calls.filter((c) => c.op === 'close').length, 0);
});

test('closes the open Issue with a comment when data is back', async () => {
	const client = fakeClient([
		{ number: 5, title: TITLE, labels: ['collector'] },
	]);
	await syncNoDataIssue(client, false, false);
	assert.deepEqual(client.calls.slice(1), [
		{ op: 'comment', issue: 5, body: 'Data is coming in again. Closing.' },
		{ op: 'close', issue: 5 },
	]);
});

test('does nothing when it is not needed and none is open', async () => {
	const client = fakeClient();
	await syncNoDataIssue(client, false, false);
	assert.deepEqual(client.calls, [{ op: 'list', labels: ['collector'] }]);
});

test('ignores other open Issues with the collector label', async () => {
	const client = fakeClient([
		{
			number: 9,
			title: '[collector] something else',
			labels: ['collector'],
		},
	]);
	await syncNoDataIssue(client, false, false);
	assert.equal(client.calls.filter((c) => c.op === 'close').length, 0);
	await syncNoDataIssue(client, true, false);
	assert.equal(client.calls.filter((c) => c.op === 'create').length, 1);
});

test('a dry run makes no client call', async () => {
	const client = fakeClient([
		{ number: 5, title: TITLE, labels: ['collector'] },
	]);
	await syncNoDataIssue(client, true, true);
	await syncNoDataIssue(client, false, true);
	assert.deepEqual(client.calls, []);
});

test('a client failure is thrown to the caller', async () => {
	const client = fakeClient();
	client.failOn.add('list');
	await assert.rejects(syncNoDataIssue(client, true, false), /list failed/);
});
