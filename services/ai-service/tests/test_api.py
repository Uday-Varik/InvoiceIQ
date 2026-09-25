from __future__ import annotations

from fastapi.testclient import TestClient

from invoiceiq_contracts.ai_service import ExtractionResult, Health, Problem, SignalResponse

from .conftest import INVOICE_TEXT, SHA, TENANT


def test_healthz(client: TestClient) -> None:
    res = client.get("/healthz")
    assert res.status_code == 200
    assert Health.model_validate(res.json()).service == "ai-service"


def test_extract_happy_path(client: TestClient) -> None:
    res = client.post("/v1/extract", json={"tenantId": TENANT, "documentSha256": SHA, "text": INVOICE_TEXT})
    assert res.status_code == 200
    body = ExtractionResult.model_validate(res.json())
    assert body.fields.invoiceNumber.value == "INV-2026-0042"
    assert body.fields.totalMinor.value == "123450"
    assert body.fields.currency.value == "USD"
    assert body.provider == "heuristic"


def test_extract_rejects_bad_sha(client: TestClient) -> None:
    res = client.post("/v1/extract", json={"tenantId": TENANT, "documentSha256": "nope", "text": "x"})
    assert res.status_code == 422
    assert Problem.model_validate(res.json()).title == "Invalid request"
    assert res.headers["content-type"].startswith("application/problem+json")


def test_extract_rejects_extra_fields(client: TestClient) -> None:
    res = client.post(
        "/v1/extract", json={"tenantId": TENANT, "documentSha256": SHA, "text": "x", "approve": True}
    )
    assert res.status_code == 422


def test_signals_roundtrip(client: TestClient) -> None:
    extraction = client.post(
        "/v1/extract", json={"tenantId": TENANT, "documentSha256": SHA, "text": "Vendor: X\n"}
    ).json()
    res = client.post("/v1/signals", json={"extraction": extraction, "extractionConfidenceHoldBelow": 0.9})
    assert res.status_code == 200
    signals = SignalResponse.model_validate(res.json()).signals
    assert [s.reasonCode.value for s in signals] == ["AI_EXTRACTION_LOW_CONFIDENCE"]
    assert all(s.outcome == "HOLD" for s in signals)


def test_signals_reject_low_threshold(client: TestClient) -> None:
    extraction = client.post(
        "/v1/extract", json={"tenantId": TENANT, "documentSha256": SHA, "text": INVOICE_TEXT}
    ).json()
    res = client.post("/v1/signals", json={"extraction": extraction, "extractionConfidenceHoldBelow": 0.1})
    assert res.status_code == 422


def test_no_route_can_change_invoice_state(client: TestClient) -> None:
    paths = {getattr(r, "path", "") for r in client.app.routes}  # type: ignore[attr-defined]
    forbidden = ("approve", "reject", "release", "payment", "pay", "transition", "state")
    offenders = [p for p in paths if any(f in p.lower() for f in forbidden)]
    assert offenders == []


def test_extract_document_happy_path(client: TestClient) -> None:
    import base64
    import hashlib
    from pathlib import Path

    data = (Path(__file__).parent / "fixtures" / "documents" / "sample-invoice.pdf").read_bytes()
    res = client.post(
        "/v1/extract/document",
        json={
            "tenantId": TENANT,
            "documentSha256": hashlib.sha256(data).hexdigest(),
            "contentType": "application/pdf",
            "contentBase64": base64.b64encode(data).decode(),
        },
    )
    assert res.status_code == 200
    assert ExtractionResult.model_validate(res.json()).fields.totalMinor.value == "123450"


def test_extract_document_sha_mismatch_is_422(client: TestClient) -> None:
    res = client.post(
        "/v1/extract/document",
        json={
            "tenantId": TENANT,
            "documentSha256": SHA,
            "contentType": "application/pdf",
            "contentBase64": "JVBERi0=",
        },
    )
    assert res.status_code == 422
    assert Problem.model_validate(res.json()).title == "Unreadable document"
