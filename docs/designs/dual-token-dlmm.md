# Dual-token DLMM deployment mode

**Status:** Implemented behind a disabled-by-default config flag; verification complete for pure logic and syntax
**Date:** 2026-10-11

## Goal

Add an optional autonomous dual-token deployment mode to Meridian's existing Meteora DLMM strategy. It starts with a SOL-denominated budget, converts the required share into both pool tokens, and returns both sides to SOL on exit. The current single-sided SOL deployment remains isolated and keeps its existing behavior. Human review remains limited to token research and manual allowlist edits; all actions after allowlisting run automatically.

## Decisions

- Enable adaptive range and distribution analysis only when `dualToken.enabled` is true.
- Use deterministic technical inputs. AI may explain the decision but cannot supply executable range, strategy, or token amounts.
- Let TA select a bounded range that includes the active bin and has funded bins on each side. Select only Meteora `Spot` or `Curve` distributions.
- Require sufficient, fresh 15-minute data for 15-minute, 1-hour, and 6-hour analysis windows. Derive longer windows from the 15-minute series. Skip a candidate when data is incomplete or stale.
- Require both pool mints to pass the owner-managed allowlist, except explicitly configured SOL/USDC base assets. Require valid SOL routes to each non-SOL mint before acting.
- Let TA select range and distribution at entry. Existing Meridian management and exit rules remain responsible after entry; do not rebalance or add capital.
- Keep `deployAmountSol` as the position budget. Reserve transaction SOL and dynamically estimated rent separately.
- Calculate total PnL in SOL from actual wallet/position flows after swaps, fees, transaction costs, and rent. Report LP fee yield from actual accrued/claimed LP fees only, separate from price movement.
- Journal every execution phase. Reconcile on-chain state before retries, resume partial work without repeating completed swaps, and keep unresolved operations persistent until funds and accounts are reconciled.
- Close bot-created temporary empty accounts when supported and safe; reuse durable ATAs. Report rent paid and returned.
- Enforce configured range, slippage, cost, data-quality, and wallet reserve bounds before any transaction.
- The initial Jupiter order checks route availability and price impact. Each signed order is checked again for the same SOL input, valid minimum output, and price impact. Its own configured slippage and minimum output govern execution; an older order's minimum is not reused after the market quote changes.
- Dual-token swaps require the wallet to be Jupiter's fee payer and first transaction signer. Sponsored/RFQ orders whose final signature cannot be known before `/execute` are skipped before submission so the durable journal always tracks a real signature. The route request excludes JupiterZ and verifies the returned payer and transaction.

## Architecture

1. **Dual TA module:** accepts normalized OHLCV, active bin, bin step, and config bounds; validates freshness/sample sufficiency; returns a deterministic strategy, bin range, and rationale. Pure calculations are independently testable.
2. **Budget allocator:** uses the selected DLMM distribution and current pool price to compute the X/Y value split under the SOL budget. Jupiter quotes determine executable input amounts; the allocator leaves transaction/rent reserves and unspent dust in SOL.
3. **Execution journal:** stores an atomic, durable operation record before sending any swap or DLMM transaction. States cover quoted, swap-X, swap-Y, add-liquidity, recovery, and reconciled/complete. Startup and screening cycles resume pending operations idempotently after checking balances, signatures, and position accounts.
4. **DLMM integration:** creates one bounded position containing the active bin, adds both token amounts through the installed Meteora SDK, and stores entry amounts/costs/range/strategy. Exit removes liquidity and claims fees, converts both output mints back to SOL, closes safe temporary accounts, then records final PnL and rent flows.
5. **Telegram:** labels dual-mode screening, TA choice, amounts/quotes/costs, each transaction, partial recovery, rent return, and final SOL PnL. A pending recovery is never reported as a successful deploy or completed exit.

## Failure handling

- Reject stale/malformed candles, missing quotes, unsupported token programs, invalid decimals, active-bin drift, unavailable bin arrays, excessive costs/slippage, insufficient transaction/rent reserve, and zero-sided allocations before swaps.
- Use one swap at a time and persist the prepared signature before sending. Persist Jupiter's reported execute signature separately when it differs; reconcile both signatures and never resubmit or roll back while either can still land.
- Attribute acquired and spent tokens from the confirmed transaction's owner and mint balance deltas. Do not infer operation-owned amounts from total wallet balance or subtract a wallet-wide baseline. This protects pre-existing USDC and tokens changed by unrelated transactions.
- Record each confirmed token delta and the operation's acquired-token ledger in one durable journal update. A restart must be able to reconstruct the same remaining amount from confirmed acquisition and rollback transactions without applying a delta twice.
- After any timeout or ambiguous response, query every candidate signature and the position account before retrying. Never infer failure solely from a client timeout or Jupiter status.
- If only one swap completes, persist only that transaction's exact acquired amount and convert that amount back to SOL within configured limits. Keep `recovery_pending` and retry on later cycles if the route is unavailable.
- Use Jupiter's total input/output fields for wallet accounting when present, and verify acquired pool tokens against the confirmed transaction's owner-and-mint balance delta. Route amounts can differ when Jupiter collects a fee.
- If RPC cannot return token-balance deltas, a confirmed signature disagrees with its transaction, or confirmed rollback spends exceed the recorded acquisition, stop recovery and request manual reconciliation. Never deploy, sell existing wallet balances, or mark the operation cancelled while attribution is incomplete.
- Telegram must distinguish a recovered abort (operation-owned tokens returned to SOL) from a recovery that is still pending. Include the operation ID when pending and tell the operator not to manually move those assets until reconciliation finishes.
- If add-liquidity fails, confirm whether the position account exists. Close an empty position to recover rent when safe, then recover both tokens. Track unrecoverable/shared bin-array rent separately from position rent.
- During exit, retain the open/recovery record until liquidity removal, both token swaps, account cleanup, and balance reconciliation complete.

## Validation matrix

- TA: exact boundary widths; Spot/Curve; active-bin inclusion; missing, stale, duplicate, unordered, zero, negative, non-finite, and insufficient candles; extreme volatility; invalid bin step; rounding and integer boundaries.
- Budgeting: SOL on X, SOL on Y, neither side SOL, configured USDC, equal/asymmetric geometry, decimals 0/6/9, quote rounding, dust, low liquidity, price impact, and reserve exhaustion.
- Transactions: quote failures; swap-X success then swap-Y failure; timeouts with confirmed and unconfirmed signatures; RPC lag; add-liquidity simulation/send failure; empty created position; partial account creation; process restart after every journal transition; duplicate cycle/concurrent invocation.
- Exit/rent: mixed X/Y withdrawal; fee claim failure; one conversion failing; ATA creation/closure rent; position rent returned; shared bin-array rent; close confirmation delay; wallet balance mismatches; repeated resume without duplicate swaps or close.
- Compatibility: default config remains single-sided; single-sided bounds/amount behavior and dry-run reports remain unchanged; dual-token paths never accept LLM-supplied strategy or amounts.

## Implementation notes

- Use the Meteora DLMM Data API OHLCV endpoint and the installed `@meteora-ag/dlmm` package's `Spot`, `Curve`, range, position, removal, and rent helpers.
- Keep the adaptive TA and budget functions pure where possible; inject RPC/Jupiter operations so failure handling is covered with deterministic tests.
- Do not enable the mode by default. Rollout starts with config disabled and dry-run output verified before any live deployment.
- The current path only accepts standard SPL Token mints and refuses ranges that need non-refundable bin-array initialization rent.
- If any confirmed transaction fee cannot be read from RPC, dual PnL is marked unavailable and manager actions are suppressed until accounting is complete.
- The RPC PnL engine must price token X and token Y by their actual mints. For a STRK-USDC pool, USDC uses its own USD price; the SOL/USD price is only the denominator for SOL accounting. A missing price for either held token makes PnL unavailable and blocks PnL-based exits.
- Exit retries persist exact signed Jupiter intents. When Jupiter cannot return the exact output amount for a confirmed historical swap, the RPC balance-delta fallback is recorded with its provenance because it can include recoverable account lamports.
- No live wallet transaction has been exercised as part of implementation verification; test suites use pure calculations, journal files, and mocked/pure policy checks.
