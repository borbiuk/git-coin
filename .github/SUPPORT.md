# Support

## Questions and problems

- **Something does not work** (a wrong price, a missing coin, a broken page, a failed run): open a [bug report](https://github.com/borbiuk/git-coin/issues/new?template=bug_report.md). Before you do, read the section "The data is late" below.
- **An idea, a new coin or a new source**: open a [feature request](https://github.com/borbiuk/git-coin/issues/new?template=feature_request.md).
- **A security problem**: do not open an issue. Follow [SECURITY.md](../SECURITY.md).
- **How it works and why**: the [decision records](../docs/adr/0000-index.md) and the [README](../README.md).

## What is supported

- The collector, the `data` branch, the dashboard and the alerts of this repository, in the state of the `main` branch ([SECURITY.md](../SECURITY.md)).
- Ten coins in USD (the list is in `config/coins.json`).
- Running it yourself: Node.js 24.22.1 and the commands in [CONTRIBUTING.md](CONTRIBUTING.md).

There is no support for using the prices to trade. The prices come from third-party sources, are provided as is, and are not financial advice (see the disclaimer in the [README](../README.md)).

## The data is late

GitHub runs scheduled workflows late, and sometimes skips them. A gap in the data, or a dashboard that says "delayed" or "stopped", is often this and not a bug. Look at the Actions tab first: if the `collect` workflow has not run for hours, GitHub did not start it. Runs of a source that fails are logged in the request log on the `data` branch. Please add the run link and the time (UTC) to a bug report.

A fix is released as a normal change to `main`. There is no promised response time.

## During the test period

For the first 14 days four price sources are stored side by side, and the data is test data. Differences between the sources are expected. The dashboard and the alerts start after one source is chosen (see the [README](../README.md)).
