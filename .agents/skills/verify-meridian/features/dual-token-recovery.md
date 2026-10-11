# Dual-token deployment and recovery

Dual-token deployment converts a SOL budget into both DLMM pool tokens, then adds liquidity. If a swap or liquidity step fails, Meridian reconciles submitted transactions and returns only tokens attributable to that operation. Existing wallet inventory must remain outside the operation ledger.

## Sub-features

- `dual-plan` calculates token allocation, routes, range, reserve, and rent before transactions.
- `dual-acquire` journals prepared and Jupiter-reported swap signatures.
- `dual-partial-failure` recovers the exact confirmed output from a successful side when the other side fails.
- `dual-signature-mismatch` waits for every candidate signature to become terminal before retrying or rolling back.
- `dual-inventory-preservation` never counts pre-existing wallet balance as this operation's output.
- `dual-recovery-report` distinguishes completed rollback from pending/manual reconciliation in Telegram.
- `dual-quote-refresh` accepts a changed order only when its exact SOL input, signed minimum output, and price impact satisfy the configured limits. The signed order's minimum governs the confirmed output check.
- `dual-self-paid-route` rejects sponsored orders before signing, because their first transaction signature can be a placeholder until Jupiter executes them.
- `dual-position-valuation` prices both pool mints independently. A missing price makes PnL unavailable so the manager cannot close on an invented gain or loss.
- `dual-reconciled-deploy` reports success when a confirmed liquidity transaction is found during recovery, even if its original submission returned an error.
- `dual-rent-basis` uses the actual position account lamports for paid and recoverable rent; the SDK quote is only a reserve estimate.
- `dual-missing-deposits` leaves PnL unavailable until Meteora supplies a valid deposit basis.
- `dual-position-discovery` checks the position account directly before closing local state when an SDK or portfolio listing omits it.

## How to get to it (user POV)

- Enable `strategy.dualToken.enabled` in `user-config.json` and reach an eligible pair through automated screening.
- Observe the plan and deploy/recovery reports in Telegram.
- For code verification, run the scoped dual-deploy and dual-operations tests. Do not trigger recovery by submitting or replaying transactions on the operator's wallet.

## Driving it with tests and Telegram

Preconditions:

- Run the Doctor checks in the parent skill.
- For routine code verification, use deterministic tests and no wallet or network credentials.
- Live-chain proof requires an explicitly configured disposable funded wallet, isolated RPC/chain environment, and operator authorization. Without all three, the live path is not verified.

- **Test wallet-inventory accounting.** Run `node --test test/dual-deploy.test.js`. The test models a pre-existing 15.385906 USDC balance and confirms that a STRK transaction delta is attributed only to STRK; unchanged USDC delta is zero.
- **Test interrupted execution.** The same suite verifies partial second-side failure, signature mismatch candidates, exact acquisition/rollback ledger, missing evidence, and rollback overspend rejection.
- **Test changed Jupiter quotes.** The dual-deploy suite checks a refreshed order against its own minimum and price-impact cap. Run `node --test test/jupiter-wallet-amounts.test.js` to check wallet settlement amounts when Jupiter route amounts differ because of fees.
- **Test durable recovery state.** Run `node --test test/dual-operations.test.js`. It verifies wallet-wide operation serialization and atomic persistence of confirmed transaction evidence with the owned-token ledger.
- **Test STRK-USDC valuation.** Run `node --test test/pnl-token-valuation.test.js`. It checks that USDC is priced as USDC, an SOL-quote pair still uses SOL, and an unpriced held token cannot produce a position value. The live manager trigger remains unverified without its VPS decision log.
- **Test rent and deposit guards.** Run `node --test test/pnl-dual-rent.test.js`. A missing deposit basis or unreadable position rent must leave net PnL and its percentage unavailable. Actual position rent must override the SDK reserve estimate, and recoverable lamports must remain an asset while open.
- **Test missing position discovery.** Run `node --test test/position-discovery.test.js`. An empty portfolio listing cannot close a position while its account exists or RPC lookup is inconclusive.
- **Test Telegram report.** Run the screening report suite from Doctor and inspect that `DEPLOY RECOVERY` differentiates recovered from pending state. This validates formatting logic, not delivery to a live Telegram chat.
- **Live recovery proof.** Only in the isolated environment, capture both signatures, confirmed transaction deltas, position/rent state, and the final report. Verify existing token inventory before and after. If the signature or owner/mint delta cannot be verified, Meridian must remain pending; do not mark it recovered.

## Gotchas

- A confirmed signature without RPC token-balance metadata is insufficient to spend a token balance. Recovery must stop for manual reconciliation.
- Old journal entries may need transaction metadata backfilled from RPC. If the old mismatched execute signature was never persisted, the bot cannot reconstruct it from wallet balances; report the incident as pending/manual until evidence is supplied.
- Telegram success text is not chain proof. Use confirmed transaction and position state.
- A successful add-liquidity transaction can be followed by an immediate manager close. Match the position address across the add and close transactions before interpreting a zero open-position count.
- A simulation error can arrive after a liquidity transaction lands. Check the journal and confirmed position before interpreting a failure report; a reconciled deployment must return success.
- Do not treat a missing Meteora deposit record as zero cost basis or an estimated rent reserve as spent capital.
- Never manually move assets while a recovery is pending; it can invalidate operation attribution.
