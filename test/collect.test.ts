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

import type { IssueClient } from '../src/alerts/index.ts';
import { runCli, runCollect } from '../src/collect.ts';
import type { CollectDeps } from '../src/collect.ts';
import { loadConfig } from '../src/config.ts';
import { ADAPTERS } from '../src/sources/index.ts';
import type {
	Config,
	HttpClient,
	HttpResult,
	SourceAdapter,
	SourceId,
	Status,
} from '../src/types.ts';

// The tests must not read or change the global or the system git config.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
delete process.env.GIT_DIR;
delete process.env.GIT_WORK_TREE;
delete process.env.GIT_INDEX_FILE;

const FIXTURE_CONFIG = new URL('./fixtures/e2e/config.json', import.meta.url);
const T0 = '2026-10-29T14:03:12Z';
const CSV_DIR = 'data/raw/2026/10/29';
const HEADER = 'ts,price,src,age_s';

const roots: string[] = [];

after(() => {
	for (const root of roots) {
		rmSync(root, { recursive: true, force: true });
	}
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

function plusMinutes(iso: string, minutes: number): string {
	const date = new Date(Date.parse(iso) + minutes * 60_000);
	return `${date.toISOString().slice(0, 19)}Z`;
}

// ---- Fake market: serves the response shape of each source, with made-up prices ----

const COIN_KEYS = {
	BTC: { krakenKey: 'XXBTZUSD', altname: 'XBTUSD', product: 'BTC-USD' },
	ETH: { krakenKey: 'XETHZUSD', altname: 'ETHUSD', product: 'ETH-USD' },
} as const;
type CoinId = keyof typeof COIN_KEYS;
const COIN_IDS = Object.keys(COIN_KEYS) as CoinId[];

interface Clock {
	iso: string;
}

interface Market {
	http: HttpClient;
	prices: Record<SourceId, Record<CoinId, string>>;
	down: Set<SourceId>;
	requests: Record<SourceId, number>;
}

function makeMarket(clock: Clock): Market {
	const prices: Market['prices'] = {
		kraken: { BTC: '100.00', ETH: '10.00' },
		coinbase: { BTC: '100.10', ETH: '10.01' },
		bitstamp: { BTC: '100.20', ETH: '10.02' },
		coinmetrics: { BTC: '100.30', ETH: '10.03' },
	};
	const down = new Set<SourceId>();
	const requests: Market['requests'] = {
		kraken: 0,
		coinbase: 0,
		bitstamp: 0,
		coinmetrics: 0,
	};

	function respond(source: SourceId, json: unknown): HttpResult {
		requests[source] += 1;
		if (down.has(source)) {
			return { status: 0, ms: 5, error: 'timeout' };
		}
		return { status: 200, ms: 7, json };
	}

	function serve(url: URL): HttpResult {
		const nowMs = Date.parse(clock.iso);
		switch (url.hostname) {
			case 'api.kraken.com': {
				if (url.pathname.endsWith('/AssetPairs')) {
					const result: Record<string, unknown> = {};
					for (const id of COIN_IDS) {
						const info = COIN_KEYS[id];
						result[info.krakenKey] = {
							altname: info.altname,
							wsname: `${id}/USD`,
							status: 'online',
						};
					}
					return respond('kraken', { error: [], result });
				}
				const result: Record<string, unknown> = {};
				for (const id of COIN_IDS) {
					result[COIN_KEYS[id].krakenKey] = {
						c: [prices.kraken[id], '1'],
					};
				}
				return respond('kraken', { error: [], result });
			}
			case 'api.exchange.coinbase.com': {
				const product = url.pathname.split('/')[2];
				const id = COIN_IDS.find(
					(c) => COIN_KEYS[c].product === product
				);
				if (id === undefined) {
					return respond('coinbase', null);
				}
				return respond('coinbase', {
					price: prices.coinbase[id],
					time: new Date(nowMs - 2000).toISOString(),
				});
			}
			case 'www.bitstamp.net':
				return respond(
					'bitstamp',
					COIN_IDS.map((id) => ({
						pair: `${id}/USD`,
						last: prices.bitstamp[id],
						timestamp: String(Math.floor(nowMs / 1000) - 3),
					}))
				);
			case 'community-api.coinmetrics.io':
				return respond('coinmetrics', {
					data: COIN_IDS.map((id) => ({
						asset: id.toLowerCase(),
						time: `${new Date(nowMs - 60_000).toISOString().slice(0, 19)}.000000000Z`,
						ReferenceRateUSD: prices.coinmetrics[id],
					})),
				});
			default:
				throw new Error(`Unexpected host in a test: ${url.hostname}`);
		}
	}

	return {
		prices,
		down,
		requests,
		http: {
			getJson(req) {
				return Promise.resolve(serve(new URL(req.url)));
			},
		},
	};
}

// ---- Fake Issue client ----

interface FakeIssues {
	client: IssueClient;
	calls: string[];
	created: Array<{ title: string; body: string; labels: string[] }>;
	closed: number[];
	failing: boolean;
}

function makeIssues(): FakeIssues {
	const open: Array<{ number: number; title: string; labels: string[] }> = [];
	const fake: FakeIssues = {
		calls: [],
		created: [],
		closed: [],
		failing: false,
		client: {
			listOpenIssues(labels) {
				fake.calls.push(`list:${labels.join('+')}`);
				if (fake.failing) {
					return Promise.reject(new Error('fake API failure'));
				}
				return Promise.resolve(
					open
						.filter((item) =>
							labels.every((label) => item.labels.includes(label))
						)
						.map((item) => ({
							number: item.number,
							title: item.title,
						}))
				);
			},
			createIssue(issue) {
				fake.calls.push('create');
				if (fake.failing) {
					return Promise.reject(new Error('fake API failure'));
				}
				const number = open.length + fake.closed.length + 1;
				open.push({
					number,
					title: issue.title,
					labels: issue.labels,
				});
				fake.created.push({
					title: issue.title,
					body: issue.body,
					labels: issue.labels,
				});
				return Promise.resolve(number);
			},
			addComment() {
				fake.calls.push('comment');
				return Promise.resolve();
			},
			closeIssue(issue) {
				fake.calls.push('close');
				const index = open.findIndex((item) => item.number === issue);
				if (index >= 0) {
					open.splice(index, 1);
				}
				fake.closed.push(issue);
				return Promise.resolve();
			},
		},
	};
	return fake;
}

// ---- Harness: a bare remote, a clone as the data checkout, a clock, a market ----

interface Harness {
	root: string;
	remote: string;
	data: string;
	configPath: string;
	config: Config;
	clock: Clock;
	market: Market;
	logs: string[];
	issues: FakeIssues;
}

type Patch = (config: Config) => void;

function productionOneSource(extra: Patch = () => undefined): Patch {
	return (config) => {
		config.settings.phase = 'production';
		config.settings.stored_sources = ['kraken'];
		extra(config);
	};
}

async function makeHarness(patch: Patch = () => undefined): Promise<Harness> {
	const root = mkdtempSync(join(tmpdir(), 'git-coin-collect-'));
	roots.push(root);
	const remote = join(root, 'remote.git');
	const data = join(root, 'data-checkout');
	git(root, 'init', '--quiet', '--bare', '--initial-branch=data', remote);
	const seed = join(root, 'seed');
	git(root, 'init', '--quiet', '--initial-branch=data', seed);
	git(seed, 'config', 'user.name', 'Seed');
	git(seed, 'config', 'user.email', 'seed@example.test');
	writeFileSync(join(seed, '.gitkeep'), '');
	git(seed, 'add', '-A');
	git(seed, 'commit', '--quiet', '-m', 'Seed');
	git(seed, 'push', '--quiet', remote, 'data');
	git(root, 'clone', '--quiet', remote, data);
	git(data, 'config', 'user.name', 'Local');
	git(data, 'config', 'user.email', 'local@example.test');

	const raw = JSON.parse(readFileSync(FIXTURE_CONFIG, 'utf8')) as Config;
	patch(raw);
	const configPath = join(root, 'config.json');
	writeFileSync(configPath, JSON.stringify(raw, null, 2));
	const clock: Clock = { iso: T0 };
	return {
		root,
		remote,
		data,
		configPath,
		config: await loadConfig(configPath),
		clock,
		market: makeMarket(clock),
		logs: [],
		issues: makeIssues(),
	};
}

function depsOf(h: Harness, extra: Partial<CollectDeps> = {}): CollectDeps {
	return {
		config: h.config,
		now: () => new Date(h.clock.iso),
		http: h.market.http,
		adapters: ADAPTERS,
		dataRoot: h.data,
		git: { repoDir: h.data, branch: 'data' },
		issueClient: null,
		dryRun: false,
		dashboardUrl: 'https://example.test/dashboard/',
		keepalive: null,
		log: (line) => {
			h.logs.push(line);
		},
		...extra,
	};
}

/** Sets the clock and runs the collector once. */
function runAt(
	h: Harness,
	iso: string,
	extra: Partial<CollectDeps> = {}
): ReturnType<typeof runCollect> {
	h.clock.iso = iso;
	return runCollect(depsOf(h, extra));
}

function show(h: Harness, path: string): string {
	return git(h.remote, 'show', `data:${path}`);
}

function remoteLines(h: Harness, path: string): string[] {
	return show(h, path).trimEnd().split('\n');
}

function remoteStatus(h: Harness): Status {
	return JSON.parse(show(h, 'state/status.json')) as Status;
}

function subjects(h: Harness): string[] {
	return git(h.remote, 'log', 'data', '--format=%s').trimEnd().split('\n');
}

function remoteHead(h: Harness): string {
	return git(h.remote, 'rev-parse', 'data').trim();
}

/** Commits and pushes a file to the data branch from the checkout, as a human would. */
function seedFile(h: Harness, path: string, content: string): void {
	mkdirSync(join(h.data, path, '..'), { recursive: true });
	writeFileSync(join(h.data, path), content);
	git(h.data, 'add', '-A');
	git(h.data, 'commit', '--quiet', '-m', `Add ${path}`);
	git(h.data, 'push', '--quiet', 'origin', 'HEAD:refs/heads/data');
}

function requestLogColumns(h: Harness): string[][] {
	return remoteLines(h, 'data/meta/2026/10/29/requests.csv')
		.slice(1)
		.map((line) => line.split(','));
}

// ---- Tests ----

test('test phase: all four sources are stored with their own src code', async () => {
	const h = await makeHarness();
	const result = await runAt(h, T0, { issueClient: h.issues.client });

	assert.deepEqual(result, {
		exitCode: 0,
		shouldPublish: false,
		rowsWritten: 8,
	});
	assert.deepEqual(remoteLines(h, `${CSV_DIR}/BTC.csv`), [
		HEADER,
		`${T0},100.00,kr,`,
		`${T0},100.10,cb,2`,
		`${T0},100.20,bs,3`,
		`${T0},100.30,cm,60`,
	]);
	assert.deepEqual(remoteLines(h, `${CSV_DIR}/ETH.csv`), [
		HEADER,
		`${T0},10.00,kr,`,
		`${T0},10.01,cb,2`,
		`${T0},10.02,bs,3`,
		`${T0},10.03,cm,60`,
	]);
	const log = requestLogColumns(h);
	assert.deepEqual(
		log.map((cols) => cols.slice(1, 3).concat(cols.slice(4))),
		[
			['kr', '200', '2', ''],
			['cb', '200', '2', ''],
			['bs', '200', '2', ''],
			['cm', '200', '2', ''],
		]
	);
	const status = remoteStatus(h);
	assert.equal(status.phase, 'test');
	assert.equal(status.consecutive_failures, 0);
	assert.equal(status.last_point_at, T0);
	assert.equal(status.last_publish_at, null);
	assert.equal(status.sources.kr?.requests, 1);
	assert.equal(status.sources.cm?.last_ok_at, T0);
	assert.deepEqual(subjects(h), ['data: 2026-10-29T14:03Z 8 rows', 'Seed']);
	// Kraken asks twice (catalogue and ticker), Coinbase once per coin
	assert.equal(h.market.requests.kraken, 2);
	assert.equal(h.market.requests.coinbase, 2);
	// The test phase touches no Issue and writes no alert state
	assert.deepEqual(h.issues.calls, []);
	assert.throws(() => show(h, 'state/alerts.json'));
	// The checkout and the remote agree, and the author is the bot
	assert.equal(git(h.data, 'rev-parse', 'HEAD').trim(), remoteHead(h));
	assert.match(
		git(h.remote, 'log', '-1', 'data', '--format=%an'),
		/github-actions\[bot\]/
	);
});

test('one source down: the other sources are stored and the failure is logged', async () => {
	const h = await makeHarness();
	h.market.down.add('coinbase');
	const result = await runAt(h, T0);

	assert.equal(result.exitCode, 0);
	assert.equal(result.rowsWritten, 6);
	assert.deepEqual(
		remoteLines(h, `${CSV_DIR}/BTC.csv`).map((l) => l.split(',')[2]),
		['src', 'kr', 'bs', 'cm']
	);
	const coinbase = requestLogColumns(h).find((cols) => cols[1] === 'cb');
	assert.equal(coinbase?.[2], '0');
	assert.equal(coinbase?.[4], '0');
	assert.equal(coinbase?.[5], 'timeout');
	const status = remoteStatus(h);
	assert.equal(status.consecutive_failures, 0);
	assert.equal(status.sources.cb?.consecutive_failures, 1);
	assert.deepEqual(status.sources.cb?.failures_by_error, { timeout: 1 });
	assert.equal(status.coins.BTC?.status, 'ok');
});

test('an adapter that throws becomes a failed log row and the others go on', async () => {
	const h = await makeHarness();
	const broken: SourceAdapter = {
		id: 'bitstamp',
		src: 'bs',
		fetchPrices() {
			return Promise.reject(new Error('boom'));
		},
	};
	const result = await runAt(h, T0, {
		adapters: { ...ADAPTERS, bitstamp: broken },
	});

	assert.equal(result.exitCode, 0);
	assert.equal(result.rowsWritten, 6);
	const bitstamp = requestLogColumns(h).find((cols) => cols[1] === 'bs');
	assert.equal(bitstamp?.[5], 'parse');
	assert.ok(h.logs.some((line) => line.includes('the adapter threw')));
});

test('a malformed price is rejected and counted, the other rows are stored', async () => {
	const h = await makeHarness();
	h.market.prices.bitstamp.BTC = '1e5';
	const result = await runAt(h, T0);

	assert.equal(result.rowsWritten, 7);
	assert.ok(!show(h, `${CSV_DIR}/BTC.csv`).includes(',bs,'));
	const status = remoteStatus(h);
	assert.equal(status.coins.BTC?.rejected_count, 1);
	assert.equal(status.coins.BTC?.last_reject_reason, 'not_decimal');
});

test('all sources down: status and request log are committed, the streak goes up', async () => {
	const h = await makeHarness();
	for (const id of Object.keys(h.market.prices) as SourceId[]) {
		h.market.down.add(id);
	}
	const result = await runAt(h, T0, { issueClient: h.issues.client });

	assert.deepEqual(result, {
		exitCode: 0,
		shouldPublish: false,
		rowsWritten: 0,
	});
	assert.deepEqual(subjects(h), ['data: 2026-10-29T14:03Z 0 rows', 'Seed']);
	assert.throws(() => show(h, `${CSV_DIR}/BTC.csv`));
	assert.deepEqual(
		requestLogColumns(h).map((cols) => cols[5]),
		['timeout', 'timeout', 'timeout', 'timeout']
	);
	const status = remoteStatus(h);
	assert.equal(status.consecutive_failures, 1);
	assert.equal(status.last_point_at, null);
	assert.equal(status.last_run_at, T0);
	assert.deepEqual(h.issues.calls, []);
});

test('production: the no data Issue opens after 4 failed runs and closes when data returns', async () => {
	const h = await makeHarness(
		productionOneSource((config) => {
			config.settings.features.alerts = true;
		})
	);
	h.market.down.add('kraken');
	for (let run = 0; run < 3; run += 1) {
		const result = await runAt(h, plusMinutes(T0, run * 15), {
			issueClient: h.issues.client,
		});
		assert.equal(result.exitCode, 0);
	}
	assert.equal(h.issues.created.length, 0);
	assert.equal(remoteStatus(h).consecutive_failures, 3);

	await runAt(h, plusMinutes(T0, 45), { issueClient: h.issues.client });
	assert.equal(remoteStatus(h).consecutive_failures, 4);
	assert.equal(h.issues.created.length, 1);
	assert.equal(h.issues.created[0]?.title, '[collector] no data');

	// The same state on the next failed run creates no second Issue
	await runAt(h, plusMinutes(T0, 60), { issueClient: h.issues.client });
	assert.equal(h.issues.created.length, 1);

	h.market.down.delete('kraken');
	const back = await runAt(h, plusMinutes(T0, 75), {
		issueClient: h.issues.client,
	});
	assert.equal(back.rowsWritten, 2);
	assert.equal(remoteStatus(h).consecutive_failures, 0);
	assert.deepEqual(h.issues.closed, [1]);
});

test('dry run writes nothing, makes no Issue call and does not publish', async () => {
	const h = await makeHarness(
		productionOneSource((config) => {
			config.settings.features.alerts = true;
			config.settings.features.publish = true;
		})
	);
	const headBefore = remoteHead(h);
	const result = await runAt(h, T0, {
		dryRun: true,
		issueClient: h.issues.client,
	});

	assert.deepEqual(result, {
		exitCode: 0,
		shouldPublish: false,
		rowsWritten: 0,
	});
	assert.equal(git(h.data, 'status', '--porcelain').trim(), '');
	assert.equal(remoteHead(h), headBefore);
	assert.deepEqual(h.issues.calls, []);
	assert.ok(h.logs.some((line) => line.includes('dry run: 2 rows')));
	// The log has counts only, no response body
	assert.ok(!h.logs.some((line) => line.includes('"result"')));
});

test('test phase stores a large step, production rejects it without a cross-check', async () => {
	const testPhase = await makeHarness();
	await runAt(testPhase, T0);
	testPhase.market.prices.kraken.BTC = '200.00';
	const accepted = await runAt(testPhase, plusMinutes(T0, 15));
	assert.equal(accepted.rowsWritten, 8);

	const production = await makeHarness(productionOneSource());
	await runAt(production, T0);
	production.market.prices.kraken.BTC = '200.00';
	const result = await runAt(production, plusMinutes(T0, 15));
	assert.equal(result.exitCode, 0);
	assert.equal(result.rowsWritten, 1);
	assert.deepEqual(remoteLines(production, `${CSV_DIR}/BTC.csv`), [
		HEADER,
		`${T0},100.00,kr,`,
	]);
	assert.equal(remoteLines(production, `${CSV_DIR}/ETH.csv`).length, 3);
	const status = remoteStatus(production);
	assert.equal(status.phase, 'production');
	assert.equal(status.coins.BTC?.rejected_count, 1);
	assert.equal(status.coins.BTC?.last_reject_reason, 'step_no_crosscheck');
	// The request log still has the row of the second run
	assert.equal(requestLogColumns(production).length, 2);
});

test('alerts are gated off in the test phase even when the feature flag is on', async () => {
	const h = await makeHarness((config) => {
		config.settings.features.alerts = true;
	});
	await runAt(h, T0, { issueClient: h.issues.client });
	assert.deepEqual(h.issues.calls, []);
	assert.throws(() => show(h, 'state/alerts.json'));
	assert.ok(!h.logs.some((line) => line.startsWith('alerts:')));
});

test('production with alerts: a sharp move opens an Issue and the alert state is committed', async () => {
	const h = await makeHarness(
		productionOneSource((config) => {
			config.settings.features.alerts = true;
		})
	);
	await runAt(h, T0, { issueClient: h.issues.client });
	assert.equal(h.issues.created.length, 0);

	h.market.prices.kraken.BTC = '110.00';
	const result = await runAt(h, plusMinutes(T0, 60), {
		issueClient: h.issues.client,
	});
	assert.equal(result.exitCode, 0);
	assert.equal(h.issues.created.length, 1);
	assert.match(h.issues.created[0]?.title ?? '', /BTC up/);
	assert.ok(
		h.issues.created[0]?.body.includes('https://example.test/dashboard/')
	);
	const state = JSON.parse(show(h, 'state/alerts.json')) as {
		keys: Record<string, { issue: number }>;
	};
	assert.equal(state.keys['BTC:up']?.issue, 1);
	assert.deepEqual(subjects(h).slice(0, 2), [
		'state: alerts 2026-10-29T15:03Z',
		'data: 2026-10-29T15:03Z 2 rows',
	]);
});

test('a broken alert state never blocks the price commit', async () => {
	const h = await makeHarness(
		productionOneSource((config) => {
			config.settings.features.alerts = true;
		})
	);
	seedFile(h, 'state/alerts.json', '{not json');
	const result = await runAt(h, T0, { issueClient: h.issues.client });

	assert.deepEqual(result, {
		exitCode: 0,
		shouldPublish: false,
		rowsWritten: 2,
	});
	assert.ok(remoteLines(h, `${CSV_DIR}/BTC.csv`).length === 2);
	assert.ok(h.logs.some((line) => line.startsWith('alerts: failed')));
	// The no data Issue sync still runs on its own
	assert.deepEqual(h.issues.calls, ['list:collector']);
});

test('a failing Issue client is not fatal, and a missing client skips the alert step', async () => {
	const failing = await makeHarness(
		productionOneSource((config) => {
			config.settings.features.alerts = true;
		})
	);
	failing.issues.failing = true;
	const result = await runAt(failing, T0, {
		issueClient: failing.issues.client,
	});
	assert.equal(result.exitCode, 0);
	assert.equal(result.rowsWritten, 2);
	assert.ok(
		failing.logs.some((line) => line.startsWith('no data Issue: failed'))
	);

	const missing = await makeHarness(
		productionOneSource((config) => {
			config.settings.features.alerts = true;
		})
	);
	const skipped = await runAt(missing, T0);
	assert.equal(skipped.exitCode, 0);
	assert.ok(missing.logs.some((line) => line.startsWith('alerts: skipped')));
});

// A second clone pushes first, so the push of the collector is rejected once.
function installPushRace(h: Harness, otherLines: string[]): string {
	const other = join(h.root, 'other');
	git(h.root, 'clone', '--quiet', h.remote, other);
	git(other, 'config', 'user.name', 'Other');
	git(other, 'config', 'user.email', 'other@example.test');
	mkdirSync(join(other, CSV_DIR), { recursive: true });
	writeFileSync(
		join(other, CSV_DIR, 'BTC.csv'),
		`${[HEADER, ...otherLines].join('\n')}\n`
	);
	git(other, 'add', '-A');
	git(other, 'commit', '--quiet', '-m', 'Other run');
	const marker = join(h.root, 'race.done');
	const hook = join(h.data, '.git', 'hooks', 'pre-push');
	writeFileSync(
		hook,
		[
			'#!/bin/sh',
			`if [ -e '${marker}' ]; then exit 0; fi`,
			`touch '${marker}'`,
			`env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE git -C '${other}' push --quiet origin HEAD:refs/heads/data`,
			'',
		].join('\n')
	);
	chmodSync(hook, 0o755);
	return marker;
}

test('a push conflict runs the write step twice without duplicate rows', async () => {
	const h = await makeHarness();
	const marker = installPushRace(h, [`${plusMinutes(T0, -30)},99.00,kr,`]);
	const result = await runAt(h, T0);

	assert.equal(readFileSync(marker, 'utf8'), '');
	assert.deepEqual(result, {
		exitCode: 0,
		shouldPublish: false,
		rowsWritten: 8,
	});
	assert.ok(h.logs.some((line) => line.includes('pushed after 2 tries')));
	assert.deepEqual(remoteLines(h, `${CSV_DIR}/BTC.csv`), [
		HEADER,
		`${plusMinutes(T0, -30)},99.00,kr,`,
		`${T0},100.00,kr,`,
		`${T0},100.10,cb,2`,
		`${T0},100.20,bs,3`,
		`${T0},100.30,cm,60`,
	]);
	// One fetch, one request-log block and one count per source, although write() ran twice
	assert.equal(h.market.requests.kraken, 2);
	assert.equal(requestLogColumns(h).length, 4);
	assert.equal(remoteStatus(h).sources.kr?.requests, 1);
	assert.equal(git(h.data, 'rev-parse', 'HEAD').trim(), remoteHead(h));
});

test('after a push conflict the spacing guard skips a row another run already stored', async () => {
	const h = await makeHarness();
	installPushRace(h, [`${plusMinutes(T0, -1)},100.05,cb,1`]);
	const result = await runAt(h, T0);

	assert.equal(result.exitCode, 0);
	assert.equal(result.rowsWritten, 7);
	const lines = remoteLines(h, `${CSV_DIR}/BTC.csv`);
	assert.equal(lines.filter((line) => line.includes(',cb,')).length, 1);
	assert.ok(lines.includes(`${plusMinutes(T0, -1)},100.05,cb,1`));
	assert.equal(lines.length, 5);
});

test('a re-run inside min_spacing adds no price rows', async () => {
	const h = await makeHarness();
	await runAt(h, T0);
	const result = await runAt(h, plusMinutes(T0, 1));

	assert.deepEqual(result, {
		exitCode: 0,
		shouldPublish: false,
		rowsWritten: 0,
	});
	assert.equal(remoteLines(h, `${CSV_DIR}/BTC.csv`).length, 5);
	assert.equal(remoteLines(h, `${CSV_DIR}/ETH.csv`).length, 5);
	assert.equal(remoteLines(h, 'data/meta/2026/10/29/requests.csv').length, 9);
	// A run in which every row is skipped counts as a failed run (A7 rule)
	assert.equal(remoteStatus(h).consecutive_failures, 1);
	assert.ok(h.logs.some((line) => line.includes('spacing')));
	// 5 minutes later the rows are accepted again
	const later = await runAt(h, plusMinutes(T0, 6));
	assert.equal(later.rowsWritten, 8);
	assert.equal(remoteStatus(h).consecutive_failures, 0);
});

test('should_publish follows the feature flag, the phase and the minimum interval', async () => {
	const h = await makeHarness(
		productionOneSource((config) => {
			config.settings.features.publish = true;
		})
	);
	const first = await runAt(h, T0);
	assert.equal(first.shouldPublish, true);
	assert.equal(remoteStatus(h).last_publish_at, T0);

	const second = await runAt(h, plusMinutes(T0, 15));
	assert.equal(second.shouldPublish, false);
	assert.equal(remoteStatus(h).last_publish_at, T0);

	const third = await runAt(h, plusMinutes(T0, 30));
	assert.equal(third.shouldPublish, true);
	assert.equal(remoteStatus(h).last_publish_at, plusMinutes(T0, 30));

	const publishOff = await makeHarness(productionOneSource());
	assert.equal((await runAt(publishOff, T0)).shouldPublish, false);
	assert.equal(remoteStatus(publishOff).last_publish_at, null);

	const testPhase = await makeHarness((config) => {
		config.settings.features.publish = true;
	});
	assert.equal((await runAt(testPhase, T0)).shouldPublish, false);
});

// ---- Exit codes ----

test('an unexpected exception gives exit code 1 and commits nothing', async () => {
	const h = await makeHarness();
	const headBefore = remoteHead(h);
	const result = await runAt(h, T0, { adapters: {} });

	assert.deepEqual(result, {
		exitCode: 1,
		shouldPublish: false,
		rowsWritten: 0,
	});
	assert.ok(h.logs.some((line) => line.includes('There is no adapter')));
	assert.equal(remoteHead(h), headBefore);
});

test('the append-only guard failure gives exit code 1', async () => {
	const h = await makeHarness();
	await runAt(h, T0);
	const headBefore = remoteHead(h);
	const file = join(h.data, CSV_DIR, 'BTC.csv');
	const cutting: SourceAdapter = {
		...ADAPTERS.kraken,
		fetchPrices(coins, http, now) {
			writeFileSync(file, `${HEADER}\n`);
			return ADAPTERS.kraken.fetchPrices(coins, http, now);
		},
	};
	const result = await runAt(h, plusMinutes(T0, 15), {
		adapters: { ...ADAPTERS, kraken: cutting },
	});

	assert.equal(result.exitCode, 1);
	assert.ok(h.logs.some((line) => line.includes('Append-only guard failed')));
	assert.equal(remoteHead(h), headBefore);
});

test('a push that fails 3 times gives exit code 1', async () => {
	const h = await makeHarness();
	git(h.data, 'remote', 'set-url', 'origin', join(h.root, 'missing.git'));
	const result = await runAt(h, T0);

	assert.deepEqual(result, {
		exitCode: 1,
		shouldPublish: false,
		rowsWritten: 0,
	});
	assert.ok(h.logs.some((line) => line.includes('was not pushed')));
});

test('a data root that is not a git checkout gives exit code 1', async () => {
	const h = await makeHarness();
	const plain = join(h.root, 'plain');
	mkdirSync(plain);
	const result = await runAt(h, T0, {
		dataRoot: plain,
		git: { repoDir: plain, branch: 'data' },
	});
	assert.equal(result.exitCode, 1);
});

test('the command line gives exit code 1 for an invalid config and for bad arguments', async () => {
	const h = await makeHarness();
	const bad = join(h.root, 'bad.json');
	const raw = JSON.parse(readFileSync(h.configPath, 'utf8')) as Record<
		string,
		unknown
	>;
	raw.surprise = true;
	writeFileSync(bad, JSON.stringify(raw));
	const lines: string[] = [];
	const options = {
		http: h.market.http,
		log: (line: string) => {
			lines.push(line);
		},
	};

	assert.equal(
		await runCli(['--config', bad, '--data-root', h.data], {}, options),
		1
	);
	assert.ok(lines.some((line) => line.startsWith('invalid config')));
	assert.equal(
		await runCli(
			['--config', join(h.root, 'nope.json'), '--data-root', h.data],
			{},
			options
		),
		1
	);
	assert.equal(await runCli([], {}, options), 1);
	assert.equal(
		await runCli(
			['--config', h.configPath, '--data-root', h.data, '--bogus'],
			{},
			options
		),
		1
	);
	assert.equal(
		await runCli(
			['--config', h.configPath, '--data-root', h.data, '--keepalive'],
			{},
			options
		),
		1
	);
	assert.equal(
		await runCli(
			['--config', h.configPath, '--data-root', h.data, '--now', 'soon'],
			{},
			options
		),
		1
	);
	// Nothing was committed by any of these
	assert.deepEqual(subjects(h), ['Seed']);
});

// ---- Outputs file and command line ----

test('the command line appends should_publish and rows_written to $GITHUB_OUTPUT', async () => {
	const h = await makeHarness(
		productionOneSource((config) => {
			config.settings.features.publish = true;
		})
	);
	const outputs = join(h.root, 'github-output');
	writeFileSync(outputs, 'earlier=1\n');
	const base = ['--config', h.configPath, '--data-root', h.data];
	const options = { http: h.market.http, log: () => undefined };

	const code = await runCli(
		[...base, '--now', T0],
		{ GITHUB_OUTPUT: outputs, GITHUB_REPOSITORY: 'Owner/Repo' },
		options
	);
	assert.equal(code, 0);
	assert.equal(
		readFileSync(outputs, 'utf8'),
		'earlier=1\nshould_publish=true\nrows_written=2\n'
	);
	assert.equal(remoteLines(h, `${CSV_DIR}/BTC.csv`)[1], `${T0},100.00,kr,`);

	// A dry run: no new rows, no publish, and the same two lines
	const dryOutputs = join(h.root, 'dry-output');
	const dry = await runCli(
		[...base, '--now', plusMinutes(T0, 60), '--dry-run'],
		{ GITHUB_OUTPUT: dryOutputs },
		options
	);
	assert.equal(dry, 0);
	assert.equal(
		readFileSync(dryOutputs, 'utf8'),
		'should_publish=false\nrows_written=0\n'
	);
	assert.deepEqual(subjects(h), ['data: 2026-10-29T14:03Z 2 rows', 'Seed']);
});

test('the command line builds the dashboard address from GITHUB_REPOSITORY', async () => {
	const h = await makeHarness(
		productionOneSource((config) => {
			config.settings.features.alerts = true;
		})
	);
	h.market.prices.kraken.BTC = '100.00';
	const base = ['--config', h.configPath, '--data-root', h.data];
	const options = {
		http: h.market.http,
		issueClient: h.issues.client,
		log: () => undefined,
	};
	await runCli(
		[...base, '--now', T0],
		{ GITHUB_REPOSITORY: 'Owner/Repo' },
		options
	);
	h.market.prices.kraken.BTC = '110.00';
	await runCli(
		[...base, '--now', plusMinutes(T0, 60)],
		{ GITHUB_REPOSITORY: 'Owner/Repo' },
		options
	);
	assert.ok(
		h.issues.created[0]?.body.includes('https://owner.github.io/Repo/')
	);
});

// ---- Keepalive ----

/** A bare `main` remote and a checkout whose only commit is old. */
function makeMain(
	h: Harness,
	commitDate: string
): { remote: string; dir: string } {
	const remote = join(h.root, 'main.git');
	const dir = join(h.root, 'code');
	git(h.root, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
	git(h.root, 'init', '--quiet', '--initial-branch=main', dir);
	git(dir, 'config', 'user.name', 'Owner');
	git(dir, 'config', 'user.email', 'owner@example.test');
	writeFileSync(join(dir, 'README.md'), 'code\n');
	git(dir, 'add', '-A');
	execFileSync('git', ['commit', '--quiet', '-m', 'Old commit'], {
		cwd: dir,
		env: {
			...process.env,
			GIT_AUTHOR_DATE: commitDate,
			GIT_COMMITTER_DATE: commitDate,
		},
	});
	git(dir, 'remote', 'add', 'origin', remote);
	git(dir, 'push', '--quiet', 'origin', 'main');
	return { remote, dir };
}

test('keepalive pushes an empty commit to main when it is stale', async () => {
	const h = await makeHarness();
	const main = makeMain(h, '2026-01-01T00:00:00Z');
	const result = await runAt(h, T0, {
		keepalive: { mainDir: main.dir, maxAgeDays: 30 },
	});

	assert.equal(result.exitCode, 0);
	assert.equal(result.rowsWritten, 8);
	assert.equal(
		git(main.remote, 'log', '-1', 'main', '--format=%s').trim(),
		'Keep schedule active'
	);
	assert.ok(h.logs.some((line) => line.includes('keepalive: pushed')));
});

test('keepalive does nothing for a recent main and in a dry run', async () => {
	const h = await makeHarness();
	const recent = makeMain(h, '2026-10-20T00:00:00Z');
	await runAt(h, T0, { keepalive: { mainDir: recent.dir, maxAgeDays: 30 } });
	assert.ok(h.logs.some((line) => line.includes('keepalive: not needed')));

	const stale = await makeHarness();
	const old = makeMain(stale, '2026-01-01T00:00:00Z');
	await runAt(stale, T0, {
		dryRun: true,
		keepalive: { mainDir: old.dir, maxAgeDays: 30 },
	});
	assert.equal(
		git(old.remote, 'log', '-1', 'main', '--format=%s').trim(),
		'Old commit'
	);
});

test('a keepalive failure is logged and does not fail the data run', async () => {
	const h = await makeHarness();
	const main = makeMain(h, '2026-01-01T00:00:00Z');
	git(main.dir, 'remote', 'set-url', 'origin', join(h.root, 'missing.git'));
	const result = await runAt(h, T0, {
		keepalive: { mainDir: main.dir, maxAgeDays: 30 },
	});

	assert.equal(result.exitCode, 0);
	assert.equal(result.rowsWritten, 8);
	assert.ok(h.logs.some((line) => line.startsWith('keepalive: failed')));
	assert.deepEqual(subjects(h), ['data: 2026-10-29T14:03Z 8 rows', 'Seed']);
});

test('the keepalive step also runs after a failed data run', async () => {
	const h = await makeHarness();
	const main = makeMain(h, '2026-01-01T00:00:00Z');
	const result = await runAt(h, T0, {
		adapters: {},
		keepalive: { mainDir: main.dir, maxAgeDays: 30 },
	});
	assert.equal(result.exitCode, 1);
	assert.equal(
		git(main.remote, 'log', '-1', 'main', '--format=%s').trim(),
		'Keep schedule active'
	);
});
