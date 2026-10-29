// The alert state file `state/alerts.json` on the data branch (ADR 0006 D4, ADR 0004 D2).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Direction, Severity, WindowLabel } from './logic.ts';

export interface KeyState {
	/** The open Issue number, or null when none is open. */
	issue: number | null;
	last_alert_at: string | null;
	last_comment_at: string | null;
	last_trigger_at: string | null;
	last_suppressed_at: string | null;
}

export interface RecentAlert {
	coin: string;
	ts: string;
	direction: Direction;
	window: WindowLabel;
	severity: Severity;
	/** Null when the Issue was not created because of the daily cap. */
	issue: number | null;
	suppressed: boolean;
}

export interface AlertState {
	schema_version: 1;
	/** Keys look like `BTC:down`. */
	keys: Record<string, KeyState>;
	daily: { day: string | null; created: number; suppressed: number };
	/** The newest alerts, oldest first. For the dashboard. */
	recent: RecentAlert[];
}

export const RECENT_LIMIT = 50;

export function emptyKeyState(): KeyState {
	return {
		issue: null,
		last_alert_at: null,
		last_comment_at: null,
		last_trigger_at: null,
		last_suppressed_at: null,
	};
}

export function emptyAlertState(): AlertState {
	return {
		schema_version: 1,
		keys: {},
		daily: { day: null, created: 0, suppressed: 0 },
		recent: [],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown, what: string): string | null {
	if (value === null || typeof value === 'string') {
		return value;
	}
	throw new Error(`Invalid alert state: ${what}`);
}

function countField(value: unknown, what: string): number {
	if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
		return value;
	}
	throw new Error(`Invalid alert state: ${what}`);
}

function parseKeyState(value: unknown, key: string): KeyState {
	if (!isRecord(value)) {
		throw new Error(`Invalid alert state: key ${key}`);
	}
	const issue = value.issue;
	if (issue !== null && typeof issue !== 'number') {
		throw new Error(`Invalid alert state: issue of ${key}`);
	}
	return {
		issue,
		last_alert_at: stringOrNull(
			value.last_alert_at,
			`last_alert_at of ${key}`
		),
		last_comment_at: stringOrNull(
			value.last_comment_at,
			`last_comment_at of ${key}`
		),
		last_trigger_at: stringOrNull(
			value.last_trigger_at,
			`last_trigger_at of ${key}`
		),
		last_suppressed_at: stringOrNull(
			value.last_suppressed_at,
			`last_suppressed_at of ${key}`
		),
	};
}

function parseRecent(value: unknown): RecentAlert {
	if (
		!isRecord(value) ||
		typeof value.coin !== 'string' ||
		typeof value.ts !== 'string' ||
		(value.direction !== 'up' && value.direction !== 'down') ||
		(value.window !== '1h' && value.window !== '24h') ||
		(value.severity !== 'warning' && value.severity !== 'critical') ||
		(value.issue !== null && typeof value.issue !== 'number') ||
		typeof value.suppressed !== 'boolean'
	) {
		throw new Error('Invalid alert state: recent');
	}
	return {
		coin: value.coin,
		ts: value.ts,
		direction: value.direction,
		window: value.window,
		severity: value.severity,
		issue: value.issue,
		suppressed: value.suppressed,
	};
}

/** Checks the parsed JSON and throws a clear error if the shape is wrong. */
export function parseAlertState(raw: unknown): AlertState {
	if (!isRecord(raw) || raw.schema_version !== 1) {
		throw new Error('Invalid alert state: schema_version');
	}
	if (
		!isRecord(raw.keys) ||
		!isRecord(raw.daily) ||
		!Array.isArray(raw.recent)
	) {
		throw new Error('Invalid alert state: top level');
	}
	const keys: Record<string, KeyState> = {};
	for (const [name, value] of Object.entries(raw.keys)) {
		keys[name] = parseKeyState(value, name);
	}
	return {
		schema_version: 1,
		keys,
		daily: {
			day: stringOrNull(raw.daily.day, 'daily.day'),
			created: countField(raw.daily.created, 'daily.created'),
			suppressed: countField(raw.daily.suppressed, 'daily.suppressed'),
		},
		recent: raw.recent.map(parseRecent),
	};
}

/** Stable text: keys sorted, two-space indent, trailing newline. */
export function serializeAlertState(state: AlertState): string {
	const keys: Record<string, KeyState> = {};
	for (const name of Object.keys(state.keys).sort()) {
		const entry = state.keys[name] as KeyState;
		keys[name] = {
			issue: entry.issue,
			last_alert_at: entry.last_alert_at,
			last_comment_at: entry.last_comment_at,
			last_trigger_at: entry.last_trigger_at,
			last_suppressed_at: entry.last_suppressed_at,
		};
	}
	const ordered: AlertState = {
		schema_version: 1,
		keys,
		daily: {
			day: state.daily.day,
			created: state.daily.created,
			suppressed: state.daily.suppressed,
		},
		recent: state.recent.map((item) => ({
			coin: item.coin,
			ts: item.ts,
			direction: item.direction,
			window: item.window,
			severity: item.severity,
			issue: item.issue,
			suppressed: item.suppressed,
		})),
	};
	return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** A missing file gives an empty state. A file with bad JSON or a bad shape throws. */
export async function readAlertState(path: string): Promise<AlertState> {
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return emptyAlertState();
		}
		throw error;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error('Invalid alert state: not JSON');
	}
	return parseAlertState(raw);
}

export async function writeAlertState(
	path: string,
	state: AlertState
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, serializeAlertState(state), 'utf8');
}
