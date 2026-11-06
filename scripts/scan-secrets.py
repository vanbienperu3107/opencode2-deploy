#!/usr/bin/env python3
"""Reject common credential material without printing the matched secret."""

from __future__ import annotations

import re
import sys
from pathlib import Path


GITHUB_TOKEN = re.compile(r"\bgh(?:p|o|u|s|r)_[A-Za-z0-9_]{20,}\b")
FINE_GRAINED_TOKEN = re.compile(r"\bgithub" + r"_pat_[A-Za-z0-9_]{20,}\b")
TAILSCALE_AUTH_KEY = re.compile(r"\bTS" + r"KEY-[A-Za-z0-9_-]{20,}\b")
PEM_HEADER = re.compile(
    r"-----BEGIN"
    + r" (?:DSA |EC |OPENSSH |RSA )?"
    + r"PRIVATE"
    + r" KEY-----"
)
PATTERNS = (
    ("GitHub token", GITHUB_TOKEN),
    ("fine-grained GitHub token", FINE_GRAINED_TOKEN),
    ("Tailscale auth key", TAILSCALE_AUTH_KEY),
    ("private-key PEM header", PEM_HEADER),
)
IGNORED_DIRECTORIES = {".git", ".codegraph", "__pycache__"}


def iter_files(root: Path):
    for path in root.rglob("*"):
        if any(part in IGNORED_DIRECTORIES for part in path.parts):
            continue
        if path.is_file():
            yield path


def scan(root: Path) -> list[str]:
    findings: list[str] = []
    for path in iter_files(root):
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for description, pattern in PATTERNS:
            if pattern.search(content):
                findings.append(f"{path}: detected {description}")
    return findings


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: scan-secrets.py DIRECTORY", file=sys.stderr)
        raise SystemExit(2)

    root = Path(sys.argv[1])
    if not root.is_dir():
        print(f"secret scan root is not a directory: {root}", file=sys.stderr)
        raise SystemExit(2)

    findings = scan(root)
    if findings:
        print("secret scan failed:", file=sys.stderr)
        print("\n".join(findings), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
