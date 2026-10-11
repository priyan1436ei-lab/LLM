"""The agent loop: prompt -> model -> tools -> observation -> ... -> answer."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

from config import describe_provider
from providers import BaseProvider, ProviderError, ToolCall
from store import Store
from tools import ToolResult, Tools


@dataclass
class Turn:
    """Everything that happened while answering one user message."""

    reply: str = ""
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    rounds: int = 0
    seconds: float = 0.0
    stopped_reason: str = "answer"


class Agent:
    def __init__(
        self,
        cfg: dict,
        provider: BaseProvider,
        tools: Tools,
        store: Store,
        session_id: str = "cli",
        on_text: Callable[[str], None] | None = None,
        on_event: Callable[[str, dict], None] | None = None,
    ):
        self.cfg = cfg
        self.provider = provider
        self.tools = tools
        self.store = store
        self.session_id = session_id
        self.on_text = on_text or (lambda _chunk: None)
        self.on_event = on_event or (lambda _kind, _payload: None)

    # ------------------------------------------------------------ prompting
    def system_prompt(self, user_message: str) -> str:
        agent_cfg = self.cfg.get("agent", {})
        name = agent_cfg.get("name", "Alex")
        persona = str(agent_cfg.get("persona", "You are a helpful assistant.")).format(name=name)
        lines = [persona, ""]

        lines.append("## How you work")
        lines.append(
            "- You are running locally on the user's own computer. There is no cloud service behind you.\n"
            "- Use the tools you are given whenever they beat guessing: search your memory before saying you "
            "do not know something about the user; search the web for facts you cannot verify; read a file "
            "before editing it.\n"
            "- Never invent file contents, command output, search results or citations. If a tool fails, say "
            "so plainly and suggest the fix.\n"
            "- Any tool result may start with 'error:' or 'blocked:'. 'blocked:' means the user declined or a "
            "safety rule refused it - do not retry the same call, tell the user instead.\n"
            "- Prefer a short, direct answer. No filler openers like 'Certainly!'."
        )
        lines.append("")

        lines.append("## Environment")
        lines.append(
            f"- Model backend: {describe_provider(self.cfg)}\n"
            f"- Workspace sandbox for files: {self.tools.guard.root}\n"
            f"- Your database: {self.store.path}\n"
            f"- Today: {time.strftime('%A, %d %B %Y')}"
        )
        lines.append("")

        if self.cfg.get("memory", {}).get("auto_recall", True) and user_message.strip():
            recalled = self.store.search_memories(
                user_message, limit=int(self.cfg["agent"].get("memory_recall_limit", 6))
            )
            if recalled:
                lines.append("## Relevant memories about the user")
                for row in recalled:
                    lines.append(
                        f"- [{row['id']}] {row['content']}"
                        + (f"  (tags: {row['tags']})" if row["tags"] else "")
                    )
                lines.append("")
                lines.append(
                    "These were retrieved automatically and may be only loosely related. Use the ones that "
                    "genuinely apply; call search_memory if you need more."
                )
                lines.append("")

        lines.append("## Available tools")
        lines.append(self.tools.describe())
        return "\n".join(lines)

    # ---------------------------------------------------------------- loop
    def ask(self, user_message: str, history: Iterable[dict] | None = None) -> Turn:
        started = time.time()
        messages: list[dict[str, Any]] = [{"role": "system", "content": self.system_prompt(user_message)}]
        for item in history or []:
            if item.get("role") in {"user", "assistant"} and item.get("content"):
                messages.append({"role": item["role"], "content": item["content"]})
        messages.append({"role": "user", "content": user_message})

        self.store.append_message(self.session_id, "user", user_message)

        turn = Turn()
        max_rounds = int(self.cfg.get("agent", {}).get("max_tool_rounds", 8))
        stream = bool(self.cfg.get("agent", {}).get("stream", True))

        for round_index in range(max_rounds):
            turn.rounds = round_index + 1
            self.on_event("model_start", {"round": round_index + 1})
            try:
                reply = self.provider.chat(
                    messages, self.tools.schemas, on_text=self.on_text if stream else None
                )
            except ProviderError as exc:
                turn.stopped_reason = "provider_error"
                turn.reply = (
                    "I could not reach the model backend.\n\n"
                    f"{exc}\n\n"
                    "Nothing was sent anywhere except this endpoint call. "
                    "Fix the backend, or run `python check.py` to diagnose it."
                )
                self.on_event("error", {"message": str(exc)})
                self.store.append_message(self.session_id, "assistant", turn.reply)
                turn.seconds = round(time.time() - started, 2)
                return turn
            self.on_event("model_end", {"text": reply.text, "tool_calls": len(reply.tool_calls)})

            if not reply.tool_calls:
                turn.reply = reply.text.strip()
                turn.stopped_reason = "answer"
                self.store.append_message(self.session_id, "assistant", turn.reply)
                turn.seconds = round(time.time() - started, 2)
                return turn

            messages.append(reply.to_message())
            if reply.text.strip():
                turn.reply = reply.text.strip()

            for call in reply.tool_calls:
                turn.tool_calls.append({"name": call.name, "arguments": call.arguments})
                result = self._run_tool(call)
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.id or f"call_{len(turn.tool_calls)}",
                        "name": call.name,
                        "content": result.content,
                    }
                )

        # Budget exhausted: force a final answer with no tools offered.
        turn.stopped_reason = "tool_budget"
        self.on_event("budget_exhausted", {"rounds": max_rounds})
        messages.append(
            {
                "role": "user",
                "content": (
                    "You have reached the tool-call limit for this turn. Answer now using only what you have "
                    "already learned, and say clearly what is still unknown."
                ),
            }
        )
        try:
            final = self.provider.chat(messages, [], on_text=self.on_text if stream else None)
            turn.reply = final.text.strip()
        except ProviderError as exc:
            turn.reply = f"I ran out of tool calls and could not produce a final answer: {exc}"
        self.store.append_message(self.session_id, "assistant", turn.reply)
        turn.seconds = round(time.time() - started, 2)
        return turn

    def _run_tool(self, call: ToolCall) -> ToolResult:
        self.on_event("tool_start", {"name": call.name, "arguments": call.arguments})
        result = self.tools.call(call.name, call.arguments)
        self.on_event("tool_end", {"name": call.name, "ok": result.ok, "content": result.content})
        return result

    # ------------------------------------------------------------ utilities
    def stats(self) -> dict[str, Any]:
        return {
            "session": self.session_id,
            "provider": describe_provider(self.cfg),
            "tools": len(self.tools.names()),
            **self.store.counts(),
        }


def preview_arguments(arguments: dict[str, Any], limit: int = 160) -> str:
    try:
        text = json.dumps(arguments, ensure_ascii=False)
    except (TypeError, ValueError):
        text = str(arguments)
    return text if len(text) <= limit else text[:limit] + "..."


def preview_result(content: str, limit: int = 240) -> str:
    text = (content or "").strip().replace("\r", "")
    lines = [line for line in text.split("\n") if line.strip()]
    joined = " | ".join(lines[:3])
    return joined if len(joined) <= limit else joined[:limit] + "..."
