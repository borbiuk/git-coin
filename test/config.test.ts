import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	ConfigError,
	candleSource,
	enabledCoins,
	hasSource,
	loadConfig,
	primarySource,
} from '../src/config.ts';
import type { CoinConfig } from '../src/types.ts';
import { usableIds } from '../tools/check-symbols.ts';

const VALID = new URL('./fixtures/config/valid.json', import.meta.url);
const REAL = new URL('../config/coins.json', import.meta.url);
const SCHEMA = new URL('../config/coins.schema.json', import.meta.url);

type Json = Record<string, unknown>;
type Path = (string | number)[];

async function readJson(url: URL): Promise<Json> {
	return JSON.parse(await readFile(url, 'utf8')) as Json;
}

/** Returns a copy of `base` with the value at `path` replaced, or removed when `value` is undefined. */
function edit(base: Json, path: Path, value: unknown): Json {
	const copy = structuredClone(base);
	let node = copy as Record<string | number, unknown>;
	for (const key of path.slice(0, -1)) {
		node = node[key] as Record<string | number, unknown>;
	}
	const last = path[path.length - 1];
	if (value === undefined) {
		delete node[last];
	} else {
		node[last] = value;
	}
	return copy;
}

// A small JSON Schema check for the keywords that config/coins.schema.json uses.
// The full validation runs in CI with check-jsonschema.
function schemaErrors(schema: Json, value: unknown, root: Json): string[] {
	const ref = schema.$ref;
	if (typeof ref === 'string') {
		let target: unknown = root;
		for (const part of ref.slice(2).split('/')) {
			target = (target as Json)[part];
		}
		return schemaErrors(target as Json, value, root);
	}
	const errors: string[] = [];
	if ('const' in schema && schema.const !== value) {
		errors.push('const');
	}
	if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
		errors.push('enum');
	}
	const type = schema.type;
	if (type === 'object') {
		if (
			typeof value !== 'object' ||
			value === null ||
			Array.isArray(value)
		) {
			return ['type object'];
		}
		const obj = value as Json;
		const properties = (schema.properties ?? {}) as Record<string, Json>;
		for (const key of (schema.required ?? []) as string[]) {
			if (!(key in obj)) {
				errors.push(`required ${key}`);
			}
		}
		for (const [key, item] of Object.entries(obj)) {
			if (key in properties) {
				errors.push(...schemaErrors(properties[key], item, root));
			} else if (schema.additionalProperties === false) {
				errors.push(`additional ${key}`);
			}
		}
	} else if (type === 'array') {
		if (!Array.isArray(value)) {
			return ['type array'];
		}
		if (
			typeof schema.minItems === 'number' &&
			value.length < schema.minItems
		) {
			errors.push('minItems');
		}
		if (
			schema.uniqueItems === true &&
			new Set(value).size !== value.length
		) {
			errors.push('uniqueItems');
		}
		for (const item of value) {
			errors.push(...schemaErrors(schema.items as Json, item, root));
		}
	} else if (type === 'string') {
		if (typeof value !== 'string') {
			return ['type string'];
		}
		if (typeof schema.pattern === 'string') {
			if (!new RegExp(schema.pattern).test(value)) {
				errors.push('pattern');
			}
		}
		if (
			typeof schema.minLength === 'number' &&
			value.length < schema.minLength
		) {
			errors.push('minLength');
		}
		if (
			typeof schema.maxLength === 'number' &&
			value.length > schema.maxLength
		) {
			errors.push('maxLength');
		}
	} else if (type === 'number' || type === 'integer') {
		if (typeof value !== 'number') {
			return ['type number'];
		}
		if (type === 'integer' && !Number.isInteger(value)) {
			errors.push('integer');
		}
		if (typeof schema.minimum === 'number' && value < schema.minimum) {
			errors.push('minimum');
		}
		if (typeof schema.maximum === 'number' && value > schema.maximum) {
			errors.push('maximum');
		}
		if (
			typeof schema.exclusiveMinimum === 'number' &&
			value <= schema.exclusiveMinimum
		) {
			errors.push('exclusiveMinimum');
		}
	} else if (type === 'boolean' && typeof value !== 'boolean') {
		errors.push('type boolean');
	}
	return errors;
}

describe('config', () => {
	let dir = '';
	let valid: Json = {};
	let schema: Json = {};
	let counter = 0;

	before(async () => {
		dir = await mkdtemp(join(tmpdir(), 'git-coin-config-'));
		valid = await readJson(VALID);
		schema = await readJson(SCHEMA);
	});

	after(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function writeTemp(content: string): Promise<string> {
		counter += 1;
		const path = join(dir, `config-${counter}.json`);
		await writeFile(path, content);
		return path;
	}

	function schemaAccepts(value: unknown): boolean {
		return schemaErrors(schema, value, schema).length === 0;
	}

	test('loads a valid config', async () => {
		const config = await loadConfig(fileURLToPath(VALID));
		assert.equal(config.schema_version, 1);
		assert.equal(config.settings.phase, 'test');
		assert.deepEqual(config.settings.stored_sources, [
			'kraken',
			'bitstamp',
		]);
		assert.equal(
			config.settings.alert_defaults.move_1h.threshold_percent,
			5
		);
		assert.equal(config.coins.length, 3);
		assert.equal(config.coins[0].alerts?.direction, 'down');
		assert.deepEqual(config.coins[0].alerts?.move_1h, {
			threshold_percent: 3,
		});
		assert.equal(config.coins[0].note, 'Synthetic coin for tests');
		assert.equal(config.coins[1].alerts, undefined);
		assert.ok(schemaAccepts(valid));
	});

	test('the real config loads and matches the plan', async () => {
		const config = await loadConfig(fileURLToPath(REAL));
		assert.ok(schemaAccepts(await readJson(REAL)));
		assert.equal(config.settings.phase, 'test');
		assert.deepEqual(config.settings.stored_sources, [
			'kraken',
			'coinbase',
			'bitstamp',
			'coinmetrics',
		]);
		assert.deepEqual(config.settings.features, {
			alerts: false,
			publish: true,
		});
		const ids =
			'BTC ETH BNB XRP SOL TRX RUNE DOT ATOM AVAX ETC KSM SC ICP EGLD CHZ MINA ZIL NEAR LINK CAKE UNI XLM SUI CRV ADA XTZ'.split(
				' '
			);
		assert.deepEqual(
			config.coins.map((coin) => coin.id),
			[...ids, 'DOGE', 'LTC', 'USDT']
		);
		// The two coins that left the list are kept, disabled, so their history stays
		for (const id of ['DOGE', 'LTC']) {
			assert.equal(
				config.coins.find((coin) => coin.id === id)?.enabled,
				false
			);
		}
		assert.equal(enabledCoins(config, 'kraken').length, 27);
		assert.equal(enabledCoins(config, 'coinmetrics').length, 28);
		// ZIL is only on Coin Metrics, so Coin Metrics is its primary source and it has no candles
		const zil = config.coins.find((coin) => coin.id === 'ZIL');
		assert.deepEqual(Object.keys(zil?.sources ?? {}), [
			'coinmetrics_asset',
			'coingecko_id',
		]);
		assert.equal(primarySource(config, zil as CoinConfig), 'coinmetrics');
		assert.equal(candleSource(zil as CoinConfig), null);
		const [btc, eth, bnb] = config.coins;
		assert.equal(btc.sources.kraken_pair, 'XBTUSD');
		assert.deepEqual(btc.alerts, {
			move_1h: { threshold_percent: 3 },
			move_24h: { threshold_percent: 8 },
		});
		assert.deepEqual(eth.alerts, {
			move_1h: { threshold_percent: 4 },
			move_24h: { threshold_percent: 12 },
		});
		assert.equal(bnb.alerts, undefined);
		// The rate entry that turns the prices into USDT, with no alerts of its own
		const usdt = config.coins.find((coin) => coin.id === 'USDT');
		assert.equal(usdt?.role, 'rate');
		assert.deepEqual(usdt?.alerts, { enabled: false });
		assert.equal(usdt?.sources.kraken_pair, 'USDTUSD');
		assert.equal(btc.role, undefined);
	});

	test('the primary source and the candle source follow the ids a coin has', async () => {
		const config = await loadConfig(fileURLToPath(REAL));
		const coin = (id: string) =>
			config.coins.find((item) => item.id === id) as CoinConfig;
		assert.equal(primarySource(config, coin('BTC')), 'kraken');
		assert.deepEqual(candleSource(coin('BTC')), {
			src: 'bs-ohlc',
			market: 'btcusd',
		});
		// RUNE and SC are only on Kraken and Coin Metrics, so Kraken gives the candles
		assert.deepEqual(candleSource(coin('RUNE')), {
			src: 'kr-ohlc',
			market: 'RUNEUSD',
		});
		assert.equal(hasSource(coin('RUNE'), 'coinbase'), false);
		assert.equal(hasSource(coin('TRX'), 'coinbase'), false);
		// Bitstamp trades TRX too rarely, so TRX has no Bitstamp market and Kraken gives its candles
		assert.equal(hasSource(coin('TRX'), 'bitstamp'), false);
		assert.equal(candleSource(coin('TRX'))?.src, 'kr-ohlc');
	});

	test('enabledCoins skips disabled coins and coins without an id for the source', async () => {
		const config = await loadConfig(fileURLToPath(VALID));
		assert.deepEqual(
			enabledCoins(config, 'kraken').map((coin) => coin.id),
			['AAA', 'BBB']
		);
		assert.deepEqual(
			enabledCoins(config, 'coinbase').map((coin) => coin.id),
			['AAA']
		);
		assert.deepEqual(enabledCoins(config, 'coinmetrics'), []);
	});

	test('rejects a missing file and text that is not JSON with ConfigError', async () => {
		await assert.rejects(
			loadConfig(join(dir, 'missing.json')),
			(error: unknown) =>
				error instanceof ConfigError &&
				/Cannot read/.test(error.message)
		);
		const path = await writeTemp('{ "schema_version": 1, ');
		await assert.rejects(
			loadConfig(path),
			(error: unknown) =>
				error instanceof ConfigError &&
				/not valid JSON/.test(error.message)
		);
		await assert.rejects(loadConfig(await writeTemp('[]')), ConfigError);
	});

	// `schema` is false when only the loader can catch the problem (rules that compare fields or check a real date)
	const cases: Array<{
		name: string;
		path: Path;
		value: unknown;
		message: RegExp;
		schema: boolean;
	}> = [
		{
			name: 'unknown top-level key',
			path: ['extra'],
			value: true,
			message: /unknown key "extra"/,
			schema: true,
		},
		{
			name: 'unknown coin key',
			path: ['coins', 0, 'colour'],
			value: 'red',
			message: /unknown key "colour"/,
			schema: true,
		},
		{
			name: 'unknown source key',
			path: ['coins', 0, 'sources', 'okx_pair'],
			value: 'AAA',
			message: /unknown key "okx_pair"/,
			schema: true,
		},
		{
			name: 'unknown settings key',
			path: ['settings', 'speed'],
			value: 1,
			message: /unknown key "speed"/,
			schema: true,
		},
		{
			name: 'unknown alert override key',
			path: ['coins', 0, 'alerts', 'min_points'],
			value: 2,
			message: /unknown key "min_points"/,
			schema: true,
		},
		{
			name: 'wrong schema_version',
			path: ['schema_version'],
			value: 2,
			message: /schema_version/,
			schema: true,
		},
		{
			name: 'missing settings',
			path: ['settings'],
			value: undefined,
			message: /missing key "settings"/,
			schema: true,
		},
		{
			name: 'quote other than USD',
			path: ['settings', 'quote'],
			value: 'EUR',
			message: /quote/,
			schema: true,
		},
		{
			name: 'bad phase',
			path: ['settings', 'phase'],
			value: 'live',
			message: /phase: must be one of/,
			schema: true,
		},
		{
			name: 'missing feature flag',
			path: ['settings', 'features', 'publish'],
			value: undefined,
			message: /missing key "publish"/,
			schema: true,
		},
		{
			name: 'feature flag is not a boolean',
			path: ['settings', 'features', 'alerts'],
			value: 'yes',
			message: /features\.alerts/,
			schema: true,
		},
		{
			name: 'empty stored_sources',
			path: ['settings', 'stored_sources'],
			value: [],
			message: /stored_sources/,
			schema: true,
		},
		{
			name: 'unknown stored source',
			path: ['settings', 'stored_sources'],
			value: ['kraken', 'okx'],
			message: /stored_sources\[1\]/,
			schema: true,
		},
		{
			name: 'repeated stored source',
			path: ['settings', 'stored_sources'],
			value: ['kraken', 'kraken'],
			message: /must not repeat/,
			schema: true,
		},
		{
			name: 'spacing of zero',
			path: ['settings', 'min_spacing_seconds'],
			value: 0,
			message: /min_spacing_seconds/,
			schema: true,
		},
		{
			name: 'spacing above the range',
			path: ['settings', 'min_spacing_seconds'],
			value: 3601,
			message: /min_spacing_seconds/,
			schema: true,
		},
		{
			name: 'spacing that is not whole',
			path: ['settings', 'min_spacing_seconds'],
			value: 1.5,
			message: /whole number/,
			schema: true,
		},
		{
			name: 'step move of zero',
			path: ['settings', 'max_step_move_percent'],
			value: 0,
			message: /greater than 0/,
			schema: true,
		},
		{
			name: 'cross-check diff that is text',
			path: ['settings', 'crosscheck_max_diff_percent'],
			value: '2',
			message: /must be a number/,
			schema: true,
		},
		{
			name: 'negative cooldown',
			path: ['settings', 'alert_defaults', 'cooldown_hours'],
			value: -1,
			message: /cooldown_hours/,
			schema: true,
		},
		{
			name: 'bad direction',
			path: ['settings', 'alert_defaults', 'direction'],
			value: 'sideways',
			message: /direction: must be one of/,
			schema: true,
		},
		{
			name: 'threshold of zero',
			path: [
				'settings',
				'alert_defaults',
				'move_1h',
				'threshold_percent',
			],
			value: 0,
			message: /threshold_percent/,
			schema: true,
		},
		{
			name: 'missing alert default',
			path: ['settings', 'alert_defaults', 'move_24h', 'window_minutes'],
			value: undefined,
			message: /missing key "window_minutes"/,
			schema: true,
		},
		{
			name: 'override threshold below range',
			path: ['coins', 0, 'alerts', 'move_1h', 'threshold_percent'],
			value: -3,
			message: /threshold_percent/,
			schema: true,
		},
		{
			name: 'empty coin list',
			path: ['coins'],
			value: [],
			message: /coins/,
			schema: true,
		},
		{
			name: 'lower-case coin id',
			path: ['coins', 0, 'id'],
			value: 'aaa',
			message: /invalid format/,
			schema: true,
		},
		{
			name: 'empty coin name',
			path: ['coins', 0, 'name'],
			value: '',
			message: /non-empty/,
			schema: true,
		},
		{
			name: 'enabled is not a boolean',
			path: ['coins', 0, 'enabled'],
			value: 1,
			message: /enabled/,
			schema: true,
		},
		{
			name: 'source id with a space',
			path: ['coins', 0, 'sources', 'kraken_pair'],
			value: 'AAA USD',
			message: /invalid format/,
			schema: true,
		},
		{
			name: 'note is not a string',
			path: ['coins', 0, 'note'],
			value: 5,
			message: /note/,
			schema: true,
		},
		{
			name: 'added that is not a real date',
			path: ['coins', 0, 'added'],
			value: '2026-02-30',
			message: /not a date/,
			schema: false,
		},
		{
			name: 'duplicate coin id',
			path: ['coins', 1, 'id'],
			value: 'AAA',
			message: /duplicate coin id "AAA"/,
			schema: false,
		},
		{
			name: 'enabled coin without an id for any stored source',
			path: ['coins', 1, 'sources'],
			value: { coingecko_id: 'x' },
			message: /no id for any stored source/,
			schema: false,
		},
		{
			name: 'role other than rate',
			path: ['coins', 0, 'role'],
			value: 'coin',
			message: /role.*must be "rate"/,
			schema: true,
		},
		{
			name: 'rate entry whose alerts are not switched off',
			path: ['coins', 0, 'role'],
			value: 'rate',
			message: /rate entry must set "enabled" to false/,
			schema: false,
		},
		{
			name: 'stale_warn not below stale_stop',
			path: ['settings', 'stale_warn_minutes'],
			value: 360,
			message: /stale_warn_minutes must be less/,
			schema: false,
		},
		{
			name: 'default tolerance not below the window',
			path: [
				'settings',
				'alert_defaults',
				'move_1h',
				'ref_tolerance_minutes',
			],
			value: 60,
			message: /ref_tolerance_minutes must be less/,
			schema: false,
		},
		{
			name: 'override tolerance not below the window',
			path: ['coins', 0, 'alerts', 'move_1h', 'ref_tolerance_minutes'],
			value: 90,
			message: /ref_tolerance_minutes must be less/,
			schema: false,
		},
	];

	for (const item of cases) {
		test(`rejects: ${item.name}`, async () => {
			const bad = edit(valid, item.path, item.value);
			const path = await writeTemp(JSON.stringify(bad));
			await assert.rejects(
				loadConfig(path),
				(error: unknown) =>
					error instanceof ConfigError &&
					item.message.test(error.message)
			);
			assert.equal(schemaAccepts(bad), !item.schema);
		});
	}

	test('rejects two rate entries', async () => {
		const bad = JSON.parse(JSON.stringify(valid));
		for (const index of [0, 1]) {
			bad.coins[index].role = 'rate';
			bad.coins[index].alerts = { enabled: false };
		}
		const path = await writeTemp(JSON.stringify(bad));
		await assert.rejects(
			loadConfig(path),
			(error: unknown) =>
				error instanceof ConfigError &&
				/only one entry can have the role "rate"/.test(error.message)
		);
	});

	test('a disabled coin may have no source ids', async () => {
		const config = await loadConfig(fileURLToPath(VALID));
		assert.equal(config.coins[2].enabled, false);
		assert.deepEqual(config.coins[2].sources, {});
	});
});

describe('usableIds (symbol check)', () => {
	test('kraken keeps online altnames only', () => {
		const json = {
			error: [],
			result: {
				XXBTZUSD: { altname: 'XBTUSD', status: 'online' },
				AAAUSD: { altname: 'AAAUSD', status: 'cancel_only' },
			},
		};
		assert.deepEqual([...usableIds('kraken', json)], ['XBTUSD']);
	});

	test('coinbase keeps online products that are not disabled', () => {
		const json = [
			{ id: 'BTC-USD', status: 'online', trading_disabled: false },
			{ id: 'DAI-USD', status: 'delisted', trading_disabled: true },
			{ id: 'ETH-USD', status: 'online', trading_disabled: true },
		];
		assert.deepEqual([...usableIds('coinbase', json)], ['BTC-USD']);
	});

	test('bitstamp keeps enabled markets', () => {
		const json = [
			{ url_symbol: 'btcusd', trading: 'Enabled' },
			{ url_symbol: 'aaausd', trading: 'Disabled' },
		];
		assert.deepEqual([...usableIds('bitstamp', json)], ['btcusd']);
	});

	test('coin metrics keeps the assets with 1 minute prices', () => {
		const json = {
			data: [
				{
					metric: 'ReferenceRateUSD',
					frequencies: [
						{ frequency: '1s', assets: ['btc', 'zzz'] },
						{ frequency: '1m', assets: ['btc', 'eth'] },
					],
				},
			],
		};
		assert.deepEqual([...usableIds('coinmetrics', json)], ['btc', 'eth']);
	});

	test('a catalogue with an unexpected shape throws', () => {
		assert.throws(
			() => usableIds('coinbase', { error: 'x' }),
			/unexpected/
		);
		assert.throws(() => usableIds('kraken', null), /unexpected/);
	});
});
