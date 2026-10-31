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
	'bs-ohlc': {
		name: 'Bitstamp',
		url: 'https://www.bitstamp.net/',
		credit: null,
	},
	'cb-ohlc': {
		name: 'Coinbase',
		url: 'https://exchange.coinbase.com/',
		credit: null,
	},
	'kt-ohlc': { name: 'Kraken', url: 'https://www.kraken.com/', credit: null },
	'ok-ohlc': { name: 'OKX', url: 'https://www.okx.com/', credit: null },
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

// The unit of the prices. `latest.json` names it: `USD`, or `USDT` when the build converts the prices.
let quote = 'USD';

export function setQuote(value) {
	quote = typeof value === 'string' && value !== '' ? value : 'USD';
}

/** The unit in words, for sentences and screen readers. */
export function quoteName() {
	return quote === 'USD' ? 'US dollars' : quote;
}

/** One number in the unit: a dollar sign for USD, the unit name after the number for any other unit. */
function formatInUnit(value, digits) {
	if (quote === 'USD') {
		return new Intl.NumberFormat('en-US', {
			style: 'currency',
			currency: 'USD',
			minimumFractionDigits: digits,
			maximumFractionDigits: digits,
		}).format(value);
	}
	return `${new Intl.NumberFormat('en-US', {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
	}).format(value)} ${quote}`;
}

/** The price in the unit, with a precision that fits the size of the price. */
export function formatPrice(value) {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return '–';
	}
	return formatInUnit(value, digitsFor(Math.abs(value)));
}

/** The price without the unit name, for tables and headings that name the unit once. USD keeps its sign. */
export function formatPriceBare(value) {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return '–';
	}
	const digits = digitsFor(Math.abs(value));
	if (quote !== 'USD') {
		return new Intl.NumberFormat('en-US', {
			minimumFractionDigits: digits,
			maximumFractionDigits: digits,
		}).format(value);
	}
	return formatInUnit(value, digits);
}

/** Shorter form for the chart axis: whole units from 1,000 up, and no unit name (the chart title has it). */
export function formatAxisPrice(value) {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return '';
	}
	const abs = Math.abs(value);
	const digits = abs >= 1000 ? 0 : digitsFor(abs);
	if (quote !== 'USD') {
		return new Intl.NumberFormat('en-US', {
			minimumFractionDigits: digits,
			maximumFractionDigits: digits,
		}).format(value);
	}
	return formatInUnit(value, digits);
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

/** "30 Oct 13:15 UTC", always with the date. `sec` is epoch seconds. */
export function formatUtcStamp(sec) {
	if (typeof sec !== 'number' || !Number.isFinite(sec)) {
		return 'unknown time';
	}
	const d = new Date(sec * 1000);
	return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

/** The line above the chart while a point is touched or pointed at: time, price and change since the first point. */
export function formatReadout(sec, price, firstPrice) {
	const parts = [formatUtcStamp(sec), formatPriceBare(price)];
	if (firstPrice > 0 && Number.isFinite(price)) {
		parts.push(
			`${formatChange((price / firstPrice - 1) * 100).text} since start`
		);
	}
	return parts.join(' · ');
}

/** One sentence that tells where the older prices come from, or an empty text when there is no history. */
export function historyNote(history, nowMs) {
	if (!history || typeof history.until !== 'string') {
		return '';
	}
	const time = formatUtcTime(history.until, nowMs);
	return `Prices before ${time} are candle closes from the exchanges (Bitstamp, Coinbase, Kraken, OKX): mostly every 15 minutes, once a day for the oldest part of some coins.`;
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

// How each stored source looks in the comparison chart: a colour slot (--series-N), a line dash and a
// marker, so the colour is never the only cue (style guide).
export const COMPARE_STYLES = {
	kr: { slot: 1, dash: [], marker: 'circle' },
	cb: { slot: 2, dash: [9, 6], marker: 'square' },
	bs: { slot: 3, dash: [2, 6], marker: 'triangle' },
	cm: { slot: 4, dash: [10, 4, 2, 4], marker: 'diamond' },
};

/** True when `obj` is a sources file: a list of known sources, each a valid `t` and `p` series. */
export function validSources(obj) {
	if (
		obj === null ||
		typeof obj !== 'object' ||
		!Array.isArray(obj.sources)
	) {
		return false;
	}
	return obj.sources.every(
		(entry) =>
			entry !== null &&
			typeof entry === 'object' &&
			Object.hasOwn(COMPARE_STYLES, entry.src) &&
			validSeries(entry, ['t', 'p'])
	);
}

/**
 * Puts the sources on one time axis. Points of different sources that lie within `windowSeconds`
 * share a time (the first of them), because the sources are read a few seconds apart in one run.
 * A source with no point at a time has `undefined` there, so its line breaks. A gap longer than
 * `factor` times the median spacing gets a row of nulls, as in breakGaps. Nothing is interpolated.
 */
export function mergeSources(sources, windowSeconds = 60, factor = 3) {
	const all = [...new Set(sources.flatMap((s) => s.t))].sort((a, b) => a - b);
	const slotOf = new Map();
	const times = [];
	for (const t of all) {
		if (times.length === 0 || t - times[times.length - 1] > windowSeconds) {
			times.push(t);
		}
		slotOf.set(t, times.length - 1);
	}
	const columns = sources.map((s) => {
		const column = new Array(times.length).fill(undefined);
		s.t.forEach((t, i) => {
			column[slotOf.get(t)] = s.p[i];
		});
		return column;
	});

	const limit = medianSpacing(times) * factor;
	const outT = [];
	const outColumns = columns.map(() => []);
	for (let i = 0; i < times.length; i++) {
		if (i > 0 && limit > 0 && times[i] - times[i - 1] > limit) {
			outT.push(times[i - 1] + limit / factor);
			outColumns.forEach((column) => column.push(null));
		}
		outT.push(times[i]);
		outColumns.forEach((column, k) => column.push(columns[k][i]));
	}
	return { t: outT, columns: outColumns };
}

/** One sentence for the `aria-label` of the comparison chart: the last price of each source. */
export function summarizeSources(coin, sources) {
	const parts = sources.map(
		(s) => `${sourceInfo(s.src).name} ${formatPrice(s.p[s.p.length - 1])}`
	);
	return `Source comparison for ${coin}, last 7 days, last prices: ${parts.join(', ')}.`;
}

// The price that counts as 0% in the coin comparison. The choice is the reader's.
export const BASES = {
	start: { label: 'Start of period' },
	latest: { label: 'Latest price' },
	low: { label: 'Period low' },
	high: { label: 'Period high' },
};

export const MAX_COMPARE_LINES = 50;

/**
 * The change of every price in percent against one price of the same series: the first one, the last
 * one, the lowest or the highest. `baseIndex` is the point that was used, so the chart can mark it.
 */
export function rebase(p, base) {
	if (p.length === 0) {
		return { pct: [], baseIndex: -1 };
	}
	let baseIndex = 0;
	if (base === 'latest') {
		baseIndex = p.length - 1;
	} else if (base === 'low') {
		baseIndex = p.indexOf(Math.min(...p));
	} else if (base === 'high') {
		baseIndex = p.indexOf(Math.max(...p));
	}
	const basePrice = p[baseIndex];
	if (!(basePrice > 0)) {
		return { pct: p.map(() => null), baseIndex };
	}
	return { pct: p.map((v) => (v / basePrice - 1) * 100), baseIndex };
}

/** A tick of the percent axis: "+2.5%", "−10%", "0%". */
export function formatPercentAxis(value) {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return '';
	}
	if (value === 0) {
		return '0%';
	}
	const digits = Math.abs(value) >= 10 || Number.isInteger(value) ? 0 : 1;
	const body = `${Math.abs(value).toFixed(digits)}%`;
	return value > 0 ? `+${body}` : `−${body}`;
}

/** One sentence for the `aria-label` of the coin comparison: how many coins, the base, the best and the worst. */
export function summarizeChanges(rangeKey, baseKey, items) {
	const title = RANGES[rangeKey]?.title ?? rangeKey;
	const base = (BASES[baseKey]?.label ?? baseKey).toLowerCase();
	if (items.length === 0) {
		return `Percent change chart, ${title}: no coins selected.`;
	}
	const sorted = [...items].sort((a, b) => b.pct - a.pct);
	const best = sorted[0];
	const worst = sorted[sorted.length - 1];
	return (
		`Percent change of ${plural(items.length, 'coin')} against ${base}, ${title}. ` +
		`At the latest point the highest is ${best.id} ${formatChange(best.pct).text} ` +
		`and the lowest is ${worst.id} ${formatChange(worst.pct).text}.`
	);
}

/** The spans of `filled` that reach into the time from `from` on, cut at `from`. Bad entries are dropped. */
export function clipFilled(filled, from) {
	if (!Array.isArray(filled)) {
		return [];
	}
	return filled
		.filter(
			(span) =>
				Array.isArray(span) &&
				span.length === 2 &&
				Number.isFinite(span[0]) &&
				Number.isFinite(span[1]) &&
				span[1] > from
		)
		.map((span) => [Math.max(span[0], from), span[1]]);
}

/**
 * The part of a series that lies within `seconds` before its last point. `filled` is the list of
 * time spans of missed runs that were filled with candles. It is kept, cut at the start of the range.
 */
export function sliceRange(series, seconds) {
	const { t, p } = series;
	if (t.length === 0 || !Number.isFinite(seconds)) {
		return withFilled(
			{ t: t.slice(), p: p.slice() },
			series.filled,
			-Infinity
		);
	}
	const from = t[t.length - 1] - seconds;
	let start = 0;
	while (start < t.length && t[start] < from) {
		start++;
	}
	return withFilled(
		{ t: t.slice(start), p: p.slice(start) },
		series.filled,
		from
	);
}

function withFilled(out, filled, from) {
	const spans = clipFilled(filled, from);
	if (spans.length > 0) {
		out.filled = spans;
	}
	return out;
}

/** A length of time in words: "20 minutes", "6 hours", "3 days". `seconds` is rounded to the nearest unit. */
export function formatSpan(seconds) {
	const minutes = Math.max(1, Math.round(seconds / 60));
	if (minutes < 60) {
		return plural(minutes, 'minute');
	}
	const hours = Math.round(minutes / 60);
	if (hours < 48) {
		return plural(hours, 'hour');
	}
	return plural(Math.round(hours / 24), 'day');
}

/** One sentence that explains the shaded bands of a chart, or an empty text when the range has none. */
export function filledNote(filled) {
	if (!Array.isArray(filled) || filled.length === 0) {
		return '';
	}
	const total = filled.reduce((sum, [from, to]) => sum + (to - from), 0);
	return `Shaded: no scheduled run in this time (${formatSpan(total)} in this range). The prices there are 15-minute candle closes from the exchanges. Hatched: no data.`;
}

// Ten colours for the coins of the comparison. The pairs of a theme are in style.css (--coin-1 to --coin-10).
export const COIN_COLOURS = 10;

/** The colour slot (1 to 10) of a coin: its place in the list of coins, so a coin keeps its colour. */
export function coinSlot(ids, id) {
	const index = ids.indexOf(id);
	return ((index < 0 ? 0 : index) % COIN_COLOURS) + 1;
}

/** "#BTC/7d": the coin and the range of the chart, so a link opens the same view. */
export function hashFor(coin, range) {
	return `#${encodeURIComponent(coin)}/${encodeURIComponent(range)}`;
}

/** The coin and the range in a URL hash. A missing or unknown part is null. Old links have only the coin. */
export function parseHash(hash) {
	const [coinPart = '', rangePart = ''] = String(hash)
		.replace(/^#/, '')
		.split('/');
	const decode = (text) => {
		try {
			return decodeURIComponent(text);
		} catch {
			return '';
		}
	};
	const coin = decode(coinPart);
	const range = decode(rangePart);
	return {
		coin: coin === '' ? null : coin,
		range: Object.hasOwn(RANGES, range) ? range : null,
	};
}

// The columns of the table of all coins. The first click on a column gives its natural order.
export const SORT_KEYS = {
	order: { dir: 'asc' },
	coin: { dir: 'asc' },
	price: { dir: 'desc' },
	'24h': { dir: 'desc' },
	'7d': { dir: 'desc' },
	'30d': { dir: 'desc' },
};

/**
 * The state after a click on a column. A new column starts with its own direction, the second click flips
 * it, and the third click goes back to the order of the coin list.
 */
export function nextSort(current, key) {
	const natural = SORT_KEYS[key]?.dir ?? 'desc';
	if (current.key !== key) {
		return { key, dir: natural };
	}
	if (current.dir === natural) {
		return { key, dir: natural === 'asc' ? 'desc' : 'asc' };
	}
	return { key: 'order', dir: 'asc' };
}

/** A copy of the rows in the order of the sort. Rows without a value come last in both directions. */
export function sortOverview(rows, sort) {
	const value = (row) => {
		if (sort.key === 'coin') {
			return row.id;
		}
		return row[sort.key] ?? null;
	};
	const sign = sort.dir === 'asc' ? 1 : -1;
	return rows
		.map((row, index) => ({ row, index }))
		.sort((a, b) => {
			const x = value(a.row);
			const y = value(b.row);
			if (x === null && y === null) {
				return a.index - b.index;
			}
			if (x === null) {
				return 1;
			}
			if (y === null) {
				return -1;
			}
			const order = typeof x === 'string' ? x.localeCompare(y) : x - y;
			return order * sign || a.index - b.index;
		})
		.map((item) => item.row);
}

/**
 * The points of a sparkline as fractions of its box: x from the first to the last time, y from the lowest
 * (0) to the highest (1) price of the series itself. At most `max` points are kept, the last one always.
 */
export function sparkPoints(t, p, max = 96) {
	if (t.length < 2 || t.length !== p.length) {
		return null;
	}
	const low = Math.min(...p);
	const high = Math.max(...p);
	const first = t[0];
	const span = t[t.length - 1] - first;
	const step = Math.max(1, Math.ceil((t.length - 1) / (max - 1)));
	const points = [];
	for (let i = 0; i < t.length; i += step) {
		points.push(i);
	}
	if (points[points.length - 1] !== t.length - 1) {
		points.push(t.length - 1);
	}
	return {
		x: points.map((i) => (span > 0 ? (t[i] - first) / span : 0)),
		y: points.map((i) => (high > low ? (p[i] - low) / (high - low) : 0.5)),
	};
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
		return `Price chart of ${coin} in ${quoteName()}, ${title}: no data in this range.`;
	}
	const low = Math.min(...p);
	const high = Math.max(...p);
	return (
		`Price chart of ${coin} in ${quoteName()}, ${title}: ` +
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
