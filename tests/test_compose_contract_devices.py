#!/usr/bin/env python3
"""Regression coverage for Docker Compose JSON device objects."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPOSITORY = Path(__file__).resolve().parents[1]
VALIDATOR = REPOSITORY / "tests" / "compose-contract.py"


def rendered_compose() -> dict[str, object]:
    return {
        "services": {
            "ts-opencode2": {
                "image": "tailscale/tailscale:v1.104.4",
                "environment": {"TS_AUTHKEY": "ci-placeholder-ts-authkey"},
                "devices": [{"path": "/dev/net/tun", "cgroup_permissions": "rwm"}],
                "cap_add": ["NET_ADMIN"],
                "volumes": [{"type": "volume", "source": "opencode2_tailscale_state", "target": "/var/lib/tailscale"}],
                "networks": {"edge": {"aliases": ["opencode2"]}},
            },
            "opencode2": {
                "image": "ghcr.io/anomalyco/opencode:2.0.32",
                "network_mode": "service:ts-opencode2",
                "environment": {"OPENCODE_SERVER_PASSWORD": "ci-placeholder-server-password", "OPENCODE_CONFIG": "/etc/opencode/opencode.jsonc"},
                "volumes": [
                    {"type": "volume", "source": "opencode2_workspace", "target": "/workspace/projects"},
                    {"type": "volume", "source": "opencode2_state", "target": "/root"},
                ],
                "configs": [{"source": "opencode-config", "target": "/etc/opencode/opencode.jsonc", "mode": 0o444}],
                "cap_drop": ["ALL"],
                "security_opt": ["no-new-privileges:true"],
                "healthcheck": {"test": ["CMD-SHELL", "wget -q -O /dev/null --header \"Authorization: Basic $$TOKEN\" http://127.0.0.1:4096/api/info"]},
            },
        },
    }


class ComposeContractDeviceTests(unittest.TestCase):
    def validate(self, compose: dict[str, object]) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory(prefix="opencode2-compose-devices-", dir="/tmp") as directory:
            rendered_path = Path(directory) / "compose.json"
            rendered_path.write_text(json.dumps(compose), encoding="utf-8")
            return subprocess.run([sys.executable, str(VALIDATOR), str(rendered_path)], capture_output=True, text=True, check=False)

    def test_accepts_normalized_tun_device_object(self) -> None:
        result = self.validate(rendered_compose())
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_missing_normalized_tun_device(self) -> None:
        compose = rendered_compose()
        compose["services"]["ts-opencode2"]["devices"] = []  # type: ignore[index]
        result = self.validate(compose)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("sidecar must receive the TUN device", result.stderr)

    def test_rejects_normalized_tun_device_on_application(self) -> None:
        compose = rendered_compose()
        compose["services"]["opencode2"]["devices"] = [{"path": "/dev/net/tun", "cgroup_permissions": "rwm"}]  # type: ignore[index]
        result = self.validate(compose)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("application must not receive ports, devices", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
