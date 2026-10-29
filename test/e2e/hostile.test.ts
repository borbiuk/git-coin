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
		assert.equal(result.rowsWritten, 44);
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
	// 44 slots, 25 of them hostile. The empty text is not in the list, so every hostile text reached the validator.
	assert.equal(result.rowsWritten, 44 - bad.length);
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

// Defect D-06, fixed: the step check applies only when the previous stored row is at most 6 hours old.
function productionKraken(): ReturnType<typeof makeWorld> {
	return makeWorld({
		patch: (config) => {
			config.settings.phase = 'production';
			config.settings.stored_sources = ['kraken'];
		},
	});
}

test('production: a 60 percent jump after a young row is rejected once, and the next normal price is accepted', async () => {
	const world = await productionKraken();
	for (let run = 0; run < 5; run += 1) {
		world.market.scale.set('BTC', run === 3 ? 1.6 : 1);
		await runAt(world, plusMinutes(T0, run * 15));
	}
	// Runs 0, 1, 2 and 4 are stored. Run 3 is rejected and does not block run 4.
	assert.equal(rowsOf(world.data, 'BTC').length, 4);
	const btc = readStatus(world.data).coins.BTC;
	assert.equal(btc?.rejected_count, 1);
	assert.equal(btc?.last_reject_reason, 'step_no_crosscheck');
	assert.equal(btc?.status, 'ok');
	// Other coins were not touched by it
	assert.equal(rowsOf(world.data, 'ETH').length, 5);
});

test('production: a lasting 60 percent move is rejected while the last row is at most 6 hours old, then accepted, and runs go on', async () => {
	const world = await productionKraken();
	await runAt(world, T0);
	world.market.scale.set('BTC', 1.6);
	// 2, 4 and exactly 6 hours later: the previous row is 6 hours old or less, so the jump is still rejected
	for (const hours of [2, 4, 6]) {
		await runAt(world, plusMinutes(T0, hours * 60));
		assert.equal(rowsOf(world.data, 'BTC').length, 1, `${hours} h`);
	}
	assert.equal(readStatus(world.data).coins.BTC?.rejected_count, 3);
	// 8 hours later the last row is older than 6 hours: no step check, the new level is stored
	await runAt(world, plusMinutes(T0, 8 * 60));
	assert.equal(rowsOf(world.data, 'BTC').length, 2);
	// And the next run, 15 minutes later, compares with the new level: no stuck state, no new rejection
	await runAt(world, plusMinutes(T0, 8 * 60 + 15));
	const rows = rowsOf(world.data, 'BTC');
	assert.equal(rows.length, 3);
	const [first, second, third] = rows.map((row) => Number(row.price));
	assert.ok((second ?? 0) > (first ?? 0) * 1.5, 'the new level is stored');
	assert.ok(Math.abs((third ?? 0) - (second ?? 0)) < (second ?? 0) * 0.01);
	assert.equal(readStatus(world.data).coins.BTC?.rejected_count, 3);
	assertFileInvariants(world.data, 300);
});

test('production: after an outage longer than 6 hours the first price may be far from the last stored one', async () => {
	const world = await productionKraken();
	await runAt(world, T0);
	world.market.scale.set('BTC', 1.6);
	world.market.scale.set('ETH', 0.4);
	const result = await runAt(world, plusMinutes(T0, 7 * 60));
	assert.equal(result.rowsWritten, 11);
	assert.equal(readStatus(world.data).coins.BTC?.rejected_count, 0);
	assert.equal(readStatus(world.data).coins.ETH?.rejected_count, 0);
});
