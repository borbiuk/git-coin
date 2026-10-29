# ADR 0008: Dashboard stack and metrics

- Status: Proposed
- Date: 2026-10-29
- Scope: static page technology, chart library, whether a build step is needed, data loading and caching, first-version metrics, later metrics, mobile, dark mode, accessibility, disclaimer.

Source grades: [A] official docs or registry, [B] own measurement, [C] first-hand report, [D] blog or vendor.

## Context

A static page on GitHub Pages shows the price history of up to 10 coins. Raw data lives on the `data` branch (ADR 0004). The collector workflow builds a small set of JSON files and deploys Pages in the same run (ADR 0005). One owner maintains it. The site is free, ad-free and read-only (ADR 0001).

## Decision Drivers

1. No build toolchain to maintain (no npm tree, no bundler).
2. Fast on a phone. Small payload.
3. Works from derived, downsampled data. No 100,000-point charts.
4. Honest about stale and missing data.
5. Dark mode and basic accessibility.

## Facts

### Chart libraries [B] unless marked

Sizes were measured on the minified single-file builds from jsDelivr with `gzip -9`. Real transfer is a few percent larger. Versions and dates are from the npm registry on 2026-10-29. [A]

| Library            | Version             | Licence    | Size gzip           | Notes                                                                                                                                                                                      |
| ------------------ | ------------------- | ---------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| uPlot              | 1.6.32 (2025-03-14) | MIT        | 22 KB (+0.8 KB CSS) | last npm release is 19 months old, last commit 2026-10-27; canvas; no built-in drag-pan; touch zoom needs a plugin; no animations                                                          |
| lightweight-charts | 5.2.1 (2026-08-12)  | Apache-2.0 | 62 KB               | TradingView; a NOTICE and a link to https://www.tradingview.com/ are required; the default logo satisfies the link rule; touch drag is on by default; pinch is not documented (UNVERIFIED) |
| Chart.js           | 4.6.1 (2026-10-22)  | MIT        | 71 KB               | needs a date adapter for time axes (not measured); decimation plugin; accessibility guide (`role="img"`, `aria-label`)                                                                     |
| Observable Plot    | 0.6.17              | ISC        | 69 KB + d3 92 KB    | not a fit                                                                                                                                                                                  |
| ECharts            | 6.1.0               | Apache-2.0 | 368 KB (full)       | has sampling and an `aria` option; custom builds are smaller (not measured)                                                                                                                |
| Plotly             | 4.1.2               | MIT        | 1,476 KB            | too big                                                                                                                                                                                    |

- No library follows `prefers-color-scheme` on its own as far as I read. Each needs colours from CSS variables or options (UNVERIFIED per library).
- I did not run a rendering benchmark with 100,000 or more points. The only numbers are vendor claims (uPlot README: 166,650 points cold start 25 ms, author's machine, 2023). UNVERIFIED independently.
- One coin at 5-minute data for one year is 105,120 points. Ten coins is about 1.05 million. Any library needs downsampling.

### Frameworks [A]

- Versions on 2026-10-29: Vite 8.3.5, Svelte 5.57.3, Astro 7.4.4, React 19.3.1, Observable Framework 1.13.4 (no release for 8 months), Evidence (active). Observable Framework and Evidence need a Node build. GitHub's own git-scraping product "Flat Data" is archived (the GitHub API shows `archived: true`).

### Loading data [B] (HTTP headers observed with `curl -I`)

- GitHub Pages: `access-control-allow-origin: *`, `cache-control: max-age=600`, gzip, ETag.
- `raw.githubusercontent.com`: `cache-control: max-age=300`, CORS `*`, `content-type: text/plain`. GitHub added rate limits for unauthenticated requests to raw files in 2025 (changelog 2025-05-08); many 429 reports; numbers not published. [A]/[C]
- Actions terms say not to use Actions "as a content delivery network", and AUP section 9 allows throttling of file hosting that is "significantly excessive in relation to other users of similar features". No sentence bans raw URLs as a CDN. [A]
- Parse cost (Node 26 on a Mac, not a phone) for one coin-year at 5 minutes (105,120 rows): CSV 25 ms, JSON array of pairs 12 ms, columnar JSON 2.4 ms. After gzip all row formats are about 0.7 MB. [B]

## Considered Options

### Stack

| Option                                                                         | Pros                                                        | Cons                                                        |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------- |
| Plain HTML + CSS + about 150 lines of JS + one vendored chart library (chosen) | no npm, no bundler, nothing to update but the Actions; tiny | manual vendoring of the chart file                          |
| Vite and plain JS                                                              | dev server, imports                                         | npm tree, Dependabot noise, a build in the job              |
| Svelte, React, Astro                                                           | components                                                  | a toolchain for one chart page; more churn                  |
| Observable Framework or Evidence                                               | data loaders, rich                                          | Node build; slow-moving (Framework) or SQL stack (Evidence) |

### Chart library

| Option             | Verdict                                                                       |
| ------------------ | ----------------------------------------------------------------------------- |
| uPlot              | chosen for v1: smallest, MIT, no attribution, fast                            |
| lightweight-charts | good later for candlesticks and built-in touch; needs TradingView attribution |
| Chart.js           | fine, 3 times larger; stronger accessibility docs                             |
| ECharts, Plotly    | too large                                                                     |

## Decision Outcome

### D1. No build step for the front end

- Static files: `site/index.html`, `site/app.js`, `site/lib.js`, `site/style.css`, the logo `site/logo.svg`, the favicon `site/favicon.svg`, and `site/vendor/` with the minified uPlot file, its CSS and its licence. Record the vendored version in a comment at the top of `app.js`. Dependabot cannot update vendored files. Update by hand when needed (checklist item).
- The data build is only a Node step (the same TypeScript code base as the collector) in the `publish` job (ADR 0005). It reads `data/raw` and writes derived JSON into the Pages artifact. No JavaScript bundler.

### D2. Derived data in the Pages artifact

```text
data/status.json            last point time, last run, failures, last publish, per-coin status
data/latest.json            latest price, 24h / 7d / 30d change, high and low per period, per coin
data/alerts.json            last 10 alerts (coin, time, direction, severity, Issue number); severity is `high` (the Issue label `warning`) or `extreme` (`critical`)
data/coins/<ID>.7d.json     last 7 days at full resolution
data/coins/<ID>.sources.json  last 7 days at full resolution for each stored source (only while more than one source is stored)
data/coins/<ID>.90d.json    last 90 days, hourly last-price points
data/coins/<ID>.daily.json  all history, daily open/high/low/close
```

- Series are columnar JSON arrays (`t` as epoch seconds, `p` as numbers) for the smallest payload. Prices on the page are display numbers. The exact source strings stay in the CSV files.
- The page draws the source comparison from `<ID>.sources.json` and hides it when that file is missing or holds fewer than two sources. Coin Metrics data carries its credit next to that chart.
- Gaps are kept as gaps (no interpolation). The chart breaks the line when a gap is longer than 3 times the median spacing.
- Size estimate (UNVERIFIED, my arithmetic): one coin has about 672 + 2,160 + 1,825 points after 5 years, about 60 KB raw and about 25 KB gzip. A visitor loads only the coin and range they open.
- The page uses same-origin Pages JSON. It never loads from `raw.githubusercontent.com`.

### D3. Caching

- Pages serves `max-age=600` with an ETag. The page fetches data with `cache: 'no-cache'` so the browser revalidates with the ETag (a 304 is cheap) and the user sees the newest deploy.
- The published page shows the `last_point_at` time, not the deploy time.

### D4. First version (v1) metrics

1. Latest price per coin, with 24h, 7d and 30d change (sign and arrow, not colour only).
2. High and low for 24h and 7d (and 30d).
3. Price chart with a range selector: 24h, 7d, 30d, 90d, All (uses the 7d file, the 7d file, the 90d file, the 90d file, the daily file).
4. Data freshness: "Last updated 14:03 UTC (12 minutes ago)". Banner "Data is delayed" if older than 120 minutes, "Collector appears stopped" if older than 6 hours (ADR 0005 D6). Banners use `role="status"`.
5. Labels: "Source: Kraken. Quote: USD. Cross-checked against CoinGecko" with links. If CoinGecko data is ever shown, add "Data provided by CoinGecko" next to it.
6. The list of the last 10 alerts with links to their Issues.
7. Disclaimer, visible without scrolling on a phone (footer is not enough): "Not financial advice. Prices may be delayed, missing or wrong. Data comes from public sources and is shown as is."
8. Expected freshness note: "Updated about every 15 to 30 minutes when GitHub runs on time. Runs can be late by hours."

### D5. Later list (not in v1)

- Multi-coin comparison, normalised to 100 at the start of the range.
- Volatility (standard deviation of hourly returns) and drawdown from the period high.
- Daily candles view (candlesticks may justify lightweight-charts and its attribution).
- Alert markers on the chart (read `alerts.json`).
- CSV download of the shown range.
- Manual light/dark toggle. Zoom and pan.

### D6. Mobile, dark mode, accessibility

- Mobile first: one column, 16 px side gutters, no horizontal page scroll, chart height from the viewport, tap targets at least 44 px. Range buttons replace zoom (uPlot has no built-in touch pan).
- Dark mode: CSS variables on `:root`, redefined under `prefers-color-scheme: dark`. The chart reads its colours from the CSS variables and redraws when the scheme changes.
- Accessibility: contrast at least 4.5:1; all controls reachable by keyboard with visible focus; the chart canvas has `role="img"` and an `aria-label` with a one-sentence summary; a `<table>` of the latest values carries the same facts as text; up and down are shown with sign and arrow, not colour alone; banners use `role="status"`.
- The page needs no cookies, no analytics and no third-party requests. External links go to Kraken, CoinGecko and the repo.

## Consequences

- Good: a tiny site (about 22 KB of library plus about 150 lines) and no toolchain.
- Good: the client never parses large series.
- Bad: vendored uPlot is not updated by Dependabot. Its last npm release is 19 months old. The fallback is Chart.js or lightweight-charts. Planned replacement path: both are drop-in for line charts with the same data files.
- Bad: no touch zoom in v1. Range buttons cover it. Check on a real phone.
- Bad: the dashboard depends on the collector's build step (derived files). A bug there breaks the page, not the data.
- Bad: dark-mode and accessibility details per library were not verified from docs. Test the page.

## Sources (access date for all: 2026-10-29)

- https://github.com/leeoniya/uPlot and https://raw.githubusercontent.com/leeoniya/uPlot/master/README.md [A] (benchmark is the author's claim)
- https://github.com/tradingview/lightweight-charts and https://tradingview.github.io/lightweight-charts/docs [A]
- https://www.chartjs.org/docs/latest/general/performance.html and /accessibility.html [A]
- https://echarts.apache.org/en/changelog.html [A]
- https://plotly.com/javascript/webgl-vs-svg/ [A]
- npm registry and jsDelivr dist files for sizes and versions [A]/[B]
- https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits [A]
- https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages [A]
- https://github.blog/changelog/2025-05-08-updated-rate-limits-for-unauthenticated-requests/ [A]
- https://github.com/orgs/community/discussions/159123 [C]
- https://github.com/githubocto/flat (archived, GitHub API) [B]
- HTTP headers from leeoniya.github.io, mdn.github.io and raw.githubusercontent.com [B]

## Open Questions

1. Does uPlot's tooltip (cursor) work well on touch screens? Test on a phone.
2. Rendering time on a low-end phone for a 90-day hourly series (about 2,200 points). Expected to be fine, not measured.
3. Keep uPlot (MIT, tiny, little recent releases) or choose Chart.js (bigger, more active)?
4. Do we need a custom domain or a `robots.txt`? Not decided. Out of scope.
