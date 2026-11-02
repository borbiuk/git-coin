// git-coin admin page: failed requests of the sources, from data/errors.json. Plain JavaScript, no build step.
import { formatUtcTime, sourceInfo } from './lib.js';

const REFRESH_MS = 5 * 60 * 1000;

/** What each error code of the request log means, in the words of src/http.ts. */
const REASONS = {
	timeout: 'No answer in 10 seconds (also retried once).',
	http_429: 'The source said "too many requests". It is not retried.',
	http_other:
		'Another HTTP status (3xx, 4xx, 5xx), or no response at all (status 0: DNS, refused, reset). 5xx and network errors are retried once.',
	parse: 'The answer was not valid JSON, or was larger than 5 MB.',
	unmapped: 'The answer was fine but had none of the coins we asked for.',
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

/** "200 ×120, 429 ×3". Status 0 is shown as "none". */
function formatCounts(record, label = (key) => key) {
	const entries = Object.entries(record ?? {});
	if (entries.length === 0) {
		return '–';
	}
	return entries.map(([key, n]) => `${label(key)} ×${n}`).join(', ');
}

function statusLabel(code) {
	return code === '0' ? 'none' : code;
}

function percent(part, whole) {
	if (whole === 0) {
		return '–';
	}
	const value = (part / whole) * 100;
	return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

function head(...names) {
	return el(
		'thead',
		{},
		el(
			'tr',
			{},
			...names.map((name) =>
				el('th', {
					scope: 'col',
					class: name.num ? 'num' : '',
					text: name.text,
				})
			)
		)
	);
}

function renderStats(table, sources) {
	const rows = Object.entries(sources ?? {});
	table.replaceChildren(
		head(
			{ text: 'Source' },
			{ text: 'Requests', num: true },
			{ text: 'Failed', num: true },
			{ text: 'Failed %', num: true },
			{ text: 'Median ms', num: true },
			{ text: 'HTTP status of all requests' },
			{ text: 'HTTP status of failures' },
			{ text: 'Reasons' },
			{ text: 'Last failure' }
		)
	);
	const body = el('tbody');
	if (rows.length === 0) {
		body.append(
			el(
				'tr',
				{},
				el('td', { colspan: '9', class: 'muted', text: 'No requests.' })
			)
		);
	}
	for (const [src, s] of rows) {
		const failed = s.failures > 0;
		body.append(
			el(
				'tr',
				{},
				el('th', { scope: 'row', text: sourceInfo(src).name }),
				el('td', { class: 'num', text: String(s.requests) }),
				el('td', {
					class: failed ? 'num err' : 'num',
					text: String(s.failures),
				}),
				el('td', {
					class: 'num',
					text: percent(s.failures, s.requests),
				}),
				el('td', {
					class: 'num',
					text: s.median_ms === null ? '–' : String(s.median_ms),
				}),
				el('td', { text: formatCounts(s.by_http, statusLabel) }),
				el('td', {
					text: formatCounts(s.failures_by_http, statusLabel),
				}),
				el('td', { text: formatCounts(s.failures_by_error) }),
				el('td', {
					text: s.last_failure_at
						? formatUtcTime(s.last_failure_at, Date.now())
						: '–',
				})
			)
		);
	}
	table.append(body);
}

function renderRecent(table, rows) {
	$('recent-empty').hidden = rows.length > 0;
	table.hidden = rows.length === 0;
	if (rows.length === 0) {
		return;
	}
	table.replaceChildren(
		head(
			{ text: 'Time' },
			{ text: 'Source' },
			{ text: 'HTTP status' },
			{ text: 'Reason' },
			{ text: 'Duration ms', num: true },
			{ text: 'Coins ok', num: true }
		)
	);
	const body = el('tbody');
	for (const row of rows) {
		body.append(
			el(
				'tr',
				{},
				el('td', { text: formatUtcTime(row.ts, Date.now()) }),
				el('td', { text: sourceInfo(row.src).name }),
				el('td', { text: statusLabel(String(row.http)) }),
				el('td', { text: row.error }),
				el('td', { class: 'num', text: String(row.ms) }),
				el('td', { class: 'num', text: String(row.coins_ok) })
			)
		);
	}
	table.append(body);
}

function renderHelp() {
	const list = $('help');
	list.replaceChildren();
	for (const [code, text] of Object.entries(REASONS)) {
		list.append(el('dt', { text: code }), el('dd', { text }));
	}
}

async function load() {
	const problem = $('problem');
	try {
		const res = await fetch('data/errors.json', { cache: 'no-cache' });
		if (!res.ok) {
			throw new Error(`HTTP ${res.status}`);
		}
		const data = await res.json();
		problem.hidden = true;
		$('generated').textContent =
			`Built ${formatUtcTime(data.generated_at, Date.now())}. The numbers come from the request log: one row per source and run.`;
		renderStats($('stats-24h'), data.periods?.['24h']);
		renderStats($('stats-7d'), data.periods?.['7d']);
		renderRecent($('recent'), data.recent ?? []);
	} catch (error) {
		problem.hidden = false;
		problem.textContent = `Could not load data/errors.json (${error instanceof Error ? error.message : error}).`;
	}
}

renderHelp();
load();
setInterval(load, REFRESH_MS);
