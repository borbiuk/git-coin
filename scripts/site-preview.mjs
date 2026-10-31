// Builds the dashboard from a data checkout into out/ and serves it on localhost.
// Same steps as the publish job of .github/workflows/collect.yml.
// Run: npm run site:preview -- [--data-root data] [--port 8765]
// The data checkout is a copy of the `data` branch, for example: git worktree add --detach data origin/data
import { spawnSync } from 'node:child_process';
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const CONTENT_TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.csv': 'text/csv; charset=utf-8',
};

const { values } = parseArgs({
	options: {
		'data-root': { type: 'string' },
		port: { type: 'string', default: '8765' },
	},
});

// Paths come from the script location, so a run from another directory never touches that directory's out/.
const root = resolve(import.meta.dirname, '..');
const dataRoot = resolve(values['data-root'] ?? join(root, 'data'));
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
	console.error(
		`--port needs a whole number from 1 to 65535, got "${values.port}"`
	);
	process.exit(1);
}
if (!existsSync(join(dataRoot, 'data', 'raw'))) {
	console.error(
		`No data found in ${dataRoot}/data/raw. Check out the data branch first:\n  git fetch origin data && git worktree add --detach ${dataRoot} origin/data`
	);
	process.exit(1);
}

const outDir = join(root, 'out');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(join(root, 'site'), outDir, { recursive: true });

const build = spawnSync(
	process.execPath,
	[
		join(root, 'src/build-site.ts'),
		'--config',
		join(root, 'config/coins.json'),
		'--data-root',
		dataRoot,
		'--out',
		join(outDir, 'data'),
	],
	{ stdio: 'inherit' }
);
if (build.status !== 0) {
	console.error('The site build failed.');
	process.exit(build.status ?? 1);
}

const server = createServer((request, response) => {
	let path;
	try {
		path = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/');
	} catch {
		response.writeHead(400).end('Bad request');
		return;
	}
	const file = resolve(
		outDir,
		`.${path.endsWith('/') ? `${path}index.html` : path}`
	);
	const inside = relative(outDir, file);
	if (
		inside.startsWith('..') ||
		isAbsolute(inside) ||
		!existsSync(file) ||
		!statSync(file).isFile()
	) {
		response.writeHead(404).end('Not found');
		return;
	}
	response.writeHead(200, {
		'content-type':
			CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
		'cache-control': 'no-store',
	});
	response.end(readFileSync(file));
});
server.on('error', (error) => {
	console.error(`Could not listen on port ${port}: ${error.message}`);
	process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
	console.log(`Dashboard on http://localhost:${port}/ (Ctrl+C to stop)`);
});
