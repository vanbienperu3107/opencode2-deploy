#!/usr/bin/env bash

set -euo pipefail

# The generated file is intended solely for SSH calls that retain this policy.
readonly strict_host_key_checking='StrictHostKeyChecking=yes'

usage() {
  cat <<'EOF'
Usage: build-known-hosts.sh --inventory PATH --output PATH

The reviewed inventory format is one entry per line:
  hostname SHA256:fingerprint key-type base64-host-key

Review this inventory out of band before running the script. This script never
uses ssh-keyscan: it pins only the supplied public host keys and confirms each
key matches its supplied SHA256 fingerprint.
EOF
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

reject_unsafe_arguments() {
  local argument
  for argument in "$@"; do
    case "$argument" in
      root|root@*|--ssh-option=StrictHostKeyChecking=no|--ssh-option=StrictHostKeyChecking=accept-new|--ssh-option=UserKnownHostsFile=/dev/null)
        fail 'root and unsafe SSH options are not permitted'
        ;;
    esac
  done
}

inventory=''
output=''
reject_unsafe_arguments "$@"

while (($#)); do
  case "$1" in
    --inventory)
      (($# >= 2)) || fail '--inventory requires a path'
      inventory=$2
      shift 2
      ;;
    --output)
      (($# >= 2)) || fail '--output requires a path'
      output=$2
      shift 2
      ;;
    --ssh-option)
      (($# >= 2)) || fail '--ssh-option requires a value'
      case "$2" in
        StrictHostKeyChecking=no|StrictHostKeyChecking=accept-new|UserKnownHostsFile=/dev/null) fail 'unsafe SSH option is not permitted' ;;
      esac
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unsupported argument: $1"
      ;;
  esac
done

test -n "$inventory" || fail 'a reviewed inventory is required'
test -n "$output" || fail 'an output path is required'
test -f "$inventory" || fail 'inventory file does not exist'
test -s "$inventory" || fail 'inventory file is blank'
test ! -e "$output" || fail 'refusing to overwrite an existing known_hosts file'

output_dir=$(dirname "$output")
test -d "$output_dir" || fail 'output directory does not exist'
staging=$(mktemp "$output_dir/.known_hosts.XXXXXX")
trap 'rm -f "$staging"' EXIT

entries=0
declare -A seen_hostnames=()
while IFS= read -r line || test -n "$line"; do
  case "$line" in
    ''|'#'*) continue ;;
  esac

  read -r hostname fingerprint key_type key_blob extra <<EOF
$line
EOF
  test -n "${hostname:-}" && test -n "${fingerprint:-}" && test -n "${key_type:-}" && test -n "${key_blob:-}" && test -z "${extra:-}" || fail 'inventory entry must contain hostname fingerprint key-type key'
  case "$hostname" in
    root|root@*|-*|*@*|*,*|*' '*|*'['*|*']'*) fail "unsafe hostname: $hostname" ;;
  esac
  test -z "${seen_hostnames[$hostname]:-}" || fail "duplicate hostname: $hostname"
  seen_hostnames[$hostname]=1
  case "$fingerprint" in
    SHA256:*) ;;
    *) fail "host fingerprint must use SHA256: $hostname" ;;
  esac
  case "$key_type" in
    ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|ssh-rsa) ;;
    *) fail "unsupported host key type: $key_type" ;;
  esac

  candidate="$hostname $key_type $key_blob"
  actual_fingerprint=$(printf '%s\n' "$candidate" | ssh-keygen -lf - -E sha256 2>/dev/null | awk '{print $2}') || fail "invalid host key for $hostname"
  test "$actual_fingerprint" = "$fingerprint" || fail "host key fingerprint mismatch for $hostname"
  printf '%s\n' "$candidate" >>"$staging"
  entries=$((entries + 1))
done <"$inventory"

test "$entries" -gt 0 || fail 'inventory contains no host keys'
chmod 0600 "$staging"

while read -r hostname _; do
  case "$hostname" in ''|'#'*) continue ;; esac
  ssh-keygen -F "$hostname" -f "$staging" >/dev/null || fail "known_hosts validation failed for $hostname"
done <"$inventory"

mv "$staging" "$output"
trap - EXIT
printf 'Wrote %s reviewed host key(s) to %s; use %s\n' "$entries" "$output" "$strict_host_key_checking"
