"""SQLite store: long-term memory, notes and chat history.

Lives in the data directory, deliberately *outside* the file-tool sandbox, so
the agent can never damage its own brain by writing to it.

Full-text search uses SQLite's FTS5 when the interpreter provides it, and falls
back to LIKE matching otherwise. Both paths are always run and merged, because
FTS tokenisation copes poorly with Chinese text while LIKE copes poorly with
ranking.
"""

from __future__ import annotations

import re
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS memories (
    id          TEXT PRIMARY KEY,
    content     TEXT NOT NULL,
    tags        TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT 'cli',
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    tags        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(active);
"""

FTS_SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tags, content_rowid='rowid');
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, body, tags, content_rowid='rowid');
"""

_WORD = re.compile(r"[0-9A-Za-z_]+")


def now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def fts_query(text: str) -> str:
    """Turn free text into a safe FTS5 OR-query (never lets quoting explode)."""
    words = _WORD.findall(text or "")
    if not words:
        return ""
    return " OR ".join(f'"{w}"' for w in words[:12])


class Store:
    def __init__(self, db_path: str | Path):
        self.path = Path(db_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self.has_fts = True
        try:
            self.conn.executescript(FTS_SCHEMA)
        except sqlite3.OperationalError:
            self.has_fts = False
        self.conn.commit()

    def close(self) -> None:
        try:
            self.conn.close()
        except Exception:  # noqa: BLE001
            pass

    # ---------------------------------------------------------------- memory
    def add_memory(self, content: str, tags: str = "", source: str = "cli") -> str:
        content = (content or "").strip()
        if not content:
            raise ValueError("memory content cannot be empty")
        memory_id = new_id("mem")
        stamp = now()
        self.conn.execute(
            "INSERT INTO memories (id, content, tags, source, active, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, 1, ?, ?)",
            (memory_id, content, tags or "", source, stamp, stamp),
        )
        self._fts_upsert("memories_fts", "content, tags", memory_id, [content, tags or ""])
        self.conn.commit()
        return memory_id

    def update_memory(self, memory_id: str, content: str | None = None, tags: str | None = None) -> bool:
        row = self.conn.execute("SELECT * FROM memories WHERE id = ?", (memory_id,)).fetchone()
        if not row:
            return False
        content = row["content"] if content is None else content.strip()
        tags = row["tags"] if tags is None else tags
        self.conn.execute(
            "UPDATE memories SET content = ?, tags = ?, updated_at = ? WHERE id = ?",
            (content, tags, now(), memory_id),
        )
        self._fts_upsert("memories_fts", "content, tags", memory_id, [content, tags or ""])
        self.conn.commit()
        return True

    def forget_memory(self, memory_id: str) -> bool:
        cursor = self.conn.execute("UPDATE memories SET active = 0, updated_at = ? WHERE id = ?", (now(), memory_id))
        self._fts_delete("memories_fts", memory_id)
        self.conn.commit()
        return cursor.rowcount > 0

    def list_memories(self, limit: int = 20, include_inactive: bool = False) -> list[dict[str, Any]]:
        where = "" if include_inactive else "WHERE active = 1"
        rows = self.conn.execute(
            f"SELECT * FROM memories {where} ORDER BY updated_at DESC, id DESC LIMIT ?", (int(limit),)
        ).fetchall()
        return [dict(r) for r in rows]

    def search_memories(self, query: str, limit: int = 6) -> list[dict[str, Any]]:
        return self._search("memories", "memories_fts", "content, tags", query, limit, "active = 1")

    # ----------------------------------------------------------------- notes
    def add_note(self, title: str, body: str = "", tags: str = "") -> str:
        title = (title or "").strip() or "untitled"
        note_id = new_id("note")
        stamp = now()
        self.conn.execute(
            "INSERT INTO notes (id, title, body, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (note_id, title, body or "", tags or "", stamp, stamp),
        )
        self._fts_upsert("notes_fts", "title, body, tags", note_id, [title, body or "", tags or ""])
        self.conn.commit()
        return note_id

    def update_note(self, note_id: str, title: str | None = None, body: str | None = None, tags: str | None = None) -> bool:
        row = self.conn.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
        if not row:
            return False
        title = row["title"] if title is None else title.strip() or row["title"]
        body = row["body"] if body is None else body
        tags = row["tags"] if tags is None else tags
        self.conn.execute(
            "UPDATE notes SET title = ?, body = ?, tags = ?, updated_at = ? WHERE id = ?",
            (title, body, tags, now(), note_id),
        )
        self._fts_upsert("notes_fts", "title, body, tags", note_id, [title, body or "", tags or ""])
        self.conn.commit()
        return True

    def delete_note(self, note_id: str) -> bool:
        cursor = self.conn.execute("DELETE FROM notes WHERE id = ?", (note_id,))
        self._fts_delete("notes_fts", note_id)
        self.conn.commit()
        return cursor.rowcount > 0

    def get_note(self, note_id: str) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
        return dict(row) if row else None

    def find_note_by_title(self, title: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM notes WHERE lower(title) = lower(?) ORDER BY updated_at DESC LIMIT 1", (title.strip(),)
        ).fetchone()
        return dict(row) if row else None

    def list_notes(self, limit: int = 20) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT id, title, tags, substr(body, 1, 120) AS preview, updated_at"
            " FROM notes ORDER BY updated_at DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
        return [dict(r) for r in rows]

    def search_notes(self, query: str, limit: int = 5) -> list[dict[str, Any]]:
        return self._search("notes", "notes_fts", "title, body, tags", query, limit, None)

    # -------------------------------------------------------------- messages
    def append_message(self, session_id: str, role: str, content: str) -> None:
        self.conn.execute(
            "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
            (session_id, role, content or "", now()),
        )
        self.conn.commit()

    def recent_messages(self, session_id: str, limit: int = 12) -> list[dict[str, str]]:
        rows = self.conn.execute(
            "SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?",
            (session_id, int(limit)),
        ).fetchall()
        return [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]

    def clear_session(self, session_id: str) -> int:
        cursor = self.conn.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
        self.conn.commit()
        return cursor.rowcount

    def counts(self) -> dict[str, int]:
        return {
            "memories": self.conn.execute("SELECT COUNT(*) c FROM memories WHERE active = 1").fetchone()["c"],
            "notes": self.conn.execute("SELECT COUNT(*) c FROM notes").fetchone()["c"],
            "messages": self.conn.execute("SELECT COUNT(*) c FROM messages").fetchone()["c"],
        }

    # --------------------------------------------------------------- internals
    def _search(
        self,
        table: str,
        fts_table: str,
        columns: str,
        query: str,
        limit: int,
        extra_where: str | None,
    ) -> list[dict[str, Any]]:
        query = (query or "").strip()
        if not query:
            return []
        ordered: list[dict[str, Any]] = []
        seen: set[str] = set()
        clause = f" AND {extra_where}" if extra_where else ""

        if self.has_fts:
            match = fts_query(query)
            if match:
                try:
                    rows = self.conn.execute(
                        f"SELECT t.* FROM {table} t JOIN {fts_table} f ON f.rowid = t.rowid"
                        f" WHERE {fts_table} MATCH ?{clause.replace('active', 't.active')}"
                        f" ORDER BY rank LIMIT ?",
                        (match, int(limit)),
                    ).fetchall()
                    for row in rows:
                        item = dict(row)
                        seen.add(item["id"])
                        ordered.append(item)
                except sqlite3.OperationalError:
                    pass

        like = f"%{query.lower()}%"
        like_where = " OR ".join(f"lower({col.strip()}) LIKE ?" for col in columns.split(","))
        params: list[Any] = [like for _ in columns.split(",")]
        rows = self.conn.execute(
            f"SELECT * FROM {table} WHERE ({like_where}){clause} ORDER BY updated_at DESC LIMIT ?",
            (*params, int(limit)),
        ).fetchall()
        for row in rows:
            item = dict(row)
            if item["id"] not in seen:
                seen.add(item["id"])
                ordered.append(item)

        return ordered[: int(limit)]

    def _rowid(self, table: str, item_id: str) -> int | None:
        row = self.conn.execute(f"SELECT rowid FROM {table} WHERE id = ?", (item_id,)).fetchone()
        return int(row["rowid"]) if row else None

    def _fts_upsert(self, fts_table: str, columns: str, item_id: str, values: list[str]) -> None:
        if not self.has_fts:
            return
        table = "memories" if fts_table.startswith("memories") else "notes"
        rowid = self._rowid(table, item_id)
        if rowid is None:
            return
        try:
            self.conn.execute(f"DELETE FROM {fts_table} WHERE rowid = ?", (rowid,))
            placeholders = ", ".join("?" for _ in values)
            self.conn.execute(
                f"INSERT INTO {fts_table} (rowid, {columns}) VALUES (?, {placeholders})", (rowid, *values)
            )
        except sqlite3.OperationalError:
            self.has_fts = False

    def _fts_delete(self, fts_table: str, item_id: str) -> None:
        if not self.has_fts:
            return
        table = "memories" if fts_table.startswith("memories") else "notes"
        rowid = self._rowid(table, item_id)
        if rowid is None:
            return
        try:
            self.conn.execute(f"DELETE FROM {fts_table} WHERE rowid = ?", (rowid,))
        except sqlite3.OperationalError:
            pass
