"""Provider adapters. Each real adapter imports its SDK only when it makes its first call."""

from assistant.ai.adapters.anthropic_adapter import AnthropicAdapter
from assistant.ai.adapters.base import ProviderAdapter, strict_json_schema
from assistant.ai.adapters.fake import FakeAdapter
from assistant.ai.adapters.gemini_adapter import GeminiAdapter
from assistant.ai.adapters.openai_adapter import GroqAdapter, OpenAIAdapter
from assistant.config import Settings


def build_adapters(settings: Settings) -> dict[str, ProviderAdapter]:
    """Real adapters for providers that have a key. Keys stay inside the SDK clients."""
    keys = {
        "anthropic": (AnthropicAdapter, settings.anthropic_api_key),
        "openai": (OpenAIAdapter, settings.openai_api_key),
        "google": (GeminiAdapter, settings.google_api_key),
        "groq": (GroqAdapter, settings.groq_api_key),
    }
    out: dict[str, ProviderAdapter] = {}
    for name, (cls, secret) in keys.items():
        key = secret.get_secret_value()
        if not key:
            continue
        if cls is GeminiAdapter:
            out[name] = GeminiAdapter(key, thinking=settings.ai_gemini_thinking)
        else:
            out[name] = cls(key)
    return out


__all__ = [
    "AnthropicAdapter", "FakeAdapter", "GeminiAdapter", "GroqAdapter", "OpenAIAdapter",
    "ProviderAdapter", "build_adapters", "strict_json_schema",
]  # fmt: skip
