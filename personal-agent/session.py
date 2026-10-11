"""One command vocabulary, shared by the terminal and the browser.

`ChatSession` owns everything a front end needs: the store, the tool registry,
the provider, the agent, and the approval decision hook. Put slashes in front of
a line and you get the same behaviour in `chat.py` and `webui.py`.

An approval request is the only thing that needs a front end to be interactive,
so it is exposed as a callback with a payload a browser can render as buttons.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from agent import Agent, Turn, preview_arguments, preview_result
from config import current_model, describe_provider, redact
from providers import BaseProvider, build_provider
from store import Store
from tools import Tools

EventHook = Callable[[str, dict], None]
ApprovalHook = Callable[[str, str], bool]


@dataclass
class CommandResult:
    """What a slash command produced, in a shape both front ends can render."""

    text: str = ""
    kind: str = "info"  # info | error | memory | note | files | tools | config | stats
    quit: bool = False
    data: list[dict[str, Any]] = field(default_factory=list)
    tabled: bool = False  # the text is already aligned for a monospace display


def default_approval(tool_name: str, prompt: str) -> bool:
    """Used when a front end supplies no interactive hook: deny, but say so."""
    return False


class ChatSession:
    def __init__(
        self,
        cfg: dict,
        session_id: str = "cli",
        approver: ApprovalHook | None = None,
        on_text: Callable[[str], None] | None = None,
        on_event: EventHook | None = None,
        provider: BaseProvider | None = None,
    ):
        self.cfg = cfg
        self.session_id = session_id
        self.store = Store(Path(cfg["paths"]["data"]) / "agent.db")
        self._approver = approver or default_approval
        self.approval_count = 0
        self.denial_count = 0
        self.tools = Tools(cfg, self.store, approver=self._guarded_approval)
        self.provider = provider or build_provider(cfg)
        self.agent = Agent(
            cfg,
            self.provider,
            self.tools,
            self.store,
            session_id=session_id,
            on_text=on_text or (lambda _chunk: None),
            on_event=on_event or (lambda _kind, _payload: None),
        )

    # ------------------------------------------------------------- approval
    def _guarded_approval(self, tool_name: str, prompt: str) -> bool:
        self.approval_count += 1
        allowed = bool(self._approver(tool_name, prompt))
        if not allowed:
            self.denial_count += 1
        return allowed

    def set_approver(self, approver: ApprovalHook) -> None:
        self._approver = approver

    # --------------------------------------------------------------- asking
    def history(self) -> list[dict[str, str]]:
        return self.store.recent_messages(
            self.session_id, limit=int(self.cfg["agent"].get("history_messages", 12))
        )

    def ask(
        self,
        message: str,
        on_text: Callable[[str], None] | None = None,
        on_event: EventHook | None = None,
    ) -> Turn:
        """Answer one message. The stream and event hooks are per call, because a
        front end may serve several requests or swap its rendering target."""
        if on_text is not None:
            self.agent.on_text = on_text
        if on_event is not None:
            self.agent.on_event = on_event
        return self.agent.ask(message, history=self.history())

    # ------------------------------------------------------------- commands
    def handle_command(self, line: str) -> CommandResult:
        parts = line[1:].split()
        command = (parts[0] if parts else "").lower()
        rest = parts[1:]

        handler = getattr(self, f"_cmd_{command}", None)
        if handler is None:
            return CommandResult(f"unknown command /{command} - try /help", kind="error")
        return handler(rest)

    def _cmd_help(self, _rest: list[str]) -> CommandResult:
        return CommandResult(
            "\n".join(
                [
                    "/help                     this list",
                    "/memories [n]             what I remember about you",
                    "/forget <id>              deactivate one memory",
                    "/notes [n]                list notes",
                    "/note <id|title>          read one note in full",
                    "/new                      forget this session's transcript (memories stay)",
                    "/tools                    the tools I can call",
                    "/files [path]             browse the workspace sandbox",
                    "/brief [--no-model]       build today's briefing now",
                    "/provider [name]          show or switch backend (ollama|openai|mock)",
                    "/model [name]             show or switch model",
                    "/stats                    counts and current backend",
                    "/config                   effective settings (secrets redacted)",
                    "/exit                     quit",
                ]
            ),
            kind="info",
        )

    def _cmd_memories(self, rest: list[str]) -> CommandResult:
        limit = int(rest[0]) if rest and rest[0].isdigit() else 20
        rows = self.store.list_memories(limit=limit)
        if not rows:
            return CommandResult("nothing saved yet", kind="memory")
        lines = []
        for row in rows:
            tag = f"   tags: {row['tags']}" if row["tags"] else ""
            lines.append(f"[{row['id']}]  {row['content']}{tag}")
        return CommandResult("\n".join(lines), kind="memory", data=rows)

    def _cmd_forget(self, rest: list[str]) -> CommandResult:
        if not rest:
            return CommandResult("usage: /forget <memory_id>", kind="error")
        ok = self.store.forget_memory(rest[0])
        return CommandResult("forgotten." if ok else "no such memory id.", kind="info" if ok else "error")

    def _cmd_notes(self, rest: list[str]) -> CommandResult:
        limit = int(rest[0]) if rest and rest[0].isdigit() else 20
        notes = self.store.list_notes(limit=limit)
        if not notes:
            return CommandResult("no notes yet", kind="note")
        lines = []
        for note in notes:
            lines.append(f"[{note['id']}]  {note['title']}   (updated {note['updated_at']})")
            preview = " ".join((note.get("preview") or "").split())[:110]
            if preview:
                lines.append(f"          {preview}...")
        return CommandResult("\n".join(lines), kind="note", data=notes)

    def _cmd_note(self, rest: list[str]) -> CommandResult:
        if not rest:
            return CommandResult("usage: /note <id|title>", kind="error")
        result = self.tools.tool_read_note(" ".join(rest))
        return CommandResult(result.content, kind="note" if result.ok else "error")

    def _cmd_new(self, _rest: list[str]) -> CommandResult:
        cleared = self.store.clear_session(self.session_id)
        return CommandResult(
            f"cleared {cleared} message(s) from this session; memories and notes are untouched."
        )

    def _cmd_tools(self, _rest: list[str]) -> CommandResult:
        lines = [f"{tool['name']:<15} {tool['description'].splitlines()[0]}" for tool in self.tools.schemas]
        return CommandResult("\n".join(lines), kind="tools", tabled=True,
                             data=[{"name": t["name"], "description": t["description"]} for t in self.tools.schemas])

    def _cmd_files(self, rest: list[str]) -> CommandResult:
        result = self.tools.tool_list_files(" ".join(rest) or ".")
        return CommandResult(result.content, kind="files" if result.ok else "error", tabled=True)

    def _cmd_brief(self, rest: list[str]) -> CommandResult:
        from briefing import build_briefing

        target = build_briefing(
            self.cfg, self.store, self.provider, use_model="--no-model" not in rest, say=lambda _m: None
        )
        return CommandResult(f"briefing written: {target}", kind="info")

    def _cmd_provider(self, rest: list[str]) -> CommandResult:
        if rest:
            name = rest[0].lower()
            if name not in {"ollama", "openai", "mock"}:
                return CommandResult("provider must be ollama, openai or mock", kind="error")
            self.cfg["provider"] = name
            self.provider = build_provider(self.cfg)
            self.agent.provider = self.provider
        return CommandResult(f"provider: {describe_provider(self.cfg)}")

    def _cmd_model(self, rest: list[str]) -> CommandResult:
        if rest:
            provider_name = self.cfg["provider"]
            if provider_name == "mock":
                return CommandResult("the mock provider has no model to set", kind="error")
            self.cfg[provider_name]["model"] = rest[0]
            self.provider = build_provider(self.cfg)
            self.agent.provider = self.provider
        return CommandResult(f"model: {current_model(self.cfg)}")

    def _cmd_stats(self, _rest: list[str]) -> CommandResult:
        lines = [f"{key:<10} {value}" for key, value in self.agent.stats().items()]
        return CommandResult("\n".join(lines), kind="stats", tabled=True)

    def _cmd_config(self, _rest: list[str]) -> CommandResult:
        return CommandResult(
            json.dumps(redact(self.cfg), indent=2, ensure_ascii=False), kind="config", tabled=True
        )

    def _cmd_exit(self, _rest: list[str]) -> CommandResult:
        return CommandResult("bye.", quit=True)

    # ------------------------------------------------------------- lifecycle
    def close(self) -> None:
        self.store.close()

    def banner(self) -> dict[str, Any]:
        return {
            "agent": self.cfg["agent"].get("name", "agent"),
            "provider": describe_provider(self.cfg),
            "model": current_model(self.cfg),
            "sandbox": self.cfg["paths"]["root"],
            "database": str(self.store.path),
            "tools": self.tools.names(),
            "counts": self.store.counts(),
        }


# Both front ends import these so tool activity looks the same everywhere.
__all__ = ["ChatSession", "CommandResult", "preview_arguments", "preview_result"]
