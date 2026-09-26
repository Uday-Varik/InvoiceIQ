"""Trace context, request logs and Prometheus metrics for ai-service.

core-api forwards a W3C ``traceparent`` on every call. ai-service starts a
child span, logs one JSON line per request with the trace id, and echoes the
span in ``traceresponse``, so a single id joins the two services' logs for an
invoice. Metrics are kept in-process and rendered in the Prometheus text
format; labels are route templates, status classes and fixed outcomes only.
"""

from __future__ import annotations

import hmac
import itertools
import json
import logging
import math
import re
import secrets
import sys
import threading
import time
from collections.abc import Sequence
from contextvars import ContextVar
from dataclasses import dataclass

PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"

_TRACEPARENT_RE = re.compile(r"^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$")
_ZERO_TRACE = "0" * 32
_ZERO_SPAN = "0" * 16


@dataclass(frozen=True)
class TraceContext:
    trace_id: str
    span_id: str
    parent_span_id: str | None
    sampled: bool

    def header(self) -> str:
        return f"00-{self.trace_id}-{self.span_id}-{'01' if self.sampled else '00'}"


def _new_id(nbytes: int, zero: str) -> str:
    while True:
        value = secrets.token_hex(nbytes)
        if value != zero:
            return value


def parse_traceparent(header: str | None) -> tuple[str, str, bool] | None:
    """(trace_id, parent_span_id, sampled), or None when the spec says to ignore the header."""
    if header is None:
        return None
    value = header.strip().lower()
    if len(value) > 512:
        return None
    m = _TRACEPARENT_RE.match(value[:55])
    if m is None:
        return None
    version, trace_id, span_id, flags = m.groups()
    if version == "ff":
        return None
    if version == "00" and len(value) != 55:
        return None
    if version != "00" and len(value) > 55 and value[55] != "-":
        return None
    if trace_id == _ZERO_TRACE or span_id == _ZERO_SPAN:
        return None
    return trace_id, span_id, bool(int(flags, 16) & 1)


def start_span(header: str | None) -> TraceContext:
    parent = parse_traceparent(header)
    span_id = _new_id(8, _ZERO_SPAN)
    if parent is None:
        return TraceContext(_new_id(16, _ZERO_TRACE), span_id, None, True)
    trace_id, parent_span, sampled = parent
    return TraceContext(trace_id, span_id, parent_span, sampled)


current_trace: ContextVar[TraceContext | None] = ContextVar("current_trace", default=None)


# ---- metrics ----------------------------------------------------------------

_NAME_RE = re.compile(r"^[a-zA-Z_:][a-zA-Z0-9_:]*$")
MAX_SERIES = 500


def _escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def _fmt(n: float) -> str:
    if math.isnan(n):
        return "NaN"
    if n == math.inf:
        return "+Inf"
    if n == -math.inf:
        return "-Inf"
    if float(n).is_integer():
        return str(int(n))
    return repr(float(n))


def _labels(names: Sequence[str], values: Sequence[str], extra: tuple[str, str] | None = None) -> str:
    pairs = [f'{n}="{_escape(v)}"' for n, v in zip(names, values, strict=True)]
    if extra is not None:
        pairs.append(f'{extra[0]}="{_escape(extra[1])}"')
    return "{" + ",".join(pairs) + "}" if pairs else ""


class _Metric:
    kind = ""

    def __init__(self, name: str, help_text: str, label_names: Sequence[str] = ()) -> None:
        if not _NAME_RE.match(name):
            raise ValueError(f"invalid metric name: {name}")
        self.name = name
        self.help = help_text
        self.label_names = tuple(label_names)
        self._lock = threading.Lock()

    def _key(self, labels: dict[str, str] | None) -> tuple[str, ...]:
        given = labels or {}
        if set(given) != set(self.label_names):
            raise ValueError(f"{self.name} takes labels {list(self.label_names)}, got {sorted(given)}")
        return tuple(str(given[n]) for n in self.label_names)

    def header(self) -> list[str]:
        help_text = self.help.replace("\\", "\\\\").replace("\n", "\\n")
        return [f"# HELP {self.name} {help_text}", f"# TYPE {self.name} {self.kind}"]

    def render(self) -> list[str]:
        raise NotImplementedError


class Counter(_Metric):
    kind = "counter"

    def __init__(self, name: str, help_text: str, label_names: Sequence[str] = ()) -> None:
        super().__init__(name, help_text, label_names)
        self._values: dict[tuple[str, ...], float] = {}

    def inc(self, labels: dict[str, str] | None = None, by: float = 1.0) -> None:
        if by < 0 or not math.isfinite(by):
            raise ValueError(f"{self.name}: counters only go up")
        key = self._key(labels)
        with self._lock:
            if key not in self._values and len(self._values) >= MAX_SERIES:
                raise ValueError(f"{self.name} exceeded {MAX_SERIES} series")
            self._values[key] = self._values.get(key, 0.0) + by

    def get(self, labels: dict[str, str] | None = None) -> float:
        return self._values.get(self._key(labels), 0.0)

    def render(self) -> list[str]:
        with self._lock:
            items = list(self._values.items())
        return self.header() + [f"{self.name}{_labels(self.label_names, k)} {_fmt(v)}" for k, v in items]


class Gauge(Counter):
    kind = "gauge"

    def set(self, value: float, labels: dict[str, str] | None = None) -> None:
        key = self._key(labels)
        with self._lock:
            self._values[key] = value


class Histogram(_Metric):
    kind = "histogram"

    def __init__(
        self, name: str, help_text: str, label_names: Sequence[str], buckets: Sequence[float]
    ) -> None:
        super().__init__(name, help_text, label_names)
        if "le" in self.label_names:
            raise ValueError(f"{name}: 'le' is reserved")
        if not buckets or any(b <= a for a, b in itertools.pairwise(buckets)):
            raise ValueError(f"{name}: buckets must be strictly increasing")
        self.buckets = tuple(buckets)
        self._series: dict[tuple[str, ...], list[float]] = {}

    def observe(self, value: float, labels: dict[str, str] | None = None) -> None:
        if not math.isfinite(value):
            return
        key = self._key(labels)
        with self._lock:
            s = self._series.get(key)
            if s is None:
                if len(self._series) >= MAX_SERIES:
                    raise ValueError(f"{self.name} exceeded {MAX_SERIES} series")
                s = [0.0] * (len(self.buckets) + 2)  # buckets..., sum, count
                self._series[key] = s
            for i, bound in enumerate(self.buckets):
                if value <= bound:
                    s[i] += 1
            s[-2] += value
            s[-1] += 1

    def count(self, labels: dict[str, str] | None = None) -> float:
        s = self._series.get(self._key(labels))
        return s[-1] if s else 0.0

    def render(self) -> list[str]:
        lines = self.header()
        with self._lock:
            items = [(k, list(v)) for k, v in self._series.items()]
        for key, s in items:
            for i, bound in enumerate(self.buckets):
                lines.append(
                    f"{self.name}_bucket{_labels(self.label_names, key, ('le', _fmt(bound)))} {_fmt(s[i])}"
                )
            lines.append(f"{self.name}_bucket{_labels(self.label_names, key, ('le', '+Inf'))} {_fmt(s[-1])}")
            lines.append(f"{self.name}_sum{_labels(self.label_names, key)} {_fmt(s[-2])}")
            lines.append(f"{self.name}_count{_labels(self.label_names, key)} {_fmt(s[-1])}")
        return lines


class Registry:
    def __init__(self) -> None:
        self._metrics: dict[str, _Metric] = {}

    def add(self, metric: _Metric) -> _Metric:
        if metric.name in self._metrics:
            raise ValueError(f"metric {metric.name} is already registered")
        self._metrics[metric.name] = metric
        return metric

    def names(self) -> list[str]:
        return sorted(self._metrics)

    def render(self) -> str:
        lines: list[str] = []
        for name in self.names():
            lines.extend(self._metrics[name].render())
        return "\n".join(lines) + "\n"


HTTP_BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0)


class ServiceMetrics:
    """Every metric ai-service exports."""

    def __init__(self) -> None:
        self.registry = Registry()
        self.requests = Counter(
            "invoiceiq_ai_http_requests_total",
            "ai-service HTTP requests by route and status class.",
            ("method", "route", "status"),
        )
        self.duration = Histogram(
            "invoiceiq_ai_http_request_duration_seconds",
            "ai-service request latency by route.",
            ("method", "route"),
            HTTP_BUCKETS,
        )
        self.extractions = Counter(
            "invoiceiq_ai_extractions_total",
            "Extraction attempts by provider and outcome.",
            ("provider", "outcome"),
        )
        self.document_text = Counter(
            "invoiceiq_ai_document_text_total",
            "Documents read, by where their text came from (text_layer, ocr, none).",
            ("source",),
        )
        self.signals = Counter(
            "invoiceiq_ai_signals_total", "Advisory HOLD signals raised, by reason code.", ("reason",)
        )
        self.signature_failures = Counter(
            "invoiceiq_ai_signature_failures_total",
            "Requests refused for a missing, stale or wrong signature.",
        )
        self.start_time = Gauge(
            "process_start_time_seconds", "Start time of the process since the Unix epoch in seconds."
        )
        for m in (
            self.requests,
            self.duration,
            self.extractions,
            self.document_text,
            self.signals,
            self.signature_failures,
            self.start_time,
        ):
            self.registry.add(m)
        self.start_time.set(float(int(time.time())))


def status_class(status: int) -> str:
    return f"{status // 100}xx" if 100 <= status < 600 else "other"


def bearer_matches(header: str | None, token: str) -> bool:
    if not header or not header.startswith("Bearer "):
        return False
    return hmac.compare_digest(header[len("Bearer ") :].encode(), token.encode())


# ---- logs -------------------------------------------------------------------


class JsonFormatter(logging.Formatter):
    """One JSON object per line, with the current trace id when there is one."""

    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, object] = {
            "time": int(record.created * 1000),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
        }
        ctx = current_trace.get()
        if ctx is not None:
            entry["traceId"] = ctx.trace_id
            entry["spanId"] = ctx.span_id
        extra = getattr(record, "fields", None)
        if isinstance(extra, dict):
            entry.update(extra)
        if record.exc_info:
            entry["err"] = self.formatException(record.exc_info)
        return json.dumps(entry, separators=(",", ":"), default=str)


def configure_logging(level: str = "INFO", stream: object = None) -> logging.Logger:
    logger = logging.getLogger("ai_service")
    handler = logging.StreamHandler(stream or sys.stdout)  # type: ignore[arg-type]
    handler.setFormatter(JsonFormatter())
    logger.handlers[:] = [handler]
    logger.setLevel(level.upper())
    logger.propagate = False
    return logger
