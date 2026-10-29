import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { runCli } from '../../src/collect.ts';

import {
	assertInSync,
	cleanUpWorlds,
	git,
	makeWorld,
	remoteCount,
	remoteLog,
	remoteShow,
	remoteFiles,
	remoteTip,
} from './harness.ts';

cleanUpWorlds();

const REPO = join(import.meta.dirname, '..', '..');
const WORKFLOWS = join(REPO, '.github', 'workflows');
const TOKEN = 'ghs_FAKE_TOKEN_9a8b7c';

function workflow(name: string): string {
	return readFileSync(join(WORKFLOWS, name), 'utf8');
}

/** The lines of one job of a workflow file (jobs are indented by 4 spaces). */
function job(text: string, name: string): string {
	const lines = text.split('\n');
	const start = lines.findIndex((line) => line === `    ${name}:`);
	assert.notEqual(start, -1, `job ${name}`);
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index += 1) {
		if (/^ {4}\S/.test(lines[index] ?? '')) {
			end = index;
			break;
		}
	}
	return lines.slice(start, end).join('\n');
}

/** The `key: value` lines under a `permissions:` key of a job (8 spaces) or of the file (0 spaces). */
function permissionsOf(text: string, indent: number): string[] {
	const lines = text.split('\n');
	const pad = ' '.repeat(indent);
	const start = lines.findIndex((line) =>
		line.startsWith(`${pad}permissions:`)
	);
	assert.notEqual(start, -1, 'permissions key');
	const first = lines[start] ?? '';
	if (!first.endsWith(':')) {
		return [first.trim()];
	}
	const found: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (!line.startsWith(`${pad}    `)) {
			break;
		}
		found.push(line.trim());
	}
	return found;
}

function collectorArgs(): string[] {
	const match = /args=\((.*)\)/.exec(workflow('collect.yml'));
	assert.ok(match, 'the collect step builds an args array');
	return (match[1] ?? '').split(' ').filter((part) => part !== '');
}

test('the collect step of the workflow runs the real command line in the real layout, and the outputs are what the publish job reads', async () => {
	const world = await makeWorld({ mainDate: '2020-01-01T00:00:00Z' });
	world.clock.iso = new Date().toISOString().slice(0, 19) + 'Z';
	const workspace = join(world.root, 'ws');
	const output = join(world.root, 'github-output');
	writeFileSync(output, '');
	const lines: string[] = [];
	const env = {
		GITHUB_TOKEN: TOKEN,
		GITHUB_REPOSITORY: 'borbiuk/git-coin',
		GITHUB_OUTPUT: output,
	};
	const args = collectorArgs();
	assert.deepEqual(args, [
		'--config',
		'code/config/coins.json',
		'--data-root',
		'data',
		'--code-root',
		'code',
		'--keepalive',
	]);

	const before = process.cwd();
	process.chdir(workspace);
	try {
		// The real CLI builds a real Issue client when a token is set. A fake one keeps the test off the network.
		const code = await runCli(args, env, {
			http: world.market.http,
			issueClient: world.issues.client,
			log: (line) => {
				lines.push(line);
			},
		});
		assert.equal(code, 0, lines.join('\n'));
		assert.equal(
			world.issues.calls,
			0,
			'a healthy run makes no Issue call'
		);
	} finally {
		process.chdir(before);
	}

	assert.equal(
		readFileSync(output, 'utf8'),
		'should_publish=false\nrows_written=40\n'
	);
	assertInSync(world.data, world.dataRemote, 'data');
	assert.equal(remoteCount(world.dataRemote, 'data'), 2);
	// The config came from the main checkout, and the keepalive made one empty commit there
	assert.ok(lines.includes('keepalive: pushed an empty commit to main'));
	assert.equal(
		remoteLog(world.mainRemote, 'main')[0]?.subject,
		'Keep schedule active'
	);
	assert.equal(
		git(world.code, 'status', '--porcelain'),
		'',
		'nothing was written into the code checkout'
	);
	assert.ok(
		remoteFiles(world.dataRemote, 'data').some((file) =>
			file.endsWith('/BTC.csv')
		)
	);

	// The token is in the environment of the step. It must not appear in the log, the files or the commits.
	const everything = [
		lines.join('\n'),
		git(world.dataRemote, 'log', '--format=%B', 'refs/heads/data'),
		remoteShow(world.dataRemote, 'data', 'state/status.json'),
	].join('\n');
	assert.ok(!everything.includes(TOKEN));
});

test('the dry run of the workflow adds --dry-run, writes nothing and still reports the two outputs', async () => {
	const world = await makeWorld({ mainDate: '2020-01-01T00:00:00Z' });
	world.clock.iso = new Date().toISOString().slice(0, 19) + 'Z';
	const output = join(world.root, 'github-output');
	writeFileSync(output, '');
	const tip = remoteTip(world.dataRemote, 'data');
	const mainTip = remoteTip(world.mainRemote, 'main');
	const before = process.cwd();
	process.chdir(join(world.root, 'ws'));
	try {
		const code = await runCli(
			[...collectorArgs(), '--dry-run'],
			{
				GITHUB_TOKEN: TOKEN,
				GITHUB_REPOSITORY: 'borbiuk/git-coin',
				GITHUB_OUTPUT: output,
			},
			{
				http: world.market.http,
				issueClient: world.issues.client,
				log: () => undefined,
			}
		);
		assert.equal(code, 0);
	} finally {
		process.chdir(before);
	}
	assert.equal(
		readFileSync(output, 'utf8'),
		'should_publish=false\nrows_written=0\n'
	);
	assert.equal(remoteTip(world.dataRemote, 'data'), tip);
	assert.equal(
		remoteTip(world.mainRemote, 'main'),
		mainTip,
		'no keepalive in a dry run'
	);
});

test('a failed run still writes the outputs, and the exit code is 1', async () => {
	const world = await makeWorld();
	const output = join(world.root, 'github-output');
	writeFileSync(output, '');
	const before = process.cwd();
	process.chdir(join(world.root, 'ws'));
	try {
		const code = await runCli(
			['--config', 'code/config/missing.json', '--data-root', 'data'],
			{ GITHUB_OUTPUT: output },
			{ http: world.market.http, log: () => undefined }
		);
		assert.equal(code, 1);
	} finally {
		process.chdir(before);
	}
	// An invalid config stops before any output is written. The job fails, so `publish` is skipped by `needs`.
	assert.equal(readFileSync(output, 'utf8'), '');
});

// ---- Static checks of the workflow files (ADR 0009) ----

const FILES = readdirSync(WORKFLOWS)
	.filter((name) => name.endsWith('.yml'))
	.sort();

test('every action is pinned by a full commit SHA with a version comment, and only known owners are used', () => {
	for (const name of FILES) {
		for (const line of workflow(name).split('\n')) {
			const match = /^\s*-?\s*uses:\s*(\S+)(.*)$/.exec(line);
			if (match === null) {
				continue;
			}
			assert.match(
				match[1] ?? '',
				/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/,
				`${name}: ${line.trim()}`
			);
			assert.match(
				match[2] ?? '',
				/^\s+# v\d+\.\d+\.\d+$/,
				`${name}: version comment in ${line.trim()}`
			);
			const owner = (match[1] ?? '').split('/')[0];
			// ossf/scorecard-action is the one third party action (the Scorecard workflow needs it)
			assert.ok(
				['actions', 'github', 'ossf'].includes(owner ?? ''),
				`${name}: ${owner}`
			);
		}
	}
});

/** Lines inside `run:` scripts that hold a `${{ }}` expression. */
function expressionsInScripts(text: string): string[] {
	const found: string[] = [];
	const lines = text.split('\n');
	lines.forEach((line, index) => {
		const run = /^(\s*)(?:- )?run:/.exec(line);
		if (run === null) {
			return;
		}
		const indent = (run[1] ?? '').length;
		if (line.includes('${{')) {
			found.push(line.trim());
		}
		for (const next of lines.slice(index + 1)) {
			if (next.trim() !== '' && next.search(/\S/) <= indent + 1) {
				break;
			}
			if (next.includes('${{')) {
				found.push(next.trim());
			}
		}
	});
	return found;
}

test('no workflow puts an expression into a shell script, so no outside text can become code', () => {
	// The scanner must be able to fail: it finds an expression in a block script and in a one-line script
	const bad =
		'steps:\n    - run: echo ${{ github.event.pull_request.title }}\n    - run: |\n          echo "${{ github.head_ref }}"\n          true\n    - run: true\n';
	assert.deepEqual(expressionsInScripts(bad), [
		'- run: echo ${{ github.event.pull_request.title }}',
		'echo "${{ github.head_ref }}"',
	]);
	for (const name of FILES) {
		assert.deepEqual(expressionsInScripts(workflow(name)), [], name);
	}
});

test('permissions: nothing at the top of the collector, and exactly the documented grants per job', () => {
	const text = workflow('collect.yml');
	assert.deepEqual(permissionsOf(text, 0), ['permissions: {}']);
	assert.deepEqual(permissionsOf(job(text, 'collect'), 8), [
		'# Push to the `data` branch and the keepalive commit on `main`',
		'contents: write',
		'# Alert Issues and the `no data` Issue',
		'issues: write',
	]);
	assert.deepEqual(
		permissionsOf(job(text, 'publish'), 8).filter(
			(line) => !line.startsWith('#')
		),
		['contents: read', 'pages: write', 'id-token: write']
	);
	for (const name of FILES) {
		const file = workflow(name);
		assert.ok(
			/^permissions:/m.test(file),
			`${name} sets permissions at the top`
		);
		assert.ok(
			!/^\s+(actions|checks|deployments|packages|pull-requests|statuses): write/m.test(
				file
			),
			`${name}: extra write scope`
		);
	}
});

test('the collector workflow: forks, runner, timeout, concurrency, credentials, no secrets', () => {
	const text = workflow('collect.yml');
	assert.match(
		text,
		/^concurrency:\n {4}group: collect\n {4}cancel-in-progress: false$/m
	);
	for (const name of ['collect', 'publish']) {
		const body = job(text, name);
		assert.ok(
			body.includes("github.repository == 'borbiuk/git-coin'"),
			`${name} guards forks`
		);
		assert.match(body, /^ {8}timeout-minutes: 10$/m);
		assert.match(body, /^ {8}runs-on: ubuntu-26\.04$/m);
	}
	assert.ok(!/secrets\./.test(text), 'no secret is used');
	// Credentials stay in the git config only where the job pushes
	assert.equal(
		(job(text, 'collect').match(/persist-credentials: true/g) ?? []).length,
		2
	);
	assert.equal(
		(job(text, 'collect').match(/fetch-depth: 1/g) ?? []).length,
		2
	);
	assert.equal(
		(job(text, 'publish').match(/persist-credentials: false/g) ?? [])
			.length,
		2
	);
	assert.ok(
		job(text, 'publish').includes(
			'environment:\n            name: github-pages'
		)
	);
	assert.ok(!/pull_request_target|workflow_run/.test(text));
	// The token reaches only the collector step
	assert.equal(
		(text.match(/GITHUB_TOKEN: \$\{\{ github\.token \}\}/g) ?? []).length,
		1
	);
});

test('the cron minutes are off-peak and the default branch is the only one that is scheduled', () => {
	for (const name of FILES) {
		for (const match of workflow(name).matchAll(/- cron: '([^']+)'/g)) {
			const minutes = (match[1] ?? '').split(' ')[0]?.split(',') ?? [];
			assert.ok(
				minutes.every(
					(minute) =>
						minute !== '0' &&
						minute !== '30' &&
						!minute.includes('*')
				),
				`${name}: ${match[1]}`
			);
		}
	}
	assert.match(workflow('collect.yml'), /- cron: '3,18,33,48 \* \* \* \*'/);
});

test('the build workflow calls only commands that exist in package.json or on disk', () => {
	const scripts = (
		JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
			scripts: Record<string, string>;
		}
	).scripts;
	const text = workflow('build.yml');
	for (const match of text.matchAll(/npm run ([\w:-]+)/g)) {
		assert.ok(scripts[match[1] ?? ''] !== undefined, `npm run ${match[1]}`);
	}
	// `npm run check` is the local gate. The CI jobs must run every part of it.
	for (const part of (scripts.check ?? '')
		.split('&&')
		.map((item) => item.trim())) {
		assert.ok(
			text.split('\n').some((line) => line.trimEnd().endsWith(part)),
			`CI runs ${part}`
		);
	}
	assert.match(text, /node tools\/check-symbols\.ts$/m);
	assert.ok(existsSync(join(REPO, 'tools', 'check-symbols.ts')));
	assert.ok(existsSync(join(REPO, 'config', 'coins.schema.json')));
	assert.ok(existsSync(join(REPO, '.github', 'actionlint.yaml')));
	assert.ok(
		text.includes(
			'check-jsonschema --builtin-schema vendor.github-workflows .github/workflows/*.yml'
		)
	);
	assert.ok(
		text.includes(
			'check-jsonschema --builtin-schema vendor.dependabot .github/dependabot.yml'
		)
	);
	assert.ok(
		text.includes(
			'check-jsonschema --schemafile config/coins.schema.json config/coins.json'
		)
	);
});

// ---- Static checks of the dashboard files (ADR 0008 D6, ADR 0009 D1) ----

test('the dashboard builds its DOM from text only and loads nothing from outside', () => {
	for (const name of ['app.js', 'lib.js']) {
		const code = readFileSync(join(REPO, 'site', name), 'utf8');
		assert.ok(
			!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|srcdoc/.test(
				code
			),
			name
		);
		assert.ok(
			!/raw\.githubusercontent\.com|\bhttp:\/\//.test(code),
			`${name}: only https and relative URLs`
		);
	}
	const app = readFileSync(join(REPO, 'site', 'app.js'), 'utf8');
	for (const match of app.matchAll(/fetchJson\('([^']+)'\)/g)) {
		assert.match(match[1] ?? '', /^data\/[\w./-]+\.json$/);
	}
	assert.ok(app.includes("cache: 'no-cache'"));

	const html = readFileSync(join(REPO, 'site', 'index.html'), 'utf8');
	assert.match(html, /http-equiv="Content-Security-Policy"/);
	assert.match(
		html,
		/default-src 'none'; script-src 'self'; style-src 'self'/
	);
	assert.ok(!/<script(?![^>]*\ssrc=)/.test(html), 'no inline script');
	assert.ok(!/<style/.test(html), 'no inline style');
	assert.ok(!/\sstyle=/.test(html), 'no style attribute');
	assert.ok(!/\son\w+=/.test(html), 'no inline event handler');
	for (const match of html.matchAll(
		/<(?:script|link)[^>]*(?:src|href)="([^"]+)"/g
	)) {
		assert.ok(
			!/^(https?:)?\/\//.test(match[1] ?? ''),
			`no remote script or style: ${match[1]}`
		);
	}
	// The disclaimer is in the page itself, before the first banner
	assert.ok(
		html.indexOf('Not financial advice') < html.indexOf('id="banners"')
	);
});
