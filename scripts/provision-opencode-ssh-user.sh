#!/usr/bin/env bash

set -euo pipefail

readonly account_name='opencode'

usage() {
  cat <<'EOF'
Usage: provision-opencode-ssh-user.sh --public-key-file PATH

Run locally on an approved target node as root. The file must contain one
Ed25519 public key. The script creates the dedicated non-root `opencode`
account only when no account with that name exists. It refuses existing
accounts before any mutation and rejects unsafe SSH overrides.
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
      root|root@*|--user=root|--user=root@*|--ssh-option=StrictHostKeyChecking=no|--ssh-option=StrictHostKeyChecking=accept-new|--ssh-option=UserKnownHostsFile=/dev/null)
        fail 'root and unsafe SSH options are not permitted'
        ;;
    esac
  done
}

public_key_file=''
reject_unsafe_arguments "$@"

while (($#)); do
  case "$1" in
    --public-key-file)
      (($# >= 2)) || fail '--public-key-file requires a path'
      public_key_file=$2
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

test "$(id -u)" = '0' || fail 'run this local provisioning script as root'
test -n "$public_key_file" || fail 'a public key file is required'
test -f "$public_key_file" || fail 'public key file does not exist'
test ! -s "$public_key_file" && fail 'public key file is blank'

line_count=$(awk 'NF { count += 1 } END { print count + 0 }' "$public_key_file")
test "$line_count" = '1' || fail 'public key file must contain exactly one nonblank line'
public_key=$(awk 'NF { print; exit }' "$public_key_file")

case "$public_key" in
  *'PRIVATE KEY'*|-----BEGIN*|-----END*) fail 'private keys are not accepted' ;;
esac

IFS=' ' read -r key_type key_blob key_comment extra <<<"$public_key"
test -n "${key_type:-}" && test -n "${key_blob:-}" && test -z "${extra:-}" || fail 'public key must include an algorithm and base64 payload'
case "$key_type" in
  ssh-ed25519) ;;
  *) fail 'only an Ed25519 public key is accepted' ;;
esac
printf '%s\n' "$public_key" | ssh-keygen -lf - >/dev/null 2>&1 || fail 'public key is invalid'

# getent exits 0 when the entry exists and 2 when it is definitively absent.
# Any other status means the account database could not be queried, so the
# account state is unknown and no root mutation may happen.
lookup_status=0
getent passwd "$account_name" >/dev/null || lookup_status=$?
case "$lookup_status" in
  0) fail 'refusing to modify an existing opencode account' ;;
  2) ;;
  *) fail 'cannot determine whether the opencode account exists' ;;
esac

# Resolve and validate the home directory before creating the account. A
# leftover home (for example from `userdel` without -r) is never reused:
# useradd would keep its contents and root writes below it could follow
# symlinks planted by its previous owner.
home_base=$(useradd -D | awk -F= '$1 == "HOME" { print $2; exit }')
case "$home_base" in
  /*) ;;
  *) fail 'cannot determine a safe absolute home base for the opencode account' ;;
esac
home_base=${home_base%/}
test -n "$home_base" || fail 'refusing to place the opencode home at the filesystem root'
account_home="$home_base/$account_name"
if test -e "$account_home" || test -L "$account_home"; then
  fail 'refusing to reuse an existing opencode home directory'
fi

useradd --home-dir "$account_home" --create-home --user-group --shell /bin/bash "$account_name"
account_record=$(getent passwd "$account_name")
recorded_home=$(printf '%s\n' "$account_record" | awk -F: 'NR == 1 { print $6 }')
test "$recorded_home" = "$account_home" || fail 'opencode account home does not match the validated path'
test -d "$account_home" && test ! -L "$account_home" || fail 'opencode home is not a real directory'
test "$(stat -c '%u' "$account_home")" = "$(id -u "$account_name")" || fail 'opencode home is not owned by the new account'
if test -e "$account_home/.ssh" || test -L "$account_home/.ssh"; then
  fail 'refusing to use a preexisting .ssh entry in the new opencode home'
fi
passwd --lock "$account_name" >/dev/null
install -d -m 0700 -o "$account_name" -g "$account_name" "$account_home/.ssh"
authorized_keys="$account_home/.ssh/authorized_keys"
touch "$authorized_keys"
chown "$account_name:$account_name" "$authorized_keys"
chmod 0600 "$authorized_keys"

if ! grep -Fqx -- "$public_key" "$authorized_keys"; then
  printf '%s\n' "$public_key" >>"$authorized_keys"
fi

printf 'Provisioned locked-down SSH identity: %s\n' "$account_name"
