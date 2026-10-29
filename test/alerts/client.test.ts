import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { createGitHubIssueClient } from '../../src/alerts/index.ts';

interface Recorded {
	method: string;
	url: string;
	headers: IncomingHttpHeaders;
	body: unknown;
}

type Reply = { status: number; json?: unknown };

let server: Server;
let baseUrl: string;
let requests: Recorded[];
let labels: Set<string>;
let issuePages: unknown[][];
let overrides: Map<string, Reply>;

function reply(res: import('node:http').ServerResponse, value: Reply): void {
	res.statusCode = value.status;
	res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify(value.json ?? {}));
}

beforeEach(async () => {
	requests = [];
	labels = new Set(['alert']);
	issuePages = [[]];
	overrides = new Map();
	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => {
			const text = Buffer.concat(chunks).toString('utf8');
			const method = req.method ?? '';
			const url = req.url ?? '';
			requests.push({
				method,
				url,
				headers: req.headers,
				body: text === '' ? undefined : JSON.parse(text),
			});
			const forced = overrides.get(`${method} ${url.split('?')[0]}`);
			if (forced !== undefined) {
				reply(res, forced);
				return;
			}
			const path = url.split('?')[0] ?? '';
			if (method === 'GET' && path.startsWith('/repos/o/r/labels/')) {
				const name = decodeURIComponent(
					path.slice('/repos/o/r/labels/'.length)
				);
				reply(
					res,
					labels.has(name)
						? { status: 200 }
						: { status: 404, json: { message: 'Not Found' } }
				);
			} else if (method === 'POST' && path === '/repos/o/r/labels') {
				const name = (JSON.parse(text) as { name: string }).name;
				labels.add(name);
				reply(res, { status: 201 });
			} else if (method === 'GET' && path === '/repos/o/r/issues') {
				const page = Number(
					new URL(url, 'http://x').searchParams.get('page')
				);
				reply(res, { status: 200, json: issuePages[page - 1] ?? [] });
			} else if (method === 'POST' && path === '/repos/o/r/issues') {
				reply(res, { status: 201, json: { number: 55 } });
			} else if (method === 'POST' && path.endsWith('/comments')) {
				reply(res, { status: 201 });
			} else if (
				method === 'PATCH' &&
				path.startsWith('/repos/o/r/issues/')
			) {
				reply(res, { status: 200 });
			} else {
				reply(res, { status: 500 });
			}
		});
	});
	await new Promise<void>((resolve) =>
		server.listen(0, '127.0.0.1', resolve)
	);
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	await new Promise<void>((resolve) => {
		server.close(() => resolve());
		server.closeAllConnections();
	});
});

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		GITHUB_TOKEN: 'test-token-value',
		GITHUB_REPOSITORY: 'o/r',
		GITHUB_API_URL: baseUrl,
		...extra,
	};
}

describe('listOpenIssues', () => {
	test('sends the labels, asks for open Issues and skips pull requests', async () => {
		issuePages = [
			[
				{ number: 3, title: 'one' },
				{ number: 4, title: 'a pull request', pull_request: {} },
				{ number: 5, title: 'two' },
				{ nope: true },
			],
		];
		const client = createGitHubIssueClient(env());
		const found = await client.listOpenIssues([
			'alert',
			'coin:BTC',
			'dir:down',
		]);
		assert.deepEqual(found, [
			{ number: 3, title: 'one' },
			{ number: 5, title: 'two' },
		]);
		const request = requests[0];
		assert.equal(request?.method, 'GET');
		const url = new URL(request?.url ?? '', 'http://x');
		assert.equal(url.searchParams.get('state'), 'open');
		assert.equal(url.searchParams.get('labels'), 'alert,coin:BTC,dir:down');
		assert.equal(url.searchParams.get('per_page'), '100');
	});

	test('sends the token, the API version and a user agent', async () => {
		await createGitHubIssueClient(env()).listOpenIssues(['alert']);
		const headers = requests[0]?.headers;
		assert.equal(headers?.authorization, 'Bearer test-token-value');
		assert.equal(headers?.['x-github-api-version'], '2022-11-28');
		assert.equal(headers?.accept, 'application/vnd.github+json');
		assert.match(String(headers?.['user-agent']), /^git-coin /);
	});

	test('reads the next page when a page is full', async () => {
		const full = Array.from({ length: 100 }, (_, i) => ({
			number: i + 1,
			title: `t${i}`,
		}));
		issuePages = [full, [{ number: 500, title: 'last' }]];
		const found = await createGitHubIssueClient(env()).listOpenIssues([
			'alert',
		]);
		assert.equal(found.length, 101);
		assert.equal(requests.length, 2);
	});

	test('a non-200 status throws a short error without the response body', async () => {
		overrides.set('GET /repos/o/r/issues', {
			status: 403,
			json: { message: 'secret body text' },
		});
		await assert.rejects(
			createGitHubIssueClient(env()).listOpenIssues(['alert']),
			(error: Error) =>
				error.message === 'GitHub API GET issues failed with status 403'
		);
	});
});

describe('createIssue', () => {
	test('creates missing labels first, then the Issue with assignees', async () => {
		const client = createGitHubIssueClient(env());
		const number = await client.createIssue({
			title: 'T',
			body: 'B',
			labels: ['alert', 'coin:BTC'],
			assignees: ['borbiuk'],
		});
		assert.equal(number, 55);
		const calls = requests.map((r) => `${r.method} ${r.url}`);
		assert.deepEqual(calls, [
			'GET /repos/o/r/labels/alert',
			'GET /repos/o/r/labels/coin%3ABTC',
			'POST /repos/o/r/labels',
			'POST /repos/o/r/issues',
		]);
		assert.equal((requests[2]?.body as { name: string }).name, 'coin:BTC');
		assert.deepEqual(requests[3]?.body, {
			title: 'T',
			body: 'B',
			labels: ['alert', 'coin:BTC'],
			assignees: ['borbiuk'],
		});
		assert.equal(requests[3]?.headers['content-type'], 'application/json');
	});

	test('checks a label only once per client', async () => {
		const client = createGitHubIssueClient(env());
		const issue = {
			title: 'T',
			body: 'B',
			labels: ['alert'],
			assignees: [],
		};
		await client.createIssue(issue);
		await client.createIssue(issue);
		assert.equal(
			requests.filter((r) => r.url.includes('/labels/')).length,
			1
		);
	});

	test('a label that another run created at the same time is fine (422)', async () => {
		overrides.set('POST /repos/o/r/labels', { status: 422 });
		const number = await createGitHubIssueClient(env()).createIssue({
			title: 'T',
			body: 'B',
			labels: ['dir:up'],
			assignees: [],
		});
		assert.equal(number, 55);
	});

	test('a failure to create the Issue throws', async () => {
		overrides.set('POST /repos/o/r/issues', {
			status: 422,
			json: { message: 'x' },
		});
		await assert.rejects(
			createGitHubIssueClient(env()).createIssue({
				title: 'T',
				body: 'B',
				labels: ['alert'],
				assignees: [],
			}),
			/GitHub API POST issues failed with status 422/
		);
	});

	test('a failure to create a label throws', async () => {
		overrides.set('POST /repos/o/r/labels', { status: 403 });
		await assert.rejects(
			createGitHubIssueClient(env()).createIssue({
				title: 'T',
				body: 'B',
				labels: ['coin:ETH'],
				assignees: [],
			}),
			/GitHub API POST label failed with status 403/
		);
	});
});

describe('addComment and closeIssue', () => {
	test('posts a comment', async () => {
		await createGitHubIssueClient(env()).addComment(12, 'hello');
		assert.equal(requests[0]?.method, 'POST');
		assert.equal(requests[0]?.url, '/repos/o/r/issues/12/comments');
		assert.deepEqual(requests[0]?.body, { body: 'hello' });
	});

	test('closes an Issue as completed', async () => {
		await createGitHubIssueClient(env()).closeIssue(12);
		assert.equal(requests[0]?.method, 'PATCH');
		assert.equal(requests[0]?.url, '/repos/o/r/issues/12');
		assert.deepEqual(requests[0]?.body, {
			state: 'closed',
			state_reason: 'completed',
		});
	});

	test('errors from the API are thrown', async () => {
		overrides.set('POST /repos/o/r/issues/12/comments', { status: 404 });
		overrides.set('PATCH /repos/o/r/issues/12', { status: 500 });
		const client = createGitHubIssueClient(env());
		await assert.rejects(client.addComment(12, 'x'), /status 404/);
		await assert.rejects(client.closeIssue(12), /status 500/);
	});
});

describe('settings', () => {
	test('a missing token throws on first use, not on creation', async () => {
		const client = createGitHubIssueClient(
			env({ GITHUB_TOKEN: undefined })
		);
		await assert.rejects(client.listOpenIssues(['alert']), /GITHUB_TOKEN/);
		assert.deepEqual(requests, []);
	});

	test('a bad repository name throws', async () => {
		const client = createGitHubIssueClient(
			env({ GITHUB_REPOSITORY: 'no-slash' })
		);
		await assert.rejects(client.closeIssue(1), /GITHUB_REPOSITORY/);
		const odd = createGitHubIssueClient(
			env({ GITHUB_REPOSITORY: 'o/r/../x' })
		);
		await assert.rejects(odd.closeIssue(1), /GITHUB_REPOSITORY/);
	});

	test('the token is never sent over plain HTTP to a remote host', async () => {
		const client = createGitHubIssueClient(
			env({ GITHUB_API_URL: 'http://example.com' })
		);
		await assert.rejects(client.closeIssue(1), /https/);
		assert.deepEqual(requests, []);
	});

	test('a trailing slash in the API address is fine', async () => {
		await createGitHubIssueClient(
			env({ GITHUB_API_URL: `${baseUrl}/` })
		).closeIssue(2);
		assert.equal(requests[0]?.url, '/repos/o/r/issues/2');
	});
});
