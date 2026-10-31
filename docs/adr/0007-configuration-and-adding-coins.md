# ADR 0007: Configuration and adding coins

- Status: Proposed
- Date: 2026-10-29
- Scope: where configuration lives, its format, schema and validation, how to add or remove a coin, what happens to history, handling delisted and renamed pairs.

Source grades: [A] official docs, [B] own measurement, [C] first-hand report, [D] blog or vendor.

## Context

The collector needs a list of coins with exchange symbols, and settings for validation, alerts and the dashboard. One owner edits it. The repo is public, so the config is public too and must never hold secrets.

## Decision Drivers

1. Zero runtime dependencies in the collector (ADR 0003).
2. Easy to review as a diff.
3. Checkable in CI before it reaches the scheduled job.
4. Safe: no untrusted text flows into a workflow.
5. Simplest possible way to add a coin.

## Facts

- Node reads JSON natively. YAML and TOML need packages. [A]
- `check-jsonschema` 0.39.0 validates JSON and YAML files against a JSON Schema (`--schemafile`), and has built-in schemas for GitHub workflows and Dependabot. TOML support is not confirmed on its usage page. UNVERIFIED. [A]
- `ajv` 8.20.0 is the JavaScript validator, but would add an npm dependency. [A]
- Issue forms are YAML templates. "Issue forms are not supported for pull requests" and the feature is described as public preview. An Issue form cannot open a pull request by itself. [A]
- `workflow_dispatch` supports up to 25 inputs and 65,535 characters of payload. Only users with write access can run it. [A]
- Bitstamp announced that the TON ticker changes to GRAM on 2026-11-09 and delisted several coins in October 2026. Coinbase shows `DAI-USD` with `status: delisted`. [A] Delistings and renames happen in weeks, not years.

## Considered Options

### Format

| Option        | Pros                                                          | Cons                                             |
| ------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| JSON (chosen) | built into Node and the browser; one JSON Schema; works in CI | no comments; stricter to type by hand            |
| YAML          | comments, readable                                            | needs a YAML package (a dependency)              |
| TOML          | comments; needs a TOML package                                | schema validation tooling is weaker (UNVERIFIED) |

### How to add a coin

| Option                                                   | Pros                                                                                                           | Cons                                                                                                                                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edit the config file by pull request (chosen)            | one reviewable diff; CI validates it; nothing runs on untrusted input; the owner can use the GitHub web editor | the owner edits JSON by hand                                                                                                                                                     |
| Issue Form that opens a pull request                     | friendly form                                                                                                  | needs a workflow that parses an Issue body and opens a PR: extra code, a write token, and untrusted text in a workflow (script-injection class of bugs); Issue forms are preview |
| `workflow_dispatch` input that edits and pushes the file | no manual JSON                                                                                                 | the workflow edits and pushes config by itself; harder to review; bypasses CI checks                                                                                             |

## Decision Outcome

### D1. Location and format

- `config/coins.json` and `config/coins.schema.json` on `main`. The collector reads them from the `main` checkout (ADR 0005). A change takes effect on the next run.
- Strict JSON. Keys that are unknown to the schema are rejected (`additionalProperties: false`).

### D2. Shape (illustration, not final code)

```json
{
	"schema_version": 1,
	"settings": {
		"quote": "USD",
		"stored_sources": ["kraken", "coinbase", "bitstamp", "coinmetrics"],
		"min_spacing_seconds": 300,
		"max_step_move_percent": 50,
		"crosscheck_max_diff_percent": 2,
		"publish_min_interval_minutes": 30,
		"stale_warn_minutes": 120,
		"stale_stop_minutes": 360,
		"alert_defaults": {
			"enabled": true,
			"direction": "both",
			"cooldown_hours": 6,
			"daily_issue_cap": 5,
			"auto_close_hours": 24,
			"move_1h": {
				"window_minutes": 60,
				"threshold_percent": 5,
				"ref_tolerance_minutes": 30
			},
			"move_24h": {
				"window_minutes": 1440,
				"threshold_percent": 15,
				"ref_tolerance_minutes": 120
			}
		}
	},
	"coins": [
		{
			"id": "BTC",
			"name": "Bitcoin",
			"enabled": true,
			"added": "2026-11-01",
			"sources": {
				"kraken_pair": "XBTUSD",
				"coinbase_product": "BTC-USD",
				"bitstamp_market": "btcusd",
				"coinmetrics_asset": "btc",
				"coingecko_id": "bitcoin"
			},
			"alerts": {
				"move_1h": { "threshold_percent": 3 },
				"move_24h": { "threshold_percent": 8 }
			},
			"note": ""
		}
	]
}
```

### D3. Per-coin settings

- `id`: upper-case ticker, used in file names and Issue labels. Unique. Never reused for a different asset.
- `name`: display name.
- `enabled`: `false` stops collection and alerts, and keeps history.
- `sources.kraken_pair`: Kraken altname. `sources.coinbase_product`, `sources.bitstamp_market`, `sources.coinmetrics_asset`: ids for the other three test sources (ADR 0002 Revision 2). `sources.coingecko_id`: CoinGecko id for a cross-check or for the CoinGecko reserve.
- `settings.stored_sources`: which sources the collector calls and stores. The four-source test enables all four. After the choice (ADR 0002 Revision 3) production lists one. An enabled coin needs an id for at least one listed source (D8); it is not called on the others (D8).
- `alerts`: overrides of `alert_defaults` (threshold, window, direction, cooldown, `enabled`).
- `added`: date. `note`: free text for the owner (reason for changes, for example "pair renamed on 2026-11-09").
- Stored currency is global (`settings.quote`). It is `USD` in v1 (ADR 0002).
- `role`: only `rate` is allowed. A rate entry (`USDT`) is collected like a coin but is not shown. Its USD price converts the other prices on the page (ADR 0008 D7). At most one entry has the role, and it must set `alerts.enabled` to `false`.

### D4. Validation

1. In CI on every pull request and on push to `main`: `check-jsonschema --schemafile config/coins.schema.json config/coins.json`. Also checks workflow files with the built-in GitHub workflow schema, plus `actionlint`.
2. A second CI job (not a required check) calls the public Kraken `AssetPairs` endpoint and confirms that each enabled `kraken_pair` exists and is `online`. It is not required because it uses the network and may fail for outside reasons.
3. The collector validates a few structural rules itself with plain code and no packages at the start of each run (unique ids, numbers in range, known keys). It does not depend on `check-jsonschema`, which is a dev tool. An invalid config is an unexpected failure: exit non-zero, so the owner gets the failed-run email.

### D5. Adding a coin

1. Open the config file in the GitHub web editor (or a local clone) on a branch and add an object to `coins`.
2. Fill `id`, `name`, the id of each source in `settings.stored_sources` (for example `kraken_pair`), `coingecko_id`, `added`. Open a pull request.
3. CI checks schema and symbol. Merge when green.
4. The new coin starts collecting at the next run. Its history begins at its first row. No history is created for it. The gap fill (ADR 0005 D8) starts after its first row.

An Issue form or a dispatch input can be added later if outside contributors appear. Not now.

### D6. Removing a coin and what happens to history

- Set `enabled: false`. Do not delete the object. History stays in the `data` branch. The dashboard lists disabled coins in an "archived" group with data up to the last point.
- Delete the object from config only if the owner also accepts that the dashboard no longer shows that history. The raw files remain in git anyway.

### D7. Delisted, renamed and missing pairs

- A daily catalogue check (one `AssetPairs` request in the first run after 00:00 UTC) compares each enabled coin's `kraken_pair` with the Kraken catalogue.
- If the pair is missing or not `online`: skip that coin, set `status: source_missing` for it in `state/status.json`, and open one deduplicated Issue `[config] BTC pair missing on Kraken` (label `config`). Do not fail the whole run. Close the Issue when the pair returns.
- Same asset, new pair name (for example a ticker rename): the owner edits `kraken_pair` in place and writes the date in `note`. The series stays continuous.
- A different asset (a replacement or a redenomination, for example TON becoming GRAM if that is a different asset): add a new `id` and set the old one to `enabled: false`. Never repoint an existing `id` to another asset, because the history would mix two assets. The same rule protects against ticker reuse after a delisting.
- A big step in price at the moment of a pair change is caught by the step check (ADR 0004 D4): rejected unless the cross-check agrees.

### D8. A coin that is missing on some sources (2026-10-31)

The owner's list has 27 coins and not every coin has a USD pair on every source (ADR 0002, update of 2026-10-31).

- Rule: an enabled coin needs an id for at least one source in `settings.stored_sources`. A source with no id for the coin is not called for it. The source comparison on the page shows only the sources the coin has.
- Primary source of a coin: the first stored source that has an id for it. It gives the live series of the page. ZIL has only Coin Metrics, so Coin Metrics is its primary source and its history starts with its first row.
- Candle source of a coin (history and gap fill): Bitstamp when the coin has a market there, else Kraken, else none. Bitstamp gives 15-minute candles from 2024-01-01 (`tools/backfill-bitstamp.ts`). Kraken gives daily candles for about two years (`tools/backfill-kraken.ts`) and 15-minute candles for the gap fill (ADR 0005 D8).
- A market that trades too rarely is left out of the config on purpose, so the candle source falls to Kraken. This was done for TRX, ATOM and ETC (a few Bitstamp candles a day, ATOM none since 2026-09-04). Their Bitstamp candles written before stay in `data` and are still shown.
- Order for a new coin: run the backfills into a checkout of `data` first, push `data`, then merge the config. The first run after the merge fills the time between the last candle and now.
- DOGE and LTC were set to `enabled: false` on 2026-10-31. Their history stays (D6).

### D9. Coin profile (2026-10-31)

Facts about a coin that never change or change rarely live in an optional `profile` object of the coin. The owner edits them by hand, in the same pull request that adds the coin. Anything that changes all the time (price, volume, market cap, supply in circulation, fees, staking yield) stays out of the config. Prices go to the CSV files.

| Field             | Meaning                                                                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launched`        | Year the asset first existed on a public network: a token contract or a mainnet genesis block, whichever came first. A fork counts from the fork year (ETC 2016). Whole year, 2009 or later. |
| `asset_type`      | `native` (the coin of its own network), `token` (lives on another network) or `stablecoin`.                                                                                                  |
| `category`        | One of `layer1`, `store_of_value`, `payments`, `defi`, `oracle`, `exchange_token`, `storage`, `stablecoin`, `meme`.                                                                          |
| `platform`        | CoinGecko id of the network a token lives on (`ethereum`, `binance-smart-chain`). Required for a `token`, not allowed for the other types.                                                   |
| `consensus`       | `pow`, `pos`, `dpos` or `other`. Required for a `native` coin, not allowed for the other types (a token uses its platform's).                                                                |
| `smart_contracts` | The network itself runs general-purpose smart contracts. Required for a `native` coin, not allowed for the other types.                                                                      |
| `max_supply`      | Hard cap in coins. A missing field means the protocol has no hard cap.                                                                                                                       |
| `previous_ids`    | Tickers the asset had before a rename. It never holds the current id.                                                                                                                        |

- `launched`, `asset_type` and `category` are always required inside a profile. The profile itself is optional, so a coin without one still loads. The code checks the cross-field rules (platform, consensus and smart contracts by asset type, `previous_ids`). The schema checks the shapes and the allowed values.
- The profile is not used by the collector, the alerts or the site yet. It is data for later use (grouping on the dashboard, notes on the coin page).
- A change of `consensus`, `smart_contracts` or `max_supply` follows a protocol upgrade. Write the date and the reason in `note`.
- Source of the values on 2026-10-31: the public CoinGecko coin pages (`genesis_date`, `categories`, `asset_platform_id`, `max_supply`). CoinGecko has no launch year for many coins and its "Smart Contract Platform" category is too loose to use, so those values and `smart_contracts` are from general knowledge. They were not checked against the project sites, so the owner should review them. `max_supply` is left out for UNI and RUNE: UNI's contract allows new minting, and the CoinGecko value for RUNE is only the supply after burns.

## Consequences

- Good: a single reviewable file. Dependencies stay at zero. No untrusted text reaches a workflow.
- Good: removing a coin does not touch history.
- Bad: the owner edits JSON, which has no comments. The `note` field is the workaround.
- Bad: the symbol check in CI depends on the network and on Kraken terms (ADR 0002).
- Bad: the collector checks structure itself, so some rules live in two places (the schema and the TypeScript code). Keep the code checks small.

## Sources (access date for all: 2026-10-29)

- Runtime and tooling sources: see ADR 0003.
- https://check-jsonschema.readthedocs.io/en/stable/usage.html [A]
- https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms [A]
- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax (workflow_dispatch limits) [A]
- https://docs.github.com/en/actions/reference/security/secure-use (untrusted input) [A]
- https://status.bitstamp.net/ (TON to GRAM on 2026-11-09) [A]
- https://docs.kraken.com/api/docs/rest-api/get-tradable-asset-pairs [A]

## Open Questions

1. Does `check-jsonschema` support TOML, in case the owner prefers TOML later? (Not needed for the chosen JSON.)
2. Should the `settings` block live in a separate file from the `coins` list? One file is simpler, so one file is chosen for v1.
3. Should the collector refuse to start if the schema `schema_version` is newer than the code expects? Likely yes. Decide at implementation.
