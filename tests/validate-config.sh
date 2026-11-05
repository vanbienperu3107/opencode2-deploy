#!/usr/bin/env bash

set -euo pipefail

grep -Fq 'ghcr.io/anomalyco/opencode:2.0.32' docker-compose.yml
grep -Fq '"providers"' opencode.jsonc
grep -Fq '"action": "*", "resource": "*", "effect": "allow"' opencode.jsonc
test ! -e .env

# Split this literal so the scanner does not flag its own detection signature.
secret_pattern='BEGIN (OPENSSH|RSA) PRIVATE KEY|gh[pous]_[A-Za-z0-9_]+|TS'"KEY-"
! grep -R -nE "$secret_pattern" --exclude-dir=.git .
