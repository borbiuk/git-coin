// Loads and checks config/coins.json (ADR 0007 D4.3). Plain code, no schema library.
// config/coins.schema.json is the same contract for CI. Rules that compare fields live only here.

import { readFile } from 'node:fs/promises';

import type {
	AlertDefaults,
	AlertOverrides,
	AlertParams,
	CoinConfig,
	CoinSources,
	Config,
	Phase,
	Settings,
	SourceId,
} from './types.ts';

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConfigError';
	}
}

const SOURCE_IDS: readonly SourceId[] = [
	'kraken',
	'coinbase',
	'bitstamp',
	'coinmetrics',
];
const PHASES: readonly Phase[] = ['test', 'production'];
const DIRECTIONS = ['up', 'down', 'both'] as const;

// The field of `CoinConfig.sources` that holds the id for each stored source
const SOURCE_FIELD = {
	kraken: 'kraken_pair',
	coinbase: 'coinbase_product',
	bitstamp: 'bitstamp_market',
	coinmetrics: 'coinmetrics_asset',
} as const satisfies Record<SourceId, keyof CoinSources>;

const SOURCE_KEYS: readonly (keyof CoinSources)[] = [
	'kraken_pair',
	'coinbase_product',
	'bitstamp_market',
	'coinmetrics_asset',
	'coingecko_id',
];

const COIN_ID = /^[A-Z0-9]{2,10}$/;
const SOURCE_KEY = /^[A-Za-z0-9._-]{1,40}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

type Obj = Record<string, unknown>;

interface NumberRule {
	min?: number;
	max?: number;
	/** The value must be greater than `min`, not equal to it. */
	exclusiveMin?: boolean;
	integer?: boolean;
}

function fail(path: string, message: string): never {
	throw new ConfigError(`${path}: ${message}`);
}

function object(value: unknown, path: string, allowed: readonly string[]): Obj {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return fail(path, 'must be an object');
	}
	const result = value as Obj;
	for (const key of Object.keys(result)) {
		if (!allowed.includes(key)) {
			return fail(path, `unknown key "${key}"`);
		}
	}
	return result;
}

function required(obj: Obj, key: string, path: string): unknown {
	if (!(key in obj)) {
		return fail(path, `missing key "${key}"`);
	}
	return obj[key];
}

function boolean(value: unknown, path: string): boolean {
	if (typeof value !== 'boolean') {
		return fail(path, 'must be true or false');
	}
	return value;
}

function text(value: unknown, path: string, pattern?: RegExp): string {
	if (typeof value !== 'string' || value.trim() === '') {
		return fail(path, 'must be a non-empty string');
	}
	if (pattern !== undefined && !pattern.test(value)) {
		return fail(path, `"${value}" has an invalid format`);
	}
	return value;
}

function number(value: unknown, path: string, rule: NumberRule): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return fail(path, 'must be a number');
	}
	if (rule.integer === true && !Number.isInteger(value)) {
		return fail(path, 'must be a whole number');
	}
	if (rule.min !== undefined) {
		const tooSmall =
			rule.exclusiveMin === true ? value <= rule.min : value < rule.min;
		if (tooSmall) {
			const word =
				rule.exclusiveMin === true ? 'greater than' : 'at least';
			return fail(path, `must be ${word} ${rule.min}`);
		}
	}
	if (rule.max !== undefined && value > rule.max) {
		return fail(path, `must be at most ${rule.max}`);
	}
	return value;
}

function oneOf<T extends string>(
	value: unknown,
	path: string,
	allowed: readonly T[]
): T {
	const found = allowed.find((item) => item === value);
	if (found === undefined) {
		return fail(path, `must be one of: ${allowed.join(', ')}`);
	}
	return found;
}

const PERCENT: NumberRule = { min: 0, exclusiveMin: true, max: 1000 };
const MINUTES: NumberRule = { min: 1, max: 10080, integer: true };
const PARAM_KEYS = [
	'window_minutes',
	'threshold_percent',
	'ref_tolerance_minutes',
] as const;

function alertParamsFields(
	obj: Obj,
	path: string,
	need: boolean
): Partial<AlertParams> {
	const result: Partial<AlertParams> = {};
	for (const key of PARAM_KEYS) {
		if (!(key in obj)) {
			if (need) {
				fail(path, `missing key "${key}"`);
			}
			continue;
		}
		const keyPath = `${path}.${key}`;
		if (key === 'window_minutes') {
			result[key] = number(obj[key], keyPath, MINUTES);
		} else if (key === 'threshold_percent') {
			result[key] = number(obj[key], keyPath, PERCENT);
		} else {
			result[key] = number(obj[key], keyPath, {
				min: 0,
				max: 10080,
				integer: true,
			});
		}
	}
	return result;
}

function alertParams(value: unknown, path: string): AlertParams {
	const obj = object(value, path, PARAM_KEYS);
	const fields = alertParamsFields(obj, path, true);
	return {
		window_minutes: fields.window_minutes as number,
		threshold_percent: fields.threshold_percent as number,
		ref_tolerance_minutes: fields.ref_tolerance_minutes as number,
	};
}

function checkTolerance(params: AlertParams, path: string): void {
	if (params.ref_tolerance_minutes >= params.window_minutes) {
		fail(path, 'ref_tolerance_minutes must be less than window_minutes');
	}
}

const ALERT_OPTION_KEYS = [
	'enabled',
	'direction',
	'cooldown_hours',
	'daily_issue_cap',
	'auto_close_hours',
	'move_1h',
	'move_24h',
] as const;

const COOLDOWN: NumberRule = { min: 0, max: 720 };
const DAILY_CAP: NumberRule = { min: 0, max: 100, integer: true };
const AUTO_CLOSE: NumberRule = { min: 0, exclusiveMin: true, max: 720 };

function alertDefaults(value: unknown, path: string): AlertDefaults {
	const obj = object(value, path, ALERT_OPTION_KEYS);
	const result: AlertDefaults = {
		enabled: boolean(required(obj, 'enabled', path), `${path}.enabled`),
		direction: oneOf(
			required(obj, 'direction', path),
			`${path}.direction`,
			DIRECTIONS
		),
		cooldown_hours: number(
			required(obj, 'cooldown_hours', path),
			`${path}.cooldown_hours`,
			COOLDOWN
		),
		daily_issue_cap: number(
			required(obj, 'daily_issue_cap', path),
			`${path}.daily_issue_cap`,
			DAILY_CAP
		),
		auto_close_hours: number(
			required(obj, 'auto_close_hours', path),
			`${path}.auto_close_hours`,
			AUTO_CLOSE
		),
		move_1h: alertParams(required(obj, 'move_1h', path), `${path}.move_1h`),
		move_24h: alertParams(
			required(obj, 'move_24h', path),
			`${path}.move_24h`
		),
	};
	checkTolerance(result.move_1h, `${path}.move_1h`);
	checkTolerance(result.move_24h, `${path}.move_24h`);
	return result;
}

function alertOverrides(
	value: unknown,
	path: string,
	defaults: AlertDefaults
): AlertOverrides {
	const obj = object(value, path, ALERT_OPTION_KEYS);
	const result: AlertOverrides = {};
	if ('enabled' in obj) {
		result.enabled = boolean(obj.enabled, `${path}.enabled`);
	}
	if ('direction' in obj) {
		result.direction = oneOf(
			obj.direction,
			`${path}.direction`,
			DIRECTIONS
		);
	}
	if ('cooldown_hours' in obj) {
		result.cooldown_hours = number(
			obj.cooldown_hours,
			`${path}.cooldown_hours`,
			COOLDOWN
		);
	}
	if ('daily_issue_cap' in obj) {
		result.daily_issue_cap = number(
			obj.daily_issue_cap,
			`${path}.daily_issue_cap`,
			DAILY_CAP
		);
	}
	if ('auto_close_hours' in obj) {
		result.auto_close_hours = number(
			obj.auto_close_hours,
			`${path}.auto_close_hours`,
			AUTO_CLOSE
		);
	}
	for (const rule of ['move_1h', 'move_24h'] as const) {
		if (!(rule in obj)) {
			continue;
		}
		const rulePath = `${path}.${rule}`;
		const partial = alertParamsFields(
			object(obj[rule], rulePath, PARAM_KEYS),
			rulePath,
			false
		);
		// The merged rule must stay valid, so a tolerance cannot outgrow a window
		checkTolerance({ ...defaults[rule], ...partial }, rulePath);
		result[rule] = partial;
	}
	return result;
}

function settings(value: unknown, path: string): Settings {
	const obj = object(value, path, [
		'quote',
		'stored_sources',
		'phase',
		'features',
		'min_spacing_seconds',
		'max_step_move_percent',
		'crosscheck_max_diff_percent',
		'publish_min_interval_minutes',
		'stale_warn_minutes',
		'stale_stop_minutes',
		'alert_defaults',
	]);

	const quote = required(obj, 'quote', path);
	if (quote !== 'USD') {
		fail(`${path}.quote`, 'must be "USD"');
	}

	const sourcesPath = `${path}.stored_sources`;
	const sourcesValue = required(obj, 'stored_sources', path);
	if (!Array.isArray(sourcesValue) || sourcesValue.length === 0) {
		fail(sourcesPath, 'must be a non-empty list');
	}
	const storedSources = (sourcesValue as unknown[]).map((item, index) =>
		oneOf(item, `${sourcesPath}[${index}]`, SOURCE_IDS)
	);
	if (new Set(storedSources).size !== storedSources.length) {
		fail(sourcesPath, 'must not repeat a source');
	}

	const featuresPath = `${path}.features`;
	const features = object(required(obj, 'features', path), featuresPath, [
		'alerts',
		'publish',
	]);

	const staleWarn = number(
		required(obj, 'stale_warn_minutes', path),
		`${path}.stale_warn_minutes`,
		MINUTES
	);
	const staleStop = number(
		required(obj, 'stale_stop_minutes', path),
		`${path}.stale_stop_minutes`,
		MINUTES
	);
	if (staleWarn >= staleStop) {
		fail(path, 'stale_warn_minutes must be less than stale_stop_minutes');
	}

	return {
		quote: 'USD',
		stored_sources: storedSources,
		phase: oneOf(required(obj, 'phase', path), `${path}.phase`, PHASES),
		features: {
			alerts: boolean(
				required(features, 'alerts', featuresPath),
				`${featuresPath}.alerts`
			),
			publish: boolean(
				required(features, 'publish', featuresPath),
				`${featuresPath}.publish`
			),
		},
		min_spacing_seconds: number(
			required(obj, 'min_spacing_seconds', path),
			`${path}.min_spacing_seconds`,
			{ min: 1, max: 3600, integer: true }
		),
		max_step_move_percent: number(
			required(obj, 'max_step_move_percent', path),
			`${path}.max_step_move_percent`,
			PERCENT
		),
		crosscheck_max_diff_percent: number(
			required(obj, 'crosscheck_max_diff_percent', path),
			`${path}.crosscheck_max_diff_percent`,
			PERCENT
		),
		publish_min_interval_minutes: number(
			required(obj, 'publish_min_interval_minutes', path),
			`${path}.publish_min_interval_minutes`,
			{ min: 1, max: 1440, integer: true }
		),
		stale_warn_minutes: staleWarn,
		stale_stop_minutes: staleStop,
		alert_defaults: alertDefaults(
			required(obj, 'alert_defaults', path),
			`${path}.alert_defaults`
		),
	};
}

function isRealDate(value: string): boolean {
	const match = DATE.exec(value);
	if (match === null) {
		return false;
	}
	const date = new Date(`${value}T00:00:00Z`);
	return (
		!Number.isNaN(date.getTime()) &&
		date.toISOString().slice(0, 10) === value
	);
}

function coinSources(value: unknown, path: string): CoinSources {
	const obj = object(value, path, SOURCE_KEYS);
	const result: CoinSources = {};
	for (const key of SOURCE_KEYS) {
		if (key in obj) {
			result[key] = text(obj[key], `${path}.${key}`, SOURCE_KEY);
		}
	}
	return result;
}

function coin(
	value: unknown,
	path: string,
	defaults: AlertDefaults
): CoinConfig {
	const obj = object(value, path, [
		'id',
		'name',
		'enabled',
		'added',
		'sources',
		'alerts',
		'note',
	]);
	const id = text(required(obj, 'id', path), `${path}.id`, COIN_ID);
	const added = text(required(obj, 'added', path), `${path}.added`);
	if (!isRealDate(added)) {
		fail(`${path}.added`, `"${added}" is not a date as YYYY-MM-DD`);
	}
	const result: CoinConfig = {
		id,
		name: text(required(obj, 'name', path), `${path}.name`),
		enabled: boolean(required(obj, 'enabled', path), `${path}.enabled`),
		added,
		sources: coinSources(required(obj, 'sources', path), `${path}.sources`),
	};
	if ('alerts' in obj) {
		result.alerts = alertOverrides(obj.alerts, `${path}.alerts`, defaults);
	}
	if ('note' in obj) {
		if (typeof obj.note !== 'string') {
			fail(`${path}.note`, 'must be a string');
		}
		result.note = obj.note;
	}
	return result;
}

function parseConfig(raw: unknown): Config {
	const root = object(raw, 'config', ['schema_version', 'settings', 'coins']);
	if (required(root, 'schema_version', 'config') !== 1) {
		fail('config.schema_version', 'must be 1');
	}
	const parsedSettings = settings(
		required(root, 'settings', 'config'),
		'config.settings'
	);

	const coinsValue = required(root, 'coins', 'config');
	if (!Array.isArray(coinsValue) || coinsValue.length === 0) {
		fail('config.coins', 'must be a non-empty list');
	}
	const coins = (coinsValue as unknown[]).map((item, index) =>
		coin(item, `config.coins[${index}]`, parsedSettings.alert_defaults)
	);

	const seen = new Set<string>();
	for (const item of coins) {
		if (seen.has(item.id)) {
			fail('config.coins', `duplicate coin id "${item.id}"`);
		}
		seen.add(item.id);
		if (!item.enabled) {
			continue;
		}
		for (const source of parsedSettings.stored_sources) {
			if (item.sources[SOURCE_FIELD[source]] === undefined) {
				fail(
					`config.coins[${item.id}].sources`,
					`enabled coin has no "${SOURCE_FIELD[source]}" but "${source}" is a stored source`
				);
			}
		}
	}

	return { schema_version: 1, settings: parsedSettings, coins };
}

/** Reads and checks the config file. Throws `ConfigError` with the path of the bad field. */
export async function loadConfig(path: string): Promise<Config> {
	let content: string;
	try {
		content = await readFile(path, 'utf8');
	} catch {
		throw new ConfigError(`Cannot read the config file: ${path}`);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(content);
	} catch {
		throw new ConfigError(`The config file is not valid JSON: ${path}`);
	}
	return parseConfig(raw);
}

/** Enabled coins that have an id for the source. */
export function enabledCoins(config: Config, source: SourceId): CoinConfig[] {
	const field = SOURCE_FIELD[source];
	return config.coins.filter(
		(item) => item.enabled && item.sources[field] !== undefined
	);
}
