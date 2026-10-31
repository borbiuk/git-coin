---
name: publish-page
description: Publishes the dashboard: checks the branch, fast-forwards main to integration, pushes main, runs collect.yml and checks the live Pages status. Use only when the user types /publish-page or clearly asks to see their changes on GitHub Pages.
disable-model-invocation: true
---

# Publish the page

The push is the owner's step (CLAUDE.md). This skill runs only because the user asked for it, and it still waits for a clear yes before the first write.

1. Check: `git status --short` must be empty and the branch must be `integration`. Run the `verify` skill. Stop on any failure and say what failed.
2. Show `git log --oneline main..integration` and the repository state of `origin/main` (`git fetch origin main`, then `git log --oneline integration..origin/main`). If `origin/main` has commits that `integration` lacks, stop and report: a fast-forward is impossible.
3. Ask: "Fast-forward main to integration, push main, and run collect.yml?" Wait for a clear yes in chat. Without it, change nothing.
4. After the yes: `./scripts/with-node24.sh git switch main`, `./scripts/with-node24.sh git merge --ff-only integration`, `./scripts/with-node24.sh git push origin main`, then `git switch integration`. Never force-push, never rebase.
5. Run `./scripts/gh-borbiuk.sh workflow run collect.yml --repo borbiuk/git-coin`, find the run with `./scripts/gh-borbiuk.sh run list --workflow collect.yml --repo borbiuk/git-coin --limit 1 --json databaseId`, and wait with `./scripts/gh-borbiuk.sh run watch <id> --repo borbiuk/git-coin --exit-status`.
6. Check the live page: `curl -s https://borbiuk.github.io/git-coin/data/status.json` and compare its time with the run time.
7. Report in Ukrainian: what was pushed, the run result, the status time. Say what was not checked (the look of the page in a browser).
