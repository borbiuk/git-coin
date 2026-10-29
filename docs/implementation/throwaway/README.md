# Throwaway tests (gate G2)

These workflows turn the guesses in the ADRs into measurements. They run on GitHub, in **throwaway public repositories** on the `borbiuk` account, never in `borbiuk/git-coin`. Each file starts with a header comment: purpose, how to run, what to record, how to read the result. This page is the order of work and the shared commands.

The checklist items are in [pre-implementation-checklist.md](../../adr/pre-implementation-checklist.md). The gates are in [plan.md](../plan.md), section 7.

## What is in this folder

| File                   | Checklist item | Trigger                                    | What it answers                                                             |
| ---------------------- | -------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| `pilot-5m.yml`         | 4              | schedule `2,7,12,...,57 * * * *`           | How many runs does GitHub deliver for a 5-minute cron on this account?      |
| `pilot-15m.yml`        | 4              | schedule `3,18,33,48 * * * *`              | Same for the default cron of ADR 0005. Also has the concurrency check.      |
| `pilot-30m.yml`        | 4              | schedule `7,37 * * * *`                    | Same for the fallback cron.                                                 |
| `analyze-pilot.mjs`    | 4              | run by hand                                | Delivery table and the ADR 0005 D1 decision rule from the three CSV logs.   |
| `pages-test.yml`       | 2              | schedule every 3 hours, manual             | Does a public repo on the Free plan deploy Pages from a scheduled run?      |
| `probe.yml`            | 3              | manual, schedule 12 times a day            | Are the four sources (and CoinGecko) reachable from a runner? All 10 coins? |
| `issue-email-test.yml` | 5              | manual, schedule (only if the flag is set) | Does a bot-created Issue email the owner? Does a failed run email?          |
| `bot-push-test.yml`    | 6 a to f       | manual                                     | Does the bot push to an orphan `data` branch under rulesets?                |
| `canary.yml`           | 9              | schedule daily                             | Does a bot commit keep scheduled workflows alive after 60 days?             |

Every job has `if: github.repository != 'borbiuk/git-coin'`, so a file copied into the real repository by mistake does nothing. The workflows use no secrets. Actions are pinned by full SHA where the ADRs give one. UNVERIFIED: the SHA of `actions/upload-pages-artifact` is not in the ADRs, so `pages-test.yml` uses the tag `v5.0.0`. Do not turn on "require full-SHA pinning" in the throwaway repos.

## Which repository gets which files

| Repository                              | Files                                                                      | Why separate                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `borbiuk/git-coin-pilot`                | `pilot-*.yml`, `analyze-pilot.mjs`                                         | Other scheduled workflows in the same repo could change the delivery numbers. Nothing else goes here. |
| `borbiuk/git-coin-throwaway`            | `pages-test.yml`, `probe.yml`, `issue-email-test.yml`, `bot-push-test.yml` | Items 2, 3, 5 and 6. The `data` branch and the rulesets live here.                                    |
| `borbiuk/git-coin-canary-a`, `-b`, `-c` | `canary.yml` (the same file in each)                                       | The 60-day rule looks at activity of the whole repo, so each variant needs its own repo.              |

You can put the pilot and the throwaway files into one repo if you accept that the pilot numbers may be disturbed. The canaries must stay separate.

## Shared setup

Use the `borbiuk` account for every command. Do not run `gh auth switch`.

```bash
export GH_TOKEN=$(gh auth token --user borbiuk)
# The folder with these files in your clone of git-coin
export T=~/projects/git-coin/docs/implementation/throwaway
```

Commit and push as yourself, not through a bot. The account that last edits a `cron` line gets the failed-run emails (ADR 0005 D6).

## Step 1: start the pilot first (item 4, about 10 minutes, then 72 hours of waiting)

The 72 hours are the longest wait before gate G3, so start here. A weekend inside the window is better.

```bash
cd ~/projects        # any folder outside your clone of git-coin
gh repo create borbiuk/git-coin-pilot --public --description "Throwaway schedule pilot for git-coin (delete after the pilot)" --clone
cd git-coin-pilot
mkdir -p .github/workflows
cp "$T"/pilot-*.yml .github/workflows/
cp "$T"/analyze-pilot.mjs .
git add .
git commit -m "Add the schedule pilot"
git branch -M main
git push -u origin main
date -u +%Y-%m-%dT%H:%M:%SZ   # write this time down: it is the --from value of the analysis
```

Check the Actions tab: the three workflows are listed. Start one manual run of each (Run workflow) to see that a row reaches the branches `pilot-5m`, `pilot-15m` and `pilot-30m`. Manual rows are ignored by the analysis. Then do not touch the repo for 72 hours.

Optional, after the 72 hours: the concurrency check in the header of `pilot-15m.yml` (open question 3 of ADR 0005).

### Read the pilot result

```bash
cd ~/projects/git-coin-pilot
git fetch origin pilot-5m pilot-15m pilot-30m
for w in 5m 15m 30m; do git show origin/pilot-$w:pilot-$w.csv > pilot-$w.csv; done
node analyze-pilot.mjs pilot-5m.csv pilot-15m.csv pilot-30m.csv --from <the time you wrote down>
```

The script prints runs per day, the gap median, p90 and maximum, the share of ticks delivered, and the result of each line of the ADR 0005 D1 rule. It does not choose. To cross-check against GitHub's own run list (this also shows cancelled runs):

```bash
gh run list --workflow pilot-15m.yml --event schedule --limit 400 --json conclusion --jq 'group_by(.conclusion) | map({conclusion: .[0].conclusion, runs: length})'
```

Put the table into ADR 0005 and confirm or change the default cron. If all three workflows deliver about 5 runs per day, stop and decide about an outside trigger (ADR 0005 D9).

## Step 2: the other tests (while the pilot runs)

```bash
cd ~/projects
gh repo create borbiuk/git-coin-throwaway --public --description "Throwaway tests for git-coin (delete after the tests)" --clone
cd git-coin-throwaway
mkdir -p .github/workflows
cp "$T"/pages-test.yml "$T"/probe.yml "$T"/issue-email-test.yml "$T"/bot-push-test.yml .github/workflows/
git add .
git commit -m "Add the throwaway tests"
git branch -M main
git push -u origin main
```

Run `gh workflow list` in that repo to confirm that the four workflows are there. A workflow with `schedule` appears after the push. A workflow that only has `workflow_dispatch` can be run from the Actions tab at once.

### Item 2: Pages (`pages-test.yml`)

1. Set the Pages source to GitHub Actions: Settings, Pages, Source. Or with the API: `gh api -X POST repos/borbiuk/git-coin-throwaway/pages -f build_type=workflow`.
2. Run the workflow by hand (Run workflow). Open the URL from the `deploy` job. The page shows the time and the event.
3. Check the headers (the response must be gzip and `max-age=600`):

    ```bash
    curl -sI -H 'Accept-Encoding: gzip' https://borbiuk.github.io/git-coin-throwaway/ | grep -i -E '^(HTTP|content-encoding|cache-control|server|last-modified)'
    ```

4. Wait for a scheduled run (every 3 hours, it may be late). The page must show `event: schedule`. If the scheduled run fails at the `github-pages` environment, note the message: the default branch rule is the likely cause.

Record: both runs green, the headers, the date and the run links. Add the result to ADR 0005 and ADR 0008.

### Item 3: source probe (`probe.yml`)

1. Run it by hand two or three times (Run workflow, keep CoinGecko on). Read the job log: one block per request with `PROBE_RESULT` (status, milliseconds, bytes) and `PROBE_COVERAGE` (coins found).
2. The schedule runs 12 times a day at different hours, three of them at minute 0. After 24 to 36 hours turn it off with `gh workflow disable probe.yml --repo borbiuk/git-coin-throwaway`.
3. Collect the results of all runs:

    ```bash
    for id in $(gh run list --workflow probe.yml --repo borbiuk/git-coin-throwaway --limit 40 --json databaseId --jq '.[].databaseId'); do
        gh run view "$id" --repo borbiuk/git-coin-throwaway --log
    done > probe-logs.txt
    grep -h 'PROBE_RESULT' probe-logs.txt | sed 's/.*PROBE_RESULT,//' > probe-results.csv
    grep -h 'PROBE_COVERAGE' probe-logs.txt | sed 's/.*PROBE_COVERAGE,//' | sort | uniq -c
    printf '%-28s %6s %6s %6s %8s\n' request calls 200 429 'avg ms'
    awk -F, '{n[$2]++; if ($3 == 200) ok[$2]++; else if ($3 == 429) r[$2]++; ms[$2] += $4}
        END {for (l in n) printf "%-28s %6d %6d %6d %8d\n", l, n[l], ok[l], r[l], ms[l] / n[l]}' probe-results.csv | sort
    ```

Pass (checklist item 3): for each test source, record the 200 rate and the 429 rate, and confirm that all 10 coins come back. A source that is blocked from the runner drops out of the test. If fewer than two of the four work, stop and reopen ADR 0002. Also record the Kraken result keys for the 10 pairs (the `PROBE_KRAKEN_KEYS` lines), whether `AssetPairs` gives `altname` and `wsname`, the Coin Metrics rate-limit headers, and the Node version and image of the runner (checklist item 12).

### Item 5: Issue email (`issue-email-test.yml`)

Use the real notification settings of the account: Watching and Participating by email on, Actions set to "Only notify for failed workflows".

1. Run the workflow with `variant` = `all`. It creates three Issues: plain, with a mention, and with an assignee plus a mention. The title has the UTC time. Write down which emails arrive and when. Close the test Issues afterwards.
2. Failed run, manual: run the workflow with `variant` = `fail`. The email goes to you (you triggered it).
3. Failed run, scheduled: set the flag with `gh variable set EMAIL_TEST_FAIL --body true --repo borbiuk/git-coin-throwaway`. The next scheduled run (every 3 hours) fails on purpose. Check that the email goes to the account that last edited the cron line. Then delete the flag: `gh variable delete EMAIL_TEST_FAIL --repo borbiuk/git-coin-throwaway`.

Pass: variant (c) arrives within a few minutes. Note which variants fail. If none arrive, do not build the alert step as designed. Reopen ADR 0006 (second channel).

### Item 6: bot push (`bot-push-test.yml`)

Prepare the repo once. The `data` branch is an orphan branch. The ruleset blocks force pushes and deletion on `data` and on the default branch, with no required pull requests (ADR 0009 D4).

```bash
cd ~/projects/git-coin-throwaway
git switch --orphan data
git commit --allow-empty -m "Start the data branch"
git push -u origin data
git switch main

gh api repos/borbiuk/git-coin-throwaway/rulesets --method POST --input - <<'JSON'
{
  "name": "protect-data-and-default",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/data", "~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [{ "type": "deletion" }, { "type": "non_fast_forward" }]
}
JSON
```

Then run the workflow from the Actions tab, one check at a time (input `check`):

| `check`         | Item | What it does                                                                | Pass when                                                               |
| --------------- | ---- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `a-push`        | 6a   | Appends a line to `data` and pushes it as `github-actions[bot]`.            | The push works under the ruleset.                                       |
| `c-race`        | 6c   | A second writer pushes first. The first writer retries (reset, redo, push). | Both lines are on `data`, none lost, none doubled.                      |
| `e-keepalive`   | 6e   | Makes an empty commit on the default branch and pushes it.                  | The push is allowed.                                                    |
| `f-author`      | 6f   | Prints the author of the last bot commit as the GitHub API shows it.        | You copy the email into ADR 0001, open question 4.                      |
| `d-force-push`  | 6d   | Tries a force push to `data`.                                               | The push is rejected. If it succeeds, the ruleset is missing.           |
| `b-concurrency` | 6b   | Holds the run for 3 minutes. Start it three times in a row.                 | One run is running, one is pending, the third replaces the pending one. |

Run `d-force-push` only after the ruleset exists: without it, the force push replaces the `data` branch of the throwaway repo (nothing of value is lost, but the check then says nothing). Item 6 is done when all six behave as designed, or the ADRs are changed.

## Step 3: the 60-day canary (item 9)

Start it the day the pilot starts. Three repos, one variant each. The same `canary.yml` goes into all three, and a repository variable chooses the variant:

| Variant | The bot commits to        | After 60 days                                                    |
| ------- | ------------------------- | ---------------------------------------------------------------- |
| A       | the default branch        | Still enabled means a bot commit on the default branch counts.   |
| B       | only a non-default branch | Disabled while A is enabled means a non-default commit does not. |
| C       | nothing                   | Disabled shows that the rule exists at all.                      |

```bash
cd ~/projects
for v in a b c; do
    gh repo create borbiuk/git-coin-canary-$v --public --description "Throwaway canary for git-coin (delete after the test)" --clone
    (
        cd git-coin-canary-$v
        mkdir -p .github/workflows
        cp "$T"/canary.yml .github/workflows/
        git add .
        git commit -m "Add the canary"
        git branch -M main
        git push -u origin main
    )
    gh variable set CANARY_VARIANT --body "$(echo $v | tr a-z A-Z)" --repo borbiuk/git-coin-canary-$v
done
date -u +%Y-%m-%d   # write the start date down
```

Make no commit by hand in these repos after the first push. After 61 days read the state of each workflow:

```bash
for v in a b c; do
    echo "canary-$v"
    gh api repos/borbiuk/git-coin-canary-$v/actions/workflows --jq '.workflows[] | [.name, .state] | @tsv'
done
```

`active` is enabled. `disabled_inactivity` is the 60-day rule. Add the result to ADR 0005 D7. Until then, keep the keepalive step in the design.

## After the tests

Delete the pilot and throwaway repos when the results are in the ADRs (the canaries stay for 61 days): `gh repo delete borbiuk/git-coin-pilot --yes` (needs the `delete_repo` scope: `gh auth refresh -s delete_repo`). The next steps (gates G1, G3 and G4) are in the [runbook](../runbook.md).
