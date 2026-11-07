#!/usr/bin/env bash

set -euo pipefail

# Guards the production deploy workflow against secret leaks, volume deletion,
# unpinned images and missing fail-closed preflight.
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
workflow="$repo_root/.github/workflows/deploy.yml"
renderer="$repo_root/scripts/render-runtime-env.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

test -f "$workflow" || fail 'missing deploy workflow'
test -f "$renderer" || fail 'missing runtime env renderer'

grep -Fq 'workflow_dispatch:' "$workflow" || fail 'deploy must be manually dispatched'
grep -Fq 'permissions:' "$workflow" || fail 'deploy must declare token permissions'
grep -Fq 'contents: read' "$workflow" || fail 'deploy token must stay read-only'
for secret in OPENCODE_SERVER_PASSWORD CLIPROXY_API_KEY OPENCODE_SSH_PRIVATE_KEY OPENCODE_SSH_KNOWN_HOSTS HEADPLANE_HS_API_KEY SSH_KEY SSH_HOST_VPN4; do
  grep -Fq "secrets.$secret" "$workflow" || fail "deploy does not consume $secret"
done
grep -Fq '::add-mask::' "$workflow" || fail 'generated Tailscale auth key must be masked'
grep -Fq 'tag:' "$workflow" && fail 'deploy must not depend on mutable tags'
if grep -Eq 'down[[:space:]]+(-[a-zA-Z]*v|--volumes)|up[[:space:]].*(-V|--renew-anon-volumes)|volume[[:space:]]+(rm|prune)' "$workflow"; then
  fail 'deploy must never remove volumes'
fi
if grep -Eq 'echo[^|]*\$\{?(OPENCODE_SERVER_PASSWORD|CLIPROXY_API_KEY|TS_AUTHKEY|HS_API_KEY)' "$workflow"; then
  fail 'deploy must not echo secret values'
fi
grep -Fq 'git checkout --detach' "$workflow" || fail 'deploy must check out an exact commit'
grep -Fq 'render-runtime-env.sh' "$workflow" || fail 'deploy must render the runtime env through the guarded script'
grep -Fq 'docker compose --env-file' "$workflow" || fail 'deploy must use the rendered env file'

test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

# Missing secrets must fail before any file is written.
if env -i PATH="$PATH" OUTPUT_DIR="$test_root/out" bash "$renderer" >/dev/null 2>&1; then
  fail 'renderer accepted missing secrets'
fi
test ! -e "$test_root/out/.env" || fail 'renderer wrote an env file without secrets'

mkdir -p "$test_root/out"
env -i PATH="$PATH" OUTPUT_DIR="$test_root/out" \
  OPENCODE_SERVER_PASSWORD='contract-password' \
  CLIPROXY_API_KEY='contract-cliproxy' \
  TS_AUTHKEY='contract-authkey' \
  OPENCODE_SSH_PRIVATE_KEY='contract-ssh-private-key' \
  OPENCODE_SSH_KNOWN_HOSTS='contract-known-hosts' \
  bash "$renderer" >"$test_root/stdout" 2>&1 || fail 'renderer rejected complete secrets'
test "$(stat -c '%a' "$test_root/out/.env")" = '600' || fail 'runtime env must be mode 0600'
grep -Fxq 'OPENCODE_SERVER_USERNAME=opencode' "$test_root/out/.env" || fail 'runtime env must pin the documented default username'
grep -Fxq 'OPENCODE_SERVER_PASSWORD=contract-password' "$test_root/out/.env" || fail 'runtime env lost the password'
if grep -Eq 'contract-(password|cliproxy|authkey)' "$test_root/stdout"; then
  fail 'renderer printed a secret value'
fi

# Values that could inject extra env lines are refused.
if env -i PATH="$PATH" OUTPUT_DIR="$test_root/inject" \
  OPENCODE_SERVER_PASSWORD=$'contract\nTS_AUTHKEY=evil' CLIPROXY_API_KEY='x' TS_AUTHKEY='y' \
  bash "$renderer" >/dev/null 2>&1; then
  fail 'renderer accepted a multi-line secret'
fi

printf 'PASS: deploy workflow contract\n'
