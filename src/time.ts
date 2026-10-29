// Time helpers shared by every module. All times are UTC (ADR 0004 D3).

/** UTC, second precision, always with a trailing `Z`, for example `2026-10-29T14:03:12Z`. */
export function isoSeconds(date: Date): string {
	return `${date.toISOString().slice(0, 19)}Z`;
}

/** The UTC day of an ISO time, as `YYYY-MM-DD`. */
export function utcDay(ts: string): string {
	return ts.slice(0, 10);
}

/** Epoch milliseconds of an ISO time. Throws on input that is not a date. */
export function parseIso(ts: string): number {
	const value = Date.parse(ts);
	if (Number.isNaN(value)) {
		throw new Error(`Not an ISO time: ${ts}`);
	}
	return value;
}
