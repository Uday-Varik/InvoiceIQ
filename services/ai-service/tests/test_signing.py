from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient

from ai_service.api import create_app
from ai_service.api.signing import MAX_SKEW_SECONDS, SignatureError, sign, verify
from ai_service.providers import HeuristicProvider

from .conftest import INVOICE_TEXT, SHA, TENANT

SECRET = "s" * 40


def _signed_headers(body: bytes, path: str, secret: str = SECRET, ts: int | None = None) -> dict[str, str]:
    stamp = int(time.time()) if ts is None else ts
    return {
        "content-type": "application/json",
        "x-iiq-timestamp": str(stamp),
        "x-iiq-signature": sign(secret, stamp, "POST", path, body),
    }


@pytest.fixture
def signed_client() -> TestClient:
    return TestClient(create_app(HeuristicProvider(), signing_secret=SECRET))


KNOWN_VECTOR = "v1=9c05c47e58b0806a6223c14a1003cfecb004622005d6474e7df5c9d1ed26ed04"


def test_sign_matches_the_shared_vector() -> None:
    # services/core-api/test/ai-client.test.ts checks the same vector, so both sides agree.
    assert sign("k" * 32, 1_700_000_000, "post", "/v1/extract", b"{}") == KNOWN_VECTOR


def test_verify_accepts_a_fresh_signature() -> None:
    now = 1_700_000_000
    sig = sign(SECRET, now, "POST", "/v1/extract", b"{}")
    verify(SECRET, timestamp=str(now), signature=sig, method="POST", path="/v1/extract", body=b"{}", now=now)


@pytest.mark.parametrize(
    ("timestamp", "signature", "body", "match"),
    [
        (None, "v1=x", b"{}", "missing"),
        ("abc", "v1=x", b"{}", "malformed"),
        (str(1_700_000_000 - MAX_SKEW_SECONDS - 1), None, b"{}", "missing"),
        (str(1_700_000_000 - MAX_SKEW_SECONDS - 1), "v1=x", b"{}", "window"),
        (str(1_700_000_000), "v1=" + "0" * 64, b"{}", "bad request signature"),
        (str(1_700_000_000), sign(SECRET, 1_700_000_000, "POST", "/v1/extract", b"{}"), b"{ }", "bad"),
    ],
)
def test_verify_refuses(timestamp: str | None, signature: str | None, body: bytes, match: str) -> None:
    with pytest.raises(SignatureError, match=match):
        verify(
            SECRET,
            timestamp=timestamp,
            signature=signature,
            method="POST",
            path="/v1/extract",
            body=body,
            now=1_700_000_000,
        )


def test_healthz_stays_unsigned(signed_client: TestClient) -> None:
    assert signed_client.get("/healthz").status_code == 200


def test_unsigned_request_is_401(signed_client: TestClient) -> None:
    res = signed_client.post("/v1/extract", json={"tenantId": TENANT, "documentSha256": SHA, "text": "x"})
    assert res.status_code == 401
    assert res.headers["content-type"].startswith("application/problem+json")


def test_signed_request_is_served(signed_client: TestClient) -> None:
    body = json.dumps({"tenantId": TENANT, "documentSha256": SHA, "text": INVOICE_TEXT}).encode()
    res = signed_client.post("/v1/extract", content=body, headers=_signed_headers(body, "/v1/extract"))
    assert res.status_code == 200
    assert res.json()["fields"]["invoiceNumber"]["value"] == "INV-2026-0042"


def test_signature_for_another_path_is_refused(signed_client: TestClient) -> None:
    body = json.dumps({"tenantId": TENANT, "documentSha256": SHA, "text": INVOICE_TEXT}).encode()
    res = signed_client.post("/v1/extract", content=body, headers=_signed_headers(body, "/v1/signals"))
    assert res.status_code == 401


def test_wrong_secret_is_refused(signed_client: TestClient) -> None:
    body = b"{}"
    res = signed_client.post(
        "/v1/signals", content=body, headers=_signed_headers(body, "/v1/signals", secret="x" * 40)
    )
    assert res.status_code == 401
