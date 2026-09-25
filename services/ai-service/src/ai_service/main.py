"""ASGI entrypoint: `uvicorn ai_service.main:app`.

AI_SIGNING_SECRET must be set so only core-api can call the service. Leaving it
unset is refused unless AI_ALLOW_UNSIGNED=1, which is meant for local work only.
"""

import os

from ai_service.api import create_app


def _signing_secret() -> str | None:
    secret = os.environ.get("AI_SIGNING_SECRET", "")
    if secret:
        if len(secret) < 32:
            raise RuntimeError("AI_SIGNING_SECRET must be at least 32 characters")
        return secret
    if os.environ.get("AI_ALLOW_UNSIGNED") == "1":
        return None
    raise RuntimeError("AI_SIGNING_SECRET is required (set AI_ALLOW_UNSIGNED=1 for local development only)")


app = create_app(signing_secret=_signing_secret())
