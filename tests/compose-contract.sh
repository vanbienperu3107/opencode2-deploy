#!/usr/bin/env bash

set -euo pipefail

rendered=$(mktemp)
trap 'rm -f "$rendered"' EXIT

docker compose --env-file .env.example config >"$rendered"

grep -Fq 'image: ghcr.io/anomalyco/opencode:2.0.32' docker-compose.yml
grep -Fq 'image: tailscale/tailscale:v1.104.4' docker-compose.yml
grep -Fq 'network_mode: service:ts-opencode2' docker-compose.yml
grep -Fq 'command: ["serve", "--hostname", "0.0.0.0", "--port", "4096"]' docker-compose.yml
grep -Fq 'TS_EXTRA_ARGS: --login-server=https://vpn2.hangocthanh.io.vn --hostname=opencode2 --accept-dns=false' docker-compose.yml
grep -Fq 'TS_STATE_DIR: /var/lib/tailscale' docker-compose.yml
grep -Fq 'TS_USERSPACE: "false"' docker-compose.yml
grep -Fq -- '- /dev/net/tun' docker-compose.yml
grep -Fq -- '- NET_ADMIN' docker-compose.yml
grep -Fq 'opencode2_tailscale_state:/var/lib/tailscale' docker-compose.yml
grep -Fq 'opencode2_workspace:/workspace/projects' docker-compose.yml
grep -Fq 'opencode2_state:/root' docker-compose.yml
grep -Fq 'target: /etc/opencode/opencode.jsonc' docker-compose.yml
grep -Fq 'no-new-privileges:true' docker-compose.yml
grep -Fq '/global/health' docker-compose.yml

application=$(awk '/^  opencode2:/{in_service=1} in_service{print} /^volumes:/{exit}' docker-compose.yml)
! grep -Eq '^    (ports|devices|cap_add|privileged):' <<<"$application"
! grep -Fq 'docker.sock' <<<"$application"
