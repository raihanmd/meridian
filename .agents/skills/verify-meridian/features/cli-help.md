# CLI help and command discovery

The Meridian CLI help lists the commands an operator can run from a terminal. This path starts the real CLI entry point without loading a wallet or calling chain APIs.

## Sub-features

- `help-default` prints command help when no subcommand is given.
- `help-explicit` prints command help for the `help` subcommand.
- `help-isolated-home` writes generated help under a temporary home, not the operator's home.

## How to get to it (user POV)

- From the repository root, run `node cli.js help`.
- The automated proof uses `scripts/verify-cli-help.sh` to isolate the home directory and preserve evidence.

## Driving it with Node CLI

Preconditions:

- Doctor passes.
- Run from the repository root.
- No `.env`, wallet, RPC, Telegram, or model key is required for this command.

- **Show help.** Run `scripts/verify-cli-help.sh`. Exit code is `0`; captured stdout includes the Meridian command reference and the `screen`, `manage`, `deploy`, `close`, and `candidates` entries.
- **Verify generated help state.** The helper confirms `$HOME/.meridian/SKILL.md` exists inside its temporary home and preserves a copy in its evidence directory.
- **Proof.** Review `action.txt`, `stdout.txt`, `stderr.txt`, `exit-code.txt`, and `generated-skill.md` in the printed evidence directory. The temporary home is removed when the helper exits; evidence remains.

## Gotchas

- `cli.js` generates `~/.meridian/SKILL.md` even for help. Always use the helper or an isolated `HOME` when validating this behavior.
- Do not infer that trade commands are safe because help prints a `--dry-run` option. They have separate read, quote, and wallet requirements.
