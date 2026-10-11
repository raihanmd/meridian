# Screening and dry-run deployment

The screening cycle selects a candidate and may call the deploy tool. In dry-run mode, the deploy implementation returns its plan before creating an operation journal entry or sending a transaction.

## Sub-features

- `screen-cli` runs one AI screening cycle from the CLI.
- `screen-telegram` runs the AI screening cycle from the configured bot's scheduled cycle; current Telegram `/screen` is candidate observation.
- `dry-run-plan` reports a deployment plan without sending a transaction.
- `no-deploy` reports why no candidate passed.

## How to get to it (user POV)

- Run `node cli.js screen --dry-run --silent` for one AI screening cycle.
- `npm run dev` starts the configured dry-run agent and its Telegram/cron interfaces.

## Driving it with Node CLI

Preconditions:

- Explicitly accept external RPC, Meteora, Jupiter quote, discovery, and model API calls.
- Confirm `DRY_RUN=true` in the process environment before running; do not rely only on a report label.
- Use an isolated checkout and disposable runtime state if the cycle could write decision or research records.
- Do not run when an existing live bot is already polling the same Telegram bot token.

- **Run a dry-run cycle.** Run `node cli.js screen --dry-run --silent`. The JSON response has `done: true` and a report containing either `DRY RUN · WOULD DEPLOY` with a simulated plan or `NO DEPLOY` with rejection reasons.
- **Verify skipped writes.** Confirm the deploy result is marked `dry_run`, no deployment transaction signature exists, no new dual-operation journal record was created, and the wallet's on-chain state is unchanged. Do not infer these facts from the phrase “dry run.”
- **Proof.** Preserve command output, process environment evidence showing `DRY_RUN=true` without recording secrets, and before/after operation journal and wallet/position state.

## Gotchas

- Dry-run still loads the wallet for dual-mode planning, fetches live pool/TA data, requests Jupiter quotes, and can write screening/decision records. It is not offline.
- A dry-run plan proves planning, not transaction success, rent recovery, or live signature reconciliation.
- If credentials or isolated state are unavailable, skip the live cycle and report the unmet precondition. Do not switch to live mode to get a result.
