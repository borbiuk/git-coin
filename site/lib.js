// Pure helpers of the dashboard. No DOM access, so node:test can import this file.

export const REPO_URL = 'https://github.com/borbiuk/git-coin';

export const DEFAULT_LIMITS = { warnMinutes: 120, stopMinutes: 360 };

// Each range reads one derived file (ADR 0008 D4) and shows the last `seconds` of it.
export const RANGES = {
	'24h': { file: '7d', seconds: 86400, label: '24h', title: 'last 24 hours' },
	'7d': { file: '7d', seconds: 7 * 86400, label: '7d', title: 'last 7 days' },
	'30d': {
		file: '90d',
		seconds: 30 * 86400,
		label: '30d',
		title: 'last 30 days',
	},
	'90d': {
		file: '90d',
		seconds: 90 * 86400,
		label: '90d',
		title: 'last 90 days',
	},
	all: {
		file: 'daily',
		seconds: Infinity,
		label: 'All',
		title: 'all history (daily closing prices)',
	},
};

const MONTHS = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec',
];

const SOURCES = {
	kr: { name: 'Kraken', url: 'https://www.kraken.com/', credit: null },
	'kr-ohlc': { name: 'Kraken', url: 'https://www.kraken.com/', credit: null },
	cb: {
		name: 'Coinbase',
		url: 'https://exchange.coinbase.com/',
		credit: null,
	},
	bs: { name: 'Bitstamp', url: 'https://www.bitstamp.net/', credit: null },
	cm: {
		name: 'Coin Metrics',
		url: 'https://coinmetrics.io/',
		credit: {
			text: 'Data provided by Coin Metrics, licensed under',
			licence: 'CC BY-NC 4.0',
			licenceUrl: 'https://creativecommons.org/licenses/by-nc/4.0/',
		},
	},
};

function digitsFor(abs) {
	if (abs >= 1) {
		return 2;
	}
	return abs < 0.01 ? 6 : 4;
}

/** US dollars with a precision that fits the size of the price. */
export function formatPrice(value) {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return '–';
	}
	const digits = digitsFor(Math.abs(value));
	return new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
	}).format(value);
}

/** Shorter form for the chart axis: whole dollars from 1,000 up. */
export function formatAxisPrice(value) {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return '';
	}
	const abs = Math.abs(value);
	const digits = abs >= 1000 ? 0 : digitsFor(abs);
	return new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
	}).format(value);
}

/** Percent change with a sign and an arrow, so colour is never the only cue. */
export function formatChange(pct) {
	if (typeof pct !== 'number' || !Number.isFinite(pct)) {
		return { text: 'n/a', arrow: '', direction: 'na' };
	}
	const rounded = Math.round(pct * 100) / 100;
	if (rounded === 0) {
		return { text: '0.00%', arrow: '▬', direction: 'flat' };
	}
	const body = `${Math.abs(rounded).toFixed(2)}%`;
	if (rounded > 0) {
		return { text: `+${body}`, arrow: '▲', direction: 'up' };
	}
	return { text: `−${body}`, arrow: '▼', direction: 'down' };
}

function plural(n, word) {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "12 minutes ago". `ms` is the age in milliseconds. */
export function formatAge(ms) {
	const minutes = Math.floor(Math.max(0, ms) / 60000);
	if (minutes < 1) {
		return 'less than a minute ago';
	}
	if (minutes < 60) {
		return `${plural(minutes, 'minute')} ago`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 48) {
		const rest = minutes % 60;
		const tail = rest > 0 ? ` ${plural(rest, 'minute')}` : '';
		return `${plural(hours, 'hour')}${tail} ago`;
	}
	return `${plural(Math.floor(hours / 24), 'day')} ago`;
}

function pad2(n) {
	return String(n).padStart(2, '0');
}

/** "14:03 UTC", or "28 Oct 14:03 UTC" when the day is not the UTC day of `nowMs`. */
export function formatUtcTime(iso, nowMs) {
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) {
		return 'unknown time';
	}
	const d = new Date(ms);
	const time = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
	const now = new Date(nowMs);
	const sameDay =
		d.getUTCFullYear() === now.getUTCFullYear() &&
		d.getUTCMonth() === now.getUTCMonth() &&
		d.getUTCDate() === now.getUTCDate();
	if (sameDay) {
		return time;
	}
	return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${time}`;
}

/** "Last updated 14:03 UTC (12 minutes ago)". `iso` is `last_point_at`. */
export function formatLastUpdated(iso, nowMs) {
	const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
	if (Number.isNaN(ms)) {
		return 'Last updated: unknown';
	}
	return `Last updated ${formatUtcTime(iso, nowMs)} (${formatAge(nowMs - ms)})`;
}

function positive(value) {
	return typeof value === 'number' && Number.isFinite(value) && value > 0
		? value
		: null;
}

/** The limits come from the status file when it has them, otherwise from the defaults. */
export function staleLimits(status) {
	const warn = positive(status?.stale_warn_minutes);
	const stop = positive(status?.stale_stop_minutes);
	if (warn !== null && stop !== null && stop > warn) {
		return { warnMinutes: warn, stopMinutes: stop };
	}
	return { ...DEFAULT_LIMITS };
}

/** 'fresh', 'delayed' (older than the warn limit), 'stopped' (older than the stop limit) or 'unknown'. */
export function staleState(iso, nowMs, limits = DEFAULT_LIMITS) {
	const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
	if (Number.isNaN(ms)) {
		return 'unknown';
	}
	const ageMinutes = (nowMs - ms) / 60000;
	if (ageMinutes > limits.stopMinutes) {
		return 'stopped';
	}
	if (ageMinutes > limits.warnMinutes) {
		return 'delayed';
	}
	return 'fresh';
}

function formatMinutes(minutes) {
	if (minutes % 60 === 0) {
		return plural(minutes / 60, 'hour');
	}
	return plural(minutes, 'minute');
}

/** Banner text for a stale state, or null when no banner is needed (ADR 0005 D6). */
export function staleBanner(state, limits = DEFAULT_LIMITS) {
	if (state === 'delayed') {
		return {
			level: 'delayed',
			title: 'Data is delayed',
			text: `The newest price is more than ${formatMinutes(limits.warnMinutes)} old. GitHub can run scheduled jobs late.`,
		};
	}
	if (state === 'stopped') {
		return {
			level: 'stopped',
			title: 'Collector appears stopped',
			text: `The newest price is more than ${formatMinutes(limits.stopMinutes)} old. The numbers on this page are old.`,
		};
	}
	if (state === 'unknown') {
		return {
			level: 'delayed',
			title: 'No price data yet',
			text: 'The status file has no time of the last price.',
		};
	}
	return null;
}

/** Name, link and optional licence credit of a source, from the `src` code of the data. */
export function sourceInfo(src) {
	return SOURCES[src] ?? { name: String(src), url: null, credit: null };
}

/** Median distance between neighbouring points, in the unit of `t`. 0 when there are fewer than 2 points. */
export function medianSpacing(t) {
	const gaps = [];
	for (let i = 1; i < t.length; i++) {
		const gap = t[i] - t[i - 1];
		if (gap > 0) {
			gaps.push(gap);
		}
	}
	if (gaps.length === 0) {
		return 0;
	}
	gaps.sort((a, b) => a - b);
	const mid = Math.floor(gaps.length / 2);
	return gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
}

/**
 * Puts a null value after the last point before every gap longer than `factor` times
 * the median spacing, so the line breaks there (ADR 0008 D2). Nothing is interpolated.
 */
export function breakGaps(t, p, factor = 3) {
	const limit = medianSpacing(t) * factor;
	const outT = [];
	const outP = [];
	for (let i = 0; i < t.length; i++) {
		if (i > 0 && limit > 0 && t[i] - t[i - 1] > limit) {
			outT.push(t[i - 1] + limit / factor);
			outP.push(null);
		}
		outT.push(t[i]);
		outP.push(p[i]);
	}
	return { t: outT, p: outP };
}

/** The part of a series that lies within `seconds` before its last point. */
export function sliceRange(series, seconds) {
	const { t, p } = series;
	if (t.length === 0 || !Number.isFinite(seconds)) {
		return { t: t.slice(), p: p.slice() };
	}
	const from = t[t.length - 1] - seconds;
	let start = 0;
	while (start < t.length && t[start] < from) {
		start++;
	}
	return { t: t.slice(start), p: p.slice(start) };
}

/** The daily file as a line of closing prices. */
export function dailyToPoints(daily) {
	return { t: daily.t, p: daily.c };
}

/** True when `obj` has all `keys` as arrays of finite numbers with equal length, and `t` is sorted. */
export function validSeries(obj, keys) {
	if (obj === null || typeof obj !== 'object') {
		return false;
	}
	const first = obj[keys[0]];
	if (!Array.isArray(first)) {
		return false;
	}
	for (const key of keys) {
		const column = obj[key];
		if (!Array.isArray(column) || column.length !== first.length) {
			return false;
		}
		if (!column.every((v) => typeof v === 'number' && Number.isFinite(v))) {
			return false;
		}
	}
	const t = obj.t;
	if (!Array.isArray(t)) {
		return false;
	}
	for (let i = 1; i < t.length; i++) {
		if (t[i] < t[i - 1]) {
			return false;
		}
	}
	return true;
}

/** Same-origin path of a derived series file. */
export function coinDataUrl(id, file) {
	return `data/coins/${encodeURIComponent(id)}.${file}.json`;
}

/** One sentence for the `aria-label` of the chart. */
export function summarizeSeries(coin, rangeKey, series) {
	const title = RANGES[rangeKey]?.title ?? rangeKey;
	const { p } = series;
	if (p.length === 0) {
		return `Price chart of ${coin} in US dollars, ${title}: no data in this range.`;
	}
	const low = Math.min(...p);
	const high = Math.max(...p);
	return (
		`Price chart of ${coin} in US dollars, ${title}: ` +
		`from ${formatPrice(p[0])} to ${formatPrice(p[p.length - 1])}, ` +
		`low ${formatPrice(low)}, high ${formatPrice(high)}, ${plural(p.length, 'point')}.`
	);
}

/** "BTC fell (extreme move)". */
export function alertSummary(alert) {
	const verb = alert.direction === 'up' ? 'rose' : 'fell';
	return `${alert.coin} ${verb} (${alert.severity} move)`;
}

/** Link to an Issue of this repository, or null when the number is not a positive integer. */
export function issueUrl(number) {
	if (!Number.isInteger(number) || number < 1) {
		return null;
	}
	return `${REPO_URL}/issues/${number}`;
}
