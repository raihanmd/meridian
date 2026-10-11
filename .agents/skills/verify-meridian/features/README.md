# Meridian verification map

This map records Meridian's user-facing CLI and Telegram paths. Read it before driving the bot. Meridian can transact with a real Solana wallet, so verification must prefer read-only commands and isolated CLI proof; never use live transaction commands as tests.

## Baseline preconditions

- Work from the Meridian repository root and run the Doctor checks in the parent skill.
- Keep production Telegram pollers and wallet state untouched. Do not start a second bot against the same Telegram token.
- For read-only network paths, confirm API/RPC use is acceptable and do not enable any live transaction path.
- For deploy/recovery behavior, use the scoped test suites unless a disposable funded wallet and isolated chain are explicitly configured.

## Driving conventions

- Capture the exact CLI/Telegram action and its output.
- `node cli.js candidates --limit 3` and `node cli.js screen --dry-run --silent` can make network requests. Dry-run still performs reads/quotes and may write local decision records.
- Telegram `/screen` is a deterministic candidate-list refresh; scheduled or CLI `screen` runs the AI screening cycle.
- `/deploy N`, deploy/swap/close CLI commands, and unqualified `npm start` are live-capable. Do not use them for verification.
- Recovery claims require the operation journal and transaction evidence, not only a Telegram summary.

## Proof and skip reporting

- Keep artifacts under `/tmp/meridian-verification/<run-id>/`.
- CLI proof includes command, stdout, stderr, exit code, and relevant generated state.
- Telegram proof includes the command sent and resulting message.
- On-chain proof includes confirmed transaction status, owner/mint deltas, position state, and fee/rent effects.
- State precisely which user entry point was driven. A unit test is not an end-to-end proof.
- Report unavailable credentials, live bot ownership, and missing isolated chain setup as unmet preconditions, not as passed checks.

## Features

- [CLI help and command discovery](./cli-help.md) is fully isolated and safe to run without credentials.
- [Pool candidate observation](./candidate-observation.md) uses read-only discovery and Telegram candidate refresh.
- [Screening and dry-run deployment](./screening-dry-run.md) describes network and local side effects and prohibits live deployment.
- [Dual-token deploy recovery](./dual-token-recovery.md) covers the partial-swap, signature mismatch, and pre-existing token balance safety contract.
