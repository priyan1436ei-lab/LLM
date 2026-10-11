"""Local web UI for the personal agent.

    python webui.py                 # serve on http://127.0.0.1:8765 and open a browser
    python webui.py --port 9000     # different port
    python webui.py --no-browser    # just serve
    python webui.py -y              # auto-approve mutating tool calls

Everything is one self-contained HTML page: no CDN, no fonts, no build step, and
no network access other than the loopback socket you are already talking to. The
page is inert until it presents a per-launch random session code, which keeps
other local pages and processes out of your agent's memory and shell.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import queue
import secrets
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import current_model, describe_provider, ensure_dirs, load_config  # noqa: E402
from session import ChatSession  # noqa: E402

SESSION_HEADER = "X-Agent-Session"
CODE_PLACEHOLDER = "__SESSION_CODE__"
APPROVAL_TIMEOUT_SECONDS = 600


# --------------------------------------------------------------------------- #
# Bridge between the agent (a worker thread) and the browser stream
# --------------------------------------------------------------------------- #
class UiBridge:
    """Turns agent callbacks into a stream of events, and turns a tool approval
    into a question the browser can answer."""

    def __init__(self) -> None:
        self.queue: queue.Queue[tuple[str, dict]] = queue.Queue()
        self.lock = threading.Lock()
        self.pending: dict[int, threading.Event] = {}
        self.decisions: dict[int, bool] = {}
        self.request_counter = 0

    # ---- agent -> browser
    def emit(self, kind: str, payload: dict[str, Any] | None = None) -> None:
        self.queue.put((kind, payload or {}))

    def text(self, chunk: str) -> None:
        self.emit("token", {"text": chunk})

    def on_event(self, kind: str, payload: dict) -> None:
        # Only user-visible activity is forwarded. model_start / model_end are
        # internal bookkeeping, and the streamed text already covers model output.
        if kind in {"tool_start", "tool_end", "error"}:
            self.emit(kind, payload)
        elif kind == "budget_exhausted":
            self.emit("budget", payload)

    # ---- browser -> agent
    def approve(self, tool_name: str, prompt: str) -> bool:
        with self.lock:
            self.request_counter += 1
            request_id = self.request_counter
            event = threading.Event()
            self.pending[request_id] = event
        self.emit("approval_request", {"id": request_id, "tool": tool_name, "prompt": prompt})
        answered = event.wait(timeout=APPROVAL_TIMEOUT_SECONDS)
        with self.lock:
            allowed = self.decisions.pop(request_id, False)
            self.pending.pop(request_id, None)
        if not answered:
            self.emit("approval_timeout", {"id": request_id})
            return False
        self.emit("approval_result", {"id": request_id, "allowed": allowed})
        return allowed

    def resolve(self, request_id: int, allowed: bool) -> bool:
        with self.lock:
            event = self.pending.get(request_id)
            if event is None:
                return False
            self.decisions[request_id] = allowed
        event.set()
        return True

    def finish(self) -> None:
        self.emit("__end__", {})


# --------------------------------------------------------------------------- #
# HTTP surface
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PersonalAgentUI"

    def log_message(self, _format, *_args):  # keep the console readable
        pass

    def _authorised(self) -> bool:
        expected: str = self.server.session_code  # type: ignore[attr-defined]
        supplied = self.headers.get(SESSION_HEADER) or ""
        if not supplied:
            supplied = parse_qs(urlparse(self.path).query).get("code", [""])[0]
        return secrets.compare_digest(supplied, expected)

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, payload: dict, status: int = 200) -> None:
        self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _error(self, status: int, message: str) -> None:
        self._json({"error": message}, status=status)

    # -- routes -----------------------------------------------------------
    def do_GET(self):  # noqa: N802 - required by BaseHTTPRequestHandler
        path = urlparse(self.path).path
        if path in {"/", "/index.html"}:
            page = APP_HTML.replace(CODE_PLACEHOLDER, self.server.session_code)  # type: ignore[attr-defined]
            self._send(200, page.encode("utf-8"), "text/html; charset=utf-8")
            return
        if path == "/favicon.ico":
            self._send(204, b"", "image/x-icon")
            return

        if not path.startswith("/api/"):
            self._error(404, f"no such path: {path}")
            return
        if not self._authorised():
            self._error(403, "missing or wrong session code")
            return

        session: ChatSession = self.server.session  # type: ignore[attr-defined]
        if path == "/api/state":
            self._json({
                "banner": session.banner(),
                "tools": session.tools.schemas,
                "provider": describe_provider(session.cfg),
                "model": current_model(session.cfg),
                "settings": {
                    "shell_enabled": bool(session.cfg.get("shell", {}).get("enabled", True)),
                    "shell_confirm": bool(session.cfg.get("shell", {}).get("confirm", True)),
                    "web_enabled": bool(session.cfg.get("web", {}).get("enabled", True)),
                    "memory_enabled": bool(session.cfg.get("memory", {}).get("enabled", True)),
                },
            })
            return
        if path == "/api/history":
            self._json({"messages": session.history()})
            return
        if path == "/api/chat":
            self._chat_stream(session)
            return
        self._error(404, f"no such api path: {path}")

    def do_HEAD(self):  # noqa: N802
        self.do_GET()

    def do_POST(self):  # noqa: N802
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            self._error(404, f"no such path: {path}")
            return
        if not self._authorised():
            self._error(403, "missing or wrong session code")
            return

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self._error(400, "body must be JSON")
            return

        bridges: dict[int, UiBridge] = self.server.bridges  # type: ignore[attr-defined]

        if path == "/api/approve":
            request_id_raw = payload.get("id")
            try:
                request_id = int(request_id_raw)
            except (TypeError, ValueError):
                self._error(400, "'id' must be the integer from an approval_request event")
                return
            bridge = bridges.get(request_id)
            if bridge is None:
                self._error(404, "no pending approval with that id (it may have expired)")
                return
            bridges.pop(request_id, None)
            allowed = bool(payload.get("allow"))
            bridge.resolve(request_id, allowed)
            self._json({"resolved": True, "allowed": allowed})
            return

        if path == "/api/command":
            session: ChatSession = self.server.session  # type: ignore[attr-defined]
            line = str(payload.get("line", "")).strip()
            if not line.startswith("/"):
                self._error(400, "commands must start with /")
                return
            result = session.handle_command(line)
            self._json({
                "text": result.text,
                "kind": result.kind,
                "quit": result.quit,
                "tabled": result.tabled,
            })
            return

        self._error(404, f"no such api path: {path}")

    # -- server-sent events ----------------------------------------------
    def _chat_stream(self, session: ChatSession) -> None:
        message = parse_qs(urlparse(self.path).query).get("message", [""])[0].strip()
        if not message:
            self._error(400, "missing 'message' query parameter")
            return

        lock: threading.Lock = self.server.chat_lock  # type: ignore[attr-defined]
        if not lock.acquire(blocking=False):
            self._error(409, "another message is still being answered")
            return

        bridge = UiBridge()
        auto_approve: bool = self.server.auto_approve  # type: ignore[attr-defined]
        bridges: dict[int, UiBridge] = self.server.bridges  # type: ignore[attr-defined]

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()

        def worker() -> None:
            try:
                session.set_approver((lambda _t, _p: True) if auto_approve else bridge.approve)
                turn = session.ask(message, on_text=bridge.text, on_event=bridge.on_event)
                bridge.emit("done", {
                    "reply": turn.reply,
                    "seconds": turn.seconds,
                    "rounds": turn.rounds,
                    "tools": [c["name"] for c in turn.tool_calls],
                    "stopped_reason": turn.stopped_reason,
                })
            except Exception as exc:  # noqa: BLE001 - reported into the stream
                bridge.emit("error", {"message": f"{type(exc).__name__}: {exc}"})
            finally:
                session.set_approver(lambda _t, _p: False)
                bridge.finish()
                lock.release()

        threading.Thread(target=worker, daemon=True).start()

        try:
            while True:
                kind, payload = bridge.queue.get()
                if kind == "__end__":
                    self._write_event("end", {})
                    break
                if kind == "approval_request":
                    bridges[payload["id"]] = bridge
                self._write_event(kind, payload)
        except (BrokenPipeError, ConnectionResetError):
            # The browser went away (tab closed or navigated). The worker keeps the
            # session consistent and releases the lock on its own.
            pass

    def _write_event(self, kind: str, payload: dict) -> None:
        chunk = f"event: {kind}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
        self.wfile.write(chunk.encode("utf-8"))
        self.wfile.flush()


class AgentServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, session: ChatSession, auto_approve: bool, session_code: str):
        super().__init__(address, handler)
        self.session = session
        self.auto_approve = auto_approve
        self.session_code = session_code
        self.chat_lock = threading.Lock()
        self.bridges: dict[int, UiBridge] = {}


def build_server(
    cfg: dict,
    session: ChatSession,
    host: str = "127.0.0.1",
    port: int | None = None,
    auto_approve: bool = False,
    session_code: str | None = None,
) -> AgentServer:
    """Create the server without starting it. port=0 picks a free port."""
    chosen = int(cfg.get("webui", {}).get("port", 8765)) if port is None else int(port)
    return AgentServer(
        (host, chosen),
        Handler,
        session=session,
        auto_approve=auto_approve,
        session_code=session_code or secrets.token_urlsafe(24),
    )


# --------------------------------------------------------------------------- #
# The page
# --------------------------------------------------------------------------- #
APP_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Personal Agent</title>
<style>
  :root {
    --bg: #0e1116; --panel: #151a21; --panel2: #1b222b; --line: #262f3a;
    --text: #e6edf3; --dim: #8b98a5; --accent: #4c9aff; --ok: #3fb950;
    --warn: #d29922; --bad: #f85149; --tool: #7ee3e0;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg); color: var(--text);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: flex; flex-direction: column;
  }
  header {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--line);
  }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: .2px; }
  .pill {
    font-size: 12px; color: var(--dim); background: var(--panel2);
    border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px;
  }
  .pill b { color: var(--text); font-weight: 500; }
  header .spacer { flex: 1; }
  button {
    font: inherit; font-size: 13px; color: var(--text); background: var(--panel2);
    border: 1px solid var(--line); border-radius: 8px; padding: 6px 12px; cursor: pointer;
  }
  button:hover:not(:disabled) { border-color: var(--accent); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #06101f; font-weight: 600; }
  button.danger { border-color: var(--bad); color: var(--bad); }
  main { flex: 1; overflow-y: auto; padding: 18px 16px 4px; }
  .wrap { max-width: 860px; margin: 0 auto; }
  .msg { margin-bottom: 16px; display: flex; gap: 12px; }
  .who {
    flex: 0 0 66px; text-align: right; font-size: 12px; color: var(--dim);
    padding-top: 4px; text-transform: uppercase; letter-spacing: .6px;
  }
  .bubble {
    flex: 1; min-width: 0; background: var(--panel); border: 1px solid var(--line);
    border-radius: 10px; padding: 10px 14px; white-space: pre-wrap; word-wrap: break-word;
    overflow-wrap: anywhere;
  }
  .msg.user .bubble { background: var(--panel2); }
  .bubble code, .bubble pre {
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px;
  }
  .bubble pre { background: #0b0f14; border: 1px solid var(--line); border-radius: 8px;
    padding: 10px; overflow-x: auto; white-space: pre; }
  .meta { font-size: 12px; color: var(--dim); margin-top: 8px; }
  .tool {
    font-family: ui-monospace, Consolas, monospace; font-size: 12.5px;
    border-left: 2px solid var(--line); padding: 4px 0 4px 12px; margin: 8px 0; color: var(--dim);
  }
  .tool .name { color: var(--tool); }
  .tool.failed .name { color: var(--bad); }
  .approval {
    border: 1px solid var(--warn); background: #2a2413; border-radius: 10px;
    padding: 12px 14px; margin: 12px 0;
  }
  .approval h3 { margin: 0 0 6px; font-size: 13px; color: var(--warn); text-transform: uppercase;
    letter-spacing: .8px; }
  .approval pre { margin: 8px 0 12px; white-space: pre-wrap; font-size: 13px;
    font-family: ui-monospace, Consolas, monospace; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  footer { border-top: 1px solid var(--line); background: var(--panel); padding: 12px 16px; }
  form { max-width: 860px; margin: 0 auto; display: flex; gap: 10px; align-items: flex-end; }
  textarea {
    flex: 1; resize: none; min-height: 46px; max-height: 190px; font: inherit;
    color: var(--text); background: var(--panel2); border: 1px solid var(--line);
    border-radius: 10px; padding: 12px; outline: none;
  }
  textarea:focus { border-color: var(--accent); }
  .hint { max-width: 860px; margin: 6px auto 0; font-size: 12px; color: var(--dim); }
  .status { font-size: 12px; color: var(--dim); }
  .status.busy { color: var(--accent); }
  .status.err { color: var(--bad); }
</style>
</head>
<body>
<header>
  <h1 id="agent-name">Personal Agent</h1>
  <span class="pill">model <b id="model">-</b></span>
  <span class="pill">sandbox <b id="sandbox">-</b></span>
  <span class="spacer"></span>
  <span class="status" id="status">ready</span>
  <button id="btn-new" title="Clear this session's transcript">New session</button>
</header>

<main id="main"><div class="wrap" id="thread"></div></main>

<footer>
  <form id="form">
    <textarea id="input" placeholder="Ask anything, or type / for commands. Enter sends, Shift+Enter makes a new line." autofocus></textarea>
    <button class="primary" id="send" type="submit">Send</button>
  </form>
  <div class="hint" id="hint">Everything stays on this machine. Mutating commands ask for your approval before they run.</div>
</footer>

<script>
const CODE = "__SESSION_CODE__";
const thread = document.getElementById('thread');
const main = document.getElementById('main');
const input = document.getElementById('input');
const form = document.getElementById('form');
const send = document.getElementById('send');
const statusEl = document.getElementById('status');
const hintEl = document.getElementById('hint');
let busy = false;
let stream = null;

const api = (path, options) => {
  const opts = Object.assign({}, options || {});
  opts.headers = Object.assign({'X-Agent-Session': CODE}, opts.headers || {});
  return fetch(path, opts).then(async (r) => {
    const text = await r.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch (e) { body = {raw: text}; }
    if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
    return body;
  });
};

const atBottom = () => main.scrollHeight - main.scrollTop - main.clientHeight < 80;
const scroll = (force) => { if (force || atBottom()) main.scrollTop = main.scrollHeight; };

function addMessage(who, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + who;
  el.innerHTML = '<div class="who"></div><div class="bubble"></div>';
  el.querySelector('.who').textContent = who === 'user' ? 'you' : 'agent';
  el.querySelector('.bubble').textContent = text || '';
  thread.appendChild(el);
  scroll(true);
  return el.querySelector('.bubble');
}

function addTool(name, args) {
  const el = document.createElement('div');
  el.className = 'tool';
  el.innerHTML = '<span class="name"></span> <span class="args"></span>';
  el.querySelector('.name').textContent = name + '(';
  el.querySelector('.args').textContent = (args || '') + ')';
  thread.appendChild(el);
  scroll();
  return el;
}

function appendToolResult(el, ok, content) {
  const line = document.createElement('div');
  line.className = 'tool' + (ok ? '' : ' failed');
  const summary = String(content || '').split('\\n').filter(Boolean).slice(0, 4).join(' | ').slice(0, 400);
  line.textContent = (ok ? '-> ' : '-> failed: ') + summary;
  if (el && el.parentNode) { el.parentNode.insertBefore(line, el.nextSibling); }
  else { thread.appendChild(line); }
  scroll();
}

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (cls ? ' ' + cls : '');
}

function setBusy(value) {
  busy = value;
  send.disabled = value;
  if (value) { setStatus('thinking...', 'busy'); } else { setStatus('ready'); }
}

function askApproval(payload) {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'approval';
    const title = document.createElement('h3');
    title.textContent = 'approval needed: ' + payload.tool;
    const pre = document.createElement('pre');
    pre.textContent = payload.prompt;
    const row = document.createElement('div');
    row.className = 'row';
    const yes = document.createElement('button');
    yes.className = 'primary';
    yes.textContent = 'Allow once';
    const no = document.createElement('button');
    no.className = 'danger';
    no.textContent = 'Deny';
    const note = document.createElement('span');
    note.className = 'status';
    row.append(yes, no, note);
    box.append(title, pre, row);
    thread.appendChild(box);
    scroll(true);

    const answer = (allow) => {
      yes.disabled = true; no.disabled = true;
      note.textContent = allow ? 'allowed' : 'denied';
      api('/api/approve', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({id: payload.id, allow: allow})
      }).then(() => resolve()).catch((err) => {
        note.textContent = 'failed: ' + err.message;
        resolve();
      });
    };
    yes.addEventListener('click', () => answer(true));
    no.addEventListener('click', () => answer(false));
  });
}

function finish(reason) {
  setBusy(false);
  stream = null;
  if (reason) setStatus(reason, 'err');
  input.focus();
}

function sendMessage(text) {
  if (busy || !String(text).trim()) return;
  addMessage('user', text);
  const bubble = addMessage('agent', '');
  setBusy(true);
  const toolEls = {};

  const url = '/api/chat?message=' + encodeURIComponent(text) + '&code=' + encodeURIComponent(CODE);
  stream = new EventSource(url);

  stream.addEventListener('token', (e) => {
    bubble.textContent += JSON.parse(e.data).text;
    scroll();
  });
  stream.addEventListener('tool_start', (e) => {
    const data = JSON.parse(e.data);
    const args = JSON.stringify(data.arguments || {});
    toolEls[data.name] = addTool(data.name, args.length > 120 ? args.slice(0, 120) + '...' : args);
  });
  stream.addEventListener('tool_end', (e) => {
    const data = JSON.parse(e.data);
    appendToolResult(toolEls[data.name], data.ok, data.content);
  });
  stream.addEventListener('approval_request', (e) => {
    setStatus('waiting for your approval', 'busy');
    askApproval(JSON.parse(e.data)).then(() => setStatus('thinking...', 'busy'));
  });
  stream.addEventListener('approval_timeout', () => {
    const note = document.createElement('div');
    note.className = 'meta';
    note.textContent = 'no answer in time - the command was refused';
    thread.appendChild(note);
  });
  stream.addEventListener('budget', () => {
    const note = document.createElement('div');
    note.className = 'meta';
    note.textContent = 'tool-call budget reached; asking for a best-effort answer';
    thread.appendChild(note);
    scroll();
  });
  stream.addEventListener('done', (e) => {
    const data = JSON.parse(e.data);
    if (!bubble.textContent) bubble.textContent = data.reply || '(no answer)';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const tools = (data.tools && data.tools.length) ? data.tools.join(', ') : 'none';
    meta.textContent = data.seconds + 's | rounds ' + data.rounds + ' | tools: ' + tools +
      ' | stop: ' + data.stopped_reason;
    thread.appendChild(meta);
    scroll();
    stream.close();
    finish();
  });
  stream.addEventListener('error', (e) => {
    if (e && e.data) {
      bubble.textContent = 'Something went wrong: ' + JSON.parse(e.data).message;
    } else if (bubble && !bubble.textContent) {
      bubble.textContent = 'The connection closed before an answer arrived.';
    }
    scroll();
  });
  stream.addEventListener('end', () => {
    if (stream) stream.close();
    finish();
  });
}

function runCommand(line) {
  addMessage('user', line);
  api('/api/command', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({line: line})
  }).then((data) => {
    const bubble = addMessage('agent', data.text || '(no output)');
    if (data.kind === 'error') bubble.style.borderColor = 'var(--bad)';
  }).catch((err) => {
    const bubble = addMessage('agent', 'command failed: ' + err.message);
    bubble.style.borderColor = 'var(--bad)';
  });
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value;
  if (!String(text).trim() || busy) return;
  input.value = '';
  input.style.height = 'auto';
  if (String(text).trim().startsWith('/')) { runCommand(String(text).trim()); return; }
  sendMessage(text);
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 190) + 'px';
});

document.getElementById('btn-new').addEventListener('click', () => {
  if (busy) return;
  runCommand('/new');
});

api('/api/state').then((data) => {
  const banner = data.banner || {};
  document.getElementById('agent-name').textContent = banner.agent || 'Personal Agent';
  document.getElementById('model').textContent = data.provider || '-';
  document.getElementById('sandbox').textContent = banner.sandbox || '-';
  const counts = banner.counts || {};
  hintEl.textContent = 'Local only. ' + (counts.memories || 0) + ' memories, ' + (counts.notes || 0) +
    ' notes, ' + (banner.tools || []).length + ' tools. /help lists the commands; mutating commands ask first.';
  if (/mock/.test(data.provider || '')) {
    hintEl.textContent += ' The mock provider only replays a fixed script.';
  }
}).catch((err) => setStatus('cannot reach the agent: ' + err.message, 'err'));

api('/api/history').then((data) => {
  const messages = data.messages || [];
  if (!messages.length) return;
  const head = document.createElement('div');
  head.className = 'meta';
  head.textContent = 'earlier in this session';
  thread.appendChild(head);
  messages.slice(-6).forEach((m) => addMessage(m.role === 'user' ? 'user' : 'agent', m.content));
}).catch(() => {});
</script>
</body>
</html>
"""


# --------------------------------------------------------------------------- #
# launcher
# --------------------------------------------------------------------------- #
def is_loopback(host: str) -> bool:
    if host in {"localhost", ""}:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="webui.py", description="Serve the agent's chat page locally.")
    parser.add_argument("--config", help="path to an alternative config.json")
    parser.add_argument("--provider", choices=["ollama", "openai", "mock"], help="override the model backend")
    parser.add_argument("--model", help="override the model name")
    parser.add_argument("--root", help="override the workspace sandbox folder")
    parser.add_argument("--port", type=int, help="port to listen on (default from config.json)")
    parser.add_argument("--host", default="127.0.0.1", help="interface to bind (loopback by default)")
    parser.add_argument("--allow-remote", action="store_true",
                        help="permit binding a non-loopback interface (exposes the agent to your network)")
    parser.add_argument("--session", default="web", help="session name used for transcript history")
    parser.add_argument("-y", "--yes", action="store_true", help="auto-approve mutating tool calls")
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser window")
    parser.add_argument("--no-shell", action="store_true", help="disable the run_command tool")
    parser.add_argument("--no-web", action="store_true", help="disable web search and fetch")
    return parser.parse_args(argv)


def build_config(args: argparse.Namespace) -> dict:
    overrides: dict = {}
    if args.provider:
        overrides["provider"] = args.provider
    if args.root:
        overrides["paths"] = {"root": args.root}
    if args.no_shell:
        overrides["shell"] = {"enabled": False}
    if args.no_web:
        overrides["web"] = {"enabled": False}
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

    if not is_loopback(args.host) and not (args.allow_remote or cfg.get("webui", {}).get("allow_remote")):
        print(
            f"refusing to bind {args.host}: that would expose your agent, its memory and its shell to the "
            "network.\nPass --allow-remote if you really mean it."
        )
        return 2

    session = ChatSession(cfg, session_id=args.session, approver=lambda _t, _p: False)
    server = build_server(cfg, session, host=args.host, port=args.port, auto_approve=args.yes)
    host, port = server.server_address[0], server.server_address[1]
    url = f"http://{host}:{port}/"

    print()
    print("  personal agent - web UI")
    print(f"  address    |  {url}")
    print(f"  backend    |  {describe_provider(cfg)}")
    print(f"  sandbox    |  {cfg['paths']['root']}")
    print(f"  approvals  |  {'auto-approved (-y)' if args.yes else 'asked in the browser'}")
    print()
    print("  The page is local-only and requires this launch's session code. Ctrl+C to stop.")

    if not args.no_browser and cfg.get("webui", {}).get("open_browser", True):
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping...")
    finally:
        server.shutdown()
        server.server_close()
        session.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
