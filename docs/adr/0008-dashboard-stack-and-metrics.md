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
data/latest.json            latest price, 24h / 7d / 30d change, high and low per period, per coin; `quote` is the unit (D7)
data/alerts.json            last 10 alerts (coin, time, direction, severity, Issue number); severity is `high` (the Issue label `warning`) or `extreme` (`critical`)
data/coins/<ID>.7d.json     last 7 days at full resolution
data/coins/<ID>.sources.json  last 7 days at full resolution for each stored source (only while more than one source is stored)
data/coins/<ID>.90d.json    last 90 days, hourly last-price points
data/coins/<ID>.daily.json  all history, daily open/high/low/close
```

- Series are columnar JSON arrays (`t` as epoch seconds, `p` as numbers) for the smallest payload. Prices on the page are display numbers. The exact source strings stay in the CSV files.
- The page draws the source comparison from `<ID>.sources.json` and hides it when that file is missing or holds fewer than two sources. Coin Metrics data carries its credit next to that chart.
- Gaps are kept as gaps (no interpolation). The chart breaks the line when a gap is longer than 3 times the median spacing.
- Missed runs (changed 2026-10-30): the collector fills the time of a missed run with Bitstamp candles (ADR 0005 D8). The builder keeps those candles and writes `filled` into the `7d` and `90d` files: a list of `[from, to]` spans in epoch seconds, each from the last live sample before the candles to the first live sample after them. The field is absent when there is none. The chart draws a shaded band with the label "No scheduled run" over every span, and keeps the hatched band "No data" for time that has neither a live row nor a candle. The text under the chart explains both bands. A candle within 5 minutes of a live sample is left out. The daily file and the multi-coin chart do not show the bands.
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
7. Disclaimer, visible without scrolling on a phone (footer is not enough): "Not financial advice. Prices may be delayed, missing or wrong." The rest ("Data comes from public sources and is shown as is.") is in the "About this data" block (D8).
8. Expected freshness note: "Updated about every 15 to 30 minutes when GitHub runs on time. Runs can be late by hours." It is in the "About this data" block (D8).

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

### D7. Prices are shown in USDT (2026-10-30)

- The owner asked for USDT. Decision: convert at build time. The data stays in USD. `config/coins.json` has one more entry, `USDT` with `"role": "rate"`, that the collector fetches like a coin (Kraken `USDTUSD`, Coinbase `USDT-USD`, Bitstamp `usdtusd`, Coin Metrics `usdt`). The site builder divides every price by the rate nearest in time (at most 24 hours away, else the point is dropped) and writes the result with 12 significant digits. `latest.json` has `"quote": "USDT"`. The rate entry itself gets no file and no tab, and its alerts must be off (the config check enforces it).
- The page reads `quote` from `latest.json`. The unit is written once (next to the big price and in the headings of the tables, D8), not after every number. The chart axis has no unit name. The footer and the screen reader texts name the unit.
- Cost: 11 entries per run, so 44 rows per run in the test phase and one more Coinbase request (11 instead of 10). The other sources still need one request. The change was measured against the live sources on 2026-10-30: all four returned the rate (a dry run wrote 44 rows).
- Alerts do not change. They read the stored USD rows and use percent moves, which the conversion would change only by the move of the rate itself.
- History (2026-10-30): rows with `src=bs-ohlc` (15-minute Bitstamp candles from 2024-01-01 to 2026-10-28, written once by `tools/backfill-bitstamp.ts`) fill the time before the first live row of the primary source. The builder joins them per entry (the rate entry too), and converts the joined series like any other. A history row after the first live row is a candle of a missed run: it is kept (ADR 0004 D3, missed runs), unless a live sample is within 5 minutes. `latest.json` then has `history: { src, until }` and the page says where the older prices come from. Kraken and Bitstamp differ by a few hundredths of a percent, so the join shows no visible step. The 24h change stays empty while the data has a gap near 24 hours ago (the live rows start at 2026-10-29T20:46Z).
- To go back to USD, set `enabled` to `false` on the rate entry. The builder then writes `"quote": "USD"`.
- Considered and not chosen:
    - Real USDT markets for the price. UNVERIFIED for runners, but the catalogues of 2026-10-30 show too few pairs: Kraken lists 9 of 10 coins (no XLM), Coinbase 8 (no BNB, LTC), Bitstamp 3 (BTC, ETH, XRP). Coin Metrics reference rates are in USD only. This would break the four-source test.
    - USDC instead of USDT: Coinbase has 3 of 10 USDC pairs and Bitstamp 4. As a conversion rate it would work the same way (`USDCUSD` exists on Kraken and Bitstamp, not on Coinbase).
    - Only a relabel from USD to USDT. It would be wrong: the two differ (USDT was 0.99885 USD on Coin Metrics on 2026-10-29).
- Open: the rate follows the primary source. If the primary source has no `USDT` row for a day, the prices of that day are missing from the page (a gap), not shown in USD.

### D8. UX revision (2026-10-30)

An audit of the live page on a phone (375 px and 320 px) and a research of 10 topics (chart types, ranges, touch, colour, hierarchy, sparklines, gaps, number formats, performance, theming) gave these changes. No new data files and no new library.

- First screen on a phone: the disclaimer is one line. The source note and the update note moved into a closed "About this data" block (a `<details>`), so the price and the stats come into view. The "Source comparison" is a closed `<details>` too.
- Tables on a phone never scroll sideways: the stats table has no unit in its cells, and the table of all coins turns into cards (name, a line of the last 7 days and the price; then the 24h, 7d and 30d changes). Its headings are sort buttons (a click sorts, a second click flips, a third goes back to the list order) with `aria-sort`.
- The table of all coins stays below the charts. Reason: a table of ten cards pushes the chart below the first screen on a phone, and the coin buttons at the top already select a coin. The row of the selected coin is marked.
- Touch: `touch-action: pan-y` on the plot. uPlot follows the mouse only, so `app.js` moves the crosshair with Pointer Events of type `touch`; a drag up or down still scrolls the page. The line above the chart shows the time, price and change since the start of the range for the touched point, and the latest point when nothing is touched. It replaces the uPlot legend, which showed empty values.
- Chart: a dashed line and a plate with the latest price; the time axis uses a 24-hour clock in UTC with the day or year under the first tick of it (`TIME_AXIS` in `app.js`).
- Coin comparison: every coin has one of ten colours (`--coin-1` to `--coin-10`, a pair for each theme, at least 3:1 against the background), the same in the lines, the names at their ends, the table and the overview. All names are drawn (only the coin on a narrow screen). The "At start" column is gone: it was always 0%.
- The link is `#BTC/7d` (coin and range). An old link with only the coin still works.
- Gap note under the chart tells how much of the range was filled with candles.
- Checkboxes are 24 px (their label is 44 px). Safe-area insets and `theme-color` are set.
- Full page view (2026-10-30): every chart (price, source comparison, coin comparison) has an "Expand" button. The chart and its controls become a fixed layer over the page (`.panel.is-expanded`, a dialog with `aria-modal`); the chart takes the height that is left. "Close" or Escape puts it back and returns the focus to the button; Tab stays inside the layer. It is CSS, not the Fullscreen API, because iPhone Safari has the API for video only. The checkboxes of the coin table are not in the layer, so the lines cannot be changed there. On a phone held sideways the buttons are smaller and the side notes are hidden.
- Not done, on purpose: log scale, candlesticks, a UTC/local switch, small multiples, hiding range buttons that lack data (the history starts in 2024, so every range has data).
- Research limits: some sources were not readable (403, PDF). The claims about Binance, Kraken and the exact CoinGecko layout have no first-hand source. The touch behaviour was checked with synthetic pointer events in a desktop browser, not on a real phone.

## Consequences

- Good: a tiny site (about 22 KB of library plus about 150 lines) and no toolchain.
- Good: the client never parses large series.
- Bad: vendored uPlot is not updated by Dependabot. Its last npm release is 19 months old. The fallback is Chart.js or lightweight-charts. Planned replacement path: both are drop-in for line charts with the same data files.
- Bad: no touch zoom in v1. Range buttons cover it. Touch drag moves the crosshair (D8). Check on a real phone.
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
