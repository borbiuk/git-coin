import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isoSeconds, parseIso, utcDay } from '../src/time.ts';

test('isoSeconds drops the milliseconds and keeps the Z', () => {
	assert.equal(
		isoSeconds(new Date('2026-10-29T14:03:12.987Z')),
		'2026-10-29T14:03:12Z'
	);
});

test('utcDay returns the UTC date of an ISO time', () => {
	assert.equal(utcDay('2026-10-29T23:59:59Z'), '2026-10-29');
});

test('parseIso returns epoch milliseconds', () => {
	assert.equal(parseIso('1970-01-01T00:00:01Z'), 1000);
});

test('parseIso throws on text that is not a date', () => {
	assert.throws(() => parseIso('yesterday'), /Not an ISO time/);
});
