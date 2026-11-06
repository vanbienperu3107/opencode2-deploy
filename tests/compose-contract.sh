#!/usr/bin/env bash

set -euo pipefail

rendered=$(mktemp)
trap 'rm -f "$rendered"' EXIT

docker compose --env-file .env.example config --format json >"$rendered"

grep -Fq 'image: ghcr.io/anomalyco/opencode:2.0.32' "$rendered"
grep -Fq 'image: tailscale/tailscale:v1.104.4' "$rendered"
grep -Fq 'network_mode: service:ts-opencode2' "$rendered"
grep -Fq '/dev/net/tun' "$rendered"
grep -Fq 'NET_ADMIN' "$rendered"
grep -Fq 'opencode2_tailscale_state:' "$rendered"
grep -Fq 'opencode2_workspace:' "$rendered"
grep -Fq 'opencode2_state:' "$rendered"
grep -Fq 'no-new-privileges:true' "$rendered"

python3 - "$rendered" <<'PY'
from __future__ import annotations

import sys

import json

with open(sys.argv[1], encoding="utf-8") as stream:
    compose = json.load(stream)

services = compose["services"]
tailscale = services["ts-opencode2"]
opencode = services["opencode2"]

assert tailscale["devices"] == ["/dev/net/tun"]
assert tailscale["cap_add"] == ["NET_ADMIN"]
assert "ports" not in tailscale
assert opencode["network_mode"] == "service:ts-opencode2"
assert "ports" not in opencode
assert "devices" not in opencode
assert "cap_add" not in opencode
assert "privileged" not in opencode
assert "docker.sock" not in str(opencode)
volumes = {volume["target"]: volume for volume in opencode["volumes"]}
assert set(volumes) == {"/workspace/projects", "/root"}
assert volumes["/workspace/projects"]["type"] == "volume"
assert volumes["/workspace/projects"]["source"] == "opencode2_workspace"
assert volumes["/root"]["type"] == "volume"
assert volumes["/root"]["source"] == "opencode2_state"
assert opencode["configs"][0]["source"] == "opencode-config"
assert opencode["configs"][0]["target"] == "/etc/opencode/opencode.jsonc"
assert opencode["healthcheck"]["test"][0] == "CMD-SHELL"
assert "/global/health" in opencode["healthcheck"]["test"][1]
assert set(compose["volumes"]) == {"opencode2_workspace", "opencode2_state", "opencode2_tailscale_state"}
PY
