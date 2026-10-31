// Analysis of the four-source test (ADR 0002 Revision 2, points 7 and 8).
// Reads the daily price files and the request log of a data checkout and prints the gate table
// and the score tables. Run: node tools/analyze-sources.ts --data-root data [--json]
import { readdir, readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { parseArgs } from 'node:util';

import { isoSeconds, parseIso } from '../src/time.ts';
import {
	SRC_CODE,
	type ErrorCode,
	type PriceRow,
	type RequestLogRow,
	type SrcCode,
} from '../src/types.ts';

/** The sources of the test, in the order of the tables. Backfill rows (`kr-ohlc`, `bs-ohlc`) are not analysed. */
const TEST_SOURCES: SrcCode[] = [
	SRC_CODE.kraken,
	SRC_CODE.coinbase,
	SRC_CODE.bitstamp,
	SRC_CODE.coinmetrics,
];

const SOURCE_NAMES: Partial<Record<SrcCode, string>> = {
	kr: 'Kraken',
	cb: 'Coinbase Exchange',
	bs: 'Bitstamp',
	cm: 'Coin Metrics',
};

/**
 * Requests one collector run sends to the source. Fixed by the adapter design, not measured:
 * the request log has one row per source per run. Kraken sends the ticker and the pair catalogue.
 */
const REQUESTS_PER_RUN: Partial<Record<SrcCode, number>> = {
	kr: 2,
	cb: 10,
	bs: 1,
	cm: 1,
};

const ERROR_CODES: ReadonlySet<string> = new Set([
	'',
	'timeout',
	'http_429',
	'http_other',
	'parse',
	'unmapped',
]);

/** Statuses that count as "rate limited or blocked". */
const BLOCK_STATUSES: ReadonlySet<number> = new Set([403, 429, 451]);

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;
const INTEGER_PATTERN = /^\d+$/;

export interface Thresholds {
	/** At least this share of ticks must be HTTP 200 with all coins parsed. */
	min_availability_percent: number;
	/** The longest run of failed ticks must not exceed this. */
	max_fail_streak: number;
	/** At most this share of ticks may be HTTP 429 or a block. */
	max_block_percent: number;
	/** The number of coins every tick must deliver. */
	expected_coins: number;
	/** A point is an outlier when it is further than this from the consensus. */
	outlier_percent: number;
	/** Only rows of other sources within this many seconds count for the consensus. */
	window_seconds: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
	min_availability_percent: 98,
	max_fail_streak: 3,
	max_block_percent: 1,
	expected_coins: 10,
	outlier_percent: 1,
	window_seconds: 300,
};

export interface AnalysisData {
	rows: PriceRow[];
	log: RequestLogRow[];
	/** Lines that could not be read. */
	skipped_lines: number;
}

export interface GateRow {
	src: SrcCode;
	ticks: number;
	ok_ticks: number;
	availability_percent: number;
	availability_pass: boolean;
	longest_fail_streak: number;
	streak_pass: boolean;
	coins_seen: number;
	min_coins_per_tick: number | null;
	avg_coins_per_tick: number | null;
	unmapped_ticks: number;
	mapping_pass: boolean;
	blocked_ticks: number;
	block_percent: number;
	block_pass: boolean;
	eligible: boolean;
}

export interface DeviationRow {
	src: SrcCode;
	/** A coin id, or `ALL` for all coins of the source together. */
	coin: string;
	points: number;
	p50: number;
	p95: number;
	max: number;
	/** Points further than `outlier_percent` from the consensus. */
	over: number;
	/** Median of the signed deviation: the steady offset. */
	bias: number;
	/** Standard deviation of the signed deviation: how stable the offset is. */
	sd: number;
}

export interface ScoreRow {
	src: SrcCode;
	availability_percent: number;
	deviation: DeviationRow | null;
	freshness: { rows: number; p50: number; p95: number; max: number } | null;
	latency: { ticks: number; p50: number; p95: number } | null;
	requests_per_run: number | null;
}

export interface Report {
	thresholds: Thresholds;
	period: { from: string | null; to: string | null };
	skipped_lines: number;
	gate: GateRow[];
	score: ScoreRow[];
	deviations: DeviationRow[];
}

// ---------- reading ----------

type LineResult<T> = T | null | undefined;

/** `null` means a malformed line, `undefined` means a valid line that is not analysed. */
function parseLines<T>(
	text: string,
	parseLine: (fields: string[]) => LineResult<T>
): { items: T[]; skipped: number } {
	const items: T[] = [];
	let skipped = 0;
	const lines = text.split('\n');
	lines.forEach((raw, index) => {
		const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
		if (line === '' || (index === 0 && line.startsWith('ts,'))) {
			return;
		}
		const parsed = parseLine(line.split(','));
		if (parsed === null) {
			skipped += 1;
		} else if (parsed !== undefined) {
			items.push(parsed);
		}
	});
	return { items, skipped };
}

function asTestSource(value: string): SrcCode | undefined {
	return TEST_SOURCES.find((src) => src === value);
}

function validTs(value: string | undefined): value is string {
	return (
		value !== undefined &&
		ISO_PATTERN.test(value) &&
		!Number.isNaN(Date.parse(value))
	);
}

function parsePriceLine(coin: string) {
	return (fields: string[]): LineResult<PriceRow> => {
		const [ts, price, src, age, ...rest] = fields;
		if (
			rest.length > 0 ||
			!validTs(ts) ||
			price === undefined ||
			!DECIMAL_PATTERN.test(price) ||
			src === undefined ||
			age === undefined ||
			!(age === '' || INTEGER_PATTERN.test(age))
		) {
			return null;
		}
		const code = asTestSource(src);
		if (code === undefined) {
			return src === '' ? null : undefined;
		}
		if (!(Number(price) > 0)) {
			return null;
		}
		return {
			ts,
			coin,
			price,
			src: code,
			age_s: age === '' ? null : Number(age),
		};
	};
}

function parseLogLine(fields: string[]): LineResult<RequestLogRow> {
	const [ts, src, http, ms, coinsOk, error, ...rest] = fields;
	if (
		rest.length > 0 ||
		!validTs(ts) ||
		src === undefined ||
		http === undefined ||
		!INTEGER_PATTERN.test(http) ||
		ms === undefined ||
		!INTEGER_PATTERN.test(ms) ||
		coinsOk === undefined ||
		!INTEGER_PATTERN.test(coinsOk) ||
		error === undefined ||
		!ERROR_CODES.has(error)
	) {
		return null;
	}
	const code = asTestSource(src);
	if (code === undefined) {
		return src === '' ? null : undefined;
	}
	return {
		ts,
		src: code,
		http: Number(http),
		ms: Number(ms),
		coins_ok: Number(coinsOk),
		error: error as ErrorCode | '',
	};
}

async function listFiles(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { recursive: true });
		return entries.sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw error;
	}
}

/** `YYYY/MM/DD/<file>` as path parts, or null for any other path. */
function dayFileParts(relative: string): string[] | null {
	const parts = relative.split(sep);
	const [year, month, day, file] = parts;
	if (
		parts.length !== 4 ||
		!/^\d{4}$/.test(year ?? '') ||
		!/^\d{2}$/.test(month ?? '') ||
		!/^\d{2}$/.test(day ?? '') ||
		file === undefined
	) {
		return null;
	}
	return parts;
}

/** Reads `<dataRoot>/data/raw/**` and `<dataRoot>/data/meta/**` (the layout of ADR 0004 D1 and D7). */
export async function loadData(dataRoot: string): Promise<AnalysisData> {
	const rows: PriceRow[] = [];
	const log: RequestLogRow[] = [];
	let skipped = 0;

	const rawDir = join(dataRoot, 'data', 'raw');
	for (const relative of await listFiles(rawDir)) {
		const file = dayFileParts(relative)?.[3];
		// `<ID>.market.csv` holds bid, ask and volume, not prices
		if (
			file === undefined ||
			!file.endsWith('.csv') ||
			file.endsWith('.market.csv')
		) {
			continue;
		}
		const text = await readFile(join(rawDir, relative), 'utf8');
		const parsed = parseLines(text, parsePriceLine(file.slice(0, -4)));
		rows.push(...parsed.items);
		skipped += parsed.skipped;
	}

	const metaDir = join(dataRoot, 'data', 'meta');
	for (const relative of await listFiles(metaDir)) {
		if (dayFileParts(relative)?.[3] !== 'requests.csv') {
			continue;
		}
		const text = await readFile(join(metaDir, relative), 'utf8');
		const parsed = parseLines(text, parseLogLine);
		log.push(...parsed.items);
		skipped += parsed.skipped;
	}
	return { rows, log, skipped_lines: skipped };
}

// ---------- statistics ----------

function round4(value: number): number {
	return Math.round(value * 10000) / 10000;
}

/** Nearest rank percentile of a sorted list. `p` is 0 to 100. */
function percentile(sorted: number[], p: number): number {
	const rank = Math.ceil((p * sorted.length) / 100);
	return sorted[Math.max(rank, 1) - 1] ?? 0;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) {
		return sorted[middle] ?? 0;
	}
	return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function sorted(values: number[]): number[] {
	return [...values].sort((a, b) => a - b);
}

// ---------- gate ----------

function isOkTick(tick: RequestLogRow, expectedCoins: number): boolean {
	return (
		tick.http === 200 && tick.error === '' && tick.coins_ok >= expectedCoins
	);
}

function isBlocked(tick: RequestLogRow): boolean {
	return BLOCK_STATUSES.has(tick.http) || tick.error === 'http_429';
}

function gateRow(
	src: SrcCode,
	ticks: RequestLogRow[],
	coinsSeen: number,
	t: Thresholds
): GateRow {
	const ordered = [...ticks].sort((a, b) => parseIso(a.ts) - parseIso(b.ts));
	let okTicks = 0;
	let streak = 0;
	let longest = 0;
	for (const tick of ordered) {
		if (isOkTick(tick, t.expected_coins)) {
			okTicks += 1;
			streak = 0;
		} else {
			streak += 1;
			longest = Math.max(longest, streak);
		}
	}
	const count = ordered.length;
	const availability = count === 0 ? 0 : (okTicks * 100) / count;
	const unmapped = ordered.filter((tick) => tick.error === 'unmapped').length;
	const blocked = ordered.filter(isBlocked).length;
	const blockShare = count === 0 ? 0 : (blocked * 100) / count;
	const coinsOk = ordered.map((tick) => tick.coins_ok);
	const row: GateRow = {
		src,
		ticks: count,
		ok_ticks: okTicks,
		availability_percent: round4(availability),
		availability_pass:
			count > 0 && availability >= t.min_availability_percent,
		longest_fail_streak: longest,
		streak_pass: longest <= t.max_fail_streak,
		coins_seen: coinsSeen,
		min_coins_per_tick: count === 0 ? null : Math.min(...coinsOk),
		avg_coins_per_tick:
			count === 0
				? null
				: round4(coinsOk.reduce((sum, n) => sum + n, 0) / count),
		unmapped_ticks: unmapped,
		mapping_pass: coinsSeen >= t.expected_coins && unmapped === 0,
		blocked_ticks: blocked,
		block_percent: round4(blockShare),
		block_pass: blockShare <= t.max_block_percent,
		eligible: false,
	};
	row.eligible =
		row.availability_pass &&
		row.streak_pass &&
		row.mapping_pass &&
		row.block_pass;
	return row;
}

// ---------- quality ----------

interface Point {
	t: number;
	v: number;
}

/** The point closest in time to `t` that is within `windowMs`, or null. Points are sorted by time. */
function nearest(points: Point[], t: number, windowMs: number): Point | null {
	let low = 0;
	let high = points.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if ((points[mid]?.t ?? 0) < t) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	let best: Point | null = null;
	for (const candidate of [points[low - 1], points[low]]) {
		if (candidate === undefined || Math.abs(candidate.t - t) > windowMs) {
			continue;
		}
		if (best === null || Math.abs(candidate.t - t) < Math.abs(best.t - t)) {
			best = candidate;
		}
	}
	return best;
}

function deviationRow(
	src: SrcCode,
	coin: string,
	signed: number[],
	outlierPercent: number
): DeviationRow {
	const absolute = sorted(signed.map(Math.abs));
	const mean = signed.reduce((sum, d) => sum + d, 0) / signed.length;
	const variance =
		signed.reduce((sum, d) => sum + (d - mean) ** 2, 0) / signed.length;
	return {
		src,
		coin,
		points: signed.length,
		p50: round4(percentile(absolute, 50)),
		p95: round4(percentile(absolute, 95)),
		max: round4(absolute[absolute.length - 1] ?? 0),
		over: absolute.filter((d) => d > outlierPercent).length,
		bias: round4(median(signed)),
		sd: round4(Math.sqrt(variance)),
	};
}

/** Deviation of every row from the median of the other sources (same coin, within the time window). */
function deviations(
	rows: PriceRow[],
	sources: SrcCode[],
	t: Thresholds
): DeviationRow[] {
	const byCoin = new Map<string, Map<SrcCode, Point[]>>();
	for (const row of rows) {
		const bySource = byCoin.get(row.coin) ?? new Map<SrcCode, Point[]>();
		const points = bySource.get(row.src) ?? [];
		points.push({ t: parseIso(row.ts), v: Number(row.price) });
		bySource.set(row.src, points);
		byCoin.set(row.coin, bySource);
	}

	const windowMs = t.window_seconds * 1000;
	const signedBySource = new Map<SrcCode, Map<string, number[]>>();
	for (const [coin, bySource] of [...byCoin].sort(([a], [b]) =>
		a.localeCompare(b)
	)) {
		for (const points of bySource.values()) {
			points.sort((a, b) => a.t - b.t);
		}
		for (const [src, points] of bySource) {
			const others = sources.filter((other) => other !== src);
			const found =
				signedBySource.get(src) ?? new Map<string, number[]>();
			const list = found.get(coin) ?? [];
			for (const point of points) {
				const values: number[] = [];
				for (const other of others) {
					const match = nearest(
						bySource.get(other) ?? [],
						point.t,
						windowMs
					);
					if (match !== null) {
						values.push(match.v);
					}
				}
				if (values.length === 0) {
					continue;
				}
				const consensus = median(values);
				list.push(((point.v - consensus) * 100) / consensus);
			}
			found.set(coin, list);
			signedBySource.set(src, found);
		}
	}

	const result: DeviationRow[] = [];
	for (const src of sources) {
		const perCoin = signedBySource.get(src) ?? new Map<string, number[]>();
		const all: number[] = [];
		for (const [coin, signed] of perCoin) {
			if (signed.length > 0) {
				result.push(deviationRow(src, coin, signed, t.outlier_percent));
				all.push(...signed);
			}
		}
		if (all.length > 0) {
			result.push(deviationRow(src, 'ALL', all, t.outlier_percent));
		}
	}
	return result;
}

// ---------- report ----------

export function analyze(
	data: AnalysisData,
	thresholds: Thresholds = DEFAULT_THRESHOLDS
): Report {
	const rows = data.rows.filter((row) => asTestSource(row.src) !== undefined);
	const log = data.log.filter((tick) => asTestSource(tick.src) !== undefined);
	const sources = TEST_SOURCES.filter(
		(src) =>
			rows.some((row) => row.src === src) ||
			log.some((tick) => tick.src === src)
	);

	const gate = sources.map((src) =>
		gateRow(
			src,
			log.filter((tick) => tick.src === src),
			new Set(
				rows.filter((row) => row.src === src).map((row) => row.coin)
			).size,
			thresholds
		)
	);
	const deviationRows = deviations(rows, sources, thresholds);

	const score = sources.map((src): ScoreRow => {
		const ages = sorted(
			rows
				.filter((row) => row.src === src && row.age_s !== null)
				.map((row) => row.age_s ?? 0)
		);
		const latencies = sorted(
			log
				.filter(
					(tick) =>
						tick.src === src &&
						isOkTick(tick, thresholds.expected_coins)
				)
				.map((tick) => tick.ms)
		);
		return {
			src,
			availability_percent:
				gate.find((row) => row.src === src)?.availability_percent ?? 0,
			deviation:
				deviationRows.find(
					(row) => row.src === src && row.coin === 'ALL'
				) ?? null,
			freshness:
				ages.length === 0
					? null
					: {
							rows: ages.length,
							p50: percentile(ages, 50),
							p95: percentile(ages, 95),
							max: ages[ages.length - 1] ?? 0,
						},
			latency:
				latencies.length === 0
					? null
					: {
							ticks: latencies.length,
							p50: percentile(latencies, 50),
							p95: percentile(latencies, 95),
						},
			requests_per_run: REQUESTS_PER_RUN[src] ?? null,
		};
	});

	const times = [
		...rows.map((row) => parseIso(row.ts)),
		...log.map((tick) => parseIso(tick.ts)),
	];
	return {
		thresholds,
		period: {
			from:
				times.length === 0
					? null
					: isoSeconds(new Date(Math.min(...times))),
			to:
				times.length === 0
					? null
					: isoSeconds(new Date(Math.max(...times))),
		},
		skipped_lines: data.skipped_lines,
		gate,
		score,
		deviations: deviationRows.filter((row) => row.coin !== 'ALL'),
	};
}

// ---------- Markdown ----------

function cell(value: number | string | null): string {
	return value === null ? 'n/a' : String(value);
}

function mark(value: number | string | null, pass: boolean): string {
	return `${cell(value)} ${pass ? 'pass' : 'FAIL'}`;
}

function table(headers: string[], rows: string[][]): string {
	const lines = [
		`| ${headers.join(' | ')} |`,
		`| ${headers.map(() => '---').join(' | ')} |`,
		...rows.map((row) => `| ${row.join(' | ')} |`),
	];
	return lines.join('\n');
}

function name(src: SrcCode): string {
	return SOURCE_NAMES[src] ?? src;
}

export function renderMarkdown(report: Report): string {
	const t = report.thresholds;
	const out: string[] = ['# Source analysis', ''];
	out.push(
		`Period: ${cell(report.period.from)} to ${cell(report.period.to)}. Unreadable lines skipped: ${report.skipped_lines}.`,
		''
	);

	out.push('## Gate (ADR 0002 Revision 2, point 7)', '');
	out.push(
		table(
			[
				'Source',
				'Ticks',
				'OK ticks',
				`Availability % (min ${t.min_availability_percent})`,
				`Longest failure streak (max ${t.max_fail_streak})`,
				`Coins mapped per tick, min / avg (need ${t.expected_coins})`,
				'Coins seen',
				'Unmapped ticks',
				`429 or block % (max ${t.max_block_percent})`,
				'Eligible',
			],
			report.gate.map((g) => [
				name(g.src),
				String(g.ticks),
				String(g.ok_ticks),
				mark(g.availability_percent, g.availability_pass),
				mark(g.longest_fail_streak, g.streak_pass),
				`${cell(g.min_coins_per_tick)} / ${cell(g.avg_coins_per_tick)}`,
				mark(g.coins_seen, g.mapping_pass),
				String(g.unmapped_ticks),
				mark(g.block_percent, g.block_pass),
				g.eligible ? 'yes' : 'NO',
			])
		),
		''
	);
	out.push(
		'A tick is one request-log row. It is OK when it has HTTP 200, no error and all expected coins. The mapping gate needs every expected coin in the data and no `unmapped` tick. Block means HTTP 403, 429 or 451, or the error `http_429`.',
		''
	);

	out.push('## Score (ADR 0002 Revision 2, point 8)', '');
	out.push(
		table(
			[
				'Source',
				'Availability %',
				'Deviation p50 %',
				'Deviation p95 %',
				'Deviation max %',
				`Points over ${t.outlier_percent}%`,
				'Offset %',
				'Offset sd %',
				'Freshness p50 s',
				'Freshness p95 s',
				'Latency p50 ms',
				'Latency p95 ms',
				'Requests per run',
			],
			report.score.map((s) => [
				name(s.src),
				String(s.availability_percent),
				cell(s.deviation?.p50 ?? null),
				cell(s.deviation?.p95 ?? null),
				cell(s.deviation?.max ?? null),
				cell(s.deviation?.over ?? null),
				cell(s.deviation?.bias ?? null),
				cell(s.deviation?.sd ?? null),
				cell(s.freshness?.p50 ?? null),
				cell(s.freshness?.p95 ?? null),
				cell(s.latency?.p50 ?? null),
				cell(s.latency?.p95 ?? null),
				cell(s.requests_per_run),
			])
		),
		''
	);
	out.push(
		`Deviation is the absolute distance of a price from the median of the other sources for the same coin (rows within ${t.window_seconds} seconds). Offset is the median of the signed deviation and offset sd is its spread: judge the stability of the offset, not only the raw gap. Freshness uses \`age_s\`, so it is n/a for a source without its own timestamp (Kraken). Latency uses OK ticks only. Percentiles use the nearest rank. Requests per run are fixed by the adapter design, not measured.`,
		''
	);

	out.push('## Deviation per coin', '');
	out.push(
		table(
			[
				'Source',
				'Coin',
				'Points',
				'p50 %',
				'p95 %',
				'Max %',
				`Over ${t.outlier_percent}%`,
				'Offset %',
				'Offset sd %',
			],
			report.deviations.map((d) => [
				name(d.src),
				d.coin,
				String(d.points),
				String(d.p50),
				String(d.p95),
				String(d.max),
				String(d.over),
				String(d.bias),
				String(d.sd),
			])
		),
		''
	);
	return out.join('\n');
}

// ---------- command line ----------

interface Io {
	out: (text: string) => void;
	err: (text: string) => void;
}

const USAGE = `Usage: node tools/analyze-sources.ts [--data-root <dir>] [--json] [options]

Reads <dir>/data/raw/**.csv and <dir>/data/meta/**/requests.csv (default dir: data).

Options (the defaults are the thresholds of ADR 0002 Revision 2):
  --min-availability <percent>   default ${DEFAULT_THRESHOLDS.min_availability_percent}
  --max-fail-streak <ticks>      default ${DEFAULT_THRESHOLDS.max_fail_streak}
  --max-block-percent <percent>  default ${DEFAULT_THRESHOLDS.max_block_percent}
  --expected-coins <count>       default ${DEFAULT_THRESHOLDS.expected_coins}
  --outlier-percent <percent>    default ${DEFAULT_THRESHOLDS.outlier_percent}
  --window-seconds <seconds>     default ${DEFAULT_THRESHOLDS.window_seconds}
  --json                         print JSON instead of Markdown
  --help                         print this text
`;

const NUMBER_OPTIONS = [
	['min-availability', 'min_availability_percent'],
	['max-fail-streak', 'max_fail_streak'],
	['max-block-percent', 'max_block_percent'],
	['expected-coins', 'expected_coins'],
	['outlier-percent', 'outlier_percent'],
	['window-seconds', 'window_seconds'],
] as const;

/** Runs the tool. Returns the exit code: 0 on success, 1 on bad input or when there is no data. */
export async function main(argv: string[], io: Io): Promise<number> {
	let values: Record<string, string | boolean | undefined>;
	try {
		values = parseArgs({
			args: argv,
			options: {
				'data-root': { type: 'string' },
				json: { type: 'boolean' },
				help: { type: 'boolean' },
				'min-availability': { type: 'string' },
				'max-fail-streak': { type: 'string' },
				'max-block-percent': { type: 'string' },
				'expected-coins': { type: 'string' },
				'outlier-percent': { type: 'string' },
				'window-seconds': { type: 'string' },
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

	const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS };
	for (const [option, key] of NUMBER_OPTIONS) {
		const raw = values[option];
		if (typeof raw !== 'string') {
			continue;
		}
		const value = Number(raw);
		if (raw.trim() === '' || !Number.isFinite(value) || value < 0) {
			io.err(
				`--${option} needs a number of zero or more, got "${raw}"\n`
			);
			return 1;
		}
		thresholds[key] = value;
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
	const report = analyze(data, thresholds);
	io.out(
		values.json === true
			? `${JSON.stringify(report, null, 2)}\n`
			: `${renderMarkdown(report)}\n`
	);
	return 0;
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2), {
		out: (text) => process.stdout.write(text),
		err: (text) => process.stderr.write(text),
	});
}
