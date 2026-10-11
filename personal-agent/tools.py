"""The tools the agent can call.

Design rules that hold for every tool here:

* The registry is the single source of truth for both the JSON schema handed to
  the model and the Python that runs it, so they cannot drift apart.
* Tools never raise at the model. They return a short, honest status line
  ("error: ..." / "blocked: ...") so the model can recover or explain.
* Two tools are hard-gated: `run_command` needs approval for anything mutating,
  and every path is re-validated inside the sandbox.
"""

from __future__ import annotations

import html
import json
import os
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from safety import CommandBlocked, PathGuard, SandboxError, classify

Approver = Callable[[str, str], bool]
"""Called with (tool_name, prompt). Returns True when the human allows it."""


@dataclass
class ToolResult:
    ok: bool
    content: str
    detail: dict[str, Any] | None = None


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict[str, Any]
    fn: Callable[..., ToolResult]

    def schema(self) -> dict[str, Any]:
        return {"name": self.name, "description": self.description, "parameters": self.parameters}


def make_safe(fn: Callable[..., ToolResult]) -> Callable[..., ToolResult]:
    """Wrap a tool so that no failure mode ever escapes as an exception."""

    def guarded(*args: Any, **kwargs: Any) -> ToolResult:
        try:
            return fn(*args, **kwargs)
        except SandboxError as exc:
            return ToolResult(False, f"blocked: {exc}")
        except CommandBlocked as exc:
            return ToolResult(False, f"blocked: {exc}")
        except TypeError as exc:
            return ToolResult(False, f"error: bad arguments for {fn.__name__}: {exc}")
        except Exception as exc:  # noqa: BLE001 - surfaced to the model, never fatal
            return ToolResult(False, f"error: {type(exc).__name__}: {exc}")

    guarded.__name__ = fn.__name__
    guarded.__doc__ = fn.__doc__
    return guarded


def _obj(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": required or []}


STR = {"type": "string"}
INT = {"type": "integer"}


class Tools:
    """Holds every tool, the sandbox guard and the approval callback."""

    def __init__(self, cfg: dict, store, approver: Approver | None = None, log: Callable[[str], None] | None = None):
        self.cfg = cfg
        self.store = store
        self.guard = PathGuard(cfg["paths"]["root"])
        self.approver = approver
        self.log = log or (lambda _msg: None)
        self.shell = cfg.get("shell", {})
        self.web = cfg.get("web", {})
        self.memory_cfg = cfg.get("memory", {})
        self._registry: dict[str, Tool] = {}
        self.denials: list[str] = []
        self._register_all()

    # ------------------------------------------------------------- registry
    def _register_all(self) -> None:
        self._add(
            "remember",
            "Save a durable fact about the user to long-term memory. Use it when the user states a "
            "preference, a personal detail, an ongoing project or anything worth recalling later. "
            "Do not use it for small talk.",
            _obj(
                {
                    "content": {**STR, "description": "The fact, written as one self-contained sentence."},
                    "tags": {**STR, "description": "Comma-separated tags, e.g. 'preference,work'."},
                },
                ["content"],
            ),
            self.tool_remember,
        )
        self._add(
            "search_memory",
            "Search saved long-term memory. Call this before claiming you do not know something about the user.",
            _obj({"query": STR, "limit": INT}, ["query"]),
            self.tool_search_memory,
        )
        self._add(
            "forget",
            "Deactivate one memory by its id (ids look like mem_1a2b3c4d). Use when the user corrects a fact.",
            _obj({"memory_id": STR}, ["memory_id"]),
            self.tool_forget,
        )
        self._add(
            "save_note",
            "Create or update a long-form note. Passing an existing title overwrites that note in place.",
            _obj({"title": STR, "body": STR, "tags": STR}, ["title", "body"]),
            self.tool_save_note,
        )
        self._add(
            "list_notes",
            "List saved notes with a short preview of each.",
            _obj({"limit": INT}),
            self.tool_list_notes,
        )
        self._add(
            "read_note",
            "Read one note in full by id or exact title.",
            _obj({"note": {**STR, "description": "Note id or title."}}),
            self.tool_read_note,
        )
        self._add(
            "list_files",
            "List files and folders inside the workspace sandbox.",
            _obj({"path": {**STR, "description": "Folder relative to the workspace root. Default '.'"}}),
            self.tool_list_files,
        )
        self._add(
            "read_file",
            "Read a UTF-8 text file inside the workspace sandbox.",
            _obj({"path": STR, "max_chars": INT}, ["path"]),
            self.tool_read_file,
        )
        self._add(
            "write_file",
            "Create or replace a text file inside the workspace sandbox.",
            _obj({"path": STR, "content": STR}, ["path", "content"]),
            self.tool_write_file,
        )
        self._add(
            "append_file",
            "Append text to a file inside the workspace sandbox.",
            _obj({"path": STR, "content": STR}, ["path", "content"]),
            self.tool_append_file,
        )
        self._add(
            "run_command",
            "Run a shell command on this computer. Read-only commands run immediately; anything that "
            "changes files, installs software or touches the system asks the user first, and a few "
            "unrecoverable commands are refused.",
            _obj(
                {
                    "command": {**STR, "description": "The full command line to run."},
                    "cwd": {**STR, "description": "Working directory relative to the workspace root."},
                },
                ["command"],
            ),
            self.tool_run_command,
        )
        self._add(
            "web_search",
            "Search the public web and return titles, URLs and snippets. Use it for anything recent "
            "or factual that you cannot confirm from memory.",
            _obj({"query": STR, "count": INT}, ["query"]),
            self.tool_web_search,
        )
        self._add(
            "fetch_page",
            "Download one public web page and return its readable text.",
            _obj({"url": STR, "max_chars": INT}, ["url"]),
            self.tool_fetch_page,
        )

    def _add(self, name: str, description: str, parameters: dict, fn: Callable) -> None:
        safe = make_safe(fn)
        self._registry[name] = Tool(name=name, description=description, parameters=parameters, fn=safe)
        # Bind the guarded version onto the instance too, so a direct call such as
        # `tools.tool_read_file("../../escape")` behaves exactly like a model-driven
        # one: a status line, never an exception.
        setattr(self, fn.__name__, safe)

    @property
    def schemas(self) -> list[dict[str, Any]]:
        return [tool.schema() for tool in self._registry.values()]

    def names(self) -> list[str]:
        return list(self._registry)

    def describe(self) -> str:
        return ", ".join(self._registry)

    # ---------------------------------------------------------------- invoke
    def call(self, name: str, arguments: dict[str, Any] | None = None) -> ToolResult:
        tool = self._registry.get(name)
        if tool is None:
            return ToolResult(False, f"error: unknown tool '{name}'. Available: {self.describe()}")
        args = arguments or {}
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                return ToolResult(False, f"error: arguments for '{name}' were not valid JSON")
        if not isinstance(args, dict):
            return ToolResult(False, f"error: arguments for '{name}' must be an object")
        try:
            return tool.fn(**args)
        except TypeError as exc:
            return ToolResult(False, f"error: bad arguments for '{name}': {exc}")

    def _approve(self, tool_name: str, prompt: str) -> bool:
        if self.approver is None:
            self.denials.append(prompt)
            return False
        return bool(self.approver(tool_name, prompt))

    # ---------------------------------------------------------------- memory
    def tool_remember(self, content: str, tags: str = "") -> ToolResult:
        if not self.memory_cfg.get("enabled", True):
            return ToolResult(False, "error: memory is disabled in config.json")
        memory_id = self.store.add_memory(content, tags=tags, source="agent")
        return ToolResult(True, f"saved memory {memory_id}: {content}", {"id": memory_id})

    def tool_search_memory(self, query: str, limit: int = 6) -> ToolResult:
        rows = self.store.search_memories(query, limit=int(limit or 6))
        if not rows:
            return ToolResult(True, f"no memories matched '{query}'")
        lines = [f"- [{r['id']}] {r['content']}" + (f"  (tags: {r['tags']})" if r["tags"] else "") for r in rows]
        return ToolResult(True, "\n".join(lines), {"count": len(rows)})

    def tool_forget(self, memory_id: str) -> ToolResult:
        memory_id = (memory_id or "").strip()
        if not memory_id.startswith("mem_"):
            # Be forgiving: allow a plain-text lookup so a sloppy model still works.
            hits = self.store.search_memories(memory_id, limit=1)
            if not hits:
                return ToolResult(False, f"error: no memory matching '{memory_id}'")
            memory_id = hits[0]["id"]
        ok = self.store.forget_memory(memory_id)
        return ToolResult(ok, f"forgot {memory_id}" if ok else f"error: no memory with id {memory_id}")

    # ----------------------------------------------------------------- notes
    def tool_save_note(self, title: str, body: str, tags: str = "") -> ToolResult:
        existing = self.store.find_note_by_title(title)
        if existing:
            self.store.update_note(existing["id"], title=title, body=body, tags=tags)
            return ToolResult(True, f"updated note {existing['id']} '{title}'", {"id": existing["id"]})
        note_id = self.store.add_note(title, body, tags)
        return ToolResult(True, f"created note {note_id} '{title}'", {"id": note_id})

    def tool_list_notes(self, limit: int = 20) -> ToolResult:
        rows = self.store.list_notes(limit=int(limit or 20))
        if not rows:
            return ToolResult(True, "no notes yet")
        lines = []
        for row in rows:
            lines.append(f"- [{row['id']}] {row['title']} (updated {row['updated_at']})")
            preview = " ".join((row.get("preview") or "").split())[:110]
            if preview:
                lines.append(f"    {preview}...")
        return ToolResult(True, "\n".join(lines), {"count": len(rows)})

    def tool_read_note(self, note: str) -> ToolResult:
        row = self.store.get_note(note) or self.store.find_note_by_title(note)
        if not row:
            hits = self.store.search_notes(note, limit=3)
            if hits:
                listing = ", ".join(f"[{h['id']}] {h['title']}" for h in hits)
                return ToolResult(False, f"error: no note named '{note}'. Did you mean: {listing}")
            return ToolResult(False, f"error: no note named '{note}'")
        body = row["body"] or "(empty)"
        return ToolResult(True, f"# {row['title']}\n(updated {row['updated_at']}, tags: {row['tags'] or '-'})\n\n{body}")

    # ----------------------------------------------------------------- files
    def tool_list_files(self, path: str = ".") -> ToolResult:
        target = self.guard.resolve(path)
        if not target.exists():
            return ToolResult(False, f"error: '{path}' does not exist in the workspace")
        if target.is_file():
            return ToolResult(True, f"{self.guard.relative(target)} ({target.stat().st_size} bytes)")
        entries: list[str] = []
        for child in sorted(target.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
            rel = self.guard.relative(child)
            if child.is_dir():
                entries.append(f"[dir]  {rel}/")
            else:
                entries.append(f"[file] {rel}  ({child.stat().st_size} bytes)")
        header = f"workspace root: {self.guard.root}"
        return ToolResult(True, "\n".join([header] + entries) if entries else f"{header}\n(empty folder)")

    def tool_read_file(self, path: str, max_chars: int = 8000) -> ToolResult:
        target = self.guard.resolve(path, must_exist=True)
        if target.is_dir():
            return ToolResult(False, f"error: '{path}' is a folder; use list_files")
        limit = max(200, min(int(max_chars or 8000), 60000))
        try:
            text = target.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            return ToolResult(False, f"error: cannot read '{path}': {exc}")
        truncated = len(text) > limit
        body = text[:limit]
        suffix = f"\n... [truncated, {len(text)} chars total]" if truncated else ""
        return ToolResult(True, body + suffix, {"chars": len(text), "truncated": truncated})

    def tool_write_file(self, path: str, content: str) -> ToolResult:
        target = self.guard.resolve(path)
        self.log(f"write_file -> {self.guard.relative(target)}")
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and self.approver is not None:
            preview = content if len(content) < 800 else content[:800] + "\n..."
            if not self._approve(
                "write_file",
                f"Overwrite existing file '{self.guard.relative(target)}' ({target.stat().st_size} bytes) with "
                f"{len(content)} chars?\n--- new content preview ---\n{preview}",
            ):
                return ToolResult(False, f"blocked: user declined to overwrite '{self.guard.relative(target)}'")
        target.write_text(content, encoding="utf-8")
        return ToolResult(True, f"wrote {len(content)} chars to {self.guard.relative(target)}", {"path": str(target)})

    def tool_append_file(self, path: str, content: str) -> ToolResult:
        target = self.guard.resolve(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("a", encoding="utf-8") as handle:
            handle.write(content)
        return ToolResult(True, f"appended {len(content)} chars to {self.guard.relative(target)}")

    # ---------------------------------------------------------------- shell
    def tool_run_command(self, command: str, cwd: str = ".") -> ToolResult:
        if not self.shell.get("enabled", True):
            return ToolResult(False, "blocked: shell access is disabled in config.json (shell.enabled=false)")

        verdict = classify(command)
        if verdict.level == "block":
            return ToolResult(False, f"blocked: {verdict.reason}")

        workdir = self.guard.resolve(cwd)
        if not workdir.is_dir():
            return ToolResult(False, f"error: working directory '{cwd}' is not a folder in the workspace")

        if verdict.level == "confirm" and self.shell.get("confirm", True):
            prompt = (
                f"Run this command in {self.guard.relative(workdir)}?\n"
                f"  {command}\n  reason: {verdict.reason}"
            )
            if not self._approve("run_command", prompt):
                return ToolResult(False, "blocked: user declined to run this command")

        timeout = int(self.shell.get("timeout_seconds", 60))
        started = time.time()
        prefix, shell_label = choose_shell(command)
        argv = [*prefix, command] if prefix else command
        try:
            completed = subprocess.run(  # noqa: S602 - gated above by classify()
                argv,
                shell=prefix is None,
                cwd=str(workdir),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            return ToolResult(False, f"error: command timed out after {timeout}s")
        except OSError as exc:
            return ToolResult(False, f"error: could not start command: {exc}")

        elapsed = round(time.time() - started, 2)
        cap = int(self.shell.get("max_output_chars", 4000))
        stdout = _clip(completed.stdout or "", cap)
        stderr = _clip(completed.stderr or "", cap // 2)
        parts = [f"exit code: {completed.returncode}  ({elapsed}s, via {shell_label})"]
        if stdout.strip():
            parts.append(f"stdout:\n{stdout.strip()}")
        if stderr.strip():
            parts.append(f"stderr:\n{stderr.strip()}")
        if len(parts) == 1:
            parts.append("(no output)")
        return ToolResult(
            completed.returncode == 0,
            "\n".join(parts),
            {"exit_code": completed.returncode, "seconds": elapsed, "shell": shell_label},
        )

    # ------------------------------------------------------------------ web
    def tool_web_search(self, query: str, count: int = 5) -> ToolResult:
        if not self.web.get("enabled", True):
            return ToolResult(False, "error: web access is disabled in config.json (web.enabled=false)")
        want = max(1, min(int(count or self.web.get("max_results", 5)), 10))
        backend = str(self.web.get("backend", "duckduckgo")).lower()
        try:
            if backend == "searx" and self.web.get("searx_url"):
                results = _search_searx(self.web["searx_url"], query, want, self.web)
            else:
                results = _search_duckduckgo(query, want, self.web)
        except urllib.error.URLError as exc:
            return ToolResult(False, f"error: web search failed (no connection?): {exc}")
        except Exception as exc:  # noqa: BLE001
            return ToolResult(False, f"error: web search failed: {type(exc).__name__}: {exc}")
        if not results:
            return ToolResult(True, f"no results for '{query}'")
        lines: list[str] = []
        for i, item in enumerate(results, 1):
            lines.append(f"{i}. {item['title']}\n   {item['url']}\n   {item['snippet']}")
        return ToolResult(True, "\n".join(lines), {"count": len(results)})

    def tool_fetch_page(self, url: str, max_chars: int = 6000) -> ToolResult:
        if not self.web.get("enabled", True):
            return ToolResult(False, "error: web access is disabled in config.json (web.enabled=false)")
        if not re.match(r"^https?://", url or "", re.I):
            return ToolResult(False, "error: url must start with http:// or https://")
        if _is_private_host(url):
            return ToolResult(False, "blocked: refusing to fetch a local or private-network address")

        limit = max(400, min(int(max_chars or 6000), 40000))
        request = urllib.request.Request(
            url, headers={"User-Agent": self.web.get("user_agent", "Mozilla/5.0"), "Accept-Language": "en,*;q=0.5"}
        )
        try:
            with urllib.request.urlopen(request, timeout=int(self.web.get("timeout_seconds", 20))) as response:
                raw = response.read()
                charset = response.headers.get_content_charset() or "utf-8"
                text = _html_to_text(raw.decode(charset, errors="replace"))
        except urllib.error.HTTPError as exc:
            return ToolResult(False, f"error: HTTP {exc.code} fetching {url}")
        except urllib.error.URLError as exc:
            return ToolResult(False, f"error: cannot reach {url}: {exc}")
        except Exception as exc:  # noqa: BLE001
            return ToolResult(False, f"error: fetch failed: {type(exc).__name__}: {exc}")

        title = url
        match = re.search(r"<title[^>]*>(.*?)</title>", raw.decode("utf-8", errors="replace"), re.I | re.S)
        if match:
            title = html.unescape(re.sub(r"\s+", " ", match.group(1))).strip()
        truncated = len(text) > limit
        body = text[:limit]
        suffix = f"\n... [truncated at {limit} of {len(text)} chars]" if truncated else ""
        return ToolResult(
            True, f"{title}\n{url}\n\n{body}{suffix}", {"chars": len(text), "truncated": truncated}
        )


# PowerShell-only syntax. The classifier understands both cmd.exe and PowerShell
# commands, but Windows' `shell=True` always means cmd.exe - so a command that uses
# PowerShell cmdlets must be handed to PowerShell explicitly or it silently fails
# with "'Remove-Item' is not recognized". Detecting this keeps the two halves
# honest with each other.
POWERSHELL_MARKERS = re.compile(
    r"\b(remove-item|get-childitem|get-content|set-content|add-content|clear-content|new-item|"
    r"copy-item|move-item|rename-item|remove-itemproperty|set-itemproperty|new-itemproperty|"
    r"get-item|get-itemproperty|test-path|resolve-path|join-path|split-path|select-object|"
    r"where-object|foreach-object|sort-object|measure-object|select-string|write-output|"
    r"out-file|invoke-webrequest|invoke-restmethod|invoke-expression|start-process|stop-process|"
    r"get-process|get-service|set-service|new-service|register-scheduledtask|new-scheduledtask\w*|"
    r"new-localuser|add-localgroupmember|get-command|get-help|get-date|get-location|"
    r"convertto-json|convertfrom-json|get-filehash|start-job|stop-job|receive-job)\b"
    r"|-(force|recurse|erroraction|literalpath|filter|exclude|include)\b"
    r"|\$env:|\bnew-scheduledtask\w*",
    re.I,
)


def choose_shell(command: str) -> tuple[list[str] | None, str]:
    """Return (argv_prefix, label). A None prefix means "let the OS pick cmd.exe"."""
    if POWERSHELL_MARKERS.search(command or ""):
        executable = shutil.which("powershell") or shutil.which("pwsh")
        if executable:
            # -NoProfile keeps the user's profile out of the run; -NonInteractive
            # guarantees an approved command can never sit waiting on a prompt.
            return [executable, "-NoProfile", "-NonInteractive", "-Command"], "powershell"
        return None, "cmd (powershell not found)"
    return None, "cmd"


def _clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n... [output truncated at {limit} chars]"


_SCRIPT = re.compile(r"<(script|style|noscript|svg|head)[^>]*>.*?</\1>", re.I | re.S)
_BLOCK = re.compile(r"</?(p|div|br|li|tr|h[1-6]|section|article|header|footer|blockquote)[^>]*>", re.I)
_TAG = re.compile(r"<[^>]+>")


def _html_to_text(markup: str) -> str:
    text = _SCRIPT.sub(" ", markup)
    text = _BLOCK.sub("\n", text)
    text = _TAG.sub(" ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t\u00a0]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    return text.strip()


def _is_private_host(url: str) -> bool:
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    if host in {"localhost", "::1", "0.0.0.0"} or host.endswith(".local") or host.endswith(".internal"):
        return True
    if re.match(r"^127\.", host) or re.match(r"^10\.", host) or re.match(r"^192\.168\.", host):
        return True
    if re.match(r"^172\.(1[6-9]|2\d|3[01])\.", host):
        return True
    if re.match(r"^169\.254\.", host):
        return True
    return False


def _search_duckduckgo(query: str, want: int, web_cfg: dict) -> list[dict[str, str]]:
    """Scrape DuckDuckGo's no-JavaScript endpoint.

    Best-effort by nature: if the markup changes, we fall back to the lite
    endpoint, and if both fail the caller turns it into an honest error rather
    than a hallucinated answer.
    """
    for endpoint in ("https://html.duckduckgo.com/html/", "https://lite.duckduckgo.com/lite/"):
        body = urllib.parse.urlencode({"q": query}).encode("utf-8")
        request = urllib.request.Request(
            endpoint,
            data=body,
            headers={
                "User-Agent": web_cfg.get("user_agent", "Mozilla/5.0"),
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept-Language": "en,*;q=0.5",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=int(web_cfg.get("timeout_seconds", 20))) as response:
            markup = response.read().decode("utf-8", errors="replace")
        results = _parse_ddg(markup, want)
        if results:
            return results
    return []


def _parse_ddg(markup: str, want: int) -> list[dict[str, str]]:
    results: list[dict[str, str]] = []

    # html.duckduckgo.com: each hit starts at a <a class="result__a">. Split on that
    # marker and look for the snippet inside the same block, so the two fields can
    # never be paired up wrongly.
    link = re.compile(
        r'<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="(?P<url>[^"]+)"[^>]*>(?P<title>.*?)</a>', re.I | re.S
    )
    snippet_re = re.compile(r'class="[^"]*result__snippet[^"]*"[^>]*>(?P<snippet>.*?)</a>', re.I | re.S)
    starts = [m.start() for m in link.finditer(markup)]
    for index, match in enumerate(link.finditer(markup)):
        end = starts[index + 1] if index + 1 < len(starts) else len(markup)
        found = snippet_re.search(markup[match.end():end])
        title = _strip_tags(match.group("title"))
        url = _clean_ddg_url(html.unescape(match.group("url")))
        if title and url:
            results.append(
                {"title": title, "url": url, "snippet": _strip_tags(found.group("snippet")) if found else ""}
            )
        if len(results) >= want:
            break
    if results:
        return results

    # lite.duckduckgo.com uses a plain table: <a class="result-link"> plus a
    # <td class="result-snippet"> a few cells later.
    lite_link = re.compile(
        r'<a[^>]+class="result-link"[^>]+href="(?P<url>[^"]+)"[^>]*>(?P<title>.*?)</a>', re.I | re.S
    )
    snippets = [
        _strip_tags(m.group("snippet"))
        for m in re.finditer(r'class="result-snippet"[^>]*>(?P<snippet>.*?)</td>', markup, re.I | re.S)
    ]
    for index, match in enumerate(lite_link.finditer(markup)):
        results.append(
            {
                "title": _strip_tags(match.group("title")),
                "url": _clean_ddg_url(html.unescape(match.group("url"))),
                "snippet": snippets[index] if index < len(snippets) else "",
            }
        )
        if len(results) >= want:
            break
    return results


def _search_searx(base: str, query: str, want: int, web_cfg: dict) -> list[dict[str, str]]:
    params = urllib.parse.urlencode({"q": query, "format": "json", "language": "all"})
    url = f"{base.rstrip('/')}/search?{params}"
    request = urllib.request.Request(url, headers={"User-Agent": web_cfg.get("user_agent", "Mozilla/5.0")})
    with urllib.request.urlopen(request, timeout=int(web_cfg.get("timeout_seconds", 20))) as response:
        data = json.loads(response.read().decode("utf-8", errors="replace"))
    return [
        {
            "title": item.get("title", ""),
            "url": item.get("url", ""),
            "snippet": re.sub(r"\s+", " ", item.get("content", "") or "").strip(),
        }
        for item in (data.get("results") or [])[:want]
    ]


def _clean_ddg_url(url: str) -> str:
    if "duckduckgo.com/l/" in url or url.startswith("/l/"):
        query = urllib.parse.urlparse(url).query or url.split("?", 1)[-1]
        target = urllib.parse.parse_qs(query).get("uddg")
        if target:
            return urllib.parse.unquote(target[0])
        return url if url.startswith("http") else "https://duckduckgo.com" + url
    return url


def _strip_tags(markup: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(_TAG.sub("", markup or ""))).strip()
