// The adapter of every source, by `SourceId`. The collector picks the ones named in `settings.stored_sources`.

import type { SourceAdapter, SourceId } from '../types.ts';

import { bitstampAdapter } from './bitstamp.ts';
import { coinbaseAdapter } from './coinbase.ts';
import { coinmetricsAdapter } from './coinmetrics.ts';
import { krakenAdapter } from './kraken.ts';

export const ADAPTERS: Record<SourceId, SourceAdapter> = {
	kraken: krakenAdapter,
	coinbase: coinbaseAdapter,
	bitstamp: bitstampAdapter,
	coinmetrics: coinmetricsAdapter,
};
