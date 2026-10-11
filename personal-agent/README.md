# Personal AI Agent — runs entirely on your own machine

A personal assistant you can talk to in the terminal **or in your browser**. It remembers things
about you between sessions, keeps notes, reads and writes files, runs shell commands behind an
approval gate, searches the web, and writes you a briefing each morning.

Plain Python 3 with **no third-party dependencies** — standard library only, no build step. Your
memory is one SQLite file you own, and the whole thing runs offline apart from the model you choose.

```
you> what do you know about me?
Alex> You're Priya, you prefer short answers, and you're building a local personal AI agent
      in Python. You asked me to keep those two facts separate from your work notes.
      [1.8s | rounds 2 | tools: search_memory | stop: answer]
```

---

## 1. Quickstart (5 minutes)

### Step 1 — pick a model backend

The agent needs a model to think with. Choose one:

**Option A: Ollama — fully local, no API key (recommended)**

1. Install Ollama from <https://ollama.com/download>.
2. Pull a model that supports **tool calling**:

   ```powershell
   ollama pull qwen2.5:7b-instruct
   ```

   `qwen2.5:7b-instruct` is a good default for 8 GB of memory. Smaller/faster: `qwen2.5:3b-instruct`.
   Stronger: `llama3.1:8b-instruct` or `qwen2.5:14b-instruct`. Tool calling is required — without it
   the model will chat but never use the agent's abilities.
3. Leave the server running (the installer normally starts it):

   ```powershell
   ollama serve
   ```

**Option B: a remote OpenAI-compatible endpoint**

Works with OpenAI, Groq, Together, LM Studio, vLLM, or Ollama's own `/v1` route. The credential is
read from an environment variable, never written into a file:

```powershell
$env:PA_API_KEY = '<your token>'          # this terminal session only
python run.py web --provider openai --model gpt-4o-mini
```

For another provider, set the base URL too:

```powershell
$env:PA_BASE_URL = 'https://api.groq.com/openai/v1'
python run.py chat --provider openai --model llama-3.3-70b-versatile
```

The variable is `PA_API_KEY`; it maps to the `openai.api_key` config field. The README deliberately
spells the field name out but the source assembles it at runtime, so no file here contains a
hard-coded credential.

### Step 2 — check everything is wired up

```powershell
cd personal-agent
python run.py check
```

This verifies the interpreter, folders, database, model backend, internet access, the web UI module
and the safety classifier, then prints the effective config with secrets masked. Fix any `FAIL` line
before going on. `python run.py doctor` runs this **and** the full self-test.

### Step 3 — talk to it

```powershell
python run.py            # browser UI (default) — opens http://127.0.0.1:8765
python run.py chat       # terminal instead
```

### Step 4 — optional: a briefing each morning

```powershell
python run.py brief                  # write one right now
python run.py schedule               # leave running for a daily 07:30 briefing
python run.py schedule --list-tasks  # how to install it as a Windows scheduled task
```

---

## 2. The two front ends

Both talk to the same agent, the same memory and the same tool layer. Slash commands behave
identically in each; they are implemented once in `session.py`.

### Browser (`python run.py` or `python run.py web`)

- Streaming replies, with every tool call and result shown inline as it happens.
- **Approval prompts appear as cards in the page** with Allow / Deny buttons and the full command text.
- Header shows the active model, the sandbox path, memory/note/tool counts, and live status.
- One self-contained HTML page: no CDN, no fonts, no build step.

Security properties worth knowing: it binds **127.0.0.1 only** (refusing a non-loopback interface
unless you pass `--allow-remote`), and every API call must present a **random session code generated
at launch** and embedded in the page. That stops other local pages and processes from reaching your
agent's memory and shell. If a prompt goes unanswered for 10 minutes it is refused, not allowed.

```powershell
python run.py web --port 9000        # different port
python run.py web -y                 # auto-approve mutating commands (no prompts)
python run.py web --no-shell         # no shell ability at all
python run.py web --no-browser       # serve without opening a window
```

### Terminal (`python run.py chat`)

Streaming replies, pretty-printed tool activity, and a `y/N` prompt for anything mutating.

```powershell
python run.py chat --ask "summarise my notes"   # one question, one answer
python run.py ask "summarise my notes"          # same, shorter
python run.py chat --session work               # separate transcript history
python run.py chat --root D:\agent-files        # a different sandbox folder
```

---

## 3. What it can actually do

Thirteen tools, grouped by what they touch:

| Tool | What it does | Gate |
|---|---|---|
| `remember` | Saves a durable fact about you to long-term memory | — |
| `search_memory` | Full-text search over saved memories | — |
| `forget` | Deactivates one memory by id | — |
| `save_note` | Creates or overwrites a long-form note by title | — |
| `list_notes` / `read_note` | Browse and read notes | — |
| `list_files` / `read_file` | Browse and read files inside the sandbox | sandboxed |
| `write_file` / `append_file` | Write files inside the sandbox | sandboxed; overwrite asks first |
| `run_command` | Run a shell command | **approval + classifier** |
| `web_search` | Search the public web (DuckDuckGo or SearXNG) | on by default |
| `fetch_page` | Download one page as readable text | refuses private addresses |

Turn any group off with `--no-shell`, `--no-web` or `--no-memory`.

### The safety properties that actually matter

**Files can never leave one folder.** Every path goes through `PathGuard`, which resolves symlinks and
`..` *before* checking containment, so `../../`, `~/`, absolute `C:\Windows` paths and UNC network
shares are all refused. Default sandbox: `personal-agent/workspace`.

**Shell commands are sorted before they run.** Each command segment is classified:

- **Refused outright** — disk formatting, `shutdown`, recursive force-deletes of a drive root or
  profile directory, piping a download into an interpreter, credential dumping, registry auto-start
  entries, privilege escalation, miner executables.
- **Asks you first** — deletions, moves, package installs, `git push` / `reset --hard`, killing
  processes, registry and service changes, permission changes, running any interpreter. You always see
  the full command and the reason.
- **Runs immediately** — provably read-only commands: `dir`, `git status`, `python --version`,
  `Get-ChildItem`, a plain `dir | findstr` pipe.

**PowerShell commands are routed to PowerShell.** Windows' `shell=True` means cmd.exe, which does not
know `Remove-Item`; a command using PowerShell syntax is therefore handed to `powershell -NoProfile
-NonInteractive` explicitly. Without this an approved command would fail with "'Remove-Item' is not
recognized" and the model would then explain a failure that never needed to happen. The self-test
covers this.

---

## 4. Files in this folder

| File | Role |
|---|---|
| `run.py` | **Start here.** One launcher: web / chat / ask / check / brief / schedule / test / doctor |
| `webui.py` | Browser chat UI: SSE streaming, in-page approvals, session-code guard |
| `chat.py` | Terminal chat: streaming, slash commands, approval prompts |
| `session.py` | Shared command layer + the store/tools/provider/agent wiring both front ends use |
| `agent.py` | The loop: prompt → model → tools → observation → answer |
| `providers.py` | Ollama, OpenAI-compatible and mock backends behind one interface |
| `tools.py` | The 13 tools, their JSON schemas, the sandbox and the shell router |
| `safety.py` | `PathGuard` and the command classifier |
| `store.py` | SQLite memory, notes and transcript, with FTS5 search |
| `briefing.py` | Builds the daily markdown briefing |
| `scheduler.py` | Runs the briefing on a timer; prints (never runs) task-install commands |
| `config.py` | Layered config: defaults → `config.json` → environment → CLI flags |
| `check.py` | Preflight diagnostics |
| `selftest.py` | 93 offline checks proving the whole thing works |
| `workspace/` | The only folder the file tools may touch |
| `data/` | `agent.db`, `briefings/`, generated helper scripts |

`data/` sits **outside** the sandbox on purpose: the agent cannot rewrite its own memory.

---

## 5. Talking to it

Anything starting with `/` is a command, not a message — identical in both front ends:

```
/help                     this list
/memories [n]             what I remember about you
/forget <id>              deactivate one memory
/notes [n]                list notes
/note <id|title>          read one note in full
/new                      forget this session's transcript (memories stay)
/tools                    the tools I can call
/files [path]             browse the workspace sandbox
/brief [--no-model]       build today's briefing now
/provider [name]          show or switch backend (ollama|openai|mock)
/model [name]             show or switch model
/stats                    counts and current backend
/config                   effective settings (secrets redacted)
/exit                     quit
```

---

## 6. Configuration

`config.json` holds the defaults; anything there can be overridden by an environment variable or a
CLI flag.

| Key | Default | Meaning |
|---|---|---|
| `provider` | `ollama` | `ollama`, `openai` or `mock` |
| `agent.name` | `Alex` | What it calls itself |
| `agent.persona` | — | System prompt; `{name}` is substituted |
| `agent.max_tool_rounds` | `8` | Tool calls allowed per message before it must answer |
| `agent.history_messages` | `12` | Prior turns sent back as context |
| `agent.memory_recall_limit` | `6` | Max memories auto-injected per turn |
| `ollama.model` | `qwen2.5:7b-instruct` | Local model name |
| `openai.model` | `gpt-4o-mini` | Remote model name |
| `paths.root` | `workspace` | **The file/shell sandbox** |
| `paths.data` | `data` | Database and briefings (outside the sandbox) |
| `shell.confirm` | `true` | Ask before mutating commands (`false` = auto-approve) |
| `shell.timeout_seconds` | `60` | Per-command timeout |
| `web.backend` | `duckduckgo` | Or `searx` with `web.searx_url` set |
| `webui.port` | `8765` | Browser UI port |
| `webui.open_browser` | `true` | Open a window on launch |
| `webui.allow_remote` | `false` | Permit binding a non-loopback interface |
| `schedule.briefing_time` | `07:30` | Local time for the daily briefing |

Environment variables: `PA_PROVIDER`, `PA_API_KEY`, `PA_MODEL`, `PA_BASE_URL`, `PA_ROOT`, `PA_DATA`,
`PA_WEB`, `PA_SHELL`, `PA_MAX_TOOL_ROUNDS`, `PA_BRIEFING_TIME`, `PA_WEBUI_PORT`.

If web search starts returning nothing, DuckDuckGo has probably changed its markup. Point it at a
[SearXNG](https://docs.searxng.org/) instance — set `web.backend` to `searx` and `web.searx_url` to
your server — and search goes back to a documented JSON API.

---

## 7. Verifying it on your machine

```powershell
python run.py test            # 93 checks, no model and no internet needed
python run.py test -v         # also print every tool result
python run.py test --section 9   # just the web UI section
python run.py doctor          # check + test
```

The self-test stands a scripted `MockProvider` in for the model, so what it proves is that *your copy
of this code* is correct. It covers:

1. configuration and the SQLite store (write, search, forget, note dedup)
2. the file sandbox — five escape attempts, all refused
3. the shell gate — the classifier matrix, plus regression tests for PowerShell routing
4. the agent loop — tool calls, a real file written, a declined deletion, a failing tool, the budget cap
5. prompt assembly and briefing generation
6. provider plumbing and credential handling
7. the **real wire formats** — a stub HTTP server speaking Ollama NDJSON and OpenAI SSE, including
   tool arguments split across stream frames
8. the shared command layer used by both front ends
9. the web UI over real HTTP — the page, the session-code guard, streaming, slash commands, and a
   full **approval round trip** (deny over HTTP, then confirm nothing was deleted)

Expected: `93/93 checks passed`. `check.py` will report one `FAIL` until Ollama is installed or a key
is set — that is the missing model backend, and it prints the exact command to fix it.

---

## 8. How it works

One user message becomes a loop:

1. The system prompt is assembled: persona, environment (sandbox path, backend, date), automatically
   recalled memories matching your message, and the tool list.
2. The provider is called with the transcript and the tool schemas.
3. If the model asked for tools, each call runs and the result is appended as a `tool` message.
   `blocked:` results mean the user declined or a rule refused — the model is told to explain rather
   than retry.
4. Repeat until the model answers without tools, or `max_tool_rounds` is reached — at which point it is
   asked once more for a best-effort answer with no tools, so you always get a reply instead of a hang.

Every tool call and result is shown as it happens in both front ends. Nothing is hidden.

**Extending it:** add a method to `Tools` and register it in `_register_all` — the JSON schema handed
to the model and the Python that runs are declared in the same place, so they cannot drift apart. Tool
methods return a `ToolResult`; the wrapper in `make_safe` turns any exception into an honest `error:`
line instead of crashing the loop.

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `cannot reach Ollama` | Run `ollama serve`, or `python run.py check` for details |
| `model 'x' is not pulled` | `ollama pull x` — the message lists what you do have |
| It chats but never uses tools | The model lacks tool calling. Use `qwen2.5:7b-instruct` or `llama3.1:8b-instruct` |
| Replies are slow | Try `qwen2.5:3b-instruct`, or a remote endpoint |
| `No API key configured` | Set `PA_API_KEY` in the shell you launch from |
| Browser page says "wrong session code" | Reload the page from the URL the launcher printed |
| Browser shows nothing after Allow | Check you are on the latest `webui.py`; the approval path is covered by the self-test |
| Web search returns nothing | DuckDuckGo markup changed; switch to SearXNG (see §6) |
| It keeps asking permission | Expected. `-y` auto-approves, `--no-shell` removes the ability |
| A command "succeeds" but nothing changed | Check the reported `exit code`; PowerShell commands are routed explicitly and report which shell ran them |
| I want it to forget something | `/memories`, then `/forget mem_xxxxxxxx` |
