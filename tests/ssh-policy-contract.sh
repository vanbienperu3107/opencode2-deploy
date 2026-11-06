#!/usr/bin/env bash

set -euo pipefail

# This contract catches security regressions where an unreviewed host key,
# unsafe SSH override, or private key reaches the provisioning flow.
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
provision_script="$repo_root/scripts/provision-opencode-ssh-user.sh"
known_hosts_script="$repo_root/scripts/build-known-hosts.sh"
ci_workflow="$repo_root/.github/workflows/ci.yml"
test_root=$(mktemp -d)

cleanup() {
  rm -rf "$test_root"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_fails() {
  if "$@" >/dev/null 2>&1; then
    fail "expected command to fail: $*"
  fi
}

assert_invalid_hostname() {
  local hostname=$1
  local output="$test_root/invalid-${RANDOM}-known_hosts"
  printf '%s %s %s %s\n' "$hostname" "$fingerprint" "$key_type" "$key_blob" >"$test_root/invalid-inventory"
  assert_fails bash "$known_hosts_script" --inventory "$test_root/invalid-inventory" --output "$output"
  test ! -e "$output" || fail "unsafe hostname wrote output: $hostname"
}

assert_existing_account_refusal_preserves_authorized_keys() {
  local scenario=$1
  local account_uid=$2
  local account_shell=$3
  local account_group_ids=$4
  local account_group_names=$5
  local passwordless_sudo=$6

  printf 'existing-safe-key\n' >"$fake_home/opencode/.ssh/authorized_keys"
  cp "$fake_home/opencode/.ssh/authorized_keys" "$test_root/authorized_keys.before"
  if PATH="$fake_bin:$PATH" \
    FAKE_ACCOUNT_HOME="$fake_home/opencode" \
    FAKE_ACCOUNT_STATE="$test_root/fake-account" \
    FAKE_ACCOUNT_UID="$account_uid" \
    FAKE_ACCOUNT_SHELL="$account_shell" \
    FAKE_GROUP_IDS="$account_group_ids" \
    FAKE_GROUP_NAMES="$account_group_names" \
    FAKE_PASSWORDLESS_SUDO="$passwordless_sudo" \
    bash "$provision_script" --public-key-file "$test_root/test_key.pub" >/dev/null 2>&1; then
    fail "$scenario existing account was accepted"
  fi
  cmp -s "$test_root/authorized_keys.before" "$fake_home/opencode/.ssh/authorized_keys" || fail "$scenario changed authorized_keys before refusal"
}

test -f "$provision_script" || fail "missing provisioning script"
test -f "$known_hosts_script" || fail "missing known_hosts builder"
test -f "$ci_workflow" || fail 'missing CI workflow'

ssh-keygen -q -t ed25519 -N '' -f "$test_root/test_key"
public_key=$(<"$test_root/test_key.pub")
fingerprint=$(ssh-keygen -lf "$test_root/test_key.pub" -E sha256 | awk '{print $2}')
key_type=$(awk '{print $1}' "$test_root/test_key.pub")
key_blob=$(awk '{print $2}' "$test_root/test_key.pub")

cat >"$test_root/inventory" <<EOF
node-a.tailnet.ts.net $fingerprint $key_type $key_blob
EOF

bash "$known_hosts_script" --inventory "$test_root/inventory" --output "$test_root/known_hosts"
test "$(stat -c '%a' "$test_root/known_hosts")" = '600' || fail 'known_hosts is not mode 0600'
ssh-keygen -F 'node-a.tailnet.ts.net' -f "$test_root/known_hosts" >/dev/null || fail 'pinned host key was not written'
grep -Fxq "node-a.tailnet.ts.net $key_type $key_blob" "$test_root/known_hosts" || fail 'known_hosts content differs from reviewed inventory'

printf 'node-a.tailnet.ts.net SHA256:not-the-reviewed-key %s %s\n' "$key_type" "$key_blob" >"$test_root/mismatched-inventory"
assert_fails bash "$known_hosts_script" --inventory "$test_root/mismatched-inventory" --output "$test_root/mismatched-known_hosts"
test ! -e "$test_root/mismatched-known_hosts" || fail 'mismatched host key created known_hosts output'

printf '%s\n%s\n' "node-a.tailnet.ts.net $fingerprint $key_type $key_blob" "node-a.tailnet.ts.net $fingerprint $key_type $key_blob" >"$test_root/duplicate-inventory"
assert_fails bash "$known_hosts_script" --inventory "$test_root/duplicate-inventory" --output "$test_root/duplicate-known_hosts"

printf 'root@node-a.tailnet.ts.net %s %s %s\n' "$fingerprint" "$key_type" "$key_blob" >"$test_root/root-inventory"
assert_fails bash "$known_hosts_script" --inventory "$test_root/root-inventory" --output "$test_root/root-known_hosts"
assert_fails bash "$known_hosts_script" --ssh-option 'StrictHostKeyChecking=no'
assert_fails bash "$known_hosts_script" --inventory "$test_root/inventory" --output "$test_root/accept-new_known_hosts" --ssh-option 'StrictHostKeyChecking=accept-new'

for unsafe_hostname in \
  '*.tailnet.ts.net' \
  '!node-a.tailnet.ts.net' \
  '#node-a.tailnet.ts.net' \
  'node\\-a.tailnet.ts.net' \
  $'node-a\t.tailnet.ts.net' \
  '192.0.2.42' \
  '2001:db8::42' \
  '[node-a.tailnet.ts.net]:22' \
  'node-a.tailnet.ts.net:22' \
  'node-a.tailnet.ts.net,alias.tailnet.ts.net'; do
  assert_invalid_hostname "$unsafe_hostname"
done

private_key_marker='-----BEGIN OPENSSH'" PRIVATE KEY-----"
printf '%s\n' "$private_key_marker" >"$test_root/private_key"
assert_fails bash "$provision_script" --public-key-file "$test_root/private_key"
assert_fails bash "$provision_script" --ssh-option 'UserKnownHostsFile=/dev/null'

fake_bin="$test_root/fake-bin"
fake_home="$test_root/home"
fake_log="$test_root/commands.log"
mkdir -p "$fake_bin" "$fake_home"

cat >"$fake_bin/getent" <<'EOF'
#!/usr/bin/env bash
if test "$1" = passwd && test "$2" = opencode && test -f "$FAKE_ACCOUNT_STATE"; then
  printf 'opencode:x:%s:1001::%s:%s\n' "${FAKE_ACCOUNT_UID:-1001}" "$FAKE_ACCOUNT_HOME" "${FAKE_ACCOUNT_SHELL:-/bin/bash}"
  exit 0
fi
exit 2
EOF
cat >"$fake_bin/id" <<'EOF'
#!/usr/bin/env bash
case "${1:-}:${2:-}" in
  -u:) printf '0\n' ;;
  -u:opencode) printf '%s\n' "${FAKE_ACCOUNT_UID:-1001}" ;;
  -g:opencode) printf '1001\n' ;;
  -G:opencode) printf '%s\n' "${FAKE_GROUP_IDS:-1001}" ;;
  -nG) printf '%s\n' "${FAKE_GROUP_NAMES:-opencode}" ;;
  opencode:) printf 'uid=1001(opencode) gid=1001(opencode) groups=1001(opencode)\n' ;;
  *) exit 0 ;;
esac
EOF
cat >"$fake_bin/passwd" <<'EOF'
#!/usr/bin/env bash
test "$1" = --lock && test "$2" = opencode
EOF
cat >"$fake_bin/useradd" <<EOF
#!/usr/bin/env bash
printf 'useradd %s\\n' "\$*" >>'$fake_log'
mkdir -p "\$FAKE_ACCOUNT_HOME"
touch "\$FAKE_ACCOUNT_STATE"
EOF
cat >"$fake_bin/usermod" <<EOF
#!/usr/bin/env bash
printf 'usermod %s\\n' "\$*" >>'$fake_log'
EOF
cat >"$fake_bin/sudo" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
cat >"$fake_bin/runuser" <<'EOF'
#!/usr/bin/env bash
test "${FAKE_PASSWORDLESS_SUDO:-0}" = 1 && exit 0
exit 1
EOF
cat >"$fake_bin/install" <<'EOF'
#!/usr/bin/env bash
path="${!#}"
mkdir -p "$path"
EOF
cat >"$fake_bin/chown" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$fake_bin/chmod" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$fake_bin"/*

PATH="$fake_bin:$PATH" FAKE_ACCOUNT_HOME="$fake_home/opencode" FAKE_ACCOUNT_STATE="$test_root/fake-account" bash "$provision_script" --public-key-file "$test_root/test_key.pub"
grep -Fq -- '--create-home --user-group --shell /bin/bash opencode' "$fake_log" || fail 'opencode user was not created with a login shell and private primary group'
grep -Fq -- '--groups  opencode' "$fake_log" && fail 'opencode was assigned supplementary groups'
grep -Fxq "$public_key" "$fake_home/opencode/.ssh/authorized_keys" || fail 'provided public key was not installed verbatim'
PATH="$fake_bin:$PATH" FAKE_ACCOUNT_HOME="$fake_home/opencode" FAKE_ACCOUNT_STATE="$test_root/fake-account" bash "$provision_script" --public-key-file "$test_root/test_key.pub"
test "$(grep -Fxc "$public_key" "$fake_home/opencode/.ssh/authorized_keys")" = '1' || fail 'public key was appended more than once'

assert_existing_account_refusal_preserves_authorized_keys 'root UID' '0' '/bin/bash' '1001' 'opencode' '0'
assert_existing_account_refusal_preserves_authorized_keys 'disabled shell' '1001' '/usr/sbin/nologin' '1001' 'opencode' '0'
# Every supplementary group is prohibited. These numeric fixtures model the
# docker and sudo memberships that N1 requires the provisioning flow to reject.
assert_existing_account_refusal_preserves_authorized_keys 'docker supplementary group' '1001' '/bin/bash' '1001 998' 'opencode docker' '0'
assert_existing_account_refusal_preserves_authorized_keys 'sudo supplementary group' '1001' '/bin/bash' '1001 27' 'opencode sudo' '0'
assert_existing_account_refusal_preserves_authorized_keys 'wheel supplementary group' '1001' '/bin/bash' '1001 10' 'opencode wheel' '0'
assert_existing_account_refusal_preserves_authorized_keys 'passwordless sudo' '1001' '/bin/bash' '1001' 'opencode' '1'

grep -Fxq '      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2' "$ci_workflow" || fail 'CI checkout is not pinned to the approved v4.2.2 SHA'
grep -Fxq '          bash tests/ssh-policy-contract.sh' "$ci_workflow" || fail 'CI does not run the SSH policy contract'

printf 'PASS: dedicated SSH identity contract\n'
