#!/usr/bin/env bash

set -euo pipefail

grep -Fq 'ghcr.io/anomalyco/opencode:2.0.32' docker-compose.yml
test ! -e .env
python3 scripts/validate-v2-contract.py opencode.jsonc
python3 scripts/scan-secrets.py .
