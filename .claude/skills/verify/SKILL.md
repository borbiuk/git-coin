---
name: verify
description: Runs the full git-coin check suite (format, exact versions, ESLint and type check, docs lint, knip, node tests) under Node 24 and reports what passed and what did not. Use after a code change, before a commit or when asked to verify the repository.
---

# Verify

Run the gate, read the output, and report the result without hiding failures.

1. Run `./scripts/with-node24.sh npm run check`. It runs, in order: `format:check`, `check:versions`, `lint` (ESLint and the TypeScript 7 type check), `lint:docs`, `lint:unused` (knip) and `test` (`node --test`).
2. If `format:check` fails, run `npm run format` and re-run the check. If another step fails, read the first error, fix the cause in your own files and re-run. Do not edit `eslint.config.mjs`, `knip.jsonc` or other tool configs to make an error disappear.
3. Report: the exact command, the exit code, the test count (pass, fail, todo) and any knip configuration hints. Say clearly what was not run: nothing here runs on GitHub, so workflows, Pages, the Issue email path and runner access to the data sources are UNVERIFIED until the owner runs them (`docs/implementation/runbook.md`).
