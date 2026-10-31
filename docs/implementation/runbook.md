# Runbook: the owner's gates

This is the list of steps that only the owner can do (agents never push, never change GitHub settings and never run anything on GitHub). It follows the gates in [plan.md](plan.md), section 7. Every step has the exact command or the exact place in the settings. Run the commands in your own clone of the repository.

| Gate | What                                                                        | Needs                                         |
| ---- | --------------------------------------------------------------------------- | --------------------------------------------- |
| G2   | Throwaway tests on GitHub (start early, the pilot takes 72 hours)           | [throwaway/README.md](throwaway/README.md)    |
| G5   | Confirm the licence and the risks, in writing, before the first public push | ADR 0001 and 0009                             |
| G1   | Make the repo public, push, set the repository settings                     | G5, and the implementation merged into `main` |
| G3   | Create the `data` branch content, dry run, first real run, 14-day test      | G1, and the G2 results (probe and bot push)   |
| G4   | Read the analysis, choose the source, switch to production                  | the 14 days of data                           |

## Conventions

Use the `borbiuk` account for every `gh` command. Do not run `gh auth switch`.

```bash
export GH_TOKEN=$(gh auth token --user borbiuk)
cd ~/projects/git-coin        # your clone; the folder names below are examples
```

Run npm and `git commit` through `./scripts/with-node24.sh` (the machine default Node is not 24). Nothing in this runbook force-pushes, and nothing needs to.

## G5: before anything is public

1. The code licence is MIT (the file `LICENSE`). Confirm it, or change it now. A licence change after the repo is public is messy.
2. Write down, in your own words and in a place you keep (a note, or the "Owner decisions" list of [ADR 0000](../adr/0000-index.md)), that you accept these risks:
    - The GitHub rules about "excessive" automated use have no number (ADR 0001). The schedule is small and polite, but the risk is not zero.
    - The test period stores real prices from four sources in a public history, and the rows of the three sources that are not chosen stay there for good (ADR 0002 Revision 2, point 9). Coinbase's terms forbid display and redistribution. This is a known conflict that you accepted on 2026-10-29. Kraken has not answered yet (checklist item 7).
    - A public git history cannot be erased. Forks and clones keep copies.
3. Check that no personal data, secret or real price file is in the history (the commands are in step 3 of G1).

## G1: public repo, first push, settings

Needs the implementation merged into `main` and `./scripts/with-node24.sh npm run check` green (the orchestrator did that in phase P3), and the G5 steps done.

### 1. Check the local repo

```bash
git switch main
git status                                   # must be clean
./scripts/with-node24.sh npm ci --ignore-scripts
./scripts/with-node24.sh npm run check       # must pass
git log --format='%an <%ae>' | sort -u       # only one line: your noreply address
git log --format='%B' | grep -i -E 'co-authored|generated' || echo 'no attribution lines'
git ls-files | grep -i -E '\.env|\.pem|\.key$|secret' || echo 'no secret-like file names'
git grep -n -i -E 'ghp_|github_pat_|api[_-]?key|password' -- . ':!package-lock.json' ':!docs' || echo 'no secret-like text outside docs'
```

Read the output. The author line must be `Nazariy Borbiuk <41112208+borbiuk@users.noreply.github.com>`.

### 2. Prepare the `data` branch (local, not pushed yet)

The collector needs the orphan branch `data` on the first run. Make it now and push it together with `main`, so no scheduled run finds a missing branch. The README on this branch is optional but recommended, because people browse the branch on GitHub.

```bash
git worktree add --orphan -b data ../git-coin-data
cd ../git-coin-data
cat > README.md <<'EOF'
# git-coin data branch

This branch holds the price history of git-coin as CSV files. The collector appends rows here. Do not edit it by hand. The code, the dashboard and the explanation are on the `main` branch.

While the sources are being compared, this is test data, provided as is. Prices can be late, missing or wrong, and they are not financial advice. No licence to the price data is granted. Prices come from third-party sources (Kraken, Coinbase Exchange, Bitstamp and Coin Metrics). Coin Metrics data is licensed under CC BY-NC 4.0.
EOF
git add README.md
git commit -m "Start the data branch"   # plain git: this branch has no scripts and no hook
cd ../git-coin
git worktree remove ../git-coin-data
git branch --list data           # the branch exists locally
```

If your Git is older than 2.42 (`git --version`), use `git switch --orphan data` in a spare clone instead of `git worktree add --orphan`.

### 3. Make the repo public and push

```bash
git remote -v                                 # origin must be https://github.com/borbiuk/git-coin.git
git ls-remote origin                          # look at what is already on GitHub
```

If `origin` is missing, add it: `git remote add origin https://github.com/borbiuk/git-coin.git`. If GitHub already has commits that are not in your local `main`, stop and look at them. Do not force-push.

```bash
gh repo edit borbiuk/git-coin --visibility public --accept-visibility-change-consequences
git push -u origin main data
gh workflow disable collect.yml --repo borbiuk/git-coin   # hold the schedule until G3 (retry in 10 seconds if the workflow is not listed yet)
```

The schedule starts as soon as `collect.yml` is on the default branch, so disable it right away. A disabled workflow keeps its file and does nothing, not even on a manual run, until you enable it in G3. If a tick fired before you disabled it, nothing bad happens: the config is in `phase: "test"` with publishing off, so it only writes test rows to `data`.

Look at the first CI runs: `gh run list --repo borbiuk/git-coin --limit 10`. `build`, `pr-title`, `codeql`, `dependency-review` and `scorecard` should be green or still running. Fix a red run before you go on.

### 4. Repository settings

Each command is one setting. Run them one by one and read the answer.

```bash
# Pages: deploy from GitHub Actions. Nothing is published during the test (features.publish is false),
# so the site stays empty until G4. If the site already exists, use -X PUT instead of -X POST.
gh api -X POST repos/borbiuk/git-coin/pages -f build_type=workflow

# Secret scanning and push protection (on by default in public repos; this makes sure)
gh api -X PATCH repos/borbiuk/git-coin --input - <<'JSON'
{ "security_and_analysis": { "secret_scanning": { "status": "enabled" }, "secret_scanning_push_protection": { "status": "enabled" } } }
JSON

# Private vulnerability reporting (SECURITY.md points to it) and Dependabot alerts
gh api -X PUT repos/borbiuk/git-coin/private-vulnerability-reporting
gh api -X PUT repos/borbiuk/git-coin/vulnerability-alerts

# The workflow token is read-only by default and cannot approve pull requests
gh api -X PUT repos/borbiuk/git-coin/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false

# Actions must be pinned to a full commit SHA (ADR 0009 D3).
# UNVERIFIED: the field name sha_pinning_required. If the API refuses it, use Settings, Actions, General.
gh api -X PUT repos/borbiuk/git-coin/actions/permissions -F enabled=true -f allowed_actions=all -F sha_pinning_required=true
```

Rulesets (ADR 0009 D4): block force pushes and deletion on `main` and `data`. There is no "require pull request" rule, so the bot can push. No bypass actors.

```bash
gh api repos/borbiuk/git-coin/rulesets --method POST --input - <<'JSON'
{
  "name": "protect-main-and-data",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main", "refs/heads/data"], "exclude": [] } },
  "rules": [{ "type": "deletion" }, { "type": "non_fast_forward" }]
}
JSON
```

To squash or rewrite `data` later (ADR 0004 D5), set the ruleset to `disabled` first, then back to `active`. Get its id with `gh api repos/borbiuk/git-coin/rulesets --jq '.[] | [.id, .name] | @tsv'`.

Account settings (the web page only, no API):

1. Open <https://github.com/settings/emails>. Turn on "Keep my email addresses private" and "Block command line pushes that expose my email".
2. Open <https://github.com/settings/notifications>. Under Actions, choose "Only notify for failed workflows". Keep email on for Watching and Participating (the alert Issues depend on it, ADR 0006).

### 5. Check the settings (checklist item 8)

```bash
gh api repos/borbiuk/git-coin --jq '{visibility, default_branch, security_and_analysis}'
gh api repos/borbiuk/git-coin/rulesets --jq '.[] | {id, name, enforcement}'
gh api repos/borbiuk/git-coin/actions/permissions
gh api repos/borbiuk/git-coin/actions/permissions/workflow
gh api repos/borbiuk/git-coin/pages --jq '{build_type, html_url}'
gh api repos/borbiuk/git-coin/private-vulnerability-reporting --jq .enabled
```

Keep this output (or screenshots of the two account pages) as the note that checklist item 8 asks for. G1 is done.

## G2: throwaway tests

Not part of this runbook. Start them as soon as the templates exist: [throwaway/README.md](throwaway/README.md). The result you need before G3 is: the probe shows at least two of the four sources working from a runner (checklist item 3), and the bot push checks a, c, e and f pass (item 6).

## G3: dry run, first real run, 14 days

Needs G1, the G2 results, and the P3 review done.

### 1. Check the config

```bash
jq '.settings | {phase, stored_sources, features}' config/coins.json
```

Expected: `phase` is `test`, `stored_sources` lists `kraken`, `coinbase`, `bitstamp` and `coinmetrics`, and `features` has `alerts` and `publish` both `false`. If the probe dropped a source, remove it from `stored_sources` first (a normal commit and push).

### 2. Dry run

A dry run fetches and validates the four sources, prints what it would write, and writes nothing (ADR 0005 D8). Enabling the workflow also turns the schedule on, so a scheduled real run may happen at any time after this step. That is fine: both are serialised by the concurrency group.

```bash
git ls-remote origin refs/heads/data         # write down the hash
gh workflow enable collect.yml --repo borbiuk/git-coin
gh workflow run collect.yml --repo borbiuk/git-coin -f dry_run=true -f mode=collect
sleep 15
id=$(gh run list --workflow collect.yml --repo borbiuk/git-coin --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$id" --repo borbiuk/git-coin --exit-status
gh run view "$id" --repo borbiuk/git-coin --log | less
```

Check in the log: four sources fetched, ten coins each, no row rejected without a reason, no error. Then `git ls-remote origin refs/heads/data` again. If no scheduled run happened in between, the hash is the same.

### 3. First real run

```bash
gh workflow run collect.yml --repo borbiuk/git-coin -f dry_run=false -f mode=collect
sleep 15
id=$(gh run list --workflow collect.yml --repo borbiuk/git-coin --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$id" --repo borbiuk/git-coin --exit-status
git fetch origin data
git log --oneline -3 origin/data
git ls-tree -r origin/data --name-only | head -20
git show origin/data:state/status.json | jq '{phase, last_run_at, last_point_at, consecutive_failures}'
```

Expected: one new commit on `data` (about 40 rows: four sources times ten coins, fewer if a source failed), CSV files under `data/raw/` and one request-log file under `data/meta/`, and `consecutive_failures` of 0.

### 4. Let the test run

The schedule now runs in `phase: "test"` for 14 days. Write down the start date and the end date. Nothing is published and no alert is sent in this phase. About once a day, and after any failed-run email, look at:

```bash
git fetch origin data
git rev-list --count origin/data                                              # grows by up to 96 a day
git show origin/data:state/status.json | jq '{last_run_at, last_point_at, consecutive_failures, sources}'
gh run list --workflow collect.yml --repo borbiuk/git-coin --limit 10
```

If a scheduled run is late or missing, that is normal (ADR 0005): the test measures the sources, and the schedule delivery is a second result. If something is clearly broken, stop the test with `gh workflow disable collect.yml --repo borbiuk/git-coin` and tell the orchestrator. Do not edit files on `data` by hand.

The Pages site stays empty until G4 (ADR 0002 Revision 2, point 5). Pages returning 404 is expected.

## G4: read the analysis, choose the source, go to production

Needs the 14 days of data.

### 1. Run the analysis

`tools/analyze-sources.ts` reads the data checkout and prints the gate and score tables of ADR 0002 Revision 2, points 7 and 8. Look at its options first: `./scripts/with-node24.sh node tools/analyze-sources.ts --help`. The flag `--data-root` below is the real one (checked against the tool).

```bash
git fetch origin data
git worktree add --detach ../git-coin-data-view origin/data
./scripts/with-node24.sh node tools/analyze-sources.ts --data-root ../git-coin-data-view > ../analysis-14d.md
./scripts/with-node24.sh node tools/analyze-sources.ts --data-root ../git-coin-data-view --json > ../analysis-14d.json
```

### 2. Read it

1. Gate (per source, over the full test): at least 98% of ticks with all 10 coins and HTTP 200, never more than 3 failed ticks in a row, stable id mapping, at most 1% HTTP 429 or block. A source that fails the gate is out.
2. Score of the sources that pass, in this order: availability, deviation from the consensus of the other sources (judge the stability of the offset), freshness, latency, requests per run.
3. Terms: write each source's terms status next to its result (ADR 0002 Revision 2, point 9). A source with an explicit prohibition (Coinbase) needs your decision before production: accept the risk in writing, get permission, or take the next source. Add the Kraken answer (item 7) and the Coin Metrics answer (item 7b) if they came.
4. If fewer than two sources pass, use the reserves in the order CoinGecko Demo, CoinMarketCap Basic, Coinranking. You create the key and add it as a repository secret (ADR 0009 D2).

### 3. Choose and switch

1. Tell the orchestrator your choice and give it `analysis-14d.md`. It writes ADR 0002 Revision 3 with the numbers and your choice, updates ADR 0004, 0005, 0007, 0009 and the index, and changes `config/coins.json` to `stored_sources: ["<chosen>"]`, `phase: "production"` and `features` with `alerts` and `publish` set to `true`.
2. Review that commit, then push it.
3. Dry run and first production run, as in G3 steps 2 and 3. Now the `publish` job runs. Check that the page opens at <https://borbiuk.github.io/git-coin/>, that it names the chosen source under the chart and shows a fresh "last updated" time.
4. Open the page on a phone, in light and dark mode (checklist item 11).
5. The rows of the other sources stay in `data` (append-only). The dashboard and the alerts read only the chosen source.
6. The README still says that the data is test data. The orchestrator updates it in the same change. Check the text after the switch.

After G4, the pilot and throwaway repos can be deleted (see the end of [throwaway/README.md](throwaway/README.md)). Deleting a repository is always the owner's step in the GitHub UI (Settings, Danger Zone). Agents have no `delete_repo` scope and the permission rules deny `gh repo delete`.

## If something goes wrong

- Stop the collector: `gh workflow disable collect.yml --repo borbiuk/git-coin`. Start it again with `gh workflow enable collect.yml --repo borbiuk/git-coin`.
- A bad row on `data`: do not rewrite history by hand. The writer is append-only on purpose (ADR 0004 D6). Ask the orchestrator for the options.
- The workflow was disabled by GitHub after 60 days without activity: enable it again with the command above (ADR 0005 D7).
- Failed-run emails go to the account that last edited the `cron` line. Commit changes to the schedule as yourself.
