# Dual-token deployment and recovery

Dual-token deployment converts a SOL budget into both DLMM pool tokens, then adds liquidity. If a swap or liquidity step fails, Meridian reconciles submitted transactions and returns only tokens attributable to that operation. Existing wallet inventory must remain outside the operation ledger.

## Sub-features

- `dual-plan` calculates token allocation, routes, range, reserve, and rent before transactions.
- `dual-acquire` journals prepared and Jupiter-reported swap signatures.
- `dual-partial-failure` recovers the exact confirmed output from a successful side when the other side fails.
- `dual-global-recovery-gate` resumes every non-terminal deploy for the wallet before candidate discovery, regardless of pool, and repeats the check under the wallet-wide lock immediately before deploy. A still-pending operation or unavailable recovery evidence blocks the screening cycle.
- `dual-signature-mismatch` waits for every candidate signature to become terminal before retrying or rolling back.
- `dual-inventory-preservation` never counts pre-existing wallet balance as this operation's output.
- `dual-rollback-balance` compares journal-owned token amount against the current associated token account above its pre-acquisition balance before requesting a rollback order. A deficit leaves recovery pending and reports the wallet balance.
- `dual-manual-deploy-clearance` records external settlement only after finalized swaps, an expired liquidity signature, zero wallet balance for every outstanding operation token, absence of the journaled position, and a wallet-wide DLMM scan with no open position. SOL proceeds and net PnL remain unverified.
- `dual-recovery-report` distinguishes completed rollback from pending/manual reconciliation in Telegram.
- `dual-failure-evidence` includes the deploy tool error verbatim in the screening report and labels the cause unverified until transaction and wallet evidence is reconciled.
- `dual-quote-refresh` accepts a changed order only when its exact SOL input, signed minimum output, and price impact satisfy the configured limits. The signed order's minimum governs the confirmed output check.
- `dual-self-paid-route` rejects sponsored orders before signing, because their first transaction signature can be a placeholder until Jupiter executes them.
- `dual-position-valuation` prices both pool mints independently. A missing price makes PnL unavailable so the manager cannot close on an invented gain or loss.
- `dual-reconciled-deploy` reports success when a confirmed liquidity transaction is found during recovery, even if its original submission returned an error.
- `dual-rent-basis` uses the actual position account lamports for paid and recoverable rent; the SDK quote is only a reserve estimate.
- `dual-missing-deposits` leaves PnL unavailable until Meteora supplies a valid deposit basis.
- `dual-position-discovery` checks the position account directly before closing local state when an SDK or portfolio listing omits it.
- `dual-manual-exit-clearance` closes a pending exit journal after an external swap only when the position account is absent, every journaled remaining token has zero wallet balance, and no bot exit transaction exists. Manual SOL proceeds and net PnL remain unverified.

## How to get to it (user POV)

- Enable `dualTokenEnabled` in `user-config.json` and reach an eligible pair through automated screening.
- Observe the plan and deploy/recovery reports in Telegram.
- For code verification, run the scoped dual-deploy and dual-operations tests. Do not trigger recovery by submitting or replaying transactions on the operator's wallet.

## Driving it with tests and Telegram

Preconditions:

- Run the Doctor checks in the parent skill.
- For routine code verification, use deterministic tests and no wallet or network credentials.
- Live-chain proof requires an explicitly configured disposable funded wallet, isolated RPC/chain environment, and operator authorization. Without all three, the live path is not verified.

- **Test wallet-inventory accounting.** Run `node --test test/dual-deploy.test.js`. The test models a pre-existing 15.385906 USDC balance and confirms that a STRK transaction delta is attributed only to STRK; unchanged USDC delta is zero.
- **Test interrupted execution.** The same suite verifies partial second-side failure, signature mismatch candidates, exact acquisition/rollback ledger, missing evidence, and rollback overspend rejection.
- **Test BORDR inventory depletion.** Run `node --test test/dual-deploy.test.js test/dual-deploy-reconciliation.test.js`. The fixture models a 4,330,950,727 raw token acquisition over a 14 raw token ATA baseline, an ATA later reduced to 7 raw units, and a zero wallet balance that must not clear the journal while any wallet DLMM position remains. The tests do not submit a swap or prove SOL proceeds.
- **Test changed Jupiter quotes.** The dual-deploy suite checks a refreshed order against its own minimum and price-impact cap. Run `node --test test/jupiter-wallet-amounts.test.js` to check wallet settlement amounts when Jupiter route amounts differ because of fees.
- **Test durable recovery state.** Run `node --test test/dual-operations.test.js`. It verifies wallet-wide operation serialization and atomic persistence of confirmed transaction evidence with the owned-token ledger.
- **Test cross-pool recovery gating.** Run `node --test test/dual-deploy-recovery.test.js`. It verifies legacy operations without a `kind`, unrelated candidate pools, pending exits blocking new deploys, other-wallet exclusion, fail-closed recovery errors, recovered-position handling, and the already-held wallet lock path.
- **Test STRK-USDC valuation.** Run `node --test test/pnl-token-valuation.test.js`. It checks that USDC is priced as USDC, an SOL-quote pair still uses SOL, and an unpriced held token cannot produce a position value. The live manager trigger remains unverified without its VPS decision log.
- **Test rent and deposit guards.** Run `node --test test/pnl-dual-rent.test.js`. A missing deposit basis or unreadable position rent must leave net PnL and its percentage unavailable. Actual position rent must override the SDK reserve estimate, and recoverable lamports must remain an asset while open.
- **Test missing position discovery.** Run `node --test test/position-discovery.test.js`. An empty portfolio listing cannot close a position while its account exists or RPC lookup is inconclusive.
- **Test manual exit clearance.** Run `node --test test/dual-exit-reconciliation.test.js`. A zero token balance clears the pending journal only after direct position-account verification. Nonzero balances, pending bot transactions, and RPC errors must leave it pending. The test does not prove the amount of SOL received by a manual swap.
- **Test Telegram report.** Run the screening report suite from Doctor and inspect that `DEPLOY RECOVERY` differentiates recovered, externally settled, and pending state, and `DEPLOY ERROR (tool)` preserves the actual tool error. This validates formatting logic, not delivery to a live Telegram chat.
- **Test range coverage.** Run `node --test test/range-coverage.test.js test/screening-report.test.js`. Both normal and reconciled deploy results should derive downside/upside coverage from persisted bin prices; a legacy plan without enough prices reports unavailable coverage without blocking reconciliation.
- **Live recovery proof.** Only in the isolated environment, capture both signatures, confirmed transaction deltas, position/rent state, and the final report. Verify existing token inventory before and after. If the signature or owner/mint delta cannot be verified, Meridian must remain pending; do not mark it recovered.

## Gotchas

- A confirmed signature without RPC token-balance metadata is insufficient to spend a token balance. Recovery must stop for manual reconciliation.
- A wallet token balance of zero is not proof of a rollback to SOL. The tokens may have entered another LP or been transferred. External clearance requires a wallet-wide DLMM scan and is recorded separately from a confirmed rollback.
- Old journal entries may need transaction metadata backfilled from RPC. If the old mismatched execute signature was never persisted, the bot cannot reconstruct it from wallet balances; report the incident as pending/manual until evidence is supplied.
- Telegram success text is not chain proof. Use confirmed transaction and position state.
- A successful add-liquidity transaction can be followed by an immediate manager close. Match the position address across the add and close transactions before interpreting a zero open-position count.
- A simulation error can arrive after a liquidity transaction lands. Check the journal and confirmed position before interpreting a failure report; a reconciled deployment must return success.
- Do not treat a missing Meteora deposit record as zero cost basis or an estimated rent reserve as spent capital.
- Never manually move assets while a recovery is pending; it can invalidate operation attribution.
- If an operator has already swapped the remaining tokens manually, do not edit `dual-operations.json`. The next position refresh can mark the exit externally cleared when the position account is absent and all remaining token balances are zero. It records that SOL proceeds were not verified; a nonzero token balance still requires manual review.
