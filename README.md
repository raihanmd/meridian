# Meridian

**Autonomous Meteora DLMM liquidity management agent for Solana, powered by LLMs.**

**Links:** [Website](https://agentmeridian.xyz) | [Telegram](https://t.me/agentmeridian) | [X](https://x.com/meridian_agent)

Meridian runs continuous screening and management cycles, deploying capital into high-quality Meteora DLMM pools and closing positions based on live PnL, yield, and range data. It learns from every position it closes.

---

## What it does

- **Screens pools** — scans Meteora DLMM pools against configurable thresholds (fee/TVL ratio, organic score, holder count, mcap, bin step) and surfaces high-quality opportunities
- **Manages positions** — monitors, claims fees, and closes LP positions autonomously; decides to STAY, CLOSE, or REDEPLOY based on live data
- **Learns from performance** — studies top LPers in target pools, saves structured lessons, and evolves screening thresholds based on closed position history
- **Discord signals** — optional Discord listener watches LP Army channels for Solana token calls and queues them for screening
- **Telegram chat** — full agent chat via Telegram, plus cycle reports and OOR alerts
- **Claude Code integration** — run AI-powered screening and management directly from your terminal using Claude Code slash commands

---

## How it works

Meridian runs a **ReAct agent loop** — each cycle the LLM reasons over live data, calls tools, and acts. Two specialized agents run on independent cron schedules:

| Agent | Default interval | Role |
|---|---|---|
| **Screening Agent** | Every 30 min | Pool screening — finds and deploys into the best candidate |
| **Management Agent** | Every 10 min | Position management — evaluates each open position and acts |

### Agent harness

Meridian's agent harness is the runtime wrapper around every autonomous cycle. It gives both **main** and **experimental** agents the same control loop: load live state, inject relevant memory, expose only role-appropriate tools, execute tool calls, and return a readable cycle report.

The harness also keeps a structured decision log in `decision-log.json` for deployments, closes, skips, and no-deploy outcomes. Each entry records the actor, pool or position, summary, reason, key risks, metrics, and rejected alternatives. Recent decisions are injected back into the system prompt and are available through `get_recent_decisions`, so the agent can answer "why did you deploy?", "why did you close?", or "why did you skip?" without guessing after the fact.

**Data sources:**
- `@meteora-ag/dlmm` SDK — on-chain position data, active bin, deploy/close transactions
- Meteora DLMM PnL API — position yield, fee accrual, PnL
- Pool screening API — fee/TVL ratios, volume, organic scores, holder counts
- Jupiter API — token audit, mcap, launchpad, price stats

Agents are powered via **OpenRouter** and can be swapped for any compatible model.

---

## Requirements

- Node.js 18+
- [OpenRouter](https://openrouter.ai) API key
- Solana wallet (base58 private key)
- Solana RPC endpoint ([Helius](https://helius.xyz) recommended)
- Telegram bot token (optional)
- [Claude Code](https://claude.ai/code) CLI (optional, for terminal slash commands)

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/yunus-0x/meridian
cd meridian
npm install
```

### 2. Run the setup wizard

```bash
npm run setup
```

The wizard writes **both** files at the repo root:

| Goes in `.env` | Goes in `user-config.json` |
|---|---|
| `WALLET_PRIVATE_KEY`, `OPENROUTER_API_KEY`, `RPC_URL`, `HELIUS_API_KEY` | Risk preset, deploy size, max positions |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ALLOWED_USER_IDS` | Strategy, screening filters, exit rules, trailing TP |
| `DRY_RUN` | Position sizing, cycle intervals, per-role LLM models, `solMode` |

`TELEGRAM_CHAT_ID` only needs to live in `.env` — setup also copies it to `user-config.json` when provided. Takes about 2 minutes.

**Or set up manually:**

Create `.env`:

```env
WALLET_PRIVATE_KEY=your_base58_private_key
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
PNL_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
OPENROUTER_API_KEY=sk-or-...
HELIUS_API_KEY=your_helius_key          # for wallet balance lookups
TELEGRAM_BOT_TOKEN=123456:ABC...        # optional — for notifications + chat
TELEGRAM_CHAT_ID=                       # auto-filled on first message
DRY_RUN=true                            # set false for live trading
```

> Never put your private key or API keys in `user-config.json` — use `.env` only. Both files are gitignored.

`RPC_URL` and `PNL_RPC_URL` are separate. Position/PnL reads default to `https://pump.helius-rpc.com` unless `PNL_RPC_URL` is set. A nonempty `pnlRpcUrl` in `user-config.json` overrides `PNL_RPC_URL`. The PnL poller runs every 3 seconds by default, so choose an RPC plan that supports the expected request volume.

Optional encrypted `.env` flow:

```bash
cp .env .env.raw
printf "replace-with-a-long-local-key\n" > .envrypt
npm run env:encrypt
```

Meridian loads envrypt-style encrypted values automatically. Keep `.env.raw` and `.envrypt` local; both are gitignored.

Copy config and edit as needed:

```bash
cp user-config.example.json user-config.json
```

See [Config reference](#config-reference) below.

### 3. Run

```bash
npm run dev    # dry run — no on-chain transactions
npm start      # live mode
```

On startup Meridian fetches your wallet balance, open positions, and top pool candidates, then begins autonomous cycles immediately.

### Run with PM2 (VPS / always-on)

PM2 is the recommended way to keep Telegram control online on a VPS. **Always start via the ecosystem file** so the working directory and script path stay pinned to the repo:

```bash
npm install
npm run pm2:start    # uses ecosystem.config.cjs — do NOT use "pm2 start index.js"
pm2 save
```

After `.env`, `user-config.json`, or code changes:

```bash
npm run pm2:restart  # re-reads .env on each restart
npm run pm2:logs
```

To update an existing PM2 install:

```bash
git pull
npm install
npm run pm2:restart
pm2 save
```

If a previous PM2 run was started incorrectly, reset it once:

```bash
pm2 delete meridian
npm run pm2:start
pm2 save
```

**PM2 vs `npm start`**

| | `npm start` | PM2 |
|---|---|---|
| Terminal | Interactive REPL | Headless daemon |
| Cron / Telegram | Starts after REPL banner | Starts immediately on boot |
| First screening | On cron schedule | May run one cycle right at startup |
| Best for | Local dev / testing | VPS / 24-7 operation |

On startup, logs show `Repo: ... | cwd: ... | PM2 id: ...`. **Repo and cwd must match.** If they differ, delete the process and use `npm run pm2:start` again.

**Common PM2 issues**

| Symptom | Likely cause | Fix |
|---|---|---|
| Crash loop after `git pull` | `npm install` skipped | `npm install && npm run pm2:restart` |
| Missing wallet / API keys | Started with `pm2 start index.js` from wrong directory | `pm2 delete meridian && npm run pm2:start` |
| `.env` changes ignored | Old PM2 env snapshot | `npm run pm2:restart` (`.env` now overrides stale PM2 env) |
| Telegram `401 Unauthorized` | Invalid `TELEGRAM_BOT_TOKEN` (not chat ID) | Fix token in `.env`; if encrypted, ensure `.envrypt` exists |
| Telegram commands ignored | Missing/wrong `TELEGRAM_CHAT_ID` | Set in `.env` (or `telegramChatId` in `user-config.json`) |
| Duplicate polling / 409 errors | `nohup node index.js` or second PM2 instance running | Kill stray processes; run only one PM2 app |
| Encrypted env crash at boot | `# encrypted` lines without `.envrypt` key | Add `.envrypt` or use plain `.env` values |

Avoid `nohup node index.js` — it runs outside PM2 and can leave a duplicate Telegram poller fighting the managed process.

---

## Running modes

### Autonomous agent

```bash
npm start
```

Starts the full autonomous agent with cron-based screening + management cycles and an interactive REPL. The prompt shows a live countdown to the next cycle:

```
[manage: 8m 12s | screen: 24m 3s]
>
```

REPL commands:

| Command | Description |
|---|---|
| `/status` | Wallet balance and open positions |
| `/candidates` | Re-screen and display top pool candidates |
| `/learn` | Study top LPers across all current candidate pools |
| `/learn <pool_address>` | Study top LPers for a specific pool |
| `/thresholds` | Current screening thresholds and performance stats |
| `/evolve` | Trigger threshold evolution from performance data (needs 5+ closed positions) |
| `/stop` | Graceful shutdown |
| `<anything>` | Free-form chat — ask the agent anything, request actions, analyze pools |

---

### Claude Code terminal (recommended)

Install [Claude Code](https://claude.ai/code) and use it from inside the meridian directory. Claude Code has built-in agents and slash commands that use the `meridian` CLI under the hood.

```bash
cd meridian
claude
```

#### Slash commands

| Command | What it does |
|---|---|
| `/screen` | Full AI screening cycle — checks Discord queue, reads config, fetches candidates, runs deep research, and deploys if a winner is found |
| `/manage` | Full AI management cycle — checks all positions, evaluates PnL, claims fees, closes OOR/losing positions |
| `/balance` | Check wallet SOL and token balances |
| `/positions` | List all open DLMM positions with range status |
| `/candidates` | Fetch and enrich top pool candidates (pool metrics + token audit + smart money) |
| `/study-pool` | Study top LPers on a specific pool |
| `/pool-ohlcv` | Fetch price/volume history for a pool |
| `/pool-compare` | Compare all Meteora DLMM pools for a token pair by APR, fee/TVL ratio, and volume |

#### Claude Code agents

Two specialized sub-agents run inside Claude Code:

**`screener`** — pool screening specialist. Invoke when you want to evaluate candidates, analyse token risk, or deploy a position. Has access to Jupiter token audit, smart-wallet checks, and all strategy logic.

**`manager`** — position management specialist. Invoke when reviewing open positions, assessing PnL, claiming fees, or closing positions.

To trigger an agent directly, just describe what you want:
```
> screen for new pools and deploy if you find something good
> review all my positions and close anything out of range
> what do you think of the SOL/BONK pool?
```

#### Loop mode

Run screening or management on a timer inside Claude Code:

```
/loop 30m /screen     # screen every 30 minutes
/loop 10m /manage     # manage every 10 minutes
```

---

### CLI (direct tool invocation)

The `meridian` CLI gives you direct access to every tool with JSON output — useful for scripting, debugging, or piping into other tools.

```bash
npm install -g .   # install globally (once)
meridian <command> [flags]
```

Or run without installing:

```bash
node cli.js <command> [flags]
```

**Positions & PnL**

```bash
meridian positions
meridian pnl <position_address>
meridian wallet-positions --wallet <addr>
```

**Screening**

```bash
meridian candidates --limit 5
meridian pool-detail --pool <addr> [--timeframe 5m]
meridian active-bin --pool <addr>
meridian search-pools --query <name_or_symbol>
meridian study --pool <addr> [--limit 4]
```

**Token research**

```bash
meridian token-info --query <mint_or_symbol>
meridian token-holders --mint <addr> [--limit 20]
meridian token-narrative --mint <addr>
```

**Deploy & manage**

```bash
meridian deploy --pool <addr> --amount <sol> [--bins-below 69] [--bins-above 0] [--strategy bid_ask|spot|curve] [--dry-run]
meridian claim --position <addr>
meridian close --position <addr> [--skip-swap] [--dry-run]
meridian swap --from <mint> --to <mint> --amount <n> [--dry-run]
meridian add-liquidity --position <addr> --pool <addr> [--amount-x <n>] [--amount-y <n>] [--strategy spot]
meridian withdraw-liquidity --position <addr> --pool <addr> [--bps 10000]
```

**Agent cycles**

```bash
meridian screen [--dry-run] [--silent]   # one AI screening cycle
meridian manage [--dry-run] [--silent]   # one AI management cycle
meridian start [--dry-run]               # start autonomous agent with cron jobs
```

**Config**

```bash
meridian config get
meridian config set <key> <value>
```

**Learning & memory**

```bash
meridian lessons
meridian lessons add "your lesson text"
meridian performance [--limit 200]
meridian evolve
meridian pool-memory --pool <addr>
```

**Blacklist**

```bash
meridian blacklist list
meridian blacklist add --mint <addr> --reason "reason"
```

**Discord signals**

```bash
meridian discord-signals
meridian discord-signals clear
```

**Balance**

```bash
meridian balance
```

**Flags**

| Flag | Effect |
|---|---|
| `--dry-run` | Skip all on-chain transactions |
| `--silent` | Suppress Telegram notifications for this run |

---

## Discord listener

The Discord listener watches configured channels (e.g. LP Army) for Solana token calls and queues them as signals for the screener agent.

### Setup

```bash
cd discord-listener
npm install
```

Add to your root `.env`:

```env
DISCORD_USER_TOKEN=your_discord_account_token   # from browser DevTools → Network
DISCORD_GUILD_ID=the_server_id
DISCORD_CHANNEL_IDS=channel1,channel2            # comma-separated
DISCORD_MIN_FEES_SOL=5                           # minimum pool fees to pass pre-check
```

> This uses a selfbot (personal account automation, not a bot token). Use responsibly.

### Run

```bash
cd discord-listener
npm start
```

Or run it in a separate terminal alongside the main agent. Signals are written to `discord-signals.json` and picked up automatically by `/screen` and `node cli.js screen`.

### Signal pipeline

Each incoming token address passes through a pre-check pipeline before being queued:
1. **Dedup** — ignores addresses seen in the last 10 minutes
2. **Blacklist** — rejects blacklisted token mints
3. **Pool resolution** — resolves the address to a Meteora DLMM pool
4. **Rug check** — checks deployer against `deployer-blacklist.json`
5. **Fees check** — rejects pools below `DISCORD_MIN_FEES_SOL`

Signals that pass all checks are queued with status `pending`. The screener picks up pending signals and processes them as priority candidates before running the normal screening cycle.

### Deployer blacklist

Add known rug/farm deployer wallet addresses to `deployer-blacklist.json`:

```json
{
  "_note": "Known farm/rug deployers — add addresses to auto-reject their pools",
  "addresses": [
    "WaLLeTaDDressHere"
  ]
}
```

---

## Telegram

### Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token
2. Add to `.env`:

```env
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<your chat id>          # .env alone is enough; also saved to user-config by setup
TELEGRAM_ALLOWED_USER_IDS=<user id>    # required for group/supergroup control
```

Meridian does **not** auto-register the first chat for safety — you must set `TELEGRAM_CHAT_ID` explicitly. For groups, also set `TELEGRAM_ALLOWED_USER_IDS` or inbound commands are ignored.

`401 Unauthorized` in logs means a bad `TELEGRAM_BOT_TOKEN` (invalid, revoked, or encrypted without a working `.envrypt` key) — not a chat ID problem.

### Notifications

Meridian sends notifications automatically for:
- Management cycle reports (reasoning + decisions)
- Screening cycle reports (what it found, whether it deployed)
- OOR alerts when a position leaves range past `outOfRangeWaitMinutes`
- Deploy: pair, amount, position address, tx hash
- Close: pair and PnL

### Telegram commands

| Command | Action |
|---|---|
| `/positions` | List open positions with progress bar |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set a note on a position |

You can also chat freely via Telegram using the same interface as the REPL. Only allowed user IDs can issue commands in groups.

---

## Config reference

All fields are optional — defaults shown. Edit `user-config.json`.

### Screening

| Field | Default | Description |
|---|---|---|
| `minFeeActiveTvlRatio` | `0.05` | Minimum fee/active-TVL ratio |
| `minTvl` | `10000` | Minimum pool TVL (USD) |
| `maxTvl` | `150000` | Maximum pool TVL (USD) |
| `minVolume` | `500` | Minimum pool volume |
| `minOrganic` | `60` | Minimum organic score (0–100) |
| `minHolders` | `500` | Minimum token holder count |
| `minMcap` | `150000` | Minimum market cap (USD) |
| `maxMcap` | `10000000` | Maximum market cap (USD) |
| `minBinStep` | `80` | Minimum bin step |
| `maxBinStep` | `125` | Maximum bin step |
| `timeframe` | `5m` | Candle timeframe for screening |
| `category` | `trending` | Pool category filter |
| `minTokenFeesSol` | `30` | Minimum all-time fees in SOL |
| `maxBotHoldersPct` | `30` | Maximum bot holder % (Jupiter audit) |
| `maxTop10Pct` | `60` | Maximum top-10 holder concentration |
| `blockedLaunchpads` | `[]` | Launchpad names to never deploy into |
| `tokenAllowlist` | `[]` | Token mints permitted for deployment on both sides of a pool; an empty list blocks every deploy |

Set `tokenAllowlist` in `user-config.json` to an array of `{ "name", "mint" }` objects. For example, to deploy only to GHOST/SOL pools:

```json
"tokenAllowlist": [
  { "name": "GHOST", "mint": "BBKPiLM9KjdJW7oQSKt99RVWcZdhF6sEHRKnwqeBGHST" },
  { "name": "SOL", "mint": "So11111111111111111111111111111111111111112" }
]
```

Meridian deploys only single-sided SOL into token Y, so deploy candidates must have SOL as token Y even when the allowlist contains other quote tokens. Startup, each scheduled screening cycle, terminal `/candidates`, and Telegram `/screen` and `/candidates` show every pool returned by the current discovery page that passes the screening settings. Telegram marks an allowlisted base token with `✅` even if its pair is still observation-only; `✅ ALLOWLIST · SOL PAIR` means that the base and SOL mints pass only the pair-level deployment guard. Later entry checks can still reject that pool. The message counts allowlisted base pools and allowlisted SOL pairs on that discovery page. Interactive startup sends its initial candidate list to Telegram after polling starts, without delaying the bot's cycles; terminal `/candidates` sends a refreshed list too. Pool order stays the order returned by discovery. The separate `SCREENING DEPLOYMENT` message reports which pools passed the remaining entry guards; when none pass, it shows reasons for allowlisted base tokens before three examples of recorded rejects. A zero deploy-ready count does not mean discovery found zero pools. With `DRY_RUN=true`, a simulated entry selected by the agent is labeled `DRY RUN · WOULD DEPLOY` and creates no position or transaction. The dry-run result does not guarantee that a later live deployment will pass all checks. Autonomous selection considers only pools that pass all entry guards. Manual deploys are blocked for observation-only pools too; the deploy path checks fresh pool details and on-chain pool data. Edit the file and restart the bot to change the list; the AI `update_config` tool cannot change it.

### Asynchronous token research

One `bun start` process runs management, screening/deployment, and a background research worker. The main Meridian flow writes each newly discovered base mint to the durable queue under `data/token-research/`, including `OBSERVE` tokens. It does this on interactive startup, manual/Telegram candidate refreshes, and scheduled screening cycles, even when deployment prechecks skip the AI screener. The research worker consumes that queue and invokes Hermes with only the `web` toolset; it does not fetch pools itself. Trading and position management never wait for Hermes. Reports are saved under `data/token-research/<mint>/report.json` and sent to the configured Telegram chat. Review the report and its source URLs yourself, then add approved mints to `tokenAllowlist` (including SOL for SOL pairs) and restart `meridian`. An empty `tokenAllowlist` keeps pool discovery and research active while blocking every deployment.

Queue state is stored under `data/token-research/<mint>/job.json`. A failed Hermes run retries up to five times with backoff; `failed` jobs remain on disk for inspection and can be queued again with `npm run research:retry -- <MINT>` or, after the provider is fixed and a probe succeeds, `bun run research:retry -- --all` for every failed research job. Stop the bot before using the bulk command, then restart it to process the jobs. The bulk command leaves pending, ready, and sent jobs untouched. Telegram delivery retries independently from the saved report until acknowledged. A process crash can cause a duplicate Telegram message if it happens after Telegram accepts a message but before the delivery state is saved. Multiple pools for the same mint share one research job. Discovery currently sees the first page of up to 50 pools per scan, so the worker cannot guarantee coverage beyond that page.

On Hermes versions with structured CLI output, research requires a successful `web_search` result. Older CLI versions lack this output, so Meridian uses a plain one-shot command and accepts only reports with at least one source URL; it cannot prove which tools the model called. An unavailable-web response or source-less report retries instead of being sent as a completed research report. The worker automatically requeues older reports that had no sources. A genuine no-result search can produce an `unknown` report only on a CLI version where a successful web search can be verified. Web provider keys inherited by Meridian are passed to Hermes only from an explicit allowlist; wallet and Telegram credentials are excluded.

To test the same Hermes CLI integration without touching queue state or sending Telegram, stop the bot and run `bun run research:probe -- <MINT> [SYMBOL]`. For example, use the DARK mint `7KEPApdbBMByrmqihz3bht2uMhFQcatjfSFQCKq66kH3` with symbol `DARK`. The probe prints the parsed report or a concrete CLI/web-tool error. It uses the same Hermes subprocess, web toolset, environment allowlist, and search verification as the worker, with a temporary working directory.

After a research report reaches Telegram, the same worker can run a separate preliminary Syariah Judge pass using the Hermes skill named `syariah-judge`. Install that skill **on the VPS, as the same Linux user that runs `bun start` or PM2**, at `~/.hermes/skills/research/syariah-judge/SKILL.md`. Meridian does not install or edit the skill. Until the file exists, research reports continue and judgment jobs wait. The worker preloads the skill with `hermes chat --skills syariah-judge --toolsets skills`, passes only the saved dossier, and limits this pass to 60 seconds. It saves the result as `data/token-research/<mint>/judgment.json` and sends a separate Telegram message. A failed judgment retries three times and can be queued again with `npm run research:retry -- --judge <MINT>`; Telegram delivery retries from the saved judgment. This is evidence-linked input for human review, never a fatwa or automatic allowlist change. If you install the skill after the bot is already running, a new Hermes invocation will pick it up; check the main bot log if no judgment arrives.

On the VPS, run `hermes tools`, enable **Web Search & Scraping**, and select a working search and extract backend (for example Firecrawl). A checked toolset alone does not prove that the backend works. On the older Hermes CLI used by this deployment, check a direct search with:

```bash
hermes chat -Q -q 'Use web_search to find the exact mint 7KEPApdbBMByrmqihz3bht2uMhFQcatjfSFQCKq66kH3 and return a URL containing it. If web_search is unavailable, answer WEB_UNAVAILABLE.' --toolsets web
```

The DARK mint appears in the [DarkSwap whitepaper](https://darkswap.app/docs/whitepaper), so this is a known-answer test. If the command returns `WEB_UNAVAILABLE`, fix Hermes web configuration before retrying Meridian jobs. Current Hermes releases document several keyless backends, but an older installation may need an explicit provider or upgrade; follow the options shown by that installed version of `hermes tools`. Once the direct test succeeds, run `bun run research:probe -- 7KEPApdbBMByrmqihz3bht2uMhFQcatjfSFQCKq66kH3 DARK` and check that the report connects the exact mint to DarkSwap with source URLs. Then retry failed queued jobs and restart `bun start`.

For **Firecrawl Self-Hosted**, start and verify the Firecrawl Docker Compose stack first, following its [versioned self-host guide](https://docs.firecrawl.dev/contributing/self-host). Bind its unauthenticated API to loopback and configure `FIRECRAWL_API_URL=http://127.0.0.1:3002` for the same Linux user that runs Hermes and Meridian. A selected provider without a running API does not make web tools usable. Meridian passes this URL to the Hermes subprocess when it is inherited in the bot environment.

Hermes must be available to the same Linux user as Meridian. Its model and web credentials should be configured in Hermes itself or inherited by Meridian as supported web provider environment variables. Check `command -v hermes`; if PM2 cannot find the executable, set `HERMES_BIN` to that absolute path in the PM2 environment. `bun start` runs all three cycles in one process; `npm run pm2:start` manages that same process. If an older deployment has a separate `meridian-research` PM2 app, remove it once with `pm2 delete meridian-research` before restarting the main app, so the embedded worker can acquire the queue lock. `bun run research:start` remains available for standalone debugging when the main bot is stopped. The main bot logs each observer discovery to `logs/agent-YYYY-MM-DD.log` and sends the full current discovery page to Telegram when a scheduled screening cycle runs. The research worker logs each job transition and sends a Telegram heartbeat when it starts and every `screeningIntervalMin` minutes. Inspect `pm2 logs meridian --lines 100` (or the `bun start` terminal) and the queue files if a report does not arrive. The worker passes basic process settings and allowlisted web provider credentials to Hermes; wallet and Telegram secrets from Meridian are excluded. It does not use research conclusions to deploy automatically.

### Management

| Field | Default | Description |
|---|---|---|
| `deployAmountSol` | `0.5` | Base SOL per new position |
| `positionSizePct` | `0.35` | Fraction of deployable balance to use |
| `maxDeployAmount` | `50` | Maximum SOL cap per position |
| `gasReserve` | `0.2` | Minimum SOL to keep for gas |
| `minSolToOpen` | `0.55` | Minimum wallet SOL before opening |
| `outOfRangeWaitMinutes` | `30` | Minutes OOR before acting |
| `stopLossPct` | `-15` | Close position if price drops by this % |
| `takeProfitPct` | `5` | Close when fees earned reach this % of capital |
| `trailingTakeProfit` | `true` | Enable trailing take-profit |
| `trailingTriggerPct` | `3` | Activate trailing TP at this PnL % |
| `trailingDropPct` | `1.5` | Close when PnL drops this % from peak |
| `strategy` | `bid_ask` | LP strategy: `spot`, `bid_ask`, or `curve` |

### Schedule

| Field | Default | Description |
|---|---|---|
| `managementIntervalMin` | `10` | Management cycle frequency (minutes) |
| `screeningIntervalMin` | `30` | Screening cycle frequency (minutes) |

### Models

| Field | Default | Description |
|---|---|---|
| `managementModel` | `openai/gpt-oss-20b:free` | LLM for management cycles |
| `screeningModel` | `openai/gpt-oss-20b:free` | LLM for screening cycles |
| `generalModel` | `openai/gpt-oss-20b:free` | LLM for REPL / chat |

> Override model at runtime: `node cli.js config set screeningModel anthropic/claude-opus-4-5`

---

## How it learns

### Lessons

After every closed position the agent runs `studyTopLPers` on candidate pools, analyzes on-chain behavior of top performers (hold duration, entry/exit timing, win rates), and saves concrete lessons. Lessons are injected into subsequent agent cycles as part of the system context.

Add a lesson manually:
```bash
node cli.js lessons add "Never deploy into pump.fun tokens under 2h old"
```

### Threshold evolution

After 5+ positions have been closed, run:
```bash
node cli.js evolve
```

This analyzes closed position performance (win rate, avg PnL, fee yields) and automatically adjusts screening thresholds in `user-config.json`. Changes take effect immediately.

---

## HiveMind

HiveMind sync uses Agent Meridian at `https://api.agentmeridian.xyz` by default with the built-in public key. Agents can register, pull shared lessons/presets, and push learning events without a separate registration flow.

**What you get:**
- Shared lessons from other Meridian agents
- Strategy presets and crowd performance context
- Role-aware lessons injected into future screener/manager prompts when `hiveMindPullMode` is `auto`

**What you share:**
- Lessons from `lessons.json`
- Closed-position performance events: pool, pool name, base mint, strategy, close reason, PnL, fees, and hold time
- Agent heartbeat metadata: agent ID, version, timestamp, and basic capability flags
- **Private keys and wallet balances are never sent**

HiveMind failures are non-blocking. If Agent Meridian is unavailable, the agent logs a warning and keeps running.

### Setup

No manual HiveMind registration command is required for the shared Agent Meridian setup. `agentId` is generated automatically on startup if it is missing.

To use a private HiveMind API key, check the Telegram announcement channel and set it as `hiveMindApiKey`.

Relevant config fields:

```json
{
  "agentId": "",
  "hiveMindUrl": "",
  "hiveMindApiKey": "",
  "hiveMindPullMode": "auto"
}
```

Blank `hiveMindUrl` and `hiveMindApiKey` values intentionally fall back to the Agent Meridian defaults. Set `hiveMindPullMode` to `manual` if you do not want shared lessons and presets pulled automatically.

### Disable

There is currently no empty-string disable path for HiveMind; blank values fall back to the built-in Agent Meridian defaults. A true off switch should be implemented as an explicit config flag before documenting HiveMind as disabled by clearing fields.

---

## Using a local model (LM Studio)

```env
LLM_BASE_URL=http://localhost:1234/v1
LLM_API_KEY=lm-studio
LLM_MODEL=your-local-model-name
```

Any OpenAI-compatible endpoint works.

---

## Architecture

```
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop: LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env (repo-root paths)
repo-root.js        Stable absolute repo path — used by PM2, state files, and .env loading
prompt.js           System prompt builder (SCREENER / MANAGER / GENERAL roles)
state.js            Position registry (state.json)
decision-log.js     Structured decision log for deploy, close, skip, and no-deploy rationale
lessons.js          Learning engine: records performance, derives lessons, evolves thresholds
pool-memory.js      Per-pool deploy history + snapshots
strategy-library.js Saved LP strategies
telegram.js         Telegram bot: polling + notifications
hivemind.js         Agent Meridian HiveMind sync
smart-wallets.js    KOL/alpha wallet tracker
token-blacklist.js  Permanent token blacklist
cli.js              Direct CLI — every tool as a subcommand with JSON output

tools/
  definitions.js    Tool schemas (OpenAI format)
  executor.js       Tool dispatch + safety checks
  dlmm.js           Meteora DLMM SDK wrapper
  screening.js      Pool discovery
  wallet.js         SOL/token balances + Jupiter swap
  token.js          Token info, holders, narrative
  study.js          Top LPer study via LPAgent API

discord-listener/
  index.js          Selfbot Discord listener
  pre-checks.js     Signal pre-check pipeline

.claude/
  agents/
    screener.md     Claude Code screener sub-agent
    manager.md      Claude Code manager sub-agent
  commands/
    screen.md       /screen slash command
    manage.md       /manage slash command
    balance.md      /balance slash command
    positions.md    /positions slash command
    candidates.md   /candidates slash command
    study-pool.md   /study-pool slash command
    pool-ohlcv.md   /pool-ohlcv slash command
    pool-compare.md /pool-compare slash command
```

---

## Disclaimer

This software is provided as-is, with no warranty. Running an autonomous trading agent carries real financial risk — you can lose funds. Always start with `DRY_RUN=true` to verify behavior before going live. Never deploy more capital than you can afford to lose. This is not financial advice.

The authors are not responsible for any losses incurred through use of this software.
