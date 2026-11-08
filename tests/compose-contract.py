#!/usr/bin/env python3
"""Validate the effective Docker Compose JSON contract without printing secrets."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import NoReturn


def fail(message: str) -> NoReturn:
    print(f"Compose contract error: {message}", file=sys.stderr)
    raise SystemExit(1)


def required_service(services: object, name: str) -> dict[str, object]:
    if not isinstance(services, dict):
        fail("services must be an object")
    service = services.get(name)
    if not isinstance(service, dict):
        fail(f"required service {name!r} is missing")
    return service


def environment(service: dict[str, object], service_name: str) -> dict[str, str]:
    values = service.get("environment")
    if not isinstance(values, dict) or not all(isinstance(key, str) and isinstance(value, str) for key, value in values.items()):
        fail(f"{service_name} environment must render as string values")
    return values


def has_volume(service: dict[str, object], source: str, target: str) -> bool:
    volumes = service.get("volumes")
    if not isinstance(volumes, list):
        return False
    return any(
        isinstance(volume, dict)
        and volume.get("type") == "volume"
        and volume.get("source") == source
        and volume.get("target") == target
        for volume in volumes
    )


def file_mode(value: object) -> int | None:
    """Normalize a Compose file mode; Compose renders it as an octal string such as "0444"."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value and all(character in "01234567" for character in value):
        return int(value, 8)
    return None


def validate(compose: dict[str, object]) -> None:
    services = compose.get("services")
    sidecar = required_service(services, "ts-opencode2")
    app = required_service(services, "opencode2")

    if sidecar.get("image") != "tailscale/tailscale:v1.104.4":
        fail("sidecar image must be pinned")
    if app.get("image") != "ghcr.io/anomalyco/opencode:2.0.32":
        fail("application image must be pinned")
    if app.get("network_mode") not in ("service:ts-opencode2", "service:opencode2-ts-opencode2"):
        fail("application must share only the sidecar network namespace")
    if any(field in app for field in ("ports", "devices", "cap_add", "privileged", "networks")):
        fail("application must not receive ports, devices, capabilities, privileged mode, or a separate network")

    app_volumes = app.get("volumes")
    if isinstance(app_volumes, list) and any(isinstance(volume, dict) and volume.get("type") == "bind" for volume in app_volumes):
        fail("application must not receive host bind mounts")
    if not has_volume(app, "opencode2_workspace", "/workspace/projects") or not has_volume(app, "opencode2_state", "/root"):
        fail("application persistent named volumes are incomplete")
    if not has_volume(sidecar, "opencode2_tailscale_state", "/var/lib/tailscale"):
        fail("sidecar state volume is missing")

    devices = sidecar.get("devices")
    if not isinstance(devices, list) or not any(
        (isinstance(device, str) and device.split(":", maxsplit=1)[0] == "/dev/net/tun")
        or (
            isinstance(device, dict)
            and (
                device.get("path") == "/dev/net/tun"
                or (device.get("source") == "/dev/net/tun" and device.get("target") == "/dev/net/tun")
            )
        )
        for device in devices
    ):
        fail("sidecar must receive the TUN device")
    capabilities = sidecar.get("cap_add")
    if not isinstance(capabilities, list) or "NET_ADMIN" not in capabilities:
        fail("sidecar must receive NET_ADMIN")
    networks = sidecar.get("networks")
    if not isinstance(networks, dict) or "edge" not in networks:
        fail("sidecar must join the edge network")
    edge = networks.get("edge") or {}
    if not isinstance(edge, dict) or "opencode2" not in (edge.get("aliases") or []):
        fail("sidecar must expose the opencode2 alias on edge for the Caddy upstream")

    configs = app.get("configs")
    if not isinstance(configs, list) or not any(
        isinstance(config, dict)
        and config.get("source") == "opencode-config"
        and config.get("target") == "/etc/opencode/opencode.jsonc"
        and file_mode(config.get("mode")) == 0o444
        for config in configs
    ):
        fail("application must receive the readonly OpenCode config")
    security_options = app.get("security_opt")
    if not isinstance(security_options, list) or app.get("cap_drop") != ["ALL"] or "no-new-privileges:true" not in security_options:
        fail("application hardening controls are incomplete")
    healthcheck = app.get("healthcheck")
    healthcheck_test = healthcheck.get("test") if isinstance(healthcheck, dict) else None
    if not isinstance(healthcheck_test, list) or not all(isinstance(part, str) for part in healthcheck_test) or "/api/info" not in " ".join(healthcheck_test) or "@127.0.0.1" in " ".join(healthcheck_test) or "Authorization: Basic" not in " ".join(healthcheck_test):
        fail("application healthcheck is missing")

    app_environment = environment(app, "application")
    sidecar_environment = environment(sidecar, "sidecar")
    if not app_environment.get("OPENCODE_SERVER_PASSWORD"):
        fail("application server password must be nonempty after rendering")
    if not sidecar_environment.get("TS_AUTHKEY"):
        fail("sidecar auth key must be nonempty after rendering")
    if app_environment.get("OPENCODE_CONFIG") != "/etc/opencode/opencode.jsonc":
        fail("application must select the managed OpenCode config")


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: compose-contract.py PATH_TO_RENDERED_COMPOSE_JSON")
    try:
        rendered = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot parse rendered Compose JSON: {error}")
    if not isinstance(rendered, dict):
        fail("rendered Compose root must be an object")
    validate(rendered)


if __name__ == "__main__":
    main()
