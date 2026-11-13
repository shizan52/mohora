"""Template rendering, CSRF and the Jinja filters shared by every router."""

import re
import secrets
from datetime import datetime
from typing import Any

from fastapi import HTTPException, Request
from fastapi.templating import Jinja2Templates
from markupsafe import Markup, escape

from .config import ROOT, config
from .db import cached_flags, utcnow

templates = Jinja2Templates(directory=ROOT / "templates")


def _asset_version() -> str:
    static = ROOT / "static"
    mtimes = [p.stat().st_mtime for p in static.rglob("*") if p.is_file()]
    return str(int(max(mtimes, default=0)))


def csrf_token(request: Request) -> str:
    token = request.session.get("csrf")
    if not token:
        token = request.session["csrf"] = secrets.token_urlsafe(24)
    return token


async def check_csrf(request: Request) -> None:
    expected = request.session.get("csrf")
    sent = request.headers.get("x-csrf-token")
    if sent is None and "form" in request.headers.get("content-type", ""):
        sent = (await request.form()).get("csrf")
    if not expected or not sent or not secrets.compare_digest(expected, str(sent)):
        raise HTTPException(403, "Security check failed. Reload the page and try again.")


def render(request: Request, name: str, status: int = 200, **ctx: Any):
    ctx.setdefault("user", None)
    ctx["csrf"] = csrf_token(request)
    return templates.TemplateResponse(request, name, ctx, status_code=status)


def ago(dt: datetime | None) -> str:
    if dt is None:
        return ""
    seconds = int((utcnow() - dt).total_seconds())
    if seconds < 60:
        return "just now"
    for unit, size in (("day", 86400), ("hour", 3600), ("minute", 60)):
        if seconds >= size:
            n = seconds // size
            return f"{n} {unit}{'s' if n > 1 else ''} ago"
    return ""


def short_date(dt: datetime | None) -> str:
    return "" if dt is None else f"{dt.day} {dt:%b %Y}"


def mark_answer(text: str, quotes: list[dict] | None = None, fillers: list[str] | None = None) -> Markup:
    """Escape an answer and wrap coach quotes and filler words in <mark> tags."""
    spans: list[tuple[int, int, str, str]] = []
    lower = text.lower()
    for q in quotes or []:
        needle = (q.get("text") or "").strip().strip('"').lower()
        start = lower.find(needle) if len(needle) > 3 else -1
        if start >= 0:
            kind = "strong" if q.get("type") == "strong" else "weak"
            spans.append((start, start + len(needle), kind, q.get("note", "")))
    for word in fillers or []:
        pattern = rf"(?<![\wঀ-৿]){re.escape(word)}(?![\wঀ-৿])"
        for m in re.finditer(pattern, text, flags=re.IGNORECASE):
            spans.append((m.start(), m.end(), "filler", "filler word"))

    spans.sort(key=lambda s: (s[0], -(s[1] - s[0])))
    out, pos = [], 0
    for start, end, kind, note in spans:
        if start < pos:
            continue  # overlapping mark; the earlier, longer one wins
        out.append(escape(text[pos:start]))
        title = f' title="{escape(note)}"' if note else ""
        out.append(Markup(f'<mark class="m-{kind}"{title}>') + escape(text[start:end]) + Markup("</mark>"))
        pos = end
    out.append(escape(text[pos:]))
    return Markup("").join(out)


templates.env.globals.update(app_name=config.app_name, v=_asset_version(), site=cached_flags, house=config.house)
templates.env.filters.update(ago=ago, short_date=short_date, mark_answer=mark_answer)
