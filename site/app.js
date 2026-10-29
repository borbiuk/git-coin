// git-coin dashboard (ADR 0008). Plain JavaScript, no build step.
// Chart library: uPlot 1.6.32 (MIT), vendored in vendor/. Dependabot cannot update it: update by hand.
import {
	RANGES,
	alertSummary,
	breakGaps,
	coinDataUrl,
	dailyToPoints,
	formatAxisPrice,
	formatChange,
	formatLastUpdated,
	formatPrice,
	formatUtcTime,
	issueUrl,
	sliceRange,
	sourceInfo,
	staleBanner,
	staleLimits,
	staleState,
	summarizeSeries,
	validSeries,
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
	cache: new Map(),
	drawToken: 0,
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
		`Price of ${formatUtcTime(coin.ts, now)}, in US dollars.${late}`;

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
			cursor: { drag: { x: false, y: false } },
			series: [
				{ value: '{YYYY}-{MM}-{DD} {HH}:{mm} UTC' },
				{
					label: 'Price',
					stroke: cssVar('--line'),
					width: 2,
					spanGaps: false,
					points: { show: false },
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

async function loadChart() {
	const token = ++app.drawToken;
	const { coin, range } = app;
	const status = $('chart-status');
	status.textContent = 'Loading the chart…';
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
			status.textContent = 'No data in this range.';
			return;
		}
		status.textContent = '';
		drawChart(series);
	} catch (err) {
		if (token !== app.drawToken) {
			return;
		}
		console.error(err);
		destroyChart();
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
}

function start() {
	renderRanges();
	loadAll();
	setInterval(renderFreshness, TICK_MS);
	setInterval(loadAll, REFRESH_MS);

	const redraw = () => {
		if (app.coin !== null) {
			loadChart();
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
}

start();
