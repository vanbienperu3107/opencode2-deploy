#!/usr/bin/env bash

set -euo pipefail

# Runs only on VPN4 after deploy-key authentication. It deliberately emits the
# key on stdout for command substitution and keeps all diagnostics generic.
root=${HEADSCALE_ENV_ROOT:-/opt/deployHeadscale}

fail() {
  printf 'Headscale runtime credential is unavailable on vpn4\n' >&2
  exit 1
}

test -d "$root" && test ! -L "$root" || fail

matches=()
while IFS= read -r candidate; do
  test ! -L "$candidate" || fail
  test -f "$candidate" || continue
  count=$(awk -F= '$1 == "HEADPLANE_HS_API_KEY" { count += 1 } END { print count + 0 }' "$candidate") || fail
  test "$count" = 1 || continue
  matches+=("$candidate")
done < <(find -P "$root" -maxdepth 3 -name .env -print 2>/dev/null)

test "${#matches[@]}" = 1 || fail
key=$(awk -F= '$1 == "HEADPLANE_HS_API_KEY" { sub(/^[^=]*=/, ""); print; exit }' "${matches[0]}") || fail
test -n "$key" || fail
printf '%s' "$key"
