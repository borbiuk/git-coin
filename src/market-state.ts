// state/market.json on the data branch: when the daily Coin Metrics metrics were last stored (ADR 0004 D8).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isoSeconds, parseIso } from './time.ts';

export interface MarketState {
	schema_version: 1;
	/** When the daily metrics were last stored. `null`: never. */
	daily_updated_at: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function emptyMarketState(): MarketState {
	return { schema_version: 1, daily_updated_at: null };
}

/**
 * Reads the file. A missing, broken or unexpected file counts as "never updated":
 * the market data must never stop the price rows.
 */
export async function readMarketState(file: string): Promise<MarketState> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(file, 'utf8'));
	} catch {
		return emptyMarketState();
	}
	if (typeof parsed !== 'object' || parsed === null) {
		return emptyMarketState();
	}
	const at = (parsed as { daily_updated_at?: unknown }).daily_updated_at;
	if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
		return emptyMarketState();
	}
	return { schema_version: 1, daily_updated_at: at };
}

export async function writeMarketState(
	file: string,
	state: MarketState
): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(state, null, '\t')}\n`, 'utf8');
}

/** True when 24 hours have passed since the daily metrics were stored, or they never were. */
export function dailyDue(state: MarketState, now: Date): boolean {
	if (state.daily_updated_at === null) {
		return true;
	}
	return now.getTime() - parseIso(state.daily_updated_at) >= DAY_MS;
}

/** The state after a successful daily update at `now`. */
export function dailyStored(now: Date): MarketState {
	return { schema_version: 1, daily_updated_at: isoSeconds(now) };
}
