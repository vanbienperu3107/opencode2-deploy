#!/usr/bin/env sh
# Chay test plugin hindsight-recall va hindsight-synth trong image OpenCode.
# Test dung mock va token gia, khong can secret. Dung: scripts/run-plugin-tests.sh [image]
set -eu
IMAGE="${1:-opencode2-tools:2.4.1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
docker run --rm --entrypoint sh -v "$ROOT/plugins:/p" -w /p "$IMAGE" -c '
set -e
cd /p/hindsight-recall
node --experimental-strip-types --test test/*.test.ts > /tmp/recall.out 2>&1 || { cat /tmp/recall.out; exit 1; }
echo "hindsight-recall: $(grep -E "^ℹ (tests|pass|fail)" /tmp/recall.out | tr "\n" " ")"
cd /p/hindsight-synth
node --experimental-strip-types --test test/*.test.ts > /tmp/synth.out 2>&1 || { cat /tmp/synth.out; exit 1; }
echo "hindsight-synth: $(grep -E "^ℹ (tests|pass|fail)" /tmp/synth.out | tr "\n" " ")"
'
