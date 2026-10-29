// Pure functions that turn price rows into the derived series of ADR 0008 D2. No file access except `loadSamples`.
import { isoSeconds, parseIso, utcDay } from '../time.ts';
import type {
	PeriodStats,
	PricePoint,
	SeriesDaily,
	SeriesPoints,
	SeriesReader,
	SeriesSources,
	SrcCode,
} from '../types.ts';

/** One price point with the time as epoch seconds and the price as a number. */
export interface Sample {
	t: number;
	p: number;
	ts: string;
}

export const PERIODS = {
	'24h': 24 * 3600,
	'7d': 7 * 86_400,
	'30d': 30 * 86_400,
} as const;
export const SEVEN_DAYS_SECONDS = PERIODS['7d'];
export const NINETY_DAYS_SECONDS = 90 * 86_400;

const HOUR_SECONDS = 3600;
/** A period start is matched to a sample only within this part of the period (also for the freshness of the last sample). */
const TOLERANCE_SHARE = 0.05;

export function toSamples(points: PricePoint[]): Sample[] {
	const samples: Sample[] = [];
	for (const point of points) {
		const p = Number(point.price);
		if (point.price === '' || !Number.isFinite(p)) {
			continue;
		}
		samples.push({
			t: Math.floor(parseIso(point.ts) / 1000),
			p,
			ts: point.ts,
		});
	}
	return samples;
}

/** Reads all rows of one coin and one source up to `now` (inclusive) and converts them. */
export async function loadSamples(
	reader: SeriesReader,
	coin: string,
	fromIso: string,
	now: Date,
	src: SrcCode
): Promise<Sample[]> {
	const toIso = isoSeconds(new Date(now.getTime() + 1000));
	return toSamples(await reader.readSeries(coin, fromIso, toIso, src));
}

export function emptyPoints(coin: string, src: SrcCode): SeriesPoints {
	return { coin, src, t: [], p: [] };
}

/** Samples from `fromSec` on, at full resolution (the 7 day file). */
export function recentPoints(
	coin: string,
	src: SrcCode,
	samples: Sample[],
	fromSec: number
): SeriesPoints {
	const out = emptyPoints(coin, src);
	for (const sample of samples) {
		if (sample.t >= fromSec) {
			out.t.push(sample.t);
			out.p.push(sample.p);
		}
	}
	return out;
}

/** The samples of every source from `fromSec` on, at full resolution. A source with no sample there is left out. */
export function sourcePoints(
	coin: string,
	bySource: Array<{ src: SrcCode; samples: Sample[] }>,
	fromSec: number
): SeriesSources {
	const sources: SeriesSources['sources'] = [];
	for (const { src, samples } of bySource) {
		const { t, p } = recentPoints(coin, src, samples, fromSec);
		if (t.length > 0) {
			sources.push({ src, t, p });
		}
	}
	return { coin, sources };
}

/** The last sample of every UTC hour, from `fromSec` on (the 90 day file). A missing hour stays missing. */
export function hourlyPoints(
	coin: string,
	src: SrcCode,
	samples: Sample[],
	fromSec: number
): SeriesPoints {
	const out = emptyPoints(coin, src);
	let lastBucket = Number.NaN;
	for (const sample of samples) {
		if (sample.t < fromSec) {
			continue;
		}
		const bucket = Math.floor(sample.t / HOUR_SECONDS);
		if (bucket === lastBucket) {
			out.t[out.t.length - 1] = sample.t;
			out.p[out.p.length - 1] = sample.p;
			continue;
		}
		lastBucket = bucket;
		out.t.push(sample.t);
		out.p.push(sample.p);
	}
	return out;
}

/** Open, high, low and close per UTC day. `t` is the start of the day. */
export function dailyCandles(
	coin: string,
	src: SrcCode,
	samples: Sample[]
): SeriesDaily {
	const out: SeriesDaily = { coin, src, t: [], o: [], h: [], l: [], c: [] };
	let lastDay = '';
	for (const sample of samples) {
		const day = utcDay(sample.ts);
		if (day !== lastDay) {
			lastDay = day;
			out.t.push(Math.floor(parseIso(`${day}T00:00:00Z`) / 1000));
			out.o.push(sample.p);
			out.h.push(sample.p);
			out.l.push(sample.p);
			out.c.push(sample.p);
			continue;
		}
		const last = out.t.length - 1;
		out.h[last] = Math.max(out.h[last], sample.p);
		out.l[last] = Math.min(out.l[last], sample.p);
		out.c[last] = sample.p;
	}
	return out;
}

function changePercent(
	samples: Sample[],
	nowSec: number,
	periodSec: number
): number | null {
	const last = samples[samples.length - 1];
	const tolerance = periodSec * TOLERANCE_SHARE;
	if (last === undefined || nowSec - last.t > tolerance) {
		return null;
	}
	const start = nowSec - periodSec;
	let reference: Sample | undefined;
	for (const sample of samples) {
		const distance = Math.abs(sample.t - start);
		if (
			reference === undefined ||
			distance < Math.abs(reference.t - start)
		) {
			reference = sample;
		}
	}
	if (
		reference === undefined ||
		reference === last ||
		Math.abs(reference.t - start) > tolerance ||
		reference.p === 0
	) {
		return null;
	}
	const change = ((last.p - reference.p) / reference.p) * 100;
	return Math.round(change * 10_000) / 10_000;
}

/**
 * Change, high and low over the last `periodSec` seconds before `nowSec`.
 * The reference of the change is the sample nearest to the period start, and only if it is close enough (5% of the period).
 * With no such sample, or when the last sample is older than that, the change is null instead of a guess.
 */
export function periodStats(
	samples: Sample[],
	nowSec: number,
	periodSec: number
): PeriodStats {
	const start = nowSec - periodSec;
	let high: number | null = null;
	let low: number | null = null;
	for (const sample of samples) {
		if (sample.t < start || sample.t > nowSec) {
			continue;
		}
		high = high === null ? sample.p : Math.max(high, sample.p);
		low = low === null ? sample.p : Math.min(low, sample.p);
	}
	return {
		change_pct: changePercent(samples, nowSec, periodSec),
		high,
		low,
	};
}
