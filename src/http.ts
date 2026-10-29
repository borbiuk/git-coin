// HTTP client for the source adapters (ADR 0005 D5, ADR 0002 decision point 6).
// One timeout per attempt, at most one retry, a size cap, and no logging of bodies.

import { setTimeout as sleep } from 'node:timers/promises';

import type {
	HttpClient,
	HttpErrorCode,
	HttpRequest,
	HttpResult,
} from './types.ts';

const DEFAULT_USER_AGENT = 'git-coin (+https://github.com/borbiuk/git-coin)';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 2000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

interface HttpClientOptions {
	userAgent?: string;
	fetchImpl?: typeof fetch;
	retryDelayMs?: number;
}

interface Attempt {
	status: number;
	json?: unknown;
	error?: HttpErrorCode;
	retry: boolean;
}

class BodyTooLargeError extends Error {}

function isTimeout(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === 'TimeoutError' || error.name === 'AbortError')
	);
}

// Reads the body as text and stops as soon as it is larger than the cap
async function readCappedText(response: Response): Promise<string> {
	const length = Number(response.headers.get('content-length'));
	if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
		await response.body?.cancel();
		throw new BodyTooLargeError();
	}
	if (response.body === null) {
		return '';
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		total += value.byteLength;
		if (total > MAX_BODY_BYTES) {
			await reader.cancel();
			throw new BodyTooLargeError();
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString('utf8');
}

async function attemptOnce(
	fetchImpl: typeof fetch,
	req: HttpRequest,
	userAgent: string
): Promise<Attempt> {
	let status = 0;
	try {
		const response = await fetchImpl(req.url, {
			headers: {
				accept: 'application/json',
				'user-agent': userAgent,
				...req.headers,
			},
			signal: AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		});
		status = response.status;
		if (status === 429) {
			await response.body?.cancel();
			return { status, error: 'http_429', retry: false };
		}
		if (status < 200 || status >= 300) {
			await response.body?.cancel();
			return { status, error: 'http_other', retry: status >= 500 };
		}
		const text = await readCappedText(response);
		try {
			return { status, json: JSON.parse(text) as unknown, retry: false };
		} catch {
			return { status, error: 'parse', retry: false };
		}
	} catch (error) {
		if (error instanceof BodyTooLargeError) {
			return { status, error: 'parse', retry: false };
		}
		if (isTimeout(error)) {
			return { status: 0, error: 'timeout', retry: true };
		}
		// Network error (DNS, refused, reset): no response at all
		return { status: 0, error: 'http_other', retry: true };
	}
}

export function createHttpClient(opts: HttpClientOptions = {}): HttpClient {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
	const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

	return {
		async getJson(req: HttpRequest): Promise<HttpResult> {
			const started = performance.now();
			let attempt = await attemptOnce(fetchImpl, req, userAgent);
			if (attempt.retry) {
				await sleep(retryDelayMs);
				attempt = await attemptOnce(fetchImpl, req, userAgent);
			}
			const result: HttpResult = {
				status: attempt.status,
				ms: Math.round(performance.now() - started),
			};
			if (attempt.error !== undefined) {
				result.error = attempt.error;
			} else {
				result.json = attempt.json;
			}
			return result;
		},
	};
}
