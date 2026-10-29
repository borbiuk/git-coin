// A minimal config loader for the site builder CLI. It checks only the fields the builder uses.
// The full validation is `loadConfig` in src/config.ts (agent A1); the collector runs it before the publish job.
import { readFile } from 'node:fs/promises';

import { SRC_CODE } from '../types.ts';
import type { Config } from '../types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function readSiteConfig(path: string): Promise<Config> {
	const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
	if (!isRecord(parsed) || !isRecord(parsed.settings)) {
		throw new Error(`${path}: "settings" is missing.`);
	}
	const sources = parsed.settings.stored_sources;
	if (
		!Array.isArray(sources) ||
		sources.length === 0 ||
		!sources.every(
			(source) => typeof source === 'string' && source in SRC_CODE
		)
	) {
		throw new Error(`${path}: "settings.stored_sources" is not valid.`);
	}
	const coins = parsed.coins;
	if (
		!Array.isArray(coins) ||
		!coins.every(
			(coin) =>
				isRecord(coin) &&
				typeof coin.id === 'string' &&
				typeof coin.name === 'string' &&
				typeof coin.enabled === 'boolean'
		)
	) {
		throw new Error(`${path}: "coins" is not valid.`);
	}
	return parsed as unknown as Config;
}
