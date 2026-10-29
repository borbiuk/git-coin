// Reads state/status.json and state/alerts.json of the data checkout and shapes them for the dashboard.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DerivedAlerts, DerivedStatus, Phase, Status } from '../types.ts';

const MAX_ALERTS = 10;

type Alert = DerivedAlerts['alerts'][number];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The parsed JSON file, or null when the file is missing or is not valid JSON (a warning goes to stderr). */
async function readJson(path: string): Promise<unknown> {
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch (error) {
		if ((error as { code?: string }).code === 'ENOENT') {
			return null;
		}
		throw error;
	}
	try {
		return JSON.parse(text);
	} catch {
		console.warn(`Ignoring ${path}: it is not valid JSON.`);
		return null;
	}
}

export async function readStatusFile(
	dataRoot: string,
	phase: Phase,
	generatedAt: string
): Promise<DerivedStatus> {
	const empty: Status = {
		schema_version: 1,
		phase,
		last_run_at: null,
		last_point_at: null,
		consecutive_failures: 0,
		last_publish_at: null,
		sources: {},
		coins: {},
	};
	const parsed = await readJson(join(dataRoot, 'state', 'status.json'));
	if (!isRecord(parsed) || parsed.schema_version !== 1) {
		return { ...empty, generated_at: generatedAt };
	}
	// Fields the file lacks fall back to the empty status, so the dashboard always finds every key
	return {
		...empty,
		...(parsed as Partial<Status>),
		generated_at: generatedAt,
	};
}

/** One entry of `recent` in state/alerts.json (written by src/alerts/state.ts), or null if it is not shown. */
function toAlert(entry: unknown): Alert | null {
	if (
		!isRecord(entry) ||
		typeof entry.coin !== 'string' ||
		typeof entry.ts !== 'string' ||
		Number.isNaN(Date.parse(entry.ts)) ||
		(entry.direction !== 'up' && entry.direction !== 'down') ||
		(entry.severity !== 'warning' && entry.severity !== 'critical') ||
		typeof entry.issue !== 'number' ||
		entry.suppressed === true
	) {
		return null;
	}
	return {
		coin: entry.coin,
		ts: entry.ts,
		direction: entry.direction,
		severity: entry.severity === 'critical' ? 'extreme' : 'high',
		issue: entry.issue,
	};
}

/**
 * The newest alerts that have an Issue, from the `recent` list of state/alerts.json (oldest first there).
 * A missing file, a file that is not valid JSON and a file without a `recent` list give an empty list.
 */
export async function readAlertsFile(
	dataRoot: string,
	generatedAt: string
): Promise<DerivedAlerts> {
	const parsed = await readJson(join(dataRoot, 'state', 'alerts.json'));
	const alerts: Alert[] = [];
	if (isRecord(parsed) && parsed.schema_version === 1) {
		const recent = Array.isArray(parsed.recent) ? parsed.recent : [];
		// Newest first: walk the list from its end, then a stable sort keeps that order for equal times
		for (let index = recent.length - 1; index >= 0; index -= 1) {
			const alert = toAlert(recent[index]);
			if (alert !== null) {
				alerts.push(alert);
			}
		}
	}
	alerts.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
	return { generated_at: generatedAt, alerts: alerts.slice(0, MAX_ALERTS) };
}
