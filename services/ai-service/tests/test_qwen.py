"""Tests for the Qwen extraction provider."""

from __future__ import annotations

import json
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

import pytest

from ai_service.extraction import extract
from ai_service.providers.base import ProviderError
from ai_service.providers.qwen import (
    SYSTEM_PROMPT,
    QwenProvider,
    _strip_markdown_fences,
)
from invoiceiq_contracts.ai_service import ExtractionRequest

from .conftest import INVOICE_TEXT, SHA, TENANT


def _req(text: str = INVOICE_TEXT) -> ExtractionRequest:
    return ExtractionRequest.model_validate({"tenantId": TENANT, "documentSha256": SHA, "text": text})


# --- construction ---


def test_empty_api_key_raises() -> None:
    with pytest.raises(ProviderError, match="OPENROUTER_API_KEY is empty"):
        QwenProvider("")


def test_whitespace_api_key_raises() -> None:
    with pytest.raises(ProviderError, match="OPENROUTER_API_KEY is empty"):
        QwenProvider("   ")


def test_valid_api_key_accepted() -> None:
    provider = QwenProvider("tok_test_12345")
    assert provider.name == "qwen"


# --- prompt construction ---


def test_system_prompt_mentions_required_fields() -> None:
    fields = (
        "vendorName",
        "invoiceNumber",
        "invoiceDate",
        "currency",
        "totalMinor",
        "subtotalMinor",
        "taxMinor",
        "dueDate",
    )
    for field in fields:
        assert field in SYSTEM_PROMPT


def test_system_prompt_mentions_json() -> None:
    assert "JSON" in SYSTEM_PROMPT


def test_system_prompt_mentions_minor_units() -> None:
    assert "minor units" in SYSTEM_PROMPT


# --- markdown fence stripping ---


def test_strip_fences_plain_json() -> None:
    raw = '{"vendorName": {"value": "Acme", "confidence": 0.9}}'
    assert _strip_markdown_fences(raw) == raw


def test_strip_fences_json_block() -> None:
    raw = '```json\n{"vendorName": {"value": "Acme", "confidence": 0.9}}\n```'
    assert _strip_markdown_fences(raw) == '{"vendorName": {"value": "Acme", "confidence": 0.9}}'


def test_strip_fences_bare_block() -> None:
    raw = '```\n{"key": 1}\n```'
    assert _strip_markdown_fences(raw) == '{"key": 1}'


def test_strip_fences_with_whitespace() -> None:
    raw = '  ```json\n{"key": 1}\n```  '
    assert _strip_markdown_fences(raw) == '{"key": 1}'


# --- integration with a mock HTTP server ---


class _MockOpenRouterHandler(BaseHTTPRequestHandler):
    response_body: str = ""

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length))
        assert body["model"] == "qwen/qwen3-235b-a22b"
        assert len(body["messages"]) == 2
        assert body["messages"][0]["role"] == "system"
        assert body["messages"][1]["role"] == "user"

        resp = json.dumps(
            {
                "choices": [{"message": {"content": self.__class__.response_body}}],
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)

    def log_message(self, format: str, *args: object) -> None:
        pass


@pytest.fixture
def mock_openrouter_server() -> Iterator[str]:
    server = HTTPServer(("127.0.0.1", 0), _MockOpenRouterHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    yield f"http://127.0.0.1:{port}"
    server.shutdown()


def test_qwen_extracts_valid_json(mock_openrouter_server: str) -> None:
    extraction_json = json.dumps(
        {
            "vendorName": {"value": "ACME Industrial Supply", "confidence": 0.95},
            "invoiceNumber": {"value": "INV-2026-0042", "confidence": 0.95},
            "invoiceDate": {"value": "2026-03-14", "confidence": 0.90},
            "currency": {"value": "USD", "confidence": 0.95},
            "totalMinor": {"value": "123450", "confidence": 0.90},
            "subtotalMinor": {"value": None, "confidence": 0.0},
            "taxMinor": {"value": None, "confidence": 0.0},
            "dueDate": {"value": None, "confidence": 0.0},
        }
    )
    _MockOpenRouterHandler.response_body = extraction_json

    provider = QwenProvider("tok_test")
    provider._api_base = mock_openrouter_server
    result = extract(_req(), provider)

    assert result.fields.vendorName.value == "ACME Industrial Supply"
    assert result.fields.vendorName.confidence == 0.95
    assert result.fields.invoiceNumber.value == "INV-2026-0042"
    assert result.fields.totalMinor.value == "123450"
    assert result.provider == "qwen"


def test_qwen_handles_markdown_wrapped_json(mock_openrouter_server: str) -> None:
    extraction_json = (
        "```json\n"
        + json.dumps(
            {
                "vendorName": {"value": "Test Corp", "confidence": 0.9},
                "invoiceNumber": {"value": "INV-001", "confidence": 0.9},
                "invoiceDate": {"value": "2026-01-01", "confidence": 0.9},
                "currency": {"value": "EUR", "confidence": 0.9},
                "totalMinor": {"value": "10000", "confidence": 0.9},
                "subtotalMinor": {"value": None, "confidence": 0.0},
                "taxMinor": {"value": None, "confidence": 0.0},
                "dueDate": {"value": None, "confidence": 0.0},
            }
        )
        + "\n```"
    )
    _MockOpenRouterHandler.response_body = extraction_json

    provider = QwenProvider("tok_test")
    provider._api_base = mock_openrouter_server
    result = extract(_req(), provider)

    assert result.fields.vendorName.value == "Test Corp"
    assert result.fields.currency.value == "EUR"


def test_qwen_sends_system_and_user_messages(mock_openrouter_server: str) -> None:
    _MockOpenRouterHandler.response_body = json.dumps(
        {
            "vendorName": {"value": None, "confidence": 0.0},
        }
    )

    provider = QwenProvider("tok_test")
    provider._api_base = mock_openrouter_server
    provider.complete(task="extract_invoice_fields", prompt="test invoice text")


def test_qwen_registered_in_registry() -> None:
    from ai_service.providers import registered_names

    assert "qwen" in registered_names()


def test_qwen_registry_requires_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    from ai_service.providers import resolve

    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    with pytest.raises(ProviderError, match="OPENROUTER_API_KEY"):
        resolve("qwen")


def test_qwen_registry_resolves_with_key(monkeypatch: pytest.MonkeyPatch) -> None:
    from ai_service.providers import resolve

    monkeypatch.setenv("OPENROUTER_API_KEY", "tok_test_12345")
    provider = resolve("qwen")
    assert isinstance(provider, QwenProvider)
