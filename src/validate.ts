// Price validation (ADR 0004 D4, ADR 0002 Revision 2 point 6). Reject, never repair.
// Reasons are short stable codes: they go into status.json and the log.

import type { Phase, PriceRow } from './types.ts';

const DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const MAX_PRICE_EXCLUSIVE = 1_000_000_000;

type PriceCheck = { ok: true; value: number } | { ok: false; reason: string };
type RowCheck = { ok: true } | { ok: false; reason: string };

/**
 * Checks the text of a price. The number is for checks only: the original string is what gets stored.
 * Reasons: `not_decimal`, `not_finite`, `not_positive`, `too_large`.
 */
export function validatePrice(raw: string): PriceCheck {
	if (typeof raw !== 'string' || !DECIMAL.test(raw)) {
		return { ok: false, reason: 'not_decimal' };
	}
	const value = Number(raw);
	if (!Number.isFinite(value)) {
		return { ok: false, reason: 'not_finite' };
	}
	if (value <= 0) {
		return { ok: false, reason: 'not_positive' };
	}
	if (value >= MAX_PRICE_EXCLUSIVE) {
		return { ok: false, reason: 'too_large' };
	}
	return { ok: true, value };
}

function usable(value: number | null | undefined): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function diffPercent(value: number, base: number): number {
	return (Math.abs(value - base) / base) * 100;
}

/**
 * Phase `test`: structural checks only (the price text). Phase `production`: also the cross-check and the step check.
 * Extra reasons in production: `crosscheck_diff`, `step_no_crosscheck`.
 * A large step is accepted only when the cross-check agrees within the limit.
 */
export function validateRow(
	row: PriceRow,
	ctx: {
		phase: Phase;
		previous: number | null;
		crosscheck?: number | null;
		maxStepPercent: number;
		crosscheckMaxDiffPercent: number;
	}
): RowCheck {
	const price = validatePrice(row.price);
	if (!price.ok) {
		return price;
	}
	if (ctx.phase === 'test') {
		return { ok: true };
	}

	const crosscheck = usable(ctx.crosscheck) ? ctx.crosscheck : null;
	const agrees =
		crosscheck !== null &&
		diffPercent(price.value, crosscheck) <= ctx.crosscheckMaxDiffPercent;
	if (crosscheck !== null && !agrees) {
		return { ok: false, reason: 'crosscheck_diff' };
	}

	if (
		usable(ctx.previous) &&
		diffPercent(price.value, ctx.previous) > ctx.maxStepPercent &&
		!agrees
	) {
		return { ok: false, reason: 'step_no_crosscheck' };
	}
	return { ok: true };
}
