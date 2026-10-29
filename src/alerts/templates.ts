// Issue text (ADR 0006 D5). Only numbers from our own validated data and our own labels go in.
// Exchange error strings and any other source text are never used here (ADR 0009).

import type { SourceId } from '../types.ts';

import type { Trigger } from './logic.ts';

export const OWNER_LOGIN = 'borbiuk';
export const NO_DATA_TITLE = '[collector] no data';
export const NO_DATA_LABEL = 'collector';
export const ALERT_LABEL = 'alert';

const SOURCE_LABELS: Record<SourceId, string> = {
	kraken: 'Kraken',
	coinbase: 'Coinbase Exchange',
	bitstamp: 'Bitstamp',
	coinmetrics: 'Coin Metrics',
};

export interface AlertText {
	coin: string;
	coinName: string;
	trigger: Trigger;
	source: SourceId;
	detectedAt: string;
	dashboardUrl: string;
}

/** Groups the integer part with commas and keeps at least two decimals: `81232.79000` gives `81,232.79`. */
export function formatPrice(price: string): string {
	const [whole = '', fraction = ''] = price.split('.');
	const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	let decimals = fraction.replace(/0+$/, '');
	while (decimals.length < 2) {
		decimals += '0';
	}
	return `${grouped}.${decimals}`;
}

export function formatPercent(value: number): string {
	return value.toFixed(1);
}

export function alertLabels(coin: string, trigger: Trigger): string[] {
	return [
		ALERT_LABEL,
		`coin:${coin}`,
		`dir:${trigger.direction}`,
		`window:${trigger.label}`,
		`severity:${trigger.severity}`,
	];
}

/** The labels that identify the alert key (coin and direction). Used to find the open Issue. */
export function keyLabels(coin: string, direction: string): string[] {
	return [ALERT_LABEL, `coin:${coin}`, `dir:${direction}`];
}

export function alertTitle(text: AlertText): string {
	const { trigger } = text;
	return `[ALERT] ${text.coin} ${trigger.direction} ${formatPercent(trigger.movePercent)}% in ${trigger.label} (${formatPrice(trigger.current.price)} USD)`;
}

export function alertBody(text: AlertText): string {
	const { trigger } = text;
	const lines = [
		`Coin: ${text.coin} (${text.coinName})`,
		`Direction: ${trigger.direction}`,
		`Window: ${trigger.label}`,
		`Threshold: ${trigger.thresholdPercent}%`,
		`Severity: ${trigger.severity}`,
		`Move: ${formatPercent(trigger.movePercent)}%`,
		'',
		`Reference: ${trigger.reference.ts} at ${formatPrice(trigger.reference.price)} USD`,
		`Current: ${trigger.current.ts} at ${formatPrice(trigger.current.price)} USD`,
		`Source: ${SOURCE_LABELS[text.source]}. Quote: USD.`,
		`Detected at: ${text.detectedAt} (UTC).`,
		'',
		'Detected at the time of the run. The move happened between the reference time and this time. Runs can be late.',
		'',
		`Dashboard: ${text.dashboardUrl}`,
		'',
		'Not financial advice. Data may be delayed or wrong.',
		'',
		`@${OWNER_LOGIN}`,
	];
	return lines.join('\n');
}

export function repeatComment(text: AlertText): string {
	const { trigger } = text;
	return `New trigger: ${text.coin} ${trigger.direction} ${formatPercent(trigger.movePercent)}% in ${trigger.label} (${formatPrice(trigger.current.price)} USD, ${trigger.severity}). Detected at ${text.detectedAt} (UTC).`;
}

export function autoCloseComment(hours: number): string {
	return `No new trigger in ${hours} hours. Closing.`;
}

export function noDataBody(): string {
	return [
		'The collector got no new price data in several runs in a row.',
		'Check the latest runs of the collect workflow.',
		'This Issue closes by itself when data comes in again.',
		'',
		`@${OWNER_LOGIN}`,
	].join('\n');
}

export function noDataClosedComment(): string {
	return 'Data is coming in again. Closing.';
}
