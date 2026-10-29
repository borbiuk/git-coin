// Documentation check that needs no network: every relative link in the Markdown files points to an
// existing file. Anchors inside a file are checked by markdownlint (MD051). Run: npm run lint:docs

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

// Tracked and new Markdown files
const files = execFileSync(
	'git',
	['ls-files', '--cached', '--others', '--exclude-standard', '*.md'],
	{ cwd: ROOT, encoding: 'utf8' }
)
	.split('\n')
	.filter((file) => file !== '' && existsSync(path.join(ROOT, file)));

/** Removes fenced code blocks and inline code, which may contain link-like text */
function stripCode(text) {
	return text
		.replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, '')
		.replace(/`[^`\n]*`/g, '');
}

for (const file of files) {
	const text = stripCode(readFileSync(path.join(ROOT, file), 'utf8'));
	for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
		const target = match[1].replace(/^<|>$/g, '');
		if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) {
			continue;
		}
		const relative = decodeURIComponent(target.split('#')[0].split('?')[0]);
		if (relative === '') {
			continue;
		}
		const resolved = path.resolve(ROOT, path.dirname(file), relative);
		if (!existsSync(resolved)) {
			errors.push(`${file}: broken link to ${target}`);
		}
	}
}

if (errors.length > 0) {
	console.error(errors.join('\n'));
	process.exit(1);
}
console.log(`Checked ${files.length} Markdown files.`);
