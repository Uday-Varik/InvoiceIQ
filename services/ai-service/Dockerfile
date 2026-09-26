# ai-service: multi-stage build, non-root runtime, health check. No database
# driver is installed and no DATABASE_URL is passed (ADR-0007). Tesseract and
# Poppler come from Debian's archive for OCR of scans (ADR-0018).
# Build from the repo root: docker build -f services/ai-service/Dockerfile .
ARG PYTHON_IMAGE=python:3.11-slim@sha256:da047cb8f9d1d98e5c070f5300ba9f7274e33b8fc0e5be5ed88740aed1b95ba9

FROM ${PYTHON_IMAGE} AS build
RUN pip install --no-cache-dir uv==0.8.17
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /repo
# Workspace manifests first, so third-party wheels are cached across source changes.
COPY pyproject.toml uv.lock ./
COPY packages/contracts/pyproject.toml packages/contracts/
COPY services/ai-service/pyproject.toml services/ai-service/
COPY data/pyproject.toml data/
RUN uv sync --frozen --no-dev --package invoiceiq-ai-service --no-install-workspace
COPY packages/contracts/generated/python packages/contracts/generated/python
COPY services/ai-service/src services/ai-service/src
RUN uv sync --frozen --no-dev --package invoiceiq-ai-service --no-editable

FROM ${PYTHON_IMAGE} AS runtime
RUN apt-get update \
  && apt-get install --yes --no-install-recommends tesseract-ocr tesseract-ocr-eng poppler-utils \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --no-create-home app
COPY --from=build --chown=app:app /app/.venv /app/.venv
ENV PATH=/app/.venv/bin:$PATH PYTHONUNBUFFERED=1 PORT=8001
WORKDIR /app
USER app
EXPOSE 8001
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('PORT', '8001'), timeout=3)"]
CMD ["sh", "-c", "exec uvicorn ai_service.main:app --host 0.0.0.0 --port \"$PORT\" --proxy-headers --no-server-header"]
