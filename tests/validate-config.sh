#!/usr/bin/env bash

set -euo pipefail

grep -Eq '^    image: ghcr\.io/anomalyco/opencode:[0-9]+\.[0-9]+\.[0-9]+$' docker-compose.yml
test ! -e .env
python3 scripts/validate-v2-contract.py opencode.jsonc
python3 scripts/scan-secrets.py .
