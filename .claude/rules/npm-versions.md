---
paths:
    - 'package.json'
    - 'package-lock.json'
    - '.npmrc'
    - 'scripts/check-versions.mjs'
---

# npm versions policy

> Exact versions only.

- **Every** entry in `devDependencies` is an exact version such as `10.13.0`. Never use `^`, `~`, `*`, `latest` or other ranges. There are no runtime `dependencies` (ADR 0003).
- npm aliases are allowed with an exact version: `"typescript7": "npm:typescript@7.0.2"`.
- `.npmrc` sets `save-exact=true` and `engine-strict=true` (Node `>=24.22.1 <25`, the `engines` field in `package.json`).
- Add or update dependencies only when the task needs it, and say so explicitly; `npm install` asks for confirmation (see `.claude/settings.json`).

## Updating

```bash
npm install -D -E <package>@latest   # dev dependency
npm run check:versions               # fails if anything is not exact
npm run check:outdated               # npm outdated; local use, not run in CI
```

- DO review `package.json` after installing: aliases must stay exact.
- DON'T hand-edit versions in `package-lock.json`; let npm regenerate it.
- After updates run `npm run check`.

## TypeScript aliases

- `typescript7` is `npm:typescript@7.0.2`: the compiler used by `npm run typecheck` (`node node_modules/typescript7/bin/tsc --noEmit`).
- `typescript` is `npm:@typescript/typescript6@6.0.2`: the TypeScript 6 package that provides the JavaScript API still required by `typescript-eslint`. Do not point it to version 7.

## CI

- The CI workflow runs `npm ci` and `npm run check:versions` on every push and pull request. `check:outdated` is for local use only, because new releases would break CI at random.
