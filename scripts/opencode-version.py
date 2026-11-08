#!/usr/bin/env python3
"""Pinned OpenCode image version helper for the auto-update workflow.

  current                 print the version pinned in docker-compose.yml
  latest <releases.json>  print the newest stable vMAJOR.x.y release of the
                          pinned major from a GitHub releases API listing
  set <version>           rewrite the single image pin in docker-compose.yml
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

COMPOSE = Path(__file__).resolve().parents[1] / "docker-compose.yml"
IMAGE = "ghcr.io/anomalyco/opencode"
PIN = re.compile(r"^(\s*image:\s*)" + re.escape(IMAGE) + r":(\d+\.\d+\.\d+)\s*$", re.MULTILINE)
VERSION = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
TAG = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")


def fail(message: str) -> None:
    print(f"opencode-version: {message}", file=sys.stderr)
    raise SystemExit(1)


def current() -> str:
    pins = PIN.findall(COMPOSE.read_text(encoding="utf-8"))
    if len(pins) != 1:
        fail("docker-compose.yml must pin exactly one OpenCode image version")
    return pins[0][1]


def parse(version: str) -> tuple[int, int, int]:
    match = VERSION.match(version)
    if not match:
        fail(f"invalid version: {version!r}")
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def latest(releases: list[dict[str, object]], major: int) -> str:
    candidates = []
    for release in releases:
        if release.get("draft") or release.get("prerelease"):
            continue
        match = TAG.match(str(release.get("tag_name", "")))
        if match and int(match.group(1)) == major:
            candidates.append(tuple(int(part) for part in match.groups()))
    if not candidates:
        fail(f"no stable v{major}.x.y release found")
    return "%d.%d.%d" % max(candidates)


def set_version(version: str) -> None:
    parse(version)
    text = COMPOSE.read_text(encoding="utf-8")
    current()
    COMPOSE.write_text(PIN.sub(lambda m: f"{m.group(1)}{IMAGE}:{version}", text), encoding="utf-8")


def main(argv: list[str]) -> None:
    if argv[:1] == ["current"] and len(argv) == 1:
        print(current())
    elif argv[:1] == ["latest"] and len(argv) == 2:
        releases = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
        if not isinstance(releases, list):
            fail("releases listing must be a JSON array")
        print(latest(releases, parse(current())[0]))
    elif argv[:1] == ["set"] and len(argv) == 2:
        set_version(argv[1])
    else:
        fail("usage: opencode-version.py current | latest <releases.json> | set <version>")


if __name__ == "__main__":
    main(sys.argv[1:])
