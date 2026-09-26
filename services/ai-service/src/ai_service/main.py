"""ASGI entrypoint: `uvicorn ai_service.main:app`.

AI_SIGNING_SECRET must be set so only core-api can call the service. Leaving it
unset is refused unless AI_ALLOW_UNSIGNED=1, which is meant for local work only.
METRICS_TOKEN (at least 32 characters) lets Prometheus scrape /metrics.
LOG_LEVEL sets the JSON request log level (default info).
"""

import os

from ai_service.api import create_app
from ai_service.api.observability import configure_logging


def _signing_secret() -> str | None:
    secret = os.environ.get("AI_SIGNING_SECRET", "")
    if secret:
        if len(secret) < 32:
            raise RuntimeError("AI_SIGNING_SECRET must be at least 32 characters")
        return secret
    if os.environ.get("AI_ALLOW_UNSIGNED") == "1":
        return None
    raise RuntimeError("AI_SIGNING_SECRET is required (set AI_ALLOW_UNSIGNED=1 for local development only)")


def _metrics_token() -> str | None:
    token = os.environ.get("METRICS_TOKEN", "")
    if token and len(token) < 32:
        raise RuntimeError("METRICS_TOKEN must be at least 32 characters")
    return token or None


app = create_app(
    signing_secret=_signing_secret(),
    metrics_token=_metrics_token(),
    logger=configure_logging(os.environ.get("LOG_LEVEL", "info")),
)
