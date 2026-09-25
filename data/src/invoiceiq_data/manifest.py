"""Tamper-evident manifest for frozen evaluation sets.

The manifest lists every file with its sha256 and size, plus a root hash over
those lines. Verification fails on any added, removed or modified file, and on
an edited manifest (the root no longer matches). Frozen sets are never edited in
place: a change means a new versioned directory (test-v2) and an ADR.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import TypedDict

MANIFEST_NAME = "MANIFEST.json"


class FileEntry(TypedDict):
    path: str
    sha256: str
    bytes: int


class Manifest(TypedDict):
    version: int
    algorithm: str
    files: list[FileEntry]
    root: str


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def root_hash(files: list[FileEntry]) -> str:
    lines = "".join(
        f"{f['path']}\t{f['sha256']}\t{f['bytes']}\n" for f in sorted(files, key=lambda f: f["path"])
    )
    return hashlib.sha256(lines.encode()).hexdigest()


def _data_files(directory: Path) -> list[Path]:
    return sorted(p for p in directory.rglob("*") if p.is_file() and p.name != MANIFEST_NAME)


def build_manifest(directory: Path) -> Manifest:
    files: list[FileEntry] = [
        {"path": p.relative_to(directory).as_posix(), "sha256": _sha256(p), "bytes": p.stat().st_size}
        for p in _data_files(directory)
    ]
    return {"version": 1, "algorithm": "sha256", "files": files, "root": root_hash(files)}


def render_manifest(manifest: Manifest) -> str:
    return json.dumps(manifest, indent=2, sort_keys=True) + "\n"


def write_manifest(directory: Path) -> Manifest:
    manifest = build_manifest(directory)
    (directory / MANIFEST_NAME).write_text(render_manifest(manifest), encoding="utf-8")
    return manifest


def verify_manifest(directory: Path) -> list[str]:
    path = directory / MANIFEST_NAME
    if not path.is_file():
        return [f"{MANIFEST_NAME} missing in {directory}"]
    manifest: Manifest = json.loads(path.read_text(encoding="utf-8"))
    problems: list[str] = []
    if manifest.get("algorithm") != "sha256":
        problems.append("unsupported algorithm")
    if root_hash(manifest["files"]) != manifest["root"]:
        problems.append("manifest root hash mismatch (manifest edited)")
    listed = {f["path"]: f for f in manifest["files"]}
    actual = {p.relative_to(directory).as_posix(): p for p in _data_files(directory)}
    for rel in sorted(listed.keys() - actual.keys()):
        problems.append(f"missing file: {rel}")
    for rel in sorted(actual.keys() - listed.keys()):
        problems.append(f"unexpected file: {rel}")
    for rel in sorted(listed.keys() & actual.keys()):
        entry, p = listed[rel], actual[rel]
        if p.stat().st_size != entry["bytes"] or _sha256(p) != entry["sha256"]:
            problems.append(f"modified file: {rel}")
    return problems
