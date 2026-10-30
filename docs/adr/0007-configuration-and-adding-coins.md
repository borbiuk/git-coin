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
- `settings.stored_sources`: which sources the collector calls and stores. The four-source test enables all four. After the choice (ADR 0002 Revision 3) production lists one. A source listed here needs its id in every enabled coin, or the schema check fails. The reserve sources (CoinGecko Demo, CoinMarketCap Basic, Coinranking) are not listed in v1 and would need a secret first (ADR 0009 D2).
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
