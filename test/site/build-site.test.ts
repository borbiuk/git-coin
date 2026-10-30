import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { buildSite } from '../../src/build-site.ts';
import { loadConfig } from '../../src/config.ts';
import type { Config } from '../../src/types.ts';

import {
	FIXTURES,
	copyState,
	epoch,
	makeTempDir,
	removeDir,
	writeDay,
} from './tree.ts';

const NOW = new Date('2026-10-29T12:00:00Z');
const CONFIG_PATH = join(FIXTURES, 'config.json');
const BUILD_SITE = join(
	import.meta.dirname,
	'..',
	'..',
	'src',
	'build-site.ts'
);

let root = '';
let out = '';

beforeEach(async () => {
	root = await makeTempDir();
	out = join(root, 'out');
});

afterEach(async () => {
	await removeDir(root);
});

async function loadFixtureConfig(): Promise<Config> {
	return loadConfig(CONFIG_PATH);
}

async function readOut<T>(name: string): Promise<T> {
	return JSON.parse(await readFile(join(out, name), 'utf8')) as T;
}

/** A small tree: BTC with rows of two sources, an archived DOGE, and nothing for ETH and XRP. */
async function writeSampleTree(): Promise<void> {
	await writeDay(root, 'BTC', '2026-10-20', [
		'2026-10-20T00:00:00Z,100,kr,',
		'2026-10-20T12:00:00Z,105,kr,',
	]);
	await writeDay(root, 'BTC', '2026-10-28', [
		'2026-10-28T12:00:00Z,200,kr,',
		'2026-10-28T12:00:01Z,7777,cb,1',
		'2026-10-28T23:50:00Z,210,kr,',
	]);
	await writeDay(root, 'BTC', '2026-10-29', [
		'2026-10-29T00:10:00Z,220,kr,',
		'2026-10-29T00:40:00Z,230,kr,',
		'2026-10-29T11:45:00Z,250,kr,',
		'2026-10-29T12:00:00Z,240.50,kr,',
		'2026-10-29T12:00:01Z,9999,kr,',
	]);
	await writeDay(root, 'DOGE', '2026-09-01', [
		'2026-09-01T00:00:00Z,0.00001234,kr,',
	]);
}

test('buildSite writes the files of the contract for the sample tree', async () => {
	await writeSampleTree();
	await copyState(root, 'status.json', 'status.json');
	await buildSite({
		dataRoot: root,
		config: await loadFixtureConfig(),
		outDir: out,
		now: NOW,
	});
	assert.deepEqual((await readdir(out)).sort(), [
		'alerts.json',
		'coins',
		'latest.json',
		'status.json',
	]);
	// DOGE is archived (it has rows), ETH is enabled and empty, XRP is disabled and empty
	assert.deepEqual((await readdir(join(out, 'coins'))).sort(), [
		'BTC.7d.json',
		'BTC.90d.json',
		'BTC.daily.json',
		'BTC.sources.json',
		'DOGE.7d.json',
		'DOGE.90d.json',
		'DOGE.daily.json',
		'DOGE.sources.json',
		'ETH.7d.json',
		'ETH.90d.json',
		'ETH.daily.json',
		'ETH.sources.json',
	]);
});

test('latest.json uses the primary source, numbers and the period stats', async () => {
	await writeSampleTree();
	await buildSite({
		dataRoot: root,
		config: await loadFixtureConfig(),
		outDir: out,
		now: NOW,
	});
	const latest = await readOut<Record<string, unknown>>('latest.json');
	assert.deepEqual(latest, {
		generated_at: '2026-10-29T12:00:00Z',
		quote: 'USD',
		src: 'kr',
		coins: {
			BTC: {
				name: 'Bitcoin',
				price: 240.5,
				ts: '2026-10-29T12:00:00Z',
				periods: {
					'24h': { change_pct: 20.25, high: 250, low: 200 },
					'7d': { change_pct: null, high: 250, low: 200 },
					'30d': { change_pct: null, high: 250, low: 100 },
				},
			},
			DOGE: {
				name: 'Dogecoin',
				price: 0.00001234,
				ts: '2026-09-01T00:00:00Z',
				periods: {
					'24h': { change_pct: null, high: null, low: null },
					'7d': { change_pct: null, high: null, low: null },
					'30d': { change_pct: null, high: null, low: null },
				},
			},
		},
	});
});

test('the 7 day file is at full resolution and ignores rows after now and other sources', async () => {
	await writeSampleTree();
	await buildSite({
		dataRoot: root,
		config: await loadFixtureConfig(),
		outDir: out,
		now: NOW,
	});
	const week = await readOut<unknown>('coins/BTC.7d.json');
	assert.deepEqual(week, {
		coin: 'BTC',
		src: 'kr',
		t: [
			'2026-10-28T12:00:00Z',
			'2026-10-28T23:50:00Z',
			'2026-10-29T00:10:00Z',
			'2026-10-29T00:40:00Z',
			'2026-10-29T11:45:00Z',
			'2026-10-29T12:00:00Z',
		].map(epoch),
		p: [200, 210, 220, 230, 250, 240.5],
	});
});

test('the sources file holds the last 7 days of each stored source and leaves out a source with no rows', async () => {
	await writeSampleTree();
	await buildSite({
		dataRoot: root,
		config: await loadFixtureConfig(),
		outDir: out,
		now: NOW,
	});
	assert.deepEqual(await readOut<unknown>('coins/BTC.sources.json'), {
		coin: 'BTC',
		sources: [
			{
				src: 'kr',
				t: [
					'2026-10-28T12:00:00Z',
					'2026-10-28T23:50:00Z',
					'2026-10-29T00:10:00Z',
					'2026-10-29T00:40:00Z',
					'2026-10-29T11:45:00Z',
					'2026-10-29T12:00:00Z',
				].map(epoch),
				p: [200, 210, 220, 230, 250, 240.5],
			},
			{
				src: 'cb',
				t: [epoch('2026-10-28T12:00:01Z')],
				p: [7777],
			},
		],
	});
	assert.deepEqual(await readOut<unknown>('coins/ETH.sources.json'), {
		coin: 'ETH',
		sources: [],
	});
});

test('the sources file is not written while only one source is stored', async () => {
	await writeSampleTree();
	const config = await loadFixtureConfig();
	await buildSite({
		dataRoot: root,
		config: {
			...config,
			settings: { ...config.settings, stored_sources: ['kraken'] },
		},
		outDir: out,
		now: NOW,
	});
	const files = await readdir(join(out, 'coins'));
	assert.equal(
		files.some((name) => name.endsWith('.sources.json')),
		false
	);
});

test('the 90 day file has one last-price point per hour and keeps the gaps', async () => {
	await writeSampleTree();
	await buildSite({
		dataRoot: root,
		config: await loadFixtureConfig(),
		outDir: out,
		now: NOW,
	});
	const ninety = await readOut<unknown>('coins/BTC.90d.json');
	assert.deepEqual(ninety, {
		coin: 'BTC',
		src: 'kr',
		t: [
			'2026-10-20T00:00:00Z',
			'2026-10-20T12:00:00Z',
			'2026-10-28T12:00:00Z',
			'2026-10-28T23:50:00Z',
			'2026-10-29T00:40:00Z',
			'2026-10-29T11:45:00Z',
			'2026-10-29T12:00:00Z',
		].map(epoch),
		p: [100, 105, 200, 210, 230, 250, 240.5],
	});
});

test('the daily file has OHLC on UTC days for all history', async () => {
	await writeSampleTree();
	await buildSite({
		dataRoot: root,
		config: await loadFixtureConfig(),
		outDir: out,
		now: NOW,
	});
	assert.deepEqual(await readOut<unknown>('coins/BTC.daily.json'), {
		coin: 'BTC',
		src: 'kr',
		t: ['2026-10-20', '2026-10-28', '2026-10-29'].map((day) =>
			epoch(`${day}T00:00:00Z`)
		),
		o: [100, 200, 220],
		h: [105, 210, 250],
		l: [100, 200, 220],
		c: [105, 210, 240.5],
	});
});

test('an archived coin keeps its history but has no recent points', async () => {
	await writeSampleTree();
	await buildSite({
		dataRoot: root,
		config: await loadFixtureConfig(),
		outDir: out,
		now: NOW,
	});
	const doge = await readOut<{ t: number[]; o: number[] }>(
		'coins/DOGE.daily.json'
	);
	assert.deepEqual(doge.t, [epoch('2026-09-01T00:00:00Z')]);
	assert.deepEqual(doge.o, [0.00001234]);
	assert.deepEqual(await readOut<unknown>('coins/DOGE.7d.json'), {
		coin: 'DOGE',
		src: 'kr',
		t: [],
		p: [],
	});
});

test('an enabled coin with no rows gets empty series and no latest entry', async () => {
	await writeSampleTree();
	await buildSite({
		dataRoot: root,
		config: await loadFixtureConfig(),
		outDir: out,
		now: NOW,
	});
	assert.deepEqual(await readOut<unknown>('coins/ETH.daily.json'), {
		coin: 'ETH',
		src: 'kr',
		t: [],
		o: [],
		h: [],
		l: [],
		c: [],
	});
	const latest = await readOut<{ coins: Record<string, unknown> }>(
		'latest.json'
	);
	assert.equal('ETH' in latest.coins, false);
});

test('buildSite handles an empty data root', async () => {
	await buildSite({
		dataRoot: root,
		config: await loadFixtureConfig(),
		outDir: out,
		now: NOW,
	});
	assert.deepEqual(await readOut<unknown>('latest.json'), {
		generated_at: '2026-10-29T12:00:00Z',
		quote: 'USD',
		src: 'kr',
		coins: {},
	});
	assert.deepEqual(await readOut<unknown>('alerts.json'), {
		generated_at: '2026-10-29T12:00:00Z',
		alerts: [],
	});
	assert.deepEqual(await readOut<unknown>('status.json'), {
		schema_version: 1,
		phase: 'test',
		last_run_at: null,
		last_point_at: null,
		consecutive_failures: 0,
		last_publish_at: null,
		sources: {},
		coins: {},
		generated_at: '2026-10-29T12:00:00Z',
	});
	assert.deepEqual((await readdir(join(out, 'coins'))).sort(), [
		'BTC.7d.json',
		'BTC.90d.json',
		'BTC.daily.json',
		'BTC.sources.json',
		'ETH.7d.json',
		'ETH.90d.json',
		'ETH.daily.json',
		'ETH.sources.json',
	]);
});

test('status.json is the state file plus generated_at', async () => {
	await copyState(root, 'status.json', 'status.json');
	await buildSite({
		dataRoot: root,
		config: await loadFixtureConfig(),
		outDir: out,
		now: NOW,
	});
	const original = JSON.parse(
		await readFile(join(FIXTURES, 'status.json'), 'utf8')
	) as object;
	assert.deepEqual(await readOut<unknown>('status.json'), {
		...original,
		generated_at: '2026-10-29T12:00:00Z',
	});
});

test('a status file that is not valid JSON falls back to the empty status', async () => {
	await copyState(root, 'status.json', 'status.json');
	await writeFile(join(root, 'state', 'status.json'), '{ broken');
	await buildSite({
		dataRoot: root,
		config: await loadFixtureConfig(),
		outDir: out,
		now: NOW,
	});
	const status = await readOut<{ last_point_at: unknown; phase: string }>(
		'status.json'
	);
	assert.equal(status.last_point_at, null);
	assert.equal(status.phase, 'test');
});

test('alerts.json lists the 10 newest alerts and drops invalid entries', async () => {
	await copyState(root, 'alerts-state.json', 'alerts.json');
	await buildSite({
		dataRoot: root,
		config: await loadFixtureConfig(),
		outDir: out,
		now: NOW,
	});
	const alerts = await readOut<{
		alerts: Array<{ issue: number; severity: string }>;
	}>('alerts.json');
	assert.deepEqual(
		alerts.alerts.map((alert) => alert.issue),
		[13, 12, 11, 10, 9, 8, 7, 6, 5, 2]
	);
	assert.equal(alerts.alerts[9].severity, 'extreme');
	assert.equal(alerts.alerts[0].severity, 'high');
});

test('alerts.json skips suppressed alerts and alerts without an Issue', async () => {
	await copyState(root, 'alerts-state.json', 'alerts.json');
	await buildSite({
		dataRoot: root,
		config: await loadFixtureConfig(),
		outDir: out,
		now: NOW,
	});
	const { alerts } = await readOut<{ alerts: Array<{ issue: number }> }>(
		'alerts.json'
	);
	// Left out: the suppressed BTC alert, the SOL alert without an Issue and Issue 14 (a direction that does not exist)
	assert.deepEqual(
		alerts.map((alert) => alert.issue),
		[13, 12, 11, 10, 9, 8, 7, 6, 5, 2]
	);
});

test('alerts.json maps warning to high and critical to extreme', async () => {
	await copyState(root, 'alerts-state.json', 'alerts.json');
	await buildSite({
		dataRoot: root,
		config: await loadFixtureConfig(),
		outDir: out,
		now: NOW,
	});
	const { alerts } = await readOut<{ alerts: unknown[] }>('alerts.json');
	assert.deepEqual(alerts[0], {
		coin: 'ETH',
		ts: '2026-10-28T13:00:00Z',
		direction: 'down',
		severity: 'high',
		issue: 13,
	});
	assert.deepEqual(alerts[1], {
		coin: 'XRP',
		ts: '2026-10-28T12:00:00Z',
		direction: 'down',
		severity: 'extreme',
		issue: 12,
	});
});

test('alerts.json is empty for a state file with the wrong shape or bad JSON', async () => {
	for (const text of [
		'{ broken',
		'{"schema_version":2,"recent":[]}',
		'{"schema_version":1}',
		'[]',
	]) {
		await mkdir(join(root, 'state'), { recursive: true });
		await writeFile(join(root, 'state', 'alerts.json'), text);
		await buildSite({
			dataRoot: root,
			config: await loadFixtureConfig(),
			outDir: out,
			now: NOW,
		});
		assert.deepEqual(
			(await readOut<{ alerts: unknown[] }>('alerts.json')).alerts,
			[],
			text
		);
	}
});

test('latest.json lists the coins in the order of the config', async () => {
	await writeSampleTree();
	await writeDay(root, 'ETH', '2026-10-29', [
		'2026-10-29T11:00:00Z,3000,kr,',
	]);
	const config = await loadFixtureConfig();
	// Config order: DOGE (archived), ETH, BTC, XRP (disabled, no rows)
	const byId = new Map(config.coins.map((coin) => [coin.id, coin]));
	config.coins = ['DOGE', 'ETH', 'BTC', 'XRP'].map(
		(id) => byId.get(id) as (typeof config.coins)[number]
	);
	await buildSite({ dataRoot: root, config, outDir: out, now: NOW });
	const latest = await readOut<{ coins: Record<string, unknown> }>(
		'latest.json'
	);
	assert.deepEqual(Object.keys(latest.coins), ['DOGE', 'ETH', 'BTC']);
});

test('the output is the same for the same input and the same now', async () => {
	await writeSampleTree();
	await copyState(root, 'status.json', 'status.json');
	await copyState(root, 'alerts-state.json', 'alerts.json');
	const config = await loadFixtureConfig();
	const second = join(root, 'out2');
	await buildSite({ dataRoot: root, config, outDir: out, now: NOW });
	await buildSite({ dataRoot: root, config, outDir: second, now: NOW });
	const names = ['latest.json', 'status.json', 'alerts.json'];
	for (const coin of ['BTC', 'DOGE', 'ETH']) {
		for (const range of ['7d', '90d', 'daily']) {
			names.push(`coins/${coin}.${range}.json`);
		}
	}
	for (const name of names) {
		assert.equal(
			await readFile(join(out, name), 'utf8'),
			await readFile(join(second, name), 'utf8'),
			name
		);
	}
});

test('a later now moves the windows', async () => {
	await writeSampleTree();
	await buildSite({
		dataRoot: root,
		config: await loadFixtureConfig(),
		outDir: out,
		now: new Date('2026-10-30T12:00:00Z'),
	});
	const latest = await readOut<{
		generated_at: string;
		coins: Record<
			string,
			{ price: number; periods: Record<string, { low: number }> }
		>;
	}>('latest.json');
	assert.equal(latest.generated_at, '2026-10-30T12:00:00Z');
	// The row of 12:00:01 on the 29th is now in the past, so it is the last price
	assert.equal(latest.coins.BTC.price, 9999);
	// The 24 hour window starts at 12:00:00 on the 29th: only the last two rows are inside
	assert.equal(latest.coins.BTC.periods['24h'].low, 240.5);
	const week = await readOut<{ t: number[] }>('coins/BTC.7d.json');
	assert.equal(week.t.length, 7);
});

test('buildSite refuses a coin id that is not safe for a file name', async () => {
	const config = await loadFixtureConfig();
	config.coins[0].id = '../evil';
	await assert.rejects(
		buildSite({ dataRoot: root, config, outDir: out, now: NOW }),
		/not safe/
	);
});

test('buildSite refuses a config with no stored source', async () => {
	const config = await loadFixtureConfig();
	config.settings.stored_sources = [];
	await assert.rejects(
		buildSite({ dataRoot: root, config, outDir: out, now: NOW }),
		/stored_sources/
	);
});

test('the CLI builds the site from the arguments', async () => {
	await writeSampleTree();
	const result = spawnSync(
		process.execPath,
		[
			BUILD_SITE,
			'--config',
			CONFIG_PATH,
			'--data-root',
			root,
			'--out',
			out,
			'--now',
			'2026-10-29T12:00:00Z',
		],
		{ encoding: 'utf8' }
	);
	assert.equal(result.status, 0, result.stderr);
	const latest = await readOut<{ coins: Record<string, { price: number }> }>(
		'latest.json'
	);
	assert.equal(latest.coins.BTC.price, 240.5);
});

test('the CLI exits with 1 and a message on a missing argument or a bad config', async () => {
	const missing = spawnSync(process.execPath, [BUILD_SITE, '--out', out], {
		encoding: 'utf8',
	});
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /Usage/);

	const badConfig = join(root, 'bad.json');
	await writeFile(badConfig, '{"settings":{"stored_sources":[]},"coins":[]}');
	const bad = spawnSync(
		process.execPath,
		[BUILD_SITE, '--config', badConfig, '--data-root', root, '--out', out],
		{ encoding: 'utf8' }
	);
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /config/i);
});

test('an enabled rate entry converts the prices, is not shown, and a disabled one leaves USD', async () => {
	await writeDay(root, 'BTC', '2026-10-28', [
		'2026-10-28T12:00:00Z,200,kr,',
		'2026-10-28T12:00:01Z,100,cb,1',
		'2026-10-28T13:00:00Z,300,kr,',
	]);
	await writeDay(root, 'USDT', '2026-10-28', [
		'2026-10-28T12:00:00Z,0.5,kr,',
		'2026-10-28T13:00:00Z,0.75,kr,',
	]);
	const config = await loadFixtureConfig();
	config.coins.push({
		id: 'USDT',
		name: 'Tether',
		role: 'rate',
		enabled: true,
		added: '2026-10-28',
		sources: { kraken_pair: 'USDTUSD' },
		alerts: { enabled: false },
	});
	await buildSite({ dataRoot: root, config, outDir: out, now: NOW });
	const latest = await readOut<{
		quote: string;
		coins: Record<string, { price: number }>;
	}>('latest.json');
	assert.equal(latest.quote, 'USDT');
	// No backfilled rows in this tree: no history field
	assert.equal('history' in latest, false);
	assert.equal(latest.coins.BTC?.price, 400);
	assert.equal(latest.coins.USDT, undefined);
	assert.deepEqual(await readOut('coins/BTC.7d.json'), {
		coin: 'BTC',
		src: 'kr',
		t: [epoch('2026-10-28T12:00:00Z'), epoch('2026-10-28T13:00:00Z')],
		p: [400, 400],
	});
	assert.ok(
		!(await readdir(join(out, 'coins'))).some((name) =>
			name.startsWith('USDT')
		)
	);
	// The source comparison is converted with the same rate
	const sources = await readOut<{
		sources: Array<{ src: string; p: number[] }>;
	}>('coins/BTC.sources.json');
	assert.deepEqual(
		sources.sources.map((item) => [item.src, item.p]),
		[
			['kr', [400, 400]],
			['cb', [200]],
		]
	);

	const off = join(root, 'out-usd');
	for (const coin of config.coins) {
		if (coin.role === 'rate') {
			coin.enabled = false;
		}
	}
	await buildSite({ dataRoot: root, config, outDir: off, now: NOW });
	const usd = JSON.parse(
		await readFile(join(off, 'latest.json'), 'utf8')
	) as {
		quote: string;
		coins: Record<string, { price: number }>;
	};
	assert.equal(usd.quote, 'USD');
	assert.equal(usd.coins.BTC?.price, 300);
});

test('backfilled rows fill the time before the first live row, are converted, and the page is told', async () => {
	await writeDay(root, 'BTC', '2026-10-27', [
		'2026-10-27T12:15:00Z,100,bs-ohlc,',
		'2026-10-27T12:30:00Z,110,bs-ohlc,',
	]);
	await writeDay(root, 'BTC', '2026-10-28', [
		'2026-10-28T12:00:00Z,200,kr,',
		// after the first live row: a candle of a missed run, kept and marked as filled
		'2026-10-28T12:30:00Z,999,bs-ohlc,',
		'2026-10-28T13:00:00Z,300,kr,',
	]);
	await writeDay(root, 'USDT', '2026-10-27', [
		'2026-10-27T12:15:00Z,0.5,bs-ohlc,',
	]);
	await writeDay(root, 'USDT', '2026-10-28', [
		'2026-10-28T12:00:00Z,0.5,kr,',
	]);
	const config = await loadFixtureConfig();
	config.coins.push({
		id: 'USDT',
		name: 'Tether',
		role: 'rate',
		enabled: true,
		added: '2026-10-27',
		sources: { kraken_pair: 'USDTUSD' },
		alerts: { enabled: false },
	});
	await buildSite({ dataRoot: root, config, outDir: out, now: NOW });
	const latest = await readOut<{
		src: string;
		history?: { src: string; until: string };
		coins: Record<string, { price: number }>;
	}>('latest.json');
	assert.equal(latest.src, 'kr');
	assert.deepEqual(latest.history, {
		src: 'bs-ohlc',
		until: '2026-10-28T12:00:00Z',
	});
	assert.equal(latest.coins.BTC?.price, 600);
	const seven = await readOut<{
		t: number[];
		p: number[];
		filled?: number[][];
	}>('coins/BTC.7d.json');
	assert.deepEqual(seven.p, [200, 220, 400, 1998, 600]);
	assert.deepEqual(seven.t, [
		epoch('2026-10-27T12:15:00Z'),
		epoch('2026-10-27T12:30:00Z'),
		epoch('2026-10-28T12:00:00Z'),
		epoch('2026-10-28T12:30:00Z'),
		epoch('2026-10-28T13:00:00Z'),
	]);
	assert.deepEqual(seven.filled, [
		[epoch('2026-10-28T12:00:00Z'), epoch('2026-10-28T13:00:00Z')],
	]);
	const quarter = await readOut<{ filled?: number[][] }>(
		'coins/BTC.90d.json'
	);
	assert.deepEqual(quarter.filled, seven.filled);
});
