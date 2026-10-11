"""Terminal chat front end for the local personal agent.

    python chat.py                 # interactive chat
    python chat.py --ask "..."     # one question, one answer, exit
    python chat.py -y              # auto-approve mutating tool calls
    python chat.py --brief         # write today's briefing and exit

The browser version of the same agent is `webui.py`.
"""

from __future__ import annotations

import argparse
import os
import sys
import textwrap
from pathlib import Path

# Running as "python chat.py" must still find the sibling modules.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import current_model, describe_provider, ensure_dirs, load_config, redact  # noqa: E402
from providers import ProviderError, build_provider  # noqa: E402
from session import ChatSession, preview_arguments, preview_result  # noqa: E402

BANNER = r"""
  ____                                 _   _          _                    _
 |  _ \ ___ _ __ ___  ___  _ __   __ _| | | |   _   _| |__  _   _ ___  ___| |
 | |_) / _ \ '__/ __|/ _ \| '_ \ / _` | | | |  | | | | '_ \| | | / __|/ _ \ |
 |  __/  __/\__ \__ \ (_) | | | | (_| | | | |__| |_| | |_) | |_| \__ \  __/_|
 |_|   \___||___/|___/\___/|_| |_|\__,_|_| |_____\__,_|_.__/ \__,_|___/\___(_)
"""

C_DIM = "\033[90m"
C_TOOL = "\033[36m"
C_OK = "\033[32m"
C_BAD = "\033[31m"
C_WARN = "\033[33m"
C_OFF = "\033[0m"


class Chat:
    def __init__(self, cfg: dict, auto_yes: bool = False, quiet: bool = False):
        self.cfg = cfg
        self.auto_yes = auto_yes
        self.quiet = quiet
        self.pending: list[str] = []
        self.session = ChatSession(
            cfg,
            session_id=cfg.get("_session") or "cli",
            approver=self.approve,
            on_text=self.print_stream,
            on_event=self.on_event,
        )

    # ------------------------------------------------------------- rendering
    def print_stream(self, chunk: str) -> None:
        self.pending.append(chunk)
        sys.stdout.write(chunk)
        sys.stdout.flush()

    def end_stream(self) -> None:
        if self.pending:
            self.pending.clear()
            print()

    def on_event(self, kind: str, payload: dict) -> None:
        if kind == "tool_start":
            self.end_stream()
            name = payload.get("name", "?")
            args = preview_arguments(payload.get("arguments") or {})
            print(f"\n  {C_TOOL}* {name}({args}){C_OFF}")
        elif kind == "tool_end":
            mark = f"{C_OK}ok{C_OFF}" if payload.get("ok") else f"{C_BAD}failed{C_OFF}"
            print(f"    -> {mark}: {preview_result(payload.get('content', ''))}")
        elif kind == "budget_exhausted":
            self.end_stream()
            print(f"\n  {C_WARN}* tool-call budget reached; asking for a best-effort answer{C_OFF}")

    def approve(self, tool_name: str, prompt: str) -> bool:
        self.end_stream()
        if self.auto_yes:
            print(f"\n  {C_WARN}[auto-approved: {tool_name}]{C_OFF}")
            print(textwrap.indent(prompt, "      "))
            return True
        print(f"\n  {C_WARN}--- approval needed ({tool_name}) ---{C_OFF}")
        print(textwrap.indent(prompt, "      "))
        try:
            answer = input("      allow? [y/N] ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            return False
        return answer in {"y", "yes"}

    # ------------------------------------------------------------------ chat
    def start(self) -> int:
        self.splash()
        while True:
            try:
                line = input(f"\n\033[1myou>{C_OFF} ").strip()
            except (EOFError, KeyboardInterrupt):
                print("\nbye.")
                return 0
            if not line:
                continue
            if line.startswith("/"):
                if self.slash(line):
                    return 0
                continue
            self.ask(line)

    def ask(self, message: str) -> None:
        print(f"\n\033[1m{self.cfg['agent'].get('name', 'agent')}>{C_OFF} ", end="")
        self.pending.clear()
        turn = self.session.ask(message, on_text=self.print_stream)
        if turn.reply and not self.pending:
            # Non-streaming path, or a provider that answered in one block.
            print(turn.reply)
        self.end_stream()
        if not self.quiet:
            tools = ", ".join(c["name"] for c in turn.tool_calls) or "none"
            print(
                f"\n  {C_DIM}[{turn.seconds}s | rounds {turn.rounds} | tools: {tools} | "
                f"stop: {turn.stopped_reason}]{C_OFF}"
            )

    def slash(self, line: str) -> bool:
        """Render a shared command result. Returns True when the user wants to quit."""
        result = self.session.handle_command(line)
        if result.text:
            for row in result.text.splitlines() or [""]:
                print(f"  {row}")
        return result.quit

    def splash(self) -> None:
        banner = self.session.banner()
        if not self.quiet:
            print(BANNER)
        print(f"  local personal agent  |  {banner['provider']}")
        print(f"  workspace sandbox    |  {banner['sandbox']}")
        print(f"  memory database      |  {banner['database']}")
        print(f"  tools               |  {', '.join(banner['tools'])}")
        counts = banner["counts"]
        print(
            f"  loaded              |  {counts['memories']} memories, {counts['notes']} notes, "
            f"{counts['messages']} transcript messages"
        )
        print("  /help for commands, /exit to quit   (browser version: python webui.py)")
        if self.cfg["provider"] == "mock":
            print(f"  {C_WARN}note: the mock provider only replays a fixed script.{C_OFF}")

    def close(self) -> None:
        self.session.close()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="chat.py",
        description="Chat with your local personal agent.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent(
            """
            examples:
              python chat.py                                  chat with the defaults from config.json
              python chat.py --ask "what is on my plate today?"
              python chat.py --provider openai --model gpt-4o-mini
              python chat.py --no-shell --no-web               keep it to memory, notes and files
              python chat.py -y                                auto-approve mutating tool calls
            """
        ),
    )
    parser.add_argument("--config", help="path to an alternative config.json")
    parser.add_argument("--provider", choices=["ollama", "openai", "mock"], help="override the model backend")
    parser.add_argument("--model", help="override the model name")
    parser.add_argument("--root", help="override the workspace sandbox folder")
    parser.add_argument("--session", default="cli", help="session name used for transcript history")
    parser.add_argument("--ask", help="ask one question, print the answer, exit")
    parser.add_argument("--brief", action="store_true", help="write today's briefing and exit")
    parser.add_argument("-y", "--yes", action="store_true", help="auto-approve mutating tool calls")
    parser.add_argument("--no-shell", action="store_true", help="disable the run_command tool")
    parser.add_argument("--no-web", action="store_true", help="disable web search and fetch")
    parser.add_argument("--no-memory", action="store_true", help="disable long-term memory writes")
    parser.add_argument("--no-stream", action="store_true", help="wait for the full reply instead of streaming")
    parser.add_argument("-q", "--quiet", action="store_true", help="hide the banner and timing footer")
    return parser.parse_args(argv)


def build_config(args: argparse.Namespace) -> dict:
    overrides: dict = {"_session": args.session}
    if args.provider:
        overrides["provider"] = args.provider
    if args.root:
        overrides["paths"] = {"root": args.root}
    if args.no_shell:
        overrides["shell"] = {"enabled": False}
    if args.no_web:
        overrides["web"] = {"enabled": False}
    if args.no_memory:
        overrides["memory"] = {"enabled": False, "auto_recall": False}
    if args.no_stream:
        overrides["agent"] = {"stream": False}
    cfg = load_config(args.config, overrides)
    if args.model:
        if cfg["provider"] == "mock":
            raise ValueError("--model cannot be combined with --provider mock")
        cfg[cfg["provider"]]["model"] = args.model
    ensure_dirs(cfg)
    return cfg


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        cfg = build_config(args)
    except ValueError as exc:
        print(f"config error: {exc}")
        return 2

    chat = Chat(cfg, auto_yes=args.yes or os.environ.get("PA_AUTO_APPROVE") == "1", quiet=args.quiet)
    try:
        if args.brief:
            from briefing import build_briefing

            build_briefing(cfg, chat.session.store, chat.session.provider, use_model=True, say=print)
            return 0
        if args.ask:
            chat.ask(args.ask)
            return 0
        return chat.start()
    except ProviderError as exc:
        print(f"\nbackend error: {exc}")
        return 1
    finally:
        chat.close()


if __name__ == "__main__":
    raise SystemExit(main())
