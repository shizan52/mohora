import asyncio
import logging
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from typing import Any, Literal
from urllib.parse import urlparse

import httpx
from fastapi import BackgroundTasks, Depends, FastAPI, Form, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.sessions import SessionMiddleware

from . import admin, auth, billing, house, notify, practice
from .auth import LoginRequired, current_user, guest_token, require_user
from .config import ROOT, config
from .db import (
    Event,
    Feedback,
    InterviewSession,
    Pack,
    SessionLocal,
    User,
    active_packs,
    billing_settings,
    cached_flags,
    get_db,
    get_setting,
    init_db,
    log_event,
    utcnow,
)
from .web import check_csrf, render

log = logging.getLogger("mohora")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if config.secure_cookies and config.secret_key in ("", "change-me", "dev-only-secret"):
        raise RuntimeError("Set SECRET_KEY in .env before serving a public site.")
    init_db()
    digest = asyncio.create_task(notify.digest_loop()) if config.telegram_enabled else None
    yield
    if digest:
        digest.cancel()


app = FastAPI(title=config.app_name, lifespan=lifespan, docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(billing.router)
app.include_router(practice.router)
app.include_router(house.router)

# Browser code calls AI providers directly, so connect-src has to allow any HTTPS
# host (custom OpenAI-compatible URLs) and localhost (Ollama, LM Studio).
CSP_RULES = (
    "default-src 'self'",
    # wasm-unsafe-eval lets the in-browser voice model (WebAssembly) run; it doesn't allow eval().
    "script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://js.puter.com",
    "style-src 'self' https://fonts.googleapis.com",
    "style-src-attr 'unsafe-inline'",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: https://lh3.googleusercontent.com",
    "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
    "worker-src 'self' blob:",
    "media-src 'self' blob:",
    "frame-src https://puter.com https://*.puter.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
)
CSP = "; ".join(CSP_RULES)

OPEN_DURING_MAINTENANCE = ("/admin", "/auth", "/static", "/healthz")


@app.middleware("http")
async def site_middleware(request: Request, call_next):
    path = request.url.path
    if int(request.headers.get("content-length") or 0) > 2_000_000:
        return JSONResponse({"detail": "Request is too large."}, status_code=413)

    if request.method == "GET" and not path.startswith(("/static", "/api")):
        remember_source(request)

    if cached_flags().get("maintenance") and not path.startswith(OPEN_DURING_MAINTENANCE):
        with SessionLocal() as db:
            uid = request.session.get("uid")
            viewer = db.get(User, uid) if uid else None
            if viewer is None or not auth.is_admin(viewer):
                return render(request, "simple.html", status=503, kind="maintenance")

    response = await call_next(request)
    response.headers["Content-Security-Policy"] = CSP
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "microphone=(self), camera=(self), geolocation=()"
    if path.startswith("/static/") and "v" in request.query_params:
        # Asset URLs carry a version, so browsers can keep them for good.
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    if path.startswith(ISOLATED_PATHS):
        # Cross-origin isolation lets the in-browser voice model use every CPU core, which
        # makes it several times faster. Only the interview room needs it; elsewhere it
        # would break sign-in popups. The threaded runtime loads its helper from a blob URL.
        response.headers["Content-Security-Policy"] = CSP.replace("script-src 'self'", "script-src 'self' blob:")
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        response.headers["Cross-Origin-Embedder-Policy"] = "credentialless"
    return response


ISOLATED_PATHS = ("/app/room/", "/static/tts-worker.js")


# Added last so it wraps the middleware above, which needs request.session.
app.add_middleware(
    SessionMiddleware,
    secret_key=config.secret_key,
    session_cookie="mohora",
    max_age=60 * 60 * 24 * 30,
    same_site="lax",
    https_only=config.secure_cookies,
)


def remember_source(request: Request) -> None:
    """First-touch attribution, shown to the admin when the visitor signs up."""
    q = request.query_params
    if q.get("ref"):
        request.session["ref"] = q["ref"][:24]
    if "src" in request.session:
        return
    source = q.get("utm_source") or ("a friend" if q.get("ref") else "")
    if not source:
        referer = urlparse(request.headers.get("referer", "")).hostname or ""
        if referer and referer != urlparse(config.base_url).hostname:
            source = referer.removeprefix("www.")
    if source:
        request.session["src"] = source[:80]


@app.exception_handler(LoginRequired)
async def login_required(request: Request, _exc: LoginRequired):
    if request.url.path.startswith("/api"):
        return JSONResponse({"detail": "Sign in to continue."}, status_code=401)
    return RedirectResponse(f"/login?next={request.url.path}", 303)


@app.exception_handler(StarletteHTTPException)
async def http_error(request: Request, exc: StarletteHTTPException):
    if request.url.path.startswith("/api"):
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
    message = "This page doesn't exist." if exc.status_code == 404 else exc.detail
    return render(request, "simple.html", status=exc.status_code, kind="error", message=message)


_hits: dict[str, deque] = defaultdict(deque)


def rate_limit(key: str, limit: int, per_seconds: float) -> None:
    now = time.monotonic()
    hits = _hits[key]
    while hits and now - hits[0] > per_seconds:
        hits.popleft()
    if len(hits) >= limit:
        raise HTTPException(429, "Too many requests. Wait a minute and try again.")
    hits.append(now)


def client_ip(request: Request) -> str:
    # The reverse proxy passes the visitor's address on; uvicorn resolves it (--proxy-headers).
    return request.client.host if request.client else ""


def owned_session(request: Request, db: Session, sid: int, user: User | None) -> InterviewSession:
    s = db.get(InterviewSession, sid)
    if s is not None:
        if user is not None and s.user_id == user.id:
            return s
        if s.user_id is None and s.guest_token and s.guest_token == request.session.get("guest"):
            return s
    raise HTTPException(404)


# ---------------------------------------------------------------- pages


@app.get("/")
def landing(request: Request, user: User | None = Depends(current_user), db: Session = Depends(get_db)):
    return render(request, "landing.html", user=user, packs=active_packs(db), journey=get_setting(db, "journey") or [],
                  billing=billing_settings(db))


@app.get("/privacy")
def privacy(request: Request, user: User | None = Depends(current_user)):
    return render(request, "legal.html", user=user, doc="privacy")


@app.get("/terms")
def terms(request: Request, user: User | None = Depends(current_user)):
    return render(request, "legal.html", user=user, doc="terms")


LOGIN_ERRORS = {
    "google": "Google sign-in didn't finish. Try again.",
    "email": "Your Google account has no verified email address.",
    "closed": "New sign-ups are paused right now. Try again later.",
    "blocked": "This account has been blocked. Contact the site owner if you think it's a mistake.",
    "dev-email": "Enter an email address.",
}


@app.get("/login")
def login_page(request: Request, next: str = "/app", error: str = "", user: User | None = Depends(current_user)):
    if user:
        return RedirectResponse(auth.safe_next(next), 303)
    return render(request, "login.html", next=auth.safe_next(next), error=LOGIN_ERRORS.get(error, ""),
                  google=config.google_enabled, dev_login=config.dev_login)


@app.get("/onboarding")
def onboarding(request: Request, user: User = Depends(require_user), db: Session = Depends(get_db)):
    return render(request, "onboarding.html", user=user, packs=active_packs(db), flags=cached_flags())


@app.get("/app/new")
def new_interview(
    request: Request,
    pack: str = "",
    again: int | None = None,
    user: User | None = Depends(current_user),
    db: Session = Depends(get_db),
):
    if user is None and not cached_flags().get("guest_mode"):
        raise LoginRequired
    previous = None
    if again:
        old = owned_session(request, db, again, user)
        previous = {**old.config, "pack": old.pack_slug}
    return render(
        request, "setup.html", user=user, packs=active_packs(db), selected=pack, previous=previous,
        prompts=get_setting(db, "prompts"), journey=get_setting(db, "journey") or [],
        has_pass=bool(user and user.has_pass), flags=cached_flags(), nav="new",
        tried=practice.tried_pro_packs(db, user),
    )


@app.get("/app/room/{sid}")
def room(request: Request, sid: int, user: User | None = Depends(current_user), db: Session = Depends(get_db)):
    s = owned_session(request, db, sid, user)
    if s.status == "completed":
        return RedirectResponse(f"/app/session/{sid}", 303)
    return render(request, "room.html", user=user, session=s, prompts=get_setting(db, "prompts"))


@app.get("/app/session/{sid}")
def report(request: Request, sid: int, user: User | None = Depends(current_user), db: Session = Depends(get_db)):
    s = owned_session(request, db, sid, user)
    if s.status != "completed" or not s.report:
        return RedirectResponse(f"/app/room/{sid}", 303)
    pack = db.get(Pack, s.pack_slug)
    journey = s.config.get("journey") or {}
    next_stage = None
    if journey and journey.get("index", 0) + 1 < len(journey.get("stages", [])):
        slug = journey["stages"][journey["index"] + 1]
        titles = {stage["pack"]: stage["title"] for stage in get_setting(db, "journey") or []}
        next_stage = {"title": titles.get(slug, slug), "number": journey["index"] + 2, "total": len(journey["stages"])}
    return render(request, "report.html", user=user, session=s, r=s.report, next_stage=next_stage,
                  pack=pack.data if pack else {"title": s.pack_slug},
                  story_prompt=(get_setting(db, "prompts") or {}).get("story", ""),
                  blocks_for_stories=practice.story_sources(s.report))


@app.get("/app/settings")
def settings_page(request: Request, user: User = Depends(require_user)):
    return render(request, "settings.html", user=user, flags=cached_flags())


@app.get("/connect/openrouter")
def connect_openrouter(request: Request, user: User | None = Depends(current_user)):
    return render(request, "simple.html", kind="connect", user=user)


@app.get("/healthz")
def healthz():
    return {"ok": True}


# ---------------------------------------------------------------- API


class NewSession(BaseModel):
    pack: str = Field(max_length=64)
    config: dict[str, Any] = {}


@app.post("/api/sessions", dependencies=[Depends(check_csrf)])
def create_session(
    body: NewSession, request: Request, user: User | None = Depends(current_user), db: Session = Depends(get_db)
):
    pack = db.get(Pack, body.pack)
    if pack is None or not pack.active:
        raise HTTPException(404, "That interview type isn't available.")
    if not (user and user.has_pass):
        if body.config.get("journey"):
            raise HTTPException(403, "The whole hiring process needs Pro. See the pricing page.")
        if pack.pro and user is None:
            raise HTTPException(403, "Sign in to try this interview type once for free.")
        if pack.pro and db.scalar(select(func.count(InterviewSession.id)).where(
                InterviewSession.user_id == user.id, InterviewSession.pack_slug == pack.slug,
                InterviewSession.status == "completed")):
            raise HTTPException(403, "You've used your free try of this interview type. Pro unlocks it.")
    if user is None:
        if not cached_flags().get("guest_mode"):
            raise LoginRequired
        rate_limit(f"guest-session:{client_ip(request)}", 12, 3600)
    s = InterviewSession(
        pack_slug=pack.slug,
        config=body.config,
        user_id=user.id if user else None,
        guest_token=None if user else guest_token(request),
    )
    db.add(s)
    db.commit()
    log_event(db, "interview_started", user.id if user else None, pack=pack.slug,
              cv=bool(body.config.get("has_cv")), input=body.config.get("input", "text"))
    return {"id": s.id}


class SessionUpdate(BaseModel):
    status: Literal["active", "completed", "abandoned"] | None = None
    duration_s: int | None = None
    overall: float | None = None
    scores: dict[str, Any] | None = None
    metrics: dict[str, Any] | None = None
    transcript: list[Any] | None = None
    report: dict[str, Any] | None = None


@app.patch("/api/sessions/{sid}", dependencies=[Depends(check_csrf)])
def update_session(
    sid: int,
    body: SessionUpdate,
    request: Request,
    background: BackgroundTasks,
    user: User | None = Depends(current_user),
    db: Session = Depends(get_db),
):
    s = owned_session(request, db, sid, user)
    if s.status == "completed":
        raise HTTPException(409, "This interview is already finished.")
    changes = body.model_dump(exclude_none=True)
    if user is not None and not user.saves_transcripts:
        changes.pop("transcript", None)
        if "report" in changes:
            for block in changes["report"].get("blocks", []):
                block.pop("turns", None)
    for key, value in changes.items():
        setattr(s, key, value)

    if body.status == "completed":
        s.ended_at = utcnow()
        db.commit()
        log_event(db, "interview_completed", s.user_id, pack=s.pack_slug, overall=s.overall)
        if user is not None:
            completed = db.scalar(select(func.count(InterviewSession.id)).where(
                InterviewSession.user_id == user.id, InterviewSession.status == "completed"))
            if completed == 1:
                pack = db.get(Pack, s.pack_slug)
                title = pack.data.get("title", s.pack_slug) if pack else s.pack_slug
                background.add_task(notify.first_interview, notify.user_card(user), title, s.overall)
            practice.after_interview(db, user, s)
    db.commit()
    return {"ok": True}


class Profile(BaseModel):
    goal: dict[str, Any] | None = None
    prefs: dict[str, Any] | None = None


@app.post("/api/me", dependencies=[Depends(check_csrf)])
def update_me(body: Profile, user: User = Depends(require_user), db: Session = Depends(get_db)):
    if body.goal is not None:
        user.goal = {**user.goal, **body.goal}
    if body.prefs is not None:
        user.prefs = {**user.prefs, **body.prefs}
    db.commit()
    return {"ok": True}


@app.get("/api/me/export")
def export_me(user: User = Depends(require_user), db: Session = Depends(get_db)):
    sessions = db.scalars(select(InterviewSession).where(InterviewSession.user_id == user.id))
    data = {
        "account": {"email": user.email, "name": user.name, "created_at": user.created_at.isoformat(),
                    "goal": user.goal, "prefs": user.prefs},
        "interviews": [
            {"id": s.id, "pack": s.pack_slug, "status": s.status, "started_at": s.started_at.isoformat(),
             "config": s.config, "overall": s.overall, "scores": s.scores, "metrics": s.metrics,
             "transcript": s.transcript, "report": s.report}
            for s in sessions
        ],
    }
    headers = {"Content-Disposition": f'attachment; filename="{config.app_name.lower()}-export.json"'}
    return JSONResponse(data, headers=headers)


@app.post("/account/delete", dependencies=[Depends(check_csrf)])
def delete_account(
    request: Request, confirm: str = Form(""), user: User = Depends(require_user), db: Session = Depends(get_db)
):
    if confirm.strip().lower() != "delete":
        return RedirectResponse("/app/settings?delete=confirm#privacy", 303)
    db.execute(delete(InterviewSession).where(InterviewSession.user_id == user.id))
    db.execute(delete(Event).where(Event.user_id == user.id))
    db.delete(user)
    db.commit()
    request.session.clear()
    return RedirectResponse("/?deleted=1", 303)


TRACKED_EVENTS = {"ai_connected", "ai_test_failed", "plan_built", "voice_used", "report_viewed"}


class ClientEvent(BaseModel):
    name: str = Field(max_length=48)
    props: dict[str, str | int | float | bool] = {}


@app.post("/api/events", dependencies=[Depends(check_csrf)])
def client_event(
    body: ClientEvent, request: Request, user: User | None = Depends(current_user), db: Session = Depends(get_db)
):
    if body.name not in TRACKED_EVENTS:
        raise HTTPException(400, "Unknown event.")
    rate_limit(f"event:{client_ip(request)}", 60, 60)
    props = {k[:24]: (v[:80] if isinstance(v, str) else v) for k, v in list(body.props.items())[:8]}
    log_event(db, body.name, user.id if user else None, **props)
    return {"ok": True}


class NewFeedback(BaseModel):
    message: str = Field(min_length=3, max_length=4000)
    kind: Literal["bug", "idea", "general"] = "general"
    page: str = Field("", max_length=200)


@app.post("/api/feedback", dependencies=[Depends(check_csrf)])
def feedback(
    body: NewFeedback,
    request: Request,
    background: BackgroundTasks,
    user: User | None = Depends(current_user),
    db: Session = Depends(get_db),
):
    rate_limit(f"feedback:{client_ip(request)}", 5, 600)
    db.add(Feedback(user_id=user.id if user else None, kind=body.kind, message=body.message, page=body.page))
    db.commit()
    who = user.email if user else "a visitor"
    background.add_task(notify.send_admin, notify.feedback_text(who, body.kind, body.message, body.page))
    return {"ok": True}


# The relay exists for providers that block calls from browsers. Only known provider
# hosts are reachable, and the key is forwarded, never stored or logged.
RELAY_BASES = {
    "openrouter": "https://openrouter.ai/api/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
    "groq": "https://api.groq.com/openai/v1",
    "openai": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com/v1",
    "deepseek": "https://api.deepseek.com/v1",
    "mistral": "https://api.mistral.ai/v1",
    "xai": "https://api.x.ai/v1",
    "cerebras": "https://api.cerebras.ai/v1",
}
RELAY_PATHS = {"/chat/completions", "/models", "/messages"}


class RelayCall(BaseModel):
    provider: str
    path: str
    key: str = Field(max_length=400)
    payload: dict[str, Any] | None = None


@app.post("/api/relay", dependencies=[Depends(check_csrf)])
async def relay(body: RelayCall, request: Request):
    if not cached_flags().get("relay"):
        raise HTTPException(403, "The relay is turned off on this server.")
    base = RELAY_BASES.get(body.provider)
    if base is None or body.path not in RELAY_PATHS:
        raise HTTPException(400, "This provider can't be relayed.")
    rate_limit(f"relay:{client_ip(request)}", 60, 60)

    if body.provider == "anthropic":
        headers = {"x-api-key": body.key, "anthropic-version": "2023-06-01"}
    else:
        headers = {"Authorization": f"Bearer {body.key}"}
    try:
        async with httpx.AsyncClient(timeout=90) as client:
            if body.path == "/models":
                upstream = await client.get(base + body.path, headers=headers)
            else:
                upstream = await client.post(base + body.path, headers=headers, json=body.payload or {})
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"Couldn't reach the provider ({type(exc).__name__}).") from None
    try:
        content = upstream.json()
    except ValueError:
        content = {"error": {"message": upstream.text[:300]}}
    return JSONResponse(content, status_code=upstream.status_code)


@app.get("/robots.txt")
def robots():
    rules = f"User-agent: *\nDisallow: /app\nDisallow: /admin\nDisallow: /api\nSitemap: {config.base_url}/sitemap.xml\n"
    return Response(rules, media_type="text/plain")
