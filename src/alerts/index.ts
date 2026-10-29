// Alerts and Issue behaviour (ADR 0006). The collector calls `runAlerts` after it wrote rows,
// and `syncNoDataIssue` after it updated the status. Only `src/types.ts` and `src/time.ts` are shared.

import { isoSeconds, parseIso, utcDay } from '../time.ts';
import { SRC_CODE } from '../types.ts';
import type { CoinConfig, Config, SeriesReader } from '../types.ts';

import { createGitHubIssueClient } from './client.ts';
import type { IssueClient } from './client.ts';
import {
	directionAllowed,
	evaluateRule,
	resolveParams,
	toSamples,
} from './logic.ts';
import type { CoinAlertParams, Direction, Trigger } from './logic.ts';
import {
	RECENT_LIMIT,
	emptyKeyState,
	readAlertState,
	serializeAlertState,
	writeAlertState,
} from './state.ts';
import type { AlertState, KeyState } from './state.ts';
import {
	NO_DATA_LABEL,
	NO_DATA_TITLE,
	OWNER_LOGIN,
	alertBody,
	alertLabels,
	alertTitle,
	autoCloseComment,
	keyLabels,
	noDataBody,
	noDataClosedComment,
	repeatComment,
} from './templates.ts';
import type { AlertText } from './templates.ts';

export { createGitHubIssueClient };
export type { IssueClient };

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

export interface AlertContext {
	config: Config;
	/** Reads the rows of the primary source (`settings.stored_sources[0]`). */
	reader: SeriesReader;
	client: IssueClient;
	now: Date;
	/** Path of `state/alerts.json` in the data checkout. */
	statePath: string;
	/** The public dashboard address for the Issue text. */
	dashboardUrl: string;
	/** When true, no client call is made and no file is written. */
	dryRun: boolean;
}

export interface AlertAction {
	kind: 'create' | 'comment' | 'close' | 'suppress' | 'cooldown';
	key: string;
	/** The Issue number, or null when there is none (cooldown, suppress, dry run create). */
	issue: number | null;
}

export interface AlertSummary {
	/** Coins that were checked (enabled coins). */
	checked: number;
	created: number;
	commented: number;
	closed: number;
	suppressed: number;
	/** Short messages about failed reads and failed API calls. A failure never stops the run. */
	errors: string[];
	actions: AlertAction[];
}

interface Io {
	findOpen(labels: string[], known: number | null): Promise<number | null>;
	create(
		trigger: Trigger,
		text: AlertText,
		labels: string[]
	): Promise<number | null>;
	comment(issue: number, body: string): Promise<void>;
	close(issue: number): Promise<void>;
}

function createIo(client: IssueClient, dryRun: boolean): Io {
	if (dryRun) {
		return {
			findOpen: (_labels, known) => Promise.resolve(known),
			create: () => Promise.resolve(null),
			comment: () => Promise.resolve(),
			close: () => Promise.resolve(),
		};
	}
	return {
		async findOpen(labels, known) {
			const open = await client.listOpenIssues(labels);
			if (open.length === 0) {
				return null;
			}
			if (known !== null && open.some((item) => item.number === known)) {
				return known;
			}
			return Math.min(...open.map((item) => item.number));
		},
		create: (_trigger, text, labels) =>
			client.createIssue({
				title: alertTitle(text),
				body: alertBody(text),
				labels,
				assignees: [OWNER_LOGIN],
			}),
		comment: (issue, body) => client.addComment(issue, body),
		close: (issue) => client.closeIssue(issue),
	};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : 'unknown error';
}

function latestOf(entry: KeyState): number | null {
	let latest: number | null = null;
	for (const value of [
		entry.last_alert_at,
		entry.last_comment_at,
		entry.last_suppressed_at,
	]) {
		if (value !== null) {
			const ms = parseIso(value);
			latest = latest === null || ms > latest ? ms : latest;
		}
	}
	return latest;
}

function pushRecent(
	state: AlertState,
	coin: string,
	nowIso: string,
	trigger: Trigger,
	issue: number | null,
	suppressed: boolean
): void {
	state.recent.push({
		coin,
		ts: nowIso,
		direction: trigger.direction,
		window: trigger.label,
		severity: trigger.severity,
		issue,
		suppressed,
	});
	if (state.recent.length > RECENT_LIMIT) {
		state.recent.splice(0, state.recent.length - RECENT_LIMIT);
	}
}

/** Picks one trigger per direction: the one that is furthest above its threshold. */
function bestTriggers(triggers: Trigger[]): Trigger[] {
	const best = new Map<Direction, Trigger>();
	for (const trigger of triggers) {
		const held = best.get(trigger.direction);
		if (
			held === undefined ||
			trigger.movePercent / trigger.thresholdPercent >
				held.movePercent / held.thresholdPercent
		) {
			best.set(trigger.direction, trigger);
		}
	}
	return [...best.values()];
}

async function handleTrigger(
	ctx: AlertContext,
	io: Io,
	state: AlertState,
	summary: AlertSummary,
	coin: CoinConfig,
	params: CoinAlertParams,
	trigger: Trigger
): Promise<void> {
	const nowMs = ctx.now.getTime();
	const nowIso = isoSeconds(ctx.now);
	const key = `${coin.id}:${trigger.direction}`;
	const today = utcDay(nowIso);
	if (state.daily.day !== today) {
		state.daily = { day: today, created: 0, suppressed: 0 };
	}
	const before = state.keys[key];
	const entry: KeyState = { ...(before ?? emptyKeyState()) };
	if (entry.issue !== null) {
		// Any trigger keeps an open Issue alive for the auto-close rule.
		entry.last_trigger_at = nowIso;
	}
	const latest = latestOf(entry);
	if (latest !== null && nowMs - latest < params.cooldownHours * HOUR_MS) {
		state.keys[key] = entry;
		summary.actions.push({ kind: 'cooldown', key, issue: entry.issue });
		return;
	}
	const primary = ctx.config.settings.stored_sources[0];
	if (primary === undefined) {
		return;
	}
	const text: AlertText = {
		coin: coin.id,
		coinName: coin.name,
		trigger,
		source: primary,
		detectedAt: nowIso,
		dashboardUrl: ctx.dashboardUrl,
	};
	try {
		const open = await io.findOpen(
			keyLabels(coin.id, trigger.direction),
			entry.issue
		);
		if (open !== null) {
			await io.comment(open, repeatComment(text));
			entry.issue = open;
			entry.last_comment_at = nowIso;
			entry.last_trigger_at = nowIso;
			summary.commented++;
			summary.actions.push({ kind: 'comment', key, issue: open });
		} else if (state.daily.created >= params.dailyIssueCap) {
			entry.issue = null;
			entry.last_suppressed_at = nowIso;
			state.daily.suppressed++;
			pushRecent(state, coin.id, nowIso, trigger, null, true);
			summary.suppressed++;
			summary.actions.push({ kind: 'suppress', key, issue: null });
		} else {
			const created = await io.create(
				trigger,
				text,
				alertLabels(coin.id, trigger)
			);
			entry.issue = created;
			entry.last_alert_at = nowIso;
			entry.last_trigger_at = nowIso;
			state.daily.created++;
			pushRecent(state, coin.id, nowIso, trigger, created, false);
			summary.created++;
			summary.actions.push({ kind: 'create', key, issue: created });
		}
		state.keys[key] = entry;
	} catch (error) {
		summary.errors.push(`${key}: ${errorText(error)}`);
		if (before !== undefined) {
			state.keys[key] = {
				...before,
				last_trigger_at: entry.last_trigger_at,
			};
		}
	}
}

async function autoClose(
	ctx: AlertContext,
	io: Io,
	state: AlertState,
	summary: AlertSummary
): Promise<void> {
	const nowMs = ctx.now.getTime();
	const nowIso = isoSeconds(ctx.now);
	const defaults = ctx.config.settings.alert_defaults;
	for (const key of Object.keys(state.keys).sort()) {
		const entry = state.keys[key] as KeyState;
		if (entry.issue === null) {
			continue;
		}
		const coinId = key.slice(0, key.lastIndexOf(':'));
		const coin = ctx.config.coins.find((item) => item.id === coinId);
		const hours =
			coin === undefined
				? defaults.auto_close_hours
				: resolveParams(coin, defaults).autoCloseHours;
		const lastTrigger = entry.last_trigger_at ?? entry.last_alert_at;
		if (lastTrigger === null) {
			entry.last_trigger_at = nowIso;
			continue;
		}
		if (nowMs - parseIso(lastTrigger) < hours * HOUR_MS) {
			continue;
		}
		try {
			await io.comment(entry.issue, autoCloseComment(hours));
			await io.close(entry.issue);
			summary.actions.push({ kind: 'close', key, issue: entry.issue });
			entry.issue = null;
			summary.closed++;
		} catch (error) {
			summary.errors.push(`${key}: ${errorText(error)}`);
		}
	}
}

/**
 * Checks every enabled coin against the 1 hour and 24 hour rules, opens or updates Issues, closes
 * quiet ones and saves `state/alerts.json`. A failed API call is reported in `errors`, and the
 * state of that key stays as it was so the next run tries again. A broken state file throws.
 */
export async function runAlerts(ctx: AlertContext): Promise<AlertSummary> {
	const summary: AlertSummary = {
		checked: 0,
		created: 0,
		commented: 0,
		closed: 0,
		suppressed: 0,
		errors: [],
		actions: [],
	};
	const settings = ctx.config.settings;
	const primary = settings.stored_sources[0];
	if (primary === undefined) {
		throw new Error('settings.stored_sources is empty');
	}
	const src = SRC_CODE[primary];
	const nowMs = ctx.now.getTime();
	const original = await readAlertState(ctx.statePath);
	const state = structuredClone(original);
	const io = createIo(ctx.client, ctx.dryRun);

	for (const coin of ctx.config.coins) {
		const params = resolveParams(coin, settings.alert_defaults);
		if (!params.enabled) {
			continue;
		}
		summary.checked++;
		const reach = Math.max(
			...params.rules.map(
				(rule) => rule.windowMinutes + rule.refToleranceMinutes
			)
		);
		let samples;
		try {
			const points = await ctx.reader.readSeries(
				coin.id,
				isoSeconds(new Date(nowMs - reach * MINUTE_MS)),
				isoSeconds(new Date(nowMs + 1000)),
				src
			);
			samples = toSamples(points);
		} catch (error) {
			summary.errors.push(`${coin.id}: read failed: ${errorText(error)}`);
			continue;
		}
		const triggers: Trigger[] = [];
		for (const rule of params.rules) {
			const trigger = evaluateRule(samples, nowMs, rule);
			if (
				trigger !== null &&
				directionAllowed(params.direction, trigger.direction)
			) {
				triggers.push(trigger);
			}
		}
		for (const trigger of bestTriggers(triggers)) {
			await handleTrigger(ctx, io, state, summary, coin, params, trigger);
		}
	}

	await autoClose(ctx, io, state, summary);

	if (
		!ctx.dryRun &&
		serializeAlertState(state) !== serializeAlertState(original)
	) {
		await writeAlertState(ctx.statePath, state);
	}
	return summary;
}

/**
 * Keeps one `[collector] no data` Issue in step with `needed`: opens it when it is needed and none
 * is open, closes it when it is not needed any more. Does nothing in a dry run.
 * A client failure is thrown to the caller.
 */
export async function syncNoDataIssue(
	client: IssueClient,
	needed: boolean,
	dryRun: boolean
): Promise<void> {
	if (dryRun) {
		return;
	}
	const open = (await client.listOpenIssues([NO_DATA_LABEL])).filter(
		(item) => item.title === NO_DATA_TITLE
	);
	if (needed && open.length === 0) {
		await client.createIssue({
			title: NO_DATA_TITLE,
			body: noDataBody(),
			labels: [NO_DATA_LABEL],
			assignees: [OWNER_LOGIN],
		});
		return;
	}
	if (!needed) {
		for (const item of open) {
			await client.addComment(item.number, noDataClosedComment());
			await client.closeIssue(item.number);
		}
	}
}
