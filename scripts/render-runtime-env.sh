#!/usr/bin/env bash

set -euo pipefail

# Writes the Compose runtime env file atomically with mode 0600. Secret values
# come only from the environment and are never printed.
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

mkdir -p "$output_dir"
umask 077
staging=$(mktemp "$output_dir/.env.XXXXXX")
trap 'rm -f "$staging"' EXIT
{
  printf 'OPENCODE_SERVER_USERNAME=opencode\n'
  printf 'OPENCODE_SERVER_PASSWORD=%s\n' "$OPENCODE_SERVER_PASSWORD"
  printf 'CLIPROXY_API_KEY=%s\n' "$CLIPROXY_API_KEY"
  printf 'TS_AUTHKEY=%s\n' "$TS_AUTHKEY"
  printf 'OPENCODE_SSH_KEY_FILE=%s/opencode_ssh_key\n' "$output_dir"
  printf 'OPENCODE_SSH_KNOWN_HOSTS_FILE=%s/opencode_known_hosts\n' "$output_dir"
} >"$staging"
chmod 0600 "$staging"
mv "$staging" "$output_dir/.env"

for secret_file in opencode_ssh_key opencode_known_hosts; do
  case "$secret_file" in
    opencode_ssh_key) secret_value=$OPENCODE_SSH_PRIVATE_KEY ;;
    opencode_known_hosts) secret_value=$OPENCODE_SSH_KNOWN_HOSTS ;;
  esac
  secret_staging=$(mktemp "$output_dir/.${secret_file}.XXXXXX")
  printf '%s\n' "$secret_value" >"$secret_staging"
  chmod 0600 "$secret_staging"
  mv "$secret_staging" "$output_dir/$secret_file"
done
trap - EXIT
printf 'Rendered runtime env and SSH material (mode 0600)\n'
