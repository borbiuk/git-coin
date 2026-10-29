# Security Policy

## Supported Versions

Only the latest commit on the `main` branch is supported with security fixes. There are no releases.

| Version     | Supported          |
| ----------- | ------------------ |
| `main`      | :white_check_mark: |
| Older state | :x:                |

## Reporting a Vulnerability

Please report a vulnerability **privately**, not in a public issue:

1. Open <https://github.com/borbiuk/git-coin/security/advisories/new> (GitHub private vulnerability reporting).
2. Include as much information as possible:
    - Description of the issue
    - Steps to reproduce
    - Potential impact
    - Suggested fix (if available)

Do not publish the details before the issue has been reviewed and fixed. A problem that is not a vulnerability (a wrong price, a missing coin, a late run) belongs in a normal [issue](https://github.com/borbiuk/git-coin/issues).

### What is in scope

git-coin has no server, no user accounts and no secrets (version 1 uses no API keys). These are examples of problems that matter:

- A workflow that can be made to run untrusted text, or to leak the `GITHUB_TOKEN`.
- A workflow permission that is wider than the job needs.
- A way to make the collector write outside the `data` branch, delete stored rows or publish text that comes from an outside source.
- Script or markup injection in the dashboard.
- A secret, a token or personal data in the repository or its history.

Prices that are wrong or late because a data source is wrong or late are not vulnerabilities. See [SUPPORT.md](.github/SUPPORT.md).

### Response Process

1. The report is reviewed as soon as possible and the reporter gets an answer in the advisory. There is no promised response time: this is a one-maintainer project.
2. If the vulnerability is confirmed, a fix is prepared and merged into `main`.
3. After the fix is available, the advisory is published and names the fix.
