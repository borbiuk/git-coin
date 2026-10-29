// Builds the derived JSON of the dashboard from the data checkout (ADR 0008 D2, plan section 3.4).
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { loadConfig } from './config.ts';
import { createSeriesReader } from './series.ts';
import {
	NINETY_DAYS_SECONDS,
	PERIODS,
	SEVEN_DAYS_SECONDS,
	convertSamples,
	dailyCandles,
	emptyPoints,
	hourlyPoints,
	loadSamples,
	periodStats,
	recentPoints,
	sourcePoints,
} from './site/derive.ts';
import { findFirstDay } from './site/first-day.ts';
import { readAlertsFile, readStatusFile } from './site/state-files.ts';
import { isoSeconds, parseIso } from './time.ts';
import { SRC_CODE } from './types.ts';
import type { Config, DerivedLatest } from './types.ts';

const SAFE_COIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function writeJson(path: string, value: unknown): Promise<void> {
	// Write and rename, so a reader never sees half a file
	const temp = `${path}.tmp`;
	await writeFile(temp, `${JSON.stringify(value)}\n`);
	await rename(temp, path);
}

export async function buildSite(opts: {
	dataRoot: string;
	config: Config;
	outDir: string;
	now: Date;
}): Promise<void> {
	const { dataRoot, config, outDir, now } = opts;
	const primary = config.settings.stored_sources[0];
	if (primary === undefined) {
		throw new Error('settings.stored_sources is empty.');
	}
	const src = SRC_CODE[primary];
	const generatedAt = isoSeconds(now);
	const nowSec = Math.floor(now.getTime() / 1000);

	await mkdir(join(outDir, 'coins'), { recursive: true });

	const reader = createSeriesReader(dataRoot);
	const firstDay = await findFirstDay(dataRoot);
	// An enabled rate entry (USDT) is not shown: its USD price converts every other price
	const rateCoin = config.coins.find(
		(coin) => coin.role === 'rate' && coin.enabled
	);
	const latest: DerivedLatest = {
		generated_at: generatedAt,
		quote: rateCoin?.id ?? 'USD',
		src,
		coins: {},
	};
	const rates =
		rateCoin === undefined || firstDay === null
			? []
			: await loadSamples(
					reader,
					rateCoin.id,
					`${firstDay}T00:00:00Z`,
					now,
					src
				);

	for (const coin of config.coins) {
		if (!SAFE_COIN_ID.test(coin.id)) {
			throw new Error(`Coin id is not safe for a file name: ${coin.id}`);
		}
		if (coin.role === 'rate') {
			continue;
		}
		const loaded =
			firstDay === null
				? []
				: await loadSamples(
						reader,
						coin.id,
						`${firstDay}T00:00:00Z`,
						now,
						src
					);
		const samples =
			rateCoin === undefined ? loaded : convertSamples(loaded, rates);
		// A disabled coin with no rows has nothing to show; a disabled coin with rows stays as an archive
		if (samples.length === 0 && !coin.enabled) {
			continue;
		}

		const last = samples[samples.length - 1];
		if (last !== undefined) {
			latest.coins[coin.id] = {
				name: coin.name,
				price: last.p,
				ts: last.ts,
				periods: {
					'24h': periodStats(samples, nowSec, PERIODS['24h']),
					'7d': periodStats(samples, nowSec, PERIODS['7d']),
					'30d': periodStats(samples, nowSec, PERIODS['30d']),
				},
			};
		}

		const base = join(outDir, 'coins', coin.id);
		await writeJson(
			`${base}.7d.json`,
			samples.length === 0
				? emptyPoints(coin.id, src)
				: recentPoints(
						coin.id,
						src,
						samples,
						nowSec - SEVEN_DAYS_SECONDS
					)
		);
		// The source comparison exists only while more than one source is stored (ADR 0002)
		if (config.settings.stored_sources.length > 1) {
			const weekStart = nowSec - SEVEN_DAYS_SECONDS;
			const bySource = [];
			for (const id of config.settings.stored_sources) {
				const code = SRC_CODE[id];
				// The other sources are converted with the same (primary) rate, so the lines differ only by the source
				const others =
					code === src
						? samples
						: await loadSamples(
								reader,
								coin.id,
								isoSeconds(new Date(weekStart * 1000)),
								now,
								code
							);
				bySource.push({
					src: code,
					samples:
						code === src || rateCoin === undefined
							? others
							: convertSamples(others, rates),
				});
			}
			await writeJson(
				`${base}.sources.json`,
				sourcePoints(coin.id, bySource, weekStart)
			);
		}
		await writeJson(
			`${base}.90d.json`,
			hourlyPoints(coin.id, src, samples, nowSec - NINETY_DAYS_SECONDS)
		);
		await writeJson(
			`${base}.daily.json`,
			dailyCandles(coin.id, src, samples)
		);
	}

	await writeJson(join(outDir, 'latest.json'), latest);
	await writeJson(
		join(outDir, 'status.json'),
		await readStatusFile(dataRoot, config.settings.phase, generatedAt)
	);
	await writeJson(
		join(outDir, 'alerts.json'),
		await readAlertsFile(dataRoot, generatedAt)
	);
}

async function main(argv: string[]): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: {
			config: { type: 'string' },
			'data-root': { type: 'string' },
			out: { type: 'string' },
			now: { type: 'string' },
		},
		strict: true,
	});
	const configPath = values.config;
	const dataRoot = values['data-root'];
	const out = values.out;
	if (
		configPath === undefined ||
		dataRoot === undefined ||
		out === undefined
	) {
		throw new Error(
			'Usage: node src/build-site.ts --config <file> --data-root <dir> --out <dir> [--now <iso>]'
		);
	}
	const now =
		values.now === undefined ? new Date() : new Date(parseIso(values.now));
	await buildSite({
		dataRoot: resolve(dataRoot),
		config: await loadConfig(resolve(configPath)),
		outDir: resolve(out),
		now,
	});
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
