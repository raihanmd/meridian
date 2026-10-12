# Meridian Repository Audit

**Date:** 2026-06-09  
**Auditor:** Atlas  
**Status:** Research complete — no implementation performed

## High-level architecture

Meridian is a Node.js ESM autonomous Solana DLMM LP agent for Meteora. It has three main execution surfaces:
- `index.js`: daemon entrypoint with cron, REPL, Telegram, health/briefing/poller orchestration
- `cli.js`: direct command surface for tools and one-shot screen/manage flows
- `setup.js`: first-run wizard writing `.env` and `user-config.json`

Core runtime flow:
1. `index.js` starts cron jobs and interfaces
2. role-specific work calls `agentLoop()` from `agent.js`
3. `agent.js` builds a system prompt via `prompt.js`
4. the LLM gets a restricted tool set from `tools/definitions.js`
5. tool calls are executed through `tools/executor.js`
6. execution fans into DLMM, screening, wallet, token, study, state, memory, and logging modules

## Project stack, runtime, package manager, entry points

- Runtime: Node.js 18+ (`package.json`, ESM via `"type": "module"`)
- Package manager: npm
- Main daemon entry: `index.js`
- CLI entry: `cli.js` and bin `meridian`
- Setup entry: `setup.js`
- Key deps:
  - `openai`
  - `@meteora-ag/dlmm`
  - `@solana/web3.js`
  - `node-cron`
  - `jsonrepair`
  - `dotenv`
- Dev/live scripts from `package.json`:
  - `npm start` → `node index.js`
  - `npm run dev` → `DRY_RUN=true node index.js`
  - `npm run setup` → `node setup.js`
  - `npm test` → syntax-only test wrapper
  - `npm run test:screen`
  - `npm run test:agent`

## Important files and directories

### Root runtime and orchestration
- `index.js`: main daemon orchestration, cron, REPL, Telegram, deterministic management rules, screening flow
- `agent.js`: ReAct loop, tool restrictions by role, intent matching for GENERAL, OpenRouter/OpenAI-compatible chat harness
- `prompt.js`: system prompt builder for `SCREENER`, `MANAGER`, and `GENERAL`
- `config.js`: config loader, defaults, env hydration, deploy amount logic, runtime config object
- `repo-root.js`: stable repo-root path resolution

### Tooling layer
- `tools/definitions.js`: tool schemas exposed to the LLM
- `tools/executor.js`: tool dispatch and safety gate for protected tools
- `tools/dlmm.js`: Meteora DLMM integration, position fetch, deploy, close, claim, add/withdraw liquidity
- `tools/screening.js`: pool discovery, candidate ranking, hard filters, scoring
- `tools/wallet.js`: wallet balances and Jupiter swaps
- `tools/token.js`: token info, holders, narrative
- `tools/study.js`: top LPer study
- `tools/agent-meridian.js`: Agent Meridian API helper
- `tools/chart-indicators.js`: indicator confirmation hook for screening

### Memory, persistence, and reasoning
- `state.js`: tracked positions and deterministic exit state
- `pool-memory.js`: per-pool deploy history, notes, cooldowns, snapshots
- `lessons.js`: performance history, lessons extraction, threshold evolution
- `decision-log.js`: structured reason log for deploy/close/skip/no_deploy
- `signal-tracker.js`: transient staged screening signals
- `signal-weights.js`: Darwinian weighting of signals
- `strategy-library.js`: persisted LP strategies and active strategy selection
- `smart-wallets.js`: tracked smart wallet dataset and checks
- `token-blacklist.js`, `dev-blocklist.js`: deny-lists
- `hivemind.js`: shared learning sync

### Integrations and interfaces
- `telegram.js`: bot polling, auth, commands, live progress messages
- `discord-listener/index.js`: Discord selfbot listener
- `discord-listener/pre-checks.js`: Discord signal pre-filter pipeline
- `briefing.js`: daily report generation
- `.claude/agents/*.md`, `.claude/commands/*.md`: Claude Code integration surface

### Tests and scripts
- `test/test-agent.js`
- `test/test-screening.js`
- `scripts/envrypt.js`
- `scripts/patch-anchor.js`

## Agent flow from input to final recommendation/action

### Autonomous daemon flow
1. `index.js` boots, loads config/env, starts HiveMind sync, cron, REPL, Telegram
2. screening cycle calls `runScreeningCycle()`
3. management cycle calls `runManagementCycle()`
4. each cycle may invoke `agentLoop()` from `agent.js`
5. `agentLoop()`:
   - loads balances and positions
   - builds prompt with `buildSystemPrompt()` from `prompt.js`
   - selects tools by role or intent
   - calls the LLM
   - repairs malformed JSON arguments if needed
   - executes requested tool calls through `executeTool()`
   - loops until answer or max steps
6. final action is produced by real tool execution, not pure text

### Recommendation/action output points
- Screening final action: typically `deploy_position`
- Management final actions: `close_position`, `claim_fees`, `swap_token`, or hold/stay reporting
- Decision artifacts are persisted to `decision-log.json`
- Cycle reports are returned to REPL/CLI/Telegram

## How the AI agent system works

### Roles
Defined in `agent.js` through explicit tool subsets:
- `SCREENER`: screening and deploy-oriented tools
- `MANAGER`: close/claim/swap/PnL tools
- `GENERAL`: intent-matched subset using regex patterns over user goal text

### Prompting
Defined in `prompt.js`:
- `MANAGER`: lean, mechanical, rule-application prompt
- `SCREENER`: candidate-picking prompt with hard rules, risk signals, deploy formula, lessons, weights
- `GENERAL`: broader operational prompt with safeguards and intent-specific rules

### Tool restriction model
- `MANAGER_TOOLS`, `SCREENER_TOOLS`, `GENERAL_INTENT_ONLY_TOOLS`, and `INTENT_TOOLS` in `agent.js`
- tool schemas in `tools/definitions.js`
- execution mapping in `tools/executor.js`

### Safety behavior in the loop
- malformed JSON repair via `jsonrepair`
- once-per-session lockouts for dangerous tools like deploy/swap/close
- no-tool retry guard for actions that must use a real tool
- system-role fallback for providers that reject `system`

## Where prompts, roles, system messages, tools, or instructions are defined

- Role prompts/system messages: `prompt.js`
- Role tool access: `agent.js`
- Tool schemas visible to model: `tools/definitions.js`
- Tool execution implementation: `tools/executor.js`
- Claude-specific agent instructions: `.claude/agents/screener.md`, `.claude/agents/manager.md`
- Claude slash command wrappers: `.claude/commands/*.md`

## Existing external data sources

Confirmed code/data sources:
- Meteora DLMM SDK: `tools/dlmm.js`
- Meteora Pool Discovery API: `tools/screening.js`
- Jupiter APIs for price/swap/token metadata: `tools/wallet.js`, `tools/token.js`
- Helius wallet balances: `tools/wallet.js`
- Agent Meridian API / LPAgent relay / chart indicators / top LPers: `tools/agent-meridian.js`, `tools/study.js`, `tools/chart-indicators.js`
- Telegram Bot API: `telegram.js`
- Discord selfbot feed: `discord-listener/*`
- HiveMind sync backend: `hivemind.js`

## How the agent gets market/pool/token/project data

### Pool / market data
- `tools/screening.js` fetches pools from `https://pool-discovery-api.datapi.meteora.ag`
- `getTopCandidates()` applies local hard filters and scoring
- `getPoolDetail()` fetches a specific pool view by timeframe

### Position / on-chain data
- `tools/dlmm.js` uses `@meteora-ag/dlmm` and Solana web3 to fetch positions, active bins, and build/send transactions

### Token/project data
- `tools/token.js` fetches token info, holders, narrative
- `tools/wallet.js` fetches wallet balances from Helius and prices/swaps from Jupiter
- `tools/study.js` studies top LPers through Agent Meridian APIs

## Meteora DLMM integration status

Yes — already deeply integrated.

Evidence:
- `@meteora-ag/dlmm` dependency in `package.json`
- lazy SDK loader in `tools/dlmm.js`
- position read methods in `tools/dlmm.js`
- deploy/close/liquidity methods in `tools/dlmm.js`
- executor routes `deploy_position`, `close_position`, etc. to DLMM implementations

Key implementation notes:
- SDK is lazy-loaded to avoid import-time failures
- position/pool caches exist
- deploy path supports safety validation and transaction simulation
- wide-range / extended position handling exists in DLMM wrapper per project docs and code structure

## Existing pool selection flow

Primary selection path lives in `tools/screening.js` and `index.js`.

1. `index.js:runScreeningCycle()` checks open positions and balance first
2. `getTopCandidates()` in `tools/screening.js` fetches a pool set and filters candidates
3. hard filters include:
   - TVL bounds
   - fee/active TVL threshold
   - usable volatility
   - duplicate pool and duplicate base mint exclusion
   - cooldown exclusions from `pool-memory.js`
   - PVP symbol logic
   - dev blocklist logic
   - optional indicator confirmation
4. remaining pools are scored using:
   - `fee_active_tvl_ratio`
   - `organic_score`
   - `volume_window`
   - `holders`
5. `index.js` enriches finalists with:
   - active bin
   - smart wallet check
   - token narrative
   - token info
6. LLM gets candidate blocks and decides deploy vs skip

## Existing reasoning flow

There are several reasoning layers already:

1. **Hard-coded deterministic reasoning**
   - pre-LLM pool filters in `tools/screening.js`
   - deterministic close rules in `index.js`
   - protected-tool safety checks in `tools/executor.js`

2. **LLM reasoning**
   - prompt-guided deploy/skip judgment in `prompt.js`
   - management execution only when non-STAY actions are identified

3. **Historical reasoning memory**
   - `lessons.js` injects lessons learned
   - `decision-log.js` injects recent structured decisions
   - `pool-memory.js` injects pool-specific history and cooldowns
   - `signal-weights.js` injects signal weighting summary

## Where final recommendations or actions are produced

- Final recommendations are surfaced by `agentLoop()` return content in `agent.js`
- Final actions are executed through `executeTool()` in `tools/executor.js`
- Screening action endpoint: `deploy_position`
- Management action endpoints: `close_position`, `claim_fees`, `swap_token`
- Human-readable reports are assembled in `index.js` around cycle execution
- Decision records are persisted in `decision-log.json`

## Simulation, execution, transaction building, or recommendation only?

The project supports all four:

### Recommendation
- LLM can screen/analyze/report without acting

### Simulation / dry run
- `DRY_RUN=true` support across daemon/CLI
- `cli.js` sets dry-run before tool imports
- deploy/close/swap paths respect dry-run guards
- transaction simulation is present in `tools/dlmm.js`

### Transaction building
- `tools/dlmm.js` builds deploy/close/liquidity transactions
- `tools/wallet.js` builds Jupiter swaps

### Real execution
- live deploy, close, claim, add/withdraw liquidity, and swap all exist
- protected by executor safety checks and runtime mode

Conclusion: Meridian is not recommendation-only. It is an execution-capable autonomous trading agent.

## Existing config system

Main config file: `config.js`

Config sources:
- `user-config.json`
- `.env`
- runtime updates through `update_config`

Top-level config groups confirmed in code:
- `risk`
- `screening`
- `management`
- `strategy`
- `schedule`
- `llm`
- `darwin`
- `tokens`
- `hiveMind`
- `api`
- `jupiter`
- `indicators`

Notable behavior:
- config hydrates some env vars from user-config if absent
- `computeDeployAmount()` computes position size from balance and reserve rules
- `reloadScreeningThresholds()` supports live threshold refresh

## Existing safety/risk checks

### Screening-time filters
In `tools/screening.js`:
- min/max TVL
- min fee/active TVL ratio
- usable volatility requirement
- already-open pool exclusion
- one-position-per-base-token exclusion
- pool cooldown and token cooldown
- PVP filtering / warning path
- dev blocklist exclusion
- optional indicator confirmation

### Execution-time checks
In `tools/executor.js` for protected tools:
- fresh pool detail validation before deploy
- deploy range validation
- min bins below / single-side constraints
- max open positions
- duplicate pool guard
- duplicate token guard
- deploy amount lower and upper bounds
- live SOL balance check if not dry run
- self-update disabled unless explicitly allowed

### Ongoing management controls
In `index.js` and `state.js`:
- stop loss
- trailing take-profit with delayed reconfirmation
- out-of-range timers
- low-yield exit logic
- deterministic management path before LLM involvement

### Persistent policy datasets
- `token-blacklist.json`
- `dev-blocklist.json`
- `smart-wallets.json`
- `pool-memory.json`
- `decision-log.json`

## Tests, lint commands, build commands, and dev scripts

From `package.json`:
- `npm run setup`
- `npm start`
- `npm run dev`
- `npm test`
- `npm run test:syntax`
- `npm run test:screen`
- `npm run test:agent`
- `npm run env:encrypt`
- `npm run pm2:start`
- `npm run pm2:restart`
- `npm run pm2:logs`

Observed test reality:
- no formal lint script found
- no formal build/transpile step found
- tests are lightweight scripts, not a full suite
- syntax test uses `node --check` over JS files

## What is missing for adding a Sharia Advisor reasoning layer

Likely missing pieces:
- no domain-specific ethical/religious compliance layer exists today
- no extra reasoning stage between candidate generation and deploy decision
- no compliance cache/store for token/pool classification
- no config namespace for faith-based screening policy
- no tool schemas for classification or compliance lookup
- no prompt sections instructing the screener/manager to consider Sharia criteria

### Most relevant files for future implementation
- `prompt.js` — inject Sharia reasoning instructions
- `agent.js` — if a new tool or role gating is needed
- `tools/definitions.js` — define compliance tools
- `tools/executor.js` — wire compliance tool execution and optional hard gate
- `tools/screening.js` — add pre-LLM Sharia hard filters or enrichments
- `config.js` — add `sharia` config section
- `user-config.example.json` — expose sample config
- `pool-memory.js` or a new cache file — persist prior compliance judgments if desired
- `decision-log.js` — record compliance-based skip reasons
- `index.js` — if an additional screening/reporting step is needed in cycle orchestration

## Open questions

1. What exact Sharia policy source should be trusted?
   - static allow/block lists?
   - third-party API?
   - internal classifier + manual overrides?

2. Should Sharia act as:
   - a hard filter before the LLM,
   - an enrichment signal for the LLM,
   - or both?

3. Is compliance assessed at token level, pool level, strategy level, or all three?

4. Should existing open positions be re-evaluated under the Sharia layer, or only new deployments?

5. Does the desired layer need explainable output suitable for user-facing audit trails in Telegram/CLI?

6. Should non-compliance create a permanent blacklist entry, a soft skip reason, or a separate Sharia-specific memory store?

## Summary

Meridian already has:
- a mature agent harness
- strong tool segregation by role
- deep Meteora integration
- real execution capability
- multiple safety layers
- historical reasoning via lessons, pool memory, and decision logs

The cleanest insertion point for a future Sharia Advisor is the screening pipeline plus prompt layer, with optional executor enforcement for hard compliance mode.
