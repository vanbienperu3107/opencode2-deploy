#!/usr/bin/env python3
"""Reject common credential material without printing the matched secret."""

from __future__ import annotations

import os
import re
import stat
import sys
from pathlib import Path


GITHUB_TOKEN = re.compile(rb"\bgh(?:p|o|u|s|r)_[A-Za-z0-9_]{20,}\b")
FINE_GRAINED_TOKEN = re.compile(rb"\bgithub" + rb"_pat_[A-Za-z0-9_]{20,}\b")
TAILSCALE_AUTH_KEY = re.compile(rb"\bTS" + rb"KEY-[A-Za-z0-9_-]{20,}\b")
PEM_HEADER = re.compile(
    rb"-----BEGIN"
    + rb" (?:DSA |EC |OPENSSH |RSA )?"
    + rb"PRIVATE"
    + rb" KEY-----"
)
PATTERNS = (
    ("GitHub token", GITHUB_TOKEN),
    ("fine-grained GitHub token", FINE_GRAINED_TOKEN),
    ("Tailscale auth key", TAILSCALE_AUTH_KEY),
    ("private-key PEM header", PEM_HEADER),
)
IGNORED_DIRECTORIES = {".git", ".codegraph", "__pycache__"}
UNREADABLE_SCOPED_FILE = "unreadable scoped file"
UNSAFE_SCOPED_FILE = "unsafe scoped file"
UNSAFE_SCOPED_SYMLINK = "unsafe scoped symlink"


def safe_open_flags(*, directory: bool = False) -> tuple[int | None, str | None]:
    try:
        return nofollow_flags(directory=directory), None
    except OSError:
        return None, UNSAFE_SCOPED_FILE


def nofollow_flags(*, directory: bool = False) -> int:
    if not hasattr(os, "O_NOFOLLOW"):
        raise OSError("platform cannot open scoped entries without following symlinks")
    flags = os.O_RDONLY | os.O_NOFOLLOW
    if directory:
        if not hasattr(os, "O_DIRECTORY"):
            raise OSError("platform cannot open scoped directories safely")
        flags |= os.O_DIRECTORY
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    return flags


def finding_for_open_error(error: OSError) -> str:
    if error.errno == getattr(os, "ELOOP", 40):
        return UNSAFE_SCOPED_SYMLINK
    return UNREADABLE_SCOPED_FILE


def scan_file(directory_fd: int, name: str) -> tuple[bytes | None, str | None]:
    flags, flag_finding = safe_open_flags()
    if flag_finding:
        return None, flag_finding
    assert flags is not None
    try:
        file_fd = os.open(name, flags, dir_fd=directory_fd)
    except OSError as error:
        return None, finding_for_open_error(error)
    try:
        if not stat.S_ISREG(os.fstat(file_fd).st_mode):
            return None, UNSAFE_SCOPED_FILE
        with os.fdopen(file_fd, "rb", closefd=False) as file:
            return file.read(), None
    except OSError:
        return None, UNREADABLE_SCOPED_FILE
    finally:
        os.close(file_fd)


def scan_directory(directory_fd: int) -> list[str]:
    findings: list[str] = []
    try:
        names = os.listdir(directory_fd)
    except OSError:
        return [UNREADABLE_SCOPED_FILE]
    for name in names:
        try:
            entry_stat = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        except OSError:
            findings.append(UNREADABLE_SCOPED_FILE)
            continue
        relative_name = os.fsencode(name)
        for description, pattern in PATTERNS:
            if pattern.search(relative_name):
                findings.append(f"detected {description} (location redacted)")
        if stat.S_ISLNK(entry_stat.st_mode):
            findings.append(UNSAFE_SCOPED_SYMLINK)
            continue
        if name in IGNORED_DIRECTORIES:
            continue
        if stat.S_ISDIR(entry_stat.st_mode):
            flags, flag_finding = safe_open_flags(directory=True)
            if flag_finding:
                findings.append(flag_finding)
                continue
            assert flags is not None
            try:
                child_fd = os.open(name, flags, dir_fd=directory_fd)
            except OSError as error:
                findings.append(finding_for_open_error(error))
                continue
            try:
                if not stat.S_ISDIR(os.fstat(child_fd).st_mode):
                    findings.append(UNSAFE_SCOPED_FILE)
                else:
                    findings.extend(scan_directory(child_fd))
            finally:
                os.close(child_fd)
            continue
        if not stat.S_ISREG(entry_stat.st_mode):
            findings.append(UNSAFE_SCOPED_FILE)
            continue
        content, error_finding = scan_file(directory_fd, name)
        if error_finding:
            findings.append(error_finding)
            continue
        if content is None:
            findings.append(UNREADABLE_SCOPED_FILE)
            continue
        for description, pattern in PATTERNS:
            if pattern.search(content):
                findings.append(f"detected {description} (location redacted)")
    return findings


def scan(root: Path) -> list[str]:
    flags, flag_finding = safe_open_flags(directory=True)
    if flag_finding:
        return [flag_finding]
    assert flags is not None
    try:
        root_fd = os.open(root, flags)
    except OSError as error:
        return [finding_for_open_error(error)]
    try:
        return scan_directory(root_fd)
    finally:
        os.close(root_fd)


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: scan-secrets.py DIRECTORY", file=sys.stderr)
        raise SystemExit(2)

    root = Path(sys.argv[1])
    try:
        root_mode = os.lstat(root).st_mode
    except OSError:
        print("secret scan root is not a directory", file=sys.stderr)
        raise SystemExit(2)

    if stat.S_ISLNK(root_mode):
        findings = [UNSAFE_SCOPED_SYMLINK]
    elif not stat.S_ISDIR(root_mode):
        print("secret scan root is not a directory", file=sys.stderr)
        raise SystemExit(2)
    else:
        findings = scan(root)

    if findings:
        print("secret scan failed:", file=sys.stderr)
        print("\n".join(findings), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
