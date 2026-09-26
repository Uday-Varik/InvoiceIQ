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
