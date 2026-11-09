"""Owner's control panel: numbers, users, interview packs and site settings."""

import json
import re
from datetime import timedelta

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import distinct, func, or_, select
from sqlalchemy.orm import Session

from .auth import require_admin
from .db import (
    AuditLog,
    Event,
    Feedback,
    InterviewSession,
    Pack,
    User,
    audit,
    forget_flags,
    get_db,
    get_setting,
    set_setting,
    site_flags,
    utcnow,
)
from .web import check_csrf, render

router = APIRouter(prefix="/admin", dependencies=[Depends(require_admin)])

PAGE_SIZE = 50
FLAG_LABELS = {
    "signups_open": "New people can sign up",
    "guest_mode": "Visitors can try an interview without signing in",
    "relay": "Allow the relay for AI providers that block browser calls",
    "maintenance": "Maintenance mode (only admins can use the site)",
}


def _count(db: Session, stmt) -> int:
    return db.scalar(stmt) or 0


@router.get("")
def overview(request: Request, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    now = utcnow()
    day, week, month = now - timedelta(days=1), now - timedelta(days=7), now - timedelta(days=30)
    users = select(func.count(User.id))
    sessions = select(func.count(InterviewSession.id))
    completed = InterviewSession.status == "completed"

    stats = {
        "users": _count(db, users),
        "new_day": _count(db, users.where(User.created_at >= day)),
        "new_week": _count(db, users.where(User.created_at >= week)),
        "active_week": _count(db, users.where(User.last_seen_at >= week)),
        "started_week": _count(db, sessions.where(InterviewSession.started_at >= week)),
        "completed_week": _count(db, sessions.where(InterviewSession.started_at >= week, completed)),
        "avg_minutes": round((db.scalar(select(func.avg(InterviewSession.duration_s)).where(
            completed, InterviewSession.started_at >= month)) or 0) / 60, 1),
    }

    def distinct_users(*where) -> int:
        return _count(db, select(func.count(distinct(InterviewSession.user_id))).where(*where))

    repeat = select(InterviewSession.user_id).where(completed).group_by(InterviewSession.user_id) \
        .having(func.count() >= 3).subquery()
    funnel = [
        ("Signed up (30 days)", _count(db, users.where(User.created_at >= month))),
        ("Connected an AI", _count(db, select(func.count(distinct(Event.user_id))).where(
            Event.name == "ai_connected", Event.ts >= month))),
        ("Started an interview", distinct_users(InterviewSession.started_at >= month)),
        ("Finished one", distinct_users(InterviewSession.started_at >= month, completed)),
        ("Finished three or more", _count(db, select(func.count()).select_from(repeat))),
    ]

    provider = func.json_extract(Event.props, "$.provider")
    providers = db.execute(
        select(provider, func.count()).where(Event.name == "ai_connected", Event.ts >= month)
        .group_by(provider).order_by(func.count().desc())
    ).all()
    packs = db.execute(
        select(InterviewSession.pack_slug, func.count()).where(InterviewSession.started_at >= month)
        .group_by(InterviewSession.pack_slug).order_by(func.count().desc())
    ).all()

    signup_day = func.date(User.created_at)
    per_day = dict(db.execute(
        select(signup_day, func.count()).where(User.created_at >= now - timedelta(days=13))
        .group_by(signup_day)
    ).all())
    days = [(now - timedelta(days=i)).date() for i in range(13, -1, -1)]
    signups = [(d, per_day.get(d.isoformat(), 0)) for d in days]

    recent = db.scalars(select(User).order_by(User.created_at.desc()).limit(8))
    new_feedback = _count(db, select(func.count(Feedback.id)).where(Feedback.status == "new"))
    return render(
        request, "admin.html", view="overview", user=user, stats=stats, funnel=funnel,
        providers=providers, packs=packs, signups=signups, peak=max([n for _, n in signups] + [1]),
        recent=list(recent), new_feedback=new_feedback,
    )


@router.get("/users")
def users_list(
    request: Request, q: str = "", page: int = 1,
    user: User = Depends(require_admin), db: Session = Depends(get_db),
):
    stmt = select(User)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(User.email.ilike(like), User.name.ilike(like)))
    total = _count(db, select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(User.created_at.desc()).offset((page - 1) * PAGE_SIZE).limit(PAGE_SIZE))
    done = dict(db.execute(
        select(InterviewSession.user_id, func.count()).where(InterviewSession.status == "completed")
        .group_by(InterviewSession.user_id)
    ).all())
    return render(request, "admin.html", view="users", user=user, rows=list(rows), q=q, page=page,
                  pages=max(1, -(-total // PAGE_SIZE)), total=total, done=done)


@router.get("/users/{uid}")
def user_detail(request: Request, uid: int, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    person = db.get(User, uid) or _not_found()
    # Metadata and scores only. Transcripts stay private to the user.
    sessions = db.scalars(select(InterviewSession).where(InterviewSession.user_id == uid)
                          .order_by(InterviewSession.started_at.desc()).limit(50))
    events = db.scalars(select(Event).where(Event.user_id == uid).order_by(Event.ts.desc()).limit(20))
    return render(request, "admin.html", view="user", user=user, person=person,
                  sessions=list(sessions), events=list(events))


@router.post("/users/{uid}", dependencies=[Depends(check_csrf)])
def user_action(
    uid: int,
    action: str = Form(...),
    days: int = Form(0),
    notes: str = Form(""),
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    person = db.get(User, uid) or _not_found()
    if action == "block" and person.id != user.id:
        person.status = "blocked"
    elif action == "unblock":
        person.status = "active"
    elif action == "toggle-admin" and person.id != user.id:
        person.is_admin = not person.is_admin
    elif action == "grant" and 0 < days <= 3650:
        start = max(person.pass_until or utcnow(), utcnow())
        person.pass_until = start + timedelta(days=days)
    elif action == "notes":
        person.notes = notes[:4000]
    else:
        raise HTTPException(400, "Unknown or unsafe action.")
    db.commit()
    audit(db, user.email, f"user.{action}", person.email, days=days or None)
    return RedirectResponse(f"/admin/users/{uid}", 303)


@router.get("/packs")
def packs_list(request: Request, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    rows = db.scalars(select(Pack).order_by(Pack.sort))
    usage = dict(db.execute(select(InterviewSession.pack_slug, func.count())
                            .group_by(InterviewSession.pack_slug)).all())
    return render(request, "admin.html", view="packs", user=user, rows=list(rows), usage=usage)


PACK_TEMPLATE = {
    "slug": "new-pack", "title": "", "summary": "", "brief": "", "pro": False, "minutes": 20,
    "default_count": 5, "interviewer": {"name": "", "role": ""}, "opener": "",
    "competencies": [], "bank": [], "rubric": [{"id": "clarity", "label": "Clarity", "hint": ""}], "rules": [],
}


@router.get("/packs/{slug}")
def pack_edit(request: Request, slug: str, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    pack = db.get(Pack, slug)
    if pack is None and slug != "new":
        _not_found()
    data = pack.data if pack else PACK_TEMPLATE
    return render(request, "admin.html", view="pack", user=user, pack=pack,
                  source=json.dumps(data, indent=2, ensure_ascii=False))


def validate_pack(data: dict) -> str | None:
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,62}", str(data.get("slug", ""))):
        return "slug must be lowercase letters, numbers and dashes."
    for key in ("title", "brief", "opener"):
        if not str(data.get(key, "")).strip():
            return f"“{key}” can't be empty."
    who = data.get("interviewer") or {}
    if not who.get("name") or not who.get("role"):
        return "interviewer needs a name and a role."
    rubric = data.get("rubric")
    if not isinstance(rubric, list) or not rubric or not all(r.get("id") and r.get("label") for r in rubric):
        return "rubric needs at least one item with an id and a label."
    for key in ("competencies", "bank", "rules"):
        if not isinstance(data.get(key, []), list):
            return f"“{key}” must be a list."
    return None


@router.post("/packs/{slug}", dependencies=[Depends(check_csrf)])
def pack_save(
    request: Request,
    slug: str,
    source: str = Form(...),
    active: bool = Form(False),
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    pack = db.get(Pack, slug)
    try:
        data = json.loads(source)
        error = validate_pack(data) if isinstance(data, dict) else "The pack must be a JSON object."
    except json.JSONDecodeError as exc:
        error = f"Not valid JSON: {exc.msg} (line {exc.lineno})."
    if error is None and slug == "new" and db.get(Pack, data["slug"]):
        error = "A pack with that slug already exists."
    if error is None and pack is not None and data["slug"] != slug:
        error = "The slug of an existing pack can't change."
    if error:
        return render(request, "admin.html", status=400, view="pack", user=user, pack=pack,
                      source=source, error=error)

    if pack is None:
        pack = Pack(slug=data["slug"], data=data, sort=_count(db, select(func.count(Pack.slug))))
        db.add(pack)
    pack.data = data
    pack.pro = bool(data.get("pro"))
    pack.active = active
    pack.updated_at = utcnow()
    db.commit()
    audit(db, user.email, "pack.save", pack.slug, active=active)
    return RedirectResponse(f"/admin/packs/{pack.slug}?saved=1", 303)


@router.get("/settings")
def settings_page(request: Request, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    log = db.scalars(select(AuditLog).order_by(AuditLog.ts.desc()).limit(40))
    return render(request, "admin.html", view="settings", user=user, flags=site_flags(db),
                  labels=FLAG_LABELS, prompts=get_setting(db, "prompts") or {}, log=list(log))


@router.post("/settings/flags", dependencies=[Depends(check_csrf)])
async def save_flags(request: Request, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    form = await request.form()
    flags = site_flags(db)
    for key in FLAG_LABELS:
        flags[key] = form.get(key) == "on"
    flags["announcement"] = str(form.get("announcement", ""))[:300].strip()
    set_setting(db, "flags", flags)
    forget_flags()
    audit(db, user.email, "settings.flags", **flags)
    return RedirectResponse("/admin/settings?saved=1", 303)


@router.post("/settings/prompts", dependencies=[Depends(check_csrf)])
async def save_prompts(request: Request, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    form = await request.form()
    prompts = get_setting(db, "prompts") or {}
    for key in prompts:
        value = str(form.get(key, "")).strip()
        if value:
            prompts[key] = value.replace("\r\n", "\n")
    set_setting(db, "prompts", dict(prompts))
    audit(db, user.email, "settings.prompts")
    return RedirectResponse("/admin/settings?saved=1#prompts", 303)


@router.get("/inbox")
def inbox(request: Request, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    rows = db.scalars(select(Feedback).order_by(Feedback.status != "new", Feedback.created_at.desc()).limit(100))
    return render(request, "admin.html", view="inbox", user=user, rows=list(rows))


@router.post("/inbox/{fid}", dependencies=[Depends(check_csrf)])
def inbox_done(fid: int, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    item = db.get(Feedback, fid) or _not_found()
    item.status = "done" if item.status == "new" else "new"
    db.commit()
    return RedirectResponse("/admin/inbox", 303)


def _not_found():
    raise HTTPException(404)
