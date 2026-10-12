# Pool candidate observation

Candidate observation refreshes pool data and displays which pools pass configured discovery filters. It sends no transactions; Telegram and interactive CLI refreshes can update the local research candidate queue. Allowlist and deployment readiness are separate decisions.

## Sub-features

- `candidates-cli` runs the screened shortlist, including allowlist, dual-token TA, and optional chart indicator checks.
- `candidates-telegram` refreshes the current discovery page from Telegram.
- `candidate-labels` distinguishes allowlisted base tokens from a deployable pair.

## How to get to it (user POV)

- Run `node cli.js candidates --limit 3` in a terminal.
- Send `/candidates` to the configured Telegram bot.
- `/screen` also refreshes the deterministic candidate list; it does not run the AI deploy cycle.

## Driving it with CLI and Telegram

Preconditions:

- Doctor passes.
- Meteora discovery access is reachable. CLI enrichment may also call RPC and token data APIs.
- For Telegram, this is the operator's existing authorized bot and there is no competing poller. Inspect `dual-operations.json` first; position lookup can resume a pending dual exit and send token-to-SOL swaps.

- **CLI shortlist.** Run `node cli.js candidates --limit 3`. Exit code `0` returns JSON with `candidates` and `total_screened`; the candidates have passed the current screening checks. This is narrower than the Telegram discovery observation page.
- **Telegram observation.** Send `/candidates`. The bot returns the current discovery page with observation/allowlist labels and pair restrictions.
- **Proof.** Save the command or Telegram action and response. Confirm a displayed allowlisted base pair is not described as deploy-ready unless the pair-level guard passes.

## Gotchas

- This path uses external APIs and can fail from rate limits or unavailable providers.
- A candidate on the observation list may fail allowlist, pair, or entry checks later.
- Optional chart confirmation may be confirmed, rejected, or skipped when its API is unavailable. Skipped confirmation currently allows the candidate through; the confirmed auto-deploy report records that distinction.
- A Telegram response from a different bot process is not proof for the process under test.
- Candidate enrichment calls position lookup. Do not drive this path against a wallet with a pending dual exit merely to verify the candidate display.
