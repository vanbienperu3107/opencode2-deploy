#!/usr/bin/env bash

set -euo pipefail

# This contract catches security regressions where an unreviewed host key,
# unsafe SSH override, or private key reaches the provisioning flow.
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
provision_script="$repo_root/scripts/provision-opencode-ssh-user.sh"
known_hosts_script="$repo_root/scripts/build-known-hosts.sh"
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

test -f "$provision_script" || fail "missing provisioning script"
test -f "$known_hosts_script" || fail "missing known_hosts builder"

ssh-keygen -q -t ed25519 -N '' -f "$test_root/test_key"
public_key=$(<"$test_root/test_key.pub")
fingerprint=$(ssh-keygen -lf "$test_root/test_key.pub" -E sha256 | awk '{print $2}')
key_type=$(awk '{print $1}' "$test_root/test_key.pub")
key_blob=$(awk '{print $2}' "$test_root/test_key.pub")

cat >"$test_root/inventory" <<EOF
node-a.tailnet.example $fingerprint $key_type $key_blob
EOF

bash "$known_hosts_script" --inventory "$test_root/inventory" --output "$test_root/known_hosts"
test "$(stat -c '%a' "$test_root/known_hosts")" = '600' || fail 'known_hosts is not mode 0600'
ssh-keygen -F 'node-a.tailnet.example' -f "$test_root/known_hosts" >/dev/null || fail 'pinned host key was not written'
grep -Fxq "node-a.tailnet.example $key_type $key_blob" "$test_root/known_hosts" || fail 'known_hosts content differs from reviewed inventory'

printf 'node-a.tailnet.example SHA256:not-the-reviewed-key %s %s\n' "$key_type" "$key_blob" >"$test_root/mismatched-inventory"
assert_fails bash "$known_hosts_script" --inventory "$test_root/mismatched-inventory" --output "$test_root/mismatched-known_hosts"
test ! -e "$test_root/mismatched-known_hosts" || fail 'mismatched host key created known_hosts output'

printf '%s\n%s\n' "node-a.tailnet.example $fingerprint $key_type $key_blob" "node-a.tailnet.example $fingerprint $key_type $key_blob" >"$test_root/duplicate-inventory"
assert_fails bash "$known_hosts_script" --inventory "$test_root/duplicate-inventory" --output "$test_root/duplicate-known_hosts"

printf 'root@node-a.tailnet.example %s %s %s\n' "$fingerprint" "$key_type" "$key_blob" >"$test_root/root-inventory"
assert_fails bash "$known_hosts_script" --inventory "$test_root/root-inventory" --output "$test_root/root-known_hosts"
assert_fails bash "$known_hosts_script" --ssh-option 'StrictHostKeyChecking=no'
assert_fails bash "$known_hosts_script" --inventory "$test_root/inventory" --output "$test_root/accept-new_known_hosts" --ssh-option 'StrictHostKeyChecking=accept-new'

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
  printf 'opencode:x:1001:1001::%s:/bin/bash\n' "$FAKE_ACCOUNT_HOME"
  exit 0
fi
exit 2
EOF
cat >"$fake_bin/id" <<'EOF'
#!/usr/bin/env bash
case "${1:-}:${2:-}" in
  -u:) printf '0\n' ;;
  -u:opencode) printf '1001\n' ;;
  -nG) printf 'opencode\n' ;;
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

printf 'PASS: dedicated SSH identity contract\n'
