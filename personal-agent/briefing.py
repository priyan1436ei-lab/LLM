"""Daily briefing: gather what the agent knows, optionally let the model write
the prose, then save a dated markdown file.

    python briefing.py              write today's briefing
    python briefing.py --no-model   skip the model, just assemble the material
    python briefing.py --out PATH   write somewhere else
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import ensure_dirs, load_config  # noqa: E402
from providers import ProviderError, build_provider  # noqa: E402
from store import Store  # noqa: E402
from tools import Tools  # noqa: E402

Say = Callable[[str], None]


def _deny_all(_tool: str, _prompt: str) -> bool:
    """The briefing runs unattended, so nothing mutating may ever happen."""
    return False


def gather(cfg: dict, store: Store, say: Say = print) -> dict:
    """Collect the raw material. Every field is honest about being empty."""
    material: dict = {"date": time.strftime("%A, %d %B %Y"), "searches": [], "warnings": []}

    notes = store.list_notes(limit=6)
    material["recent_notes"] = [
        {"title": n["title"], "updated": n["updated_at"], "preview": (n.get("preview") or "").strip()}
        for n in notes
    ]

    memories: list[dict] = []
    seen: set[str] = set()
    for keyword in ("today", "tomorrow", "due", "deadline", "remind", "appointment", "todo"):
        for row in store.search_memories(keyword, limit=4):
            if row["id"] not in seen:
                seen.add(row["id"])
                memories.append({"id": row["id"], "content": row["content"]})
    material["relevant_memories"] = memories[:10]

    if cfg.get("web", {}).get("enabled", True):
        tools = Tools(cfg, store, approver=_deny_all)
        for query in cfg.get("schedule", {}).get("briefing_queries", []) or []:
            say(f"  searching: {query}")
            result = tools.tool_web_search(query, count=int(cfg["web"].get("max_results", 5)))
            if result.ok:
                material["searches"].append({"query": query, "results": result.content})
            else:
                material["warnings"].append(f"search '{query}' failed: {result.content}")
    else:
        material["warnings"].append("web is disabled in config.json")

    return material


def compose_with_model(cfg: dict, provider, material: dict) -> str:
    prompt = (
        "Write a short morning briefing for the user, in plain markdown, at most 250 words.\n"
        "Use ONLY the material below. If a section has nothing, write 'nothing noted'. "
        "Never invent news, dates or events. End with a one-line 'Suggested focus'.\n\n"
        "MATERIAL\n"
        f"- date: {material['date']}\n"
        f"- saved memories that might be time-relevant: {material['relevant_memories'] or 'none'}\n"
        f"- recent notes: {material['recent_notes'] or 'none'}\n"
        f"- search results:\n{material['searches'] or 'none'}\n"
        f"- warnings: {material['warnings'] or 'none'}\n"
    )
    reply = provider.chat(
        [
            {"role": "system", "content": "You are a precise assistant. You never invent facts."},
            {"role": "user", "content": prompt},
        ],
        [],
    )
    return reply.text.strip()


def _render(cfg: dict, material: dict, body: str | None, model_note: str) -> str:
    lines = [f"# Daily briefing - {material['date']}", ""]
    if model_note:
        lines += [f"_{model_note}_", ""]
    if material["relevant_memories"]:
        lines.append("## Time-relevant memories")
        lines += [f"- {m['content']}  `{m['id']}`" for m in material["relevant_memories"]]
        lines.append("")
    if material["recent_notes"]:
        lines.append("## Recent notes")
        for note in material["recent_notes"]:
            lines.append(f"- **{note['title']}** (updated {note['updated']})")
            if note["preview"]:
                lines.append(f"  {note['preview'][:160]}")
        lines.append("")
    if material["searches"]:
        lines.append("## Web results")
        for block in material["searches"]:
            lines.append(f"### {block['query']}")
            lines.append(block["results"])
            lines.append("")
    if material["warnings"]:
        lines.append("## Warnings")
        lines += [f"- {w}" for w in material["warnings"]]
        lines.append("")
    if body:
        lines += ["## Briefing", "", body, ""]
    lines.append("---")
    lines.append(
        f"_Generated locally by the personal agent at {time.strftime('%Y-%m-%d %H:%M:%S')} "
        f"using {cfg.get('provider')}:{cfg.get(cfg.get('provider'), {}).get('model', '?')}._"
    )
    return "\n".join(lines)


def build_briefing(
    cfg: dict,
    store: Store,
    provider=None,
    use_model: bool = True,
    out_path: str | Path | None = None,
    say: Say = print,
) -> Path:
    material = gather(cfg, store, say=say)
    body: str | None = None
    model_note = ""

    if use_model:
        provider = provider or build_provider(cfg)
        try:
            body = compose_with_model(cfg, provider, material)
            model_note = f"written by {cfg.get('provider')}:{cfg.get(cfg.get('provider'), {}).get('model', '?')}"
        except ProviderError as exc:
            model_note = "model unavailable - material only"
            material["warnings"].append(f"model unavailable ({exc}); briefing left as raw material")
            say(f"  ! model unavailable: {exc}")
    else:
        model_note = "raw material only (--no-model)"

    target = Path(out_path) if out_path else Path(cfg["paths"]["data"]) / "briefings" / f"{time.strftime('%Y-%m-%d')}.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(_render(cfg, material, body, model_note), encoding="utf-8")

    say(f"  briefing written: {target}")
    return target


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="briefing.py", description="Build the daily briefing file.")
    parser.add_argument("--config", help="path to an alternative config.json")
    parser.add_argument("--no-model", action="store_true", help="skip the model, keep the raw material")
    parser.add_argument("--out", help="output markdown path")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    cfg = load_config(args.config)
    ensure_dirs(cfg)
    store = Store(Path(cfg["paths"]["data"]) / "agent.db")
    try:
        build_briefing(cfg, store, use_model=not args.no_model, out_path=args.out)
    finally:
        store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
