// Health of a data checkout: when each source last answered, how many ticks it logged per day, how many failed,
// the longest gap, and the newest price of every coin. Gaps are normal (ADR 0005); this shows how big they are.
// Reads the same layout as tools/analyze-sources.ts. Run: node tools/data-health.ts --data-root data [--days 3] [--json]
import { parseArgs } from 'node:util';

import { isoSeconds } from '../src/time.ts';
import { SRC_CODE, type SrcCode } from '../src/types.ts';

import { loadData, type AnalysisData } from './analyze-sources.ts';

const SOURCES: SrcCode[] = [
	SRC_CODE.kraken,
	SRC_CODE.coinbase,
	SRC_CODE.bitstamp,
	SRC_CODE.coinmetrics,
];

const DAY_MS = 86400000;

export interface DayHealth {
	day: string;
	ticks: number;
	failed: number;
}

export interface SourceHealth {
	src: SrcCode;
	last_tick: string | null;
	last_tick_age_min: number | null;
	ticks: number;
	failed: number;
	longest_gap_min: number | null;
	per_day: DayHealth[];
}

export interface CoinHealth {
	coin: string;
	last_price_at: string;
	last_price_age_min: number;
}

export interface HealthReport {
	generated_at: string;
	days: number;
	sources: SourceHealth[];
	coins: CoinHealth[];
	skipped_lines: number;
}

interface Io {
	out: (text: string) => void;
	err: (text: string) => void;
}

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

function isFailedTick(http: number, error: string): boolean {
	return http !== 200 || error !== '';
}

/** Measures the last `days` days up to `nowMs`. A tick is one row of the request log. */
export function analyzeHealth(
	data: AnalysisData,
	nowMs: number,
	days: number
): HealthReport {
	const fromMs = nowMs - days * DAY_MS;

	const sources: SourceHealth[] = SOURCES.map((src) => {
		const ticks = data.log
			.filter((row) => row.src === src)
			.map((row) => ({ row, ms: Date.parse(row.ts) }))
			.filter((item) => !Number.isNaN(item.ms) && item.ms <= nowMs)
			.sort((a, b) => a.ms - b.ms);
		const last = ticks[ticks.length - 1];
		const inWindow = ticks.filter((item) => item.ms >= fromMs);

		let longest: number | null = null;
		for (let i = 1; i < inWindow.length; i++) {
			const gap =
				((inWindow[i]?.ms ?? 0) - (inWindow[i - 1]?.ms ?? 0)) / 60000;
			longest = longest === null ? gap : Math.max(longest, gap);
		}
		// The silence since the last tick counts as a gap too
		const lastInWindow = inWindow[inWindow.length - 1];
		if (lastInWindow !== undefined) {
			longest = Math.max(longest ?? 0, (nowMs - lastInWindow.ms) / 60000);
		}

		const perDay = new Map<string, DayHealth>();
		for (const { row } of inWindow) {
			const day = row.ts.slice(0, 10);
			const entry = perDay.get(day) ?? { day, ticks: 0, failed: 0 };
			entry.ticks += 1;
			if (isFailedTick(row.http, row.error)) {
				entry.failed += 1;
			}
			perDay.set(day, entry);
		}

		return {
			src,
			last_tick:
				last === undefined ? null : isoSeconds(new Date(last.ms)),
			last_tick_age_min:
				last === undefined ? null : round1((nowMs - last.ms) / 60000),
			ticks: inWindow.length,
			failed: [...perDay.values()].reduce((sum, d) => sum + d.failed, 0),
			longest_gap_min: longest === null ? null : round1(longest),
			per_day: [...perDay.values()].sort((a, b) =>
				a.day.localeCompare(b.day)
			),
		};
	});

	const newest = new Map<string, number>();
	for (const row of data.rows) {
		const ms = Date.parse(row.ts);
		if (!Number.isNaN(ms) && ms > (newest.get(row.coin) ?? 0)) {
			newest.set(row.coin, ms);
		}
	}
	const coins: CoinHealth[] = [...newest.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([coin, ms]) => ({
			coin,
			last_price_at: isoSeconds(new Date(ms)),
			last_price_age_min: round1((nowMs - ms) / 60000),
		}));

	return {
		generated_at: isoSeconds(new Date(nowMs)),
		days,
		sources,
		coins,
		skipped_lines: data.skipped_lines,
	};
}

export function renderText(report: HealthReport): string {
	const lines = [
		`Data health at ${report.generated_at} (last ${report.days} days)`,
		'',
		`${'Source'.padEnd(8)}${'Last tick (age, min)'.padEnd(37)}Ticks  Failed  Longest gap (min)`,
	];
	for (const source of report.sources) {
		const last =
			source.last_tick === null
				? 'n/a'
				: `${source.last_tick} (${source.last_tick_age_min})`;
		lines.push(
			`${source.src.padEnd(8)}${last.padEnd(37)}${String(source.ticks).padEnd(7)}${String(source.failed).padEnd(8)}${source.longest_gap_min ?? 'n/a'}`
		);
		for (const day of source.per_day) {
			lines.push(
				`        ${day.day}: ${day.ticks} ticks, ${day.failed} failed`
			);
		}
	}
	lines.push('', 'Coin    Newest price (age, min)');
	for (const coin of report.coins) {
		lines.push(
			`${coin.coin.padEnd(8)}${coin.last_price_at} (${coin.last_price_age_min})`
		);
	}
	if (report.skipped_lines > 0) {
		lines.push(
			'',
			`Skipped lines that did not parse: ${report.skipped_lines}`
		);
	}
	return lines.join('\n');
}

const USAGE = `Usage: node tools/data-health.ts [--data-root <dir>] [--days <days>] [--now <iso>] [--json]

  --data-root <dir>   a checkout of the data branch, default data
  --days <days>       how many days back to count ticks, default 3
  --now <iso>         the current time, for a reproducible report
  --json              print JSON instead of text
  --help              print this text
`;

/** Runs the tool. Returns the exit code: 0 on success, 1 on bad input or when there is no data. */
export async function main(argv: string[], io: Io): Promise<number> {
	let values: Record<string, string | boolean | undefined>;
	try {
		values = parseArgs({
			args: argv,
			options: {
				'data-root': { type: 'string' },
				days: { type: 'string' },
				now: { type: 'string' },
				json: { type: 'boolean' },
				help: { type: 'boolean' },
			},
		}).values;
	} catch (error) {
		io.err(`${(error as Error).message}\n\n${USAGE}`);
		return 1;
	}
	if (values.help === true) {
		io.out(USAGE);
		return 0;
	}

	const days = typeof values.days === 'string' ? Number(values.days) : 3;
	if (!Number.isFinite(days) || days <= 0) {
		io.err('--days needs a number above zero\n');
		return 1;
	}
	const nowMs =
		typeof values.now === 'string' ? Date.parse(values.now) : Date.now();
	if (Number.isNaN(nowMs)) {
		io.err(`--now needs an ISO time, got "${String(values.now)}"\n`);
		return 1;
	}

	const dataRoot =
		typeof values['data-root'] === 'string' ? values['data-root'] : 'data';
	const data = await loadData(dataRoot);
	if (data.rows.length === 0 && data.log.length === 0) {
		io.err(
			`No price rows or request log rows found under ${dataRoot}/data\n`
		);
		return 1;
	}
	const report = analyzeHealth(data, nowMs, days);
	io.out(
		values.json === true
			? `${JSON.stringify(report, null, 2)}\n`
			: `${renderText(report)}\n`
	);
	return 0;
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2), {
		out: (text) => process.stdout.write(text),
		err: (text) => process.stderr.write(text),
	});
}
