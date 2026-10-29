import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PriceRow } from '../src/types.ts';
import { validatePrice, validateRow } from '../src/validate.ts';

function row(price: string): PriceRow {
	return {
		ts: '2026-10-29T14:03:12Z',
		coin: 'BTC',
		price,
		src: 'kr',
		age_s: null,
	};
}

const production = {
	phase: 'production' as const,
	previous: 100 as number | null,
	maxStepPercent: 50,
	crosscheckMaxDiffPercent: 2,
};

test('validatePrice accepts plain decimals and returns the number', () => {
	assert.deepEqual(validatePrice('100.00'), { ok: true, value: 100 });
	assert.deepEqual(validatePrice('0.00001234'), {
		ok: true,
		value: 0.00001234,
	});
	assert.deepEqual(validatePrice('67890'), { ok: true, value: 67890 });
	assert.deepEqual(validatePrice('999999999.99'), {
		ok: true,
		value: 999999999.99,
	});
});

test('validatePrice rejects values that are not strict decimals', () => {
	const bad = [
		'',
		' 1',
		'1 ',
		'1\n',
		'abc',
		'NaN',
		'Infinity',
		'null',
		'1e5',
		'1E5',
		'+1',
		'1,5',
		'1,000.50',
		'.5',
		'5.',
		'007',
		'0x10',
		'1_000',
		'--1',
	];
	for (const raw of bad) {
		assert.deepEqual(
			validatePrice(raw),
			{ ok: false, reason: 'not_decimal' },
			JSON.stringify(raw)
		);
	}
});

test('validatePrice rejects values that are not strings', () => {
	assert.deepEqual(validatePrice(null as unknown as string), {
		ok: false,
		reason: 'not_decimal',
	});
	assert.deepEqual(validatePrice(100 as unknown as string), {
		ok: false,
		reason: 'not_decimal',
	});
});

test('validatePrice rejects zero and negative prices', () => {
	for (const raw of ['0', '0.0', '0.000', '-0', '-1', '-0.5']) {
		assert.deepEqual(
			validatePrice(raw),
			{ ok: false, reason: 'not_positive' },
			raw
		);
	}
});

test('validatePrice rejects prices of one billion or more', () => {
	assert.deepEqual(validatePrice('1000000000'), {
		ok: false,
		reason: 'too_large',
	});
	assert.deepEqual(validatePrice('99999999999999'), {
		ok: false,
		reason: 'too_large',
	});
});

test('validatePrice rejects a number too long to be finite', () => {
	assert.deepEqual(validatePrice('9'.repeat(400)), {
		ok: false,
		reason: 'not_finite',
	});
});

test('validateRow in test phase checks only the price text', () => {
	const ctx = {
		phase: 'test' as const,
		previous: 100,
		crosscheck: 1,
		maxStepPercent: 50,
		crosscheckMaxDiffPercent: 2,
	};
	assert.deepEqual(validateRow(row('500'), ctx), { ok: true });
	assert.deepEqual(validateRow(row('0'), ctx), {
		ok: false,
		reason: 'not_positive',
	});
	assert.deepEqual(validateRow(row('1e5'), ctx), {
		ok: false,
		reason: 'not_decimal',
	});
});

test('validateRow in production rejects a malformed price first', () => {
	assert.deepEqual(validateRow(row('abc'), production), {
		ok: false,
		reason: 'not_decimal',
	});
});

test('validateRow in production accepts a normal step', () => {
	assert.deepEqual(validateRow(row('120'), production), { ok: true });
	assert.deepEqual(validateRow(row('50'), production), { ok: true });
	assert.deepEqual(validateRow(row('150'), production), { ok: true });
});

test('validateRow in production accepts the first row (no previous)', () => {
	assert.deepEqual(
		validateRow(row('1000'), { ...production, previous: null }),
		{ ok: true }
	);
});

test('validateRow rejects a step over 50 percent without a cross-check', () => {
	assert.deepEqual(validateRow(row('150.01'), production), {
		ok: false,
		reason: 'step_no_crosscheck',
	});
	assert.deepEqual(validateRow(row('49.99'), production), {
		ok: false,
		reason: 'step_no_crosscheck',
	});
	assert.deepEqual(
		validateRow(row('200'), { ...production, crosscheck: null }),
		{ ok: false, reason: 'step_no_crosscheck' }
	);
});

test('validateRow ignores an unusable cross-check', () => {
	for (const crosscheck of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.deepEqual(
			validateRow(row('200'), { ...production, crosscheck }),
			{ ok: false, reason: 'step_no_crosscheck' },
			String(crosscheck)
		);
	}
});

test('validateRow accepts a large step when the cross-check agrees', () => {
	assert.deepEqual(
		validateRow(row('200'), { ...production, crosscheck: 201 }),
		{ ok: true }
	);
});

test('validateRow rejects a large step when the cross-check disagrees', () => {
	assert.deepEqual(
		validateRow(row('200'), { ...production, crosscheck: 100 }),
		{ ok: false, reason: 'crosscheck_diff' }
	);
});

test('validateRow rejects a small step that the cross-check contradicts', () => {
	assert.deepEqual(
		validateRow(row('101'), { ...production, crosscheck: 110 }),
		{ ok: false, reason: 'crosscheck_diff' }
	);
	assert.deepEqual(
		validateRow(row('101'), { ...production, crosscheck: 101.5 }),
		{ ok: true }
	);
});
