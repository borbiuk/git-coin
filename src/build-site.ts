// Builds the derived JSON of the dashboard from the data checkout (ADR 0008 D2, plan section 3.4).
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { hasSource, loadConfig, primarySource } from './config.ts';
import { createSeriesReader } from './series.ts';
import {
	NINETY_DAYS_SECONDS,
	PERIODS,
	SEVEN_DAYS_SECONDS,
	clipSpans,
	convertSamples,
	dailyCandles,
	emptyPoints,
	hourlyPoints,
	loadSamples,
	periodStats,
	recentPoints,
	sourcePoints,
	joinHistory,
	mergeHistory,
} from './site/derive.ts';
import type { Sample, Span } from './site/derive.ts';
import { findFirstDay } from './site/first-day.ts';
import { readAlertsFile, readStatusFile } from './site/state-files.ts';
import { isoSeconds, parseIso } from './time.ts';
import { SRC_CODE } from './types.ts';
import type {
	CoinConfig,
	Config,
	DerivedLatest,
	SeriesPoints,
	SrcCode,
} from './types.ts';

/** The sources of candle closes, in order of priority when two have the same time. */
const HISTORY_SRCS: SrcCode[] = [
	'cb-ohlc',
	'kt-ohlc',
	'bs-ohlc',
	'ok-ohlc',
	'kr-ohlc',
];

const SAFE_COIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function writeJson(path: string, value: unknown): Promise<void> {
	// Write and rename, so a reader never sees half a file
	const temp = `${path}.tmp`;
	await writeFile(temp, `${JSON.stringify(value)}\n`);
	await rename(temp, path);
}

/** The series with the spans of filled gaps that lie in its time range. No span, no field. */
function withFilled(
	series: SeriesPoints,
	filled: Span[],
	fromSec: number
): SeriesPoints {
	const spans = clipSpans(filled, fromSec);
	return spans.length === 0 ? series : { ...series, filled: spans };
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
	// The default source. A coin that is missing on it uses the first stored source that has the coin.
	const defaultSrc = SRC_CODE[primary];
	const srcOf = (coin: CoinConfig): SrcCode => {
		const own = primarySource(config, coin);
		return own === null ? defaultSrc : SRC_CODE[own];
	};
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
		src: defaultSrc,
		coins: {},
	};
	// The history and the live rows of one entry, joined in time order. `until` is where the live rows begin.
	// `filled` is the time of missed runs that the collector filled with candles.
	let historyUntil = null as string | null;
	let historySrc: SrcCode | null = null;
	async function readJoined(
		coin: CoinConfig
	): Promise<{ samples: Sample[]; filled: Span[] }> {
		if (firstDay === null) {
			return { samples: [], filled: [] };
		}
		const from = `${firstDay}T00:00:00Z`;
		const live = await loadSamples(reader, coin.id, from, now, srcOf(coin));
		// The candle sources of a coin, in order of priority (ADR 0004 D1, ADR 0007 D8)
		const bySrc = new Map<SrcCode, Sample[]>();
		for (const code of HISTORY_SRCS) {
			let samples = await loadSamples(reader, coin.id, from, now, code);
			// OKX prices are in USDT. With no rate entry they cannot be shown in USD.
			if (code === 'ok-ohlc' && rateCoin === undefined) {
				samples = [];
			}
			bySrc.set(code, samples);
		}
		const history = mergeHistory(
			HISTORY_SRCS.map((code) => bySrc.get(code) ?? [])
		);
		const joined = joinHistory(history, live);
		const until = live[0]?.ts ?? history[history.length - 1]?.ts;
		if (joined.samples.length > live.length && until !== undefined) {
			historyUntil =
				historyUntil === null || until < historyUntil
					? until
					: historyUntil;
			historySrc ??=
				HISTORY_SRCS.find(
					(code) => (bySrc.get(code)?.length ?? 0) > 0
				) ?? null;
		}
		return joined;
	}
	const rates =
		rateCoin === undefined ? [] : (await readJoined(rateCoin)).samples;

	for (const coin of config.coins) {
		if (!SAFE_COIN_ID.test(coin.id)) {
			throw new Error(`Coin id is not safe for a file name: ${coin.id}`);
		}
		if (coin.role === 'rate') {
			continue;
		}
		const { samples: loaded, filled } = await readJoined(coin);
		const samples =
			rateCoin === undefined ? loaded : convertSamples(loaded, rates);
		// A disabled coin with no rows has nothing to show; a disabled coin with rows stays as an archive
		if (samples.length === 0 && !coin.enabled) {
			continue;
		}

		const src = srcOf(coin);
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
		const weekFrom = nowSec - SEVEN_DAYS_SECONDS;
		const week =
			samples.length === 0
				? emptyPoints(coin.id, src)
				: recentPoints(coin.id, src, samples, weekFrom);
		await writeJson(`${base}.7d.json`, withFilled(week, filled, weekFrom));
		// The source comparison exists only while more than one source is stored (ADR 0002)
		if (config.settings.stored_sources.length > 1) {
			const weekStart = nowSec - SEVEN_DAYS_SECONDS;
			const bySource = [];
			for (const id of config.settings.stored_sources) {
				const code = SRC_CODE[id];
				if (!hasSource(coin, id)) {
					continue;
				}
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
		const quarterFrom = nowSec - NINETY_DAYS_SECONDS;
		await writeJson(
			`${base}.90d.json`,
			withFilled(
				hourlyPoints(coin.id, src, samples, quarterFrom),
				filled,
				quarterFrom
			)
		);
		await writeJson(
			`${base}.daily.json`,
			dailyCandles(coin.id, src, samples)
		);
	}

	if (historyUntil !== null && historySrc !== null) {
		latest.history = { src: historySrc, until: historyUntil };
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
