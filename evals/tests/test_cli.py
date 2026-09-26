import json

import pytest

from invoiceiq_evals.cli import main


def test_cli_text(capsys: pytest.CaptureFixture[str]) -> None:
    main(["--version", "test-v1"])
    out = capsys.readouterr().out
    assert "Evaluation Report" in out


def test_cli_json(capsys: pytest.CaptureFixture[str]) -> None:
    main(["--json", "--version", "test-v1"])
    out = capsys.readouterr().out
    parsed = json.loads(out)
    assert parsed["total_documents"] == 46


def test_cli_provider_flag(capsys: pytest.CaptureFixture[str]) -> None:
    main(["--json", "--provider", "heuristic", "--version", "test-v1"])
    out = capsys.readouterr().out
    parsed = json.loads(out)
    assert parsed["total_documents"] == 46


def test_cli_provider_echo(capsys: pytest.CaptureFixture[str]) -> None:
    main(["--json", "--provider", "echo", "--version", "test-v1"])
    out = capsys.readouterr().out
    parsed = json.loads(out)
    assert parsed["total_documents"] == 46
    assert parsed["provider"] == "echo"
