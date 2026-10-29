import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
	directionAllowed,
	evaluateRule,
	pickCurrent,
	pickReference,
	resolveParams,
	toSamples,
} from '../../src/alerts/logic.ts';
import type { RuleParams, Sample } from '../../src/alerts/logic.ts';

import { makeCoin, makeConfig } from './helpers.ts';

const NOW_MS = Date.parse('2026-10-29T14:00:00Z');

function sample(ts: string, price: string): Sample {
	return { ms: Date.parse(ts), ts, price, value: Number(price) };
}

const RULE_1H: RuleParams = {
	rule: 'move_1h',
	label: '1h',
	windowMinutes: 60,
	thresholdPercent: 5,
	refToleranceMinutes: 30,
};

describe('resolveParams', () => {
	const defaults = makeConfig([]).settings.alert_defaults;

	test('uses the defaults when the coin has no overrides', () => {
		const params = resolveParams(makeCoin('SOL'), defaults);
		assert.equal(params.enabled, true);
		assert.equal(params.direction, 'both');
		assert.equal(params.cooldownHours, 6);
		assert.equal(params.dailyIssueCap, 5);
		assert.equal(params.autoCloseHours, 24);
		assert.deepEqual(
			params.rules.map((r) => [
				r.label,
				r.windowMinutes,
				r.thresholdPercent,
			]),
			[
				['1h', 60, 5],
				['24h', 1440, 15],
			]
		);
	});

	test('merges a partial per-coin override with the defaults', () => {
		const coin = makeCoin('BTC', {
			alerts: {
				direction: 'down',
				cooldown_hours: 2,
				move_1h: { threshold_percent: 3 },
				move_24h: { threshold_percent: 8, ref_tolerance_minutes: 60 },
			},
		});
		const params = resolveParams(coin, defaults);
		assert.equal(params.direction, 'down');
		assert.equal(params.cooldownHours, 2);
		assert.equal(params.rules[0]?.thresholdPercent, 3);
		assert.equal(params.rules[0]?.refToleranceMinutes, 30);
		assert.equal(params.rules[1]?.thresholdPercent, 8);
		assert.equal(params.rules[1]?.refToleranceMinutes, 60);
	});

	test('a disabled coin is never enabled by an override', () => {
		const coin = makeCoin('ADA', {
			enabled: false,
			alerts: { enabled: true },
		});
		assert.equal(resolveParams(coin, defaults).enabled, false);
	});

	test('a per-coin override can turn alerts off or on', () => {
		const off = makeCoin('ADA', { alerts: { enabled: false } });
		assert.equal(resolveParams(off, defaults).enabled, false);
		const globalOff = { ...defaults, enabled: false };
		const on = makeCoin('ADA', { alerts: { enabled: true } });
		assert.equal(resolveParams(on, globalOff).enabled, true);
		assert.equal(resolveParams(makeCoin('ADA'), globalOff).enabled, false);
	});
});

describe('toSamples', () => {
	test('drops bad prices and bad times', () => {
		const samples = toSamples([
			{
				ts: '2026-10-29T13:00:00Z',
				price: '100.50',
				src: 'kr',
				age_s: null,
			},
			{ ts: '2026-10-29T13:05:00Z', price: '0', src: 'kr', age_s: null },
			{ ts: '2026-10-29T13:06:00Z', price: '-5', src: 'kr', age_s: null },
			{
				ts: '2026-10-29T13:07:00Z',
				price: '1e5',
				src: 'kr',
				age_s: null,
			},
			{
				ts: '2026-10-29T13:08:00Z',
				price: '12,5',
				src: 'kr',
				age_s: null,
			},
			{
				ts: '2026-10-29T13:09:00Z',
				price: 'abc',
				src: 'kr',
				age_s: null,
			},
			{ ts: '2026-10-29T13:10:00Z', price: '', src: 'kr', age_s: null },
			{ ts: 'not a time', price: '10', src: 'kr', age_s: null },
		]);
		assert.deepEqual(
			samples.map((s) => s.price),
			['100.50']
		);
	});

	test('keeps small prices as they are', () => {
		const samples = toSamples([
			{
				ts: '2026-10-29T13:00:00Z',
				price: '0.00001234',
				src: 'kr',
				age_s: null,
			},
		]);
		assert.equal(samples[0]?.price, '0.00001234');
		assert.equal(samples[0]?.value, 0.00001234);
	});
});

describe('pickReference', () => {
	const at = (minutesBefore: number): string =>
		new Date(NOW_MS - minutesBefore * 60_000).toISOString().slice(0, 19) +
		'Z';

	test('takes the latest sample at or before now minus the window', () => {
		const samples = [
			sample(at(75), '90'),
			sample(at(62), '95'),
			sample(at(60), '100'),
			sample(at(50), '110'),
		];
		assert.equal(pickReference(samples, NOW_MS, 60, 30)?.price, '100');
	});

	test('a sample after the window start is not a reference', () => {
		const samples = [sample(at(59), '100')];
		assert.equal(pickReference(samples, NOW_MS, 60, 30), null);
	});

	test('the oldest allowed age is window plus tolerance, inclusive', () => {
		assert.equal(
			pickReference([sample(at(90), '100')], NOW_MS, 60, 30)?.price,
			'100'
		);
		assert.equal(
			pickReference([sample(at(91), '100')], NOW_MS, 60, 30),
			null
		);
	});

	test('returns null for no samples', () => {
		assert.equal(pickReference([], NOW_MS, 60, 30), null);
	});

	test('does not depend on the order of the samples', () => {
		const samples = [sample(at(62), '95'), sample(at(80), '90')];
		assert.equal(pickReference(samples, NOW_MS, 60, 30)?.price, '95');
		assert.equal(
			pickReference([...samples].reverse(), NOW_MS, 60, 30)?.price,
			'95'
		);
	});
});

describe('pickCurrent', () => {
	test('takes the latest sample that is not in the future and not too old', () => {
		const samples = [
			sample('2026-10-29T13:40:00Z', '1'),
			sample('2026-10-29T13:50:00Z', '2'),
			sample('2026-10-29T14:00:01Z', '3'),
		];
		assert.equal(pickCurrent(samples, NOW_MS, 30 * 60_000)?.price, '2');
	});

	test('returns null when the latest sample is too old', () => {
		const samples = [sample('2026-10-29T13:29:59Z', '1')];
		assert.equal(pickCurrent(samples, NOW_MS, 30 * 60_000), null);
		assert.equal(
			pickCurrent(
				[sample('2026-10-29T13:30:00Z', '1')],
				NOW_MS,
				30 * 60_000
			)?.price,
			'1'
		);
	});
});

describe('evaluateRule', () => {
	const ref = sample('2026-10-29T13:00:00Z', '100');

	test('a move of exactly the threshold triggers a warning', () => {
		const trigger = evaluateRule(
			[ref, sample('2026-10-29T14:00:00Z', '95')],
			NOW_MS,
			RULE_1H
		);
		assert.equal(trigger?.direction, 'down');
		assert.equal(trigger?.severity, 'warning');
		assert.equal(trigger?.movePercent, 5);
	});

	test('a move just below the threshold does not trigger', () => {
		const trigger = evaluateRule(
			[ref, sample('2026-10-29T14:00:00Z', '95.01')],
			NOW_MS,
			RULE_1H
		);
		assert.equal(trigger, null);
	});

	test('twice the threshold is critical, just below is a warning', () => {
		const critical = evaluateRule(
			[ref, sample('2026-10-29T14:00:00Z', '110')],
			NOW_MS,
			RULE_1H
		);
		assert.equal(critical?.direction, 'up');
		assert.equal(critical?.severity, 'critical');
		const warning = evaluateRule(
			[ref, sample('2026-10-29T14:00:00Z', '109.99')],
			NOW_MS,
			RULE_1H
		);
		assert.equal(warning?.severity, 'warning');
	});

	test('a threshold such as 3 percent is not lost to rounding', () => {
		const rule = { ...RULE_1H, thresholdPercent: 3 };
		const trigger = evaluateRule(
			[
				sample('2026-10-29T13:00:00Z', '81232.79'),
				sample('2026-10-29T14:00:00Z', String(81232.79 * 0.97)),
			],
			NOW_MS,
			rule
		);
		assert.notEqual(trigger, null);
	});

	test('no reference gives no trigger', () => {
		assert.equal(
			evaluateRule(
				[sample('2026-10-29T14:00:00Z', '50')],
				NOW_MS,
				RULE_1H
			),
			null
		);
	});

	test('a current sample older than the tolerance gives no trigger', () => {
		assert.equal(
			evaluateRule(
				[ref, sample('2026-10-29T13:20:00Z', '50')],
				NOW_MS,
				RULE_1H
			),
			null
		);
	});

	test('a flat price gives no trigger', () => {
		assert.equal(
			evaluateRule(
				[ref, sample('2026-10-29T14:00:00Z', '100')],
				NOW_MS,
				RULE_1H
			),
			null
		);
	});
});

describe('directionAllowed', () => {
	test('follows the direction setting', () => {
		assert.equal(directionAllowed('both', 'up'), true);
		assert.equal(directionAllowed('both', 'down'), true);
		assert.equal(directionAllowed('up', 'up'), true);
		assert.equal(directionAllowed('up', 'down'), false);
		assert.equal(directionAllowed('down', 'up'), false);
		assert.equal(directionAllowed('down', 'down'), true);
	});
});
