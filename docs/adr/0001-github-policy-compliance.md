# ADR 0001: GitHub policy compliance and public-repo implications

- Status: Proposed
- Date: 2026-10-29
- Scope: Terms, policies and limits of GitHub that apply to a public repo with a scheduled bot, a public Pages dashboard and automated Issues.

Source grades used in all ADRs:

- [A] Official GitHub or vendor documentation, changelog or repo.
- [B] My own measurement (API calls, local tests). Method is written next to the number.
- [C] First-hand user report (community thread, issue, README).
- [D] Blog, vendor marketing, news. Not used alone for a decision.

Method warning: the policy pages were read through a text extractor, not as raw HTML. Short quotes are probably exact. Check the wording on the live page before you quote it in public. This is listed in the pre-implementation checklist.

## Context

The project fetches crypto prices on a schedule in GitHub Actions, commits them to a public repo, shows them on GitHub Pages, and opens Issues on sharp moves. The repo is public (fixed decision). The owner wants the highest collection frequency that stays inside the GitHub Terms of Service (ToS), Acceptable Use Policies (AUP), the Additional Product Terms (ATF) and Actions limits.

## Decision Drivers

- No rule violation that could disable the repo, the workflow or the account.
- No budget. Free plan only.
- Policy text is vague about "excessive" use. We need a conservative design, not a guess.
- One owner. Low maintenance.

## Facts (with sources)

### F1. Scheduling and frequency

- Minimum cron interval is 5 minutes. Quote: "The shortest interval you can run scheduled workflows is once every 5 minutes." [A]
- Schedules can be late or dropped. Quote: "The `schedule` event can be delayed during periods of high loads of GitHub Actions workflow runs. High load times include the start of every hour." and "some queued jobs may be dropped". [A]
- Scheduled workflows run only on the default branch, on its latest commit. [A]
- Push guidance (recommended, not enforced): "The recommended maximum limit is 6 pushes per minute per repository." [A] A 15-minute schedule makes at most 0.07 pushes per minute. A 5-minute schedule makes 0.2.
- No policy text sets a cap on commit frequency or schedule frequency. I searched ToS, AUP and ATF. [A] (absence of a rule; the search was done through an extractor)
- Run history (runs, logs, artifacts) is kept 90 days by default. [A]

### F2. "Excessive" and "disproportionate" use

- AUP section 4 lists as abuse: "using our servers for any form of excessive automated bulk activity, to place undue burden on our servers through automated means". [A]
- AUP section 9: if bandwidth use is "significantly excessive in relation to other users of similar features", GitHub may suspend, throttle or limit the account. GitHub may also delete repos "placing undue strain on our infrastructure" after notice. [A]
- ATF, Actions: no use that places a burden on GitHub servers "disproportionate to the benefits provided to users". Also no use as a content delivery network or as part of a serverless application. Also on GitHub-hosted runners: no activity "unrelated to the production, testing, deployment, or publication of the software project". (The last quote was shortened by the extractor.) [A]
- No number defines "excessive". GitHub alone decides. ToS section H says for the API: "GitHub, in our sole discretion, will determine abuse or excessive usage of the API." [A]

### F3. Crypto

- Banned: "cryptocurrency mining" (AUP) and "Cryptomining" (ATF Actions). [A]
- Not found: any rule about price tracking, price data or crypto-related sites on Pages. [A] (absence)
- The Pages limits page says use is subject to the ToS "including restrictions on get-rich-quick schemes". A read-only price page is not that. Do not add buy/sell promotion. [A]

### F4. Bots, commits, Issues

- Machine accounts need a separate registration. We do not use one. Commits are made with the built-in `GITHUB_TOKEN` as `github-actions[bot]`. [A]
- No AUP rule on automated Issue creation in your own repo. The nearest rule (AUP section 10) bans "excessive bulk content" in issues of OTHER users' accounts, as advertising. [A]
- REST secondary limits: 80 content-generating requests per minute and 500 per hour; 900 points per minute; 100 concurrent requests. `GITHUB_TOKEN` primary limit is 1,000 requests per hour per repo. [A]

### F5. Pages

- Pages works on the Free plan for public repos. Quote: "the repository must be public". [A]
- Limits: published site 1 GB; source repo recommended 1 GB; soft bandwidth 100 GB per month; soft 10 builds per hour; deploy timeout 10 minutes. [A]
- The 10-builds-per-hour limit "does not apply if you build and publish your site with a custom GitHub Actions workflow". [A]
- Not allowed: running an online business, e-commerce, commercial SaaS; sensitive transactions (passwords, card numbers). [A]
- Opinion: a free, ad-free, read-only price dashboard fits none of the banned uses.

### F6. Actions billing and limits (Free plan, public repo)

- Quote: "GitHub Actions usage is free for standard GitHub-hosted runners in public repositories". Larger runners are billed. Use only standard runners. [A]
- For a private repo the Free plan includes $12 compute per month. At $0.006 per Linux 2-core minute that is about 2,000 minutes (my arithmetic). Each job is rounded up to a whole minute. [A]+[B]
- Job timeout default 360 minutes. Free plan: 20 concurrent jobs. 500 workflow runs queued per 10 seconds. [A]
- Real cost of one small run: 6 to 26 seconds for the whole job, 2 to 6 seconds waiting for a runner. Measured on 12 recent runs of 3 public repos. [B] (see ADR 0005)

### F7. Repository size

- "We recommend repositories remain small, ideally less than 1 GB, and less than 5 GB is strongly recommended." [A]
- The repository limits page says something different: `.git` recommended maximum 10 GB. Files over 50 MiB warn, over 100 MiB are blocked, a push is limited to 2 GB. [A]
- The two GitHub pages disagree. We use the stricter one (1 GB / 5 GB).
- No limit on commit count is stated. The Commits tab shows at most 10,000 commits. [A]

### F8. Public-repo facts

- Secret scanning, push protection and code scanning are "Available for public repositories by default". [A]
- Everything committed is world-readable and stays in history until history is rewritten. [A]
- Commit email format for privacy: `ID+USERNAME@users.noreply.github.com`. The setting "Block command line pushes that expose my email" exists. [A]
- The bot identity `41898282+github-actions[bot]@users.noreply.github.com` is widely used, but I did not find it on a GitHub docs page. UNVERIFIED on a primary page.
- Scheduled workflows are disabled by default in forks. [A]

### F9. 60-day rule

- Quote: "In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days." [A]
- "Repository activity" is not defined. Whether a bot commit with `GITHUB_TOKEN` counts is UNVERIFIED. One live repo (simonw/ollama-models-atom-feed, bot commits only, still running) suggests yes, but I could not exclude human activity. [B]/[C]
- The known keepalive action gautamkrishnar/keepalive-workflow is blocked by GitHub (reason "tos", checked with the API). Do not use it. [B]

### F10. Enforcement stories (how real is the risk?)

- Simon Willison's pge-outages repo reached over 40,000 commits from a scheduled scraper. No ban reported. [C]
- csm10495/commit-ment: GitHub support paused a repo after about 22 million commits and 5.5 TB. This is a joke repo at extreme scale. Far from our scale (about 35,000 commits per year at 15 minutes). [C]
- One report of account-level Actions disablement after heavy CI use (community discussion 184661), later lifted. Cause unconfirmed. [C]
- I found no report of a git-scraping repo flagged for commit frequency. This is absence of evidence only.

## Considered Options

### Option 1. Aggressive: 5-minute schedule, commit every run, deploy every run

- Pros: most data points when the platform delivers them.
- Cons: 3x more ticks and commits than 15 minutes for little extra data (see ADR 0005). More exposure to the vague "excessive" and "undue burden" clauses.

### Option 2. Moderate (chosen): 15-minute schedule at off-peak minutes, small jobs, raw data on a separate `data` branch, Pages deploy at most every 30 minutes

- Pros: 0.07 pushes per minute against a guidance of 6. Jobs take seconds. One concurrency group. Easy to justify as "not excessive".
- Cons: fewer points when the platform is healthy (at most about 20 percent fewer than the best case of a 5-minute schedule, see ADR 0005).

### Option 3. Conservative: 30-minute or hourly schedule

- Pros: lowest exposure. The only interval that also fits the Free private allowance (1,440 minutes per month).
- Cons: weak for "as often as possible". Kept as the fallback.

## Decision Outcome

Chosen: Option 2. Run the policy-compliance rules below.

1. Public repo, standard runner only (`ubuntu-26.04`, see ADR 0003). No larger runners, no self-hosted runners.
2. Schedule: default `3,18,33,48 * * * *` (every 15 minutes). Fallback `7,37 * * * *`. Never use minute 0. See ADR 0005.
3. Jobs stay short (target under 60 seconds, `timeout-minutes: 10`). One concurrency group. No matrix. No loops that wait.
4. Commit only valid data. Never commit error bodies, never commit empty or duplicate runs.
5. Pages: custom Actions deploy in the same workflow. Deploy at most once per 30 minutes (see ADR 0005). The dashboard loads data from the Pages origin, never from `raw.githubusercontent.com` (see ADR 0008).
6. Issues: sparse and deduplicated (see ADR 0006). The expected volume is below one new Issue per day.
7. The dashboard stays free, ad-free, read-only. No trading, wallet or login input. No "buy now" language. It shows a "not financial advice" line (see ADR 0008).
8. No crypto mining, no content hosting, no CDN-like use. The repo has one purpose: collect, store and show public prices.
9. Keep a written risk acceptance (this ADR): the clause "unrelated to the ... software project" is a grey area for git scraping. Many public projects do it, and GitHub's own (now archived) Flat Data product promoted the pattern. It is tolerated in practice, not permitted in explicit words. If GitHub disables the workflow, move the schedule to another host (see ADR 0005, escalation).

### What must never be committed (public repo)

- API keys, tokens, passwords, private keys, `.env` files, exchange account data. The design needs no keys. Keep it that way.
- The ntfy topic, Telegram token, SMTP password, webhook URLs (if ever added they live only in repo secrets).
- Personal data: the owner's real email or address in commits, logs or config; phone numbers; IP addresses; raw HTTP logs with headers.
- Large generated files, build output, `node_modules`, caches.
- Exchange response bodies other than minimal test fixtures (see ADR 0002 on data terms).
- Anything the data terms of a source forbid us to redistribute (see ADR 0002).

How to check it automatically:

- Keep secret scanning and push protection on (default for public repos). Verify in the checklist.
- `.gitignore` contains `.env*`, `*.pem`, `*.key`.
- CI job greps the diff for common key patterns only as a cheap extra (optional).
- Commit identity in CI is `github-actions[bot]` with its noreply email. The owner uses the GitHub noreply email locally and turns on "Block command line pushes that expose my email".

### Public-visibility risks

- Every price point, every alert and every config change is public and permanent. Rewriting history is possible but forks and caches keep copies.
- Anyone can fork. Forks have scheduled workflows disabled by default. If a fork owner turns them on, each fork runs its own collector from shared runner IPs. Guard every job with `if: github.repository == 'borbiuk/git-coin'`.
- Issues are public. Alert Issues show your price alerts to everyone. Do not put personal text in them. Public Issues can receive spam comments. Use repo moderation settings (limit interactions) if needed.
- Public Issues and Actions logs are indexed. Never print secrets or personal data in logs.
- Visitors and bots may load the dashboard many times. 100 GB per month of Pages bandwidth is a soft limit. Our data files are small (see ADR 0008).

## Consequences

- Good: a plain, defensible policy position. No numeric rule is broken. The design stays far below every published number (push rate, repo size, minutes).
- Bad: the vague clauses cannot be fully removed. GitHub can still act at its own discretion.
- Bad: data-source terms (ADR 0002) are a bigger legal risk than GitHub terms.
- Follow-up: a person must read the live policy pages again before the first public commit (checklist item).

## Sources (access date for all: 2026-10-29)

- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows [A]
- https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows [A]
- https://docs.github.com/en/site-policy/github-terms/github-terms-of-service [A]
- https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies [A]
- https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features [A]
- https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits [A]
- https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site [A]
- https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages [A]
- https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits [A]
- https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github [A]
- https://docs.github.com/en/billing/concepts/product-billing/github-actions [A]
- https://docs.github.com/en/billing/reference/actions-runner-pricing [A]
- https://docs.github.com/en/actions/reference/limits [A]
- https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api [A]
- https://docs.github.com/en/code-security/getting-started/github-security-features [A]
- https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection [A]
- https://docs.github.com/en/account-and-profile/reference/email-addresses-reference [A]
- https://simonwillison.net/2021/Mar/5/git-scraping/ [C]
- https://github.com/csm10495/commit-ment/ [C]
- https://github.com/orgs/community/discussions/184661 [C]
- https://github.com/gautamkrishnar/keepalive-workflow (API check: access blocked, reason "tos") [B]
- https://github.com/simonw/ollama-models-atom-feed (bot-only commits, API check) [B]

## Open Questions

1. Does a bot commit with `GITHUB_TOKEN` count as "repository activity" for the 60-day rule? Does a commit to a non-default branch count? (Mitigation in ADR 0005. Test in the checklist.)
2. Does GitHub tolerate a data-collecting scheduled workflow in the long run? No explicit statement exists.
3. Should the owner accept the grey-area risk in writing, or ask GitHub Support for confirmation? (The data-terms question is decided separately. The owner asked Kraken first, then decided on 2026-10-29 to use real data in the public repo without waiting for the answer. See ADR 0002 Revision 2.)
4. The bot's noreply email string: confirm on a GitHub docs page or by inspecting a real bot commit. Answered on 2026-10-29 by a real bot commit in a throwaway repo: `github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>` (login `github-actions[bot]`, id 41898282). See `docs/implementation/g2-results.md`.
