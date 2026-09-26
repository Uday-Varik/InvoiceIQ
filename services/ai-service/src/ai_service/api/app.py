"""FastAPI surface. Every route must exist in packages/contracts/openapi/ai-service.yaml."""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Awaitable, Callable
from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, PlainTextResponse

from ai_service.api.observability import (
    PROMETHEUS_CONTENT_TYPE,
    ServiceMetrics,
    bearer_matches,
    current_trace,
    start_span,
    status_class,
)
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


def create_app(
    provider: LLMProvider | None = None,
    *,
    signing_secret: str | None = None,
    metrics_token: str | None = None,
    metrics: ServiceMetrics | None = None,
    logger: logging.Logger | None = None,
) -> FastAPI:
    """Build the app.

    With `signing_secret` set, every route but /healthz requires a valid
    signature. /metrics answers a matching `metrics_token` bearer instead; with
    no token it is signed like everything else (open only in unsigned local runs).
    """
    app = FastAPI(title="InvoiceIQ ai-service", version="0.1.0")
    active = provider or default_provider()
    stats = metrics or ServiceMetrics()
    log = logger or logging.getLogger("ai_service")
    unsigned = UNSIGNED_PATHS | ({"/metrics"} if metrics_token else set())

    if signing_secret is not None:
        secret = signing_secret

        @app.middleware("http")
        async def require_signature(
            request: Request, call_next: Callable[[Request], Awaitable[Response]]
        ) -> Response:
            if request.url.path in unsigned:
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
                stats.signature_failures.inc()
                return _problem(401, "Unauthorized", str(exc))
            return await call_next(request)

    known_routes: set[str] = set()

    # Added after the signature check, so it wraps it: refused requests are traced and counted too.
    @app.middleware("http")
    async def observe(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        ctx = start_span(request.headers.get("traceparent"))
        token = current_trace.set(ctx)
        started = time.perf_counter()
        route = request.url.path if request.url.path in known_routes else "unmatched"
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            response.headers["traceresponse"] = ctx.header()
            response.headers["x-trace-id"] = ctx.trace_id
            return response
        finally:
            seconds = time.perf_counter() - started
            stats.requests.inc({"method": request.method, "route": route, "status": status_class(status)})
            stats.duration.observe(seconds, {"method": request.method, "route": route})
            if route != "/healthz":
                log.info(
                    "request",
                    extra={
                        "fields": {
                            "method": request.method,
                            "route": route,
                            "status": status,
                            "ms": round(seconds * 1000, 1),
                        }
                    },
                )
            current_trace.reset(token)

    @app.exception_handler(RequestValidationError)
    async def validation_problem(_: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        loc = ".".join(str(p) for p in first.get("loc", ()))
        return _problem(422, "Invalid request", f"{loc}: {first.get('msg', 'invalid')}")

    @app.get("/healthz", response_model=Health)
    def healthz() -> Health:
        return Health(status="ok", service="ai-service")

    def counted(outcome: str) -> None:
        stats.extractions.inc({"provider": active.name, "outcome": outcome})

    @app.post("/v1/extract", response_model=ExtractionResult)
    def extract_invoice(body: ExtractionRequest) -> ExtractionResult | JSONResponse:
        try:
            result = extract(body, active)
        except ExtractionError as exc:
            counted("unusable_output")
            return _problem(422, "Unusable provider output", str(exc))
        except ProviderError as exc:
            counted("provider_unavailable")
            return _problem(503, "Provider unavailable", str(exc))
        counted("ok")
        return result

    @app.post("/v1/extract/document", response_model=ExtractionResult)
    def extract_invoice_document(body: DocumentExtractionRequest) -> ExtractionResult | JSONResponse:
        try:
            result = extract_document(body, active)
            source = (
                "ocr"
                if result.provider.endswith("+ocr")
                else "none"
                if result.provider.endswith(":no-text-layer")
                else "text_layer"
            )
            stats.document_text.inc({"source": source})
        except DocumentError as exc:
            counted("unreadable_document")
            return _problem(422, "Unreadable document", str(exc))
        except ExtractionError as exc:
            counted("unusable_output")
            return _problem(422, "Unusable provider output", str(exc))
        except ProviderError as exc:
            counted("provider_unavailable")
            return _problem(503, "Provider unavailable", str(exc))
        counted("ok")
        return result

    @app.post("/v1/signals", response_model=SignalResponse)
    def signals(body: SignalRequest) -> SignalResponse:
        response = compute_signals(body)
        for signal in response.signals:
            stats.signals.inc({"reason": signal.reasonCode.value})
        return response

    @app.get("/metrics", response_class=PlainTextResponse)
    def metrics_endpoint(request: Request) -> Response:
        if metrics_token and not bearer_matches(request.headers.get("authorization"), metrics_token):
            problem = _problem(401, "Unauthorized", "metrics need the scrape token")
            problem.headers["www-authenticate"] = 'Bearer realm="metrics"'
            return problem
        return PlainTextResponse(
            stats.registry.render(), media_type=PROMETHEUS_CONTENT_TYPE, headers={"cache-control": "no-store"}
        )

    known_routes.update(r.path for r in app.routes if hasattr(r, "path"))
    return app
