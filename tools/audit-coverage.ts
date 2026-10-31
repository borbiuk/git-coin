// Coverage of the price history: how many 15-minute intervals and hours of each coin have at least one price.
// The count runs over every source and over the whole range from `--from`, so a coin whose history is short
// shows a low share. A coin that was listed after `--from` stays below 100% for good. tools/backfill.ts uses
// the share to pick the coins that need more history.
// Run: node tools/audit-coverage.ts --data-root <checkout of the data branch> [--from <iso>] [--coins BTC,ETH]

import { parseArgs } from 'node:util';

import { loadConfig } from '../src/config.ts';
import { dailyPath, readDailyPoints } from '../src/csv.ts';
import { isoSeconds, parseIso } from '../src/time.ts';

const DAY_SECONDS = 86_400;
const STEP_SECONDS = 900;
const DEFAULT_FROM = '2024-01-01T00:00:00Z';

export interface Coverage {
	coin: string;
	/** First row of the coin at or after the start, epoch seconds. `null`: no row. */
	firstSec: number | null;
	rowsBySrc: Record<string, number>;
	/** Share of the 15-minute intervals from the start of the range to the end that have a price (0 to 1). */
	share15: number;
	/** The same for hours. */
	shareHour: number;
}

/** Reads the daily files of one coin from `fromSec` up to `toSec` and counts the intervals with a price. */
export async function coverageOf(
	dataRoot: string,
	coin: string,
	fromSec: number,
	toSec: number
): Promise<Coverage> {
	const bins15 = new Set<number>();
	const hours = new Set<number>();
	const rowsBySrc: Record<string, number> = {};
	let firstSec: number | null = null;
	for (
		let day = Math.floor(fromSec / DAY_SECONDS) * DAY_SECONDS;
		day < toSec;
		day += DAY_SECONDS
	) {
		const file = dailyPath(
			dataRoot,
			coin,
			isoSeconds(new Date(day * 1000))
		);
		const { points } = await readDailyPoints(file);
		for (const point of points) {
			const sec = parseIso(point.ts) / 1000;
			if (sec < fromSec || sec >= toSec) {
				continue;
			}
			rowsBySrc[point.src] = (rowsBySrc[point.src] ?? 0) + 1;
			bins15.add(Math.floor(sec / STEP_SECONDS));
			hours.add(Math.floor(sec / 3600));
			firstSec = firstSec === null ? sec : Math.min(firstSec, sec);
		}
	}
	if (firstSec === null) {
		return { coin, firstSec, rowsBySrc, share15: 0, shareHour: 0 };
	}
	const total15 = Math.max(
		1,
		Math.floor(toSec / STEP_SECONDS) - Math.floor(fromSec / STEP_SECONDS)
	);
	const totalHours = Math.max(
		1,
		Math.floor(toSec / 3600) - Math.floor(fromSec / 3600)
	);
	return {
		coin,
		firstSec,
		rowsBySrc,
		share15: Math.min(1, bins15.size / total15),
		shareHour: Math.min(1, hours.size / totalHours),
	};
}

function percent(share: number): string {
	return `${(share * 100).toFixed(1)}%`.padStart(6);
}

/** One line per coin, for the terminal. */
export function formatCoverage(item: Coverage): string {
	const first =
		item.firstSec === null
			? 'no rows'
			: isoSeconds(new Date(item.firstSec * 1000)).slice(0, 10);
	const rows = Object.entries(item.rowsBySrc)
		.map(([src, count]) => `${src}:${count}`)
		.join(' ');
	return `${item.coin.padEnd(6)} from ${first}  15 min ${percent(item.share15)}  hour ${percent(item.shareHour)}  ${rows}`;
}

async function main(): Promise<number> {
	const { values } = parseArgs({
		options: {
			'data-root': { type: 'string' },
			config: { type: 'string', default: 'config/coins.json' },
			from: { type: 'string', default: DEFAULT_FROM },
			coins: { type: 'string' },
		},
	});
	if (values['data-root'] === undefined) {
		console.error(
			'Usage: node tools/audit-coverage.ts --data-root <dir> [--from <iso>] [--coins BTC,ETH]'
		);
		return 1;
	}
	const config = await loadConfig(values.config);
	const only = values.coins?.split(',') ?? null;
	const fromSec = parseIso(values.from) / 1000;
	const toSec = Math.floor(Date.now() / 1000);
	for (const coin of config.coins) {
		if (!coin.enabled || (only !== null && !only.includes(coin.id))) {
			continue;
		}
		const item = await coverageOf(
			values['data-root'],
			coin.id,
			fromSec,
			toSec
		);
		console.log(formatCoverage(item));
	}
	return 0;
}

if (import.meta.main) {
	process.exitCode = await main();
}
