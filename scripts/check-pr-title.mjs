// Checks the title of a pull request (it becomes the commit title when the pull request is squashed).
// Mechanical rules only: starts with an upper case letter, at most 72 characters, no trailing period,
// no WIP, fixup! or squash! marker. Writing it in the imperative mood is a convention in CONTRIBUTING.md.
// Usage: node scripts/check-pr-title.mjs "Add a CSV writer"  (CI passes the title as PR_TITLE)

const MAX_LENGTH = 72;

const title = (process.argv[2] ?? process.env.PR_TITLE ?? '').trim();
const problems = [];

if (title === '') {
	problems.push('the title is empty');
}
if (title !== '' && !/^\p{Lu}/u.test(title)) {
	problems.push('it must start with an upper case letter');
}
if (title.length > MAX_LENGTH) {
	problems.push(
		`it has ${title.length} characters, the limit is ${MAX_LENGTH}`
	);
}
if (title.endsWith('.')) {
	problems.push('it must not end with a period');
}
if (/^(wip\b|fixup!|squash!)/i.test(title) || /\bWIP\b/.test(title)) {
	problems.push('it must not contain a WIP, fixup! or squash! marker');
}

if (problems.length > 0) {
	console.error(`Invalid pull request title "${title}":`);
	for (const problem of problems) {
		console.error(`- ${problem}`);
	}
	process.exit(1);
}
console.log(`Pull request title is valid: "${title}"`);
