"""Guard rails for the two dangerous tools.

PathGuard keeps every file read/write inside one sandbox folder (symlinks and
UNC paths included). CommandGuard inspects a shell command *before* it runs and
sorts it into three buckets:

    OK       - read-only / harmless, run it
    CONFIRM  - mutating or outward-facing, ask the human first
    BLOCK    - unrecoverable or plainly hostile, never run

The classifier is deliberately conservative and always shows the human the full
command text it is asking about, so a wrong guess is cheap.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path


class SandboxError(PermissionError):
    """Raised when a path escapes the sandbox."""


class CommandBlocked(RuntimeError):
    """Raised when a command is refused outright."""


# --------------------------------------------------------------------------- #
# Paths
# --------------------------------------------------------------------------- #
class PathGuard:
    def __init__(self, root: str | os.PathLike):
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self._root_key = self._key(self.root)

    @staticmethod
    def _key(path: Path) -> str:
        text = str(path).rstrip("\\/")
        return text.lower() if os.name == "nt" else text

    def resolve(self, requested: str, must_exist: bool = False) -> Path:
        relative = (requested or ".").strip().strip('"').strip("'")
        if relative.startswith("~"):
            raise SandboxError("Refusing to touch your home directory. Use paths inside the workspace.")
        if re.match(r"^[A-Za-z]:", relative) and not relative.lower().startswith(self._key(self.root)[:2]):
            raise SandboxError(f"Absolute paths outside the workspace are not allowed: {relative}")
        if relative.startswith("\\\\") or relative.startswith("//"):
            raise SandboxError("Network (UNC) paths are not allowed.")

        candidate = Path(relative)
        full = candidate if candidate.is_absolute() else self.root / relative
        # resolve() collapses '..' and follows symlinks, so both link escapes
        # and traversal attempts land outside the root and are caught below.
        full = full.resolve()

        if self._key(full) != self._root_key and not self._key(full).startswith(self._root_key + os.sep):
            raise SandboxError(
                f"Path escapes the workspace sandbox: {requested}\nWorkspace root: {self.root}"
            )
        if must_exist and not full.exists():
            raise SandboxError(f"No such path: {requested}")
        return full

    def is_inside(self, path: str | os.PathLike) -> bool:
        try:
            self.resolve(str(path))
            return True
        except SandboxError:
            return False

    def relative(self, path: str | os.PathLike) -> str:
        try:
            return str(Path(path).resolve().relative_to(self.root)).replace("\\", "/") or "."
        except ValueError:
            return str(path)


# --------------------------------------------------------------------------- #
# Commands
# --------------------------------------------------------------------------- #
@dataclass
class Verdict:
    level: str  # "ok" | "confirm" | "block"
    reason: str = ""
    matches: list[str] = field(default_factory=list)

    @property
    def allowed(self) -> bool:
        return self.level != "block"


# (regex, human reason) — unrecoverable or clearly abusive.
BLOCK: list[tuple[str, str]] = [
    (r"\bformat\s+[a-z]:", "formats a disk volume — destroys all data on it"),
    (r"\bdiskpart\b", "raw disk partitioning can wipe drives"),
    (r"clean\s+all\b", "diskpart 'clean all' zeroes an entire disk"),
    (r"\bbcdedit\b", "editing the boot configuration can make Windows unbootable"),
    (r"\bvssadmin\b.*\bdelete\b", "deletes shadow copies / backups"),
    (r"\bwbadmin\b.*\bdelete\b", "deletes Windows backups"),
    (r"\bcipher\s+/w\b", "overwrites free space — anti-forensic wipe"),
    (r"\bsdelete\b|\bdd\s+if=.*of=\\\\?\.\\physicaldrive", "secure/raw disk wipe"),
    (r"\bmkfs(\.\w+)?\b", "formats a filesystem"),
    (r"\bshutdown\b|\brestart-computer\b|\bstop-computer\b", "shuts down or restarts the machine"),
    (r"\bhalt\b", "powers off the machine"),
    (r"\bnet\s+user\b.*\/add", "creates local accounts behind your back"),
    (r"\bnetsh\b.*\b(firewall|advfirewall)\b", "changes firewall rules"),
    (r"\breg\s+delete\s+hklm", "deletes keys from the system registry hive"),
    (r"\bremove-item\b(?=.*-recurse\b)(?=.*-force\b).*(\s[a-z]:[\\/]*\s*$|\\windows\b|\\users\\[^\\/\s]+[\\/]*\s*$)",
     "recursively force-deletes a drive root or a profile directory"),
    (r"\brm\s+-rf?\s+(/|\$home|~)(\s|$)", "recursively deletes the root or your home directory"),
    (r"\bdel\s+/[sfq]\b.*\\windows\b", "deletes system files"),
    (r"(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)[^|]*\|\s*(bash|sh|zsh|pwsh|powershell|iex|invoke-expression)",
     "pipes a downloaded script straight into an interpreter"),
    (r"\b(iex|invoke-expression)\b[^;|]*\b(frombase64string|downloadstring|downloaddata|iwr|irm|curl|wget)",
     "executes remotely fetched or base64-encoded code"),
    (r"\bnew-localuser\b", "creates a local user account"),
    (r"\b(net\s+localgroup\s+administrators|add-localgroupmember)\b", "grants administrator rights"),
    (r"\bschtasks\b.*\/create\b.*\/(ru|rl)\s+system", "installs a SYSTEM-level scheduled task"),
    (r"\breg\s+add\b.*\\run\b", "installs an auto-start registry entry"),
    (r"\bnc\b\s+-e\b|\bncat\b\s+.*-e\b", "opens a reverse shell listener"),
    (r"\bmimikatz\b|\bsekurlsa\b|\blsass\b", "credential dumping"),
    (r"\bxmrig\b|\bstratum\+tcp\b|\brandomx\b|\bnanopool\b|\bminexmr\b", "cryptocurrency mining"),
]

# Mutating, install-y or outward-facing — ask first.
CONFIRM: list[tuple[str, str]] = [
    (r"\bremove-item\b|\brmdir\b|\brd\b|\bdel\b|\berase\b|\brm\b|\bshutil\.rmtree\b", "deletes files"),
    (r"\bmove-item\b|\bmv\b|\brename-item\b|\bren\b", "moves or renames files"),
    (r"\bclear-content\b|\btruncate\b", "empties a file"),
    (r"\bpip\s+(install|uninstall)\b|\bpython\s+-m\s+pip\b.*\b(install|uninstall)\b", "installs/removes Python packages"),
    (r"\bnpm\s+(i|install|uninstall|remove|ci)\b|\byarn\s+add\b|\bpnpm\s+add\b", "installs/removes npm packages"),
    (r"\bwinget\s+install\b|\bchoco\s+install\b|\bscoop\s+install\b", "installs system software"),
    (r"\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s*\.|branch\s+-D)\b", "rewrites or publishes git history"),
    (r"\bgit\s+config\b.*--global\b", "changes global git configuration"),
    (r"\bstop-process\b|\btaskkill\b|\bkill\b\s", "terminates running processes"),
    (r"\bstart-process\b|\bstart-job\b", "launches a new process"),
    (r"\bset-itemproperty\b|\bnew-itemproperty\b|\bremove-itemproperty\b|\breg\s+(add|delete|import)\b",
     "modifies the Windows registry"),
    (r"\bnew-service\b|\bsc\s+(create|config|delete|stop|start)\b|\bset-service\b", "changes Windows services"),
    (r"\bicacls\b|\btakeown\b|\battrib\b|\bchmod\b|\bchown\b", "changes permissions / ownership"),
    (r"\bschtasks\b|\bregister-scheduledtask\b", "creates a scheduled task"),
    (r"\bset-content\b|\bout-file\b", "rewrites a file's contents"),
    (r"\bset-executionpolicy\b", "changes the PowerShell execution policy"),
    (r"\bnetsh\b|\bipconfig\s+/release\b|\broute\s+(add|delete)\b", "changes network configuration"),
    (r"\binvoke-expression\b|\biex\b|\bpowershell\s+-enc", "runs dynamically generated code"),
    (r"^\s*(python|python3|node|pwsh|powershell|cmd)\b", "runs an interpreter"),
    (r"\bbase64\b.*(-d|--decode|frombase64)", "decodes an encoded payload"),
    (r"\b(hashcat|john|hydra|sqlmap|nmap|masscan|ffuf|gobuster|nikto)\b", "runs an offensive-security tool"),
    (r"\bsudo\b|\brunas\b|\bstart-process\b.*-verb\s+runas", "attempts privilege elevation"),
]

# Provably read-only invocations. Checked BEFORE the confirm table so that asking
# "what version is installed" never turns into an approval prompt.
SAFE_READONLY: list[str] = [
    r"^\s*\S+\s+(--version|-v|-V|--help|-h)\s*$",
    r"^\s*(python|python3|node|npm|git|pip|pwsh|powershell|cmd|dotnet|java|go|cargo|ollama|docker|tsc)\s+version\s*$",
    r"^\s*(dir|ls|pwd|cd|echo|type|cat|where|which|whoami|hostname|date|time|ipconfig)\b",
    r"^\s*git\s+(status|log|diff|branch|show|remote)\b",
    r"^\s*(find|findstr|select-string|grep|rg|sort|measure-object|get-childitem|get-content|get-item|test-path)\b",
]
_SAFE_READONLY = [re.compile(pattern, re.I) for pattern in SAFE_READONLY]

_SEGMENT = re.compile(r"(?<!\|)\|(?!\|)|;|&&|\|\||\r?\n")


def is_read_only(segment: str) -> bool:
    return any(pattern.search(segment or "") for pattern in _SAFE_READONLY)


def split_segments(command: str) -> list[str]:
    # Only split on ';', '&&', '||' and newlines. A bare single pipe is left intact
    # so that patterns such as "download | execute" stay visible as one string; the
    # two pipe-based rules are therefore evaluated before segmentation in classify().
    parts = [p.strip() for p in re.split(r";|&&|\|\||\r?\n", command or "")]
    return [p for p in parts if p]


def classify(command: str) -> Verdict:
    """Sort a shell command into ok / confirm / block."""
    text = (command or "").strip()
    if not text:
        return Verdict("block", "empty command")

    segments = split_segments(text) or [text]

    # Two rules only make sense on the WHOLE line, because their meaning lives in
    # the connection between segments: "download | interpreter" and "decoded | interpreter".
    combined = text.lower()
    for pattern, reason in BLOCK:
        if "|" in pattern and re.search(pattern, combined):
            return Verdict("block", f"Refused: {reason}", [reason])

    blocks: list[str] = []
    confirms: list[str] = []
    for segment in segments:
        if is_read_only(segment):
            continue
        low = segment.lower()
        for pattern, reason in BLOCK:
            if re.search(pattern, low):
                blocks.append(f"{reason}  [{segment[:80]}]")
                break
        else:
            for pattern, reason in CONFIRM:
                if re.search(pattern, low):
                    confirms.append(f"{reason}  [{segment[:80]}]")
                    break

    if blocks:
        return Verdict("block", "Refused: " + blocks[0], blocks)
    if confirms:
        # Several segments confirming for the same reason is noise, not signal.
        unique = list(dict.fromkeys(confirms))
        return Verdict("confirm", "Needs your approval: " + "; ".join(unique[:3]), unique)
    return Verdict("ok", "read-only")
