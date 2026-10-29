---
paths:
    - 'CLAUDE.md'
    - 'AGENTS.md'
    - '.claude/**'
---

# Maintaining agent context (.claude/)

> How to keep CLAUDE.md, AGENTS.md and `.claude/` consistent and useful.

## Layout

| Location                | Purpose                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `CLAUDE.md`             | Always loaded: imports `AGENTS.md` (`@AGENTS.md`) and adds Claude-specific working rules. Keep short. |
| `AGENTS.md`             | Tool-agnostic orientation for humans and AI contributors (architecture, constraints, commands).       |
| `.claude/rules/`        | Topical rules. Every rule has `paths` frontmatter, so it loads only when matching files are touched.  |
| `.claude/settings.json` | Shared permissions (allow, ask, deny). Personal overrides go to the gitignored `settings.local.json`. |

## Rules of thumb

- A new rule needs `paths` frontmatter; only `CLAUDE.md` and `AGENTS.md` are always loaded.
- Write what Claude cannot derive from the code; link to real files instead of copying them. Do not repeat the same fact in several files.
- Requirements that can be enforced (blocked commands, formatting, checks) belong in `.claude/settings.json`, hooks, scripts or CI, not only in prose.
- Remove outdated guidance promptly; stale rules are worse than no rules.

## Keeping things in sync

- When an npm script, a module contract or a command changes, update `AGENTS.md`, the matching rule and `docs/implementation/plan.md`.
- After moving or renaming files, check that every relative link in `CLAUDE.md`, `AGENTS.md` and `.claude/**/*.md` still resolves (`npm run lint:docs`).
