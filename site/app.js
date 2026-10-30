// git-coin dashboard (ADR 0008). Plain JavaScript, no build step.
// Chart library: uPlot 1.6.32 (MIT), vendored in vendor/. Dependabot cannot update it: update by hand.
import {
	BASES,
	COMPARE_STYLES,
	MAX_COMPARE_LINES,
	RANGES,
	alertSummary,
	breakGaps,
	coinDataUrl,
	dailyToPoints,
	formatAxisPrice,
	formatChange,
	formatPercentAxis,
	formatLastUpdated,
	formatPrice,
	formatUtcTime,
	historyNote,
	issueUrl,
	mergeSources,
	quoteName,
	rebase,
	setQuote,
	sliceRange,
	sourceInfo,
	staleBanner,
	staleLimits,
	staleState,
	summarizeChanges,
	summarizeSeries,
	summarizeSources,
	validSeries,
	validSources,
} from './lib.js';

const REFRESH_MS = 10 * 60 * 1000;
const TICK_MS = 30 * 1000;

const app = {
	status: null,
	latest: null,
	alerts: null,
	coin: null,
	range: '7d',
	chart: null,
	compare: null,
	// The coin comparison: the coins on the chart, the 0% base and the range are the reader's choice
	multi: {
		chart: null,
		token: 0,
		selected: null,
		base: 'start',
		range: '7d',
		focus: null,
		rows: [],
	},
	cache: new Map(),
	drawToken: 0,
	compareToken: 0,
};

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (key === 'text') {
			node.textContent = value;
		} else if (key === 'class') {
			node.className = value;
		} else {
			node.setAttribute(key, value);
		}
	}
	node.append(...children);
	return node;
}

function link(href, text) {
	return el('a', { href, rel: 'noopener' }, text);
}

async function fetchJson(url) {
	const res = await fetch(url, { cache: 'no-cache' });
	if (!res.ok) {
		throw new Error(`${url}: HTTP ${res.status}`);
	}
	return res.json();
}

// ----- freshness, banners and labels

function renderFreshness() {
	const now = Date.now();
	const iso = app.status?.last_point_at ?? null;
	$('updated').textContent = app.status
		? formatLastUpdated(iso, now)
		: 'Last updated: unknown';

	const limits = staleLimits(app.status);
	const banner = app.status
		? staleBanner(staleState(iso, now, limits), limits)
		: null;
	const box = $('banners');
	box.replaceChildren();
	if (banner) {
		box.append(
			el(
				'div',
				{ class: `banner banner-${banner.level}` },
				el('strong', { text: `${banner.title}. ` }),
				banner.text
			)
		);
	}
}

function renderSource() {
	const box = $('source');
	box.replaceChildren();
	if (!app.latest) {
		return;
	}
	const info = sourceInfo(app.latest.src);
	box.append('Source: ');
	box.append(info.url ? link(info.url, info.name) : info.name);
	box.append(`. Quote: ${app.latest.quote}.`);
	const history = historyNote(app.latest.history, Date.now());
	if (history) {
		box.append(` ${history}`);
	}
	if (info.credit) {
		box.append(
			` ${info.credit.text} `,
			link(info.credit.licenceUrl, info.credit.licence),
			'.'
		);
	}
}

function showProblem(message) {
	const box = $('problem');
	box.textContent = message ?? '';
	box.hidden = !message;
}

// ----- latest prices

function coinIds() {
	return app.latest ? Object.keys(app.latest.coins) : [];
}

function changeNode(pct) {
	const c = formatChange(pct);
	const word = { up: 'up', down: 'down', flat: 'unchanged', na: '' }[
		c.direction
	];
	return el(
		'span',
		{ class: `chg chg-${c.direction}` },
		el('span', { class: 'arrow', 'aria-hidden': 'true', text: c.arrow }),
		el('span', { class: 'sr', text: word ? `${word} ` : '' }),
		c.text
	);
}

// The buttons are kept between updates, so keyboard focus stays on the one that was used
function setPressed(box, key) {
	for (const button of box.children) {
		button.setAttribute('aria-pressed', String(button.dataset.key === key));
	}
}

function renderChips() {
	const box = $('coins');
	const ids = coinIds();
	if (box.dataset.ids !== ids.join(',')) {
		box.replaceChildren();
		for (const id of ids) {
			const chip = el('button', {
				type: 'button',
				class: 'chip',
				'data-key': id,
				text: id,
			});
			chip.addEventListener('click', () => selectCoin(id));
			box.append(chip);
		}
		box.dataset.ids = ids.join(',');
	}
	setPressed(box, app.coin);
}

function renderTable() {
	const body = $('latest').querySelector('tbody');
	body.replaceChildren();
	for (const [id, coin] of Object.entries(app.latest.coins)) {
		const pick = el('button', {
			type: 'button',
			class: 'link-button',
			'aria-label': `Show ${coin.name} (${id}) in the chart`,
			text: id,
		});
		pick.addEventListener('click', () => {
			selectCoin(id);
			$('detail').scrollIntoView({ block: 'start' });
		});
		body.append(
			el(
				'tr',
				{},
				el('th', { scope: 'row' }, pick),
				el('td', { class: 'num', text: formatPrice(coin.price) }),
				el(
					'td',
					{ class: 'num' },
					changeNode(coin.periods['24h'].change_pct)
				),
				el(
					'td',
					{ class: 'num' },
					changeNode(coin.periods['7d'].change_pct)
				),
				el(
					'td',
					{ class: 'num' },
					changeNode(coin.periods['30d'].change_pct)
				)
			)
		);
	}

	const missing = Object.entries(app.status?.coins ?? {})
		.filter(
			([id, s]) =>
				s.status === 'source_missing' && !(id in app.latest.coins)
		)
		.map(([id]) => id);
	$('missing').textContent =
		missing.length > 0
			? `No data from the source for: ${missing.join(', ')}.`
			: '';
	$('all').hidden = false;
}

function renderDetail() {
	const coin = app.latest.coins[app.coin];
	$('detail').hidden = false;
	$('detail-title').textContent = `${coin.name} (${app.coin})`;
	$('detail-price').textContent = formatPrice(coin.price);

	const now = Date.now();
	const limits = staleLimits(app.status);
	const state = staleState(coin.ts, now, limits);
	const late = state === 'fresh' ? '' : ' This price is old.';
	$('detail-asof').textContent =
		`Price of ${formatUtcTime(coin.ts, now)}, in ${quoteName()}.${late}`;

	const body = $('stats').querySelector('tbody');
	body.replaceChildren();
	for (const key of ['24h', '7d', '30d']) {
		const period = coin.periods[key];
		body.append(
			el(
				'tr',
				{},
				el('th', { scope: 'row', text: key }),
				el('td', {}, changeNode(period.change_pct)),
				el('td', { text: formatPrice(period.high) }),
				el('td', { text: formatPrice(period.low) })
			)
		);
	}
}

// ----- alerts

function renderAlerts() {
	const list = $('alerts');
	list.replaceChildren();
	const alerts = app.alerts?.alerts ?? [];
	$('alerts-empty').hidden = alerts.length > 0;
	$('alerts-empty').textContent = app.alerts
		? 'No alerts yet.'
		: 'The list of alerts could not be loaded.';
	const now = Date.now();
	for (const alert of alerts) {
		const url = issueUrl(alert.issue);
		const when = formatUtcTime(alert.ts, now);
		const text = `${alertSummary(alert)}, ${when}`;
		list.append(
			el(
				'li',
				{},
				text,
				url ? ' · ' : '',
				url ? link(url, `Issue #${alert.issue}`) : ''
			)
		);
	}
}

// ----- chart

function cssVar(name) {
	return getComputedStyle(document.documentElement)
		.getPropertyValue(name)
		.trim();
}

function chartHeight() {
	return Math.round(Math.min(420, Math.max(220, window.innerHeight * 0.38)));
}

function destroyChart() {
	if (app.chart) {
		app.chart.destroy();
		app.chart = null;
	}
}

// Points that get a marker: both ends of every run of points around a gap, and the last point
function markerIndices(values) {
	const last = values.length - 1;
	const out = [];
	for (let i = 0; i <= last; i++) {
		if (values[i] === null) {
			continue;
		}
		if (i === last || values[i - 1] === null || values[i + 1] === null) {
			out.push(i);
		}
	}
	return out;
}

// Time spans of the gaps: from the last point before a gap to the first point after it (see breakGaps)
function gapSpans(t, values) {
	const spans = [];
	for (let i = 1; i < values.length - 1; i++) {
		if (values[i] === null) {
			spans.push([t[i - 1], t[i + 1]]);
		}
	}
	return spans;
}

function hatchPattern(ctx, color, ratio) {
	const size = Math.round(8 * ratio);
	const tile = document.createElement('canvas');
	tile.width = size;
	tile.height = size;
	const tileCtx = tile.getContext('2d');
	tileCtx.strokeStyle = color;
	tileCtx.lineWidth = ratio;
	tileCtx.beginPath();
	tileCtx.moveTo(0, size);
	tileCtx.lineTo(size, 0);
	tileCtx.stroke();
	return ctx.createPattern(tile, 'repeat');
}

// A hatched band and a "No data" label over every gap, drawn under the grid and the line
function drawGaps(u, spans, colors) {
	const { ctx, bbox } = u;
	const ratio = window.devicePixelRatio || 1;
	const hatch = hatchPattern(ctx, colors.hatch, ratio);
	ctx.save();
	for (const [from, to] of spans) {
		const x0 = Math.max(u.valToPos(from, 'x', true), bbox.left);
		const x1 = Math.min(u.valToPos(to, 'x', true), bbox.left + bbox.width);
		const width = x1 - x0;
		if (width < 6 * ratio) {
			continue;
		}
		ctx.fillStyle = hatch;
		ctx.fillRect(x0, bbox.top, width, bbox.height);
		if (width < 64 * ratio) {
			continue;
		}
		ctx.font = `${12 * ratio}px ${colors.font}`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'top';
		const label = 'No data';
		const labelWidth = ctx.measureText(label).width + 8 * ratio;
		const middle = x0 + width / 2;
		const top = bbox.top + 6 * ratio;
		ctx.fillStyle = colors.bg;
		ctx.fillRect(middle - labelWidth / 2, top, labelWidth, 18 * ratio);
		ctx.fillStyle = colors.text;
		ctx.fillText(label, middle, top + 3 * ratio);
	}
	ctx.restore();
}

function drawChart(series) {
	destroyChart();
	const host = $('chart');
	const UPlot = window.uPlot;
	if (!UPlot) {
		$('chart-status').textContent = 'The chart library did not load.';
		return;
	}
	const data = breakGaps(series.t, series.p);
	const muted = cssVar('--muted');
	const grid = cssVar('--grid');
	const line = cssVar('--line');
	const bg = cssVar('--bg');
	const colors = {
		bg,
		text: cssVar('--text'),
		hatch: cssVar('--border'),
		font: cssVar('--font'),
	};
	const spans = gapSpans(data.t, data.p);
	const markers = markerIndices(data.p);
	const axis = {
		stroke: muted,
		grid: { stroke: grid, width: 1 },
		ticks: { stroke: grid, width: 1 },
	};
	app.chart = new UPlot(
		{
			width: Math.max(host.clientWidth, 200),
			height: chartHeight(),
			tzDate: (ts) => UPlot.tzDate(new Date(ts * 1000), 'Etc/UTC'),
			cursor: {
				y: false,
				drag: { x: false, y: false },
				points: { size: 9, width: 2, fill: bg, stroke: line },
			},
			hooks: { drawClear: [(u) => drawGaps(u, spans, colors)] },
			series: [
				{ value: '{YYYY}-{MM}-{DD} {HH}:{mm} UTC' },
				{
					label: 'Price',
					stroke: line,
					width: 2,
					spanGaps: false,
					points: {
						show: true,
						size: 9,
						fill: line,
						stroke: bg,
						width: 2,
						filter: () => markers,
					},
					value: (u, v) => (v === null ? '–' : formatPrice(v)),
				},
			],
			axes: [
				{ ...axis },
				{
					...axis,
					values: (u, ticks) => ticks.map(formatAxisPrice),
					// Room for the longest label, about 7 px per character plus the tick
					size: (u, labels) =>
						labels
							? Math.max(...labels.map((s) => s.length)) * 7 + 22
							: 60,
				},
			],
		},
		[data.t, data.p],
		host
	);
}

// ----- source comparison (shown only while the data holds more than one source)

function destroyCompare() {
	if (app.compare) {
		app.compare.destroy();
		app.compare = null;
	}
}

function hideCompare() {
	destroyCompare();
	$('compare').hidden = true;
}

function drawMarker(ctx, shape, x, y, r) {
	ctx.beginPath();
	if (shape === 'circle') {
		ctx.arc(x, y, r, 0, Math.PI * 2);
	} else if (shape === 'square') {
		ctx.rect(x - r, y - r, 2 * r, 2 * r);
	} else if (shape === 'triangle') {
		ctx.moveTo(x, y - r);
		ctx.lineTo(x + r, y + r);
		ctx.lineTo(x - r, y + r);
		ctx.closePath();
	} else {
		ctx.moveTo(x, y - r);
		ctx.lineTo(x + r, y);
		ctx.lineTo(x, y + r);
		ctx.lineTo(x - r, y);
		ctx.closePath();
	}
	ctx.fill();
}

// A marker at the end of every line and its name beside it, so no legend is needed to tell the lines apart
function drawEnds(u, ends, colors) {
	const { ctx, bbox } = u;
	const ratio = window.devicePixelRatio || 1;
	const spacing = 15 * ratio;
	const radius = 5 * ratio;
	const items = [];
	for (let i = 0; i < ends.length; i++) {
		if (!ends[i]) {
			continue;
		}
		const values = u.data[i + 1];
		let last = values.length - 1;
		while (last >= 0 && values[last] == null) {
			last--;
		}
		if (last >= 0) {
			const y = u.valToPos(values[last], 'y', true);
			items.push({
				...ends[i],
				x: u.valToPos(u.data[0][last], 'x', true),
				y,
				labelY: y,
			});
		}
	}
	// Keep the names apart: push each one down below the one above it, then pull the pile back into the plot
	items.sort((a, b) => a.y - b.y);
	for (let i = 1; i < items.length; i++) {
		items[i].labelY = Math.max(
			items[i].labelY,
			items[i - 1].labelY + spacing
		);
	}
	const bottom = bbox.top + bbox.height;
	for (let i = items.length - 1; i >= 0; i--) {
		const limit =
			i === items.length - 1 ? bottom : items[i + 1].labelY - spacing;
		items[i].labelY = Math.min(items[i].labelY, limit);
	}

	ctx.save();
	ctx.font = `${12 * ratio}px ${colors.font}`;
	ctx.textAlign = 'left';
	ctx.textBaseline = 'middle';
	ctx.lineWidth = 1.5 * ratio;
	for (const item of items) {
		const markerX = item.x + 3 * radius;
		ctx.strokeStyle = item.color;
		ctx.beginPath();
		ctx.moveTo(item.x, item.y);
		ctx.lineTo(markerX - radius, item.labelY);
		ctx.stroke();
		ctx.fillStyle = item.color;
		drawMarker(ctx, item.shape, markerX, item.labelY, radius);
		ctx.fillStyle = colors.text;
		ctx.fillText(item.name, markerX + 2 * radius, item.labelY);
	}
	ctx.restore();
}

function drawCompare(sources) {
	destroyCompare();
	const host = $('compare-chart');
	const UPlot = window.uPlot;
	if (!UPlot) {
		return;
	}
	const merged = mergeSources(sources);
	const styles = sources.map((s) => COMPARE_STYLES[s.src]);
	const colorOf = styles.map((s) => cssVar(`--series-${s.slot}`));
	const ends = sources.map((s, i) => ({
		name: sourceInfo(s.src).name,
		color: colorOf[i],
		shape: styles[i].marker,
	}));
	const muted = cssVar('--muted');
	const grid = cssVar('--grid');
	const bg = cssVar('--bg');
	const colors = {
		bg,
		text: cssVar('--text'),
		hatch: cssVar('--border'),
		font: cssVar('--font'),
	};
	const spans = gapSpans(merged.t, merged.columns[0]);
	const axis = {
		stroke: muted,
		grid: { stroke: grid, width: 1 },
		ticks: { stroke: grid, width: 1 },
	};
	app.compare = new UPlot(
		{
			width: Math.max(host.clientWidth, 200),
			height: chartHeight(),
			// Room on the right for the names of the lines
			padding: [8, 104, 0, 0],
			tzDate: (ts) => UPlot.tzDate(new Date(ts * 1000), 'Etc/UTC'),
			cursor: {
				y: false,
				drag: { x: false, y: false },
				points: {
					size: 9,
					width: 2,
					fill: bg,
					stroke: (u, seriesIdx) => colorOf[seriesIdx - 1],
				},
			},
			hooks: {
				drawClear: [(u) => drawGaps(u, spans, colors)],
				draw: [(u) => drawEnds(u, ends, colors)],
			},
			series: [
				{ value: '{YYYY}-{MM}-{DD} {HH}:{mm} UTC' },
				...sources.map((s, i) => ({
					label: ends[i].name,
					stroke: colorOf[i],
					width: 2,
					dash: styles[i].dash,
					spanGaps: false,
					points: { show: false },
					value: (u, v) => (v == null ? '–' : formatPrice(v)),
				})),
			],
			axes: [
				{ ...axis },
				{
					...axis,
					values: (u, ticks) => ticks.map(formatAxisPrice),
					size: (u, labels) =>
						labels
							? Math.max(...labels.map((s) => s.length)) * 7 + 22
							: 60,
				},
			],
		},
		[merged.t, ...merged.columns],
		host
	);
}

async function getSources(id) {
	const key = `${id}.sources`;
	if (!app.cache.has(key)) {
		const json = await fetchJson(coinDataUrl(id, 'sources'));
		if (!validSources(json)) {
			throw new Error(`${key}: unexpected data`);
		}
		app.cache.set(key, json.sources);
	}
	return app.cache.get(key);
}

function renderCompareNote(sources) {
	const box = $('compare-note');
	box.replaceChildren(
		`Sources: ${sources.map((s) => sourceInfo(s.src).name).join(', ')}. Times in UTC.`
	);
	const credit = sources
		.map((s) => sourceInfo(s.src).credit)
		.find((item) => item);
	if (credit) {
		box.append(
			` ${credit.text} `,
			link(credit.licenceUrl, credit.licence),
			'.'
		);
	}
}

// The comparison needs a sources file with at least two sources. When it is missing, the section stays hidden.
async function loadCompare() {
	const token = ++app.compareToken;
	const { coin } = app;
	try {
		const sources = await getSources(coin);
		if (token !== app.compareToken) {
			return;
		}
		if (sources.length < 2) {
			hideCompare();
			return;
		}
		$('compare').hidden = false;
		$('compare-chart').setAttribute(
			'aria-label',
			summarizeSources(coin, sources)
		);
		renderCompareNote(sources);
		drawCompare(sources);
	} catch {
		if (token === app.compareToken) {
			hideCompare();
		}
	}
}

// ----- coin comparison in percent (many coins on one chart)

function destroyMulti() {
	if (app.multi.chart) {
		app.multi.chart.destroy();
		app.multi.chart = null;
	}
	app.multi.focus = null;
}

function hideMulti() {
	destroyMulti();
	$('multi').hidden = true;
}

function shownRows() {
	return app.multi.rows.filter((row) => app.multi.selected.has(row.id));
}

// Highlights the line of one coin (or none), from the table or from the chart
function focusLine(id) {
	const chart = app.multi.chart;
	if (!chart) {
		return;
	}
	const index = shownRows().findIndex((row) => row.id === id);
	chart.setSeries(index < 0 ? null : index + 1, { focus: true });
}

function updateReadout(u) {
	const out = $('multi-readout');
	const focus = app.multi.focus;
	const row = focus ? shownRows()[focus - 1] : null;
	if (!row) {
		out.textContent = 'Point at a line or at a row of the table to see it.';
		return;
	}
	const index = u.cursor.idx;
	if (index == null) {
		out.textContent = `${row.id}: ${formatChange(row.start).text} at the start, ${formatChange(row.end).text} at the latest point.`;
		return;
	}
	const value = u.data[focus][index];
	const time = new Date(u.data[0][index] * 1000)
		.toISOString()
		.slice(0, 16)
		.replace('T', ' ');
	out.textContent = `${row.id}: ${value == null ? '–' : formatChange(value).text} at ${time} UTC`;
}

// The 0% line with its name, a ring on the point each coin takes as its base, and the highlighted line on top
function drawMultiOverlay(u, rows, colors) {
	const { ctx, bbox } = u;
	const ratio = window.devicePixelRatio || 1;
	const zero = u.valToPos(0, 'y', true);
	ctx.save();
	ctx.beginPath();
	ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
	ctx.clip();
	if (zero >= bbox.top && zero <= bbox.top + bbox.height) {
		ctx.strokeStyle = colors.text;
		ctx.lineWidth = ratio;
		ctx.setLineDash([4 * ratio, 4 * ratio]);
		ctx.beginPath();
		ctx.moveTo(bbox.left, zero);
		ctx.lineTo(bbox.left + bbox.width, zero);
		ctx.stroke();
		ctx.setLineDash([]);
		ctx.font = `${12 * ratio}px ${colors.font}`;
		ctx.fillStyle = colors.text;
		ctx.textAlign = 'left';
		ctx.textBaseline = 'top';
		ctx.fillText(
			`Dashed line: 0% = ${BASES[app.multi.base].label.toLowerCase()}`,
			bbox.left + 6 * ratio,
			bbox.top + 4 * ratio
		);
		ctx.fillStyle = colors.bg;
		ctx.lineWidth = 1.5 * ratio;
		for (const row of rows) {
			ctx.beginPath();
			ctx.arc(
				u.valToPos(row.baseTime, 'x', true),
				zero,
				3.5 * ratio,
				0,
				Math.PI * 2
			);
			ctx.fill();
			ctx.stroke();
		}
	}
	const focus = app.multi.focus;
	if (focus) {
		const values = u.data[focus];
		ctx.strokeStyle = colors.accent;
		ctx.lineWidth = 2.5 * ratio;
		ctx.lineJoin = 'round';
		ctx.beginPath();
		let drawing = false;
		for (let i = 0; i < values.length; i++) {
			if (values[i] == null) {
				drawing = false;
				continue;
			}
			const x = u.valToPos(u.data[0][i], 'x', true);
			const y = u.valToPos(values[i], 'y', true);
			if (drawing) {
				ctx.lineTo(x, y);
			} else {
				ctx.moveTo(x, y);
			}
			drawing = true;
		}
		ctx.stroke();
	}
	ctx.restore();
}

// Names at the end of the lines: every coin when there are few, else the two highest, the two lowest and the focused one
function drawMultiEnds(u, rows, colors) {
	const order = rows
		.map((row, i) => i)
		.sort((a, b) => rows[b].end - rows[a].end);
	const named = new Set(
		rows.length <= 6 ? order : [...order.slice(0, 2), ...order.slice(-2)]
	);
	const focus = app.multi.focus;
	if (focus) {
		named.add(focus - 1);
	}
	const ends = rows.map((row, i) =>
		named.has(i)
			? {
					name: `${row.id} ${formatChange(row.end).text}`,
					color: i === focus - 1 ? colors.accent : colors.text,
					shape: 'circle',
				}
			: null
	);
	drawEnds(u, ends, colors);
}

function drawMulti() {
	destroyMulti();
	const host = $('multi-chart');
	const note = $('multi-note');
	const rows = shownRows();
	const { range, base } = app.multi;
	host.setAttribute(
		'aria-label',
		summarizeChanges(
			range,
			base,
			rows.map((row) => ({ id: row.id, pct: row.end }))
		)
	);
	if (rows.length === 0) {
		note.textContent =
			app.multi.rows.length === 0
				? 'No data in this range.'
				: 'No coins are selected. Tick coins in the table.';
		return;
	}
	const UPlot = window.uPlot;
	if (!UPlot) {
		note.textContent = 'The chart library did not load.';
		return;
	}
	const source = app.latest ? sourceInfo(app.latest.src).name : '';
	note.textContent =
		`Change against the ${BASES[base].label.toLowerCase()}. ` +
		`${source ? `Source: ${source}. ` : ''}Times in UTC.`;

	const merged = mergeSources(rows.map((row) => ({ t: row.t, p: row.pct })));
	const bg = cssVar('--bg');
	const muted = cssVar('--muted');
	const grid = cssVar('--grid');
	const colors = {
		bg,
		text: cssVar('--text'),
		hatch: cssVar('--border'),
		font: cssVar('--font'),
		accent: cssVar('--accent'),
	};
	const spans = gapSpans(merged.t, merged.columns[0]);
	const axis = {
		stroke: muted,
		grid: { stroke: grid, width: 1 },
		ticks: { stroke: grid, width: 1 },
	};
	app.multi.chart = new UPlot(
		{
			width: Math.max(host.clientWidth, 200),
			height: chartHeight(),
			// Room on the right for the names at the ends of the lines
			padding: [8, 112, 0, 0],
			tzDate: (ts) => UPlot.tzDate(new Date(ts * 1000), 'Etc/UTC'),
			legend: { show: false },
			focus: { alpha: 0.3 },
			cursor: {
				y: false,
				drag: { x: false, y: false },
				points: { show: false },
				focus: { prox: 24 },
			},
			hooks: {
				drawClear: [(u) => drawGaps(u, spans, colors)],
				setSeries: [
					(u, index, opts) => {
						if (opts && opts.focus) {
							app.multi.focus = index;
							updateReadout(u);
							u.redraw(false);
						}
					},
				],
				setCursor: [(u) => updateReadout(u)],
				draw: [
					(u) => {
						drawMultiOverlay(u, rows, colors);
						drawMultiEnds(u, rows, colors);
					},
				],
			},
			series: [
				{ value: '{YYYY}-{MM}-{DD} {HH}:{mm} UTC' },
				...rows.map((row) => ({
					label: row.id,
					stroke: muted,
					width: 1.5,
					spanGaps: false,
					points: { show: false },
					value: (u, v) => (v == null ? '–' : formatChange(v).text),
				})),
			],
			axes: [
				{ ...axis },
				{
					...axis,
					values: (u, ticks) => ticks.map(formatPercentAxis),
					size: (u, labels) =>
						labels
							? Math.max(...labels.map((s) => s.length)) * 7 + 22
							: 60,
				},
			],
		},
		[merged.t, ...merged.columns],
		host
	);
	updateReadout(app.multi.chart);
}

function renderMultiTable() {
	const body = $('multi-table').querySelector('tbody');
	body.replaceChildren();
	const rows = [...app.multi.rows].sort(
		(a, b) => b.end - a.end || a.id.localeCompare(b.id)
	);
	for (const row of rows) {
		const box = el('input', {
			type: 'checkbox',
			'aria-label': `Show ${row.id} in the chart`,
		});
		box.checked = app.multi.selected.has(row.id);
		box.addEventListener('change', () => {
			if (box.checked && app.multi.selected.size >= MAX_COMPARE_LINES) {
				box.checked = false;
				$('multi-note').textContent =
					`At most ${MAX_COMPARE_LINES} lines fit on the chart.`;
				return;
			}
			if (box.checked) {
				app.multi.selected.add(row.id);
			} else {
				app.multi.selected.delete(row.id);
			}
			drawMulti();
		});
		const tr = el(
			'tr',
			{},
			el('td', {}, el('label', { class: 'check' }, box)),
			el('th', { scope: 'row', text: row.id }),
			el('td', { class: 'num' }, changeNode(row.start)),
			el('td', { class: 'num' }, changeNode(row.end))
		);
		tr.addEventListener('mouseenter', () => focusLine(row.id));
		tr.addEventListener('mouseleave', () => focusLine(null));
		box.addEventListener('focus', () => focusLine(row.id));
		box.addEventListener('blur', () => focusLine(null));
		body.append(tr);
	}
}

async function loadMulti() {
	const token = ++app.multi.token;
	const ids = coinIds();
	if (ids.length < 2) {
		hideMulti();
		return;
	}
	$('multi').hidden = false;
	if (app.multi.selected === null) {
		app.multi.selected = new Set(ids.slice(0, MAX_COMPARE_LINES));
	}
	const { range, base } = app.multi;
	$('multi-note').textContent = 'Loading the comparison…';
	const loaded = await Promise.allSettled(
		ids.map((id) => getSeries(id, RANGES[range].file))
	);
	if (token !== app.multi.token) {
		return;
	}
	const rows = [];
	loaded.forEach((result, i) => {
		if (result.status !== 'fulfilled') {
			return;
		}
		const series = sliceRange(result.value, RANGES[range].seconds);
		if (series.t.length < 2) {
			return;
		}
		const { pct, baseIndex } = rebase(series.p, base);
		rows.push({
			id: ids[i],
			t: series.t,
			pct,
			baseTime: series.t[baseIndex],
			start: pct[0],
			end: pct[pct.length - 1],
		});
	});
	app.multi.rows = rows;
	renderMultiTable();
	drawMulti();
}

function renderMultiButtons() {
	const rangeBox = $('multi-ranges');
	for (const [key, range] of Object.entries(RANGES)) {
		const button = el('button', {
			type: 'button',
			class: 'chip',
			'data-key': key,
			text: range.label,
		});
		button.addEventListener('click', () => {
			app.multi.range = key;
			setPressed(rangeBox, key);
			loadMulti();
		});
		rangeBox.append(button);
	}
	setPressed(rangeBox, app.multi.range);

	const baseBox = $('multi-base');
	for (const [key, base] of Object.entries(BASES)) {
		const button = el('button', {
			type: 'button',
			class: 'chip',
			'data-key': key,
			text: base.label,
		});
		button.addEventListener('click', () => {
			app.multi.base = key;
			setPressed(baseBox, key);
			loadMulti();
		});
		baseBox.append(button);
	}
	setPressed(baseBox, app.multi.base);

	$('multi-all').addEventListener('click', () => {
		app.multi.selected = new Set(
			app.multi.rows.slice(0, MAX_COMPARE_LINES).map((row) => row.id)
		);
		renderMultiTable();
		drawMulti();
	});
	$('multi-none').addEventListener('click', () => {
		app.multi.selected = new Set();
		renderMultiTable();
		drawMulti();
	});
}

async function getSeries(id, file) {
	const key = `${id}.${file}`;
	if (!app.cache.has(key)) {
		const json = await fetchJson(coinDataUrl(id, file));
		const keys = file === 'daily' ? ['t', 'c'] : ['t', 'p'];
		if (!validSeries(json, keys)) {
			throw new Error(`${key}: unexpected data`);
		}
		app.cache.set(key, file === 'daily' ? dailyToPoints(json) : json);
	}
	return app.cache.get(key);
}

// The chart box shows a skeleton while loading and a dashed frame when there is nothing to draw
function setChartState(state) {
	const host = $('chart');
	host.classList.remove('is-loading', 'is-empty', 'is-error');
	if (state) {
		host.classList.add(`is-${state}`);
	}
}

function setChartCaption(visible) {
	const source = app.latest ? sourceInfo(app.latest.src).name : '';
	$('chart-caption').textContent =
		visible && source ? `Source: ${source}. Times in UTC.` : '';
}

async function loadChart() {
	const token = ++app.drawToken;
	const { coin, range } = app;
	const status = $('chart-status');
	status.textContent = 'Loading the chart…';
	setChartState(app.chart ? null : 'loading');
	try {
		const full = await getSeries(coin, RANGES[range].file);
		if (token !== app.drawToken) {
			return;
		}
		const series = sliceRange(full, RANGES[range].seconds);
		$('chart').setAttribute(
			'aria-label',
			summarizeSeries(coin, range, series)
		);
		if (series.t.length === 0) {
			destroyChart();
			setChartState('empty');
			setChartCaption(false);
			status.textContent = 'No data in this range.';
			return;
		}
		status.textContent = '';
		setChartState(null);
		setChartCaption(true);
		drawChart(series);
	} catch (err) {
		if (token !== app.drawToken) {
			return;
		}
		console.error(err);
		destroyChart();
		setChartState('error');
		setChartCaption(false);
		$('chart').setAttribute(
			'aria-label',
			`Price chart of ${coin}: not available.`
		);
		status.textContent = 'The chart data could not be loaded.';
	}
}

function renderRanges() {
	const box = $('ranges');
	for (const [key, range] of Object.entries(RANGES)) {
		const button = el('button', {
			type: 'button',
			class: 'chip',
			'data-key': key,
			text: range.label,
		});
		button.addEventListener('click', () => {
			app.range = key;
			setPressed(box, key);
			loadChart();
		});
		box.append(button);
	}
	setPressed(box, app.range);
}

function selectCoin(id) {
	app.coin = id;
	history.replaceState(null, '', `#${encodeURIComponent(id)}`);
	renderChips();
	renderDetail();
	loadChart();
	loadCompare();
}

// ----- loading

function hashCoin() {
	try {
		return decodeURIComponent(location.hash.slice(1));
	} catch {
		return '';
	}
}

async function loadAll() {
	const [status, latest, alerts] = await Promise.allSettled([
		fetchJson('data/status.json'),
		fetchJson('data/latest.json'),
		fetchJson('data/alerts.json'),
	]);
	app.status = status.status === 'fulfilled' ? status.value : app.status;
	app.alerts = alerts.status === 'fulfilled' ? alerts.value : app.alerts;
	if (latest.status === 'fulfilled') {
		if (
			app.latest &&
			app.latest.generated_at !== latest.value.generated_at
		) {
			app.cache.clear();
		}
		app.latest = latest.value;
		setQuote(app.latest.quote);
		$('footer-quote').textContent = quoteName();
	}

	renderFreshness();
	renderAlerts();
	if (!app.latest) {
		showProblem('The latest prices could not be loaded. Try again later.');
		return;
	}
	showProblem(
		latest.status === 'rejected'
			? 'The newest data could not be loaded. The numbers below may be old.'
			: ''
	);
	renderSource();
	const ids = coinIds();
	const wanted = hashCoin();
	const first = ids.includes(app.coin) ? app.coin : wanted;
	app.coin = ids.includes(first) ? first : (ids[0] ?? null);
	if (app.coin === null) {
		showProblem('The data has no coins.');
		return;
	}
	renderChips();
	renderTable();
	renderDetail();
	loadChart();
	loadCompare();
	loadMulti();
}

function start() {
	renderRanges();
	renderMultiButtons();
	loadAll();
	setInterval(renderFreshness, TICK_MS);
	setInterval(loadAll, REFRESH_MS);

	const redraw = () => {
		if (app.coin !== null) {
			loadChart();
			loadCompare();
			drawMulti();
		}
	};
	window
		.matchMedia('(prefers-color-scheme: dark)')
		.addEventListener('change', redraw);
	new ResizeObserver(() => {
		const host = $('chart');
		if (app.chart && host.clientWidth > 0) {
			app.chart.setSize({
				width: host.clientWidth,
				height: chartHeight(),
			});
		}
	}).observe($('chart'));
	new ResizeObserver(() => {
		const host = $('compare-chart');
		if (app.compare && host.clientWidth > 0) {
			app.compare.setSize({
				width: host.clientWidth,
				height: chartHeight(),
			});
		}
	}).observe($('compare-chart'));
	new ResizeObserver(() => {
		const host = $('multi-chart');
		if (app.multi.chart && host.clientWidth > 0) {
			app.multi.chart.setSize({
				width: host.clientWidth,
				height: chartHeight(),
			});
		}
	}).observe($('multi-chart'));
}

start();
