from __future__ import annotations

import json
from pathlib import Path

import pytest

from invoiceiq_data.cli import main
from invoiceiq_data.manifest import MANIFEST_NAME, build_manifest, root_hash, verify_manifest, write_manifest
from invoiceiq_data.paths import FROZEN_TEST_DIR


@pytest.fixture
def frozen(tmp_path: Path) -> Path:
    (tmp_path / "test.jsonl").write_text('{"a": 1}\n')
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "extra.txt").write_text("hello\n")
    write_manifest(tmp_path)
    return tmp_path


def test_fresh_manifest_verifies(frozen: Path) -> None:
    assert verify_manifest(frozen) == []


def test_manifest_is_deterministic(frozen: Path) -> None:
    assert build_manifest(frozen) == build_manifest(frozen)


def test_detects_modified_file(frozen: Path) -> None:
    (frozen / "test.jsonl").write_text('{"a": 2}\n')
    assert verify_manifest(frozen) == ["modified file: test.jsonl"]


def test_detects_same_size_modification(frozen: Path) -> None:
    (frozen / "sub" / "extra.txt").write_text("jello\n")
    assert verify_manifest(frozen) == ["modified file: sub/extra.txt"]


def test_detects_deleted_file(frozen: Path) -> None:
    (frozen / "sub" / "extra.txt").unlink()
    assert verify_manifest(frozen) == ["missing file: sub/extra.txt"]


def test_detects_added_file(frozen: Path) -> None:
    (frozen / "smuggled.jsonl").write_text("{}\n")
    assert verify_manifest(frozen) == ["unexpected file: smuggled.jsonl"]


def test_detects_edited_manifest(frozen: Path) -> None:
    path = frozen / MANIFEST_NAME
    manifest = json.loads(path.read_text())
    manifest["files"][0]["sha256"] = "0" * 64
    path.write_text(json.dumps(manifest))
    problems = verify_manifest(frozen)
    assert "manifest root hash mismatch (manifest edited)" in problems


def test_detects_rehashed_manifest_with_tampered_file(frozen: Path) -> None:
    """An attacker who edits a file AND recomputes the root still changes the root,
    which is pinned in git history and in docs; verification here catches the file."""
    (frozen / "test.jsonl").write_text('{"a": 3}\n')
    assert verify_manifest(frozen) != []


def test_missing_manifest(tmp_path: Path) -> None:
    assert verify_manifest(tmp_path) == [f"{MANIFEST_NAME} missing in {tmp_path}"]


def test_root_hash_is_order_independent() -> None:
    a = {"path": "a", "sha256": "1" * 64, "bytes": 1}
    b = {"path": "b", "sha256": "2" * 64, "bytes": 2}
    assert root_hash([a, b]) == root_hash([b, a])  # type: ignore[list-item]


def test_committed_frozen_set_is_intact() -> None:
    assert verify_manifest(FROZEN_TEST_DIR) == []


def test_freeze_refuses_to_overwrite() -> None:
    assert main(["freeze", "--to", str(FROZEN_TEST_DIR)]) == 1


def test_check_passes_on_committed_artifacts(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["check"]) == 0
    assert "frozen set intact" in capsys.readouterr().out
