"""ASGI entrypoint: `uvicorn ai_service.main:app`."""

from ai_service.api import create_app

app = create_app()
