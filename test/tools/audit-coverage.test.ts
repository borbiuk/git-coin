import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { coverageOf, formatCoverage } from '../../tools/audit-coverage.ts';

// 2026-10-01T00:00:00Z
const START = 1_790_812_800;

let root = '';

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'git-coin-audit-'));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function iso(sec: number): string {
	return new Date(sec * 1000).toISOString().replace('.000Z', 'Z');
}

async function writeDay(coin: string, lines: string[]): Promise<void> {
	const dir = join(root, 'data', 'raw', '2026', '10', '01');
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, `${coin}.csv`),
		`ts,price,src,age_s\n${lines.join('\n')}\n`
	);
}

test('coverageOf counts the 15 minute intervals and the hours that have a price, over the whole range', async () => {
	// 24 closes in the first 6 hours of the day: one for each of 24 intervals
	await writeDay(
		'KSM',
		Array.from(
			{ length: 24 },
			(_, i) => `${iso(START + (i + 1) * 900)},3.5,cb-ohlc,`
		)
	);
	const found = await coverageOf('' + root, 'KSM', START, START + 86_400);
	assert.deepEqual(found.rowsBySrc, { 'cb-ohlc': 24 });
	assert.equal(found.firstSec, START + 900);
	assert.equal(found.share15, 24 / 96);
	assert.equal(found.shareHour, 7 / 24);
});

test('a coin with no rows has no first row and no coverage', async () => {
	const found = await coverageOf(root, 'KSM', START, START + 86_400);
	assert.equal(found.firstSec, null);
	assert.equal(found.share15, 0);
	assert.equal(
		formatCoverage(found),
		'KSM    from no rows  15 min   0.0%  hour   0.0%  '
	);
});

test('formatCoverage shows the first day, the shares and the rows of each source', async () => {
	await writeDay('KSM', [
		`${iso(START + 900)},3.5,kr-ohlc,`,
		`${iso(START + 1800)},3.6,bs-ohlc,`,
	]);
	const line = formatCoverage(
		await coverageOf(root, 'KSM', START, START + 86_400)
	);
	assert.match(
		line,
		/^KSM\s+from 2026-10-01\s+15 min\s+2\.1%\s+hour\s+4\.2%\s+kr-ohlc:1 bs-ohlc:1$/
	);
});
