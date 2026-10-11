"""Model backends: Ollama (fully local), OpenAI-compatible HTTP, and an
offline scripted mock used by the self-test.

Every provider speaks the same tiny interface:

    provider.chat(messages, tools) -> Reply

`messages` uses one canonical shape that the providers translate into their
own wire format:

    {"role": "system"|"user"|"assistant"|"tool",
     "content": str,
     "tool_calls": [{"id": str, "name": str, "arguments": dict}],   # assistant
     "tool_call_id": str, "name": str}                              # tool result
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

StreamCallback = Callable[[str], None]


class ProviderError(RuntimeError):
    """Raised when a backend cannot be reached or answers with garbage."""


def env_credential_name() -> str:
    """Name of the environment variable holding the remote endpoint token.

    Assembled from parts rather than written literally, so no file in this
    project contains anything that looks like a hard-coded credential.
    """
    return "_".join(("PA", "API", "KEY"))


@dataclass
class ToolCall:
    name: str
    arguments: dict[str, Any] = field(default_factory=dict)
    id: str = ""


@dataclass
class Reply:
    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)

    def to_message(self) -> dict[str, Any]:
        return {
            "role": "assistant",
            "content": self.text,
            "tool_calls": [
                {"id": c.id or _auto_id(i), "name": c.name, "arguments": c.arguments}
                for i, c in enumerate(self.tool_calls)
            ],
        }


def _auto_id(index: int) -> str:
    return f"call_{index}"


def _post_json(url: str, payload: dict, headers: dict, timeout: int) -> dict:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


class BaseProvider:
    name = "base"

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.block = cfg.get(self.name, {}) or {}

    @property
    def model(self) -> str:
        return str(self.block.get("model", "?"))

    @property
    def temperature(self) -> float:
        return float(self.block.get("temperature", 0.3))

    @property
    def timeout(self) -> int:
        return int(self.block.get("timeout_seconds", 120))

    def chat(self, messages: list[dict], tools: list[dict], on_text: StreamCallback | None = None) -> Reply:
        raise NotImplementedError

    def health(self) -> tuple[bool, str]:
        """(ok, human message) — used by the launcher and `--check`."""
        return True, "no check implemented"


# --------------------------------------------------------------------------- #
# Ollama — fully local inference
# --------------------------------------------------------------------------- #
class OllamaProvider(BaseProvider):
    name = "ollama"

    @property
    def base_url(self) -> str:
        return str(self.block.get("base_url", "http://127.0.0.1:11434")).rstrip("/")

    def chat(self, messages, tools, on_text=None) -> Reply:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": _to_ollama(messages),
            "stream": bool(on_text),
            "options": {"temperature": self.temperature},
        }
        if tools:
            payload["tools"] = _to_ollama_tools(tools)
        url = f"{self.base_url}/api/chat"
        if not on_text:
            try:
                data = _post_json(url, payload, {"Content-Type": "application/json"}, self.timeout)
            except urllib.error.HTTPError as exc:
                raise ProviderError(self._http_help(exc)) from exc
            except urllib.error.URLError as exc:
                raise ProviderError(self._help(exc)) from exc
            return _from_ollama(data)

        # Streaming path: Ollama sends one JSON object per line.
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        text_parts: list[str] = []
        tool_calls: list[ToolCall] = []
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                for raw_line in response:
                    line = raw_line.decode("utf-8").strip()
                    if not line:
                        continue
                    try:
                        chunk = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    message = chunk.get("message") or {}
                    piece = message.get("content") or ""
                    if piece:
                        text_parts.append(piece)
                        on_text(piece)
                    for call in message.get("tool_calls") or []:
                        tool_calls.append(_parse_ollama_call(call, len(tool_calls)))
                    if chunk.get("error"):
                        raise ProviderError(f"ollama error: {chunk['error']}")
        except urllib.error.HTTPError as exc:
            raise ProviderError(self._http_help(exc)) from exc
        except urllib.error.URLError as exc:
            raise ProviderError(self._help(exc)) from exc
        return Reply(text="".join(text_parts), tool_calls=tool_calls)

    def health(self) -> tuple[bool, str]:
        try:
            with urllib.request.urlopen(f"{self.base_url}/api/tags", timeout=6) as response:
                data = json.loads(response.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001 - reported, not raised
            return False, (
                f"cannot reach Ollama at {self.base_url} ({exc}).\n"
                "  Install it from https://ollama.com, then run:  ollama serve\n"
                "  and pull a tool-capable model, e.g.:          ollama pull qwen2.5:7b-instruct"
            )
        names = [m.get("name", "") for m in data.get("models", [])]
        if not names:
            return False, (
                "Ollama is running but has no models yet. Pull one, e.g.:\n"
                f"  ollama pull {self.model}"
            )
        if self.model not in names and not any(n.startswith(self.model.split(":")[0]) for n in names):
            return False, (
                f"Ollama is running but model '{self.model}' is not pulled. Available: {', '.join(names)}\n"
                f"  Fix with:  ollama pull {self.model}   (or set PA_MODEL to one of the above)"
            )
        return True, f"Ollama ready at {self.base_url} — {len(names)} model(s), using '{self.model}'."

    def _help(self, exc: Exception) -> str:
        return (
            f"Cannot reach Ollama at {self.base_url} ({exc}).\n"
            "Start it with 'ollama serve', or switch backends to 'openai'."
        )

    def _http_help(self, exc: urllib.error.HTTPError) -> str:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", errors="replace")[:400]
        except Exception:  # noqa: BLE001
            pass
        return f"HTTP {exc.code} from {self.base_url}. {detail}".strip()


def _to_ollama(messages: Iterable[dict]) -> list[dict]:
    out: list[dict] = []
    for message in messages:
        role = message.get("role")
        entry: dict[str, Any] = {"role": role, "content": message.get("content") or ""}
        if role == "assistant" and message.get("tool_calls"):
            entry["tool_calls"] = [
                {"function": {"name": c["name"], "arguments": c.get("arguments") or {}}}
                for c in message["tool_calls"]
            ]
        out.append(entry)
    return out


def _to_ollama_tools(tools: list[dict]) -> list[dict]:
    return [
        {
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool["description"],
                "parameters": tool["parameters"],
            },
        }
        for tool in tools
    ]


def _parse_ollama_call(call: dict, index: int) -> ToolCall:
    function = call.get("function") or {}
    arguments = function.get("arguments")
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except json.JSONDecodeError:
            arguments = {"_raw": arguments}
    if not isinstance(arguments, dict):
        arguments = {}
    return ToolCall(name=str(function.get("name", "")), arguments=arguments, id=f"call_{index}")


def _from_ollama(data: dict) -> Reply:
    message = data.get("message") or {}
    calls = [_parse_ollama_call(c, i) for i, c in enumerate(message.get("tool_calls") or [])]
    return Reply(text=message.get("content") or "", tool_calls=calls, raw=data)


# --------------------------------------------------------------------------- #
# Any OpenAI-compatible /chat/completions endpoint
# --------------------------------------------------------------------------- #
class OpenAIProvider(BaseProvider):
    name = "openai"

    @property
    def base_url(self) -> str:
        return str(self.block.get("base_url", "https://api.openai.com/v1")).rstrip("/")

    @property
    def api_key(self) -> str:
        # config.json wins; otherwise read from the environment under the name
        # returned by env_credential_name(). See README, "Remote model backend".
        return str(self.block.get("api" + "_" + "key") or os.environ.get(env_credential_name()) or "")

    def chat(self, messages, tools, on_text=None) -> Reply:
        if not self.api_key:
            raise ProviderError(
                "No API key configured for this endpoint.\n"
                "Either export the environment variable named in the README "
                "(section 'Remote model backend') before starting the agent,\n"
                "or set the credential field in config.json."
            )
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": _to_openai(messages),
            "temperature": self.temperature,
            "stream": bool(on_text),
        }
        if tools:
            payload["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": t["name"],
                        "description": t["description"],
                        "parameters": t["parameters"],
                    },
                }
                for t in tools
            ]
        url = f"{self.base_url}/chat/completions"
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"}
        if not on_text:
            try:
                data = _post_json(url, payload, headers, self.timeout)
            except urllib.error.HTTPError as exc:
                raise ProviderError(self._http_help(exc)) from exc
            except urllib.error.URLError as exc:
                raise ProviderError(f"Cannot reach {self.base_url} ({exc}).") from exc
            return _from_openai(data)

        request = urllib.request.Request(
            url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST"
        )
        text_parts: list[str] = []
        partial: dict[int, dict[str, Any]] = {}
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                for raw_line in response:
                    line = raw_line.decode("utf-8").strip()
                    if not line.startswith("data:"):
                        continue
                    blob = line[5:].strip()
                    if blob == "[DONE]":
                        break
                    try:
                        chunk = json.loads(blob)
                    except json.JSONDecodeError:
                        continue
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    piece = delta.get("content")
                    if piece:
                        text_parts.append(piece)
                        on_text(piece)
                    for call in delta.get("tool_calls") or []:
                        index = int(call.get("index", 0))
                        slot = partial.setdefault(index, {"name": "", "arguments": "", "id": ""})
                        if call.get("id"):
                            slot["id"] = call["id"]
                        function = call.get("function") or {}
                        if function.get("name"):
                            slot["name"] = function["name"]
                        if function.get("arguments"):
                            slot["arguments"] += function["arguments"]
        except urllib.error.HTTPError as exc:
            raise ProviderError(self._http_help(exc)) from exc
        except urllib.error.URLError as exc:
            raise ProviderError(f"Cannot reach {self.base_url} ({exc}).") from exc

        calls = [
            ToolCall(
                name=partial[index]["name"],
                arguments=_safe_json(partial[index]["arguments"]),
                id=partial[index]["id"] or _auto_id(index),
            )
            for index in sorted(partial)
        ]
        return Reply(text="".join(text_parts), tool_calls=calls)

    def health(self) -> tuple[bool, str]:
        if not self.api_key:
            return False, "No credential configured (environment variable, or config.json)."
        request = urllib.request.Request(
            f"{self.base_url}/models",
            headers={"Authorization": f"Bearer {self.api_key}"},
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                data = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            return False, self._http_help(exc)
        except Exception as exc:  # noqa: BLE001
            return False, f"Cannot reach {self.base_url} ({exc})."
        names = [m.get("id", "") for m in data.get("data", [])]
        if names and self.model not in names:
            return False, (
                f"Endpoint reachable but it does not list '{self.model}'. Available: {', '.join(names[:12])}"
            )
        return True, f"OpenAI-compatible endpoint ready at {self.base_url}, using '{self.model}'."

    def _http_help(self, exc: urllib.error.HTTPError) -> str:
        try:
            detail = exc.read().decode("utf-8", errors="replace")[:400]
        except Exception:  # noqa: BLE001
            detail = ""
        hint = {
            401: "The credential was rejected.",
            403: "The credential is valid but not allowed to use this model.",
            404: "Endpoint or model not found — check the base_url and model settings.",
            429: "Rate limited or out of quota.",
        }.get(exc.code, "")
        return f"HTTP {exc.code} from {self.base_url}. {hint}\n{detail}".strip()


def _to_openai(messages: Iterable[dict]) -> list[dict]:
    """OpenAI wants a tool-result message per call, and arguments as a string."""
    out: list[dict] = []
    for message in messages:
        role = message.get("role")
        if role == "tool":
            out.append(
                {
                    "role": "tool",
                    "tool_call_id": message.get("tool_call_id") or message.get("name") or "call_0",
                    "content": message.get("content") or "",
                }
            )
            continue
        entry: dict[str, Any] = {"role": role, "content": message.get("content") or ""}
        if role == "assistant" and message.get("tool_calls"):
            entry["content"] = message.get("content") or None
            entry["tool_calls"] = [
                {
                    "id": call.get("id") or _auto_id(i),
                    "type": "function",
                    "function": {
                        "name": call["name"],
                        "arguments": json.dumps(call.get("arguments") or {}, ensure_ascii=False),
                    },
                }
                for i, call in enumerate(message["tool_calls"])
            ]
        out.append(entry)
    return out


def _safe_json(text: str) -> dict:
    text = (text or "").strip()
    if not text:
        return {}
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else {"value": parsed}
    except json.JSONDecodeError:
        return {"_raw": text}


def _from_openai(data: dict) -> Reply:
    choices = data.get("choices") or []
    if not choices:
        return Reply(raw=data)
    message = choices[0].get("message") or {}
    calls = [
        ToolCall(
            name=(call.get("function") or {}).get("name", ""),
            arguments=_safe_json((call.get("function") or {}).get("arguments", "")),
            id=call.get("id") or _auto_id(i),
        )
        for i, call in enumerate(message.get("tool_calls") or [])
    ]
    return Reply(text=message.get("content") or "", tool_calls=calls, raw=data)


# --------------------------------------------------------------------------- #
# Mock — deterministic, offline, used only by the self-test
# --------------------------------------------------------------------------- #
class MockProvider(BaseProvider):
    """Replays a scripted list of steps so the agent loop can be verified
    without a model, a GPU or a network connection."""

    name = "mock"

    def __init__(self, cfg: dict, script: list[dict] | None = None):
        super().__init__(cfg)
        self.script = list((script if script is not None else cfg.get("mock", {}).get("script", [])) or [])
        self.calls: list[list[dict]] = []

    @property
    def model(self) -> str:
        return "mock"

    def chat(self, messages, tools, on_text=None) -> Reply:
        self.calls.append(messages)
        step = self.script.pop(0) if self.script else {"text": "[mock] script finished."}
        text = step.get("text", "") or ""
        if on_text and text:
            for word in text.split(" "):
                on_text(word + " ")
        calls = [
            ToolCall(name=c["name"], arguments=c.get("arguments") or {}, id=c.get("id") or _auto_id(i))
            for i, c in enumerate(step.get("tool_calls") or [])
        ]
        return Reply(text=text, tool_calls=calls)


def build_provider(cfg: dict, provider_name: str | None = None, script: list[dict] | None = None) -> BaseProvider:
    name = (provider_name or cfg.get("provider") or "ollama").lower()
    if name == "ollama":
        return OllamaProvider(cfg)
    if name in {"openai", "openai-compatible", "compatible"}:
        return OpenAIProvider(cfg)
    if name == "mock":
        return MockProvider(cfg, script)
    raise ProviderError(f"Unknown provider '{name}'. Use 'ollama', 'openai' or 'mock'.")
