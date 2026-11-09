"""Telegram alerts for the site owner. Failures are logged and never reach the user."""

import html
import logging
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from .config import config

log = logging.getLogger("mohora.telegram")


async def call(method: str, **payload: Any) -> dict | None:
    if not config.telegram_token:
        return None
    url = f"https://api.telegram.org/bot{config.telegram_token}/{method}"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            data = (await client.post(url, json=payload)).json()
    except (httpx.HTTPError, ValueError) as exc:
        # The URL contains the bot token, so log only the error type.
        log.warning("Telegram %s failed (%s)", method, type(exc).__name__)
        return None
    if not data.get("ok"):
        log.warning("Telegram %s rejected: %s", method, data.get("description"))
    return data


async def send_admin(text: str, buttons: list[list[dict]] | None = None) -> None:
    if not config.telegram_enabled:
        return
    payload: dict[str, Any] = {
        "chat_id": config.telegram_chat_id,
        "text": text,
        "parse_mode": "HTML",
        "link_preview_options": {"is_disabled": True},
    }
    if buttons:
        payload["reply_markup"] = {"inline_keyboard": buttons}
    await call("sendMessage", **payload)


def local_time(dt: datetime) -> str:
    local = dt.replace(tzinfo=UTC).astimezone(ZoneInfo(config.tz))
    return f"{local.day} {local:%b %Y, %H:%M}"


def user_card(user: Any) -> dict:
    # A plain snapshot, because background tasks run after the DB session is closed.
    return {"id": user.id, "name": user.name, "email": user.email, "created_at": user.created_at}


def new_user_text(card: dict, number: int, ctx: dict) -> str:
    where = [ctx.get("country", ""), ctx.get("device", "")]
    if ctx.get("source"):
        where.append(f"via {ctx['source']}")
    lines = [
        f"<b>New user #{number}</b>",
        html.escape(card["name"] or "(no name)"),
        html.escape(card["email"]),
        html.escape(", ".join(w for w in where if w)),
        local_time(card["created_at"]),
        f"{config.base_url}/admin/users/{card['id']}",
    ]
    return "\n".join(line for line in lines if line)


def first_interview_text(card: dict, pack_title: str, overall: float | None) -> str:
    score = f", scored {overall:.1f}/5" if overall else ""
    return (
        f"{html.escape(card['name'] or card['email'])} finished their first interview: "
        f"{html.escape(pack_title)}{score}\n{config.base_url}/admin/users/{card['id']}"
    )


def feedback_text(who: str, kind: str, message: str, page: str) -> str:
    where = f" on {html.escape(page)}" if page else ""
    return f"<b>Feedback ({kind})</b> from {html.escape(who)}{where}\n\n{html.escape(message[:1500])}"


async def new_user(card: dict, number: int, ctx: dict) -> None:
    await send_admin(new_user_text(card, number, ctx))


async def first_interview(card: dict, pack_title: str, overall: float | None) -> None:
    await send_admin(first_interview_text(card, pack_title, overall))
