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

function severityOf(value: unknown): Alert['severity'] {
	return value === 'extreme' || value === 'critical' ? 'extreme' : 'high';
}

function toAlert(entry: unknown, fallbackCoin?: string): Alert | null {
	if (!isRecord(entry)) {
		return null;
	}
	const coin = entry.coin ?? fallbackCoin;
	const ts = entry.ts ?? entry.last_alert_at;
	const direction = entry.direction;
	const issue = entry.issue ?? entry.issue_number;
	if (
		typeof coin !== 'string' ||
		typeof ts !== 'string' ||
		Number.isNaN(Date.parse(ts)) ||
		(direction !== 'up' && direction !== 'down') ||
		typeof issue !== 'number' ||
		!Number.isInteger(issue)
	) {
		return null;
	}
	return { coin, ts, direction, severity: severityOf(entry.severity), issue };
}

/** The key of a per-key state entry is `COIN:direction` or `COIN|direction`, optionally followed by more parts. */
function fromKeyedEntries(entries: Record<string, unknown>): Alert[] {
	const alerts: Alert[] = [];
	for (const [key, value] of Object.entries(entries)) {
		const [coin, direction] = key.split(/[:|]/);
		if (isRecord(value)) {
			const alert = toAlert({ direction, ...value }, coin);
			if (alert !== null) {
				alerts.push(alert);
			}
		}
	}
	return alerts;
}

/**
 * The shape of state/alerts.json belongs to the alert module (ADR 0006 D4), so this reader is lenient.
 * It accepts a list under `alerts` or `history` (items with coin, ts, direction, severity, issue)
 * and a record under `keys` (one entry per `COIN:direction` key with `last_alert_at` and `issue_number`).
 * Anything else gives an empty list.
 */
export async function readAlertsFile(
	dataRoot: string,
	generatedAt: string
): Promise<DerivedAlerts> {
	const parsed = await readJson(join(dataRoot, 'state', 'alerts.json'));
	const alerts: Alert[] = [];
	if (isRecord(parsed)) {
		for (const name of ['alerts', 'history']) {
			const list = parsed[name];
			if (Array.isArray(list)) {
				for (const entry of list) {
					const alert = toAlert(entry);
					if (alert !== null) {
						alerts.push(alert);
					}
				}
			}
		}
		if (isRecord(parsed.keys)) {
			alerts.push(...fromKeyedEntries(parsed.keys));
		}
	}
	alerts.sort(
		(a, b) =>
			Date.parse(b.ts) - Date.parse(a.ts) ||
			a.coin.localeCompare(b.coin) ||
			a.direction.localeCompare(b.direction)
	);
	return { generated_at: generatedAt, alerts: alerts.slice(0, MAX_ALERTS) };
}
