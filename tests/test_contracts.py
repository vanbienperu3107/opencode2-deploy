#!/usr/bin/env python3
"""Executable negative tests for the public deployment contracts."""

from __future__ import annotations

import json
import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


REPOSITORY = Path(__file__).resolve().parents[1]
VALIDATOR = REPOSITORY / "scripts" / "validate-v2-contract.py"
SCANNER = REPOSITORY / "scripts" / "scan-secrets.py"
WORKFLOW = REPOSITORY / ".github" / "workflows" / "ci.yml"
COMPOSE = REPOSITORY / "docker-compose.yml"
COMPOSE_CONTRACT = REPOSITORY / "tests" / "compose-contract.sh"
CONFIG = REPOSITORY / "opencode.jsonc"
CHECKOUT_SHA = "11bd71901bbe5b1630ceea73d27597364c9af683"


def valid_config() -> dict[str, object]:
    return {
        "$schema": "https://opencode.ai/config.json",
        "providers": {
            "cliproxy": {
                "env": ["CLIPROXY_API_KEY"],
                "package": "@opencode/ai/providers/openai-compatible",
                "settings": {
                    "baseURL": "https://cliproxy.hangocthanh.io.vn/v1",
                    "apiKey": "{env:CLIPROXY_API_KEY}",
                },
            },
        },
        "permissions": [
            {"action": "*", "resource": "*", "effect": "allow"},
        ],
    }


def valid_cliproxy_config() -> dict[str, object]:
    return valid_config()


def run_command(*command: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, capture_output=True, text=True, check=False)


def load_scanner_module():
    specification = importlib.util.spec_from_file_location("scan_secrets", SCANNER)
    if specification is None or specification.loader is None:
        raise RuntimeError("cannot load secret scanner")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


class WithoutOpenFlag:
    def __init__(self, wrapped, missing_flag: str) -> None:
        self.wrapped = wrapped
        self.missing_flag = missing_flag

    def __getattr__(self, name: str):
        if name == self.missing_flag:
            raise AttributeError(name)
        return getattr(self.wrapped, name)


class V2ContractValidatorTests(unittest.TestCase):
    def validate(self, config: dict[str, object]) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory(prefix="opencode2-v2-config-", dir="/tmp") as directory:
            config_path = Path(directory) / "opencode.jsonc"
            config_path.write_text(json.dumps(config), encoding="utf-8")
            return run_command(sys.executable, str(VALIDATOR), str(config_path))

    def test_accepts_only_the_required_v2_baseline_shape(self) -> None:
        result = self.validate(valid_cliproxy_config())
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_requires_the_cliproxy_openai_compatible_provider_contract(self) -> None:
        cases = {
            "missing": {
                "$schema": "https://opencode.ai/config.json",
                "providers": {},
                "permissions": [{"action": "*", "resource": "*", "effect": "allow"}],
            },
            "wrong_package": valid_cliproxy_config(),
            "wrong_base_url": valid_cliproxy_config(),
            "missing_api_key_template": valid_cliproxy_config(),
        }
        cases["wrong_package"]["providers"]["cliproxy"]["package"] = "@ai-sdk/openai-compatible"  # type: ignore[index]
        cases["wrong_base_url"]["providers"]["cliproxy"]["settings"]["baseURL"] = "https://example.invalid/v1"  # type: ignore[index]
        del cases["missing_api_key_template"]["providers"]["cliproxy"]["settings"]["apiKey"]  # type: ignore[index]

        for name, config in cases.items():
            with self.subTest(name=name):
                result = self.validate(config)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("CLIProxy provider", result.stderr)

    def test_rejects_v1_provider_and_permission_fields(self) -> None:
        for field, value in (("provider", {}), ("permission", [])):
            with self.subTest(field=field):
                config = valid_config()
                config[field] = value
                result = self.validate(config)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"V1 field '{field}'", result.stderr)

    def test_rejects_non_object_providers(self) -> None:
        for providers in ([], "cliproxy", None):
            with self.subTest(providers=providers):
                config = valid_config()
                config["providers"] = providers
                result = self.validate(config)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("'providers' must be an object", result.stderr)

    def test_rejects_non_object_provider_entries(self) -> None:
        config = valid_config()
        config["providers"] = {"cliproxy": []}
        result = self.validate(config)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("provider 'cliproxy' must be an object", result.stderr)

    def test_rejects_non_array_permissions(self) -> None:
        for permissions in ({}, "allow", None):
            with self.subTest(permissions=permissions):
                config = valid_config()
                config["permissions"] = permissions
                result = self.validate(config)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("'permissions' must be an array", result.stderr)

    def test_rejects_non_object_permission_entries(self) -> None:
        config = valid_config()
        config["permissions"] = ["allow"]
        result = self.validate(config)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("permission at index 0 must be an object", result.stderr)

    def test_rejects_permission_fields_with_wrong_types(self) -> None:
        for field, value in (("action", 1), ("resource", []), ("effect", None)):
            with self.subTest(field=field):
                config = valid_config()
                config["permissions"] = [
                    {"action": "*", "resource": "*", "effect": "allow"},
                    {"action": "read", "resource": "*", "effect": "allow", field: value},
                ]
                result = self.validate(config)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"field '{field}' must be a string", result.stderr)

    def test_rejects_v1_bash_permission_action(self) -> None:
        config = valid_config()
        config["permissions"] = [
            {"action": "bash", "resource": "*", "effect": "allow"},
            {"action": "*", "resource": "*", "effect": "allow"},
        ]
        result = self.validate(config)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("action 'bash' is invalid", result.stderr)

    def test_rejects_permissions_without_the_wildcard_allow_rule(self) -> None:
        config = valid_config()
        config["permissions"] = [
            {"action": "read", "resource": "*", "effect": "allow"},
        ]
        result = self.validate(config)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("wildcard allow permission is required", result.stderr)


class SecretScannerTests(unittest.TestCase):
    @staticmethod
    def github_token_sentinel(fill: str = "A") -> str:
        return "gh" + "p_" + (fill * 24)

    def test_accepts_a_directory_without_secrets(self) -> None:
        with tempfile.TemporaryDirectory(prefix="opencode2-secret-sentinels-", dir="/tmp") as directory:
            root = Path(directory)
            (root / "safe.txt").write_text("public configuration only\n", encoding="utf-8")
            result = run_command(sys.executable, str(SCANNER), str(root))
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_detects_all_standard_github_token_prefixes(self) -> None:
        prefixes = ("p", "o", "u", "s", "r")
        with tempfile.TemporaryDirectory(prefix="opencode2-secret-sentinels-", dir="/tmp") as directory:
            root = Path(directory)
            for prefix in prefixes:
                sentinel = "gh" + prefix + "_" + ("A" * 24)
                file_path = root / f"github-{prefix}.txt"
                file_path.write_text(sentinel, encoding="utf-8")
                result = run_command(sys.executable, str(SCANNER), str(root))
                self.assertNotEqual(result.returncode, 0, result.stderr)
                self.assertIn("GitHub token", result.stderr)
                self.assertNotIn(sentinel, result.stderr)
                self.assertNotIn(file_path.name, result.stderr)
                file_path.unlink()

            fine_grained = "github" + "_pat_" + ("B" * 24)
            file_path = root / "github-fine-grained.txt"
            file_path.write_text(fine_grained, encoding="utf-8")
            result = run_command(sys.executable, str(SCANNER), str(root))
            self.assertNotEqual(result.returncode, 0, result.stderr)
            self.assertIn("fine-grained GitHub token", result.stderr)
            self.assertNotIn(fine_grained, result.stderr)
            self.assertNotIn(file_path.name, result.stderr)

    def test_detects_tailscale_auth_keys_retained_from_the_baseline_scanner(self) -> None:
        with tempfile.TemporaryDirectory(prefix="opencode2-secret-sentinels-", dir="/tmp") as directory:
            root = Path(directory)
            file_path = root / "tailscale-auth-key.txt"
            file_path.write_text("TS" + "KEY-" + ("C" * 24), encoding="utf-8")
            result = run_command(sys.executable, str(SCANNER), str(root))
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertIn("Tailscale auth key", result.stderr)

    def test_detects_generic_ec_openssh_and_rsa_private_key_headers(self) -> None:
        key_kinds = ("", "DSA", "EC", "OPENSSH", "RSA")
        with tempfile.TemporaryDirectory(prefix="opencode2-secret-sentinels-", dir="/tmp") as directory:
            root = Path(directory)
            for kind in key_kinds:
                qualifier = f"{kind} " if kind else ""
                sentinel = "-----BEGIN " + qualifier + "PRIVATE KEY-----"
                file_path = root / f"private-key-{kind or 'generic'}.txt"
                file_path.write_text(sentinel, encoding="utf-8")
                result = run_command(sys.executable, str(SCANNER), str(root))
                self.assertNotEqual(result.returncode, 0, result.stderr)
                self.assertIn("private-key PEM header", result.stderr)
                self.assertNotIn(file_path.name, result.stderr)
                file_path.unlink()

    def test_detects_a_token_embedded_in_non_utf8_binary_content(self) -> None:
        sentinel = self.github_token_sentinel("B")
        with tempfile.TemporaryDirectory(prefix="opencode2-secret-sentinels-", dir="/tmp") as directory:
            root = Path(directory)
            file_path = root / "binary.dat"
            file_path.write_bytes(b"\xff\x00" + sentinel.encode("ascii") + b"\x80")
            result = run_command(sys.executable, str(SCANNER), str(root))
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertIn("GitHub token", result.stderr)
        self.assertNotIn(sentinel, result.stderr)

    def test_rejects_a_filename_containing_a_token_without_disclosing_it(self) -> None:
        sentinel = self.github_token_sentinel("C")
        with tempfile.TemporaryDirectory(prefix="opencode2-secret-sentinels-", dir="/tmp") as directory:
            root = Path(directory)
            file_path = root / f"artifact-{sentinel}.txt"
            file_path.write_text("public content\n", encoding="utf-8")
            result = run_command(sys.executable, str(SCANNER), str(root))
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(sentinel, result.stdout)
        self.assertNotIn(sentinel, result.stderr)
        self.assertNotIn(file_path.name, result.stderr)

    def test_stderr_redacts_sentinels_from_both_path_and_binary_content(self) -> None:
        path_sentinel = self.github_token_sentinel("D")
        content_sentinel = self.github_token_sentinel("E")
        with tempfile.TemporaryDirectory(prefix="opencode2-secret-sentinels-", dir="/tmp") as directory:
            root = Path(directory)
            file_path = root / f"artifact-{path_sentinel}.dat"
            file_path.write_bytes(b"\xfe" + content_sentinel.encode("ascii"))
            result = run_command(sys.executable, str(SCANNER), str(root))
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertIn("GitHub token", result.stderr)
        self.assertNotIn(path_sentinel, result.stdout + result.stderr)
        self.assertNotIn(content_sentinel, result.stdout + result.stderr)

    def test_fails_closed_without_disclosing_unreadable_file_paths(self) -> None:
        with tempfile.TemporaryDirectory(prefix="opencode2-secret-sentinels-", dir="/tmp") as directory:
            root = Path(directory)
            inaccessible_name = "unreadable-file.txt"
            file_path = root / inaccessible_name
            file_path.write_text("public content\n", encoding="utf-8")
            file_path.chmod(0)
            try:
                result = run_command(sys.executable, str(SCANNER), str(root))
            finally:
                file_path.chmod(0o600)
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertIn("unreadable scoped file", result.stderr)
        self.assertNotIn(inaccessible_name, result.stderr)

    def test_fails_closed_when_an_unreadable_scoped_directory_cannot_be_walked(self) -> None:
        with tempfile.TemporaryDirectory(prefix="opencode2-secret-sentinels-", dir="/tmp") as directory:
            root = Path(directory)
            inaccessible_directory = root / "unreadable-directory"
            inaccessible_directory.mkdir()
            inaccessible_directory.chmod(0)
            try:
                result = run_command(sys.executable, str(SCANNER), str(root))
            finally:
                inaccessible_directory.chmod(0o700)
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertIn("unreadable scoped file", result.stderr)
        self.assertNotIn(inaccessible_directory.name, result.stderr)

    def test_fails_closed_and_redacts_an_in_root_file_symlink(self) -> None:
        sentinel = self.github_token_sentinel("F")
        with tempfile.TemporaryDirectory(prefix="opencode2-secret-sentinels-", dir="/tmp") as directory:
            root = Path(directory)
            target = root / "safe-target.txt"
            target.write_text("public content\n", encoding="utf-8")
            symlink_name = f"alias-{sentinel}"
            (root / symlink_name).symlink_to(target.name)
            result = run_command(sys.executable, str(SCANNER), str(root))
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertIn("unsafe scoped symlink", result.stderr)
        self.assertNotIn(sentinel, result.stdout + result.stderr)
        self.assertNotIn(symlink_name, result.stdout + result.stderr)

    def test_fails_closed_and_redacts_a_symlinked_scan_root(self) -> None:
        sentinel = self.github_token_sentinel("J")
        with tempfile.TemporaryDirectory(prefix="opencode2-secret-sentinels-", dir="/tmp") as directory:
            parent = Path(directory)
            target = parent / "safe-root"
            target.mkdir()
            symlink_name = f"root-alias-{sentinel}"
            root = parent / symlink_name
            root.symlink_to(target.name, target_is_directory=True)
            result = run_command(sys.executable, str(SCANNER), str(root))
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertIn("unsafe scoped symlink", result.stderr)
        self.assertNotIn(sentinel, result.stdout + result.stderr)
        self.assertNotIn(symlink_name, result.stdout + result.stderr)

    def test_fails_closed_and_redacts_a_broken_scoped_symlink(self) -> None:
        sentinel = self.github_token_sentinel("G")
        with tempfile.TemporaryDirectory(prefix="opencode2-secret-sentinels-", dir="/tmp") as directory:
            root = Path(directory)
            symlink_name = f"broken-{sentinel}"
            (root / symlink_name).symlink_to("missing-target")
            result = run_command(sys.executable, str(SCANNER), str(root))
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertIn("unsafe scoped symlink", result.stderr)
        self.assertNotIn(sentinel, result.stdout + result.stderr)
        self.assertNotIn(symlink_name, result.stdout + result.stderr)

    def test_fails_closed_and_redacts_an_in_root_directory_symlink(self) -> None:
        sentinel = self.github_token_sentinel("H")
        with tempfile.TemporaryDirectory(prefix="opencode2-secret-sentinels-", dir="/tmp") as directory:
            root = Path(directory)
            target = root / "safe-directory"
            target.mkdir()
            (target / "safe.txt").write_text("public content\n", encoding="utf-8")
            symlink_name = f"directory-alias-{sentinel}"
            (root / symlink_name).symlink_to(target.name, target_is_directory=True)
            result = run_command(sys.executable, str(SCANNER), str(root))
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertIn("unsafe scoped symlink", result.stderr)
        self.assertNotIn(sentinel, result.stdout + result.stderr)
        self.assertNotIn(symlink_name, result.stdout + result.stderr)

    def test_fails_closed_when_a_file_becomes_a_symlink_between_stat_and_open(self) -> None:
        scanner = load_scanner_module()
        sentinel = self.github_token_sentinel("I")
        with tempfile.TemporaryDirectory(prefix="opencode2-secret-sentinels-", dir="/tmp") as directory:
            root = Path(directory)
            raced_file = root / "race.txt"
            raced_file.write_text("public content\n", encoding="utf-8")
            target = root / "target.txt"
            target.write_text(sentinel, encoding="utf-8")
            original_open = scanner.os.open
            replaced = False

            def replace_before_file_open(path, flags, mode=0o777, *, dir_fd=None):
                nonlocal replaced
                if path == raced_file.name and dir_fd is not None and not replaced:
                    replaced = True
                    raced_file.unlink()
                    raced_file.symlink_to(target.name)
                return original_open(path, flags, mode, dir_fd=dir_fd)

            with mock.patch.object(scanner.os, "open", side_effect=replace_before_file_open):
                findings = scanner.scan(root)
        rendered = "\n".join(findings)
        self.assertTrue(replaced)
        self.assertIn("unsafe scoped symlink", rendered)
        self.assertNotIn(sentinel, rendered)
        self.assertNotIn(raced_file.name, rendered)

    def test_fails_closed_and_redacts_when_no_follow_is_unavailable(self) -> None:
        scanner = load_scanner_module()
        sentinel = self.github_token_sentinel("K")
        with tempfile.TemporaryDirectory(prefix="opencode2-secret-sentinels-", dir="/tmp") as directory:
            root = Path(directory)
            (root / f"clean-{sentinel}.txt").write_text("public content\n", encoding="utf-8")
            with mock.patch.object(scanner, "os", WithoutOpenFlag(os, "O_NOFOLLOW")):
                findings = scanner.scan(root)
        rendered = "\n".join(findings)
        self.assertIn("unsafe scoped file", rendered)
        self.assertNotIn(sentinel, rendered)

    def test_fails_closed_and_redacts_when_directory_flag_is_unavailable(self) -> None:
        scanner = load_scanner_module()
        sentinel = self.github_token_sentinel("L")
        with tempfile.TemporaryDirectory(prefix="opencode2-secret-sentinels-", dir="/tmp") as directory:
            root = Path(directory)
            (root / f"clean-{sentinel}").mkdir()
            with mock.patch.object(scanner, "os", WithoutOpenFlag(os, "O_DIRECTORY")):
                findings = scanner.scan(root)
        rendered = "\n".join(findings)
        self.assertIn("unsafe scoped file", rendered)
        self.assertNotIn(sentinel, rendered)


class WorkflowPinTests(unittest.TestCase):
    def test_ci_uses_the_verified_checkout_commit_and_keeps_read_only_permissions(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn(f"actions/checkout@{CHECKOUT_SHA}", workflow)
        self.assertNotIn("actions/checkout@v4", workflow)
        self.assertIn("contents: read", workflow)


class RuntimeComposeContractTests(unittest.TestCase):
    def test_runtime_contract_script_is_versioned_and_runs_in_ci(self) -> None:
        self.assertTrue(COMPOSE_CONTRACT.is_file())
        script = COMPOSE_CONTRACT.read_text(encoding="utf-8")
        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("docker compose --env-file .env.example config", script)
        self.assertIn("bash tests/compose-contract.sh", workflow)

    def test_compose_defines_an_isolated_tailnet_sidecar_and_application(self) -> None:
        compose = COMPOSE.read_text(encoding="utf-8")
        for expected in (
            "  ts-opencode2:",
            "image: tailscale/tailscale:v1.104.4",
            "TS_STATE_DIR: /var/lib/tailscale",
            "TS_USERSPACE: \"false\"",
            "- /dev/net/tun",
            "- NET_ADMIN",
            "network_mode: service:ts-opencode2",
            "command: [\"serve\", \"--hostname\", \"0.0.0.0\", \"--port\", \"4096\"]",
            "opencode2_tailscale_state:",
            "opencode2_workspace:",
            "opencode2_state:",
            "no-new-privileges:true",
            "test: [\"CMD-SHELL\", \"wget -q -O /dev/null",
        ):
            with self.subTest(expected=expected):
                self.assertIn(expected, compose)

        application = compose.split("  opencode2:", maxsplit=1)[1]
        self.assertNotIn("privileged:", application)
        self.assertNotIn("cap_add:", application)
        self.assertNotIn("devices:", application)
        self.assertNotIn("ports:", application)
        self.assertNotIn("docker.sock", application)

    def test_committed_config_is_the_validated_cliproxy_v2_contract(self) -> None:
        config = json.loads(CONFIG.read_text(encoding="utf-8"))
        result = run_command(sys.executable, str(VALIDATOR), str(CONFIG))
        self.assertEqual(config["providers"]["cliproxy"]["settings"]["baseURL"], "https://cliproxy.hangocthanh.io.vn/v1")
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
