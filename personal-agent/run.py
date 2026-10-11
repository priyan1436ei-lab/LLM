"""One entry point for the personal agent.

    python run.py                 start the web UI (opens a browser)
    python run.py chat            terminal chat
    python run.py ask "question"  one question, one answer
    python run.py check           preflight diagnostics
    python run.py brief           write today's briefing
    python run.py schedule        run the briefing daemon
    python run.py test            the offline self-test
    python run.py doctor          check + test, the "is anything broken" button

Flags after the command are passed straight through, e.g.
    python run.py chat -y --no-web
    python run.py web --port 9000
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

COMMANDS = ("web", "chat", "ask", "check", "brief", "schedule", "test", "doctor", "help")

DESCRIPTIONS = {
    "web": "start the browser chat UI (default)",
    "chat": "terminal chat",
    "ask": "ask one question and print the answer",
    "check": "preflight diagnostics for this machine",
    "brief": "write today's briefing file now",
    "schedule": "run the daily briefing on a timer",
    "test": "offline self-test of the whole agent",
    "doctor": "run check, then test",
    "help": "show this message",
}


def _run(script: str, args: list[str]) -> int:
    """Run a sibling script as a child process so its output streams live."""
    command = [sys.executable, str(HERE / script), *args]
    return subprocess.call(command, cwd=str(HERE))


def _ask(args: list[str]) -> int:
    if not args:
        print('usage: python run.py ask "your question"')
        return 2
    return _run("chat.py", ["--ask", " ".join(args)])


def _help() -> int:
    print(__doc__.strip())
    print("\ncommands:")
    for name in COMMANDS:
        print(f"  {name:<9} {DESCRIPTIONS[name]}")
    print("\nexamples:")
    print('  python run.py                             browser chat with the defaults')
    print('  python run.py chat --no-web -y            terminal, no internet, auto-approve')
    print('  python run.py ask "summarise my notes"')
    print("  python run.py web --port 9000")
    print("  python run.py doctor")
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)

    if argv and argv[0] in {"-h", "--help"}:
        argv[0] = "help"
    if not argv:
        argv = ["web"]
    if argv[0] not in COMMANDS:
        # Nobody types "run.py --ask"; treat an unknown first token that looks like
        # a flag or a free-form question as "just talk to it".
        if argv[0].startswith("-"):
            argv = ["web", *argv]
        else:
            argv = ["ask", *argv]

    command, rest = argv[0], argv[1:]

    if command == "help":
        return _help()
    if command == "web":
        return _run("webui.py", rest)
    if command == "chat":
        return _run("chat.py", rest)
    if command == "ask":
        return _ask(rest)
    if command == "check":
        return _run("check.py", rest)
    if command == "brief":
        return _run("briefing.py", rest)
    if command == "schedule":
        return _run("scheduler.py", rest)
    if command == "test":
        return _run("selftest.py", rest)
    if command == "doctor":
        check_code = _run("check.py", [])
        test_code = _run("selftest.py", rest)
        if check_code == 0 and test_code == 0:
            print("\nEverything is healthy.")
            return 0
        print(
            "\nDoctor found problems. A check.py failure usually just means the model backend "
            "is not running yet ('ollama serve'); a selftest.py failure is a real bug in this code."
        )
        return 1 if test_code else 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
