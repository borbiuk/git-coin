import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
	T0,
	assertFileInvariants,
	assertInSync,
	cleanUpWorlds,
	git,
	makeWorld,
	plusMinutes,
	readLogLines,
	readPriceFiles,
	readStatus,
	remoteCount,
	remoteLog,
	remoteShow,
	rowsOf,
	runAt,
} from './harness.ts';

cleanUpWorlds();

const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

test('twelve runs in the test phase store four sources, one commit per run, from a shallow checkout', async () => {
	const world = await makeWorld();
	const before = remoteCount(world.dataRemote, 'data');
	for (let run = 0; run < 12; run += 1) {
		const result = await runAt(world, plusMinutes(T0, run * 15));
		assert.deepEqual(result, {
			exitCode: 0,
			shouldPublish: false,
			rowsWritten: 40,
		});
		assertInSync(world.data, world.dataRemote, 'data');
	}

	// One commit per run, made by the bot, with the documented message
	const log = remoteLog(world.dataRemote, 'data');
	assert.equal(log.length, before + 12);
	for (const entry of log.slice(0, 12)) {
		assert.match(entry.subject, /^data: 2026-10-29T\d\d:\d\dZ 40 rows$/);
		assert.equal(entry.name, 'github-actions[bot]');
		assert.equal(entry.email, BOT_EMAIL);
	}

	// Ten coins in one day file each. Per coin 48 rows: 12 runs times 4 sources.
	const files = [...readPriceFiles(world.data).keys()];
	assert.equal(files.length, 10);
	for (const [relative, lines] of readPriceFiles(world.data)) {
		assert.match(relative, /^2026\/10\/29\/[A-Z]+\.csv$/);
		assert.equal(lines.length, 1 + 48 + 1, relative);
	}
	assertFileInvariants(world.data, 300);

	// The price text is the source text, byte for byte, including trailing zeros and long decimals
	for (const coin of world.config.coins) {
		const rows = rowsOf(world.data, coin.id);
		for (const [source, code] of [
			['kraken', 'kr'],
			['coinbase', 'cb'],
			['bitstamp', 'bs'],
			['coinmetrics', 'cm'],
		] as const) {
			const own = rows.filter((row) => row.src === code);
			assert.equal(own.length, 12, `${coin.id} ${code}`);
			assert.equal(
				own.at(-1)?.price,
				world.market.served.get(`${source}:${coin.id}`),
				`${coin.id} ${code} is stored as served`
			);
			// Kraken has no time of its own, the others do
			const empty = own.every((row) => row.age === '');
			assert.equal(empty, code === 'kr', `${coin.id} ${code} age_s`);
		}
	}
	const btc = rowsOf(world.data, 'BTC').filter((row) => row.src === 'kr');
	assert.match(btc[0]?.price ?? '', /^\d+\.\d{5}$/);
	const doge = rowsOf(world.data, 'DOGE').filter((row) => row.src === 'cm');
	assert.match(doge[0]?.price ?? '', /^0\.\d{14}$/);

	// Requests per run: 2 for Kraken, 10 for Coinbase (at most 4 at a time), 1 for Bitstamp and Coin Metrics
	assert.deepEqual(world.market.requests, {
		kraken: 24,
		coinbase: 120,
		bitstamp: 12,
		coinmetrics: 12,
	});
	assert.ok(world.market.maxCoinbaseInFlight <= 4);
	assert.ok(
		world.market.maxCoinbaseInFlight >= 2,
		'Coinbase did run in parallel'
	);

	// The request log: four lines per run, all successful
	const logFiles = readLogLines(world.data);
	assert.equal(logFiles.size, 1);
	const lines = [...logFiles.values()][0] ?? [];
	assert.equal(lines.length, 1 + 48 + 1);
	assert.ok(
		lines
			.slice(1, -1)
			.every((line) => /^[^,]+,(kr|cb|bs|cm),200,\d+,10,$/.test(line))
	);

	// The status file
	const status = readStatus(world.data);
	assert.equal(status.consecutive_failures, 0);
	assert.equal(status.last_point_at, plusMinutes(T0, 11 * 15));
	for (const code of ['kr', 'cb', 'bs', 'cm']) {
		assert.equal(status.sources[code]?.requests, 12);
		assert.equal(status.sources[code]?.failures, 0);
		assert.equal(status.sources[code]?.consecutive_failures, 0);
	}
	assert.equal(Object.keys(status.coins).length, 10);
	assert.ok(
		Object.values(status.coins).every((coin) => coin.status === 'ok')
	);
	const text = readFileSync(join(world.data, 'state', 'status.json'), 'utf8');
	assert.ok(text.endsWith('}\n'));
	assert.equal(
		text,
		remoteShow(world.dataRemote, 'data', 'state/status.json')
	);

	// The test phase runs no alert step and, with features.publish off, asks for no publish
	assert.equal(world.issues.calls, 0);
	assert.deepEqual(
		remoteLog(world.dataRemote, 'data').filter((entry) =>
			entry.subject.startsWith('state:')
		),
		[]
	);
});

test('the collector commits without any git identity in the checkout', async () => {
	const world = await makeWorld({ identity: false });
	// No name and no email in the local config of the checkout, and the global config is off
	assert.throws(() => git(world.data, 'config', '--get', 'user.name'));
	const result = await runAt(world, T0);
	assert.equal(result.exitCode, 0);
	const [latest] = remoteLog(world.dataRemote, 'data');
	assert.equal(latest?.name, 'github-actions[bot]');
	assert.equal(latest?.email, BOT_EMAIL);
	assertInSync(world.data, world.dataRemote, 'data');
});

test('a dry run on a shallow checkout changes nothing, not even the index', async () => {
	const world = await makeWorld();
	await runAt(world, T0);
	const tip = git(world.data, 'rev-parse', 'HEAD');
	const result = await runAt(world, plusMinutes(T0, 15), { dryRun: true });
	assert.deepEqual(result, {
		exitCode: 0,
		shouldPublish: false,
		rowsWritten: 0,
	});
	assert.equal(git(world.data, 'rev-parse', 'HEAD'), tip);
	assertInSync(world.data, world.dataRemote, 'data');
	assert.ok(
		world.logs.some((line) =>
			/^dry run: 40 rows would be written/.test(line)
		)
	);
	// The status file still shows one request per source
	assert.equal(readStatus(world.data).sources.kr?.requests, 1);
});

test('a run that fails on a corrupt status file exits 1, pushes nothing and keeps the remote intact', async () => {
	const world = await makeWorld();
	await runAt(world, T0);
	// Someone damages the status file on the remote
	git(world.other, 'fetch', '--quiet', 'origin', 'data');
	git(world.other, 'reset', '--hard', '--quiet', 'origin/data');
	writeFileSync(join(world.other, 'state', 'status.json'), '{ not json');
	git(world.other, 'add', '-A');
	git(world.other, 'commit', '--quiet', '-m', 'Break the status');
	git(world.other, 'push', '--quiet', 'origin', 'HEAD:refs/heads/data');
	git(world.data, 'fetch', '--quiet', 'origin', 'data');
	git(world.data, 'reset', '--hard', '--quiet', 'origin/data');

	const tip = git(world.data, 'rev-parse', 'HEAD');
	const result = await runAt(world, plusMinutes(T0, 15));
	assert.equal(result.exitCode, 1);
	assert.equal(result.rowsWritten, 0);
	assert.equal(git(world.dataRemote, 'rev-parse', 'refs/heads/data'), tip);
	assert.ok(
		world.logs.some((line) =>
			line.startsWith('error: Error: Status file is not valid JSON')
		)
	);
});
