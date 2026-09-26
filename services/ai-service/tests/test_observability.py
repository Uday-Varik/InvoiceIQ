"""Trace context, request metrics, JSON logs and the /metrics endpoint."""

from __future__ import annotations

import io
import json
import logging
import re
import time

import pytest
from fastapi.testclient import TestClient

from ai_service.api import create_app
from ai_service.api.observability import (
    MAX_SERIES,
    PROMETHEUS_CONTENT_TYPE,
    Counter,
    Gauge,
    Histogram,
    Registry,
    ServiceMetrics,
    bearer_matches,
    configure_logging,
    current_trace,
    parse_traceparent,
    start_span,
    status_class,
)
from ai_service.api.signing import sign
from ai_service.providers import HeuristicProvider, ProviderError
from ai_service.providers.base import Completion

from .conftest import INVOICE_TEXT, SHA, TENANT

TRACE = "4bf92f3577b34da6a3ce929d0e0e4736"
PARENT = "00f067aa0ba902b7"
HEADER = f"00-{TRACE}-{PARENT}-01"
SECRET = "s" * 40
TOKEN = "m" * 40


# ---- traceparent -------------------------------------------------------------


def test_parse_valid_traceparent() -> None:
    assert parse_traceparent(HEADER) == (TRACE, PARENT, True)


def test_parse_unsampled_flag() -> None:
    assert parse_traceparent(f"00-{TRACE}-{PARENT}-00") == (TRACE, PARENT, False)


def test_parse_is_case_insensitive_and_trims() -> None:
    assert parse_traceparent(f"  00-{TRACE.upper()}-{PARENT}-01 ") == (TRACE, PARENT, True)


@pytest.mark.parametrize(
    "header",
    [
        None,
        "",
        "garbage",
        f"ff-{TRACE}-{PARENT}-01",
        f"00-{'0' * 32}-{PARENT}-01",
        f"00-{TRACE}-{'0' * 16}-01",
        f"00-{TRACE}-{PARENT}-01-extra",
        f"00-{TRACE[:-1]}-{PARENT}-01",
        f"00-{TRACE}-{PARENT}-1",
        f"0-{TRACE}-{PARENT}-01",
        f"00-{TRACE}-{PARENT}-01" + "x" * 600,
        f"01-{TRACE}-{PARENT}-01x",
    ],
)
def test_parse_ignores_invalid_headers(header: str | None) -> None:
    assert parse_traceparent(header) is None


def test_future_version_with_extra_fields_is_read() -> None:
    assert parse_traceparent(f"01-{TRACE}-{PARENT}-01-something") == (TRACE, PARENT, True)


def test_start_span_joins_the_callers_trace() -> None:
    ctx = start_span(HEADER)
    assert ctx.trace_id == TRACE
    assert ctx.parent_span_id == PARENT
    assert ctx.span_id != PARENT
    assert re.fullmatch(r"[0-9a-f]{16}", ctx.span_id)
    assert ctx.header() == f"00-{TRACE}-{ctx.span_id}-01"


def test_start_span_without_header_starts_a_new_trace() -> None:
    a, b = start_span(None), start_span("bogus")
    assert a.trace_id != b.trace_id
    assert re.fullmatch(r"[0-9a-f]{32}", a.trace_id)
    assert a.parent_span_id is None
    assert a.sampled


def test_start_span_keeps_the_unsampled_flag() -> None:
    assert start_span(f"00-{TRACE}-{PARENT}-00").header().endswith("-00")


# ---- registry ----------------------------------------------------------------


def test_counter_renders_help_type_and_labels() -> None:
    c = Counter("x_total", "Things.", ("kind",))
    c.inc({"kind": "a"})
    c.inc({"kind": "a"}, 2)
    assert c.render() == ["# HELP x_total Things.", "# TYPE x_total counter", 'x_total{kind="a"} 3']


def test_counter_refuses_negative_and_wrong_labels() -> None:
    c = Counter("x_total", "Things.", ("kind",))
    with pytest.raises(ValueError, match="only go up"):
        c.inc({"kind": "a"}, -1)
    with pytest.raises(ValueError, match="takes labels"):
        c.inc({"other": "a"})
    with pytest.raises(ValueError, match="takes labels"):
        c.inc()


def test_label_values_are_escaped() -> None:
    c = Counter("x_total", "Things.", ("v",))
    c.inc({"v": 'a"b\\c\nd'})
    assert c.render()[-1] == 'x_total{v="a\\"b\\\\c\\nd"} 1'


def test_series_are_capped() -> None:
    c = Counter("x_total", "Things.", ("v",))
    for i in range(MAX_SERIES):
        c.inc({"v": str(i)})
    with pytest.raises(ValueError, match="exceeded"):
        c.inc({"v": "one-too-many"})


def test_invalid_metric_name_is_refused() -> None:
    with pytest.raises(ValueError, match="invalid metric name"):
        Counter("1bad", "x")


def test_gauge_sets_values() -> None:
    g = Gauge("g", "A gauge.")
    g.set(4.5)
    assert g.render()[-1] == "g 4.5"


def test_histogram_is_cumulative_with_sum_and_count() -> None:
    h = Histogram("h_seconds", "Latency.", ("route",), (0.1, 1.0))
    for v in (0.05, 0.5, 5.0):
        h.observe(v, {"route": "/x"})
    h.observe(float("nan"), {"route": "/x"})
    assert h.render()[2:] == [
        'h_seconds_bucket{route="/x",le="0.1"} 1',
        'h_seconds_bucket{route="/x",le="1"} 2',
        'h_seconds_bucket{route="/x",le="+Inf"} 3',
        'h_seconds_sum{route="/x"} 5.55',
        'h_seconds_count{route="/x"} 3',
    ]


@pytest.mark.parametrize("buckets", [(), (1.0, 1.0), (2.0, 1.0)])
def test_histogram_needs_increasing_buckets(buckets: tuple[float, ...]) -> None:
    with pytest.raises(ValueError, match="strictly increasing"):
        Histogram("h", "x", (), buckets)


def test_histogram_reserves_le() -> None:
    with pytest.raises(ValueError, match="reserved"):
        Histogram("h", "x", ("le",), (1.0,))


def test_registry_refuses_duplicates_and_sorts_output() -> None:
    r = Registry()
    r.add(Counter("b_total", "b"))
    r.add(Counter("a_total", "a"))
    with pytest.raises(ValueError, match="already registered"):
        r.add(Counter("a_total", "again"))
    assert r.names() == ["a_total", "b_total"]
    assert r.render().index("a_total") < r.render().index("b_total")
    assert r.render().endswith("\n")


def test_service_metrics_names() -> None:
    assert ServiceMetrics().registry.names() == [
        "invoiceiq_ai_extractions_total",
        "invoiceiq_ai_http_request_duration_seconds",
        "invoiceiq_ai_http_requests_total",
        "invoiceiq_ai_signals_total",
        "invoiceiq_ai_signature_failures_total",
        "process_start_time_seconds",
    ]


@pytest.mark.parametrize(("status", "cls"), [(200, "2xx"), (404, "4xx"), (503, "5xx"), (99, "other")])
def test_status_class(status: int, cls: str) -> None:
    assert status_class(status) == cls


def test_bearer_matches() -> None:
    assert bearer_matches(f"Bearer {TOKEN}", TOKEN)
    assert not bearer_matches(f"Bearer {TOKEN}x", TOKEN)
    assert not bearer_matches(TOKEN, TOKEN)
    assert not bearer_matches(None, TOKEN)


# ---- the app -----------------------------------------------------------------


def _extract(client: TestClient, headers: dict[str, str] | None = None) -> object:
    return client.post(
        "/v1/extract",
        json={"tenantId": TENANT, "documentSha256": SHA, "text": INVOICE_TEXT},
        headers=headers or {},
    )


def test_response_joins_the_callers_trace(client: TestClient) -> None:
    res = client.post(
        "/v1/extract",
        json={"tenantId": TENANT, "documentSha256": SHA, "text": INVOICE_TEXT},
        headers={"traceparent": HEADER},
    )
    assert res.status_code == 200
    assert res.headers["x-trace-id"] == TRACE
    assert re.fullmatch(rf"00-{TRACE}-[0-9a-f]{{16}}-01", res.headers["traceresponse"])
    assert PARENT not in res.headers["traceresponse"]


def test_response_without_traceparent_gets_a_new_trace(client: TestClient) -> None:
    a = client.get("/healthz").headers["x-trace-id"]
    b = client.get("/healthz").headers["x-trace-id"]
    assert a != b


def test_trace_context_does_not_leak_between_requests(client: TestClient) -> None:
    client.get("/healthz", headers={"traceparent": HEADER})
    assert current_trace.get() is None


def test_requests_are_counted_by_route_and_status() -> None:
    stats = ServiceMetrics()
    client = TestClient(create_app(HeuristicProvider(), metrics=stats))
    client.get("/healthz")
    client.get("/healthz")
    client.get("/nope")
    assert stats.requests.get({"method": "GET", "route": "/healthz", "status": "2xx"}) == 2
    assert stats.requests.get({"method": "GET", "route": "unmatched", "status": "4xx"}) == 1
    assert stats.duration.count({"method": "GET", "route": "/healthz"}) == 2


def test_extractions_and_signals_are_counted() -> None:
    stats = ServiceMetrics()
    client = TestClient(create_app(HeuristicProvider(), metrics=stats))
    extraction = client.post(
        "/v1/extract", json={"tenantId": TENANT, "documentSha256": SHA, "text": "Vendor: X\n"}
    ).json()
    client.post("/v1/signals", json={"extraction": extraction, "extractionConfidenceHoldBelow": 0.9})
    assert stats.extractions.get({"provider": "heuristic", "outcome": "ok"}) == 1
    assert stats.signals.get({"reason": "AI_EXTRACTION_LOW_CONFIDENCE"}) == 1


class _Down:
    name = "down"
    model = "none"

    def complete(self, *, task: str, prompt: str) -> Completion:
        raise ProviderError("provider is down")


def test_provider_outage_is_counted() -> None:
    stats = ServiceMetrics()
    client = TestClient(create_app(_Down(), metrics=stats))
    assert _extract(client).status_code == 503  # type: ignore[attr-defined]
    assert stats.extractions.get({"provider": "down", "outcome": "provider_unavailable"}) == 1


def test_signature_failures_are_counted_and_traced() -> None:
    stats = ServiceMetrics()
    client = TestClient(create_app(HeuristicProvider(), signing_secret=SECRET, metrics=stats))
    res = client.post("/v1/signals", json={}, headers={"traceparent": HEADER})
    assert res.status_code == 401
    assert res.headers["x-trace-id"] == TRACE
    assert stats.signature_failures.get() == 1
    assert stats.requests.get({"method": "POST", "route": "/v1/signals", "status": "4xx"}) == 1


def test_metrics_endpoint_renders_prometheus_text(client: TestClient) -> None:
    client.get("/healthz")
    res = client.get("/metrics")
    assert res.status_code == 200
    assert res.headers["content-type"] == PROMETHEUS_CONTENT_TYPE
    assert res.headers["cache-control"] == "no-store"
    assert 'invoiceiq_ai_http_requests_total{method="GET",route="/healthz",status="2xx"} 1' in res.text


def test_metrics_token_is_required_when_set() -> None:
    client = TestClient(create_app(HeuristicProvider(), signing_secret=SECRET, metrics_token=TOKEN))
    refused = client.get("/metrics")
    assert refused.status_code == 401
    assert refused.headers["www-authenticate"] == 'Bearer realm="metrics"'
    assert client.get("/metrics", headers={"authorization": "Bearer wrong"}).status_code == 401
    ok = client.get("/metrics", headers={"authorization": f"Bearer {TOKEN}"})
    assert ok.status_code == 200
    assert "invoiceiq_ai_signature_failures_total" in ok.text


def test_metrics_without_token_needs_a_signature() -> None:
    client = TestClient(create_app(HeuristicProvider(), signing_secret=SECRET))
    assert client.get("/metrics").status_code == 401
    stamp = int(time.time())
    headers = {"x-iiq-timestamp": str(stamp), "x-iiq-signature": sign(SECRET, stamp, "GET", "/metrics", b"")}
    assert client.get("/metrics", headers=headers).status_code == 200


def test_metrics_token_does_not_open_other_routes() -> None:
    client = TestClient(create_app(HeuristicProvider(), signing_secret=SECRET, metrics_token=TOKEN))
    res = _extract(client, {"authorization": f"Bearer {TOKEN}"})
    assert res.status_code == 401  # type: ignore[attr-defined]


def test_request_log_is_json_with_the_trace_id() -> None:
    stream = io.StringIO()
    logger = configure_logging("info", stream)
    client = TestClient(create_app(HeuristicProvider(), logger=logger))
    _extract(client, {"traceparent": HEADER})
    lines = [json.loads(line) for line in stream.getvalue().splitlines()]
    entry = next(e for e in lines if e.get("route") == "/v1/extract")
    assert entry["traceId"] == TRACE
    assert entry["status"] == 200
    assert entry["method"] == "POST"
    assert entry["level"] == "info"
    assert isinstance(entry["ms"], float)


def test_health_checks_are_not_logged() -> None:
    stream = io.StringIO()
    client = TestClient(create_app(HeuristicProvider(), logger=configure_logging("info", stream)))
    client.get("/healthz")
    assert stream.getvalue() == ""


def test_log_level_filters() -> None:
    stream = io.StringIO()
    client = TestClient(create_app(HeuristicProvider(), logger=configure_logging("warning", stream)))
    _extract(client)
    assert stream.getvalue() == ""
    assert logging.getLogger("ai_service").level == logging.WARNING
