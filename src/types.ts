// Shared contract of the collector, the site builder and the tools (docs/implementation/plan.md, section 3.2).
// Types and constants only: no logic. Changes go through the orchestrator.

export type SourceId = 'kraken' | 'coinbase' | 'bitstamp' | 'coinmetrics';
export type SrcCode = 'kr' | 'cb' | 'bs' | 'cm' | 'kr-ohlc';
export const SRC_CODE = {
	kraken: 'kr',
	coinbase: 'cb',
	bitstamp: 'bs',
	coinmetrics: 'cm',
} as const;
export type Phase = 'test' | 'production';
export type ErrorCode =
	'timeout' | 'http_429' | 'http_other' | 'parse' | 'unmapped';
export type HttpErrorCode = Exclude<ErrorCode, 'unmapped'>;

// Config (ADR 0007, extended with `phase` and `features`)
export interface CoinSources {
	kraken_pair?: string;
	coinbase_product?: string;
	bitstamp_market?: string;
	coinmetrics_asset?: string;
	coingecko_id?: string;
}
export interface AlertParams {
	window_minutes: number;
	threshold_percent: number;
	ref_tolerance_minutes: number;
}
export interface AlertOverrides {
	enabled?: boolean;
	direction?: 'up' | 'down' | 'both';
	cooldown_hours?: number;
	daily_issue_cap?: number;
	auto_close_hours?: number;
	move_1h?: Partial<AlertParams>;
	move_24h?: Partial<AlertParams>;
}
export interface AlertDefaults {
	enabled: boolean;
	direction: 'up' | 'down' | 'both';
	cooldown_hours: number;
	daily_issue_cap: number;
	auto_close_hours: number;
	move_1h: AlertParams;
	move_24h: AlertParams;
}
export interface CoinConfig {
	id: string;
	name: string;
	/** A `rate` entry is not shown on the dashboard. Its USD price turns the other prices into its own unit (USDT). */
	role?: 'rate';
	enabled: boolean;
	added: string;
	sources: CoinSources;
	alerts?: AlertOverrides;
	note?: string;
}
export interface Settings {
	quote: 'USD';
	/** The first entry is the primary source for alerts and the site. */
	stored_sources: SourceId[];
	phase: Phase;
	features: { alerts: boolean; publish: boolean };
	min_spacing_seconds: number;
	max_step_move_percent: number;
	crosscheck_max_diff_percent: number;
	publish_min_interval_minutes: number;
	stale_warn_minutes: number;
	stale_stop_minutes: number;
	alert_defaults: AlertDefaults;
}
export interface Config {
	schema_version: 1;
	settings: Settings;
	coins: CoinConfig[];
}

// HTTP
export interface HttpRequest {
	url: string;
	headers?: Record<string, string>;
	timeoutMs?: number;
}
/** `status` is 0 when there was no response. */
export interface HttpResult {
	status: number;
	ms: number;
	json?: unknown;
	error?: HttpErrorCode;
}
export interface HttpClient {
	getJson(req: HttpRequest): Promise<HttpResult>;
}

// Rows
export interface PriceRow {
	ts: string;
	coin: string;
	price: string;
	src: SrcCode;
	age_s: number | null;
}
export interface PricePoint {
	ts: string;
	price: string;
	src: SrcCode;
	age_s: number | null;
}
export interface RequestLogRow {
	ts: string;
	src: SrcCode;
	http: number;
	ms: number;
	coins_ok: number;
	error: ErrorCode | '';
}
export interface SourceRun {
	src: SrcCode;
	rows: PriceRow[];
	log: RequestLogRow;
}
export interface SourceAdapter {
	readonly id: SourceId;
	readonly src: SrcCode;
	fetchPrices(
		coins: CoinConfig[],
		http: HttpClient,
		now: () => Date
	): Promise<SourceRun>;
}
/** Rows of one coin and one src, sorted by `ts`, `fromIso` inclusive, `toIso` exclusive. */
export interface SeriesReader {
	readSeries(
		coin: string,
		fromIso: string,
		toIso: string,
		src: SrcCode
	): Promise<PricePoint[]>;
}

// Status (state/status.json on the data branch)
export interface SourceStatus {
	requests: number;
	failures: number;
	failures_by_error: Partial<Record<ErrorCode, number>>;
	consecutive_failures: number;
	last_ok_at: string | null;
}
export interface CoinStatus {
	last_point_at: string | null;
	status: 'ok' | 'source_missing' | 'disabled';
	rejected_count: number;
	last_reject_reason: string | null;
}
export interface Status {
	schema_version: 1;
	phase: Phase;
	last_run_at: string | null;
	last_point_at: string | null;
	consecutive_failures: number;
	last_publish_at: string | null;
	sources: Partial<Record<SrcCode, SourceStatus>>;
	coins: Record<string, CoinStatus>;
}

// Derived JSON for the dashboard (ADR 0008 D2). `t` is epoch seconds. Prices are numbers.
export interface PeriodStats {
	change_pct: number | null;
	high: number | null;
	low: number | null;
}
export interface DerivedLatest {
	generated_at: string;
	/** The unit of every price in the derived files: the id of the rate entry (`USDT`) when the config has one, else `USD`. */
	quote: string;
	src: SrcCode;
	coins: Record<
		string,
		{
			name: string;
			price: number;
			ts: string;
			periods: Record<'24h' | '7d' | '30d', PeriodStats>;
		}
	>;
}
export interface DerivedStatus extends Status {
	generated_at: string;
}
export interface DerivedAlerts {
	generated_at: string;
	alerts: Array<{
		coin: string;
		ts: string;
		direction: 'up' | 'down';
		severity: 'high' | 'extreme';
		issue: number;
	}>;
}
/** Used by the 7 day and the 90 day files. */
export interface SeriesPoints {
	coin: string;
	src: SrcCode;
	t: number[];
	p: number[];
}
export interface SeriesDaily {
	coin: string;
	src: SrcCode;
	t: number[];
	o: number[];
	h: number[];
	l: number[];
	c: number[];
}
