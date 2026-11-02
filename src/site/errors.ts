// Reads the request log (data/meta/YYYY/MM/DD/requests.csv) of the last 7 days and counts the failures for the admin page.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isoSeconds } from '../time.ts';
import type {
	DerivedErrors,
	ErrorCode,
	ErrorStats,
	RequestLogRow,
	SrcCode,
} from '../types.ts';

const MAX_RECENT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const ERROR_CODES: ReadonlySet<string> = new Set([
	'timeout',
	'http_429',
	'http_other',
	'parse',
	'unmapped',
]);
const SOURCES: ReadonlySet<string> = new Set(['kr', 'cb', 'bs', 'cm']);
const INTEGER = /^\d+$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** One line of the log, or null when it is not a valid row (a bad line is skipped, never fatal). */
function parseLine(line: string): RequestLogRow | null {
	const parts = line.split(',');
	const [ts = '', src = '', http = '', ms = '', coinsOk = '', error = ''] =
		parts;
	if (
		parts.length !== 6 ||
		!ISO.test(ts) ||
		Number.isNaN(Date.parse(ts)) ||
		!SOURCES.has(src) ||
		!INTEGER.test(http) ||
		!INTEGER.test(ms) ||
		!INTEGER.test(coinsOk) ||
		(error !== '' && !ERROR_CODES.has(error))
	) {
		return null;
	}
	return {
		ts,
		src: src as SrcCode,
		http: Number(http),
		ms: Number(ms),
		coins_ok: Number(coinsOk),
		error: error as ErrorCode | '',
	};
}

function median(values: number[]): number | null {
	if (values.length === 0) {
		return null;
	}
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const high = sorted[mid] ?? 0;
	const low = sorted[mid - 1] ?? high;
	return sorted.length % 2 === 1 ? high : Math.round((low + high) / 2);
}

function count(record: Record<string, number>, key: string): void {
	record[key] = (record[key] ?? 0) + 1;
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
	return Object.fromEntries(
		Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	);
}

function statsOf(rows: RequestLogRow[]): ErrorStats {
	const stats: ErrorStats = {
		requests: rows.length,
		failures: 0,
		by_http: {},
		failures_by_http: {},
		failures_by_error: {},
		median_ms: median(rows.map((row) => row.ms)),
		last_failure_at: null,
	};
	for (const row of rows) {
		count(stats.by_http, String(row.http));
		if (row.error === '') {
			continue;
		}
		stats.failures += 1;
		count(stats.failures_by_http, String(row.http));
		stats.failures_by_error[row.error] =
			(stats.failures_by_error[row.error] ?? 0) + 1;
		if (stats.last_failure_at === null || row.ts > stats.last_failure_at) {
			stats.last_failure_at = row.ts;
		}
	}
	stats.by_http = sortedRecord(stats.by_http);
	stats.failures_by_http = sortedRecord(stats.failures_by_http);
	stats.failures_by_error = sortedRecord(stats.failures_by_error);
	return stats;
}

function bySource(rows: RequestLogRow[]): Partial<Record<SrcCode, ErrorStats>> {
	const groups = new Map<SrcCode, RequestLogRow[]>();
	for (const row of rows) {
		const group = groups.get(row.src);
		if (group === undefined) {
			groups.set(row.src, [row]);
		} else {
			group.push(row);
		}
	}
	const result: Partial<Record<SrcCode, ErrorStats>> = {};
	for (const src of [...groups.keys()].sort()) {
		result[src] = statsOf(groups.get(src) ?? []);
	}
	return result;
}

async function readDay(dataRoot: string, day: Date): Promise<RequestLogRow[]> {
	const [year, month, date] = day.toISOString().slice(0, 10).split('-');
	const path = join(
		dataRoot,
		'data',
		'meta',
		year ?? '',
		month ?? '',
		date ?? '',
		'requests.csv'
	);
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch (error) {
		if ((error as { code?: string }).code === 'ENOENT') {
			return [];
		}
		throw error;
	}
	const rows: RequestLogRow[] = [];
	for (const line of text.split('\n')) {
		const row = line === '' ? null : parseLine(line);
		if (row !== null) {
			rows.push(row);
		}
	}
	return rows;
}

/** Failure counts of the last 24 hours and 7 days. A data root with no log gives empty periods. */
export async function readErrorsFile(
	dataRoot: string,
	now: Date
): Promise<DerivedErrors> {
	const nowMs = now.getTime();
	const weekStart = nowMs - 7 * DAY_MS;
	const rows: RequestLogRow[] = [];
	// A UTC day file can hold rows of the window on both of its ends, so 8 day files are read
	for (let back = 7; back >= 0; back -= 1) {
		rows.push(
			...(await readDay(dataRoot, new Date(nowMs - back * DAY_MS)))
		);
	}
	const week = rows.filter((row) => {
		const ms = Date.parse(row.ts);
		return ms >= weekStart && ms <= nowMs;
	});
	const dayStart = nowMs - DAY_MS;
	const day = week.filter((row) => Date.parse(row.ts) >= dayStart);
	const recent = week
		.filter((row) => row.error !== '')
		.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
		.slice(0, MAX_RECENT);
	return {
		generated_at: isoSeconds(now),
		periods: { '24h': bySource(day), '7d': bySource(week) },
		recent,
	};
}
