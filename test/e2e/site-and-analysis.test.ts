import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';

// The dashboard code is plain JavaScript for the browser and has no type declarations
// @ts-expect-error the dashboard code is not part of the TypeScript project
import * as lib from '../../site/lib.js';
import { buildSite } from '../../src/build-site.ts';
import type { Config } from '../../src/types.ts';
import { main as analyze } from '../../tools/analyze-sources.ts';
import type { Report } from '../../tools/analyze-sources.ts';

import {
	T0,
	cleanUpWorlds,
	makeWorld,
	plusMinutes,
	readStatus,
	remoteShow,
	rowsOf,
	runAt,
} from './harness.ts';
import type { World } from './harness.ts';

cleanUpWorlds();

const REPO = join(import.meta.dirname, '..', '..');
const TICKS = 20;
const LAST = plusMinutes(T0, (TICKS - 1) * 15);
const NOW = new Date(plusMinutes(LAST, 1));

let world: World;

// One season of 20 runs with a Coinbase outage (runs 6 to 10) and a planted Bitstamp outlier (run 12, BTC)
before(async () => {
	world = await makeWorld();
	for (let run = 0; run < TICKS; run += 1) {
		if (run === 6) {
			world.market.down.set('coinbase', 'timeout');
		}
		if (run === 11) {
			world.market.down.delete('coinbase');
		}
		if (run === 12) {
			world.market.override.set('bitstamp:BTC', '103500.00');
		}
		if (run === 13) {
			world.market.override.delete('bitstamp:BTC');
		}
		const result = await runAt(world, plusMinutes(T0, run * 15));
		assert.equal(result.exitCode, 0);
	}
});

function configFor(
	primary: Array<'kraken' | 'coinbase' | 'bitstamp' | 'coinmetrics'>
): Config {
	const config = structuredClone(world.config);
	config.settings.phase = 'production';
	config.settings.stored_sources = primary;
	config.settings.features.publish = true;
	return config;
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function numbers(coin: string, src: string): number[] {
	return rowsOf(world.data, coin)
		.filter((row) => row.src === src)
		.map((row) => Number(row.price));
}

test('the site files in production mode have the contract shapes and use only the primary source', async () => {
	const out = join(world.root, 'site-kr');
	await buildSite({
		dataRoot: world.data,
		config: configFor(['kraken', 'coinbase']),
		outDir: out,
		now: NOW,
	});

	assert.deepEqual(readdirSync(out).sort(), [
		'alerts.json',
		'coins',
		'latest.json',
		'status.json',
	]);
	// Four files per coin: 7d, 90d, daily and, because two sources are stored, sources
	assert.equal(readdirSync(join(out, 'coins')).length, 40);

	const latest = readJson(join(out, 'latest.json')) as {
		generated_at: string;
		quote: string;
		src: string;
		coins: Record<
			string,
			{
				name: string;
				price: number;
				ts: string;
				periods: Record<
					string,
					{ change_pct: number | null; high: number; low: number }
				>;
			}
		>;
	};
	assert.equal(latest.generated_at, NOW.toISOString().slice(0, 19) + 'Z');
	assert.equal(latest.quote, 'USD');
	assert.equal(latest.src, 'kr');
	assert.deepEqual(
		Object.keys(latest.coins),
		world.config.coins.map((coin) => coin.id)
	);
	for (const coin of world.config.coins) {
		const entry = latest.coins[coin.id];
		const series = numbers(coin.id, 'kr');
		assert.equal(entry?.name, coin.name);
		assert.equal(
			entry?.price,
			series.at(-1),
			`${coin.id} price is the last Kraken price`
		);
		assert.equal(entry?.ts, LAST);
		for (const key of ['24h', '7d', '30d']) {
			const period = entry?.periods[key];
			assert.equal(period?.high, Math.max(...series));
			assert.equal(period?.low, Math.min(...series));
			// The history is five hours long, so no period has a start sample: no guess, just null
			assert.equal(period?.change_pct, null);
		}
	}

	for (const coin of world.config.coins) {
		const seven = readJson(join(out, 'coins', `${coin.id}.7d.json`)) as {
			coin: string;
			src: string;
			t: number[];
			p: number[];
		};
		assert.equal(seven.coin, coin.id);
		assert.equal(seven.src, 'kr');
		assert.deepEqual(
			seven.p,
			numbers(coin.id, 'kr'),
			`${coin.id} 7d is the Kraken rows in order`
		);
		assert.equal(seven.t.length, TICKS);
		assert.deepEqual(
			seven.t,
			[...seven.t].sort((a, b) => a - b)
		);
		assert.equal(seven.t[0], Date.parse(T0) / 1000);
		assert.ok(lib.validSeries(seven, ['t', 'p']));

		// 90 days: the last price of every UTC hour
		const ninety = readJson(join(out, 'coins', `${coin.id}.90d.json`)) as {
			t: number[];
			p: number[];
		};
		const lastOfHour = new Map<number, number>();
		for (const row of rowsOf(world.data, coin.id).filter(
			(item) => item.src === 'kr'
		)) {
			lastOfHour.set(
				Math.floor(Date.parse(row.ts) / 3_600_000),
				Number(row.price)
			);
		}
		assert.deepEqual(ninety.p, [...lastOfHour.values()]);
		assert.ok(lib.validSeries(ninety, ['t', 'p']));

		// Daily candles
		const daily = readJson(join(out, 'coins', `${coin.id}.daily.json`)) as {
			t: number[];
			o: number[];
			h: number[];
			l: number[];
			c: number[];
		};
		const prices = numbers(coin.id, 'kr');
		assert.deepEqual(daily.t, [Date.parse('2026-10-29T00:00:00Z') / 1000]);
		assert.deepEqual(daily.o, [prices[0]]);
		assert.deepEqual(daily.c, [prices.at(-1)]);
		assert.deepEqual(daily.h, [Math.max(...prices)]);
		assert.deepEqual(daily.l, [Math.min(...prices)]);
		assert.ok(lib.validSeries(daily, ['t', 'c']));
	}

	// The status is the state file plus the time, and the alert list is empty
	const status = readJson(join(out, 'status.json'));
	const state = JSON.parse(
		remoteShow(world.dataRemote, 'data', 'state/status.json')
	) as Record<string, unknown>;
	assert.deepEqual(status, { ...state, generated_at: latest.generated_at });
	assert.deepEqual(readJson(join(out, 'alerts.json')), {
		generated_at: latest.generated_at,
		alerts: [],
	});
});

test('another primary source changes every series, and the outage of that source stays a gap', async () => {
	const out = join(world.root, 'site-cb');
	await buildSite({
		dataRoot: world.data,
		config: configFor(['coinbase', 'kraken']),
		outDir: out,
		now: NOW,
	});
	const latest = readJson(join(out, 'latest.json')) as {
		src: string;
		coins: Record<string, { price: number }>;
	};
	assert.equal(latest.src, 'cb');
	for (const coin of world.config.coins) {
		assert.equal(
			latest.coins[coin.id]?.price,
			numbers(coin.id, 'cb').at(-1)
		);
		const seven = readJson(join(out, 'coins', `${coin.id}.7d.json`)) as {
			src: string;
			t: number[];
			p: number[];
		};
		assert.equal(seven.src, 'cb');
		assert.deepEqual(seven.p, numbers(coin.id, 'cb'));
		assert.equal(seven.t.length, TICKS - 5);
	}
	// The dashboard breaks the line at the gap and nowhere else
	const btc = readJson(join(out, 'coins', 'BTC.7d.json')) as {
		t: number[];
		p: number[];
	};
	const broken = lib.breakGaps(btc.t, btc.p) as {
		t: number[];
		p: Array<number | null>;
	};
	assert.equal(broken.p.filter((value) => value === null).length, 1);
});

test('the dashboard reads every file that the builder wrote, with its own checks and names', async () => {
	const page = join(world.root, 'site-contract');
	const out = join(page, 'data');
	await buildSite({
		dataRoot: world.data,
		config: configFor(['kraken']),
		outDir: out,
		now: NOW,
	});
	for (const range of Object.values(lib.RANGES) as Array<{ file: string }>) {
		for (const coin of world.config.coins) {
			const path = join(page, lib.coinDataUrl(coin.id, range.file));
			assert.ok(existsSync(path), path);
		}
	}
	const status = readJson(join(out, 'status.json'));
	const iso = status.last_point_at as string;
	assert.equal(
		lib.staleState(iso, Date.parse(iso) + 60_000, lib.staleLimits(status)),
		'fresh'
	);
	assert.equal(
		lib.staleState(
			iso,
			Date.parse(iso) + 121 * 60_000,
			lib.staleLimits(status)
		),
		'delayed'
	);
	assert.equal(
		lib.staleState(
			iso,
			Date.parse(iso) + 361 * 60_000,
			lib.staleLimits(status)
		),
		'stopped'
	);
	assert.equal(
		lib.sourceInfo(
			(readJson(join(out, 'latest.json')) as { src: string }).src
		).name,
		'Kraken'
	);
});

test('the workflow commands build the page: copy the site, then run the builder from a workspace', () => {
	// The publish job of collect.yml runs in a workspace with `code/` and `data/`
	const workspace = join(world.root, 'publish-ws');
	mkdirSync(join(workspace, 'code', 'config'), { recursive: true });
	cpSync(
		join(REPO, 'config', 'coins.json'),
		join(workspace, 'code', 'config', 'coins.json')
	);
	cpSync(world.data, join(workspace, 'data'), { recursive: true });
	mkdirSync(join(workspace, 'out'), { recursive: true });
	cpSync(join(REPO, 'site'), join(workspace, 'out'), { recursive: true });
	execFileSync(
		process.execPath,
		[
			join(REPO, 'src', 'build-site.ts'),
			'--config',
			'code/config/coins.json',
			'--data-root',
			'data',
			'--out',
			'out/data',
			'--now',
			NOW.toISOString(),
		],
		{ cwd: workspace, stdio: 'pipe' }
	);

	// Everything the page loads is in the artifact folder
	for (const file of [
		'index.html',
		'app.js',
		'lib.js',
		'style.css',
		'vendor/uPlot.iife.min.js',
		'vendor/uPlot.min.css',
		'data/status.json',
		'data/latest.json',
		'data/alerts.json',
		'data/coins/BTC.7d.json',
	]) {
		assert.ok(existsSync(join(workspace, 'out', file)), file);
	}
	const html = readFileSync(join(workspace, 'out', 'index.html'), 'utf8');
	for (const [, href] of html.matchAll(/(?:href|src)="([^"#]+)"/g)) {
		if (
			href !== undefined &&
			!href.startsWith('http') &&
			!href.startsWith('data:')
		) {
			assert.ok(
				existsSync(join(workspace, 'out', href)),
				`index.html refers to ${href}`
			);
		}
	}
	// The coin files exist for exactly the coins of the latest list
	const latest = readJson(join(workspace, 'out', 'data', 'latest.json')) as {
		coins: Record<string, unknown>;
	};
	const files = readdirSync(join(workspace, 'out', 'data', 'coins')).sort();
	assert.deepEqual(
		files,
		Object.keys(latest.coins)
			.flatMap((id) => [
				`${id}.7d.json`,
				`${id}.90d.json`,
				`${id}.daily.json`,
				`${id}.sources.json`,
			])
			.sort()
	);
});

async function runAnalysis(
	args: string[]
): Promise<{ code: number; out: string; err: string }> {
	let out = '';
	let err = '';
	const code = await analyze(['--data-root', world.data, ...args], {
		out: (text) => {
			out += text;
		},
		err: (text) => {
			err += text;
		},
	});
	return { code, out, err };
}

test('the source analysis on the same data: gate, streaks, planted outlier, counts and the table text', async () => {
	const { code, out, err } = await runAnalysis(['--json']);
	assert.equal(code, 0, err);
	const report = JSON.parse(out) as Report;

	const gate = Object.fromEntries(report.gate.map((row) => [row.src, row]));
	for (const src of ['kr', 'bs', 'cm']) {
		assert.equal(gate[src]?.ticks, TICKS, src);
		assert.equal(gate[src]?.availability_percent, 100, src);
		assert.equal(gate[src]?.longest_fail_streak, 0, src);
		assert.equal(gate[src]?.eligible, true, src);
	}
	// Coinbase: five failed ticks in a row out of 20
	assert.equal(gate.cb?.ticks, TICKS);
	assert.equal(gate.cb?.ok_ticks, TICKS - 5);
	assert.equal(gate.cb?.availability_percent, 75);
	assert.equal(gate.cb?.longest_fail_streak, 5);
	assert.equal(gate.cb?.availability_pass, false);
	assert.equal(gate.cb?.streak_pass, false);
	assert.equal(gate.cb?.eligible, false);

	// The planted Bitstamp point is the only outlier in BTC and the largest deviation of the report
	const bsBtc = report.deviations.find(
		(row) => row.src === 'bs' && row.coin === 'BTC'
	);
	assert.ok((bsBtc?.over ?? 0) >= 1);
	assert.ok((bsBtc?.max ?? 0) > 2);
	const krBtc = report.deviations.find(
		(row) => row.src === 'kr' && row.coin === 'BTC'
	);
	assert.ok(
		(krBtc?.max ?? 0) < 1,
		'the planted point does not move the consensus median'
	);
	assert.equal(report.skipped_lines, 0);
	assert.equal(report.period.from, T0);

	// Latency comes from the request log (the fake source says 7 ms), and the requests per run are fixed
	const score = Object.fromEntries(report.score.map((row) => [row.src, row]));
	assert.equal(score.kr?.latency?.p50, 14);
	assert.equal(score.cb?.requests_per_run, 10);
	assert.equal(score.kr?.requests_per_run, 2);

	const text = await runAnalysis([]);
	assert.equal(text.code, 0);
	for (const word of ['Kraken', 'Coinbase', 'Bitstamp', 'Coin Metrics']) {
		assert.ok(text.out.includes(word), word);
	}
});

test('the analysis tool runs as a command on the data checkout and with its default thresholds on ten coins', () => {
	const output = execFileSync(
		process.execPath,
		[
			join(REPO, 'tools', 'analyze-sources.ts'),
			'--data-root',
			world.data,
			'--json',
		],
		{ encoding: 'utf8' }
	);
	const report = JSON.parse(output) as Report;
	assert.equal(report.thresholds.expected_coins, 10);
	assert.equal(report.gate.length, 4);
});

test('the status file of the season is consistent with the files', () => {
	const status = readStatus(world.data);
	assert.equal(status.sources.cb?.failures, 5);
	assert.equal(status.sources.cb?.requests, TICKS);
	assert.equal(status.consecutive_failures, 0);
	assert.equal(status.last_point_at, LAST);
});
