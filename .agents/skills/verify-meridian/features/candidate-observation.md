# Pool candidate observation

Candidate observation refreshes pool data and displays which pools pass configured discovery filters. It is a read path; allowlist and deployment readiness are separate decisions.

## Sub-features

- `candidates-cli` fetches and enriches a limited candidate list in the CLI.
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
- For Telegram, this is the operator's existing authorized bot and there is no competing poller.

- **CLI observation.** Run `node cli.js candidates --limit 3`. Exit code `0` returns JSON with `candidates` and `total_screened`; each returned candidate has its pool address and configured metrics.
- **Telegram observation.** Send `/candidates`. The bot returns the current discovery page with observation/allowlist labels and pair restrictions.
- **Proof.** Save the command or Telegram action and response. Confirm a displayed allowlisted base pair is not described as deploy-ready unless the pair-level guard passes.

## Gotchas

- This path uses external APIs and can fail from rate limits or unavailable providers.
- A candidate on the observation list may fail allowlist, pair, or entry checks later.
- A Telegram response from a different bot process is not proof for the process under test.
