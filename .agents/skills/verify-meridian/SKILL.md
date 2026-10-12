---
name: verify-meridian
description: "Verify Meridian, a Solana Meteora DLMM CLI and Telegram trading bot. Use after changes to screening, autonomous deployment, dual-token execution or recovery, position management, or Telegram reports."
---

# Verify Meridian

Use this skill to check Meridian through its user-facing CLI and to validate the trading and recovery guards before handoff. Meridian can sign real Solana transactions; this workflow never invokes a live deploy, swap, claim, or close.

## Launch

Meridian has no local web server. Its user surfaces are the one-shot Node CLI, an interactive terminal agent, and a long-running Telegram bot. The CLI needs no persistent process for read-only help. Run commands from the repository root with Node 18 or newer.

For the isolated CLI proof, use a clean checkout without a production `.env` and a temporary home directory so its generated `~/.meridian/SKILL.md` cannot touch the operator's home:

```bash
.agents/skills/verify-meridian/scripts/verify-cli-help.sh
```

The helper exits after the command. It removes only the temporary home it created. Evidence remains under `/tmp/meridian-verification/`.

For a configured development run, `npm run dev` sets `DRY_RUN=true` and starts the agent/Telegram surfaces. Stop only the process started in that terminal with Ctrl-C. Do not start a second Telegram poller when a managed Meridian instance is already running.

## Doctor

Run these read-only checks before driving any feature:

```bash
test "$(git rev-parse --show-toplevel)" = "$PWD"
node --version
test -d node_modules
npm test
node --test test/dual-deploy.test.js test/dual-operations.test.js test/dual-exit-reconciliation.test.js test/dual-ta.test.js test/dual-token-policy.test.js test/pnl-dual-rent.test.js test/pnl-token-valuation.test.js test/position-discovery.test.js test/screening-report.test.js test/range-coverage.test.js test/chart-indicators.test.js test/management-decision.test.js test/pool-memory-reason.test.js
git diff --check
```

Require Node 18+, the expected repo root, successful syntax checks, passing focused suites, and no whitespace errors. A changed test suite is evidence only for the code paths it actually exercises. If a command hangs, record the exact command and last output; stop only the test process you started. Do not kill processes by name.

## Drive

Use `.agents/skills/verify-meridian/scripts/verify-cli-help.sh` as the no-network, no-wallet CLI entry proof from a clean checkout. Isolating `HOME` does not isolate repository `.env` loading. Use `node cli.js candidates --limit 3` only when API access is configured and the wallet has no pending dual exit: candidate enrichment looks up positions and can resume exit swaps. For Telegram, use `/status`, `/config`, `/candidates`, and `/screen` only on the operator's authorized bot after checking for pending dual exits; `/screen` refreshes the deterministic candidate list in Telegram.

Never use `/deploy`, `node cli.js deploy`, `node cli.js swap`, `/close`, or `node cli.js close` for verification. They can sign real transactions when live mode is active.

`DRY_RUN=true` blocks on-chain writes in the deploy implementation, but it still loads the wallet in dual mode and may call RPC, Meteora, Jupiter quote, pool-discovery, and model APIs. It can also write decision/runtime records. Do not treat dry-run as offline or use the production wallet to exercise uncertain paths. Only run `node cli.js screen --dry-run --silent` when the operator has explicitly configured the checkout for safe verification and accepts those network and local-record side effects.

For dual-token partial-swap recovery, follow [Dual-token deployment and recovery](./features/dual-token-recovery.md). For PnL and management, follow [Position value and management](./features/position-accounting.md). Current automated tests prove transaction-scoped accounting and fail-closed reconciliation. Do not fabricate or inject signed transactions into a live wallet to produce a recovery scenario. End-to-end on-chain recovery requires a disposable funded wallet and isolated RPC/chain environment; absent those, report the live path as unverified.

## Evidence

Keep evidence under `/tmp/meridian-verification/<run-id>/`; the CLI helper creates a unique directory and records the exact command, stdout, stderr, exit code, and the CLI-generated skill file. Keep artifacts after cleanup.

For code changes, capture the commands and results from Doctor and the relevant focused tests. Recovery evidence must include both the prepared and Jupiter-reported signature states, exact transaction-scoped token deltas, the reconstructed operation ledger, whether recovery is pending or complete, and proof that pre-existing wallet inventory was excluded. Use test output and journal fixtures for these claims; do not present a unit test as live-chain evidence.

Exercise the user entry path and resulting state. A final report alone is insufficient for a Telegram or transaction path: capture the user action, resulting Telegram/CLI message, and relevant journal or chain state. Redact wallet addresses, signatures, API keys, and balances before sharing evidence outside the local verification directory.

## Cleanup

The CLI proof helper removes its own temporary `HOME` directory and leaves evidence in `/tmp/meridian-verification/`. No daemon, port, wallet, or chain state is created by that proof.

If you started a development bot, stop that exact terminal process with Ctrl-C. Confirm that its process exited before starting or interacting with another poller. Do not remove the evidence directory. Do not clear `dual-operations.json`, `decision-log.json`, or wallet state as part of cleanup.

## Helpers

- `.agents/skills/verify-meridian/scripts/verify-cli-help.sh` runs the isolated CLI proof and checks the captured output and generated user help file. Invoke it from the repository root.
- The recovery suite is `node --test test/dual-deploy.test.js test/dual-operations.test.js test/dual-exit-reconciliation.test.js`. It covers wallet inventory preservation, partial swaps, mismatched signatures, exact deltas, rollback limits, missing evidence, durable journal updates, and zero-balance manual exit clearance.

## Feature map

Read [the feature index](./features/README.md) before choosing a user path. The map lists Telegram and CLI entry points and states which paths are unsafe to drive against a live wallet.

## Maintenance

When an entry point, command, Telegram message, journal transition, or recovery invariant changes, update the matching feature file and re-run the documented Doctor and proof. Use the `maintain-verification-skill` skill to review the map for stale paths.
