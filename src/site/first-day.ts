// Finds where the history starts. `SeriesReader` reads a range only, so the daily file needs this one directory scan.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function listNames(dir: string, pattern: RegExp): Promise<string[]> {
	try {
		const names = await readdir(dir);
		return names.filter((name) => pattern.test(name)).sort();
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') {
			return [];
		}
		throw error;
	}
}

/** The first UTC day (`YYYY-MM-DD`) that has a directory under `data/raw`, or null when there is no data. */
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
