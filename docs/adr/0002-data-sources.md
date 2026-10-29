# ADR 0002: Data sources and exchanges

- Status: Proposed
- Date: 2026-10-29
- Scope: which public price endpoints to use, quote currency, number of sources, symbol mapping, starting coins, backfill, and the terms of use of the price data.

Source grades: [A] official docs or terms, [B] own measurement, [C] first-hand report, [D] blog or news. See ADR 0001.

## Context

The collector runs on GitHub-hosted runners (US-based cloud IPs). It must work without API keys. It stores prices in a public git repo and shows them on a public page. The use is non-commercial and has one owner. The Actions run is short, so one HTTP request for all coins is best.

## Decision Drivers

1. The data terms must not forbid storing and showing prices publicly.
2. The endpoint must work from GitHub runner IPs (no HTTP 451 or 403 geo-block).
3. One request must return all coins. No key.
4. Real USD quote, not USDT.
5. Few sources. Each extra source adds a terms risk and a failure mode.

## Important limits of the research

- I could not test from a real GitHub runner. The local machine has a Ukrainian IP. A 451 from Binance.US and Gemini there is a Ukraine geo-block and says nothing about runners. A 200 from Binance global there proves nothing either.
- Every "works from a runner" claim is UNVERIFIED unless a source is named. The runner probe is a blocking checklist item.
- Terms were read through extractors or a browser pane. This is not legal advice.

## Facts: comparison of candidates

Local tests: one request per endpoint on 2026-10-28 23:15 to 23:28 UTC from a Ukrainian IP. [B]

| Source                        | Key      | Latest-price endpoint                                                                              | Quote         | Rate limit                                | Runner access                                            | Store history                         | Show publicly                        | Public repo                                                                               |
| ----------------------------- | -------- | -------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------- | -------------------------------------------------------- | ------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------- |
| Kraken                        | no       | `GET api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD,...`                                        | USD           | "1 per second (or less)" is the safe rate | UNVERIFIED, no block reports                             | Unclear                               | Unclear                              | Unclear                                                                                   |
| CoinGecko keyless             | no       | `GET api.coingecko.com/api/v3/simple/price?ids=...&vs_currencies=usd&include_last_updated_at=true` | USD aggregate | about 5 calls per minute, shared IP pool  | UNVERIFIED, high 429 risk on shared IPs                  | Unclear (treated as 24 h cache)       | Allowed with attribution             | Unclear, leans no                                                                         |
| CoinGecko Demo                | free key | same + `x-cg-demo-api-key`                                                                         | USD aggregate | 100 per minute, 10,000 per month          | n/a                                                      | Unclear                               | Allowed with attribution             | Unclear                                                                                   |
| Bitstamp                      | no       | `GET www.bitstamp.net/api/v2/ticker/` (all markets)                                                | USD           | 400 per second, 10,000 per 10 min         | UNVERIFIED                                               | Unclear, leans no                     | Unclear, leans no                    | Unclear, leans no                                                                         |
| Coinbase Exchange             | no       | `GET api.exchange.coinbase.com/products/BTC-USD/ticker` (one per call)                             | USD           | 10 per second per IP                      | UNVERIFIED                                               | Unclear ("personal or research")      | Not allowed                          | Not allowed                                                                               |
| Bitfinex                      | no       | `GET api-pub.bitfinex.com/v2/tickers?symbols=...`                                                  | USD           | 30 per minute                             | UNVERIFIED                                               | Allowed (internal)                    | Unclear                              | Not allowed                                                                               |
| Binance global                | no       | `GET api.binance.com/api/v3/ticker/price?symbols=[...]`                                            | USDT          | 6000 weight per minute per IP             | Blocked from GitHub runners (secondary report, HTTP 451) | UNVERIFIED                            | UNVERIFIED                           | UNVERIFIED                                                                                |
| Bybit                         | no       | `GET api.bybit.com/v5/market/tickers?category=spot`                                                | USDT          | 600 per 5 s per IP                        | Blocked (secondary report, HTTP 403)                     | UNVERIFIED                            | UNVERIFIED                           | UNVERIFIED                                                                                |
| OKX                           | no       | `GET www.okx.com/api/v5/market/tickers?instType=SPOT`                                              | USDT/USDC/EUR | per IP, number UNVERIFIED                 | One blog says it works                                   | Not allowed                           | Not allowed                          | Not allowed                                                                               |
| KuCoin                        | no       | `GET api.kucoin.com/api/v1/market/orderbook/level1?symbol=BTC-USDT`                                | USDT          | public pool                               | UNVERIFIED                                               | Not allowed                           | Not allowed                          | Not allowed                                                                               |
| CoinMarketCap keyless         | no       | `GET pro-api.coinmarketcap.com/public-api/v2/simple/price?symbol=BTC,ETH&convert=USD`              | USD aggregate | shared IP pool, no number                 | UNVERIFIED                                               | UNVERIFIED (keyed terms: not allowed) | UNVERIFIED (keyed: with attribution) | UNVERIFIED (keyed: not allowed)                                                           |
| CoinPaprika free              | no       | `GET api.coinpaprika.com/v1/tickers?quotes=USD`                                                    | USD aggregate | 10 per second, 20,000 per month per IP    | UNVERIFIED                                               | Unclear                               | With attribution                     | Not allowed on the free plan (plans page: usage "Personal", redistribution not available) |
| CryptoCompare / CoinDesk Data | key now  | -                                                                                                  | -             | -                                         | local test: HTTP 401 "API key required"                  | -                                     | -                                    | -                                                                                         |
| Gemini                        | no       | `GET api.gemini.com/v1/pubticker/{symbol}`                                                         | USD           | UNVERIFIED                                | UNVERIFIED (local 451 is a Ukraine geo-block)            | UNVERIFIED                            | UNVERIFIED                           | UNVERIFIED                                                                                |

Key term quotes [A] (shortened):

- Coinbase Market Data Terms (updated 2026-08-07): use is "exclusively for you or your entity's personal or research purposes"; you may not "Redistribute, display, or disseminate" market data, derived works included. Docs say that by using the Exchange Market Data API "you agree to be bound by the Market Data Terms of Use". Technically good, legally the worst fit.
- Kraken Global Terms (updated 2026-10-28), sections 8 and 9: Kraken or its licensors own content on the site. Users may not "otherwise commercially exploit or make available to any third party Our Content". They may not use "web scraping, web harvesting, or data extraction methods". The terms do not say whether the public REST ticker is "Our Content". There is no separate API or market-data licence page. A search snippet named an address `marketdata@kraken.com`. I could not confirm it on a Kraken page. UNVERIFIED. Do not rely on it.
- Bitstamp Terms of Use: prices, trades, charts "belong to Bitstamp" and "should not be copied, reproduced ... scraped, collected or distributed in any form". The API page tells companies using the data for their own commercial purposes to sign a Data License Agreement. It does not address non-commercial API use.
- CoinGecko API Terms, section 4.3: show "Powered by CoinGecko" (font not smaller than 10). Section 6.1: "We do not encourage caching or storage of Data"; if you cache, refresh at least every 24 hours (6.1.1). Section 6.2: no right to "duplicate, reproduce, copy, store, derive from or translate any Data" except as allowed. So a permanent public history of CoinGecko prices is not covered. Keyless is "not recommended for production" and shares an IP-based pool.
- OKX API Agreement 9.4: no "resell, redistribute, publish, display" without written consent. KuCoin Article 91: no "databases" or compilations. Bitfinex: "Distribute, redistribute ... to any party" is prohibited. CoinMarketCap keyed terms: no downloading or storing content.

Stablecoin and quote facts:

- Kraken, Coinbase, Bitstamp and Bitfinex list real USD pairs. Binance, Bybit and KuCoin mainly quote USDT. [A]/[B]
- At one minute (2026-10-28 23:2x UTC), Coinbase 81232.79, Kraken 81255.5, Bitstamp 81230.29 (USD). Binance BTCUSDT 81328.2, about 0.1% higher. USD venues agree within about 0.15%. [B]
- On 2025-10-10/11 Binance paid about $283 million after depegs of USDe, BNSOL and WBETH on its own platform. It later called part of it a display error. [D] (The Block, Decrypt). A single venue can show a wrong price for non-USD quotes for minutes.

## Considered Options

### Option A. Kraken only

- Pros: one request, real USD, no key, US-friendly, safest stated rate. Least explicit prohibition among exchanges.
- Cons: terms unclear. One source means no cross-check and gaps when Kraken is down.

### Option B. Kraken stored, CoinGecko as a run-time cross-check that is not stored (chosen)

- Pros: detects bad ticks and a wrong series. Keeps CoinGecko storage terms out of the repo. One extra request per run.
- Cons: the keyless CoinGecko pool is shared and may return 429. The cross-check must be best effort.

### Option C. Median of three (Kraken, Coinbase, Bitstamp)

- Pros: robust to one bad source.
- Cons: three terms problems. Coinbase forbids display. Three failure modes. Median needs three values anyway. Rejected.

### Option D. Aggregator only (CoinGecko or CoinMarketCap)

- Pros: one key-less request, USD aggregate.
- Cons: storage terms (CoinGecko 24 hour cache), attribution, shared IP rate pool, 5 calls per minute. Rejected as the stored series.

### Option E. Binance or Bybit

- Cons: blocked from US cloud IPs per reports; USDT quote. Rejected.

## Decision Outcome

Chosen in the first draft: Option B. Revision 2 (below, after point 8) replaces it for the test phase. The owner now wants four sources tested, then one chosen.

1. Stored series: Kraken `Ticker` for all enabled coins in one request. Quote currency: USD only. No USDT, no EUR in v1.
2. Cross-check: CoinGecko `simple/price` for the same coins, once per run, best effort. It is not stored. If the two values differ by more than 2%, the point is rejected (not written) and logged. If CoinGecko fails (429, timeout), skip the check. Other sanity rules still apply (ADR 0004).
3. No median. No fallback source for stored data in v1. If Kraken fails, the run writes nothing and leaves a gap. A gap is honest. A fallback row would mix sources and terms. Bitstamp can be added later behind a config flag only after its terms are clarified.
4. Not used for stored data: Coinbase, Bitfinex, OKX, KuCoin (terms say no), Binance, Bybit (blocked), CoinMarketCap and CryptoCompare/CoinDesk (terms or key).
5. Every stored row has a `src` column (`kr`). The dashboard names the source and the quote currency, and shows "Cross-checked against CoinGecko" with a link. If CoinGecko values are ever displayed, show "Data provided by CoinGecko" next to them.
6. Request rules: one request per source per run, timeout 10 seconds, at most one retry after 2 seconds, descriptive `User-Agent` (project name and repo URL), no tight retry loops. HTTP 429 skips the run for that source. Schedule minutes are off-peak (ADR 0005).
7. Kraken's data terms are unclear. Before the first public data commit, the owner asks Kraken support in writing whether a non-commercial public dashboard and a public history are allowed, or consciously accepts the risk (see Open Questions). Owner decision (2026-10-29): ask first. No real price data is committed to the public repo until Kraken answers. Dry runs and tests with fixtures are allowed in the meantime. Superseded later on 2026-10-29: the owner decided to run everything in the public repo with real data, without waiting for Kraken. The written request to Kraken stays open. See Revision 2, points 5 and 9.
8. A second round of research (Addendum A) checked about 20 more exchanges and about 20 non-exchange sources. None is clearly permissive for a public repo. Kraken stays primary. Plan B is Coin Metrics (the most open licence found), which also needs a written permission. The owner may send that question in parallel (checklist item 7b). Revision 2 below changes the roles: Coin Metrics is now one of four test sources.

### Revision 2 (2026-10-29, later the same day): test four sources, then choose one

Owner decision. The first draft chose Kraken by reading terms and reports. The owner prefers to test the candidates on real runners and choose after that. For the ranking and for the test, the storage and display terms of the sources are not scored (the owner's instruction). They stay recorded in the tables above and in Addendum A.

1. Test sources (rank numbers are from Addendum B): Kraken (1), Coinbase Exchange (3), Bitstamp (4), Coin Metrics Community (6). None needs a key.
2. Reserve sources (documented only, no key created): CoinGecko Demo (2), CoinMarketCap Basic (5), Coinranking (7). Each needs a free key, which would be a repository secret (ADR 0009 D2). Activation rule: use them only if fewer than two of the four test sources pass the gate in point 7, or if the owner decides to widen the test. Order: 2, 5, 7. Creating a key and adding the secret is the owner's step.
3. Potential sources (documented only, not tested, not reserved): Bitfinex (8), Crypto.com (9), CoinPaprika (10) and the twelve sources of group B in Addendum B.
4. Test shape: one collector run calls all four sources and stores each source's raw price under its own `src` code (`kr`, `cb`, `bs`, `cm`). Per run: one request each to Kraken, Bitstamp and Coin Metrics, and ten requests to Coinbase (one per coin), so 13 requests (Kraken needs one more `AssetPairs` request to map result keys, so 14 in practice). The sources are independent: a failure, a 429 or a block on one source does not stop the others. They run in parallel with the timeouts of ADR 0005 D5. The Coinbase requests run at most 4 at a time (its limit is 10 per second per IP).
5. Where the test data goes (owner decision, 2026-10-29, later): the public repo `borbiuk/git-coin`, with real prices, without waiting for the Kraken answer. This replaces the Kraken gate of point 7 of the first decision for the test. The written request to Kraken stays open. The test rows go straight to the `data` branch, with no separate test branch (owner decision, 2026-10-29; layout in ADR 0004 D7). The test has no dashboard and no alerts, and Pages stays off until the choice, so the page never shows mixed sources. Length: 14 days at the default 15-minute cadence, about 1,350 runs. Standard runners are free in public repos (ADR 0001). While the test data is public, the README names the four sources, says it is test data provided as is, and credits Coin Metrics with a link to the CC BY-NC 4.0 licence (A3).
6. In the test, values are stored as received. Only malformed values are rejected (not a decimal number, not finite, not greater than 0). The cross-check and the step check of ADR 0004 D4 are off, because they would hide the errors the test wants to measure. Deviations are computed offline from the stored rows. Every file carries the extra column `age_s` (ADR 0004 D1 and D7).
7. Gate. A source is eligible only if all of these hold over the full test (thresholds are my proposal, the owner confirms them before the start):
    - at least 98% of ticks give HTTP 200 with all 10 coins parsed;
    - never more than 3 failed ticks in a row;
    - the id mapping works for all 10 coins and does not change during the test;
    - HTTP 429 or block responses in at most 1% of ticks.
8. Score among eligible sources, in this order:
    1. availability;
    2. quality: deviation from the consensus of the other sources (median of the others for the same coin, with `ts` within 5 minutes). Report p50, p95 and maximum per coin, and the number of points more than 1% off. An aggregate (Coin Metrics) and an exchange differ by a small steady offset. Judge the stability of the offset, not only the raw gap;
    3. freshness where the source gives its own time (Coinbase `time`, Bitstamp `timestamp`, Coin Metrics `time`). Kraken's `Ticker` has none, so Kraken cannot be scored on this;
    4. latency p50 and p95;
    5. simplicity: requests per run (1 for Kraken, Bitstamp and Coin Metrics, 10 for Coinbase).
9. Terms are recorded, not scored. Coinbase's market data terms forbid display and redistribution. Kraken's and Bitstamp's are unclear. Coin Metrics wants a written permission. The test data is public from the first commit. For Coinbase this is a known conflict with its stated terms, and for the other three it is an open risk. The owner accepted this on 2026-10-29. Fact, not advice: a public git history cannot be fully erased. Rows written to `data` stay in its history for good: the writer is append-only and the rulesets block force pushes, so removing the rows of the non-chosen sources would need a history rewrite that the owner would have to allow. Forks and clones keep copies even after a rewrite, and GitHub may serve unreachable commits by their SHA for some time (UNVERIFIED). If a source with an explicit prohibition wins, the owner decides whether it goes to production: accept the risk in writing, get permission, or take the next source. This ADR does not decide that.
10. After the test the owner picks one source, and this ADR gets a Revision 3 with the choice and the measured numbers. The production collector stores one source. Whether a second source stays as a run-time cross-check that is not stored is decided then (open question 8). Points 1 to 5 of the first decision stay as written only if the test picks Kraken.

### Symbol mapping

- Canonical id: the upper-case ticker used in our config and in file names (`BTC`, `ETH`). An id is never reused for a different asset. A renamed or replaced asset gets a new id (see ADR 0007).
- The config has an explicit table per coin: `kraken_pair` (altname, for example `XBTUSD`) and `coingecko_id` (for example `bitcoin`). No string rules. [A] Kraken result keys differ from altnames (`XXBTZUSD` for BTC, `XETHZUSD` for ETH, `XDGUSD` for DOGE, `SOLUSD` without prefix). The collector must map result keys back to our ids by the catalogue (`AssetPairs`: `altname`, `wsname`), not by hard-coded keys.
- Kraken docs describe `pair` as a single string, but a comma list works in practice (local test). The multi-pair form is not on the current docs page. UNVERIFIED. The runner probe checks it. If it fails, call `Ticker` without `pair` (all assets) and filter.
- A daily catalogue check (`AssetPairs`) marks a coin `source_missing` when its pair is missing or not `online` (see ADR 0007).

### Starting coins

Selection: CoinGecko top 25 by market cap on 2026-10-28, without stablecoins and the tokenised real-world asset, and only coins that have USD pairs on Kraken, Coinbase and Bitstamp (live catalogues, 2026-10-28). [B]

| Id   | CoinGecko id | Kraken altname | Kraken result key |
| ---- | ------------ | -------------- | ----------------- |
| BTC  | bitcoin      | XBTUSD         | XXBTZUSD          |
| ETH  | ethereum     | ETHUSD         | XETHZUSD          |
| BNB  | binancecoin  | BNBUSD         | BNBUSD            |
| XRP  | ripple       | XRPUSD         | XXRPZUSD          |
| SOL  | solana       | SOLUSD         | SOLUSD            |
| DOGE | dogecoin     | XDGUSD         | XDGUSD            |
| LINK | chainlink    | LINKUSD        | LINKUSD           |
| ADA  | cardano      | ADAUSD         | ADAUSD            |
| XLM  | stellar      | XLMUSD         | XXLMZUSD          |
| LTC  | litecoin     | LTCUSD         | XLTCZUSD          |

All ten showed `online` on Kraken. The list is locked in config. Do not auto-follow the top N. Re-run the check before launch. Result keys for BNB, SOL, DOGE, LINK, ADA come from the research notes (convention plus the local catalogue check). Verify them in the probe.

### Per-source identifiers for the test

Names follow each source's usual naming. They are UNVERIFIED until the runner probe (checklist item 3) lists the catalogues. Coin Metrics coverage was tested only for `btc`, `eth` and `sol` (Addendum A3).

| Id   | Kraken (altname) | Coinbase (product) | Bitstamp (market) | Coin Metrics (asset) |
| ---- | ---------------- | ------------------ | ----------------- | -------------------- |
| BTC  | XBTUSD           | BTC-USD            | btcusd            | btc                  |
| ETH  | ETHUSD           | ETH-USD            | ethusd            | eth                  |
| BNB  | BNBUSD           | BNB-USD            | bnbusd            | bnb                  |
| XRP  | XRPUSD           | XRP-USD            | xrpusd            | xrp                  |
| SOL  | SOLUSD           | SOL-USD            | solusd            | sol                  |
| DOGE | XDGUSD           | DOGE-USD           | dogeusd           | doge                 |
| LINK | LINKUSD          | LINK-USD           | linkusd           | link                 |
| ADA  | ADAUSD           | ADA-USD            | adausd            | ada                  |
| XLM  | XLMUSD           | XLM-USD            | xlmusd            | xlm                  |
| LTC  | LTCUSD           | LTC-USD            | ltcusd            | ltc                  |

The ten coins were selected because they had USD pairs on Kraken, Coinbase and Bitstamp on 2026-10-28 (see "Starting coins"). Config fields are in ADR 0007 D3.

### Backfill sources (for the manual gap fill in ADR 0005)

- Kraken `OHLC`: "Returns up to 720 of the most recent entries. Older data cannot be retrieved, regardless of `since`." With 15-minute candles that is 7.5 days. [A]
- Coinbase: 300 candles per call. Bitstamp: 1,000 per call. Bitfinex: 10,000 per call. CoinGecko: hourly for 2 to 90 days. The same terms caveats apply. We use only Kraken for backfill, until the test picks a source (Revision 2).

## Consequences

- Good: a small, simple data path with the least legal exposure found among the free options.
- Bad: one source. A Kraken outage or a Kraken block of runner IPs stops data. The dashboard shows a stale banner (ADR 0008).
- Bad: the Kraken terms are unclear and the answer may be "no". Then the only clean path is a different source with a clear licence, or a change of the project (for example a private repo, which breaks the fixed decision, or a licensed paid feed). This ADR does not decide that.
- Bad: CoinGecko keyless may often return 429 on shared runner IPs. The cross-check is best effort. A free Demo key would help but needs a secret. Not used in v1.
- Follow-up: the daily symbol catalogue check needs one more request per day.
- Revision 2, good: the source is chosen by measurement from real runners, not by reading terms and reports. Four independent views also make bad ticks and blocks visible.
- Revision 2, bad: the test touches three more terms questions (Coinbase, Bitstamp, Coin Metrics), and the rows are public from the first commit. Coinbase's terms forbid this. The owner accepted the risk (point 9).
- Revision 2, bad: 13 requests per run instead of 2, and about four times the data volume of one source (about 4 MB for 14 days, local estimate). Both are small and short-lived.
- Revision 2, bad: the rows of the three non-chosen sources stay in `data` for good (append-only, no history rewrite). Readers must filter by `src`. The extra size is small (about 4 MB, ADR 0004 D7).

## Sources (access date for all: 2026-10-29 unless noted)

- https://docs.kraken.com/api/docs/rest-api/get-ticker-information [A]
- https://docs.kraken.com/api/docs/rest-api/get-ohlc-data [A]
- https://docs.kraken.com/api/docs/rest-api/get-tradable-asset-pairs [A]
- https://support.kraken.com/articles/206548367-what-are-the-api-rate-limits- [A] (page was in Ukrainian; the safe rate is from a search snippet and my reading)
- https://www.kraken.com/legal/global-terms [A]
- https://status.kraken.com/ [A]
- https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits [A]
- https://www.coinbase.com/legal/market_data [A] (read in the browser pane; plain fetch gets a Cloudflare 403)
- https://www.bitstamp.net/api/ [A]
- https://www.bitstamp.net/legal/terms-of-use/ltd/ [A]
- https://status.bitstamp.net/ [A] (TON renamed to GRAM on 2026-11-09)
- https://www.bitfinex.com/legal/general/market-data/ [A]
- https://developers.binance.com/docs/binance-spot-api-docs/rest-api/general-api-information [A]
- https://dev.to/brojinga/what-i-learned-building-a-funding-rate-comparison-tool-and-where-exchange-apis-get-weird-j13 [D] (Binance 451 and Bybit 403 from GitHub Azure IPs; one author, no year shown)
- https://bybit-exchange.github.io/docs/v5/rate-limit [A]
- https://www.okx.com/help/okx-api-agreement [A]
- https://www.kucoin.com/legal/terms-of-use [A]
- https://docs.coingecko.com/docs/keyless-public-api.md [A]
- https://docs.coingecko.com/docs/errors-and-rate-limits.md [A]
- https://www.coingecko.com/en/api_terms [A]
- https://brand.coingecko.com/resources/attribution-guide [A]
- https://www.coingecko.com/en/api/pricing [A]
- https://coinmarketcap.com/api/documentation/pro-api-reference/keyless-public-api.md [A]
- https://pro.coinmarketcap.com/user-agreement-commercial/ [A]
- https://coinpaprika.com/api-terms-of-use/ and https://docs.coinpaprika.com/faq.md [A]
- https://www.theblock.co/post/374295/binance-pays-283-million-in-compensation-following-fridays-depegs-covering-user-losses [D]
- Local curl tests, 2026-10-28 UTC, Ukrainian IP [B]

## Open Questions

1. Kraken: are a public history and a public dashboard of its public ticker allowed for non-commercial use? Ask in writing. Who sends the request? (Owner.)
2. Do Kraken, CoinGecko (keyless) and Bitstamp respond from GitHub runner IPs without 429, 403 or 451? How often?
3. Does `Ticker?pair=A,B,C` still work, and what are the exact result keys for all ten coins?
4. Should a Bitstamp fallback be enabled after its terms are clarified?
5. Is an unclear-terms risk acceptable at all, if the answer from Kraken is "no" or never arrives?
6. Legal questions not researched: whether bare price facts are protectable, EU database rights. I am not a lawyer.
7. Revision 2: does the owner confirm the gate thresholds and the 14-day length before the test starts?
8. Revision 2: after the choice, does a second source stay as an unstored run-time cross-check (and which one)?
9. Revision 2: after the choice, the rows of the non-chosen sources stay in `data`. Is that acceptable, or does the owner want a one-time history rewrite later (it needs lifting the force-push block of ADR 0009)?
10. Revision 2: if the winner is Coinbase (its terms forbid display), what does the owner do?
11. Revision 2: the `age_s` column stays in the production format after the choice (empty for Kraken). Does the owner confirm?

## Addendum A (2026-10-29): additional sources researched

Question: is there another free source with a clear right to store prices in a public repo and show them on a public page? Answer: no. The problem is structural. Free price data almost never comes with a written right to store and publish it. Local curl tests below ran from a Ukrainian IP on 2026-10-29 (10:50 to 11:57 UTC) [B]. They prove nothing about GitHub runners. I found no reports of GitHub Actions or Azure IP blocks for these sources (absence of evidence only).

### A1. Non-exchange sources

| Source                                                                            | Key                | Store / show / public repo                              | Main blocker or note                                                                                                                                                                                                |
| --------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coin Metrics Community API (`ReferenceRateUSD`)                                   | no                 | Unclear / Unclear / Unclear                             | Data is under CC BY-NC 4.0, but the Terms of Use grant use for "non-commercial internal business purposes" and bar "PUBLISH, DISPLAY, DISTRIBUTE" without written approval. Best open-licence signal found. Plan B. |
| Coinranking                                                                       | free key           | Unclear to allowed / allowed with attribution / unclear | Best explicit wording ("may be shared publicly"), but data is "primarily for the User's internal use only" and derived data must be destroyed on termination. Needs a secret.                                       |
| LiveCoinWatch                                                                     | free key           | Unclear / allowed with link / unclear                   | Attribution link required. Bans "scraping or harvesting data".                                                                                                                                                      |
| Mobula                                                                            | free key           | Unclear / Unclear / Unclear                             | Allows commercial use. Silent on storing and redistribution.                                                                                                                                                        |
| Chainlink Data Feed via a public RPC                                              | no                 | Unclear / Unclear / Unclear                             | No licence and no restriction found. Public RPC terms ban automated scraping. Step-like series (see A4).                                                                                                            |
| mempool.space                                                                     | no                 | Unclear / Unclear / Unclear                             | BTC only. No data clause in its terms. It averages Kraken, Coinbase, Bitfinex and Gemini, so their terms may apply downstream.                                                                                      |
| DefiLlama coins                                                                   | no                 | Unclear / Unclear / Not allowed                         | Terms bar "republish" and "mirror". Prices are mostly CoinGecko's.                                                                                                                                                  |
| DIA                                                                               | no                 | Not allowed                                             | Terms bar storing content and commercial use. The hosted REST API "will be discontinued on 20 December 2026".                                                                                                       |
| Pyth Hermes                                                                       | now yes            | n/a                                                     | "Hermes now requires a Pyth API Key." since 2026-08-26. Free trial only.                                                                                                                                            |
| CoinCap v3                                                                        | now yes (HTTP 401) | n/a                                                     | Key required. Terms not found.                                                                                                                                                                                      |
| CoinLore                                                                          | no                 | Unclear / Unclear / Not allowed                         | "copying, redistributing, or commercial use of content is prohibited without our express written consent".                                                                                                          |
| Stooq, Yahoo Finance                                                              | no                 | Not allowed                                             | Stooq: no redistribution without consent. Yahoo: no automated collection.                                                                                                                                           |
| Alpha Vantage, Twelve Data, Finnhub, Coinlayer, CoinAPI, Massive (Polygon), EODHD | key                | Not allowed (free tiers are personal or internal use)   | Tiingo and FMP are very likely not allowed too, but I could read only secondary sources for them.                                                                                                                   |
| RedStone, BitPay, CoinGate, Blockchain.com ticker                                 | no                 | Unverified                                              | RedStone API returned HTTP 500. The others have no terms I could find.                                                                                                                                              |

Not verified: Moralis, Messari, FreeCryptoAPI, Bitquery, API3, Uniswap subgraphs, Marketstack.

### A2. More exchanges

| Source                                                    | Real USD pairs                                                        | Terms reading (store / show / public repo)                                                                                                              | Other                                                                             |
| --------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Crypto.com Exchange                                       | all 8 tested coins, deepest book                                      | Not allowed (clause 13.2(a): no "downloading, copying... publishing... distributing")                                                                   | best liquidity, so only usable as an in-memory cross-check, never stored or shown |
| MEXC, Bitget, Blockchain.com, CEX.IO, Independent Reserve | MEXC and Bitget: USDT only. Others: USD but dead, stale or thin books | Not allowed (explicit clauses)                                                                                                                          | not usable                                                                        |
| HTX, Poloniex, Gate.io                                    | USDT only (Gate: only BTC_USD and ETH_USD, dust volume)               | Unclear (they restrict "commercial" use)                                                                                                                | all three bar US users                                                            |
| WhiteBIT                                                  | 7 of 8 (no LINK_USD), thin                                            | Unclear (no explicit redistribution clause found)                                                                                                       | bars US citizens and residents; 20,000 requests per 10 s per IP                   |
| Bitso                                                     | all 8, thin                                                           | Unverified (legal pages need JavaScript)                                                                                                                | 60 requests per minute per IP                                                     |
| Uphold                                                    | yes (broker bid and ask, spread about 0.3%)                           | Unclear. The Developer Agreement says "Not cache, aggregate, or store data", which binds registered developers; the general User Agreement was not read | US-friendly; no rate limit published                                              |
| Bitpanda                                                  | legacy ticker, own prices                                             | Unclear                                                                                                                                                 | the keyless legacy ticker ends 2027-01-31; the new API needs a key                |
| Bitvavo, Bithumb, Coinone, Luno, Pionex, OKCoin, others   | EUR or KRW only, or blocked or no reply                               | excluded or unverified                                                                                                                                  |                                                                                   |

### A3. Plan B: Coin Metrics Community API

- Endpoint (keyless, multi-asset): `GET https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc,eth,sol&metrics=ReferenceRateUSD&frequency=1m&limit_per_asset=2&paging_from=end`. Local test returned HTTP 200 with values like `{"asset":"btc","time":"2026-10-29T10:55:00...","ReferenceRateUSD":"80235.52"}`. Frequencies 1s, 1m, 1h and 1d worked without a key. Depth is only about 7 days for 1h and 1d, about 3.5 days for 1m. That is enough to fill short gaps, not for long backfill. [B]
- Rate limit: "10 requests per 6 seconds per IP address." The response headers showed a different plan header, so which limit applies to runners is UNVERIFIED. [A]/[B]
- The value is an aggregated USD reference rate, not a single exchange.
- Licence: "Available to the community under the Creative Commons license", linking to CC BY-NC 4.0 (requires credit and a link to the licence, and no commercial use). [A]
- Terms of Use (effective 2025-10-21; the live page now redirects to Talos, so the text was read from a Wayback snapshot of 2026-02-06): section 4.1 grants the right "to access, copy, display, perform, and use Coin Metrics Content for non-commercial internal business purposes" under CC BY-NC 4.0. Section 6 says not to "DUPLICATE, PUBLISH, DISPLAY, DISTRIBUTE, MODIFY, OR CREATE DERIVATIVE WORKS" unless authorised in writing. It also bans web scraping outside the Services, use with AI systems, and VPN or proxy use to bypass rate limits. [A]
- Reading: the licence text is open but the terms contradict it for publishing. Verdict "Unclear". A written permission is the clean path.
- Risks: Coin Metrics was acquired by Talos. A 2025-10-28 notice says Reference Rates "will remain freely accessible under our community licensing, with some restrictions". The terms may change again. No runner-block reports found. UNVERIFIED for runners.
- If chosen later: `src` becomes `cm` in the CSV (ADR 0004), `ts` stays our fetch time, and the dashboard must credit Coin Metrics.

### A4. Cross-check candidates other than CoinGecko

- Chainlink BTC/USD read through a public RPC: 80,200.15 at 10:49 UTC, 4 minutes old. The official feed page shows a 0.5% deviation threshold and a heartbeat countdown consistent with about one hour. The "one hour" figure comes from secondary sources. The feed has 31 node operators. Opinion: a robust cross-check, but a step-like series that can lag the market by up to about one hour and 0.5%. Public RPC terms (publicnode) forbid "data mining, robots, scraping". A keyed provider or an own node would be safer. Not verified for those.
- mempool.space: BTC only, whole-dollar integers, rate limited (HTTP 429).
- CoinGecko stays the cross-check in this ADR. Its issues are unchanged (shared IP pool, storage terms).

### A5. Outcome of the second round

1. No source changes the decision. Kraken stays the stored source. CoinGecko stays the cross-check.
2. Plan B: Coin Metrics, after a written permission. Plan C: Coinranking with a free key stored as a repository secret. Plan C needs the owner to accept the "destroy derived data on termination" clause, which clashes with an immutable public git history, so it is not recommended unless the owner accepts that.
3. Routes that make any source defensible (opinion, not legal advice): a written permission from the source; publishing only derived values (for example a rounded daily index) instead of raw quotes; or a private repo, which would break the fixed decision of a public repo.
4. Not recommended as stored sources: Crypto.com, Coinbase and other exchanges whose terms forbid publishing; HTX, WhiteBIT and Gate (US bans, thin books, USDT); Uphold (spread, developer no-store clause) unless its User Agreement is read and allows it.

### A6. Sources for Addendum A (access date 2026-10-29)

- https://gitbook-docs.coinmetrics.io/api-reference/rate-limits [A]
- https://gitbook-docs.coinmetrics.io/packages/coin-metrics-community-data [A]
- http://web.archive.org/web/20260206210011id_/https://coinmetrics.io/terms-of-use/ [A] (Wayback snapshot)
- https://creativecommons.org/licenses/by-nc/4.0/ [A]
- https://www.talos.com/insights/updates-to-coin-metrics-community-data [A]
- https://coinranking.com/api/pricing and https://support.coinranking.com/article/131-api-terms-conditions [A]
- https://www.livecoinwatch.com/legal/terms [A]
- https://docs.mobula.io/legal/terms-of-service [A]
- https://data.chain.link/feeds/ethereum/mainnet/btc-usd and https://chain.link/terms [A]
- https://www.publicnode.com/terms [A]
- https://mempool.space/terms-of-service and https://mempool.space/docs/api/rest [A]
- https://www.diadata.org/terms-conditions/ and https://www.diadata.org/docs/reference/apis/token-prices/api-endpoints [A]
- https://docs.pyth.network/price-feeds/core/upgrade/preparing [A]
- https://defillama.com/terms [A]
- https://www.coinlore.com/terms-of-use [A]
- https://stooq.com/terms.html and https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html [A]
- https://www.alphavantage.co/terms_of_service/, https://twelvedata.com/terms, https://finnhub.io/terms-of-service, https://coinlayer.com/terms, https://eodhd.com/financial-apis/terms-conditions [A]
- https://static2.crypto.com/exchange/assets/documents/tnc.pdf [A]
- https://www.blockchain.com/legal/terms [A]
- https://whitebit.com/terms and https://docs.whitebit.com/api-reference/rate-limits [A]
- https://docs.bitso.com/bitso-api/docs/general-concepts [A]
- https://www.independentreserve.com/help/terms-and-conditions [A]
- https://cex.io/terms [A]
- Local curl tests, 2026-10-29 10:50 to 11:57 UTC, Ukrainian IP [B]

### A7. Open questions from Addendum A

1. Will Coin Metrics allow a non-commercial public dashboard with attribution, in writing? (Checklist item 7b.)
2. Does the Coin Metrics Community API work from GitHub runner IPs, and which rate limit applies?
3. Do the Coin Metrics terms differ on the live Talos site from the Wayback snapshot of 2026-02-06?
4. Uphold's general User Agreement was not read. Read it only if Uphold becomes a candidate.
5. If both Kraken and Coin Metrics say no, does the owner choose derived-values-only publication, Coinranking with its clause, or a change of plan?

## Addendum B (2026-10-29): ranking of usable APIs when storage terms are ignored

Question from the owner: which free APIs could this project use, if registering for a free key is fine and the storage terms are ignored for now? Answer: the ranking below. It is my judgement, not a measurement. Nothing was tested from a GitHub runner, so "runner access" is UNVERIFIED for every row. The test in Revision 2 replaces opinion with numbers.

Criteria, in order: all 10 coins in USD from one request or a few; the free limit covers about 96 runs per day; fresh data; no sign of runner blocking; the service is not closing. Limits marked [A] were read on the live page on 2026-10-29. Limits marked "notes" come from the research notes of the first two rounds and were not re-read.

### B1. Group A: best fit

| Rank | Source                 | Key      | Free limits                                                                                             | Role      | Notes                                                                                                                                                                                                                                  |
| ---- | ---------------------- | -------- | ------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Kraken `Ticker`        | no       | about 1 request per second (safe rate)                                                                  | Test      | Real USD exchange price. All ten pairs in one request.                                                                                                                                                                                 |
| 2    | CoinGecko Demo         | free key | 100 calls per minute [A]; 10,000 calls per month (notes)                                                | Reserve   | Aggregate USD price, one request for all ids. A key removes the shared-IP pool problem of the keyless API. At a 5-minute cadence the month needs about 8,640 of the 10,000 calls.                                                      |
| 3    | Coinbase Exchange      | no       | 10 requests per second per IP                                                                           | Test      | Deepest US USD liquidity. One request per coin (10 per run).                                                                                                                                                                           |
| 4    | Bitstamp `ticker/`     | no       | 400 requests per second, 10,000 per 10 minutes                                                          | Test      | Real USD, all markets in one request. Thinner books.                                                                                                                                                                                   |
| 5    | CoinMarketCap Basic    | free key | 15,000 credits per month, 50 requests per minute, data updated every 60 seconds [A]                     | Reserve   | The page says Basic includes commercial use rights. The credit cost of a latest-quotes call for 10 coins is not verified, and the pricing table was unclear about latest quotes in Basic (the FAQ says Basic includes latest pricing). |
| 6    | Coin Metrics Community | no       | 10 requests per 6 seconds per IP (docs)                                                                 | Test      | `ReferenceRateUSD`, 1-minute frequency, about 7 days of history for gap filling. Details in A3.                                                                                                                                        |
| 7    | Coinranking            | free key | 10,000 credits per month, 5 requests per second, prices updated every minute, 1 year of history (notes) | Reserve   | About 2,900 credits per month at a 15-minute cadence.                                                                                                                                                                                  |
| 8    | Bitfinex `tickers`     | no       | 30 requests per minute                                                                                  | Potential | Real USD, one request for a list of symbols.                                                                                                                                                                                           |
| 9    | Crypto.com Exchange    | no       | not checked                                                                                             | Potential | Deepest order book. USD pairs for 8 of the coins tested in round two (not shown for all 10).                                                                                                                                           |
| 10   | CoinPaprika            | no       | 20,000 calls per month per IP, 10 requests per second [A]                                               | Potential | Aggregate USD. Refresh "up to 10 min". The response for all tickers is large. Free plan usage is "Personal".                                                                                                                           |

### B2. Group B: works, with weaker points

| Rank | Source                       | Key                               | Free limits                                                  | Weak point                                                                                                                                     |
| ---- | ---------------------------- | --------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 11   | LiveCoinWatch                | free key                          | 10,000 requests per day (notes)                              | A visible link to the site is required.                                                                                                        |
| 12   | CoinStats                    | free key                          | 20,000 credits per month, 2 requests per second [A]          | Basic market data costs 1 to 2 credits per call. The terms page returned 403 and was not read.                                                 |
| 13   | Mobula                       | free key                          | 10,000 credits per month, 1 request per second (notes)       | A multi-asset endpoint is not verified.                                                                                                        |
| 14   | Alchemy Prices API           | free key                          | 300 requests per hour (notes)                                | Update frequency not stated. Volume-weighted average of 10+ exchanges.                                                                         |
| 15   | Crypto APIs                  | free key                          | 100,000 credits per month, hard stop, no overage billing [A] | Rates are CoinMarketCap-sourced. No OHLCV. Credit cost per request is not stated. Full terms not read (the summary page has no data clause).   |
| 16   | CoinCap v3                   | key (HTTP 401 without it)         | not verified                                                 | Little information.                                                                                                                            |
| 17   | Twelve Data                  | free key                          | 8 requests per minute, 800 per day (notes)                   | Ten coins at 96 runs per day exceed the day limit if each coin costs one credit (UNVERIFIED), so the step would be about 20 minutes or longer. |
| 18   | Gemini                       | no                                | not verified                                                 | USD, one symbol per call. The local HTTP 451 is a Ukraine geo-block, not a runner result. The docs page has nothing on data use.               |
| 19   | Chainlink Data Feeds via RPC | no (public RPC) or a free RPC key | depends on the RPC                                           | Cross-check only. The value moves on a 0.5% change or about every hour (A4).                                                                   |
| 20   | mempool.space                | no                                | rate limited (HTTP 429)                                      | BTC only, whole dollars.                                                                                                                       |
| 21   | DefiLlama coins              | no                                | no numbers published                                         | Almost all prices come from CoinGecko, so it is not an independent source.                                                                     |
| 22   | CoinLore                     | no                                | about 1 request per second (recommended)                     | No time field per item.                                                                                                                        |

### B3. Not ranked as candidates (reasons)

- USDT quote or blocked from runners: Binance, Bybit (reported blocked), OKX, KuCoin, MEXC, Bitget, Gate.io, HTX, Poloniex. On 2026-10-28 USDT prices were about 0.1% above USD venues.
- Thin books or country limits: WhiteBIT, Bitso, Uphold (about 0.3% spread). Blockchain.com, BitPay and CoinGate give BTC only or payment-processor rates without time or source.
- Messari, Finnhub, Tiingo, FMP, Coinlayer: free limits and coverage not confirmed. FMP offers 250 requests per day (notes).
- Excluded: DIA (hosted REST API ends 2026-12-20), Pyth Hermes (key and trial only since 2026-08-26), Alpha Vantage (25 requests per day), Polygon/Massive (end-of-day only), CoinAPI (no free tier), RedStone (API returned HTTP 500), Stooq and Yahoo (no stable programmatic access).
- CoinDesk Data / CryptoCompare: two secondary sources (Coinranking and CoinStats blogs, both vendors [D]) say the free tier ended on 2026-05-21. A CoinGecko comparison says a free tier with a lifetime call limit exists. Not confirmed on a CoinDesk page. Not used.
- Checked from the owner's list and not usable: DEX Screener (DEX pairs, no terms on the page), Sharpe (no spot price endpoint), CoinEx (key required by its docs page, no data terms there).
- Not checked at all (derivatives, DEX or trial-only, unlikely for USD spot of ten coins): Brave New Coin, Santiment, SiftingIO, CoinGlass, Hyperliquid, Deribit, dYdX, Delta Exchange, 0x, ParaSwap.

### B4. Corrections made by this addendum

- CoinPaprika: the first table said "Unclear, leans no" for the public repo. Its plans page marks the free plan as usage "Personal" and redistribution as not available. The row is now "Not allowed on the free plan". The attribution rule of its API terms is unchanged.
- CoinMarketCap: the first table lists a keyless endpoint. The pricing page lists a free Basic plan with a key. Both exist in my notes. For the reserve role, the keyed Basic plan is the one that counts.

### B5. Sources for Addendum B (access date 2026-10-29)

- https://coinmarketcap.com/api/pricing/ [A]
- https://docs.coingecko.com/docs/common-errors-rate-limit [A]
- https://coinranking.com/api/pricing [A] (notes)
- https://coinranking.com/blog/crypto-api-pricing-compared/ [D] (vendor; CoinDesk free tier claim)
- https://docs.coinpaprika.com/api-plans.md [A]
- https://coinstats.app/api/ [A]
- https://coinstats.app/blog/best-free-crypto-api/ [D] (HTTP 403, not read)
- https://cryptoapis.io/free-crypto-api and https://cryptoapis.io/terms-conditions [A]
- https://github.com/narekgevorgyan/free-crypto-apis [D] (a list, maintained by the CoinStats team, no terms)
- https://www.okx.com/okx-api [A]
- https://docs.dexscreener.com/api/reference [A]
- https://www.sharpe.ai/docs/free-api [A]
- https://docs.coinex.com/api/v2/ [A]
- https://developer.gemini.com/rest-api/rest-api [A]
- https://docs.messari.io/reference/rate-limits [A] (not read in full; the table of limits did not load)
- https://gitbook-docs.coinmetrics.io/cm-api-spec [A] (support address, licence link)

### B6. Open questions from Addendum B

1. What is the credit cost of one CoinMarketCap latest-quotes call for 10 coins on Basic, and is the endpoint in Basic? Check only if CoinMarketCap becomes active as a reserve.
2. Does the CoinGecko Demo plan still have the 10,000 calls per month cap? The live page read on 2026-10-29 did not state it.
3. Is the CoinDesk Data free tier really closed? Check on a CoinDesk page if the owner wants it.
4. The full terms of CoinStats and Crypto APIs were not read.
