"""Verify HMAC request signatures from core-api (see the requestSignature scheme in ai-service.yaml)."""

from __future__ import annotations

import hashlib
import hmac
import time

MAX_SKEW_SECONDS = 300
TIMESTAMP_HEADER = "x-iiq-timestamp"
SIGNATURE_HEADER = "x-iiq-signature"


class SignatureError(ValueError):
    """The request is unsigned, stale, or signed with the wrong key."""


def sign(secret: str, timestamp: int, method: str, path: str, body: bytes) -> str:
    body_hash = hashlib.sha256(body).hexdigest()
    message = f"{timestamp}.{method.upper()}.{path}.{body_hash}".encode()
    return "v1=" + hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


def verify(
    secret: str,
    *,
    timestamp: str | None,
    signature: str | None,
    method: str,
    path: str,
    body: bytes,
    now: float | None = None,
) -> None:
    if not timestamp or not signature:
        raise SignatureError("missing request signature")
    try:
        ts = int(timestamp)
    except ValueError as exc:
        raise SignatureError("malformed signature timestamp") from exc
    current = time.time() if now is None else now
    if abs(current - ts) > MAX_SKEW_SECONDS:
        raise SignatureError("signature timestamp outside the allowed window")
    expected = sign(secret, ts, method, path, body)
    if not hmac.compare_digest(expected, signature):
        raise SignatureError("bad request signature")
