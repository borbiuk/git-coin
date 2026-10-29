// Daily CSV files and the request log (ADR 0004 D1, D3, D6, D7). Append-only: an existing line is never rewritten.
import { mkdir, open, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseIso } from './time.ts';
import { SRC_CODE } from './types.ts';
import type { PricePoint, PriceRow, RequestLogRow, SrcCode } from './types.ts';

const PRICE_HEADER = 'ts,price,src,age_s';
const LOG_HEADER = 'ts,src,http,ms,coins_ok,error';
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const COIN_RE = /^[A-Za-z0-9]{1,20}$/;
const INTEGER_RE = /^-?\d+$/;
const SRC_CODES = new Set<string>([...Object.values(SRC_CODE), 'kr-ohlc']);

function isNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isSrcCode(value: string): value is SrcCode {
	return SRC_CODES.has(value);
}

function assertIso(ts: string): void {
	if (!ISO_RE.test(ts) || Number.isNaN(Date.parse(ts))) {
		throw new Error(`Bad ts, expected YYYY-MM-DDTHH:MM:SSZ: ${ts}`);
	}
}

/** A field must never break the line: no comma and no line break. */
function assertSafeField(name: string, value: string): void {
	if (/[,\r\n]/.test(value)) {
		throw new Error(
			`Bad ${name}: a CSV field cannot hold a comma or a line break`
		);
	}
}

function coinFileName(coin: string): string {
	if (!COIN_RE.test(coin)) {
		throw new Error(`Bad coin id: ${coin}`);
	}
	return `${coin.toUpperCase()}.csv`;
}

function datePath(ts: string): string[] {
	assertIso(ts);
	return [ts.slice(0, 4), ts.slice(5, 7), ts.slice(8, 10)];
}

/** `<dataRoot>/data/raw/YYYY/MM/DD/<ID>.csv`, the UTC day of `ts`, the upper-case coin id. */
export function dailyPath(dataRoot: string, coin: string, ts: string): string {
	return path.join(
		dataRoot,
		'data',
		'raw',
		...datePath(ts),
		coinFileName(coin)
	);
}

function requestLogPath(dataRoot: string, ts: string): string {
	return path.join(dataRoot, 'data', 'meta', ...datePath(ts), 'requests.csv');
}

function parseRowLine(line: string): PricePoint | null {
	const parts = line.split(',');
	if (parts.length !== 4) {
		return null;
	}
	const [ts = '', price = '', src = '', age = ''] = parts;
	if (!ISO_RE.test(ts) || Number.isNaN(Date.parse(ts))) {
		return null;
	}
	if (price === '' || !Number.isFinite(Number(price))) {
		return null;
	}
	if (!isSrcCode(src)) {
		return null;
	}
	if (age !== '' && !INTEGER_RE.test(age)) {
		return null;
	}
	return { ts, price, src, age_s: age === '' ? null : Number(age) };
}

/** Reads one daily file. A missing file is empty. The header and blank lines are not counted as malformed. */
export async function readDailyPoints(
	file: string
): Promise<{ points: PricePoint[]; malformed: number }> {
	let text: string;
	try {
		text = await readFile(file, 'utf8');
	} catch (error) {
		if (isNotFound(error)) {
			return { points: [], malformed: 0 };
		}
		throw error;
	}
	const points: PricePoint[] = [];
	let malformed = 0;
	for (const raw of text.split('\n')) {
		const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
		if (line === '' || line === PRICE_HEADER) {
			continue;
		}
		const point = parseRowLine(line);
		if (point === null) {
			malformed += 1;
		} else {
			points.push(point);
		}
	}
	return { points, malformed };
}

/** Names in a directory that match `pattern`, newest (largest) first. A missing directory is empty. */
async function listDescending(dir: string, pattern: RegExp): Promise<string[]> {
	try {
		const names = await readdir(dir);
		return names
			.filter((name) => pattern.test(name))
			.sort()
			.reverse();
	} catch (error) {
		if (isNotFound(error)) {
			return [];
		}
		throw error;
	}
}

/** The newest stored row of one coin and one `src`, searching the daily files from the latest day backwards. */
export async function readLastRow(
	dataRoot: string,
	coin: string,
	src: SrcCode
): Promise<PricePoint | null> {
	const fileName = coinFileName(coin);
	const rawDir = path.join(dataRoot, 'data', 'raw');
	for (const year of await listDescending(rawDir, /^\d{4}$/)) {
		const yearDir = path.join(rawDir, year);
		for (const month of await listDescending(yearDir, /^\d{2}$/)) {
			const monthDir = path.join(yearDir, month);
			for (const day of await listDescending(monthDir, /^\d{2}$/)) {
				const { points } = await readDailyPoints(
					path.join(monthDir, day, fileName)
				);
				for (let i = points.length - 1; i >= 0; i -= 1) {
					const point = points[i];
					if (point !== undefined && point.src === src) {
						return point;
					}
				}
			}
		}
	}
	return null;
}

/**
 * Appends lines in one write. A new file gets the header first. If the file does not end with a
 * line break (a cut write), a line break is added first, so no existing byte changes.
 */
async function appendLines(
	file: string,
	header: string,
	lines: string[]
): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const handle = await open(file, 'a+');
	try {
		const { size } = await handle.stat();
		let prefix = '';
		if (size === 0) {
			prefix = `${header}\n`;
		} else {
			const last = Buffer.alloc(1);
			await handle.read(last, 0, 1, size - 1);
			prefix = last[0] === 0x0a ? '' : '\n';
		}
		await handle.write(`${prefix}${lines.join('\n')}\n`);
	} finally {
		await handle.close();
	}
}

function formatRow(row: PriceRow): string {
	assertIso(row.ts);
	assertSafeField('price', row.price);
	if (row.price === '') {
		throw new Error('Bad price: empty');
	}
	if (!isSrcCode(row.src)) {
		throw new Error(`Bad src: ${row.src}`);
	}
	if (row.age_s !== null && !Number.isInteger(row.age_s)) {
		throw new Error(`Bad age_s: ${row.age_s}`);
	}
	return `${row.ts},${row.price},${row.src},${row.age_s === null ? '' : row.age_s}`;
}

/**
 * Appends rows to the daily files. Per coin and per `src`, a row is skipped when its `ts` is earlier
 * than the last stored one (`clock`) or less than `minSpacingSeconds` after it (`spacing`).
 * Every row is checked before anything is written.
 */
export async function appendRows(
	dataRoot: string,
	rows: PriceRow[],
	opts: { minSpacingSeconds: number }
): Promise<{
	written: PriceRow[];
	skipped: Array<{ row: PriceRow; reason: 'spacing' | 'clock' }>;
}> {
	if (
		!Number.isFinite(opts.minSpacingSeconds) ||
		opts.minSpacingSeconds < 0
	) {
		throw new Error(`Bad minSpacingSeconds: ${opts.minSpacingSeconds}`);
	}
	const spacingMs = opts.minSpacingSeconds * 1000;
	const formatted = rows.map((row) => {
		return {
			row,
			line: formatRow(row),
			file: dailyPath(dataRoot, row.coin, row.ts),
		};
	});

	const lastByKey = new Map<string, number | null>();
	const linesByFile = new Map<string, string[]>();
	const written: PriceRow[] = [];
	const skipped: Array<{ row: PriceRow; reason: 'spacing' | 'clock' }> = [];

	for (const { row, line, file } of formatted) {
		const key = `${row.coin.toUpperCase()}|${row.src}`;
		let last = lastByKey.get(key);
		if (last === undefined) {
			const stored = await readLastRow(dataRoot, row.coin, row.src);
			last = stored === null ? null : parseIso(stored.ts);
			lastByKey.set(key, last);
		}
		const now = parseIso(row.ts);
		if (last !== null && now < last) {
			skipped.push({ row, reason: 'clock' });
			continue;
		}
		if (last !== null && now - last < spacingMs) {
			skipped.push({ row, reason: 'spacing' });
			continue;
		}
		lastByKey.set(key, now);
		written.push(row);
		const lines = linesByFile.get(file);
		if (lines === undefined) {
			linesByFile.set(file, [line]);
		} else {
			lines.push(line);
		}
	}

	for (const [file, lines] of linesByFile) {
		await appendLines(file, PRICE_HEADER, lines);
	}
	return { written, skipped };
}

function formatLogRow(row: RequestLogRow): string {
	assertIso(row.ts);
	if (!isSrcCode(row.src)) {
		throw new Error(`Bad src: ${row.src}`);
	}
	for (const [name, value] of [
		['http', row.http],
		['ms', row.ms],
		['coins_ok', row.coins_ok],
	] as const) {
		if (!Number.isInteger(value) || value < 0) {
			throw new Error(`Bad ${name}: ${value}`);
		}
	}
	assertSafeField('error', row.error);
	return `${row.ts},${row.src},${row.http},${row.ms},${row.coins_ok},${row.error}`;
}

/** Appends one line per source and run to `data/meta/YYYY/MM/DD/requests.csv`. */
export async function appendRequestLog(
	dataRoot: string,
	rows: RequestLogRow[]
): Promise<void> {
	const linesByFile = new Map<string, string[]>();
	for (const row of rows) {
		const line = formatLogRow(row);
		const file = requestLogPath(dataRoot, row.ts);
		const lines = linesByFile.get(file);
		if (lines === undefined) {
			linesByFile.set(file, [line]);
		} else {
			lines.push(line);
		}
	}
	for (const [file, lines] of linesByFile) {
		await appendLines(file, LOG_HEADER, lines);
	}
}
