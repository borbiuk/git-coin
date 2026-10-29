// Pure alert rules (ADR 0006 D1 to D3). No I/O, no clock: the caller passes the time.

import type { AlertDefaults, CoinConfig, PricePoint } from '../types.ts';

export type Direction = 'up' | 'down';
export type Severity = 'warning' | 'critical';
export type RuleName = 'move_1h' | 'move_24h';
export type WindowLabel = '1h' | '24h';

const MINUTE_MS = 60_000;

// Decimal prices are not exact in floating point. A move of exactly the threshold must still count.
const EDGE_TOLERANCE = 1e-9;

// A stored price is a plain decimal string. Anything else is not used for an alert.
const PRICE_PATTERN = /^(0|[1-9]\d{0,11})(\.\d{1,18})?$/;

export interface RuleParams {
	rule: RuleName;
	label: WindowLabel;
	windowMinutes: number;
	thresholdPercent: number;
	refToleranceMinutes: number;
}

export interface CoinAlertParams {
	enabled: boolean;
	direction: 'up' | 'down' | 'both';
	cooldownHours: number;
	dailyIssueCap: number;
	autoCloseHours: number;
	rules: RuleParams[];
}

export interface Sample {
	ms: number;
	ts: string;
	price: string;
	value: number;
}

export interface Trigger {
	rule: RuleName;
	label: WindowLabel;
	direction: Direction;
	movePercent: number;
	thresholdPercent: number;
	severity: Severity;
	reference: Sample;
	current: Sample;
}

/** Merges the global defaults with the per-coin overrides (ADR 0007 D3). */
export function resolveParams(
	coin: CoinConfig,
	defaults: AlertDefaults
): CoinAlertParams {
	const over = coin.alerts ?? {};
	const rule = (
		name: RuleName,
		label: WindowLabel,
		base: AlertDefaults['move_1h'],
		patch: Partial<AlertDefaults['move_1h']> | undefined
	): RuleParams => ({
		rule: name,
		label,
		windowMinutes: patch?.window_minutes ?? base.window_minutes,
		thresholdPercent: patch?.threshold_percent ?? base.threshold_percent,
		refToleranceMinutes:
			patch?.ref_tolerance_minutes ?? base.ref_tolerance_minutes,
	});
	return {
		enabled: coin.enabled && (over.enabled ?? defaults.enabled),
		direction: over.direction ?? defaults.direction,
		cooldownHours: over.cooldown_hours ?? defaults.cooldown_hours,
		dailyIssueCap: over.daily_issue_cap ?? defaults.daily_issue_cap,
		autoCloseHours: over.auto_close_hours ?? defaults.auto_close_hours,
		rules: [
			rule('move_1h', '1h', defaults.move_1h, over.move_1h),
			rule('move_24h', '24h', defaults.move_24h, over.move_24h),
		],
	};
}

/** Keeps the points with a valid time and a plain positive decimal price. */
export function toSamples(points: PricePoint[]): Sample[] {
	const samples: Sample[] = [];
	for (const point of points) {
		const ms = Date.parse(point.ts);
		if (Number.isNaN(ms) || !PRICE_PATTERN.test(point.price)) {
			continue;
		}
		const value = Number(point.price);
		if (!Number.isFinite(value) || value <= 0) {
			continue;
		}
		samples.push({ ms, ts: point.ts, price: point.price, value });
	}
	return samples;
}

/** The latest sample at or before `nowMs`, not older than `maxAgeMs`. */
export function pickCurrent(
	samples: Sample[],
	nowMs: number,
	maxAgeMs: number
): Sample | null {
	let best: Sample | null = null;
	for (const sample of samples) {
		if (sample.ms > nowMs || nowMs - sample.ms > maxAgeMs) {
			continue;
		}
		if (best === null || sample.ms > best.ms) {
			best = sample;
		}
	}
	return best;
}

/**
 * The reference sample (ADR 0006 D2): the latest sample with `ts <= now - window`
 * that is not older than `window + tolerance`. Null when there is none.
 */
export function pickReference(
	samples: Sample[],
	nowMs: number,
	windowMinutes: number,
	toleranceMinutes: number
): Sample | null {
	const latestAllowed = nowMs - windowMinutes * MINUTE_MS;
	const earliestAllowed = latestAllowed - toleranceMinutes * MINUTE_MS;
	let best: Sample | null = null;
	for (const sample of samples) {
		if (sample.ms > latestAllowed || sample.ms < earliestAllowed) {
			continue;
		}
		if (best === null || sample.ms > best.ms) {
			best = sample;
		}
	}
	return best;
}

/** Checks one rule. Returns a trigger when the move reaches the threshold. */
export function evaluateRule(
	samples: Sample[],
	nowMs: number,
	rule: RuleParams
): Trigger | null {
	const current = pickCurrent(
		samples,
		nowMs,
		rule.refToleranceMinutes * MINUTE_MS
	);
	const reference = pickReference(
		samples,
		nowMs,
		rule.windowMinutes,
		rule.refToleranceMinutes
	);
	if (current === null || reference === null) {
		return null;
	}
	const diff = current.value - reference.value;
	// Compare without a division. The tolerance keeps an edge case such as exactly 3.000% in.
	const scaled = Math.abs(diff) * 100 * (1 + EDGE_TOLERANCE);
	if (scaled < rule.thresholdPercent * reference.value) {
		return null;
	}
	return {
		rule: rule.rule,
		label: rule.label,
		direction: diff > 0 ? 'up' : 'down',
		movePercent: (Math.abs(diff) * 100) / reference.value,
		thresholdPercent: rule.thresholdPercent,
		severity:
			scaled >= 2 * rule.thresholdPercent * reference.value
				? 'critical'
				: 'warning',
		reference,
		current,
	};
}

export function directionAllowed(
	setting: 'up' | 'down' | 'both',
	direction: Direction
): boolean {
	return setting === 'both' || setting === direction;
}
