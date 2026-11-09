from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[1]
HELPER = REPOSITORY / "scripts" / "opencode-version.py"
AUTO_UPDATE = REPOSITORY / ".github" / "workflows" / "auto-update.yml"
DEPLOY = REPOSITORY / ".github" / "workflows" / "deploy.yml"


class VersionHelperTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "scripts").mkdir()
        shutil.copy(HELPER, self.tmp / "scripts" / HELPER.name)
        shutil.copy(REPOSITORY / "docker-compose.yml", self.tmp / "docker-compose.yml")
        self.addCleanup(shutil.rmtree, self.tmp)

    def run_helper(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([sys.executable, str(self.tmp / "scripts" / HELPER.name), *args], capture_output=True, text=True)

    def test_reads_single_pin(self) -> None:
        result = self.run_helper("current")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout.strip(), r"^\d+\.\d+\.\d+$")

    def test_latest_picks_newest_stable_release_of_pinned_major(self) -> None:
        self.run_helper("set", "2.0.32")
        releases = [
            {"tag_name": "v2.2.6", "draft": False, "prerelease": False},
            {"tag_name": "v2.10.0", "draft": False, "prerelease": True},
            {"tag_name": "v2.11.0", "draft": True, "prerelease": False},
            {"tag_name": "v3.0.0", "draft": False, "prerelease": False},
            {"tag_name": "v2.2.10", "draft": False, "prerelease": False},
            {"tag_name": "process-daemon-v9.0.0", "draft": False, "prerelease": False},
            {"tag_name": "v1.19.5", "draft": False, "prerelease": False},
        ]
        listing = self.tmp / "releases.json"
        listing.write_text(json.dumps(releases), encoding="utf-8")
        result = self.run_helper("latest", str(listing))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "2.2.10")

    def test_set_rewrites_only_the_opencode_pin(self) -> None:
        before = (self.tmp / "docker-compose.yml").read_text(encoding="utf-8")
        result = self.run_helper("set", "2.2.6")
        self.assertEqual(result.returncode, 0, result.stderr)
        after = (self.tmp / "docker-compose.yml").read_text(encoding="utf-8")
        self.assertIn("image: ghcr.io/anomalyco/opencode:2.2.6\n", after)
        self.assertIn("tailscale/tailscale:v1.104.4", after)
        self.assertEqual(len(before.splitlines()), len(after.splitlines()))

    def test_set_rejects_non_semver(self) -> None:
        for bad in ("latest", "2.2", "2.2.6-rc1", "2.2.6;rm"):
            self.assertNotEqual(self.run_helper("set", bad).returncode, 0, bad)


class AutoUpdateWorkflowTests(unittest.TestCase):
    def test_deploy_is_reusable_by_exact_sha(self) -> None:
        deploy = DEPLOY.read_text(encoding="utf-8")
        self.assertIn("workflow_call:", deploy)
        self.assertIn("type: string", deploy)

    def test_auto_update_deploys_before_promoting_and_rolls_back(self) -> None:
        workflow = AUTO_UPDATE.read_text(encoding="utf-8")
        self.assertIn("schedule:", workflow)
        self.assertIn("uses: ./.github/workflows/deploy.yml", workflow)
        self.assertIn("ref: ${{ needs.check.outputs.candidate_sha }}", workflow)
        self.assertIn("needs: [check, deploy]", workflow)
        self.assertIn("ref: ${{ needs.check.outputs.main_sha }}", workflow)
        self.assertIn("needs.deploy.result == 'failure'", workflow)
        self.assertIn("ghcr.io/v2/anomalyco/opencode/manifests/", workflow)
        self.assertIn("bash tests/deploy-workflow-contract.sh", workflow)
        self.assertNotIn("--force", workflow)
        self.assertNotIn("push -f", workflow)
        self.assertNotIn(":latest", workflow)


VERIFY = REPOSITORY / ".github" / "workflows" / "verify.yml"


class VerifyWorkflowTests(unittest.TestCase):
    def test_verify_is_manual_and_reverts_its_side_effects(self) -> None:
        workflow = VERIFY.read_text(encoding="utf-8")
        self.assertIn("  service-check:", workflow)
        self.assertNotIn("\n  api-check:\n", workflow)
        self.assertIn("workflow_dispatch:", workflow)
        self.assertNotIn("schedule:", workflow)
        self.assertNotIn("down -v", workflow)
        self.assertNotIn("volume rm", workflow)
        self.assertIn("unbanip", workflow)
        self.assertIn("-X DELETE", workflow)
        self.assertIn("if: always()", workflow[workflow.index("  cleanup:"):])
        self.assertNotIn("StrictHostKeyChecking", workflow)
        self.assertNotIn("opencode_ssh_key", workflow)
        self.assertNotIn("opencode_known_hosts", workflow)
        self.assertIn("needs: [service-check, browser]", workflow)
        self.assertIn("if: needs.host.result == 'success'", workflow)
        self.assertIn("group: deploy-vpn4-host", workflow)

    def test_verify_covers_every_acceptance_area(self) -> None:
        workflow = VERIFY.read_text(encoding="utf-8")
        for marker in ("/api/model/default", "/prompt", "PONG", "tailscale ping",
                       "docker restart", "fail2ban-client status opencode2-401", "Pixel 7", "width: 1440"):
            self.assertIn(marker, workflow)
        self.assertIn('page.locator("#server-connect-url")', workflow)
        self.assertIn("CLIProxy did not complete an assistant message", workflow)
        self.assertIn("assistant message summary", workflow)
        self.assertIn("provider error kinds", workflow)
        self.assertIn("/api/experimental/session/$sid/wait", workflow)
        self.assertNotIn('print("default model payload:"', workflow)
        self.assertNotIn("edge-nginx", workflow)


if __name__ == "__main__":
    unittest.main()
