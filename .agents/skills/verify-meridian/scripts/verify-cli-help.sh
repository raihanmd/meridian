#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
if [[ "$PWD" != "$REPO_ROOT" ]]; then
  echo "Run from the Meridian repository root: $REPO_ROOT" >&2
  exit 2
fi

ARTIFACT_ROOT="${MERIDIAN_VERIFY_ARTIFACTS:-/tmp/meridian-verification}"
mkdir -p "$ARTIFACT_ROOT"
ARTIFACT_DIR="$(mktemp -d "$ARTIFACT_ROOT/cli-help.XXXXXX")"
TEMP_HOME="$(mktemp -d /tmp/meridian-verify-home.XXXXXX)"
cleanup() {
  rm -rf -- "$TEMP_HOME"
}
trap cleanup EXIT

printf 'HOME=<isolated temporary home> node cli.js help\n' > "$ARTIFACT_DIR/action.txt"
set +e
HOME="$TEMP_HOME" node cli.js help > "$ARTIFACT_DIR/stdout.txt" 2> "$ARTIFACT_DIR/stderr.txt"
EXIT_CODE=$?
set -e
printf '%s\n' "$EXIT_CODE" > "$ARTIFACT_DIR/exit-code.txt"

if [[ "$EXIT_CODE" -ne 0 ]]; then
  echo "CLI help failed; evidence: $ARTIFACT_DIR" >&2
  exit "$EXIT_CODE"
fi
for expected in "meridian screen" "meridian candidates" "meridian deploy" "meridian close"; do
  if ! grep -Fq "$expected" "$ARTIFACT_DIR/stdout.txt"; then
    echo "CLI help did not include '$expected'; evidence: $ARTIFACT_DIR" >&2
    exit 1
  fi
done

GENERATED_HELP="$TEMP_HOME/.meridian/SKILL.md"
if [[ ! -s "$GENERATED_HELP" ]]; then
  echo "CLI did not create its generated help file under the isolated HOME" >&2
  exit 1
fi
cp "$GENERATED_HELP" "$ARTIFACT_DIR/generated-skill.md"
echo "$ARTIFACT_DIR"
