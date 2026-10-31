import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// site/lib.js is plain JavaScript for the browser and has no type declarations
// @ts-expect-error the dashboard code is not part of the TypeScript project
import * as lib from '../../site/lib.js';

const siteDir = join(import.meta.dirname, '..', '..', 'site');
const dataDir = join(import.meta.dirname, '..', 'fixtures', 'ui', 'data');

function readJson(...parts: string[]) {
	return JSON.parse(readFileSync(join(dataDir, ...parts), 'utf8'));
}

const MIN = 60 * 1000;
const NOW = Date.parse('2026-10-29T14:15:00Z');

test('formatPrice picks the precision from the size of the price', () => {
	assert.equal(lib.formatPrice(47349.8), '$47,349.80');
	assert.equal(lib.formatPrice(2.5), '$2.50');
	assert.equal(lib.formatPrice(0.22325), '$0.2233');
	assert.equal(lib.formatPrice(0.00123456), '$0.001235');
});

test('with the unit USDT, formatPrice puts the unit name after the number and the axis has none', () => {
	lib.setQuote('USDT');
	try {
		assert.equal(lib.quoteName(), 'USDT');
		assert.equal(lib.formatPrice(47349.8), '47,349.80 USDT');
		assert.equal(lib.formatPrice(0.22325), '0.2233 USDT');
		assert.equal(lib.formatAxisPrice(47349.8), '47,350');
		assert.equal(lib.formatAxisPrice(2.5), '2.50');
		assert.match(
			lib.summarizeSeries('BTC', '7d', { t: [1], p: [1] }),
			/^Price chart of BTC in USDT, /
		);
	} finally {
		lib.setQuote('USD');
	}
	assert.equal(lib.quoteName(), 'US dollars');
	assert.equal(lib.formatPrice(2.5), '$2.50');
	lib.setQuote(undefined);
	assert.equal(lib.formatPrice(2.5), '$2.50');
});

test('formatPrice shows a dash for a missing or invalid value', () => {
	assert.equal(lib.formatPrice(null), '–');
	assert.equal(lib.formatPrice(undefined), '–');
	assert.equal(lib.formatPrice(Number.NaN), '–');
	assert.equal(lib.formatPrice('5'), '–');
});

test('formatAxisPrice drops the cents from 1,000 up', () => {
	assert.equal(lib.formatAxisPrice(47000), '$47,000');
	assert.equal(lib.formatAxisPrice(3768.61), '$3,769');
	assert.equal(lib.formatAxisPrice(15.5), '$15.50');
	assert.equal(lib.formatAxisPrice(0.215), '$0.2150');
	assert.equal(lib.formatAxisPrice(null), '');
});

test('formatChange gives a sign and an arrow', () => {
	assert.deepEqual(lib.formatChange(1.234), {
		text: '+1.23%',
		arrow: '▲',
		direction: 'up',
	});
	assert.deepEqual(lib.formatChange(-0.5), {
		text: '−0.50%',
		arrow: '▼',
		direction: 'down',
	});
});

test('formatChange treats a value that rounds to zero as flat', () => {
	assert.equal(lib.formatChange(0).direction, 'flat');
	assert.equal(lib.formatChange(0.004).text, '0.00%');
	assert.equal(lib.formatChange(-0.004).direction, 'flat');
});

test('formatChange handles a missing value', () => {
	assert.deepEqual(lib.formatChange(null), {
		text: 'n/a',
		arrow: '',
		direction: 'na',
	});
	assert.equal(lib.formatChange(Number.NaN).direction, 'na');
});

test('formatAge writes minutes, hours and days', () => {
	assert.equal(lib.formatAge(20 * 1000), 'less than a minute ago');
	assert.equal(lib.formatAge(MIN), '1 minute ago');
	assert.equal(lib.formatAge(12 * MIN), '12 minutes ago');
	assert.equal(lib.formatAge(60 * MIN), '1 hour ago');
	assert.equal(lib.formatAge(125 * MIN), '2 hours 5 minutes ago');
	assert.equal(lib.formatAge(50 * 60 * MIN), '2 days ago');
});

test('formatAge treats a time in the future as just now', () => {
	assert.equal(lib.formatAge(-5 * MIN), 'less than a minute ago');
});

test('formatUtcTime shows the date only when it is not today (UTC)', () => {
	assert.equal(lib.formatUtcTime('2026-10-29T14:03:00Z', NOW), '14:03 UTC');
	assert.equal(
		lib.formatUtcTime('2026-10-28T09:05:00Z', NOW),
		'28 Oct 09:05 UTC'
	);
	assert.equal(lib.formatUtcTime('nonsense', NOW), 'unknown time');
});

test('formatLastUpdated combines the time and the age', () => {
	assert.equal(
		lib.formatLastUpdated('2026-10-29T14:03:00Z', NOW),
		'Last updated 14:03 UTC (12 minutes ago)'
	);
	assert.equal(lib.formatLastUpdated(null, NOW), 'Last updated: unknown');
	assert.equal(lib.formatLastUpdated('bad', NOW), 'Last updated: unknown');
});

test('staleState uses 120 minutes and 6 hours by default', () => {
	const at = (minutesAgo: number) =>
		new Date(NOW - minutesAgo * MIN).toISOString();
	assert.equal(lib.staleState(at(5), NOW), 'fresh');
	assert.equal(lib.staleState(at(120), NOW), 'fresh');
	assert.equal(lib.staleState(at(121), NOW), 'delayed');
	assert.equal(lib.staleState(at(360), NOW), 'delayed');
	assert.equal(lib.staleState(at(361), NOW), 'stopped');
	assert.equal(lib.staleState(at(5000), NOW), 'stopped');
});

test('staleState is unknown without a valid time, and fresh for a time in the future', () => {
	assert.equal(lib.staleState(null, NOW), 'unknown');
	assert.equal(lib.staleState('bad', NOW), 'unknown');
	assert.equal(
		lib.staleState(new Date(NOW + 10 * MIN).toISOString(), NOW),
		'fresh'
	);
});

test('staleState accepts other limits', () => {
	const limits = { warnMinutes: 30, stopMinutes: 60 };
	const at = (minutesAgo: number) =>
		new Date(NOW - minutesAgo * MIN).toISOString();
	assert.equal(lib.staleState(at(31), NOW, limits), 'delayed');
	assert.equal(lib.staleState(at(61), NOW, limits), 'stopped');
});

test('staleLimits reads the status file and falls back to the defaults', () => {
	assert.deepEqual(
		lib.staleLimits({ stale_warn_minutes: 90, stale_stop_minutes: 240 }),
		{ warnMinutes: 90, stopMinutes: 240 }
	);
	const defaults = { warnMinutes: 120, stopMinutes: 360 };
	assert.deepEqual(lib.staleLimits(null), defaults);
	assert.deepEqual(lib.staleLimits({}), defaults);
	assert.deepEqual(lib.staleLimits({ stale_warn_minutes: 'x' }), defaults);
	assert.deepEqual(
		lib.staleLimits({ stale_warn_minutes: 300, stale_stop_minutes: 100 }),
		defaults
	);
});

test('staleBanner has text for delayed, stopped and unknown only', () => {
	assert.equal(lib.staleBanner('fresh'), null);
	assert.equal(lib.staleBanner('delayed').title, 'Data is delayed');
	assert.match(lib.staleBanner('delayed').text, /more than 2 hours old/);
	assert.equal(lib.staleBanner('stopped').title, 'Collector appears stopped');
	assert.match(lib.staleBanner('stopped').text, /more than 6 hours old/);
	assert.equal(lib.staleBanner('unknown').title, 'No price data yet');
	assert.match(
		lib.staleBanner('delayed', { warnMinutes: 90, stopMinutes: 240 }).text,
		/more than 90 minutes old/
	);
});

test('historyNote says where the older prices end and where they come from', () => {
	const now = Date.parse('2026-10-30T10:00:00Z');
	assert.match(
		lib.historyNote({ src: 'bs-ohlc', until: '2026-10-29T20:46:24Z' }, now),
		/^Prices before 29 Oct 20:46 UTC are candle closes from the exchanges .*every 15 minutes/
	);
	assert.equal(lib.historyNote(undefined, now), '');
	assert.equal(lib.historyNote({ src: 'bs-ohlc' }, now), '');
});

test('sourceInfo names the source and links it', () => {
	assert.equal(lib.sourceInfo('kr').name, 'Kraken');
	assert.equal(lib.sourceInfo('kr-ohlc').name, 'Kraken');
	assert.equal(lib.sourceInfo('cb').name, 'Coinbase');
	assert.equal(lib.sourceInfo('bs').name, 'Bitstamp');
	assert.equal(lib.sourceInfo('bs-ohlc').name, 'Bitstamp');
	assert.equal(lib.sourceInfo('cb-ohlc').name, 'Coinbase');
	assert.equal(lib.sourceInfo('kt-ohlc').name, 'Kraken');
	assert.equal(lib.sourceInfo('ok-ohlc').name, 'OKX');
	assert.equal(lib.sourceInfo('cm').name, 'Coin Metrics');
	for (const src of ['kr', 'cb', 'bs', 'cm']) {
		assert.match(lib.sourceInfo(src).url, /^https:\/\//);
	}
});

test('only Coin Metrics carries a licence credit', () => {
	assert.equal(lib.sourceInfo('kr').credit, null);
	assert.equal(lib.sourceInfo('cb').credit, null);
	assert.equal(lib.sourceInfo('bs').credit, null);
	assert.equal(lib.sourceInfo('cm').credit.licence, 'CC BY-NC 4.0');
	assert.match(lib.sourceInfo('cm').credit.licenceUrl, /^https:\/\//);
});

test('sourceInfo does not fail on an unknown code', () => {
	assert.deepEqual(lib.sourceInfo('zz'), {
		name: 'zz',
		url: null,
		credit: null,
	});
});

test('medianSpacing returns the median distance of neighbours', () => {
	assert.equal(lib.medianSpacing([0, 10, 20, 30]), 10);
	assert.equal(lib.medianSpacing([0, 10, 20, 100]), 10);
	assert.equal(lib.medianSpacing([0, 10, 30]), 15);
	assert.equal(lib.medianSpacing([5]), 0);
	assert.equal(lib.medianSpacing([]), 0);
});

test('breakGaps leaves a regular series as it is', () => {
	const out = lib.breakGaps([0, 10, 20, 30], [1, 2, 3, 4]);
	assert.deepEqual(out, { t: [0, 10, 20, 30], p: [1, 2, 3, 4] });
});

test('breakGaps adds a null after the last point before a long gap', () => {
	const t = [0, 10, 20, 30, 100, 110];
	const out = lib.breakGaps(t, [1, 2, 3, 4, 5, 6]);
	assert.deepEqual(out.t, [0, 10, 20, 30, 40, 100, 110]);
	assert.deepEqual(out.p, [1, 2, 3, 4, null, 5, 6]);
});

test('breakGaps breaks only above 3 times the median spacing', () => {
	assert.deepEqual(
		lib.breakGaps([0, 10, 20, 50], [1, 2, 3, 4]).p,
		[1, 2, 3, 4]
	);
	assert.deepEqual(lib.breakGaps([0, 10, 20, 51], [1, 2, 3, 4]).p, [
		1,
		2,
		3,
		null,
		4,
	]);
});

test('breakGaps keeps the time axis sorted and does not change its input', () => {
	const t = [0, 10, 20, 30, 100, 110, 400, 410];
	const p = [1, 2, 3, 4, 5, 6, 7, 8];
	const out = lib.breakGaps(t, p);
	for (let i = 1; i < out.t.length; i++) {
		assert.ok(out.t[i] > out.t[i - 1]);
	}
	assert.equal(out.p.filter((v: number | null) => v === null).length, 2);
	assert.deepEqual(t, [0, 10, 20, 30, 100, 110, 400, 410]);
	assert.deepEqual(p, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('breakGaps handles empty and single point series', () => {
	assert.deepEqual(lib.breakGaps([], []), { t: [], p: [] });
	assert.deepEqual(lib.breakGaps([5], [1]), { t: [5], p: [1] });
});

test('sliceRange keeps the points within the range before the last point', () => {
	const series = { t: [0, 10, 20, 30, 40], p: [1, 2, 3, 4, 5] };
	assert.deepEqual(lib.sliceRange(series, 20), {
		t: [20, 30, 40],
		p: [3, 4, 5],
	});
	assert.deepEqual(lib.sliceRange(series, 5), { t: [40], p: [5] });
});

test('sliceRange returns a copy of everything for an infinite range', () => {
	const series = { t: [0, 10], p: [1, 2] };
	const out = lib.sliceRange(series, Infinity);
	assert.deepEqual(out, series);
	assert.notEqual(out.t, series.t);
	assert.deepEqual(lib.sliceRange({ t: [], p: [] }, 100), { t: [], p: [] });
});

test('dailyToPoints uses the closing prices', () => {
	assert.deepEqual(
		lib.dailyToPoints({
			t: [1, 2],
			o: [5, 5],
			h: [9, 9],
			l: [4, 4],
			c: [6, 7],
		}),
		{ t: [1, 2], p: [6, 7] }
	);
});

test('every range names one of the three derived files', () => {
	const files = Object.values<{ file: string }>(lib.RANGES).map(
		(r) => r.file
	);
	assert.deepEqual(Object.keys(lib.RANGES), [
		'24h',
		'7d',
		'30d',
		'90d',
		'all',
	]);
	assert.deepEqual(files, ['7d', '7d', '90d', '90d', 'daily']);
});

test('validSeries accepts equal length numeric columns with sorted time', () => {
	assert.equal(
		lib.validSeries({ t: [1, 2, 3], p: [5, 6, 7] }, ['t', 'p']),
		true
	);
	assert.equal(lib.validSeries({ t: [], p: [] }, ['t', 'p']), true);
});

test('validSeries rejects broken data', () => {
	assert.equal(lib.validSeries(null, ['t', 'p']), false);
	assert.equal(lib.validSeries('x', ['t', 'p']), false);
	assert.equal(lib.validSeries({ t: [1, 2] }, ['t', 'p']), false);
	assert.equal(lib.validSeries({ t: [1, 2], p: [5] }, ['t', 'p']), false);
	assert.equal(
		lib.validSeries({ t: [1, 2], p: [5, null] }, ['t', 'p']),
		false
	);
	assert.equal(
		lib.validSeries({ t: [1, 2], p: ['5', '6'] }, ['t', 'p']),
		false
	);
	assert.equal(
		lib.validSeries({ t: [1, Number.NaN], p: [5, 6] }, ['t', 'p']),
		false
	);
	assert.equal(lib.validSeries({ t: [2, 1], p: [5, 6] }, ['t', 'p']), false);
});

test('coinDataUrl is a same-origin path and encodes the coin id', () => {
	assert.equal(lib.coinDataUrl('BTC', '7d'), 'data/coins/BTC.7d.json');
	assert.equal(
		lib.coinDataUrl('a/b', 'daily'),
		'data/coins/a%2Fb.daily.json'
	);
});

test('summarizeSeries writes one sentence with the first, last, low and high price', () => {
	const text = lib.summarizeSeries('BTC', '7d', {
		t: [1, 2, 3],
		p: [100, 90, 110],
	});
	assert.equal(
		text,
		'Price chart of BTC in US dollars, last 7 days: from $100.00 to $110.00, low $90.00, high $110.00, 3 points.'
	);
});

test('summarizeSeries says so when the range has no data', () => {
	assert.equal(
		lib.summarizeSeries('ETH', '24h', { t: [], p: [] }),
		'Price chart of ETH in US dollars, last 24 hours: no data in this range.'
	);
});

test('alertSummary and issueUrl describe an alert', () => {
	assert.equal(
		lib.alertSummary({
			coin: 'BTC',
			direction: 'down',
			severity: 'extreme',
		}),
		'BTC fell (extreme move)'
	);
	assert.equal(
		lib.alertSummary({ coin: 'ETH', direction: 'up', severity: 'high' }),
		'ETH rose (high move)'
	);
	assert.equal(
		lib.issueUrl(12),
		'https://github.com/borbiuk/git-coin/issues/12'
	);
});

test('issueUrl refuses a number that is not a positive integer', () => {
	assert.equal(lib.issueUrl(0), null);
	assert.equal(lib.issueUrl(-3), null);
	assert.equal(lib.issueUrl(1.5), null);
	assert.equal(lib.issueUrl('7'), null);
	assert.equal(lib.issueUrl(undefined), null);
});

test('the sample data has the shapes the page reads', () => {
	const latest = readJson('latest.json');
	const status = readJson('status.json');
	const alerts = readJson('alerts.json');
	assert.equal(latest.src, 'kr');
	assert.equal(latest.quote, 'USD');
	assert.deepEqual(Object.keys(latest.coins), ['BTC', 'ETH', 'DOGE']);
	assert.equal(status.coins.XLM.status, 'source_missing');
	assert.ok(!('XLM' in latest.coins));
	assert.equal(alerts.alerts.length, 3);

	for (const id of Object.keys(latest.coins)) {
		for (const file of ['7d', '90d']) {
			assert.equal(
				lib.validSeries(readJson('coins', `${id}.${file}.json`), [
					't',
					'p',
				]),
				true
			);
		}
		const daily = readJson('coins', `${id}.daily.json`);
		assert.equal(lib.validSeries(daily, ['t', 'o', 'h', 'l', 'c']), true);
		assert.ok(daily.t.length > 30);
	}
});

test('the sample 7 day and 90 day series each hold one gap that breakGaps marks', () => {
	for (const file of ['7d', '90d']) {
		const series = readJson('coins', `BTC.${file}.json`);
		const out = lib.breakGaps(series.t, series.p);
		const nulls = out.p.filter((v: number | null) => v === null).length;
		assert.equal(nulls, 1, `${file} series`);
	}
});

test('the sample sources file is valid and merges onto one time axis with one gap row', () => {
	const file = readJson('coins', 'BTC.sources.json');
	assert.equal(lib.validSources(file), true);
	const merged = lib.mergeSources(file.sources);
	assert.equal(merged.columns.length, 4);
	for (const column of merged.columns) {
		assert.equal(column.length, merged.t.length);
	}
	// The sources are read seconds apart, so they share one time per run (626 runs and one gap row)
	assert.equal(merged.t.length, 627);
	const gapRows = merged.t.filter((_: number, i: number) =>
		merged.columns.every((column: unknown[]) => column[i] === null)
	);
	assert.equal(gapRows.length, 1);
});

test('mergeSources keeps a missing point as undefined and never interpolates', () => {
	const merged = lib.mergeSources([
		{ src: 'kr', t: [0, 600, 1200], p: [1, 2, 3] },
		{ src: 'cb', t: [1, 1201], p: [10, 30] },
	]);
	assert.deepEqual(merged.t, [0, 600, 1200]);
	assert.deepEqual(merged.columns, [
		[1, 2, 3],
		[10, undefined, 30],
	]);
});

test('mergeSources puts a row of nulls into a gap longer than three times the spacing', () => {
	const merged = lib.mergeSources([
		{ src: 'kr', t: [0, 300, 600, 900, 5000], p: [1, 2, 3, 4, 5] },
	]);
	assert.deepEqual(merged.t, [0, 300, 600, 900, 1200, 5000]);
	assert.deepEqual(merged.columns, [[1, 2, 3, 4, null, 5]]);
});

test('validSources accepts known sources with valid series and nothing else', () => {
	const good = { src: 'kr', t: [1, 2], p: [1, 2] };
	assert.equal(lib.validSources({ sources: [good] }), true);
	assert.equal(lib.validSources({ sources: [] }), true);
	assert.equal(lib.validSources({ sources: [{ ...good, src: 'x' }] }), false);
	assert.equal(lib.validSources({ sources: [{ ...good, p: [1] }] }), false);
	assert.equal(
		lib.validSources({ sources: [{ ...good, t: [2, 1] }] }),
		false
	);
	assert.equal(lib.validSources({ sources: 'kr' }), false);
	assert.equal(lib.validSources(null), false);
});

test('summarizeSources names every source with its last price', () => {
	assert.equal(
		lib.summarizeSources('BTC', [
			{ src: 'kr', t: [1, 2], p: [99, 100] },
			{ src: 'cb', t: [1, 2], p: [99, 101.5] },
		]),
		'Source comparison for BTC, last 7 days, last prices: Kraken $100.00, Coinbase $101.50.'
	);
});

test('rebase gives the percent change against the chosen base and names the base point', () => {
	const p = [100, 120, 80, 110];
	const start = lib.rebase(p, 'start');
	assert.equal(start.baseIndex, 0);
	assert.deepEqual(
		start.pct.map((v: number) => Math.round(v)),
		[0, 20, -20, 10]
	);
	const latest = lib.rebase(p, 'latest');
	assert.equal(latest.baseIndex, 3);
	assert.equal(latest.pct[3], 0);
	assert.ok(Math.abs(latest.pct[0] - (100 / 110 - 1) * 100) < 1e-9);
	const low = lib.rebase(p, 'low');
	assert.equal(low.baseIndex, 2);
	assert.deepEqual(
		low.pct.map((v: number) => Math.round(v)),
		[25, 50, 0, 38]
	);
	const high = lib.rebase(p, 'high');
	assert.equal(high.baseIndex, 1);
	assert.ok(high.pct.every((v: number) => v <= 0));
});

test('rebase handles an empty series and a base price that is not positive', () => {
	assert.deepEqual(lib.rebase([], 'start'), { pct: [], baseIndex: -1 });
	assert.deepEqual(lib.rebase([0, 1], 'start'), {
		pct: [null, null],
		baseIndex: 0,
	});
});

test('formatPercentAxis writes the sign, the real minus and a fitting number of digits', () => {
	assert.equal(lib.formatPercentAxis(0), '0%');
	assert.equal(lib.formatPercentAxis(2.5), '+2.5%');
	assert.equal(lib.formatPercentAxis(-2.5), '−2.5%');
	assert.equal(lib.formatPercentAxis(10), '+10%');
	assert.equal(lib.formatPercentAxis(-12.5), '−13%');
	assert.equal(lib.formatPercentAxis(Number.NaN), '');
});

test('summarizeChanges names the base, the best and the worst coin', () => {
	assert.equal(
		lib.summarizeChanges('7d', 'start', [
			{ id: 'BTC', pct: 1.8 },
			{ id: 'SOL', pct: 4.1 },
			{ id: 'XRP', pct: -3 },
		]),
		'Percent change of 3 coins against start of period, last 7 days. At the latest point the highest is SOL +4.10% and the lowest is XRP −3.00%.'
	);
	assert.equal(
		lib.summarizeChanges('7d', 'low', []),
		'Percent change chart, last 7 days: no coins selected.'
	);
});

test('the sample data is fresh at its own time and stopped a day later', () => {
	const status = readJson('status.json');
	const at = Date.parse(status.last_point_at);
	assert.equal(lib.staleState(status.last_point_at, at + 10 * MIN), 'fresh');
	assert.equal(
		lib.staleState(status.last_point_at, at + 24 * 60 * MIN),
		'stopped'
	);
});

test('index.html loads only files of its own origin', () => {
	const html = readFileSync(join(siteDir, 'index.html'), 'utf8');
	const urls = [
		...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g),
		...html.matchAll(/<link[^>]*\shref="([^"]+)"/g),
	].map((m) => m[1]);
	assert.ok(urls.length >= 4);
	for (const url of urls) {
		assert.ok(
			url.startsWith('data:') || !/^(?:[a-z]+:)?\/\//i.test(url),
			`not same-origin: ${url}`
		);
	}
});

test('the one chart sits in a panel with a button that can show it on the whole page', () => {
	const html = readFileSync(join(siteDir, 'index.html'), 'utf8');
	const app = readFileSync(join(siteDir, 'app.js'), 'utf8');
	assert.match(
		html,
		/id="multi-panel"[^>]*class="panel"|class="panel"[^>]*id="multi-panel"/
	);
	assert.match(html, /aria-controls="multi-panel"/);
	assert.match(html, /id="multi-panel-title"/);
	assert.match(app, /'multi-panel':/);
	assert.equal(html.match(/class="expand"/g)?.length, 1);
	assert.equal(html.match(/<div[^>]*class="chart"/g)?.length, 1);
});

test('the coins on the chart are chosen in the table and in the list of the whole page view', () => {
	const html = readFileSync(join(siteDir, 'index.html'), 'utf8');
	const app = readFileSync(join(siteDir, 'app.js'), 'utf8');
	// The list of coins is inside the panel, so it goes full page with the chart
	const panel = html.slice(html.indexOf('id="multi-panel"'));
	assert.ok(
		panel.indexOf('id="multi-coins"') < panel.indexOf('id="multi-chart"')
	);
	assert.match(app, /class: 'show-coin'/);
	assert.match(app, /class: `chip coin-chip /);
	// The old blocks are gone: the coin buttons, the details of one coin and the notes
	for (const text of [
		'id="detail"',
		'id="coins"',
		'id="multi-table"',
		'About this data',
		'Not financial advice',
		'collected on a schedule and kept in git',
	]) {
		assert.ok(!html.includes(text), text);
	}
});

test('app.js records the vendored uPlot version and fetches only own data files', () => {
	const app = readFileSync(join(siteDir, 'app.js'), 'utf8');
	assert.match(app.split('\n').slice(0, 3).join('\n'), /uPlot 1\.6\.32/);
	for (const m of app.matchAll(/fetchJson\('([^']+)'\)/g)) {
		assert.match(m[1], /^data\/[a-z]+\.json$/);
	}
	assert.doesNotMatch(app, /https?:\/\//);
});

test('the vendored uPlot files are the expected version and have a licence', () => {
	const js = readFileSync(
		join(siteDir, 'vendor', 'uPlot.iife.min.js'),
		'utf8'
	);
	assert.match(js.slice(0, 120), /uPlot \(v1\.6\.32\)/);
	const licence = readFileSync(
		join(siteDir, 'vendor', 'uPlot.LICENSE.txt'),
		'utf8'
	);
	assert.match(licence, /MIT License/);
});

test('sliceRange keeps the filled spans of the range and cuts the one that crosses its start', () => {
	const series = {
		t: [0, 10, 20, 30, 40],
		p: [1, 2, 3, 4, 5],
		filled: [
			[2, 8],
			[12, 25],
			[32, 38],
		],
	};
	assert.deepEqual(lib.sliceRange(series, 25).filled, [
		[15, 25],
		[32, 38],
	]);
	assert.deepEqual(lib.sliceRange(series, 2).filled, undefined);
	assert.equal('filled' in lib.sliceRange({ t: [1], p: [1] }, 5), false);
	assert.deepEqual(lib.sliceRange(series, Infinity).filled, series.filled);
});

test('clipFilled drops entries that are not a pair of numbers', () => {
	assert.deepEqual(
		lib.clipFilled([[1, 5], 'x', [1], [Number.NaN, 4], [2, 9]], 3),
		[
			[3, 5],
			[3, 9],
		]
	);
	assert.deepEqual(lib.clipFilled(undefined, 0), []);
});

test('filledNote explains the shaded bands only when the range has some', () => {
	assert.equal(lib.filledNote(undefined), '');
	assert.equal(lib.filledNote([]), '');
	assert.match(lib.filledNote([[1, 2]]), /no scheduled run/i);
	assert.match(lib.filledNote([[1, 2]]), /hatched: no data/i);
});

test('filledNote tells how much time of the range was filled', () => {
	assert.match(lib.filledNote([[0, 3600 * 2]]), /\(2 hours in this range\)/);
	assert.match(
		lib.filledNote([
			[0, 3600],
			[7200, 10800],
		]),
		/\(2 hours in this range\)/
	);
});

test('formatSpan writes minutes, hours and days', () => {
	assert.equal(lib.formatSpan(30), '1 minute');
	assert.equal(lib.formatSpan(20 * 60), '20 minutes');
	assert.equal(lib.formatSpan(90 * 60), '2 hours');
	assert.equal(lib.formatSpan(47 * 3600), '47 hours');
	assert.equal(lib.formatSpan(3 * 86400), '3 days');
});

test('formatPriceBare leaves the unit name to the heading', () => {
	assert.equal(lib.formatPriceBare(47349.8), '$47,349.80');
	lib.setQuote('USDT');
	try {
		assert.equal(lib.formatPriceBare(47349.8), '47,349.80');
		assert.equal(lib.formatPriceBare(0.22325), '0.2233');
		assert.equal(lib.formatPriceBare(null), '–');
	} finally {
		lib.setQuote('USD');
	}
});

test('formatUtcStamp and formatReadout always show the date, the price and the change since the start', () => {
	const sec = Date.parse('2026-10-30T13:15:00Z') / 1000;
	assert.equal(lib.formatUtcStamp(sec), '30 Oct 13:15 UTC');
	assert.equal(lib.formatUtcStamp(Number.NaN), 'unknown time');
	lib.setQuote('USDT');
	try {
		assert.equal(
			lib.formatReadout(sec, 99, 100),
			'30 Oct 13:15 UTC · 99.00 · −1.00% since start'
		);
		assert.equal(lib.formatReadout(sec, 99, 0), '30 Oct 13:15 UTC · 99.00');
	} finally {
		lib.setQuote('USD');
	}
});

test('coinSlot gives every coin a stable colour from 1 to 10 and wraps around', () => {
	const ids = ['BTC', 'ETH', 'BNB'];
	assert.equal(lib.coinSlot(ids, 'BTC'), 1);
	assert.equal(lib.coinSlot(ids, 'BNB'), 3);
	assert.equal(lib.coinSlot(ids, 'XYZ'), 1);
	const many = Array.from({ length: 12 }, (_, i) => `C${i}`);
	assert.equal(lib.coinSlot(many, 'C9'), 10);
	assert.equal(lib.coinSlot(many, 'C10'), 1);
});

test('hashFor and parseHash keep the coin and the range in the link', () => {
	assert.equal(lib.hashFor('BTC', '30d'), '#BTC/30d');
	assert.deepEqual(lib.parseHash('#BTC/30d'), { coin: 'BTC', range: '30d' });
	assert.deepEqual(lib.parseHash('#ETH'), { coin: 'ETH', range: null });
	assert.deepEqual(lib.parseHash('#BTC/century'), {
		coin: 'BTC',
		range: null,
	});
	assert.deepEqual(lib.parseHash(''), { coin: null, range: null });
	assert.deepEqual(lib.parseHash('#%E0%A4%A/7d'), {
		coin: null,
		range: '7d',
	});
	assert.deepEqual(lib.parseHash('#/all'), { coin: null, range: 'all' });
	assert.deepEqual(lib.parseHash('#constructor/toString'), {
		coin: 'constructor',
		range: null,
	});
});

test('nextSort starts a column in its natural order, flips it, then goes back to the coin list order', () => {
	const start = { key: 'order', dir: 'asc' };
	const first = lib.nextSort(start, '24h');
	assert.deepEqual(first, { key: '24h', dir: 'desc' });
	const second = lib.nextSort(first, '24h');
	assert.deepEqual(second, { key: '24h', dir: 'asc' });
	assert.deepEqual(lib.nextSort(second, '24h'), start);
	assert.deepEqual(lib.nextSort(first, 'coin'), { key: 'coin', dir: 'asc' });
	const byCoin = lib.nextSort(start, 'coin');
	assert.deepEqual(lib.nextSort(byCoin, 'coin'), {
		key: 'coin',
		dir: 'desc',
	});
	assert.deepEqual(lib.nextSort(lib.nextSort(byCoin, 'coin'), 'coin'), start);
});

test('sortOverview orders by a column, keeps the input and puts missing values last', () => {
	const rows = [
		{ id: 'B', price: 2, '24h': -1, '7d': null },
		{ id: 'A', price: 3, '24h': 4, '7d': 1 },
		{ id: 'C', price: 1, '24h': null, '7d': 5 },
	];
	const ids = (sort: { key: string; dir: string }) =>
		lib.sortOverview(rows, sort).map((row: { id: string }) => row.id);
	assert.deepEqual(ids({ key: '24h', dir: 'desc' }), ['A', 'B', 'C']);
	assert.deepEqual(ids({ key: '24h', dir: 'asc' }), ['B', 'A', 'C']);
	assert.deepEqual(ids({ key: '7d', dir: 'desc' }), ['C', 'A', 'B']);
	assert.deepEqual(ids({ key: 'coin', dir: 'desc' }), ['C', 'B', 'A']);
	assert.deepEqual(ids({ key: 'order', dir: 'asc' }), ['B', 'A', 'C']);
	assert.deepEqual(
		rows.map((row) => row.id),
		['B', 'A', 'C']
	);
});

test('sparkPoints scales one series to its own range and keeps the last point', () => {
	const t = [0, 10, 20, 30, 40];
	const points = lib.sparkPoints(t, [5, 1, 3, 9, 5]);
	assert.deepEqual(points.x, [0, 0.25, 0.5, 0.75, 1]);
	assert.deepEqual(points.y, [0.5, 0, 0.25, 1, 0.5]);
	assert.equal(lib.sparkPoints([1], [1]), null);
	assert.equal(lib.sparkPoints([1, 2], [1]), null);
	assert.deepEqual(lib.sparkPoints([0, 1], [7, 7]).y, [0.5, 0.5]);
	const long = Array.from({ length: 1000 }, (_, i) => i);
	const thin = lib.sparkPoints(long, long, 50);
	assert.ok(thin.x.length <= 51);
	assert.equal(thin.x[thin.x.length - 1], 1);
	assert.equal(thin.y[thin.y.length - 1], 1);
});
