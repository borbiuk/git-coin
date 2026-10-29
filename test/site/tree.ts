// Helpers for the site builder tests: synthetic CSV trees in a temp directory.
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'site');

export async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'git-coin-site-'));
}

export async function removeDir(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
}

/** Writes `data/raw/YYYY/MM/DD/<COIN>.csv` with the header and the given lines (`ts,price,src,age_s`). */
export async function writeDay(
	dataRoot: string,
	coin: string,
	day: string,
	lines: string[]
): Promise<void> {
	const [year, month, date] = day.split('-');
	const dir = join(dataRoot, 'data', 'raw', year, month, date);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, `${coin}.csv`),
		['ts,price,src,age_s', ...lines].join('\n') + '\n'
	);
}

/** Copies a fixture file into `state/` of the data root. */
export async function copyState(
	dataRoot: string,
	fixture: string,
	name: string
): Promise<void> {
	await mkdir(join(dataRoot, 'state'), { recursive: true });
	await cp(join(FIXTURES, fixture), join(dataRoot, 'state', name));
}

export function epoch(iso: string): number {
	return Date.parse(iso) / 1000;
}
