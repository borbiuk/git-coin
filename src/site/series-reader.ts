// A small reader of the daily CSV files (ADR 0004 D1). The collector has its own reader in src/series.ts (agent A6);
// the site builder keeps this one so that it needs nothing but the shared types.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PricePoint, SeriesReader, SrcCode } from '../types.ts';

const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DAY_MS = 86_400_000;

function isMissingFile(error: unknown): boolean {
	const code = (error as { code?: string }).code;
	return code === 'ENOENT' || code === 'ENOTDIR';
}

/** One CSV line to a point, or null for the header and for a malformed line. */
function parseLine(line: string, src: SrcCode): PricePoint | null {
	const parts = line.trim().split(',');
	if (parts.length < 3) {
		return null;
	}
	const [ts, price, lineSrc, ageText] = parts;
	if (lineSrc !== src || !ISO_SECONDS.test(ts)) {
		return null;
	}
	if (price === '' || !Number.isFinite(Number(price))) {
		return null;
	}
	const age = ageText === undefined || ageText === '' ? NaN : Number(ageText);
	return { ts, price, src, age_s: Number.isFinite(age) ? age : null };
}

function dayPath(dataRoot: string, coin: string, day: string): string {
	const [year, month, date] = day.split('-');
	return join(dataRoot, 'data', 'raw', year, month, date, `${coin}.csv`);
}

export function createFileSeriesReader(dataRoot: string): SeriesReader {
	return {
		async readSeries(coin, fromIso, toIso, src) {
			const fromMs = Date.parse(fromIso);
			const toMs = Date.parse(toIso);
			const points: PricePoint[] = [];
			if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs >= toMs) {
				return points;
			}
			const firstDayMs = Math.floor(fromMs / DAY_MS) * DAY_MS;
			for (let dayMs = firstDayMs; dayMs < toMs; dayMs += DAY_MS) {
				const day = new Date(dayMs).toISOString().slice(0, 10);
				let text: string;
				try {
					text = await readFile(dayPath(dataRoot, coin, day), 'utf8');
				} catch (error) {
					if (isMissingFile(error)) {
						continue;
					}
					throw error;
				}
				for (const line of text.split('\n')) {
					const point = parseLine(line, src);
					if (
						point !== null &&
						point.ts >= fromIso &&
						point.ts < toIso
					) {
						points.push(point);
					}
				}
			}
			// Lines are appended in time order, but a hand-edited file must not break the sort
			points.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
			return points;
		},
	};
}

async function listNames(dir: string, pattern: RegExp): Promise<string[]> {
	try {
		const names = await readdir(dir);
		return names.filter((name) => pattern.test(name)).sort();
	} catch (error) {
		if (isMissingFile(error)) {
			return [];
		}
		throw error;
	}
}

/** The first UTC day (`YYYY-MM-DD`) that has a data directory, or null when there is no data. */
export async function findFirstDay(dataRoot: string): Promise<string | null> {
	const raw = join(dataRoot, 'data', 'raw');
	for (const year of await listNames(raw, /^\d{4}$/)) {
		for (const month of await listNames(join(raw, year), /^\d{2}$/)) {
			const days = await listNames(join(raw, year, month), /^\d{2}$/);
			if (days.length > 0) {
				return `${year}-${month}-${days[0]}`;
			}
		}
	}
	return null;
}
