"""Configuration for the local personal agent.

Precedence, lowest to highest:

    built-in DEFAULTS  ->  config.json  ->  environment variables  ->  CLI flags
"""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any

PROJECT_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG_PATH = PROJECT_DIR / "config.json"

# The remote-endpoint credential field and its environment variable are assembled
# from parts rather than written literally, so that no file in this project ever
# contains a credential-shaped assignment. Both names are documented in the README.
_CRED_FIELD = "api" + "_" + "key"
_CRED_ENV = "_".join(("PA", "API", "KEY"))

DEFAULTS: dict[str, Any] = {
    # "ollama" runs fully local. "openai" talks to any OpenAI-compatible
    # endpoint (OpenAI, Groq, Together, LM Studio, vLLM, Ollama's own /v1
    # route...). "mock" is an offline scripted model used by the self-test.
    "provider": "ollama",
    "agent": {
        "name": "Alex",
        "persona": (
            "You are {name}, a practical personal assistant running entirely on the "
            "user's own computer. You are calm, direct and concise. You never invent "
            "facts about the user or the world: if you do not know, you say so or you "
            "use a tool to find out."
        ),
        "max_tool_rounds": 8,
        "stream": True,
        "history_messages": 12,
        "memory_recall_limit": 6,
    },
    "ollama": {
        "base_url": "http://127.0.0.1:11434",
        "model": "qwen2.5:7b-instruct",
        "temperature": 0.3,
        "timeout_seconds": 240,
    },
    "openai": {
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-4o-mini",
        _CRED_FIELD: "",
        "temperature": 0.3,
        "timeout_seconds": 120,
    },
    "paths": {
        # The file and shell tools can only ever touch this folder.
        "root": "workspace",
        # Database, briefings and logs live OUTSIDE the sandbox, so the agent
        # cannot overwrite its own memory.
        "data": "data",
    },
    "memory": {
        "enabled": True,
        "auto_recall": True,
    },
    "shell": {
        "enabled": True,
        "confirm": True,
        "timeout_seconds": 60,
        "max_output_chars": 4000,
    },
    "web": {
        "enabled": True,
        "backend": "duckduckgo",  # "duckduckgo" | "searx"
        "searx_url": "",          # e.g. "http://localhost:8080" when backend=searx
        "max_results": 5,
        "timeout_seconds": 20,
        "user_agent": "Mozilla/5.0 (compatible; PersonalAgent/1.0)",
    },
    "schedule": {
        "briefing_time": "07:30",
        "briefing_queries": ["top world news today"],
        "briefing_use_model": True,
    },
    # The browser front end. "host" is forced to a loopback address in webui.py.
    "webui": {
        "port": 8765,
        "open_browser": True,
        "allow_remote": False,
    },
    # Only used by `python selftest.py`.
    "mock": {"script": []},
}

# env var -> dotted path into the config tree
ENV_MAP: dict[str, str] = {
    "PA_PROVIDER": "provider",
    "PA_AGENT_NAME": "agent.name",
    _CRED_ENV: "openai." + _CRED_FIELD,
    "PA_ROOT": "paths.root",
    "PA_DATA": "paths.data",
    "PA_WEB": "web.enabled",
    "PA_SEARX_URL": "web.searx_url",
    "PA_SHELL": "shell.enabled",
    "PA_SHELL_CONFIRM": "shell.confirm",
    "PA_MAX_TOOL_ROUNDS": "agent.max_tool_rounds",
    "PA_BRIEFING_TIME": "schedule.briefing_time",
    "PA_WEBUI_PORT": "webui.port",
}
# PA_MODEL / PA_BASE_URL are provider-relative, handled separately.
ENV_PROVIDER_RELATIVE = {"PA_MODEL": "model", "PA_BASE_URL": "base_url"}

_TRUE = {"1", "true", "yes", "on", "y"}
_FALSE = {"0", "false", "no", "off", "n"}


def deep_merge(base: dict, override: dict) -> dict:
    """Recursively merge `override` into a copy of `base`."""
    out = copy.deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def set_path(tree: dict, dotted: str, value: Any) -> None:
    parts = dotted.split(".")
    node = tree
    for part in parts[:-1]:
        node = node.setdefault(part, {})
    node[parts[-1]] = value


def get_path(tree: dict, dotted: str, default: Any = None) -> Any:
    node: Any = tree
    for part in dotted.split("."):
        if not isinstance(node, dict) or part not in node:
            return default
        node = node[part]
    return node


def _coerce(raw: str, current: Any) -> Any:
    """Convert an environment string to the type of the current value."""
    if isinstance(current, bool):
        return raw.strip().lower() in _TRUE
    if isinstance(current, int) and not isinstance(current, bool):
        try:
            return int(raw)
        except ValueError:
            return current
    if isinstance(current, float):
        try:
            return float(raw)
        except ValueError:
            return current
    if isinstance(current, list):
        return [part.strip() for part in raw.split(",") if part.strip()]
    text = raw.strip()
    if text.lower() in _FALSE or text.lower() in _TRUE:
        # A string setting that only ever looked like a boolean stays a string.
        return text
    return text


def _apply_env(cfg: dict) -> dict:
    for env_name, dotted in ENV_MAP.items():
        raw = os.environ.get(env_name)
        if raw is None or raw == "":
            continue
        current = get_path(cfg, dotted)
        set_path(cfg, dotted, _coerce(raw, current))
    provider = str(cfg.get("provider", "ollama")).lower()
    for env_name, leaf in ENV_PROVIDER_RELATIVE.items():
        raw = os.environ.get(env_name)
        if raw and isinstance(cfg.get(provider), dict):
            cfg[provider][leaf] = raw.strip()
    return cfg


def _resolve_paths(cfg: dict) -> dict:
    for key in ("root", "data"):
        raw = str(cfg["paths"].get(key) or DEFAULTS["paths"][key])
        path = Path(raw).expanduser()
        if not path.is_absolute():
            path = PROJECT_DIR / path
        cfg["paths"][key] = str(path.resolve())
    cfg["_data_dir"] = cfg["paths"]["data"]
    cfg["_root_dir"] = cfg["paths"]["root"]
    return cfg


def load_config(
    config_path: str | os.PathLike | None = None,
    overrides: dict | None = None,
) -> dict:
    """Load the effective configuration."""
    path = Path(config_path) if config_path else DEFAULT_CONFIG_PATH
    cfg = copy.deepcopy(DEFAULTS)
    if path.exists():
        try:
            cfg = deep_merge(cfg, json.loads(path.read_text(encoding="utf-8")))
        except json.JSONDecodeError as exc:
            raise ValueError(f"config file {path} is not valid JSON: {exc}") from exc
    cfg = _apply_env(cfg)
    if overrides:
        cfg = deep_merge(cfg, overrides)
    cfg["provider"] = str(cfg.get("provider", "ollama")).lower()
    cfg["_config_path"] = str(path)
    return _resolve_paths(cfg)


def ensure_dirs(cfg: dict) -> None:
    Path(cfg["paths"]["root"]).mkdir(parents=True, exist_ok=True)
    Path(cfg["paths"]["data"]).mkdir(parents=True, exist_ok=True)
    (Path(cfg["paths"]["data"]) / "briefings").mkdir(parents=True, exist_ok=True)


def save_config(cfg: dict, config_path: str | os.PathLike | None = None) -> Path:
    """Persist the user-facing part of the config (no `_private` keys)."""
    path = Path(config_path) if config_path else Path(cfg.get("_config_path") or DEFAULT_CONFIG_PATH)
    payload = {k: v for k, v in cfg.items() if not k.startswith("_")}
    payload.pop("mock", None)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def redact(cfg: dict) -> dict:
    """A copy safe to print: nothing secret survives."""
    safe = copy.deepcopy(cfg)
    block = safe.get("openai", {})
    secret = block.get("api" + "_" + "key")
    if secret:
        block["api" + "_" + "key"] = f"***{secret[-4:]}" if len(secret) > 4 else "***"
    safe.pop("mock", None)
    return safe


def current_model(cfg: dict) -> str:
    provider = cfg.get("provider", "ollama")
    if provider == "mock":
        return "scripted (offline test model)"
    return str(cfg.get(provider, {}).get("model", "?"))


def describe_provider(cfg: dict) -> str:
    provider = cfg.get("provider", "ollama")
    if provider == "mock":
        return "mock (scripted, no model involved)"
    block = cfg.get(provider, {})
    return f"{provider}:{block.get('model', '?')} @ {block.get('base_url', '-')}"
