import json
import secrets
import time
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any, ClassVar

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    create_engine,
    event,
    inspect,
    select,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from .config import ROOT, config


def utcnow() -> datetime:
    # SQLite has no timezone type; everything is stored as naive UTC.
    return datetime.now(UTC).replace(tzinfo=None)


class Base(DeclarativeBase):
    type_annotation_map: ClassVar[dict] = {dict[str, Any]: JSON, list[Any]: JSON}


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    google_sub: Mapped[str | None] = mapped_column(String(64), unique=True)
    email: Mapped[str] = mapped_column(String(255), unique=True)
    name: Mapped[str] = mapped_column(String(200), default="")
    avatar_url: Mapped[str] = mapped_column(String(500), default="")
    locale: Mapped[str] = mapped_column(String(20), default="")
    country: Mapped[str] = mapped_column(String(8), default="")
    source: Mapped[str] = mapped_column(String(80), default="")
    status: Mapped[str] = mapped_column(String(16), default="active")
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    pass_until: Mapped[datetime | None] = mapped_column(DateTime)
    referral_code: Mapped[str] = mapped_column(
        String(16), unique=True, default=lambda: secrets.token_urlsafe(6)
    )
    referred_by: Mapped[int | None] = mapped_column(Integer)
    goal: Mapped[dict[str, Any]] = mapped_column(default=dict)
    prefs: Mapped[dict[str, Any]] = mapped_column(default=dict)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    @property
    def first_name(self) -> str:
        return (self.name or self.email).split()[0].split("@")[0]

    @property
    def has_pass(self) -> bool:
        return self.pass_until is not None and self.pass_until > utcnow()

    @property
    def saves_transcripts(self) -> bool:
        return self.prefs.get("save_transcripts", True)


class InterviewSession(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    guest_token: Mapped[str | None] = mapped_column(String(48), index=True)
    pack_slug: Mapped[str] = mapped_column(String(64))
    config: Mapped[dict[str, Any]] = mapped_column(default=dict)
    status: Mapped[str] = mapped_column(String(16), default="active")
    started_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime)
    duration_s: Mapped[int] = mapped_column(Integer, default=0)
    overall: Mapped[float | None] = mapped_column(Float)
    scores: Mapped[dict[str, Any]] = mapped_column(default=dict)
    metrics: Mapped[dict[str, Any]] = mapped_column(default=dict)
    transcript: Mapped[list[Any] | None] = mapped_column()
    report: Mapped[dict[str, Any] | None] = mapped_column()
    share_slug: Mapped[str | None] = mapped_column(String(24), unique=True)


class ReviewItem(Base):
    """A question the user answered weakly, scheduled to come back until it lands."""

    __tablename__ = "review_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    question: Mapped[str] = mapped_column(Text)
    pack_slug: Mapped[str] = mapped_column(String(64))
    last_score: Mapped[float] = mapped_column(Float, default=0)
    interval_days: Mapped[int] = mapped_column(Integer, default=1)
    reps: Mapped[int] = mapped_column(Integer, default=0)
    due_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Story(Base):
    __tablename__ = "stories"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    situation: Mapped[str] = mapped_column(Text, default="")
    task: Mapped[str] = mapped_column(Text, default="")
    action: Mapped[str] = mapped_column(Text, default="")
    result: Mapped[str] = mapped_column(Text, default="")
    tags: Mapped[list[Any]] = mapped_column(default=list)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Pack(Base):
    __tablename__ = "packs"

    slug: Mapped[str] = mapped_column(String(64), primary_key=True)
    data: Mapped[dict[str, Any]] = mapped_column()
    pro: Mapped[bool] = mapped_column(Boolean, default=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    sort: Mapped[int] = mapped_column(Integer, default=100)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Payment(Base):
    __tablename__ = "payments"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    network: Mapped[str] = mapped_column(String(16))
    tx_id: Mapped[str] = mapped_column(String(100), unique=True)
    amount: Mapped[float] = mapped_column(Float)
    days: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), default="pending")
    note: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime)
    reviewed_by: Mapped[str] = mapped_column(String(255), default="")


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON)


class Event(Base):
    __tablename__ = "events"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(Integer, index=True)
    name: Mapped[str] = mapped_column(String(48), index=True)
    props: Mapped[dict[str, Any]] = mapped_column(default=dict)
    ts: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class Feedback(Base):
    __tablename__ = "feedback"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(24), default="general")
    message: Mapped[str] = mapped_column(Text)
    page: Mapped[str] = mapped_column(String(200), default="")
    status: Mapped[str] = mapped_column(String(16), default="new")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    actor: Mapped[str] = mapped_column(String(255))
    action: Mapped[str] = mapped_column(String(64))
    target: Mapped[str] = mapped_column(String(255), default="")
    details: Mapped[dict[str, Any]] = mapped_column(default=dict)
    ts: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


engine = create_engine(
    f"sqlite:///{config.db_path.as_posix()}", connect_args={"check_same_thread": False}
)
SessionLocal = sessionmaker(engine, expire_on_commit=False)


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_conn, _record) -> None:
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.execute("PRAGMA busy_timeout=5000")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.close()


def get_db() -> Iterator[Session]:
    with SessionLocal() as db:
        yield db


# Schema changes after the first release go here, in order. create_all() only adds
# missing tables; columns added to existing tables need an ALTER step.
MIGRATIONS: list[str] = [
    "ALTER TABLE sessions ADD COLUMN share_slug VARCHAR(24)",
    "CREATE UNIQUE INDEX IF NOT EXISTS ix_sessions_share_slug ON sessions (share_slug)",
]

DEFAULT_FLAGS: dict[str, Any] = {
    "signups_open": True,
    "guest_mode": True,
    "maintenance": False,
    "relay": True,
    "announcement": "",
    "contact_email": "",
}

DEFAULT_BILLING: dict[str, Any] = {"price_usdt": 1, "days": 30, "trc20_address": "", "bep20_address": ""}

PACKS_FILE = ROOT / "app" / "packs.json"


def init_db() -> None:
    config.db_path.parent.mkdir(parents=True, exist_ok=True)
    # A brand-new database gets every column from create_all, so it starts fully migrated.
    fresh = not inspect(engine).has_table("users")
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        version = len(MIGRATIONS) if fresh else conn.execute(text("PRAGMA user_version")).scalar() or 0
        for step in MIGRATIONS[version:]:
            conn.execute(text(step))
        conn.execute(text(f"PRAGMA user_version = {len(MIGRATIONS)}"))
    with SessionLocal() as db:
        seed(db)


def seed(db: Session) -> None:
    """Add packs, prompts and settings that don't exist yet. Admin edits are never overwritten."""
    data = json.loads(PACKS_FILE.read_text(encoding="utf-8"))
    existing = {row.slug: row for row in db.scalars(select(Pack))}
    for i, pack in enumerate(data["packs"]):
        row = existing.get(pack["slug"])
        if row is None:
            db.add(Pack(slug=pack["slug"], data=pack, pro=pack.get("pro", False), sort=i))
        elif pack.keys() - row.data.keys():
            # A newer version of the app added fields to this type: fill them in, keep the rest.
            row.data = {**pack, **row.data}
    prompts = get_setting(db, "prompts") or {}
    missing = {k: v for k, v in data["prompts"].items() if k not in prompts}
    if missing or not prompts:
        set_setting(db, "prompts", {**prompts, **missing})
    if get_setting(db, "journey") is None:
        set_setting(db, "journey", data["journey"])
    if get_setting(db, "digest_date") is None:
        set_setting(db, "digest_date", "")
    db.commit()


def active_packs(db: Session) -> list[dict]:
    rows = db.scalars(select(Pack).where(Pack.active).order_by(Pack.sort))
    return [{**p.data, "slug": p.slug, "pro": p.pro} for p in rows]


def get_setting(db: Session, key: str, default: Any = None) -> Any:
    row = db.get(Setting, key)
    return default if row is None else row.value


def set_setting(db: Session, key: str, value: Any) -> None:
    row = db.get(Setting, key)
    if row is None:
        db.add(Setting(key=key, value=value))
    else:
        row.value = value
    db.commit()


def site_flags(db: Session) -> dict[str, Any]:
    return {**DEFAULT_FLAGS, **(get_setting(db, "flags") or {})}


def billing_settings(db: Session) -> dict[str, Any]:
    return {**DEFAULT_BILLING, **(get_setting(db, "billing") or {})}


_flags_cache: tuple[float, dict[str, Any]] = (0.0, {})


def cached_flags() -> dict[str, Any]:
    """Flags are read on every request, so keep them for a few seconds."""
    global _flags_cache
    if time.monotonic() - _flags_cache[0] > 15:
        with SessionLocal() as db:
            _flags_cache = (time.monotonic(), site_flags(db))
    return _flags_cache[1]


def forget_flags() -> None:
    global _flags_cache
    _flags_cache = (0.0, {})


def log_event(db: Session, name: str, user_id: int | None = None, **props: Any) -> None:
    db.add(Event(name=name, user_id=user_id, props=props))
    db.commit()


def audit(db: Session, actor: str, action: str, target: str = "", **details: Any) -> None:
    db.add(AuditLog(actor=actor, action=action, target=target, details=details))
    db.commit()
