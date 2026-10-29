// Shared helpers for the alert tests: a config builder, a fake series reader and a fake Issue client.

import type {
	IssueClient,
	IssueSummary,
	NewIssue,
} from '../../src/alerts/client.ts';
import type {
	CoinConfig,
	Config,
	PricePoint,
	SeriesReader,
	SrcCode,
} from '../../src/types.ts';

export const NOW = new Date('2026-10-29T14:00:00Z');

export function makeCoin(
	id: string,
	extra: Partial<CoinConfig> = {}
): CoinConfig {
	return {
		id,
		name: `${id} coin`,
		enabled: true,
		added: '2026-10-01',
		sources: {},
		...extra,
	};
}

export function makeConfig(
	coins: CoinConfig[],
	alertDefaults: Partial<Config['settings']['alert_defaults']> = {}
): Config {
	return {
		schema_version: 1,
		settings: {
			quote: 'USD',
			stored_sources: ['kraken', 'coinbase'],
			phase: 'production',
			features: { alerts: true, publish: true },
			min_spacing_seconds: 300,
			max_step_move_percent: 50,
			crosscheck_max_diff_percent: 2,
			publish_min_interval_minutes: 30,
			stale_warn_minutes: 120,
			stale_stop_minutes: 360,
			alert_defaults: {
				enabled: true,
				direction: 'both',
				cooldown_hours: 6,
				daily_issue_cap: 5,
				auto_close_hours: 24,
				move_1h: {
					window_minutes: 60,
					threshold_percent: 5,
					ref_tolerance_minutes: 30,
				},
				move_24h: {
					window_minutes: 1440,
					threshold_percent: 15,
					ref_tolerance_minutes: 120,
				},
				...alertDefaults,
			},
		},
		coins,
	};
}

export interface ReadCall {
	coin: string;
	from: string;
	to: string;
	src: SrcCode;
}

export interface FakeReader extends SeriesReader {
	calls: ReadCall[];
}

/** Rows per coin. Every row has the source `kr` unless the entry says otherwise. */
export function fakeReader(
	data: Record<string, Array<[string, string] | [string, string, SrcCode]>>
): FakeReader {
	const calls: ReadCall[] = [];
	return {
		calls,
		readSeries(coin, from, to, src) {
			calls.push({ coin, from, to, src });
			const rows = data[coin];
			if (rows === undefined) {
				return Promise.resolve([]);
			}
			const points: PricePoint[] = [];
			for (const [ts, price, rowSrc = 'kr'] of rows) {
				if (rowSrc === src && ts >= from && ts < to) {
					points.push({ ts, price, src: rowSrc, age_s: null });
				}
			}
			points.sort((a, b) => a.ts.localeCompare(b.ts));
			return Promise.resolve(points);
		},
	};
}

export function failingReader(message: string): SeriesReader {
	return {
		readSeries: () => Promise.reject(new Error(message)),
	};
}

export type ClientCall =
	| { op: 'list'; labels: string[] }
	| { op: 'create'; issue: NewIssue }
	| { op: 'comment'; issue: number; body: string }
	| { op: 'close'; issue: number };

export interface FakeIssue extends IssueSummary {
	labels: string[];
}

export interface FakeClient extends IssueClient {
	calls: ClientCall[];
	/** Open Issues. `listOpenIssues` returns those that carry all the asked labels. */
	open: FakeIssue[];
	/** The call kinds that should fail, for example `create`. */
	failOn: Set<ClientCall['op']>;
	nextNumber: number;
}

export function fakeClient(open: FakeIssue[] = []): FakeClient {
	const client: FakeClient = {
		calls: [],
		open,
		failOn: new Set(),
		nextNumber: 100,
		listOpenIssues(labels) {
			client.calls.push({ op: 'list', labels });
			if (client.failOn.has('list')) {
				return Promise.reject(new Error('list failed'));
			}
			return Promise.resolve(
				client.open
					.filter((item) =>
						labels.every((l) => item.labels.includes(l))
					)
					.map(({ number, title }) => ({ number, title }))
			);
		},
		createIssue(issue) {
			client.calls.push({ op: 'create', issue });
			if (client.failOn.has('create')) {
				return Promise.reject(new Error('create failed'));
			}
			const number = client.nextNumber++;
			client.open.push({
				number,
				title: issue.title,
				labels: issue.labels,
			});
			return Promise.resolve(number);
		},
		addComment(issue, body) {
			client.calls.push({ op: 'comment', issue, body });
			if (client.failOn.has('comment')) {
				return Promise.reject(new Error('comment failed'));
			}
			return Promise.resolve();
		},
		closeIssue(issue) {
			client.calls.push({ op: 'close', issue });
			if (client.failOn.has('close')) {
				return Promise.reject(new Error('close failed'));
			}
			client.open = client.open.filter((item) => item.number !== issue);
			return Promise.resolve();
		},
	};
	return client;
}
