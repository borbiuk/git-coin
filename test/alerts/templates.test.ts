import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Trigger } from '../../src/alerts/logic.ts';
import {
	alertBody,
	alertLabels,
	alertTitle,
	autoCloseComment,
	formatPrice,
	keyLabels,
	noDataBody,
	repeatComment,
} from '../../src/alerts/templates.ts';
import type { AlertText } from '../../src/alerts/templates.ts';

const trigger: Trigger = {
	rule: 'move_1h',
	label: '1h',
	direction: 'down',
	movePercent: 3.4412,
	thresholdPercent: 3,
	severity: 'warning',
	reference: {
		ms: Date.parse('2026-10-29T13:00:00Z'),
		ts: '2026-10-29T13:00:00Z',
		price: '84125.40000',
		value: 84125.4,
	},
	current: {
		ms: Date.parse('2026-10-29T14:00:00Z'),
		ts: '2026-10-29T14:00:00Z',
		price: '81232.79000',
		value: 81232.79,
	},
};

const text: AlertText = {
	coin: 'BTC',
	coinName: 'Bitcoin',
	trigger,
	source: 'kraken',
	detectedAt: '2026-10-29T14:03:12Z',
	dashboardUrl: 'https://borbiuk.github.io/git-coin/',
};

test('formatPrice groups thousands and keeps two or more decimals', () => {
	assert.equal(formatPrice('81232.79000'), '81,232.79');
	assert.equal(formatPrice('100'), '100.00');
	assert.equal(formatPrice('1234567.5'), '1,234,567.50');
	assert.equal(formatPrice('0.00001234'), '0.00001234');
	assert.equal(formatPrice('0.5000'), '0.50');
	assert.equal(formatPrice('999'), '999.00');
});

test('the title follows the ADR template', () => {
	assert.equal(
		alertTitle(text),
		'[ALERT] BTC down 3.4% in 1h (81,232.79 USD)'
	);
});

test('the labels follow the ADR', () => {
	assert.deepEqual(alertLabels('BTC', trigger), [
		'alert',
		'coin:BTC',
		'dir:down',
		'window:1h',
		'severity:warning',
	]);
	assert.deepEqual(keyLabels('BTC', 'down'), [
		'alert',
		'coin:BTC',
		'dir:down',
	]);
});

test('the body has the required facts, the mention and the disclaimer', () => {
	const body = alertBody(text);
	for (const line of [
		'Coin: BTC (Bitcoin)',
		'Direction: down',
		'Window: 1h',
		'Threshold: 3%',
		'Severity: warning',
		'Reference: 2026-10-29T13:00:00Z at 84,125.40 USD',
		'Current: 2026-10-29T14:00:00Z at 81,232.79 USD',
		'Source: Kraken. Quote: USD.',
		'Detected at: 2026-10-29T14:03:12Z (UTC).',
		'Runs can be late.',
		'Dashboard: https://borbiuk.github.io/git-coin/',
		'Not financial advice. Data may be delayed or wrong.',
		'@borbiuk',
	]) {
		assert.ok(body.includes(line), `missing: ${line}`);
	}
});

test('the other comments are short and plain', () => {
	assert.equal(
		repeatComment(text),
		'New trigger: BTC down 3.4% in 1h (81,232.79 USD, warning). Detected at 2026-10-29T14:03:12Z (UTC).'
	);
	assert.equal(autoCloseComment(24), 'No new trigger in 24 hours. Closing.');
	assert.ok(noDataBody().includes('@borbiuk'));
});
