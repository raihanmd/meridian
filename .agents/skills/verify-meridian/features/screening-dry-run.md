# Screening and dry-run deployment

The screening cycle selects a candidate and may call the deploy tool. In dry-run mode, the deploy implementation returns its plan before creating an operation journal entry or sending a transaction.

## Sub-features

- `screen-cli` runs one AI screening cycle from the CLI.
- `screen-telegram` runs the AI screening cycle from the configured bot's scheduled cycle; current Telegram `/screen` is candidate observation.
- `dry-run-plan` reports a deployment plan without sending a transaction.
- `no-deploy` reports why no candidate passed.
- `confirmed-entry-evidence` formats the confirmed tool result, the latest complete TA candle, and indicator status without asking the model to calculate range percentages.

## How to get to it (user POV)

- Run `node cli.js screen --dry-run --silent` for one AI screening cycle.
- `npm run dev` starts the configured dry-run agent and its Telegram/cron interfaces.

## Driving it with Node CLI

Preconditions:

- Explicitly accept external RPC, Meteora, Jupiter quote, discovery, and model API calls.
- Use `DRY_RUN=true node cli.js screen --dry-run --silent` so the process environment explicitly confirms dry-run mode. The CLI `--dry-run` flag also sets this value before loading the bot.
- Use an isolated checkout and disposable runtime state if the cycle could write decision or research records.
- Do not run when an existing live bot is already polling the same Telegram bot token.

- **Run a dry-run cycle.** Run `DRY_RUN=true node cli.js screen --dry-run --silent`. The JSON response has `done: true`. A successful plan says `DRY RUN · WOULD DEPLOY` for single-sided mode or `DRY RUN · DUAL-TOKEN DEPLOY` for dual mode. The cycle may instead report `NO DEPLOY`, a precheck skip, or an observer failure; record which path actually ran.
- **Verify skipped writes.** Confirm the deploy result is marked `dry_run`, no deployment transaction signature exists, no new dual-operation journal record was created, and the wallet's on-chain state is unchanged. Do not infer these facts from the phrase “dry run.”
- **Proof.** Preserve command output, process environment evidence showing `DRY_RUN=true` without recording secrets, and before/after operation journal and wallet/position state.
- **Offline report proof.** Run `node --test test/screening-report.test.js test/range-coverage.test.js test/dual-ta.test.js test/chart-indicators.test.js`. Confirm the dual-token range has nonzero upside when the active bin is inside it, and an unavailable indicator says `SKIPPED` with interval failures. This proves formatting and calculations, not Telegram delivery.

## Gotchas

- Dry-run still loads the wallet for dual-mode planning, fetches live pool/TA data, requests Jupiter quotes, and can write screening/decision records. It is not offline.
- `--silent` does not currently suppress every research-observation Telegram message. Use a checkout with no production Telegram configuration for any CLI dry-run proof.
- The CLI JSON report contains formatted text, not the underlying `dry_run` result. Inspect the journal and wallet state separately before claiming no transaction occurred.
- After a confirmed deploy, the screening report uses the deploy tool's range, fees, position address, and final liquidity transaction signature. Indicator confirmation can be `CONFIRMED` or `SKIPPED` when the API is unavailable; a skipped indicator currently does not block entry.
- A dry-run plan proves planning, not transaction success, rent recovery, or live signature reconciliation.
- If credentials or isolated state are unavailable, skip the live cycle and report the unmet precondition. Do not switch to live mode to get a result.
