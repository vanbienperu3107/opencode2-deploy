#!/usr/bin/env python3
"""Validate the OpenCode configuration contract required by this deployment."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import NoReturn


WILDCARD_ALLOW = {"action": "*", "resource": "*", "effect": "allow"}
V1_FIELDS = ("provider", "permission")
CLIPROXY_PROVIDER = {
    "name": "CLIProxy",
    "env": ["CLIPROXY_API_KEY"],
    "package": "@opencode/ai/providers/openai-compatible",
    "settings": {
        "baseURL": "https://cliproxy.hangocthanh.io.vn/v1",
        "apiKey": "{env:CLIPROXY_API_KEY}",
    },
    "models": {
        "deepseek-v4-flash": {
            "name": "DeepSeek V4 Flash",
            "modelID": "deepseek-v4-flash",
        },
        "claude-opus-5": {
            "name": "Claude Opus 5",
            "modelID": "claude-opus-5",
        },
    },
}
DEFAULT_MODEL = "cliproxy/deepseek-v4-flash"


def fail(message: str) -> NoReturn:
    print(f"OpenCode V2 contract error: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_config(config_path: Path) -> dict[str, object]:
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot parse {config_path}: {error}")

    if not isinstance(config, dict):
        fail("configuration root must be an object")
    return config


def validate(config: dict[str, object]) -> None:
    for field in V1_FIELDS:
        if field in config:
            fail(f"V1 field '{field}' is forbidden; use the V2 plural field")

    providers = config.get("providers")
    if not isinstance(providers, dict):
        fail("'providers' must be an object")
    for name, provider in providers.items():
        if not isinstance(provider, dict):
            fail(f"provider '{name}' must be an object")

    if providers.get("cliproxy") != CLIPROXY_PROVIDER:
        fail("CLIProxy provider must use the required V2 OpenAI-compatible contract")

    if config.get("model") != DEFAULT_MODEL:
        fail("CLIProxy deployment default model must be cliproxy/deepseek-v4-flash")

    permissions = config.get("permissions")
    if not isinstance(permissions, list):
        fail("'permissions' must be an array")

    wildcard_allow_found = False
    for index, permission in enumerate(permissions):
        if not isinstance(permission, dict):
            fail(f"permission at index {index} must be an object")
        for field in ("action", "resource", "effect"):
            if not isinstance(permission.get(field), str):
                fail(f"permission at index {index} field '{field}' must be a string")
        if permission.get("action") == "bash":
            fail(f"permission at index {index} action 'bash' is invalid in V2")
        if permission == WILDCARD_ALLOW:
            wildcard_allow_found = True

    if not wildcard_allow_found:
        fail("wildcard allow permission is required")


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: validate-v2-contract.py PATH_TO_OPENCODE_JSONC")
    validate(load_config(Path(sys.argv[1])))


if __name__ == "__main__":
    main()
