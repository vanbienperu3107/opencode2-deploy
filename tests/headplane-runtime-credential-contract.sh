#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
reader="$repo_root/scripts/read-headplane-api-key.sh"
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_fails_without_leak() {
  local secret=$1
  shift
  if output=$("$@" 2>&1); then
    fail 'credential reader unexpectedly succeeded'
  fi
  test -z "$output" || test "$output" = 'Headscale runtime credential is unavailable on vpn4' || fail 'credential reader leaked discovery details'
  test -z "$secret" || ! grep -Fq "$secret" <<<"$output" || fail 'credential reader leaked key material'
}

secret='contract-headplane-key'
assert_fails_without_leak "$secret" env HEADSCALE_ENV_ROOT="$test_root/missing" bash "$reader"

mkdir -p "$test_root/one"
printf 'HEADPLANE_HS_API_KEY=%s\n' "$secret" >"$test_root/one/.env"
test "$(env HEADSCALE_ENV_ROOT="$test_root/one" bash "$reader")" = "$secret" || fail 'single credential source was not read'

mkdir -p "$test_root/nested/ui-preview/opencode2"
printf 'HEADPLANE_HS_API_KEY=%s\n' "$secret" >"$test_root/nested/ui-preview/opencode2/.env"
test "$(env HEADSCALE_ENV_ROOT="$test_root/nested" bash "$reader")" = "$secret" || fail 'nested credential source within the allowed depth was not read'

mkdir -p "$test_root/multiple/child"
printf 'HEADPLANE_HS_API_KEY=%s\n' "$secret" >"$test_root/multiple/.env"
printf 'HEADPLANE_HS_API_KEY=other\n' >"$test_root/multiple/child/.env"
assert_fails_without_leak "$secret" env HEADSCALE_ENV_ROOT="$test_root/multiple" bash "$reader"

mkdir -p "$test_root/symlink-target"
printf 'HEADPLANE_HS_API_KEY=%s\n' "$secret" >"$test_root/symlink-target/.env"
mkdir -p "$test_root/symlink-root"
ln -s "$test_root/symlink-target/.env" "$test_root/symlink-root/.env"
assert_fails_without_leak "$secret" env HEADSCALE_ENV_ROOT="$test_root/symlink-root" bash "$reader"

mkdir -p "$test_root/mixed/regular" "$test_root/mixed/alias"
printf 'HEADPLANE_HS_API_KEY=%s\n' "$secret" >"$test_root/mixed/regular/.env"
ln -s "$test_root/symlink-target/.env" "$test_root/mixed/alias/.env"
assert_fails_without_leak "$secret" env HEADSCALE_ENV_ROOT="$test_root/mixed" bash "$reader"

printf 'PASS: Headscale runtime credential discovery contract\n'
