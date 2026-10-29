# ADR 0003: Language and runtime

- Status: Proposed
- Date: 2026-10-29
- Revision: the first draft chose Python (standard library only). The owner knows Node better and asked for Node 24.22.1. Technically the two were close, so familiarity decided. This version chooses Node.js 24 with native TypeScript.
- Revision 2 (2026-10-29, later): the owner asked to use the tool set and templates of the Hyperfriend repository. Prettier, ESLint, knip, markdownlint, Husky and exact versions replace the Biome plan of the first version. The runtime choice is unchanged.
- Scope: language of the collector, runner image, tooling (format, lint, types, tests, dependency updates). The dashboard stack is in ADR 0008.

Source grades: [A] official docs or registry, [B] own measurement, [C] first-hand report, [D] blog or news.

## Context

The collector runs every 15 minutes on a GitHub-hosted runner. It does HTTP requests, validates numbers, appends CSV rows, calls the GitHub REST API for Issues and builds a few JSON files. Cold start matters because the job should take seconds. The owner maintains it alone and knows Node well.

## Decision Drivers

1. Owner familiarity (maintenance effort).
2. Zero or near-zero runtime dependencies (supply-chain risk, no install step in the scheduled job).
3. Runtime is already on the runner (fast start).
4. Easy to test with fixtures.
5. One language for the collector and the dashboard, if it costs nothing.

## Facts

- `ubuntu-26.04` image 20261026: Node.js 24.22.1 is the default (22.23.4 is also cached), Python 3.14.4, jq 1.8.1, curl 8.18.0, git 2.56.0. [A]
- `ubuntu-24.04` image 20261026: Node.js 22.23.4 is the default; 22.23.4 and 24.22.1 are cached. So on 24.04 an exact Node 24.22.1 needs `actions/setup-node`. [A]
- `ubuntu-latest` is moving from 24.04 to 26.04 between 2026-10-19 and 2026-11-19. The changelog says it "may break builds" and advises testing with `ubuntu-26.04` or pinning `ubuntu-24.04`. [A]
- Node 24 is an LTS line ("Krypton"). The newest 24.x release on nodejs.org on 2026-10-29 was v24.22.2 (2026-10-27), so the image default may move past 24.22.1 when images are rebuilt. [A]
- Node runs `.ts` files by type stripping. It was enabled by default in v22.18.0 and marked stable in v24.12.0. Only "erasable" syntax works (no `enum`, no namespaces with code, no parameter properties). `tsconfig.json` is ignored. Node does no type checking. Type checking needs the `typescript` npm package. [A]
- Node has a built-in test runner (`node --test`). [A]
- Not researched in this work: the exact behaviour of the built-in `fetch` with `AbortSignal.timeout` in Node 24 (timeouts, retries). Confirm at implementation. UNVERIFIED.
- Node 20 was removed from runners on 2026-09-23. Latest majors of first-party actions run on node24: checkout v7.0.1, setup-node v7.1.0, deploy-pages v5.0.1, configure-pages v6.0.0, upload-pages-artifact v5.0.0 (composite). [A]
- Dev tool versions on 2026-10-29: `typescript` 7.0.2 (2026-07-08, Apache-2.0), `eslint` 10.13.0, `prettier` 3.9.10, `typescript-eslint` 8.72.0, `knip` 6.42.0, `markdownlint-cli2` 0.24.0, `husky` 9.1.7, `@types/node` 24.19.2 (the Node 24 line). The tool set and versions are the ones of the owner's Hyperfriend repository (revision note below). [A]
- Supply-chain incidents in 2025-26 hit npm and PyPI repeatedly (for example the 2025-09 phished-maintainer npm incident; tj-actions/changed-files CVE-2025-30066 in Actions). GitHub says Dependabot now waits 3 days before opening version-update PRs (default cooldown). Most 2026 npm install-time incidents used install scripts. npm v12 (2026-06) disables install scripts by default. [A] for GitHub's posts; counts from news and vendor blogs [D] are not used for the decision.
- Not measured: setup-action durations and cold start on a runner. A minimal job (checkout, small script, push) took 6 to 26 seconds in total on three public repos. [B] (see ADR 0005)

## Considered Options

| Criterion                      | Node.js 24 + native TS (chosen)   | Node.js 24 + plain JS with JSDoc   | Python (stdlib)      | Go                                    | Bash + curl + jq | .NET           |
| ------------------------------ | --------------------------------- | ---------------------------------- | -------------------- | ------------------------------------- | ---------------- | -------------- |
| On the runner                  | yes (26.04 default; 24.04 cached) | yes                                | yes (3.12 or 3.14)   | cached 1.24 to 1.26; 1.27 needs setup | yes              | not researched |
| Runtime deps                   | 0                                 | 0                                  | 0                    | 0                                     | 0                | not researched |
| Owner familiarity              | high                              | high                               | lower                | unknown                               | unknown          | high           |
| Same language as the dashboard | yes                               | yes                                | no                   | no                                    | no               | no             |
| Testing                        | `node --test` built in            | same                               | pytest or `unittest` | `go test`                             | weak             | not researched |
| Types                          | `tsc` (dev dep, CI only)          | `tsc --checkJs` (dev dep, CI only) | optional mypy        | built in                              | none             | built in       |
| Exact decimals                 | no (strings plus numbers)         | no                                 | `Decimal`            | yes                                   | fragile          | yes            |
| Toolchain churn                | medium (TypeScript releases fast) | low                                | low                  | low, but a build step                 | none             | not researched |

- Node with TypeScript: best fit for this owner. Type stripping removes the build step. The weak spots are the TypeScript churn and the lack of `Decimal`. Prices are kept as strings, so only percentage math uses numbers (ADR 0004).
- Node with plain JavaScript and JSDoc: the lowest-churn Node variant. `tsc --checkJs` still gives types in CI. Switching to it later is easy.
- Python: also a good fit (rated slightly ahead on stability and `Decimal`). The difference is small. It would mean a second language next to the dashboard.
- Go: a build step and a binary for a short job. Not worth it.
- Bash: poor for validation, Issue logic and tests. Rejected.
- .NET: not researched (is the SDK on the runner, which versions, start time). Not recommended without evidence. It would also be a second language next to the dashboard.

## Decision Outcome

Chosen: Node.js 24 with TypeScript run natively (type stripping), no runtime dependencies, for the collector and for the data build step.

1. Language and version: Node.js 24 (the image has 24.22.1). TypeScript source files are run directly (`node src/collect.ts`). Use erasable syntax only. If the owner wants less tool churn, plain JS with JSDoc is an allowed fallback (see options).
2. Runner: `runs-on: ubuntu-26.04` (pinned label, not `ubuntu-latest`). Node 24.22.1 is the default there, so no `setup-node` step is needed. The first step of the job checks that `node --version` starts with `v24` and fails otherwise. The patch version is whatever the image has. Do not rely on an exact patch version. If an exact `24.22.1` is required, use `actions/setup-node` with `node-version: 24.22.1`, pinned by SHA (first-party). It is cached on 24.04, so on `ubuntu-24.04` it should be fast. This is the alternative if `ubuntu-26.04` causes trouble.
3. Runtime dependencies: none. HTTP with the built-in `fetch` and an explicit timeout. The scheduled job never runs `npm install`. This keeps npm out of the scheduled path.
4. Prices: kept as the source strings (ADR 0004). A price is checked with a strict decimal pattern, then converted to a number only for comparisons and percentage math.
5. Dev tools (CI only, never installed in the scheduled job):
    - format: Prettier (tabs, width 4, single quotes, `es5` trailing commas, LF), as in Hyperfriend
    - lint: ESLint 10 flat config with `typescript-eslint`, `eslint-config-prettier` and `eslint-plugin-import-x` (rules `curly: all`, import order, no floating promises)
    - docs: `markdownlint-cli2` and a relative-link check (`scripts/check-docs.mjs`); unused code and dependencies: `knip`; exact versions: `scripts/check-versions.mjs`; pull request titles: `scripts/check-pr-title.mjs`
    - types: `typescript7` (alias of `typescript` 7.0.2), run as `node node_modules/typescript7/bin/tsc --noEmit`; `typescript` is the TypeScript 6 compat alias that `typescript-eslint` needs
    - tests: `node --test` (built in)
    - config check: `check-jsonschema` 0.39.0, run in CI with a pinned version (it is a Python tool and Python is on the runner; see ADR 0007)
    - workflow lint: `actionlint` (v1.7.12) and `zizmor` (1.31.1)
      Pin dev tools in `package.json` with a lockfile. Install in CI with `npm ci --ignore-scripts`.
6. Updates: Dependabot for `github-actions` and `npm` dev dependencies, both weekly with a 7-day cooldown (as in Hyperfriend). Pin all actions by full commit SHA with a `# vX.Y.Z` comment (ADR 0009). Dev dependencies use exact versions only (`.npmrc` `save-exact=true`, `check:versions`).
7. A Husky pre-commit hook runs the formatter on every commit (local only, as in Hyperfriend). CI runs the same checks (`npm run check` is the local gate). The scheduled job installs nothing, so the hook never runs there.
8. Use only first-party actions: `actions/checkout`, `actions/upload-pages-artifact`, `actions/deploy-pages`. Commit and push with plain `git`. Create Issues with the REST API from the script using `GITHUB_TOKEN`.

## Consequences

- Good: one language for collector and dashboard. The owner knows it.
- Good: no dependency installs in the scheduled job. Start time is checkout time plus script time.
- Good: tests need no framework.
- Bad: no `Decimal`. Handled by keeping strings.
- Bad: TypeScript tooling changes quickly. Keep the dev tool list short and pinned. Fall back to JSDoc if it hurts.
- Bad: the runner image decides the Node patch version. A guard step catches a wrong major.
- Bad: `check-jsonschema` is a Python tool, so CI has two ecosystems. The alternative is `ajv` (npm) with a small script. Decide at implementation (ADR 0007).
- Follow-up: measure the real job duration in the pilot (ADR 0005).

## Sources (access date for all: 2026-10-29)

- https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md [A]
- https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2604-Readme.md [A]
- https://github.blog/changelog/2026-09-17-ubuntu-26-generally-available-and-latest-migration [A]
- https://github.blog/changelog/2026-02-04-deprecation-of-node-20-on-github-actions-runners/ [A]
- https://nodejs.org/docs/latest-v24.x/api/typescript.html [A]
- https://nodejs.org/en/blog/release/v22.18.0 [A]
- https://nodejs.org/dist/index.json (Node release dates and LTS names) [A]
- npm registry for the dev tool versions [A]
- The owner's Hyperfriend repository (`github.com/borbiuk/hyperfriend`): `package.json`, `.prettierrc.json`, `eslint.config.mjs`, `knip.jsonc`, `.markdownlint-cli2.jsonc`, `.husky/pre-commit`, `.github/` [B]
- Releases API for actionlint, zizmor and the first-party actions [A]
- https://github.blog/security/supply-chain-security/the-case-for-a-cooldown-why-dependabot-now-waits-before-issuing-version-updates/ [A]
- https://github.blog/security/supply-chain-security/disrupting-supply-chain-attacks-on-npm-and-github-actions/ [A]
- https://github.com/advisories/GHSA-mrrh-fwg8-r2c3 (tj-actions/changed-files) [A]
- https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference [A]
- https://go.dev/doc/devel/release and https://devguide.python.org/versions/ (for the rejected options) [A]

## Open Questions

1. `ubuntu-26.04` or `ubuntu-24.04` with `setup-node` 24.22.1? Chosen: 26.04, because Node 24.22.1 is the default there and `ubuntu-latest` is moving there anyway. Check it in the pilot.
2. Does the built-in `fetch` with `AbortSignal.timeout` behave as needed (timeout, 429 handling) on Node 24? Not researched.
3. Is the real cold start of the job (checkout, Node start, requests, push) below 30 seconds? Measure in the pilot.
4. Keep TypeScript, or fall back to JSDoc after the first month if the toolchain annoys?
5. `check-jsonschema` (Python, CI only) or `ajv` (npm)?
6. .NET was not researched. Research it only if the owner wants it compared.
