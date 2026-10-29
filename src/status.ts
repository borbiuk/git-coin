// state/status.json on the data branch (ADR 0004 D4, ADR 0005 D6, ADR 0006 D7).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isoSeconds } from './time.ts';
import type {
	CoinStatus,
	ErrorCode,
	Phase,
	PriceRow,
	RequestLogRow,
	SourceStatus,
	Status,
} from './types.ts';

const NO_DATA_ISSUE_AFTER = 4;

/** What one collector run did. The collector builds it, `applyRun` folds it into the status. */
export interface RunSummary {
	/** The phase of the config at the time of the run. */
	phase: Phase;
	sources: Array<{
		/** The request-log row of this source for this run. */
		log: RequestLogRow;
		/** The rows that were really appended. */
		written: PriceRow[];
		/** The rows that failed validation, with the stable reason code. */
		rejected: Array<{ coin: string; reason: string }>;
		/** Ids of the coins the source did not deliver (unmapped or missing in the response). */
		missingCoins: string[];
	}>;
}

export function emptyStatus(phase: Phase): Status {
	return {
		schema_version: 1,
		phase,
		last_run_at: null,
		last_point_at: null,
		consecutive_failures: 0,
		last_publish_at: null,
		sources: {},
		coins: {},
	};
}

function emptySource(): SourceStatus {
	return {
		requests: 0,
		failures: 0,
		failures_by_error: {},
		consecutive_failures: 0,
		last_ok_at: null,
	};
}

function emptyCoin(): CoinStatus {
	return {
		last_point_at: null,
		status: 'ok',
		rejected_count: 0,
		last_reject_reason: null,
	};
}

/** Returns a new status. `prev` is not changed. */
export function applyRun(prev: Status, run: RunSummary, now: Date): Status {
	const next = structuredClone(prev);
	const nowIso = isoSeconds(now);
	next.phase = run.phase;
	next.last_run_at = nowIso;

	const writtenCoins = new Set<string>();
	const missingCoins = new Set<string>();
	let rowsWritten = 0;

	for (const source of run.sources) {
		const log = source.log;
		const stats = (next.sources[log.src] ??= emptySource());
		stats.requests += 1;
		if (log.error === '') {
			stats.consecutive_failures = 0;
			stats.last_ok_at = log.ts;
		} else {
			stats.failures += 1;
			stats.consecutive_failures += 1;
			const code: ErrorCode = log.error;
			stats.failures_by_error[code] =
				(stats.failures_by_error[code] ?? 0) + 1;
		}

		for (const row of source.written) {
			writtenCoins.add(row.coin);
			rowsWritten += 1;
		}
		for (const coin of source.missingCoins) {
			missingCoins.add(coin);
		}
		for (const reject of source.rejected) {
			const coin = (next.coins[reject.coin] ??= emptyCoin());
			coin.rejected_count += 1;
			coin.last_reject_reason = reject.reason;
		}
	}

	for (const id of writtenCoins) {
		const coin = (next.coins[id] ??= emptyCoin());
		coin.last_point_at = nowIso;
		coin.status = 'ok';
	}
	for (const id of missingCoins) {
		if (writtenCoins.has(id)) {
			continue;
		}
		const coin = (next.coins[id] ??= emptyCoin());
		coin.status = 'source_missing';
	}

	if (rowsWritten > 0) {
		next.consecutive_failures = 0;
		next.last_point_at = nowIso;
	} else {
		next.consecutive_failures += 1;
	}
	return next;
}

/** True after 4 or more failed runs in a row (ADR 0004 D4). */
export function needsNoDataIssue(s: Status): boolean {
	return s.consecutive_failures >= NO_DATA_ISSUE_AFTER;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A missing file gives an empty status (phase `test`; the collector sets the real phase in `applyRun`). Other problems throw. */
export async function readStatus(path: string): Promise<Status> {
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch (error) {
		if (isRecord(error) && error.code === 'ENOENT') {
			return emptyStatus('test');
		}
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`Status file is not valid JSON: ${path}`);
	}
	if (
		!isRecord(parsed) ||
		parsed.schema_version !== 1 ||
		(parsed.phase !== 'test' && parsed.phase !== 'production') ||
		!isRecord(parsed.sources) ||
		!isRecord(parsed.coins) ||
		typeof parsed.consecutive_failures !== 'number'
	) {
		throw new Error(`Status file has an unexpected shape: ${path}`);
	}
	return parsed as unknown as Status;
}

function sortedKeys<T>(record: Record<string, T>): Array<[string, T]> {
	return Object.entries(record).sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0
	);
}

function stable(s: Status): Status {
	const sources: Record<string, SourceStatus> = {};
	for (const [src, stats] of sortedKeys(
		s.sources as Record<string, SourceStatus>
	)) {
		sources[src] = {
			requests: stats.requests,
			failures: stats.failures,
			failures_by_error: Object.fromEntries(
				sortedKeys(stats.failures_by_error as Record<string, number>)
			),
			consecutive_failures: stats.consecutive_failures,
			last_ok_at: stats.last_ok_at,
		};
	}
	const coins: Record<string, CoinStatus> = {};
	for (const [id, coin] of sortedKeys(s.coins)) {
		coins[id] = {
			last_point_at: coin.last_point_at,
			status: coin.status,
			rejected_count: coin.rejected_count,
			last_reject_reason: coin.last_reject_reason,
		};
	}
	return {
		schema_version: 1,
		phase: s.phase,
		last_run_at: s.last_run_at,
		last_point_at: s.last_point_at,
		consecutive_failures: s.consecutive_failures,
		last_publish_at: s.last_publish_at,
		sources,
		coins,
	};
}

/** Writes JSON with a fixed key order, sorted source and coin keys, two-space indent and a trailing newline. */
export async function writeStatus(path: string, s: Status): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.tmp`;
	await writeFile(temp, `${JSON.stringify(stable(s), null, 2)}\n`, 'utf8');
	await rename(temp, path);
}
