// The Issue client: an interface for the logic and a real implementation over `fetch` (ADR 0006 D4).
// Errors carry the HTTP method, a fixed path name and the status only. Response bodies are never copied.

export interface IssueSummary {
	number: number;
	title: string;
}

export interface NewIssue {
	title: string;
	body: string;
	labels: string[];
	assignees: string[];
}

export interface IssueClient {
	/** Open Issues that carry all the given labels. Pull requests are not included. */
	listOpenIssues(labels: string[]): Promise<IssueSummary[]>;
	/** Creates the Issue (and any missing label) and returns its number. */
	createIssue(issue: NewIssue): Promise<number>;
	addComment(issue: number, body: string): Promise<void>;
	closeIssue(issue: number): Promise<void>;
}

const DEFAULT_API_URL = 'https://api.github.com';
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const USER_AGENT = 'git-coin (+https://github.com/borbiuk/git-coin)';
const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

const LABEL_COLORS: Record<string, string> = {
	alert: 'd93f0b',
	coin: '0e8a16',
	dir: '1d76db',
	window: '5319e7',
	severity: 'fbca04',
	collector: 'b60205',
};

interface ClientSettings {
	apiUrl: string;
	repository: string;
	token: string;
}

function readSettings(env: NodeJS.ProcessEnv): ClientSettings {
	const token = env.GITHUB_TOKEN;
	if (token === undefined || token === '') {
		throw new Error('GITHUB_TOKEN is not set');
	}
	const repository = env.GITHUB_REPOSITORY;
	if (repository === undefined || !REPOSITORY_PATTERN.test(repository)) {
		throw new Error('GITHUB_REPOSITORY is not set or not owner/name');
	}
	const apiUrl = (env.GITHUB_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, '');
	const url = new URL(apiUrl);
	const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
	// The token must never go over plain HTTP, except to a local test server.
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
		throw new Error('GITHUB_API_URL must be an https URL');
	}
	return { apiUrl, repository, token };
}

function labelOptions(name: string): { color: string; description: string } {
	const prefix = name.includes(':') ? name.slice(0, name.indexOf(':')) : name;
	return {
		color: LABEL_COLORS[prefix] ?? 'ededed',
		description: 'Created by git-coin',
	};
}

export function createGitHubIssueClient(env: NodeJS.ProcessEnv): IssueClient {
	const knownLabels = new Set<string>();

	async function request(
		method: string,
		path: string,
		name: string,
		body?: unknown
	): Promise<{ status: number; json: unknown }> {
		const settings = readSettings(env);
		const response = await fetch(
			`${settings.apiUrl}/repos/${settings.repository}${path}`,
			{
				method,
				headers: {
					Authorization: `Bearer ${settings.token}`,
					Accept: 'application/vnd.github+json',
					'X-GitHub-Api-Version': '2022-11-28',
					'User-Agent': USER_AGENT,
					...(body === undefined
						? {}
						: { 'Content-Type': 'application/json' }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			}
		);
		const json: unknown = await response.json().catch(() => null);
		if (
			!response.ok &&
			response.status !== 404 &&
			response.status !== 422
		) {
			throw new Error(
				`GitHub API ${method} ${name} failed with status ${response.status}`
			);
		}
		return { status: response.status, json };
	}

	function fail(method: string, name: string, status: number): Error {
		return new Error(
			`GitHub API ${method} ${name} failed with status ${status}`
		);
	}

	async function ensureLabel(name: string): Promise<void> {
		if (knownLabels.has(name)) {
			return;
		}
		const found = await request(
			'GET',
			`/labels/${encodeURIComponent(name)}`,
			'label'
		);
		if (found.status === 404) {
			const { color, description } = labelOptions(name);
			const created = await request('POST', '/labels', 'label', {
				name,
				color,
				description,
			});
			// 422 means another run made the label first. That is fine.
			if (created.status !== 201 && created.status !== 422) {
				throw fail('POST', 'label', created.status);
			}
		} else if (found.status !== 200) {
			throw fail('GET', 'label', found.status);
		}
		knownLabels.add(name);
	}

	return {
		async listOpenIssues(labels) {
			const found: IssueSummary[] = [];
			for (let page = 1; page <= MAX_PAGES; page++) {
				const query = `state=open&labels=${encodeURIComponent(labels.join(','))}&per_page=${PAGE_SIZE}&page=${page}`;
				const result = await request(
					'GET',
					`/issues?${query}`,
					'issues'
				);
				if (result.status !== 200 || !Array.isArray(result.json)) {
					throw fail('GET', 'issues', result.status);
				}
				for (const item of result.json as unknown[]) {
					if (
						typeof item !== 'object' ||
						item === null ||
						'pull_request' in item
					) {
						continue;
					}
					const { number, title } = item as {
						number?: unknown;
						title?: unknown;
					};
					if (
						typeof number === 'number' &&
						typeof title === 'string'
					) {
						found.push({ number, title });
					}
				}
				if (result.json.length < PAGE_SIZE) {
					break;
				}
			}
			return found;
		},

		async createIssue(issue) {
			for (const label of issue.labels) {
				await ensureLabel(label);
			}
			const result = await request('POST', '/issues', 'issues', {
				title: issue.title,
				body: issue.body,
				labels: issue.labels,
				assignees: issue.assignees,
			});
			const number = (result.json as { number?: unknown } | null)?.number;
			if (result.status !== 201 || typeof number !== 'number') {
				throw fail('POST', 'issues', result.status);
			}
			return number;
		},

		async addComment(issue, body) {
			const result = await request(
				'POST',
				`/issues/${issue}/comments`,
				'comment',
				{ body }
			);
			if (result.status !== 201) {
				throw fail('POST', 'comment', result.status);
			}
		},

		async closeIssue(issue) {
			const result = await request('PATCH', `/issues/${issue}`, 'issue', {
				state: 'closed',
				state_reason: 'completed',
			});
			if (result.status !== 200) {
				throw fail('PATCH', 'issue', result.status);
			}
		},
	};
}
