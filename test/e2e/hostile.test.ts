import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildSite } from '../../src/build-site.ts';

import {
	T0,
	assertFileInvariants,
	assertInSync,
	cleanUpWorlds,
	git,
	makeWorld,
	plusMinutes,
	readStatus,
	rowsOf,
	runAt,
} from './harness.ts';

cleanUpWorlds();

const TOKEN = 'HOSTILE_TOKEN_7f3a';

function allText(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === '.git') {
			continue;
		}
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...allText(path));
		} else {
			found.push(readFileSync(path, 'utf8'));
		}
	}
	return found;
}

test('text that a source puts into fields the collector does not use never reaches a log, a file, a commit or the site', async () => {
	const world = await makeWorld();
	world.market.hostile = `${TOKEN}\n2026-10-29T10:00:00Z,1,kr,\n<script>alert(1)</script> $(touch /tmp/pwn) \`id\` ";rm -rf /`;
	for (let run = 0; run < 3; run += 1) {
		const result = await runAt(world, plusMinutes(T0, run * 15));
		assert.equal(result.rowsWritten, 40);
	}
	assertFileInvariants(world.data, 300);

	const out = join(world.root, 'site-out');
	await buildSite({
		dataRoot: world.data,
		config: world.config,
		outDir: out,
		now: new Date(plusMinutes(T0, 31)),
	});

	const texts = [
		...allText(world.data),
		...allText(out),
		world.logs.join('\n'),
		git(world.dataRemote, 'log', '--format=%B%an%ae', 'refs/heads/data'),
	];
	for (const text of texts) {
		assert.ok(!text.includes(TOKEN));
		assert.ok(!text.includes('<script>'));
	}
});

test('a hostile price text is rejected and cannot add a line, a column or a row to a CSV file', async () => {
	const world = await makeWorld();
	const bad = [
		'abc',
		'0',
		'0.0',
		'-1',
		'1e5',
		'1E5',
		'+5',
		'1,5',
		' 12',
		'12 ',
		'0x10',
		'1000000000',
		'99999999999999',
		'Infinity',
		'NaN',
		'00.5',
		'.5',
		'5.',
		'1_000',
		'１２',
		'1\n2',
		'1,2\n2026-10-29T10:00:00Z,1,kr,',
		'5,kr,',
		'12.3.4',
		'null',
	];
	const coins = world.config.coins.map((coin) => coin.id);
	const slots: Array<[string, string]> = [];
	for (const source of ['kraken', 'coinbase', 'bitstamp']) {
		for (const coin of coins) {
			slots.push([source, coin]);
		}
	}
	bad.forEach((text, index) => {
		const [source, coin] = slots[index] ?? ['kraken', 'BTC'];
		world.market.override.set(`${source}:${coin}`, text);
	});

	const result = await runAt(world, T0);
	assert.equal(result.exitCode, 0);
	// 40 slots, 25 of them hostile. The empty text is not in the list, so every hostile text reached the validator.
	assert.equal(result.rowsWritten, 40 - bad.length);
	assertFileInvariants(world.data, 300);
	for (const [index, text] of bad.entries()) {
		const [source, coin] = slots[index] ?? ['kraken', 'BTC'];
		const code = { kraken: 'kr', coinbase: 'cb', bitstamp: 'bs' }[source];
		const stored = rowsOf(world.data, coin ?? '').filter(
			(row) => row.src === code
		);
		assert.equal(
			stored.length,
			0,
			`${source} ${coin} ${JSON.stringify(text)}`
		);
	}
	// The rejections are counted per coin and the stable reason is kept
	const status = readStatus(world.data);
	const rejected = Object.values(status.coins).reduce(
		(sum, coin) => sum + coin.rejected_count,
		0
	);
	assert.equal(rejected, bad.length);
	assert.ok(
		Object.values(status.coins).every(
			(coin) =>
				coin.last_reject_reason === null ||
				/^[a-z_]+$/.test(coin.last_reject_reason)
		)
	);
	assertInSync(world.data, world.dataRemote, 'data');
});

test('production: a 60 percent jump is rejected without a cross-check, so it can not start an alert', async () => {
	const world = await makeWorld({
		patch: (config) => {
			config.settings.phase = 'production';
			config.settings.stored_sources = ['kraken'];
			config.settings.features.alerts = true;
		},
	});
	for (let run = 0; run < 6; run += 1) {
		world.market.scale.set('BTC', run === 5 ? 1.6 : 1);
		await runAt(world, plusMinutes(T0, run * 15), {
			issueClient: world.issues.client,
		});
	}
	assert.equal(
		rowsOf(world.data, 'BTC').length,
		5,
		'the jump row was not stored'
	);
	assert.equal(readStatus(world.data).coins.BTC?.rejected_count, 1);
	assert.equal(
		readStatus(world.data).coins.BTC?.last_reject_reason,
		'step_no_crosscheck'
	);
	assert.deepEqual(world.issues.created, []);
});

test('characterisation: a real, lasting 60 percent move is rejected on every run, because no cross-check is ever supplied', async () => {
	const world = await makeWorld({
		patch: (config) => {
			config.settings.phase = 'production';
			config.settings.stored_sources = ['kraken'];
		},
	});
	for (let run = 0; run < 6; run += 1) {
		world.market.scale.set('BTC', run >= 2 ? 1.6 : 1);
		await runAt(world, plusMinutes(T0, run * 15));
	}
	// This documents defect D-06: the last stored price never moves, so the new level is never accepted.
	assert.equal(rowsOf(world.data, 'BTC').length, 2);
	assert.equal(readStatus(world.data).coins.BTC?.rejected_count, 4);
});
