#!/usr/bin/env bash

set -euo pipefail

rendered=$(mktemp --suffix=.json)
trap 'rm -f "$rendered"' EXIT

if docker compose --env-file .env.example config --format json >/dev/null 2>&1; then
  printf '%s\n' 'expected Compose to reject blank deployment secrets' >&2
  exit 1
fi

docker compose --env-file tests/compose-ci.env config --format json >"$rendered"

python3 tests/compose-contract.py "$rendered"
