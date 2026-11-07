#!/usr/bin/env bash

set -euo pipefail

# Writes .env and SSH material together into a private generation, then atomically
# swaps current to that completed generation. Secret values are never printed.
fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

output_dir=${OUTPUT_DIR:?OUTPUT_DIR must point at the deployment directory}

for name in OPENCODE_SERVER_PASSWORD CLIPROXY_API_KEY TS_AUTHKEY OPENCODE_SSH_PRIVATE_KEY OPENCODE_SSH_KNOWN_HOSTS; do
  value=${!name:-}
  test -n "$value" || fail "$name is required"
  case "$value" in
    *$'\n'*|*$'\r'*) fail "$name must be a single line" ;;
  esac
done

mkdir -p "$output_dir/generations"
umask 077
generation=$(mktemp -d "$output_dir/generations/.pending.XXXXXX")
trap 'rm -rf "$generation"' EXIT
chmod 0700 "$generation"
current="$output_dir/current"

{
  printf 'OPENCODE_SERVER_USERNAME=opencode\n'
  printf 'OPENCODE_SERVER_PASSWORD=%s\n' "$OPENCODE_SERVER_PASSWORD"
  printf 'CLIPROXY_API_KEY=%s\n' "$CLIPROXY_API_KEY"
  printf 'TS_AUTHKEY=%s\n' "$TS_AUTHKEY"
  printf 'OPENCODE_SSH_KEY_FILE=%s/opencode_ssh_key\n' "$current"
  printf 'OPENCODE_SSH_KNOWN_HOSTS_FILE=%s/opencode_known_hosts\n' "$current"
} >"$generation/.env"
printf '%s\n' "$OPENCODE_SSH_PRIVATE_KEY" >"$generation/opencode_ssh_key"
test "${RENDER_RUNTIME_ENV_FAIL_ON_SECOND_SECRET_WRITE:-}" != 1 || fail 'injected failure before second secret write'
printf '%s\n' "$OPENCODE_SSH_KNOWN_HOSTS" >"$generation/opencode_known_hosts"
chmod 0600 "$generation/.env" "$generation/opencode_ssh_key" "$generation/opencode_known_hosts"

published_generation="$output_dir/generations/$(basename "$generation" | sed 's/^\.pending\.//')"
mv "$generation" "$published_generation"
next_current="$output_dir/.current.XXXXXX"
ln -s "generations/$(basename "$published_generation")" "$next_current"
mv -T "$next_current" "$current"
trap - EXIT
printf 'Rendered runtime generation (directory mode 0700; files mode 0600)\n'
