"""Provider credential environment mapping and status summary.

This module reports only whether credential *environment variables* are present.
It never reads, stores, or logs the credential values themselves.
"""

import os

# Provider name -> environment variables that must ALL be present for the
# adapter to be considered "configured". Empty list = no credentials needed.
PROVIDER_CREDENTIAL_ENV: dict[str, list[str]] = {
    "openai": ["OPENAI_API_KEY"],
    "anthropic": ["ANTHROPIC_API_KEY"],
    "gemini": ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    "huggingface": ["HF_TOKEN", "HUGGINGFACE_API_KEY"],
    "ollama": [],
    "custom": [],
    "mock": [],
}

ADAPTER_TYPES = ["openai", "anthropic", "gemini", "huggingface", "ollama", "custom", "mock"]


def provider_is_configured(provider_type: str) -> bool:
    envs = PROVIDER_CREDENTIAL_ENV.get(provider_type)
    if envs is None:
        return False
    return all(os.getenv(name) for name in envs)


def provider_status_summary() -> dict[str, bool]:
    """True = credentials present in the environment (no network call is made)."""
    return {name: provider_is_configured(name) for name in ADAPTER_TYPES}
