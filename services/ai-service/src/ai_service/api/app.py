"""FastAPI surface. Every route must exist in packages/contracts/openapi/ai-service.yaml."""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable
from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from ai_service.api.signing import SIGNATURE_HEADER, TIMESTAMP_HEADER, SignatureError, verify
from ai_service.extraction import DocumentError, ExtractionError, extract, extract_document
from ai_service.providers import HeuristicProvider, LLMProvider, ProviderError, ReplayProvider
from ai_service.signals import compute_signals
from invoiceiq_contracts.ai_service import (
    DocumentExtractionRequest,
    ExtractionRequest,
    ExtractionResult,
    Health,
    SignalRequest,
    SignalResponse,
)

UNSIGNED_PATHS = frozenset({"/healthz"})


def _problem(status: int, title: str, detail: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        media_type="application/problem+json",
        content={"type": "about:blank", "title": title, "status": status, "detail": detail},
    )


def default_provider() -> LLMProvider:
    replay_dir = os.environ.get("AI_REPLAY_DIR")
    return ReplayProvider(Path(replay_dir)) if replay_dir else HeuristicProvider()


def create_app(provider: LLMProvider | None = None, *, signing_secret: str | None = None) -> FastAPI:
    """Build the app. With `signing_secret` set, every route but /healthz requires a valid signature."""
    app = FastAPI(title="InvoiceIQ ai-service", version="0.1.0")
    active = provider or default_provider()

    if signing_secret is not None:
        secret = signing_secret

        @app.middleware("http")
        async def require_signature(
            request: Request, call_next: Callable[[Request], Awaitable[Response]]
        ) -> Response:
            if request.url.path in UNSIGNED_PATHS:
                return await call_next(request)
            try:
                verify(
                    secret,
                    timestamp=request.headers.get(TIMESTAMP_HEADER),
                    signature=request.headers.get(SIGNATURE_HEADER),
                    method=request.method,
                    path=request.url.path,
                    body=await request.body(),
                )
            except SignatureError as exc:
                return _problem(401, "Unauthorized", str(exc))
            return await call_next(request)

    @app.exception_handler(RequestValidationError)
    async def validation_problem(_: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        loc = ".".join(str(p) for p in first.get("loc", ()))
        return _problem(422, "Invalid request", f"{loc}: {first.get('msg', 'invalid')}")

    @app.get("/healthz", response_model=Health)
    def healthz() -> Health:
        return Health(status="ok", service="ai-service")

    @app.post("/v1/extract", response_model=ExtractionResult)
    def extract_invoice(body: ExtractionRequest) -> ExtractionResult | JSONResponse:
        try:
            return extract(body, active)
        except ExtractionError as exc:
            return _problem(422, "Unusable provider output", str(exc))
        except ProviderError as exc:
            return _problem(503, "Provider unavailable", str(exc))

    @app.post("/v1/extract/document", response_model=ExtractionResult)
    def extract_invoice_document(body: DocumentExtractionRequest) -> ExtractionResult | JSONResponse:
        try:
            return extract_document(body, active)
        except DocumentError as exc:
            return _problem(422, "Unreadable document", str(exc))
        except ExtractionError as exc:
            return _problem(422, "Unusable provider output", str(exc))
        except ProviderError as exc:
            return _problem(503, "Provider unavailable", str(exc))

    @app.post("/v1/signals", response_model=SignalResponse)
    def signals(body: SignalRequest) -> SignalResponse:
        return compute_signals(body)

    return app
