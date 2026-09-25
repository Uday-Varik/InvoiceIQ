from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from ai_service.api import create_app
from ai_service.providers import HeuristicProvider

SHA = "b" * 64
TENANT = "5f0c7d9e-2b1a-4c3d-8e9f-0a1b2c3d4e5f"

INVOICE_TEXT = """ACME Industrial Supply
Vendor: ACME Industrial Supply
Invoice Number: INV-2026-0042
Date: 2026-03-14
Currency: USD
Total: 1,234.50
"""


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(create_app(HeuristicProvider())) as c:
        yield c
