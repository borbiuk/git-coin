import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { createHttpClient } from '../src/http.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, hit: number) => void;

interface TestServer {
	url: string;
	hits: () => number;
	headers: () => Array<IncomingMessage['headers']>;
	close: () => Promise<void>;
}

async function startServer(handler: Handler): Promise<TestServer> {
	let hits = 0;
	const seen: Array<IncomingMessage['headers']> = [];
	const server = createServer((req, res) => {
		hits += 1;
		seen.push(req.headers);
		handler(req, res, hits);
	});
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/`,
		hits: () => hits,
		headers: () => seen,
		close: async () => {
			// Stalled responses would keep close() waiting
			server.closeAllConnections();
			await new Promise<void>((resolve) => {
				server.close(() => {
					resolve();
				});
			});
		},
	};
}

// A request that the client gave up on may reach the handler after getJson returns
async function waitForHits(
	server: TestServer,
	expected: number
): Promise<void> {
	const deadline = Date.now() + 5000;
	while (server.hits() < expected && Date.now() < deadline) {
		await sleep(10);
	}
}

function sendJson(res: ServerResponse, status: number, body: string): void {
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(body);
}

test('200 with JSON returns status, json and the elapsed time', async () => {
	const server = await startServer((_req, res) => {
		sendJson(res, 200, '{"price":"100.00"}');
	});
	try {
		const result = await createHttpClient().getJson({ url: server.url });
		assert.equal(result.status, 200);
		assert.deepEqual(result.json, { price: '100.00' });
		assert.equal(result.error, undefined);
		assert.ok(Number.isInteger(result.ms) && result.ms >= 0);
		assert.equal(server.hits(), 1);
	} finally {
		await server.close();
	}
});

test('sends the default User-Agent and accept header', async () => {
	const server = await startServer((_req, res) => {
		sendJson(res, 200, '{}');
	});
	try {
		await createHttpClient().getJson({ url: server.url });
		const headers = server.headers()[0];
		assert.equal(
			headers?.['user-agent'],
			'git-coin (+https://github.com/borbiuk/git-coin)'
		);
		assert.equal(headers?.accept, 'application/json');
	} finally {
		await server.close();
	}
});

test('a custom User-Agent and request headers are sent', async () => {
	const server = await startServer((_req, res) => {
		sendJson(res, 200, '{}');
	});
	try {
		const client = createHttpClient({ userAgent: 'test-agent/1' });
		await client.getJson({
			url: server.url,
			headers: { 'x-test': 'yes' },
		});
		const headers = server.headers()[0];
		assert.equal(headers?.['user-agent'], 'test-agent/1');
		assert.equal(headers?.['x-test'], 'yes');
	} finally {
		await server.close();
	}
});

test('429 returns http_429 at once and is never retried', async () => {
	const server = await startServer((_req, res) => {
		sendJson(res, 429, '{"error":"slow down"}');
	});
	try {
		const result = await createHttpClient({ retryDelayMs: 0 }).getJson({
			url: server.url,
		});
		assert.equal(result.status, 429);
		assert.equal(result.error, 'http_429');
		assert.equal(result.json, undefined);
		assert.equal(server.hits(), 1);
	} finally {
		await server.close();
	}
});

test('500 then 200 retries once and returns the second answer', async () => {
	const server = await startServer((_req, res, hit) => {
		if (hit === 1) {
			sendJson(res, 500, '{"error":"boom"}');
			return;
		}
		sendJson(res, 200, '{"ok":true}');
	});
	try {
		const result = await createHttpClient({ retryDelayMs: 0 }).getJson({
			url: server.url,
		});
		assert.equal(result.status, 200);
		assert.deepEqual(result.json, { ok: true });
		assert.equal(result.error, undefined);
		assert.equal(server.hits(), 2);
	} finally {
		await server.close();
	}
});

test('500 twice gives http_other after exactly one retry', async () => {
	const server = await startServer((_req, res) => {
		sendJson(res, 503, '{}');
	});
	try {
		const result = await createHttpClient({ retryDelayMs: 0 }).getJson({
			url: server.url,
		});
		assert.equal(result.status, 503);
		assert.equal(result.error, 'http_other');
		assert.equal(server.hits(), 2);
	} finally {
		await server.close();
	}
});

test('a 4xx other than 429 gives http_other and is not retried', async () => {
	const server = await startServer((_req, res) => {
		sendJson(res, 404, '{}');
	});
	try {
		const result = await createHttpClient({ retryDelayMs: 0 }).getJson({
			url: server.url,
		});
		assert.equal(result.status, 404);
		assert.equal(result.error, 'http_other');
		assert.equal(server.hits(), 1);
	} finally {
		await server.close();
	}
});

test('a response that never comes gives timeout after one retry', async () => {
	const server = await startServer(() => {
		// No answer at all
	});
	try {
		const result = await createHttpClient({ retryDelayMs: 0 }).getJson({
			url: server.url,
			timeoutMs: 100,
		});
		assert.equal(result.status, 0);
		assert.equal(result.error, 'timeout');
		await waitForHits(server, 2);
		assert.equal(server.hits(), 2);
		assert.ok(result.ms >= 150, `ms was ${result.ms}`);
	} finally {
		await server.close();
	}
});

test('a body that stalls after the headers also times out', async () => {
	const server = await startServer((_req, res) => {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.write('{"price":');
	});
	try {
		const result = await createHttpClient({ retryDelayMs: 0 }).getJson({
			url: server.url,
			timeoutMs: 100,
		});
		assert.equal(result.status, 0);
		assert.equal(result.error, 'timeout');
		await waitForHits(server, 2);
		assert.equal(server.hits(), 2);
	} finally {
		await server.close();
	}
});

test('a timeout on the first try and 200 on the second returns the data', async () => {
	const server = await startServer((_req, res, hit) => {
		if (hit === 1) {
			// Stay silent so the first try times out; the second try has a generous limit
			return;
		}
		sendJson(res, 200, '{"ok":true}');
	});
	try {
		const result = await createHttpClient({ retryDelayMs: 0 }).getJson({
			url: server.url,
			timeoutMs: 400,
		});
		assert.equal(result.status, 200);
		assert.deepEqual(result.json, { ok: true });
		assert.equal(server.hits(), 2);
	} finally {
		await server.close();
	}
});

test('ms covers the whole call, including the retry delay', async () => {
	const server = await startServer((_req, res, hit) => {
		if (hit === 1) {
			sendJson(res, 500, '{}');
			return;
		}
		sendJson(res, 200, '{}');
	});
	try {
		const result = await createHttpClient({ retryDelayMs: 150 }).getJson({
			url: server.url,
		});
		assert.equal(result.status, 200);
		assert.ok(result.ms >= 140, `ms was ${result.ms}`);
	} finally {
		await server.close();
	}
});

test('invalid JSON gives parse with the HTTP status and no retry', async () => {
	const server = await startServer((_req, res) => {
		sendJson(res, 200, '<html>not json</html>');
	});
	try {
		const result = await createHttpClient({ retryDelayMs: 0 }).getJson({
			url: server.url,
		});
		assert.equal(result.status, 200);
		assert.equal(result.error, 'parse');
		assert.equal(result.json, undefined);
		assert.equal(server.hits(), 1);
	} finally {
		await server.close();
	}
});

test('an empty 200 body gives parse', async () => {
	const server = await startServer((_req, res) => {
		res.writeHead(200);
		res.end();
	});
	try {
		const result = await createHttpClient({ retryDelayMs: 0 }).getJson({
			url: server.url,
		});
		assert.equal(result.status, 200);
		assert.equal(result.error, 'parse');
	} finally {
		await server.close();
	}
});

test('a body above 5 MB with a content-length gives parse', async () => {
	const server = await startServer((_req, res) => {
		sendJson(
			res,
			200,
			JSON.stringify({ big: 'x'.repeat(6 * 1024 * 1024) })
		);
	});
	try {
		const result = await createHttpClient({ retryDelayMs: 0 }).getJson({
			url: server.url,
		});
		assert.equal(result.status, 200);
		assert.equal(result.error, 'parse');
		assert.equal(result.json, undefined);
		assert.equal(server.hits(), 1);
	} finally {
		await server.close();
	}
});

test('a chunked body above 5 MB is cut off and gives parse', async () => {
	const server = await startServer((_req, res) => {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.write('{"big":"');
		const chunk = 'x'.repeat(1024 * 1024);
		for (let index = 0; index < 6; index += 1) {
			res.write(chunk);
		}
		res.end('"}');
	});
	try {
		const result = await createHttpClient({ retryDelayMs: 0 }).getJson({
			url: server.url,
		});
		assert.equal(result.status, 200);
		assert.equal(result.error, 'parse');
		assert.equal(server.hits(), 1);
	} finally {
		await server.close();
	}
});

test('a body just under the cap still parses', async () => {
	const server = await startServer((_req, res) => {
		sendJson(
			res,
			200,
			JSON.stringify({ big: 'x'.repeat(4 * 1024 * 1024) })
		);
	});
	try {
		const result = await createHttpClient({ retryDelayMs: 0 }).getJson({
			url: server.url,
		});
		assert.equal(result.status, 200);
		assert.equal(result.error, undefined);
	} finally {
		await server.close();
	}
});

test('a refused connection gives status 0 and http_other after one retry', async () => {
	// Take a free port, then close the server so nothing listens there
	const server = await startServer(() => {});
	const url = server.url;
	await server.close();
	const result = await createHttpClient({ retryDelayMs: 0 }).getJson({
		url,
		timeoutMs: 2000,
	});
	assert.equal(result.status, 0);
	assert.equal(result.error, 'http_other');
});

test('a network error from fetch is retried once with the injected fetch', async () => {
	let calls = 0;
	const fetchImpl = (() => {
		calls += 1;
		if (calls === 1) {
			return Promise.reject(new TypeError('fetch failed'));
		}
		return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
	}) as typeof fetch;
	const result = await createHttpClient({
		fetchImpl,
		retryDelayMs: 0,
	}).getJson({ url: 'http://127.0.0.1:1/' });
	assert.equal(calls, 2);
	assert.equal(result.status, 200);
	assert.deepEqual(result.json, { ok: true });
});

test('the injected fetch gets an abort signal for the timeout', async () => {
	let signal: AbortSignal | null | undefined;
	const fetchImpl = ((_url: string, init?: RequestInit) => {
		signal = init?.signal;
		return Promise.resolve(new Response('{}', { status: 200 }));
	}) as typeof fetch;
	await createHttpClient({ fetchImpl }).getJson({
		url: 'http://127.0.0.1:1/',
		timeoutMs: 5000,
	});
	assert.ok(signal instanceof AbortSignal);
	assert.equal(signal.aborted, false);
});
