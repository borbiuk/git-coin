import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
	appendRequestLog,
	appendRows,
	dailyPath,
	readLastRow,
} from '../src/csv.ts';
import type { PriceRow, RequestLogRow, SrcCode } from '../src/types.ts';

const HEADER = 'ts,price,src,age_s\n';
const SPACING = { minSpacingSeconds: 300 };

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(path.join(tmpdir(), 'git-coin-csv-'));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function row(
	ts: string,
	price: string,
	src: SrcCode = 'kr',
	coin = 'BTC',
	age: number | null = null
): PriceRow {
	return { ts, coin, price, src, age_s: age };
}

function logRow(overrides: Partial<RequestLogRow> = {}): RequestLogRow {
	return {
		ts: '2026-10-29T14:03:12Z',
		src: 'kr',
		http: 200,
		ms: 312,
		coins_ok: 10,
		error: '',
		...overrides,
	};
}

function logPath(root: string, day: string): string {
	const [year = '', month = '', date = ''] = day.split('-');
	return path.join(root, 'data', 'meta', year, month, date, 'requests.csv');
}

test('dailyPath builds the layout and upper-cases the coin', () => {
	assert.equal(
		dailyPath('/root', 'btc', '2026-10-29T14:03:12Z'),
		path.join('/root', 'data', 'raw', '2026', '10', '29', 'BTC.csv')
	);
});

test('dailyPath rejects a coin id that could leave the folder', () => {
	assert.throws(() => dailyPath('/root', '../x', '2026-10-29T14:03:12Z'));
	assert.throws(() => dailyPath('/root', '', '2026-10-29T14:03:12Z'));
});

test('dailyPath rejects a bad ts', () => {
	assert.throws(() => dailyPath('/root', 'BTC', '2026-10-29'));
	assert.throws(() => dailyPath('/root', 'BTC', '2026-13-29T14:03:12Z'));
});

test('appendRows creates the file with the header', async () => {
	await withRoot(async (root) => {
		const result = await appendRows(
			root,
			[row('2026-10-29T14:03:12Z', '81232.79000')],
			SPACING
		);
		assert.equal(result.written.length, 1);
		assert.deepEqual(result.skipped, []);
		const text = await readFile(
			dailyPath(root, 'BTC', '2026-10-29T14:03:12Z'),
			'utf8'
		);
		assert.equal(text, `${HEADER}2026-10-29T14:03:12Z,81232.79000,kr,\n`);
	});
});

test('appendRows appends to an existing file without a second header', async () => {
	await withRoot(async (root) => {
		await appendRows(
			root,
			[row('2026-10-29T14:00:00Z', '100.00')],
			SPACING
		);
		await appendRows(
			root,
			[row('2026-10-29T14:15:00Z', '101.00')],
			SPACING
		);
		const text = await readFile(
			dailyPath(root, 'BTC', '2026-10-29T14:00:00Z'),
			'utf8'
		);
		assert.equal(
			text,
			`${HEADER}2026-10-29T14:00:00Z,100.00,kr,\n2026-10-29T14:15:00Z,101.00,kr,\n`
		);
	});
});

test('appendRows writes the price string and age_s byte for byte', async () => {
	await withRoot(async (root) => {
		await appendRows(
			root,
			[
				row('2026-10-29T14:00:00Z', '0.00001234'),
				row('2026-10-29T14:00:00Z', '81232.79000', 'cb', 'ETH', 2),
			],
			SPACING
		);
		const btc = await readFile(
			dailyPath(root, 'BTC', '2026-10-29T14:00:00Z'),
			'utf8'
		);
		const eth = await readFile(
			dailyPath(root, 'ETH', '2026-10-29T14:00:00Z'),
			'utf8'
		);
		assert.equal(btc, `${HEADER}2026-10-29T14:00:00Z,0.00001234,kr,\n`);
		assert.equal(eth, `${HEADER}2026-10-29T14:00:00Z,81232.79000,cb,2\n`);
	});
});

test('sources are independent inside one file', async () => {
	await withRoot(async (root) => {
		await appendRows(
			root,
			[row('2026-10-29T14:00:00Z', '100.00', 'kr')],
			SPACING
		);
		// 10 seconds later: too close for kr, but the first row of cb.
		const result = await appendRows(
			root,
			[
				row('2026-10-29T14:00:10Z', '100.10', 'kr'),
				row('2026-10-29T14:00:10Z', '100.20', 'cb', 'BTC', 3),
			],
			SPACING
		);
		assert.deepEqual(
			result.written.map((r) => r.src),
			['cb']
		);
		assert.deepEqual(
			result.skipped.map((s) => [s.row.src, s.reason]),
			[['kr', 'spacing']]
		);
	});
});

test('coins are independent', async () => {
	await withRoot(async (root) => {
		await appendRows(
			root,
			[row('2026-10-29T14:00:00Z', '100.00')],
			SPACING
		);
		const result = await appendRows(
			root,
			[row('2026-10-29T14:00:10Z', '5.00', 'kr', 'ETH')],
			SPACING
		);
		assert.equal(result.written.length, 1);
	});
});

test('a row closer than the spacing is skipped and not written', async () => {
	await withRoot(async (root) => {
		await appendRows(
			root,
			[row('2026-10-29T14:00:00Z', '100.00')],
			SPACING
		);
		const result = await appendRows(
			root,
			[row('2026-10-29T14:04:59Z', '101.00')],
			SPACING
		);
		assert.equal(result.written.length, 0);
		assert.equal(result.skipped[0]?.reason, 'spacing');
		const edge = await appendRows(
			root,
			[row('2026-10-29T14:05:00Z', '102.00')],
			SPACING
		);
		assert.equal(edge.written.length, 1);
	});
});

test('re-running the same rows writes nothing twice', async () => {
	await withRoot(async (root) => {
		const rows = [
			row('2026-10-29T14:00:00Z', '100.00'),
			row('2026-10-29T14:00:01Z', '5.00', 'kr', 'ETH'),
		];
		await appendRows(root, rows, SPACING);
		const again = await appendRows(root, rows, SPACING);
		assert.equal(again.written.length, 0);
		assert.equal(again.skipped.length, 2);
	});
});

test('a row earlier than the last stored ts is skipped as clock', async () => {
	await withRoot(async (root) => {
		await appendRows(
			root,
			[row('2026-10-29T14:00:00Z', '100.00')],
			SPACING
		);
		const result = await appendRows(
			root,
			[row('2026-10-29T13:00:00Z', '99.00')],
			SPACING
		);
		assert.equal(result.written.length, 0);
		assert.equal(result.skipped[0]?.reason, 'clock');
	});
});

test('a clock-skipped row from an earlier day does not create a file', async () => {
	await withRoot(async (root) => {
		await appendRows(
			root,
			[row('2026-10-29T14:00:00Z', '100.00')],
			SPACING
		);
		await appendRows(root, [row('2026-10-28T23:00:00Z', '99.00')], SPACING);
		await assert.rejects(
			readFile(dailyPath(root, 'BTC', '2026-10-28T23:00:00Z'), 'utf8')
		);
	});
});

test('midnight rollover starts a new file and still checks the previous day', async () => {
	await withRoot(async (root) => {
		await appendRows(
			root,
			[row('2026-10-29T23:58:00Z', '100.00')],
			SPACING
		);
		const close = await appendRows(
			root,
			[row('2026-10-30T00:00:30Z', '100.50')],
			SPACING
		);
		assert.equal(close.skipped[0]?.reason, 'spacing');
		const next = await appendRows(
			root,
			[row('2026-10-30T00:05:00Z', '101.00')],
			SPACING
		);
		assert.equal(next.written.length, 1);
		const day2 = await readFile(
			dailyPath(root, 'BTC', '2026-10-30T00:05:00Z'),
			'utf8'
		);
		assert.equal(day2, `${HEADER}2026-10-30T00:05:00Z,101.00,kr,\n`);
	});
});

test('one call can write rows of several days in order', async () => {
	await withRoot(async (root) => {
		const result = await appendRows(
			root,
			[
				row('2026-10-29T23:59:00Z', '1.00'),
				row('2026-10-30T00:10:00Z', '2.00'),
				row('2026-10-30T00:20:00Z', '3.00'),
			],
			SPACING
		);
		assert.equal(result.written.length, 3);
		const day2 = await readFile(
			dailyPath(root, 'BTC', '2026-10-30T00:10:00Z'),
			'utf8'
		);
		assert.equal(
			day2,
			`${HEADER}2026-10-30T00:10:00Z,2.00,kr,\n2026-10-30T00:20:00Z,3.00,kr,\n`
		);
	});
});

test('rows of one src in one call respect the spacing among themselves', async () => {
	await withRoot(async (root) => {
		const result = await appendRows(
			root,
			[
				row('2026-10-29T14:00:00Z', '1.00'),
				row('2026-10-29T14:01:00Z', '2.00'),
			],
			SPACING
		);
		assert.equal(result.written.length, 1);
		assert.equal(result.skipped[0]?.reason, 'spacing');
	});
});

test('a file that ends without a line break is not glued to the next row', async () => {
	await withRoot(async (root) => {
		const file = dailyPath(root, 'BTC', '2026-10-29T14:00:00Z');
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(
			file,
			`${HEADER}2026-10-29T14:00:00Z,100.00,kr,\n2026-10-29T14:`
		);
		await appendRows(
			root,
			[row('2026-10-29T14:15:00Z', '101.00')],
			SPACING
		);
		const text = await readFile(file, 'utf8');
		assert.equal(
			text,
			`${HEADER}2026-10-29T14:00:00Z,100.00,kr,\n2026-10-29T14:\n2026-10-29T14:15:00Z,101.00,kr,\n`
		);
	});
});

test('bad rows throw before anything is written', async () => {
	await withRoot(async (root) => {
		const good = row('2026-10-29T14:00:00Z', '100.00');
		const bad = [
			row('2026-10-29T14:00:00Z', '1,5'),
			row('2026-10-29T14:00:00Z', '1\n5'),
			row('2026-10-29T14:00:00Z', ''),
			row('2026-10-29', '1.00'),
			row('2026-10-29T14:00:00Z', '1.00', 'zz' as SrcCode),
			row('2026-10-29T14:00:00Z', '1.00', 'kr', 'BTC', 1.5),
			row('2026-10-29T14:00:00Z', '1.00', 'kr', '../BTC'),
		];
		for (const item of bad) {
			await assert.rejects(appendRows(root, [good, item], SPACING));
		}
		await assert.rejects(readFile(dailyPath(root, 'BTC', good.ts), 'utf8'));
	});
});

test('appendRows rejects a bad spacing option', async () => {
	await withRoot(async (root) => {
		await assert.rejects(appendRows(root, [], { minSpacingSeconds: -1 }));
	});
});

test('readLastRow returns null when nothing is stored', async () => {
	await withRoot(async (root) => {
		assert.equal(await readLastRow(root, 'BTC', 'kr'), null);
	});
});

test('readLastRow returns the last row of the src, also from an earlier day', async () => {
	await withRoot(async (root) => {
		await appendRows(
			root,
			[
				row('2026-10-28T10:00:00Z', '1.00', 'kr'),
				row('2026-10-28T10:00:01Z', '2.00', 'cb', 'BTC', 4),
				row('2026-10-28T10:10:00Z', '3.00', 'kr'),
				row('2026-10-29T10:00:01Z', '4.00', 'cb', 'BTC', 5),
			],
			SPACING
		);
		assert.deepEqual(await readLastRow(root, 'BTC', 'kr'), {
			ts: '2026-10-28T10:10:00Z',
			price: '3.00',
			src: 'kr',
			age_s: null,
		});
		assert.deepEqual(await readLastRow(root, 'BTC', 'cb'), {
			ts: '2026-10-29T10:00:01Z',
			price: '4.00',
			src: 'cb',
			age_s: 5,
		});
		assert.equal(await readLastRow(root, 'BTC', 'bs'), null);
		assert.equal(await readLastRow(root, 'ETH', 'kr'), null);
	});
});

test('readLastRow ignores malformed lines', async () => {
	await withRoot(async (root) => {
		const file = dailyPath(root, 'BTC', '2026-10-29T10:00:00Z');
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(
			file,
			`${HEADER}2026-10-29T10:00:00Z,100.00,kr,\ngarbage\n2026-10-29T10:05:00Z,,kr,\n`
		);
		assert.equal((await readLastRow(root, 'BTC', 'kr'))?.price, '100.00');
	});
});

test('an append never changes the bytes that are already in a file', async () => {
	await withRoot(async (root) => {
		// A small seeded generator, so a failure can be reproduced.
		let seed = 12345;
		const next = (max: number): number => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return Math.floor(seed / 65536) % max;
		};
		const srcs: SrcCode[] = ['kr', 'cb', 'bs', 'cm'];
		const coins = ['BTC', 'ETH', 'SOL'];
		const files = new Set<string>();
		let clock = Date.parse('2026-10-29T23:00:00Z') / 1000;
		let totalWritten = 0;
		for (let round = 0; round < 60; round += 1) {
			// Sometimes the clock goes back, so clock skips happen too.
			clock += next(1500) - 100;
			const rows: PriceRow[] = [];
			const count = 1 + next(6);
			for (let i = 0; i < count; i += 1) {
				const ts = new Date((clock + next(30)) * 1000).toISOString();
				rows.push(
					row(
						`${ts.slice(0, 19)}Z`,
						`${next(100000)}.${next(100000)}`,
						srcs[next(srcs.length)] ?? 'kr',
						coins[next(coins.length)] ?? 'BTC',
						next(2) === 0 ? null : next(10)
					)
				);
			}
			const before = new Map<string, Buffer>();
			for (const file of files) {
				before.set(file, await readFile(file));
			}
			const result = await appendRows(root, rows, {
				minSpacingSeconds: 60,
			});
			totalWritten += result.written.length;
			for (const written of result.written) {
				files.add(dailyPath(root, written.coin, written.ts));
			}
			for (const [file, bytes] of before) {
				const after = await readFile(file);
				assert.ok(
					after.subarray(0, bytes.length).equals(bytes),
					`bytes changed in ${file}`
				);
			}
		}
		assert.ok(totalWritten > 20);
	});
});

test('appendRequestLog creates the file with the header and appends', async () => {
	await withRoot(async (root) => {
		await appendRequestLog(root, [
			logRow(),
			logRow({
				ts: '2026-10-29T14:03:13Z',
				src: 'cb',
				http: 0,
				ms: 5000,
				coins_ok: 0,
				error: 'timeout',
			}),
		]);
		await appendRequestLog(root, [
			logRow({
				ts: '2026-10-29T14:18:12Z',
				src: 'bs',
				http: 429,
				ms: 90,
				coins_ok: 0,
				error: 'http_429',
			}),
		]);
		const text = await readFile(logPath(root, '2026-10-29'), 'utf8');
		assert.equal(
			text,
			[
				'ts,src,http,ms,coins_ok,error',
				'2026-10-29T14:03:12Z,kr,200,312,10,',
				'2026-10-29T14:03:13Z,cb,0,5000,0,timeout',
				'2026-10-29T14:18:12Z,bs,429,90,0,http_429',
				'',
			].join('\n')
		);
	});
});

test('appendRequestLog splits rows by UTC day and accepts an empty list', async () => {
	await withRoot(async (root) => {
		await appendRequestLog(root, []);
		await appendRequestLog(root, [
			logRow({ ts: '2026-10-29T23:59:59Z', ms: 1 }),
			logRow({ ts: '2026-10-30T00:00:01Z', ms: 2 }),
		]);
		const day1 = await readFile(logPath(root, '2026-10-29'), 'utf8');
		const day2 = await readFile(logPath(root, '2026-10-30'), 'utf8');
		assert.equal(
			day1,
			'ts,src,http,ms,coins_ok,error\n2026-10-29T23:59:59Z,kr,200,1,10,\n'
		);
		assert.equal(
			day2,
			'ts,src,http,ms,coins_ok,error\n2026-10-30T00:00:01Z,kr,200,2,10,\n'
		);
	});
});

test('appendRequestLog rejects bad rows before writing', async () => {
	await withRoot(async (root) => {
		const good = logRow();
		const bad = [
			logRow({ ms: -1 }),
			logRow({ ts: 'now' }),
			logRow({ http: 1.5 }),
			logRow({ src: 'zz' as SrcCode }),
		];
		for (const item of bad) {
			await assert.rejects(appendRequestLog(root, [good, item]));
		}
		await assert.rejects(readFile(logPath(root, '2026-10-29'), 'utf8'));
	});
});
