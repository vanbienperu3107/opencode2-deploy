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
for secret in OPENCODE_SERVER_PASSWORD CLIPROXY_API_KEY OPENCODE_SSH_PRIVATE_KEY OPENCODE_SSH_KNOWN_HOSTS SSH_KEY SSH_HOST_VPN4 SSH_USER SSH_HOST_VPN4_FINGERPRINT; do
  grep -Fq "secrets.$secret" "$workflow" || fail "deploy does not consume $secret"
done
grep -Eq 'appleboy/ssh-action@[0-9a-f]{40}[[:space:]]+# v1\.2\.0' "$workflow" || fail 'deploy must pin appleboy ssh-action to the reviewed v1.2.0 commit'
grep -Fq 'fingerprint: ${{ secrets.SSH_HOST_VPN4_FINGERPRINT }}' "$workflow" || fail 'deploy must verify the vpn4 SSH host fingerprint'
grep -Fq 'headscale_user_id:' "$workflow" || fail 'deploy must require a Headscale user ID input'
grep -Fq 'HEADSCALE_USER_ID: ${{ inputs.headscale_user_id }}' "$workflow" || fail 'deploy must bind the requested Headscale user ID'
grep -Fq 'HEADSCALE_ENV=/opt/deployHeadscale/.env' "$workflow" || fail 'deploy must read the existing Headscale env only on vpn4'
grep -Fq 'HEADPLANE_HS_API_KEY' "$workflow" || fail 'deploy must locate the existing Headscale key on vpn4'
! grep -Fq 'secrets.HEADPLANE_HS_API_KEY' "$workflow" || fail 'deploy must not transfer the old Headscale key through GitHub secrets'
grep -Fq "'^[0-9]+$'" "$workflow" || fail 'deploy must validate the Headscale user ID as numeric'
grep -Fq 'requested Headscale user was not found' "$workflow" || fail 'deploy must verify the requested Headscale user exists'
grep -Fq '\"user\":\"$HEADSCALE_USER_ID\"' "$workflow" || fail 'deploy must create the pre-auth key for the requested Headscale user'
preflight_line=$(grep -n -- '- name: Check required secrets' "$workflow" | cut -d: -f1)
transport_line=$(grep -n -- '- name: Preflight vpn4 SSH transport' "$workflow" | cut -d: -f1)
deploy_line=$(grep -n -- '- name: Deploy stack to vpn4' "$workflow" | cut -d: -f1)
test -n "$preflight_line" && test -n "$transport_line" && test -n "$deploy_line" && test "$preflight_line" -lt "$transport_line" && test "$transport_line" -lt "$deploy_line" || fail 'deploy must preflight SSH transport before remote pre-auth key creation'
preflight=$(sed -n "${preflight_line},$((transport_line - 1))p" "$workflow")
transport=$(sed -n "${transport_line},$((deploy_line - 1))p" "$workflow")
grep -Fq 'appleboy/ssh-action@7eaf76671a0d7eec5d98ee897acda4f968735a17 # v1.2.0' <<<"$transport" || fail 'SSH transport preflight must use the pinned action'
for value in 'host: ${{ secrets.SSH_HOST_VPN4 }}' 'username: ${{ secrets.SSH_USER }}' 'key: ${{ secrets.SSH_KEY }}' 'fingerprint: ${{ secrets.SSH_HOST_VPN4_FINGERPRINT }}'; do
  grep -Fq "$value" <<<"$transport" || fail 'SSH transport preflight is missing a pinned transport input'
done
grep -Fxq '            true' <<<"$transport" || fail 'SSH transport preflight must execute harmless true'
for name in SSH_HOST_VPN4 SSH_USER SSH_KEY SSH_HOST_VPN4_FINGERPRINT; do
  grep -Fq "$name" <<<"$preflight" || fail "deploy preflight omits $name"
done
! grep -Fq 'GITHUB_OUTPUT' "$workflow" || fail 'remote-only Tailscale auth key must not return to the GitHub runner'
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
private_key_header="-----BEGIN OPENSSH"$' '"PRIVATE KEY-----"
private_key_footer="-----END OPENSSH"$' '"PRIVATE KEY-----"
private_key="$private_key_header"$'\ncontract-key-material\n'"$private_key_footer"
known_hosts=$'node-a.tailnet.ts.net ssh-ed25519 contract-key-a\nnode-b.tailnet.ts.net ssh-ed25519 contract-key-b'
env -i PATH="$PATH" OUTPUT_DIR="$test_root/out" \
  OPENCODE_SERVER_PASSWORD='contract-password' \
  CLIPROXY_API_KEY='contract-cliproxy' \
  TS_AUTHKEY='contract-authkey' \
  OPENCODE_SSH_PRIVATE_KEY="$private_key" \
  OPENCODE_SSH_KNOWN_HOSTS="$known_hosts" \
  bash "$renderer" >"$test_root/stdout" 2>&1 || fail 'renderer rejected complete secrets'
current="$test_root/out/current"
test -L "$current" || fail 'runtime renderer must publish an atomic current generation pointer'
generation=$(readlink -f "$current")
test "$(stat -c '%a' "$generation")" = '700' || fail 'runtime generation directory must be mode 0700'
test "$(stat -c '%a' "$generation/.env")" = '600' || fail 'runtime env must be mode 0600'
test "$(stat -c '%a' "$generation/opencode_ssh_key")" = '600' || fail 'SSH key must be mode 0600'
test "$(stat -c '%a' "$generation/opencode_known_hosts")" = '600' || fail 'known hosts must be mode 0600'
grep -Fxq 'OPENCODE_SERVER_USERNAME=opencode' "$generation/.env" || fail 'runtime env must pin the documented default username'
grep -Fxq 'OPENCODE_SERVER_PASSWORD=contract-password' "$generation/.env" || fail 'runtime env lost the password'
grep -Fxq "OPENCODE_SSH_KEY_FILE=$current/opencode_ssh_key" "$generation/.env" || fail 'runtime env must reference the current-generation SSH key'
grep -Fxq "OPENCODE_SSH_KNOWN_HOSTS_FILE=$current/opencode_known_hosts" "$generation/.env" || fail 'runtime env must reference the current-generation known hosts'
grep -Fxq -- "$private_key_header" "$generation/opencode_ssh_key" || fail 'renderer must preserve multiline SSH private-key material'
grep -Fxq 'node-a.tailnet.ts.net ssh-ed25519 contract-key-a' "$generation/opencode_known_hosts" || fail 'renderer must preserve multiline known-hosts material'
grep -Fxq 'node-b.tailnet.ts.net ssh-ed25519 contract-key-b' "$generation/opencode_known_hosts" || fail 'renderer must preserve every known-host entry'

# Failure during the second secret publish must not alter the currently live generation.
previous_target=$(readlink "$current")
if env -i PATH="$PATH" OUTPUT_DIR="$test_root/out" RENDER_RUNTIME_ENV_FAIL_ON_SECOND_SECRET_WRITE=1 \
  OPENCODE_SERVER_PASSWORD='next-password' \
  CLIPROXY_API_KEY='next-cliproxy' \
  TS_AUTHKEY='next-authkey' \
  OPENCODE_SSH_PRIVATE_KEY='next-ssh-private-key' \
  OPENCODE_SSH_KNOWN_HOSTS='next-known-hosts' \
  bash "$renderer" >/dev/null 2>&1; then
  fail 'renderer did not fail when the second secret publish was injected to fail'
fi
test "$(readlink "$current")" = "$previous_target" || fail 'failed generation replaced the live current pointer'
test "$(readlink -f "$current")" = "$generation" || fail 'failed generation changed the live generation'
grep -Fxq 'OPENCODE_SERVER_PASSWORD=contract-password' "$generation/.env" || fail 'failed generation changed existing env material'
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
