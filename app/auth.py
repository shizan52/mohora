"""Google sign-in, the local development sign-in, and request guards."""

import re
import secrets

from authlib.integrations.starlette_client import OAuth, OAuthError
from fastapi import APIRouter, BackgroundTasks, Depends, Form, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session

from . import notify
from .config import config
from .db import InterviewSession, User, get_db, log_event, site_flags, utcnow
from .web import check_csrf, render

router = APIRouter()
oauth = OAuth()
if config.google_enabled:
    oauth.register(
        "google",
        client_id=config.google_client_id,
        client_secret=config.google_client_secret,
        server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
        client_kwargs={"scope": "openid email profile", "prompt": "select_account"},
    )


class LoginRequired(Exception):
    """Raised by guards. main.py turns it into a redirect for pages and a 401 for the API."""


def is_admin(user: User) -> bool:
    return user.is_admin or user.email.lower() in config.admin_emails


def current_user(request: Request, db: Session = Depends(get_db)) -> User | None:
    uid = request.session.get("uid")
    if not uid:
        return None
    user = db.get(User, uid)
    if user is None or user.status != "active":
        request.session.pop("uid", None)
        return None
    if (utcnow() - user.last_seen_at).total_seconds() > 600:
        user.last_seen_at = utcnow()
        db.commit()
    return user


def require_user(user: User | None = Depends(current_user)) -> User:
    if user is None:
        raise LoginRequired
    return user


def require_admin(user: User = Depends(require_user)) -> User:
    if not is_admin(user):
        raise HTTPException(404)
    return user


def guest_token(request: Request) -> str:
    token = request.session.get("guest")
    if not token:
        token = request.session["guest"] = secrets.token_urlsafe(24)
    return token


def safe_next(path: str | None) -> str:
    if path and path.startswith("/") and not path.startswith("//"):
        return path
    return "/app"


def describe_device(ua: str) -> str:
    browsers = (("Edg/", "Edge"), ("OPR/", "Opera"), ("Firefox/", "Firefox"),
                ("Chrome/", "Chrome"), ("Safari/", "Safari"))
    systems = (("Android", "Android"), ("iPhone", "iOS"), ("iPad", "iOS"),
               ("Windows", "Windows"), ("Mac OS X", "macOS"), ("Linux", "Linux"))
    browser = next((name for key, name in browsers if key in ua), "")
    system = next((name for key, name in systems if key in ua), "")
    return f"{browser} on {system}" if browser and system else browser or system


def request_context(request: Request) -> dict:
    country = request.headers.get("cf-ipcountry", "")
    if not country:
        lang = request.headers.get("accept-language", "").split(",")[0]
        match = re.search(r"-([A-Za-z]{2})\b", lang)
        country = match.group(1).upper() if match else ""
    return {
        "country": country,
        "device": describe_device(request.headers.get("user-agent", "")),
        "source": request.session.get("src", ""),
    }


def sign_in(
    request: Request,
    db: Session,
    background: BackgroundTasks,
    *,
    email: str,
    name: str = "",
    avatar: str = "",
    sub: str | None = None,
    locale: str = "",
) -> RedirectResponse:
    email = email.strip().lower()
    match = or_(User.email == email, User.google_sub == sub) if sub else User.email == email
    user = db.scalar(select(User).where(match))
    ctx = request_context(request)
    created = user is None

    if created:
        if not site_flags(db)["signups_open"]:
            return RedirectResponse("/login?error=closed", 303)
        user = User(email=email, country=ctx["country"], source=ctx["source"][:80])
        db.add(user)
    elif user.status != "active":
        return RedirectResponse("/login?error=blocked", 303)

    user.google_sub = sub or user.google_sub
    user.name = name or user.name
    user.avatar_url = avatar or user.avatar_url
    user.locale = locale or user.locale
    user.is_admin = user.is_admin or email in config.admin_emails
    user.last_seen_at = utcnow()
    db.commit()

    # Interviews done before signing in become this user's.
    guest = request.session.get("guest")
    if guest:
        db.execute(
            update(InterviewSession)
            .where(InterviewSession.guest_token == guest, InterviewSession.user_id.is_(None))
            .values(user_id=user.id, guest_token=None)
        )
        db.commit()

    next_url = safe_next(request.session.get("next"))
    request.session.clear()
    request.session["uid"] = user.id

    if created:
        log_event(db, "signup", user.id, source=user.source)
        number = db.scalar(select(func.count(User.id))) or 0
        background.add_task(notify.new_user, notify.user_card(user), number, ctx)
        next_url = "/onboarding"
    return RedirectResponse(next_url, 303)


@router.get("/auth/login")
async def login(request: Request, next: str = "/app"):
    request.session["next"] = safe_next(next)
    if config.google_enabled:
        return await oauth.google.authorize_redirect(request, f"{config.base_url}/auth/callback")
    if config.dev_login:
        return RedirectResponse("/auth/dev", 303)
    raise HTTPException(503, "Sign-in isn't set up on this server yet.")


@router.get("/auth/callback")
async def google_callback(
    request: Request, background: BackgroundTasks, db: Session = Depends(get_db)
):
    if not config.google_enabled:
        raise HTTPException(404)
    try:
        token = await oauth.google.authorize_access_token(request)
    except OAuthError:
        return RedirectResponse("/login?error=google", 303)
    info = token.get("userinfo") or {}
    if not info.get("email") or not info.get("email_verified"):
        return RedirectResponse("/login?error=email", 303)
    return sign_in(
        request, db, background,
        email=info["email"], name=info.get("name", ""), avatar=info.get("picture", ""),
        sub=info.get("sub"), locale=info.get("locale", ""),
    )


@router.get("/auth/dev")
def dev_login_page(request: Request):
    if not config.dev_login:
        raise HTTPException(404)
    return render(request, "simple.html", kind="dev-login")


@router.post("/auth/dev", dependencies=[Depends(check_csrf)])
def dev_login(
    request: Request,
    background: BackgroundTasks,
    email: str = Form(...),
    name: str = Form(""),
    db: Session = Depends(get_db),
):
    if not config.dev_login:
        raise HTTPException(404)
    if "@" not in email:
        return render(request, "simple.html", status=400, kind="dev-login", error="Enter an email address.")
    return sign_in(request, db, background, email=email, name=name.strip())


@router.post("/auth/logout", dependencies=[Depends(check_csrf)])
def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/", 303)
