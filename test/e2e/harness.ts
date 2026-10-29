// Shared helpers of the end-to-end tests (A15): a bare remote, shallow checkouts like `actions/checkout`
// with `fetch-depth: 1`, a second writer, a fake market that serves the response shape of each source,
// and invariant checks for the files the collector writes. No network: every URL goes to the fake market.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

import type { IssueClient } from '../../src/alerts/index.ts';
import { runCollect } from '../../src/collect.ts';
import type { CollectDeps } from '../../src/collect.ts';
import { loadConfig } from '../../src/config.ts';
import { ADAPTERS } from '../../src/sources/index.ts';
import type {
	Config,
	HttpClient,
	HttpResult,
	SourceId,
} from '../../src/types.ts';

// The tests must not read or change the global or the system git config.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
delete process.env.GIT_DIR;
delete process.env.GIT_WORK_TREE;
delete process.env.GIT_INDEX_FILE;

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const REAL_CONFIG = join(REPO_ROOT, 'config', 'coins.json');

/**
 * The real config with publishing turned off, so the e2e tests do not depend on the
 * live `features.publish` switch. A test turns it on with its own patch.
 */
function readRealConfig(): Config {
	const raw = JSON.parse(readFileSync(REAL_CONFIG, 'utf8')) as Config;
	raw.settings.features.publish = false;
	return raw;
}

const roots: string[] = [];

/** Removes the temp directories of the worlds that this test file made. Call once per file. */
export function cleanUpWorlds(): void {
	after(() => {
		for (const root of roots) {
			rmSync(root, { recursive: true, force: true });
		}
	});
}

export function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

export function plusMinutes(iso: string, minutes: number): string {
	return `${new Date(Date.parse(iso) + minutes * 60_000).toISOString().slice(0, 19)}Z`;
}

// ---- The fake market ----

export type Fault =
	'timeout' | 'http_429' | 'http_500' | 'bad_json' | 'wrong_shape';

// The result keys of Kraken differ from the pair names (ADR 0002). The other pairs use the pair name.
const KRAKEN_KEYS: Record<string, string> = {
	XBTUSD: 'XXBTZUSD',
	ETHUSD: 'XETHZUSD',
	XRPUSD: 'XXRPZUSD',
	XLMUSD: 'XXLMZUSD',
	LTCUSD: 'XLTCZUSD',
	USDTUSD: 'USDTZUSD',
};

// Made-up base prices. Small coins get 8 decimals, so the byte-for-byte rule is tested on long strings.
const BASE_PRICE: Record<string, number> = {
	BTC: 100_000.5,
	ETH: 3_000.25,
	BNB: 600.1,
	XRP: 2.5,
	SOL: 150.75,
	DOGE: 0.12345678,
	LINK: 15.5,
	ADA: 0.45,
	XLM: 0.11,
	LTC: 80.2,
	USDT: 0.9988,
};

// Each source sits a little off the others, like real venues.
const OFFSET: Record<SourceId, number> = {
	kraken: 1,
	coinbase: 1.0003,
	bitstamp: 0.9998,
	coinmetrics: 1.0006,
};

export interface Clock {
	iso: string;
	/** Added to the clock before every HTTP call, so rows of one run get different times. */
	stepMs: number;
}

export interface Market {
	http: HttpClient;
	/** A fault for a whole source. */
	down: Map<SourceId, Fault>;
	/** Coin ids that a source leaves out of its answer. */
	missing: Map<SourceId, Set<string>>;
	/** A price string that replaces the normal one, by `source:COIN`. */
	override: Map<string, string>;
	/** The last price string served, by `source:COIN`. */
	served: Map<string, string>;
	/** Multiplies the price of a coin (to plant a sharp move). */
	scale: Map<string, number>;
	requests: Record<SourceId, number>;
	maxCoinbaseInFlight: number;
	/** Text that a hostile source puts into fields the collector must never copy. */
	hostile: string | null;
	/** Runs at the start of every HTTP call. */
	onRequest: ((source: SourceId) => Promise<void> | void) | null;
}

function format(value: number, decimals: number): string {
	return value.toFixed(decimals);
}

function normalPrice(
	source: SourceId,
	coin: string,
	scale: number,
	tick: number
): string {
	const base = BASE_PRICE[coin] ?? 10;
	const wobble = 1 + 0.0005 * Math.sin(tick * 0.7 + coin.length);
	const value = base * OFFSET[source] * wobble * scale;
	const decimals = base < 1 ? 8 : 2;
	switch (source) {
		case 'kraken':
			return format(value, decimals + 3);
		case 'coinbase':
			return format(value, decimals);
		case 'bitstamp':
			return format(value, decimals);
		case 'coinmetrics':
			return format(value, decimals + 6);
	}
}

function makeMarket(config: Config, clock: Clock): Market {
	let tick = 0;
	let coinbaseInFlight = 0;
	const market: Market = {
		down: new Map(),
		missing: new Map(),
		override: new Map(),
		served: new Map(),
		scale: new Map(),
		requests: { kraken: 0, coinbase: 0, bitstamp: 0, coinmetrics: 0 },
		maxCoinbaseInFlight: 0,
		hostile: null,
		onRequest: null,
		http: {
			async getJson(req): Promise<HttpResult> {
				const url = new URL(req.url);
				const source = sourceOf(url.hostname);
				if (clock.stepMs > 0) {
					clock.iso = `${new Date(Date.parse(clock.iso) + clock.stepMs).toISOString().slice(0, 19)}Z`;
				}
				market.requests[source] += 1;
				if (market.onRequest !== null) {
					await market.onRequest(source);
				}
				if (source === 'coinbase') {
					coinbaseInFlight += 1;
					market.maxCoinbaseInFlight = Math.max(
						market.maxCoinbaseInFlight,
						coinbaseInFlight
					);
					await new Promise((resolve) => setImmediate(resolve));
					coinbaseInFlight -= 1;
				}
				tick = Math.floor(Date.parse(clock.iso) / 900_000);
				return serve(url, source);
			},
		},
	};

	function sourceOf(host: string): SourceId {
		switch (host) {
			case 'api.kraken.com':
				return 'kraken';
			case 'api.exchange.coinbase.com':
				return 'coinbase';
			case 'www.bitstamp.net':
				return 'bitstamp';
			case 'community-api.coinmetrics.io':
				return 'coinmetrics';
			default:
				throw new Error(`A test tried to reach the network: ${host}`);
		}
	}

	function price(source: SourceId, coin: string): string {
		const key = `${source}:${coin}`;
		const text =
			market.override.get(key) ??
			normalPrice(source, coin, market.scale.get(coin) ?? 1, tick);
		market.served.set(key, text);
		return text;
	}

	function left(source: SourceId, coin: string): boolean {
		return market.missing.get(source)?.has(coin) ?? false;
	}

	function fault(source: SourceId): HttpResult | null {
		switch (market.down.get(source)) {
			case undefined:
				return null;
			case 'timeout':
				return { status: 0, ms: 5, error: 'timeout' };
			case 'http_429':
				return { status: 429, ms: 5, error: 'http_429' };
			case 'http_500':
				return { status: 500, ms: 5, error: 'http_other' };
			case 'bad_json':
				return { status: 200, ms: 5, error: 'parse' };
			case 'wrong_shape':
				return { status: 200, ms: 5, json: { unexpected: true } };
		}
	}

	function serve(url: URL, source: SourceId): HttpResult {
		const failed = fault(source);
		if (failed !== null) {
			return failed;
		}
		const nowMs = Date.parse(clock.iso);
		const hostile = market.hostile;
		const coins = config.coins.filter((coin) => coin.enabled);
		switch (source) {
			case 'kraken': {
				const result: Record<string, unknown> = {};
				const isCatalogue = url.pathname.endsWith('/AssetPairs');
				for (const coin of coins) {
					const pair = coin.sources.kraken_pair ?? '';
					const key = KRAKEN_KEYS[pair] ?? pair;
					if (isCatalogue) {
						result[key] = {
							altname: pair,
							wsname: `${pair.replace(/USD$/, '')}/USD`,
							status: 'online',
						};
					} else if (!left('kraken', coin.id)) {
						result[key] = {
							c: [price('kraken', coin.id), '1.5'],
							note: hostile,
						};
					}
				}
				return {
					status: 200,
					ms: 7,
					json: {
						error: [],
						result,
					},
				};
			}
			case 'coinbase': {
				const product = decodeURIComponent(
					url.pathname.split('/')[2] ?? ''
				);
				const coin = coins.find(
					(item) => item.sources.coinbase_product === product
				);
				if (coin === undefined || left('coinbase', coin.id)) {
					return { status: 404, ms: 7, error: 'http_other' };
				}
				return {
					status: 200,
					ms: 7,
					json: {
						price: price('coinbase', coin.id),
						time: new Date(nowMs - 2000).toISOString(),
						message: hostile,
					},
				};
			}
			case 'bitstamp':
				return {
					status: 200,
					ms: 7,
					json: coins
						.filter((coin) => !left('bitstamp', coin.id))
						.map((coin) => ({
							pair: `${coin.id}/USD`,
							last: price('bitstamp', coin.id),
							timestamp: String(Math.floor(nowMs / 1000) - 3),
							description: hostile,
						})),
				};
			case 'coinmetrics':
				return {
					status: 200,
					ms: 7,
					json: {
						data: coins
							.filter((coin) => !left('coinmetrics', coin.id))
							.map((coin) => ({
								asset: coin.sources.coinmetrics_asset,
								time: `${new Date(nowMs - 60_000).toISOString().slice(0, 19)}.000000000Z`,
								ReferenceRateUSD: price('coinmetrics', coin.id),
							})),
						error: hostile,
					},
				};
		}
	}

	return market;
}

// ---- A fake Issue client ----

export interface FakeIssues {
	client: IssueClient;
	created: Array<{
		title: string;
		body: string;
		labels: string[];
		assignees: string[];
	}>;
	comments: Array<{ issue: number; body: string }>;
	closed: number[];
	calls: number;
}

function makeIssues(): FakeIssues {
	const open: Array<{ number: number; title: string; labels: string[] }> = [];
	let next = 1;
	const fake: FakeIssues = {
		created: [],
		comments: [],
		closed: [],
		calls: 0,
		client: {
			listOpenIssues(labels) {
				fake.calls += 1;
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
				fake.calls += 1;
				const number = next;
				next += 1;
				open.push({ number, title: issue.title, labels: issue.labels });
				fake.created.push({
					title: issue.title,
					body: issue.body,
					labels: issue.labels,
					assignees: issue.assignees,
				});
				return Promise.resolve(number);
			},
			addComment(issue, body) {
				fake.calls += 1;
				fake.comments.push({ issue, body });
				return Promise.resolve();
			},
			closeIssue(issue) {
				fake.calls += 1;
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

// ---- The world: remotes, shallow checkouts, a second writer, a clock and a market ----

export interface World {
	root: string;
	dataRemote: string;
	mainRemote: string;
	/** Shallow checkout of `data` (depth 1), like the workflow makes. */
	data: string;
	/** Shallow checkout of `main` (depth 1). */
	code: string;
	/** A full clone of `data` for a second writer. */
	other: string;
	configPath: string;
	config: Config;
	clock: Clock;
	market: Market;
	logs: string[];
	issues: FakeIssues;
}

export interface WorldOptions {
	patch?: (config: Config) => void;
	/** Set a local git identity in the checkouts. Default true. The collector must not need it. */
	identity?: boolean;
	/** The commit date of the seed commit on `main`. */
	mainDate?: string;
}

export const T0 = '2026-10-29T10:03:12Z';

function gitAt(cwd: string, date: string | null, ...args: string[]): string {
	const env = { ...process.env };
	if (date !== null) {
		env.GIT_AUTHOR_DATE = date;
		env.GIT_COMMITTER_DATE = date;
	}
	return execFileSync('git', args, {
		cwd,
		env,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

function seedRemote(
	root: string,
	name: string,
	branch: string,
	files: Record<string, string>,
	date: string | null
): string {
	const remote = join(root, `${name}.git`);
	const seed = join(root, `${name}-seed`);
	git(
		root,
		'init',
		'--quiet',
		'--bare',
		`--initial-branch=${branch}`,
		remote
	);
	git(root, 'init', '--quiet', `--initial-branch=${branch}`, seed);
	git(seed, 'config', 'user.name', 'Seed');
	git(seed, 'config', 'user.email', 'seed@example.test');
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(join(seed, file, '..'), { recursive: true });
		writeFileSync(join(seed, file), text);
	}
	git(seed, 'add', '-A');
	gitAt(seed, date, 'commit', '--quiet', '-m', 'Seed');
	git(seed, 'push', '--quiet', remote, branch);
	return remote;
}

function shallowClone(
	root: string,
	remote: string,
	branch: string,
	dir: string,
	identity: boolean
): void {
	// A file URL, because a plain path ignores --depth. Same shape as `actions/checkout` with fetch-depth 1.
	git(
		root,
		'clone',
		'--quiet',
		'--depth',
		'1',
		'--single-branch',
		'--branch',
		branch,
		`file://${remote}`,
		dir
	);
	if (identity) {
		git(dir, 'config', 'user.name', 'Runner');
		git(dir, 'config', 'user.email', 'runner@example.test');
	}
}

export async function makeWorld(opts: WorldOptions = {}): Promise<World> {
	const root = mkdtempSync(join(tmpdir(), 'git-coin-e2e-'));
	roots.push(root);
	const identity = opts.identity ?? true;

	const dataRemote = seedRemote(
		root,
		'data',
		'data',
		{ 'README.md': 'The data branch.\n' },
		null
	);
	const mainRemote = seedRemote(
		root,
		'main',
		'main',
		{
			'README.md': 'The code branch.\n',
			'config/coins.json': JSON.stringify(readRealConfig(), null, '\t'),
		},
		opts.mainDate ?? null
	);
	const data = join(root, 'ws', 'data');
	const code = join(root, 'ws', 'code');
	const other = join(root, 'other');
	shallowClone(root, dataRemote, 'data', data, identity);
	shallowClone(root, mainRemote, 'main', code, identity);
	git(root, 'clone', '--quiet', `file://${dataRemote}`, other);
	git(other, 'config', 'user.name', 'Owner');
	git(other, 'config', 'user.email', 'owner@example.test');

	const raw = readRealConfig();
	opts.patch?.(raw);
	const configPath = join(root, 'config.json');
	writeFileSync(configPath, JSON.stringify(raw, null, '\t'));
	const config = await loadConfig(configPath);
	const clock: Clock = { iso: T0, stepMs: 0 };
	return {
		root,
		dataRemote,
		mainRemote,
		data,
		code,
		other,
		configPath,
		config,
		clock,
		market: makeMarket(config, clock),
		logs: [],
		issues: makeIssues(),
	};
}

export function depsOf(
	world: World,
	extra: Partial<CollectDeps> = {}
): CollectDeps {
	return {
		config: world.config,
		now: () => new Date(world.clock.iso),
		http: world.market.http,
		adapters: ADAPTERS,
		dataRoot: world.data,
		git: { repoDir: world.data, branch: 'data' },
		issueClient: null,
		dryRun: false,
		dashboardUrl: 'https://example.test/git-coin/',
		keepalive: null,
		log: (line) => {
			world.logs.push(line);
		},
		...extra,
	};
}

/** Sets the clock and runs the collector once. */
export function runAt(
	world: World,
	iso: string,
	extra: Partial<CollectDeps> = {}
): ReturnType<typeof runCollect> {
	world.clock.iso = iso;
	return runCollect(depsOf(world, extra));
}

// ---- Reading the remote and the checkouts ----

export function remoteTip(remote: string, branch: string): string {
	return git(remote, 'rev-parse', `refs/heads/${branch}`);
}

export function remoteCount(remote: string, branch: string): number {
	return Number(git(remote, 'rev-list', '--count', `refs/heads/${branch}`));
}

export function remoteShow(
	remote: string,
	branch: string,
	path: string
): string {
	return execFileSync('git', ['show', `refs/heads/${branch}:${path}`], {
		cwd: remote,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

export function remoteFiles(remote: string, branch: string): string[] {
	return git(remote, 'ls-tree', '-r', '--name-only', `refs/heads/${branch}`)
		.split('\n')
		.filter((line) => line !== '');
}

/** Subject, author name and author email of the commits of a branch, newest first. */
export function remoteLog(
	remote: string,
	branch: string
): Array<{ subject: string; name: string; email: string }> {
	return git(
		remote,
		'log',
		'--format=%s%x09%an%x09%ae',
		`refs/heads/${branch}`
	)
		.split('\n')
		.map((line) => {
			const [subject = '', name = '', email = ''] = line.split('\t');
			return { subject, name, email };
		});
}

/** The checkout is clean, shallow, and at the tip of the remote: nothing is left behind. */
export function assertInSync(
	checkout: string,
	remote: string,
	branch: string
): void {
	assert.equal(
		git(checkout, 'status', '--porcelain'),
		'',
		'the checkout is clean'
	);
	assert.equal(git(checkout, 'rev-parse', 'HEAD'), remoteTip(remote, branch));
	assert.equal(git(checkout, 'rev-parse', '--is-shallow-repository'), 'true');
}

/** A second writer pushes a commit to `data` (for example the owner, or another run). */
export function otherCommit(
	world: World,
	message: string,
	mutate: (dir: string) => void
): void {
	git(world.other, 'fetch', '--quiet', 'origin', 'data');
	git(world.other, 'reset', '--hard', '--quiet', 'origin/data');
	mutate(world.other);
	git(world.other, 'add', '-A');
	git(world.other, 'commit', '--quiet', '-m', message);
	git(world.other, 'push', '--quiet', 'origin', 'HEAD:refs/heads/data');
}

/**
 * Makes the remote reject pushes with a pre-receive hook: the first `skip` pushes pass, the next `count`
 * pushes fail, later ones pass again. The hook counts in a file inside the repository.
 */
export function rejectPushes(remote: string, count: number, skip = 0): void {
	const counter = join(remote, 'push-count');
	writeFileSync(counter, '0');
	const hook = join(remote, 'hooks', 'pre-receive');
	writeFileSync(
		hook,
		`#!/bin/sh\nn=$(cat "${counter}")\necho $((n + 1)) > "${counter}"\nif [ "$n" -ge ${skip} ] && [ "$n" -lt ${skip + count} ]; then\n  echo "rejected for the test" >&2\n  exit 1\nfi\nexit 0\n`
	);
	chmodSync(hook, 0o755);
}

// ---- Parsing and invariants ----

export interface Row {
	ts: string;
	price: string;
	src: string;
	age: string;
	file: string;
}

const HEADER = 'ts,price,src,age_s';
const LOG_HEADER = 'ts,src,http,ms,coins_ok,error';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ERRORS = new Set([
	'',
	'timeout',
	'http_429',
	'http_other',
	'parse',
	'unmapped',
]);

function listFiles(dir: string, prefix = ''): string[] {
	const found: string[] = [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const entry of entries) {
		if (entry.name === '.git') {
			continue;
		}
		const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) {
			found.push(...listFiles(join(dir, entry.name), relative));
		} else {
			found.push(relative);
		}
	}
	return found.sort();
}

/** The price files of a checkout: `data/raw/YYYY/MM/DD/<COIN>.csv`, as lines (header included). */
export function readPriceFiles(checkout: string): Map<string, string[]> {
	const files = new Map<string, string[]>();
	for (const relative of listFiles(join(checkout, 'data', 'raw'))) {
		const text = readFileSync(
			join(checkout, 'data', 'raw', relative),
			'utf8'
		);
		files.set(relative, text.split('\n'));
	}
	return files;
}

export function readLogLines(checkout: string): Map<string, string[]> {
	const files = new Map<string, string[]>();
	for (const relative of listFiles(join(checkout, 'data', 'meta'))) {
		const text = readFileSync(
			join(checkout, 'data', 'meta', relative),
			'utf8'
		);
		files.set(relative, text.split('\n'));
	}
	return files;
}

export function rowsOf(checkout: string, coin: string): Row[] {
	const rows: Row[] = [];
	for (const [relative, lines] of readPriceFiles(checkout)) {
		if (!relative.endsWith(`/${coin}.csv`)) {
			continue;
		}
		for (const line of lines.slice(1)) {
			if (line === '') {
				continue;
			}
			const [ts = '', price = '', src = '', age = ''] = line.split(',');
			rows.push({ ts, price, src, age, file: relative });
		}
	}
	return rows;
}

/**
 * The rules of ADR 0004 for every file the collector wrote: one header per file, four fields per line,
 * the day of the file is the day of `ts`, and per coin and `src` the times grow by at least the spacing.
 * The request log has one header per file and only known error codes.
 */
export function assertFileInvariants(
	checkout: string,
	spacingSeconds: number
): void {
	const last = new Map<string, number>();
	for (const [relative, lines] of readPriceFiles(checkout)) {
		assert.equal(lines[0], HEADER, `${relative}: header`);
		assert.equal(lines.at(-1), '', `${relative}: ends with a line break`);
		assert.equal(
			lines.filter((line) => line === HEADER).length,
			1,
			`${relative}: one header`
		);
		const [year, month, day, name] = relative.split('/');
		const coin = (name ?? '').replace(/\.csv$/, '');
		for (const line of lines.slice(1, -1)) {
			const fields = line.split(',');
			assert.equal(
				fields.length,
				4,
				`${relative}: four fields in "${line}"`
			);
			const [ts = '', price = '', src = ''] = fields;
			assert.match(ts, ISO, `${relative}: ts`);
			assert.equal(
				ts.slice(0, 10),
				`${year}-${month}-${day}`,
				`${relative}: day of ts`
			);
			assert.match(price, /^\d+(\.\d+)?$/, `${relative}: price text`);
			const key = `${coin}|${src}`;
			const before = last.get(key);
			const now = Date.parse(ts);
			if (before !== undefined) {
				assert.ok(
					now - before >= spacingSeconds * 1000,
					`${relative}: ${key} grows by the spacing (${ts})`
				);
			}
			last.set(key, now);
		}
	}
	for (const [relative, lines] of readLogLines(checkout)) {
		assert.equal(lines[0], LOG_HEADER, `${relative}: log header`);
		assert.equal(lines.filter((line) => line === LOG_HEADER).length, 1);
		const [year, month, day] = relative.split('/');
		for (const line of lines.slice(1, -1)) {
			const fields = line.split(',');
			assert.equal(
				fields.length,
				6,
				`${relative}: log fields in "${line}"`
			);
			assert.match(fields[0] ?? '', ISO);
			assert.equal(
				(fields[0] ?? '').slice(0, 10),
				`${year}-${month}-${day}`,
				`${relative}: day of the log row`
			);
			assert.ok(
				ERRORS.has(fields[5] ?? ''),
				`${relative}: error code in "${line}"`
			);
		}
	}
}

export function readStatus(checkout: string): {
	last_run_at: string | null;
	last_point_at: string | null;
	consecutive_failures: number;
	sources: Record<
		string,
		{
			requests: number;
			failures: number;
			failures_by_error: Record<string, number>;
			consecutive_failures: number;
			last_ok_at: string | null;
		}
	>;
	coins: Record<
		string,
		{
			status: string;
			rejected_count: number;
			last_reject_reason: string | null;
		}
	>;
} {
	return JSON.parse(
		readFileSync(join(checkout, 'state', 'status.json'), 'utf8')
	);
}
