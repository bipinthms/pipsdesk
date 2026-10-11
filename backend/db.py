"""SQLite persistence: settings/state (JSON key-value), news events, and the order journal."""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

from sqlalchemy import Column, Text
from sqlmodel import Field, Session, SQLModel, create_engine, select


class KeyValue(SQLModel, table=True):
    key: str = Field(primary_key=True)
    value: str = Field(sa_column=Column(Text, nullable=False))


class NewsEvent(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    time_utc: int = Field(index=True)
    title: str


class JournalEntry(SQLModel, table=True):
    """One row per order attempt (accepted or not) and per notable event."""

    id: int | None = Field(default=None, primary_key=True)
    time_utc: float = Field(index=True)
    # open | pending | modify_position | modify_order | close | cancel | flatten | settings
    action: str
    # accepted | blocked (risk engine) | rejected (broker) | error | info
    status: str = Field(index=True)
    symbol: str | None = None
    side: str | None = None
    volume: float | None = None
    price: float | None = None
    sl: float | None = None
    tp: float | None = None
    ticket: int | None = None
    retcode: int | None = None
    risk_amount: float | None = None
    reason: str = ""
    note: str = ""
    details: str = Field(default="{}", sa_column=Column(Text, nullable=False, default="{}"))


class Database:
    def __init__(self, path: Path | str) -> None:
        url = "sqlite://" if str(path) == ":memory:" else f"sqlite:///{Path(path)}"
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        kwargs: dict[str, Any] = {"connect_args": {"check_same_thread": False}}
        if str(path) == ":memory:":
            from sqlalchemy.pool import StaticPool

            kwargs["poolclass"] = StaticPool  # one shared in-memory DB across threads
        self.engine = create_engine(url, **kwargs)
        self._lock = threading.Lock()  # SQLite allows one writer at a time
        SQLModel.metadata.create_all(self.engine)

    # -- key/value JSON ------------------------------------------------------

    def get_json(self, key: str) -> Any | None:
        with Session(self.engine) as s:
            row = s.get(KeyValue, key)
            return json.loads(row.value) if row else None

    def set_json(self, key: str, value: Any) -> None:
        with self._lock, Session(self.engine) as s:
            s.merge(KeyValue(key=key, value=json.dumps(value)))
            s.commit()

    # -- news events ---------------------------------------------------------

    def news_events(self, since_utc: float | None = None) -> list[NewsEvent]:
        with Session(self.engine) as s:
            q = select(NewsEvent).order_by(NewsEvent.time_utc)  # type: ignore[arg-type]
            if since_utc is not None:
                q = q.where(NewsEvent.time_utc >= since_utc)
            return list(s.exec(q))

    def add_news_event(self, time_utc: int, title: str) -> NewsEvent:
        with self._lock, Session(self.engine) as s:
            ev = NewsEvent(time_utc=time_utc, title=title)
            s.add(ev)
            s.commit()
            s.refresh(ev)
            return ev

    def delete_news_event(self, event_id: int) -> bool:
        with self._lock, Session(self.engine) as s:
            ev = s.get(NewsEvent, event_id)
            if ev is None:
                return False
            s.delete(ev)
            s.commit()
            return True

    # -- journal -------------------------------------------------------------

    def journal_add(self, *, details: dict[str, Any] | None = None, **fields: Any) -> JournalEntry:
        entry = JournalEntry(time_utc=fields.pop("time_utc", time.time()), details=json.dumps(details or {}), **fields)
        with self._lock, Session(self.engine) as s:
            s.add(entry)
            s.commit()
            s.refresh(entry)
            return entry

    def journal_set_note(self, entry_id: int, note: str) -> JournalEntry | None:
        with self._lock, Session(self.engine) as s:
            entry = s.get(JournalEntry, entry_id)
            if entry is None:
                return None
            entry.note = note
            s.add(entry)
            s.commit()
            s.refresh(entry)
            return entry

    def journal_list(self, limit: int = 200, before_id: int | None = None, status: str | None = None) -> list[JournalEntry]:
        with Session(self.engine) as s:
            q = select(JournalEntry).order_by(JournalEntry.id.desc()).limit(limit)  # type: ignore[union-attr]
            if before_id is not None:
                q = q.where(JournalEntry.id < before_id)  # type: ignore[operator]
            if status:
                q = q.where(JournalEntry.status == status)
            return list(s.exec(q))
