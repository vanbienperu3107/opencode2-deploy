#!/usr/bin/env bash

set -euo pipefail

# Writes .env into a private generation, then atomically swaps current to that
# completed generation. Secret values are never printed.
fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

output_dir=${OUTPUT_DIR:?OUTPUT_DIR must point at the deployment directory}

for name in OPENCODE_SERVER_PASSWORD CLIPROXY_API_KEY TS_AUTHKEY; do
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
} >"$generation/.env"
chmod 0600 "$generation/.env"

published_generation="$output_dir/generations/$(basename "$generation" | sed 's/^\.pending\.//')"
mv "$generation" "$published_generation"
next_current="$output_dir/.current.XXXXXX"
ln -s "generations/$(basename "$published_generation")" "$next_current"
mv -T "$next_current" "$current"
trap - EXIT
printf 'Rendered runtime generation (directory mode 0700; files mode 0600)\n'
