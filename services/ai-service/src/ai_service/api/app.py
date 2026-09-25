"""FastAPI surface. Every route must exist in packages/contracts/openapi/ai-service.yaml."""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from ai_service.extraction import ExtractionError, extract
from ai_service.providers import HeuristicProvider, LLMProvider, ProviderError, ReplayProvider
from ai_service.signals import compute_signals
from invoiceiq_contracts.ai_service import (
    ExtractionRequest,
    ExtractionResult,
    Health,
    SignalRequest,
    SignalResponse,
)


def _problem(status: int, title: str, detail: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        media_type="application/problem+json",
        content={"type": "about:blank", "title": title, "status": status, "detail": detail},
    )


def default_provider() -> LLMProvider:
    replay_dir = os.environ.get("AI_REPLAY_DIR")
    return ReplayProvider(Path(replay_dir)) if replay_dir else HeuristicProvider()


def create_app(provider: LLMProvider | None = None) -> FastAPI:
    app = FastAPI(title="InvoiceIQ ai-service", version="0.1.0")
    active = provider or default_provider()

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

    @app.post("/v1/signals", response_model=SignalResponse)
    def signals(body: SignalRequest) -> SignalResponse:
        return compute_signals(body)

    return app
