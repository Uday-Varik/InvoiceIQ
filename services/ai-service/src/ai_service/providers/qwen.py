"""Qwen provider via Together.ai API."""

from __future__ import annotations

import json
import urllib.error
import urllib.request

from ai_service.providers.base import Completion, ProviderError


class QwenProvider:
    """Qwen extraction via Together.ai."""

    name = "qwen"
    _model = "qwen/qwen3.8-27b:free"
    _api_base = "https://api.together.xyz/v1"

    def __init__(self, api_key: str) -> None:
        """Initialize with Together.ai API key.

        Args:
            api_key: Together.ai API key.

        Raises:
            ProviderError: If the API key is invalid or missing.
        """
        if not api_key or not api_key.strip():
            raise ProviderError("QWEN_API_KEY is empty")
        self._api_key = api_key

    def complete(self, *, task: str, prompt: str) -> Completion:
        """Call Qwen via Together.ai to extract invoice fields.

        Args:
            task: Task identifier (for logging/tracing).
            prompt: The prompt text to send to the model.

        Returns:
            Completion with provider name, model, and extracted JSON.

        Raises:
            ProviderError: If the API call fails.
        """
        payload = {
            "model": self._model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 2048,
            "temperature": 0.1,  # Low temp for structured extraction
        }

        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }

        req = urllib.request.Request(  # noqa: S310
            f"{self._api_base}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=60) as response:  # noqa: S310
                data = json.loads(response.read().decode("utf-8"))
        except (urllib.error.HTTPError, urllib.error.URLError) as exc:
            raise ProviderError(f"together.ai API error: {exc}") from exc
        except json.JSONDecodeError as exc:
            raise ProviderError(f"together.ai returned invalid JSON: {exc}") from exc

        # Extract the completion text
        try:
            message = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ProviderError(f"unexpected response structure: {exc}") from exc

        return Completion(provider=self.name, model=self._model, text=message)
