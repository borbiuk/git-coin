// git-coin dashboard (ADR 0008). Plain JavaScript, no build step.
// Chart library: uPlot 1.6.32 (MIT), vendored in vendor/. Dependabot cannot update it: update by hand.
import {
	BASES,
	COIN_COLOURS,
	MAX_COMPARE_LINES,
	RANGES,
	alertSummary,
	coinDataUrl,
	coinSlot,
	dailyToPoints,
	formatChange,
	formatPercentAxis,
	formatLastUpdated,
	formatPriceBare,
	formatUtcTime,
	issueUrl,
	mergeSources,
	nextSort,
	quoteName,
	rebase,
	setQuote,
	sliceRange,
	sortOverview,
	sourceInfo,
	sparkPoints,
	staleBanner,
	staleLimits,
	staleState,
	summarizeChanges,
	validSeries,
} from './lib.js';

const REFRESH_MS = 10 * 60 * 1000;
const TICK_MS = 30 * 1000;

const app = {
	status: null,
	latest: null,
	alerts: null,
	// The order of the table of all coins: the coin list order until a heading is pressed
	sort: { key: 'order', dir: 'asc' },
	// The coin comparison: the coins on the chart, the 0% base and the range are the reader's choice
	multi: {
		chart: null,
		token: 0,
		selected: null,
		base: 'start',
		range: '7d',
		focus: null,
		rows: [],
		compact: false,
		// The list of coins in the full page view is open until the reader closes it
		pickerOpen: true,
	},
	cache: new Map(),
	// The 7 day series of every coin, for the lines of the overview table. Null until they are loaded.
	sparks: null,
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

function showProblem(message) {
	const box = $('problem');
	box.textContent = message ?? '';
	box.hidden = !message;
}

// ----- latest prices

function coinIds() {
	return app.latest ? Object.keys(app.latest.coins) : [];
}

// Bitcoin has its own look (a heavier line, a marked row), so it stands out among the other coins
const ACCENT_COIN = 'BTC';

// The ten colours go to the other coins in list order, so a coin keeps its colour. The accent coin has its own.
function coinClass(id) {
	if (id === ACCENT_COIN) {
		return 'coin-accent';
	}
	const others = coinIds().filter((other) => other !== ACCENT_COIN);
	return `coin-${coinSlot(others, id)}`;
}

// The colour of a coin: the same in the lines, the names at their ends, the table and the overview
function coinColour(id) {
	return cssVar(`--${coinClass(id)}`);
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

// The columns of the table of all coins that can be sorted. The line of the last 7 days is the last cell.
const OVERVIEW_COLUMNS = [
	{ key: 'coin', label: 'Coin', num: false },
	{ key: 'price', label: 'Price', num: true },
	{ key: '24h', label: '24h', num: true },
	{ key: '7d', label: '7d', num: true },
	{ key: '30d', label: '30d', num: true },
];

// The headings are sort buttons. They are built once, so keyboard focus stays on the one that was used.
function renderOverviewHead() {
	const head = $('latest').querySelector('thead tr');
	if (head.children.length === 0) {
		for (const column of OVERVIEW_COLUMNS) {
			const button = el(
				'button',
				{ type: 'button', class: 'sort', 'data-key': column.key },
				column.label,
				el('span', { class: 'sort-mark', 'aria-hidden': 'true' })
			);
			button.addEventListener('click', () => {
				app.sort = nextSort(app.sort, column.key);
				renderTable();
			});
			head.append(
				el(
					'th',
					{ scope: 'col', class: column.num ? 'num' : '' },
					button
				)
			);
		}
		head.append(
			el('th', { scope: 'col', class: 'col-spark', text: 'Trend' })
		);
	}
	for (const th of head.children) {
		const button = th.querySelector('.sort');
		if (!button) {
			continue;
		}
		const active = button.dataset.key === app.sort.key;
		const dir = app.sort.dir === 'asc' ? 'ascending' : 'descending';
		th.setAttribute('aria-sort', active ? dir : 'none');
		button.querySelector('.sort-mark').textContent = active
			? app.sort.dir === 'asc'
				? '▲'
				: '▼'
			: '';
	}
}

function overviewRows() {
	return Object.entries(app.latest.coins).map(([id, coin]) => ({
		id,
		name: coin.name,
		price: coin.price,
		'24h': coin.periods['24h'].change_pct,
		'7d': coin.periods['7d'].change_pct,
		'30d': coin.periods['30d'].change_pct,
	}));
}

// A line of the last 7 days in the colour of the coin, scaled to the prices of that coin alone
function paintSparks() {
	const ratio = window.devicePixelRatio || 1;
	for (const canvas of $('latest').querySelectorAll('canvas.spark')) {
		const series = app.sparks?.get(canvas.dataset.id);
		const points = series ? sparkPoints(series.t, series.p) : null;
		const width = canvas.clientWidth || 88;
		const height = canvas.clientHeight || 28;
		canvas.width = Math.round(width * ratio);
		canvas.height = Math.round(height * ratio);
		if (!points) {
			continue;
		}
		const ctx = canvas.getContext('2d');
		ctx.scale(ratio, ratio);
		const pad = 3;
		const at = (i) => [
			pad + points.x[i] * (width - 2 * pad),
			height - pad - points.y[i] * (height - 2 * pad),
		];
		ctx.strokeStyle = coinColour(canvas.dataset.id);
		ctx.fillStyle = ctx.strokeStyle;
		ctx.lineWidth = 1.5;
		ctx.lineJoin = 'round';
		ctx.beginPath();
		points.x.forEach((x, i) => {
			const [px, py] = at(i);
			if (i === 0) {
				ctx.moveTo(px, py);
			} else {
				ctx.lineTo(px, py);
			}
		});
		ctx.stroke();
		const [lastX, lastY] = at(points.x.length - 1);
		ctx.beginPath();
		ctx.arc(lastX, lastY, 2.5, 0, Math.PI * 2);
		ctx.fill();
	}
}

async function loadSparks() {
	const ids = coinIds();
	const loaded = await Promise.allSettled(
		ids.map((id) => getSeries(id, '7d'))
	);
	app.sparks = new Map(
		ids.map((id, i) => [
			id,
			loaded[i].status === 'fulfilled' ? loaded[i].value : null,
		])
	);
	paintSparks();
}

function renderTable() {
	renderOverviewHead();
	const body = $('latest').querySelector('tbody');
	body.replaceChildren();
	$('latest-unit').textContent = quoteName();
	for (const row of sortOverview(overviewRows(), app.sort)) {
		const box = el('input', {
			type: 'checkbox',
			class: 'show-coin',
			'data-id': row.id,
			'aria-label': `Show ${row.name} (${row.id}) in the chart`,
		});
		box.checked = app.multi.selected.has(row.id);
		box.addEventListener('change', () => setCoinShown(row.id, box.checked));
		const pick = el(
			'label',
			{ class: 'pick' },
			box,
			el('span', { class: 'swatch', 'aria-hidden': 'true' }),
			row.id
		);
		const tr = el(
			'tr',
			{ class: coinClass(row.id), 'data-id': row.id },
			el('th', { scope: 'row', class: 'col-coin' }, pick),
			el('td', {
				class: 'num col-price',
				text: formatPriceBare(row.price),
			}),
			...['24h', '7d', '30d'].map((key) =>
				el(
					'td',
					{ class: `num col-${key}`, 'data-label': key },
					changeNode(row[key])
				)
			),
			el(
				'td',
				{ class: 'col-spark' },
				el('canvas', {
					class: 'spark',
					'data-id': row.id,
					'aria-hidden': 'true',
				})
			)
		);
		tr.addEventListener('mouseenter', () => focusLine(row.id));
		tr.addEventListener('mouseleave', () => focusLine(null));
		box.addEventListener('focus', () => focusLine(row.id));
		box.addEventListener('blur', () => focusLine(null));
		body.append(tr);
	}
	if (app.sparks) {
		paintSparks();
	} else {
		loadSparks();
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

// The height of a chart: a share of the screen, or all that the box has left when its panel fills the page
function chartHeight(host) {
	if (host.closest('.panel.is-expanded')) {
		const legend = host.querySelector('.u-legend');
		return Math.max(
			160,
			host.clientHeight - (legend ? legend.offsetHeight : 0)
		);
	}
	return Math.round(Math.min(420, Math.max(220, window.innerHeight * 0.38)));
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

// Time labels of the x axis, 24-hour clock and UTC. A new day or year is written under the first tick of it.
// Each row: tick step in seconds, default, year, month, day, hour, minute, second, mode (uPlot axis format).
const TIME_AXIS = [
	[31536000, '{YYYY}', null, null, null, null, null, null, 1],
	[2419200, '{MMM}', '\n{YYYY}', null, null, null, null, null, 1],
	[86400, '{D} {MMM}', '\n{YYYY}', null, null, null, null, null, 1],
	[
		3600,
		'{HH}:{mm}',
		'\n{D} {MMM} {YYYY}',
		null,
		'\n{D} {MMM}',
		null,
		null,
		null,
		1,
	],
	[
		60,
		'{HH}:{mm}',
		'\n{D} {MMM} {YYYY}',
		null,
		'\n{D} {MMM}',
		null,
		null,
		null,
		1,
	],
	[
		1,
		':{ss}',
		'\n{D} {MMM} {YYYY} {HH}:{mm}',
		null,
		'\n{D} {MMM} {HH}:{mm}',
		null,
		'\n{HH}:{mm}',
		null,
		1,
	],
];

// uPlot follows the mouse only. A finger dragged along the chart moves the crosshair the same way, and
// `touch-action: pan-y` (style.css) leaves the drag up or down to the page.
function followTouch(u) {
	const over = u.over;
	const move = (event) => {
		if (event.pointerType !== 'touch') {
			return;
		}
		const box = over.getBoundingClientRect();
		u.setCursor({
			left: event.clientX - box.left,
			top: event.clientY - box.top,
		});
	};
	over.addEventListener('pointerdown', move);
	over.addEventListener('pointermove', move);
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
	ctx.textAlign = 'left';
	ctx.textBaseline = 'middle';
	for (const item of items) {
		const markerX = item.x + 3 * radius;
		ctx.font = `${item.bold ? '700 ' : ''}${12 * ratio}px ${colors.font}`;
		ctx.lineWidth = (item.bold ? 2.5 : 1.5) * ratio;
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

// ----- coin comparison in percent (many coins on one chart)

function destroyMulti() {
	if (app.multi.chart) {
		app.multi.chart.destroy();
		app.multi.chart = null;
	}
	app.multi.focus = null;
}

function hideMulti() {
	closePanelOf('multi-panel');
	destroyMulti();
	$('multi').hidden = true;
}

// The rows on the chart. The accent coin is the last one, so its line is drawn on top of the others.
function shownRows() {
	const rows = app.multi.rows.filter((row) => app.multi.selected.has(row.id));
	return [
		...rows.filter((row) => row.id !== ACCENT_COIN),
		...rows.filter((row) => row.id === ACCENT_COIN),
	];
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
		ctx.strokeStyle = coinColour(rows[focus - 1].id);
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

// Names at the end of the lines, in the colour of each coin. On a narrow screen the name is the coin only.
function drawMultiEnds(u, rows, colors, compact) {
	const ends = rows.map((row) => ({
		name: compact ? row.id : `${row.id} ${formatChange(row.end).text}`,
		color: coinColour(row.id),
		shape: 'circle',
		bold: row.id === ACCENT_COIN,
	}));
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
				: 'No coins are selected. Tick coins in the table below.';
		return;
	}
	const UPlot = window.uPlot;
	if (!UPlot) {
		note.textContent = 'The chart library did not load.';
		return;
	}
	const info = app.latest ? sourceInfo(app.latest.src) : null;
	note.replaceChildren(
		`Change against the ${BASES[base].label.toLowerCase()}. ` +
			`${info ? `Source: ${info.name}. ` : ''}Times in UTC.`
	);
	if (info?.credit) {
		note.append(
			` ${info.credit.text} `,
			link(info.credit.licenceUrl, info.credit.licence),
			'.'
		);
	}

	const merged = mergeSources(rows.map((row) => ({ t: row.t, p: row.pct })));
	const bg = cssVar('--bg');
	const muted = cssVar('--muted');
	const grid = cssVar('--grid');
	const colors = {
		bg,
		text: cssVar('--text'),
		hatch: cssVar('--border'),
		font: cssVar('--font'),
	};
	const spans = gapSpans(merged.t, merged.columns[0]);
	// A phone has no room for the percent beside every name: the table below has them
	const compact = host.clientWidth < 480;
	app.multi.compact = compact;
	const axis = {
		stroke: muted,
		grid: { stroke: grid, width: 1 },
		ticks: { stroke: grid, width: 1 },
	};
	app.multi.chart = new UPlot(
		{
			width: Math.max(host.clientWidth, 200),
			height: chartHeight(host),
			// Room on the right for the names at the ends of the lines
			padding: [8, compact ? 64 : 112, 0, 0],
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
				ready: [followTouch],
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
						drawMultiEnds(u, rows, colors, compact);
					},
				],
			},
			series: [
				{ value: '{YYYY}-{MM}-{DD} {HH}:{mm} UTC' },
				...rows.map((row) => ({
					label: row.id,
					stroke: coinColour(row.id),
					width: row.id === ACCENT_COIN ? 3 : 1.5,
					spanGaps: false,
					points: { show: false },
					value: (u, v) => (v == null ? '–' : formatChange(v).text),
				})),
			],
			axes: [
				{ ...axis, values: TIME_AXIS },
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

async function loadMulti() {
	const token = ++app.multi.token;
	const ids = coinIds();
	if (ids.length < 2) {
		hideMulti();
		return;
	}
	$('multi').hidden = false;
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

	for (const button of document.querySelectorAll('.multi-all')) {
		button.addEventListener('click', () => setAllShown(true));
	}
	for (const button of document.querySelectorAll('.multi-none')) {
		button.addEventListener('click', () => setAllShown(false));
	}
	$('multi-picker-toggle').addEventListener('click', () => {
		app.multi.pickerOpen = !app.multi.pickerOpen;
		renderPickerState();
	});
}

// ----- the choice of coins: ticks in the table and, in the full page view, buttons in the chart panel

// Brings every control in line with the choice: the ticks of the table, the buttons of the list and the count
function syncChoice() {
	const { selected } = app.multi;
	for (const box of document.querySelectorAll('input.show-coin')) {
		box.checked = selected.has(box.dataset.id);
	}
	for (const button of $('multi-coins').children) {
		button.setAttribute(
			'aria-pressed',
			String(selected.has(button.dataset.key))
		);
	}
	$('multi-picker-toggle').textContent =
		`Coins: ${selected.size} of ${coinIds().length}`;
}

function setCoinShown(id, on) {
	const { selected } = app.multi;
	if (on && selected.size >= MAX_COMPARE_LINES) {
		$('multi-note').textContent =
			`At most ${MAX_COMPARE_LINES} lines fit on the chart.`;
		syncChoice();
		return;
	}
	if (on) {
		selected.add(id);
	} else {
		selected.delete(id);
	}
	syncChoice();
	drawMulti();
}

function setAllShown(on) {
	app.multi.selected = new Set(
		on ? coinIds().slice(0, MAX_COMPARE_LINES) : []
	);
	syncChoice();
	drawMulti();
}

// One button for every coin. The list is built again only when the coins change.
function renderPicker() {
	const box = $('multi-coins');
	const ids = coinIds();
	if (box.dataset.ids !== ids.join(',')) {
		box.replaceChildren();
		for (const id of ids) {
			const chip = el('button', {
				type: 'button',
				class: `chip coin-chip ${coinClass(id)}`,
				'data-key': id,
				text: id,
			});
			chip.addEventListener('click', () =>
				setCoinShown(id, !app.multi.selected.has(id))
			);
			box.append(chip);
		}
		box.dataset.ids = ids.join(',');
	}
	syncChoice();
	renderPickerState();
}

function renderPickerState() {
	const open = app.multi.pickerOpen;
	$('multi-coins').hidden = !open;
	$('multi-picker-toggle').setAttribute('aria-expanded', String(open));
}

// The request is cached, not only its answer, so the overview and the comparison never fetch a file twice
function getSeries(id, file) {
	const key = `${id}.${file}`;
	if (!app.cache.has(key)) {
		const keys = file === 'daily' ? ['t', 'c'] : ['t', 'p'];
		const request = fetchJson(coinDataUrl(id, file)).then((json) => {
			if (!validSeries(json, keys)) {
				throw new Error(`${key}: unexpected data`);
			}
			return file === 'daily' ? dailyToPoints(json) : json;
		});
		app.cache.set(key, request);
		request.catch(() => {
			if (app.cache.get(key) === request) {
				app.cache.delete(key);
			}
		});
	}
	return app.cache.get(key);
}

// ----- loading

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
			app.sparks = null;
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
	const ids = coinIds();
	if (ids.length === 0) {
		showProblem('The data has no coins.');
		return;
	}
	if (app.multi.selected === null) {
		// The first coins are on the chart at the start. "Show all" adds the rest, and the colours repeat.
		app.multi.selected = new Set(ids.slice(0, COIN_COLOURS));
	}
	renderPicker();
	renderTable();
	loadMulti();
}

// Sizes the chart to its box. It runs when the box changes its size, and when the panel enters or leaves the
// full page view (the box can keep its size then).
function fitChart() {
	const chart = app.multi.chart;
	const host = $('multi-chart');
	if (!chart || host.clientWidth === 0) {
		return;
	}
	// The names at the line ends are short on a narrow screen, so a change of the width class redraws
	if (app.multi.compact !== host.clientWidth < 480) {
		drawMulti();
		return;
	}
	chart.setSize({ width: host.clientWidth, height: chartHeight(host) });
}

// ----- a chart on the whole page

const PANELS = {
	'multi-panel': () =>
		`Coin comparison, ${RANGES[app.multi.range].title}, percent change`,
};

// The panel that fills the page, with what is needed to put it back
let openPanel = null;

function showPanel(node) {
	closePanel();
	const title = $(`${node.id}-title`);
	const button = node.querySelector('.expand');
	openPanel = { node, title, button, was: title.textContent };
	title.textContent = PANELS[node.id]();
	node.classList.add('is-expanded');
	node.setAttribute('role', 'dialog');
	node.setAttribute('aria-modal', 'true');
	node.setAttribute('aria-labelledby', title.id);
	button.setAttribute('aria-expanded', 'true');
	button.setAttribute('aria-label', 'Close the whole page view');
	button.replaceChildren(
		el('span', { 'aria-hidden': 'true', text: '✕' }),
		' Close'
	);
	document.body.classList.add('has-panel-open');
	if (node.id === 'multi-panel') {
		// A phone held sideways has no room for the list of coins: it starts closed there
		app.multi.pickerOpen = window.innerHeight > 500;
		renderPickerState();
	}
	fitChart();
	button.focus();
}

function closePanel() {
	if (!openPanel) {
		return;
	}
	const { node, title, button, was } = openPanel;
	openPanel = null;
	title.textContent = was;
	node.classList.remove('is-expanded');
	node.removeAttribute('role');
	node.removeAttribute('aria-modal');
	node.removeAttribute('aria-labelledby');
	button.setAttribute('aria-expanded', 'false');
	button.setAttribute('aria-label', button.dataset.label);
	button.replaceChildren(
		el('span', { 'aria-hidden': 'true', text: '⤢' }),
		' Expand'
	);
	document.body.classList.remove('has-panel-open');
	fitChart();
	button.focus();
}

// A panel whose chart is gone (the data has fewer than two coins) cannot stay open
function closePanelOf(id) {
	if (openPanel?.node.id === id) {
		closePanel();
	}
}

function initPanels() {
	for (const node of document.querySelectorAll('.panel')) {
		const button = node.querySelector('.expand');
		button.dataset.label = button.getAttribute('aria-label');
		button.addEventListener('click', () => {
			if (openPanel?.node === node) {
				closePanel();
			} else {
				showPanel(node);
			}
		});
	}
	document.addEventListener('keydown', (event) => {
		if (!openPanel) {
			return;
		}
		if (event.key === 'Escape') {
			closePanel();
			return;
		}
		if (event.key !== 'Tab') {
			return;
		}
		// Keep the focus inside the panel: it covers the page, which must not be reached by Tab
		const items = [
			...openPanel.node.querySelectorAll(
				'button, input, a[href], [tabindex="0"]'
			),
		].filter((item) => item.offsetParent !== null);
		const first = items[0];
		const last = items[items.length - 1];
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	});
}

function start() {
	renderMultiButtons();
	loadAll();
	setInterval(renderFreshness, TICK_MS);
	setInterval(loadAll, REFRESH_MS);

	const redraw = () => {
		if (app.multi.selected !== null) {
			drawMulti();
			paintSparks();
		}
	};
	window
		.matchMedia('(prefers-color-scheme: dark)')
		.addEventListener('change', redraw);
	new ResizeObserver(fitChart).observe($('multi-chart'));
	initPanels();
}

start();
