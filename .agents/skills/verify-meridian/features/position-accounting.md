# Position value and management

`/positions` displays current position value, net PnL when its inputs are complete, and unclaimed fees. The management cycle can close a position from PnL or range rules. Dual-token PnL is denominated in the configured SOL budget; capital movement, LP fees, transaction fees, and unrecovered rent are accounted for separately.

## Sub-features

- `positions-telegram` lists live positions and shows `pending cost basis` while PnL is unverified.
- `dual-net-pnl` values each mint at its own price and uses actual position rent. Missing deposit history, token prices, rent, or recorded transaction fees leaves PnL unavailable.
- `manager-pnl-guard` does not act on stop-loss, take-profit, or trailing-profit rules from suspicious or missing PnL.
- `position-sync` requires direct account absence before state marks a position closed after its indexing grace period.
- `dual-exit` claims, removes liquidity, closes the position, and swaps operation-owned non-SOL output to SOL. Dual-token exit does not use the LPAgent zap-out relay.

## How to get to it

- Send `/positions` to the operator's running Telegram bot to view the current list.
- The management cycle runs on its configured schedule, or through the CLI `manage` command in an isolated environment.
- For offline verification, run `node --test test/pnl-token-valuation.test.js test/pnl-dual-rent.test.js test/position-discovery.test.js test/dual-deploy.test.js`.

## Driving and evidence

- Run the parent Doctor first. Do not start another Telegram poller against the production bot.
- A Telegram check requires authorization to use the running bot, a suitable open position, and read-only inspection of `dual-operations.json` first. Do not call `/positions` while a dual exit is pending: its position lookup can resume token-to-SOL swaps. Capture the response and matching account, token prices, Meteora deposit record, and position rent. A pending basis should display `pending cost basis` and never a numeric gain.
- A management or exit proof requires a disposable funded wallet and isolated environment. Capture the action, confirmed claim/remove/swap transactions, journal stage, paid and recovered rent, and final SOL balance. Never issue a live close merely for verification.
- Offline tests cover calculation and discovery decisions. They do not prove a live Telegram response or on-chain exit.

## Gotchas

- Meteora's green gross position PnL can differ from net SOL-budget PnL because swap costs, execution fees, and unrecovered rent are separate.
- The SDK's quoted position cost is a reserve estimate. Read position account lamports for the paid and recoverable rent basis.
- An empty portfolio result alone does not prove the position closed. If the account still exists or RPC lookup fails, discovery is unresolved and autonomous screening must wait.
