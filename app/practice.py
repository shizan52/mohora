"""What brings people back between interviews.

Weak answers return on a schedule until they land, a readiness score and a day-by-day plan
point at the interview date, stories are kept for reuse, and reports can be shared.
"""

import json
import secrets
from collections import Counter
from datetime import UTC, date, datetime, timedelta
from functools import lru_cache
from types import SimpleNamespace
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .auth import current_user, require_user
from .billing import grant_pass
from .config import config
from .db import (
    PACKS_FILE,
    InterviewSession,
    Pack,
    ReviewItem,
    Story,
    User,
    active_packs,
    get_db,
    get_setting,
    utcnow,
)
from .web import check_csrf, render

router = APIRouter()

# Days until a question comes back after each good answer in a row.
INTERVALS = [1, 3, 7]
GOOD_SCORE = 4.0
FREE_STORIES = 5
REFERRAL_DAYS = 7
MAX_REFERRALS = 10
COMPETENCIES = ["ownership", "conflict", "failure", "leadership", "teamwork", "impact"]
PLAN_ORDER = ["behavioral-star", "role-technical", "recruiter-screen", "fresher-hr", "final-round"]


def local_today() -> date:
    return datetime.now(ZoneInfo(config.tz)).date()


def local_day(moment: datetime) -> date:
    return moment.replace(tzinfo=UTC).astimezone(ZoneInfo(config.tz)).date()


def days_until(day: str | None) -> int | None:
    try:
        return (date.fromisoformat(day or "") - local_today()).days
    except ValueError:
        return None


@lru_cache
def seed_data() -> dict:
    return json.loads(PACKS_FILE.read_text(encoding="utf-8"))


# ---------------------------------------------------------------- after an interview


def after_interview(db: Session, user: User, session: InterviewSession) -> None:
    schedule_reviews(db, user, session)
    reward_referral(db, user)
    db.commit()


def schedule_reviews(db: Session, user: User, session: InterviewSession) -> None:
    """Weak answers join the review queue; three good answers in a row retire a question."""
    now = utcnow()
    rows = db.scalars(select(ReviewItem).where(ReviewItem.user_id == user.id))
    known = {item.question.casefold(): item for item in rows}
    for block in (session.report or {}).get("blocks", []):
        result = block.get("eval")
        question = (block.get("q") or "").strip()[:500]
        if not result or not question:
            continue
        score = float(result.get("overall") or 0)
        item = known.get(question.casefold())
        if item is None:
            if score >= GOOD_SCORE:
                continue
            item = ReviewItem(user_id=user.id, question=question, pack_slug=session.pack_slug, reps=0)
            db.add(item)
            known[question.casefold()] = item
        if score >= GOOD_SCORE:
            item.reps += 1
            if item.reps >= len(INTERVALS):
                db.delete(item)
                del known[question.casefold()]
                continue
        else:
            item.reps = 0
        item.interval_days = INTERVALS[item.reps]
        item.last_score = score
        item.due_at = now + timedelta(days=item.interval_days)
        item.updated_at = now


def reward_referral(db: Session, user: User) -> None:
    """Both people get Pro days once the invited friend finishes a first interview."""
    if not user.referred_by or user.prefs.get("referral_paid"):
        return
    user.prefs = {**user.prefs, "referral_paid": True}
    grant_pass(user, REFERRAL_DAYS)
    friend = db.get(User, user.referred_by)
    if friend and friend.status == "active" and referrals_paid(db, friend) < MAX_REFERRALS:
        grant_pass(friend, REFERRAL_DAYS)


def referrals_paid(db: Session, user: User) -> int:
    paid = func.json_extract(User.prefs, "$.referral_paid") == 1
    return db.scalar(select(func.count(User.id)).where(User.referred_by == user.id, paid)) or 0


# ---------------------------------------------------------------- dashboard numbers


def readiness(done: list[InterviewSession], due: int, tracked: int) -> dict:
    """A 0-100 score built from four visible parts, so the user can see how to raise it."""
    now = utcnow()
    recent = [s.overall for s in done[:5] if s.overall]
    this_week = sum(1 for s in done if s.started_at >= now - timedelta(days=7))
    kinds = len({s.pack_slug for s in done if s.started_at >= now - timedelta(days=30)})
    average = sum(recent) / len(recent) if recent else 0

    if not done:
        fixed, fixed_note = 0, "Finish an interview and weak answers are tracked here"
    elif not tracked:
        fixed, fixed_note = 15, "No weak answers waiting"
    else:
        fixed = round((1 - due / tracked) * 15)
        fixed_note = f"{due} of {tracked} weak answers are due for another try"
    parts = [
        {"label": "Answer quality", "value": round(average / 5 * 50), "max": 50,
         "note": f"Average {average:.1f} out of 5 over your last {len(recent)}" if recent else "No scored interviews yet"},
        {"label": "Practice this week", "value": round(min(this_week, 3) / 3 * 20), "max": 20,
         "note": f"{this_week} of 3 interviews in the last 7 days"},
        {"label": "Range", "value": round(min(kinds, 3) / 3 * 15), "max": 15,
         "note": f"{kinds} of 3 interview types in the last 30 days"},
        {"label": "Weak answers fixed", "value": fixed, "max": 15, "note": fixed_note},
    ]
    return {"score": sum(p["value"] for p in parts), "parts": parts}


def skills(done: list[InterviewSession]) -> list[dict]:
    """Average per rubric line over the last ten interviews, weakest first."""
    totals: dict[str, list[float]] = {}
    for session in done[:10]:
        for item in (session.report or {}).get("rubric", []):
            if item.get("avg") is not None:
                totals.setdefault(item["label"], []).append(item["avg"])
    rows = [{"label": label, "avg": round(sum(v) / len(v), 1), "n": len(v)} for label, v in totals.items()]
    return sorted(rows, key=lambda row: row["avg"])[:6]


def week_streak(done: list[InterviewSession]) -> int:
    """Weeks in a row with at least one interview. The current week doesn't break it until it ends."""
    weeks = {s.started_at.isocalendar()[:2] for s in done}
    day = utcnow()
    if day.isocalendar()[:2] not in weeks:
        day -= timedelta(days=7)
    streak = 0
    while day.isocalendar()[:2] in weeks:
        streak += 1
        day -= timedelta(days=7)
    return streak


def build_plan(goal: dict, packs: dict[str, dict], days_left: int | None) -> list[dict]:
    order = [slug for slug in dict.fromkeys([goal.get("pack"), *PLAN_ORDER]) if slug in packs and not packs[slug]["pro"]]
    if not order:
        return []
    today = local_today()
    # None when there is no interview date, or it has passed: then it's an open-ended plan.
    left = days_left if days_left is not None and days_left >= 0 else None
    plan = []
    for i in range((min(left, 6) if left is not None else 4) + 1):
        day = today + timedelta(days=i)
        if left is not None and i == left:
            plan.append({"day": day, "kind": "warmup", "title": "Interview day",
                         "note": "A five-minute warm-up on your weakest answers, then stop. You've done the work."})
        elif left is not None and left >= 2 and i == left - 1:
            plan.append({"day": day, "kind": "review", "title": "Light day",
                         "note": "Redo your weak answers and read your stories once. No new material."})
        else:
            # Tied to the calendar date, so tomorrow's suggestion differs from today's.
            pack = packs[order[day.toordinal() % len(order)]]
            plan.append({"day": day, "kind": "interview", "title": pack["title"], "pack": pack["slug"],
                         "note": f"About {pack.get('minutes', 15)} minutes"})
    return plan


def sparkline(values: list[float], width: int = 160, height: int = 36) -> str:
    if len(values) < 2:
        return ""
    step = width / (len(values) - 1)
    points = (f"{i * step:.1f},{height - (v - 1) / 4 * height:.1f}" for i, v in enumerate(values))
    return " ".join(points)


def completed_sessions(db: Session, user: User, limit: int = 30) -> list[InterviewSession]:
    return list(db.scalars(
        select(InterviewSession)
        .where(InterviewSession.user_id == user.id, InterviewSession.status == "completed")
        .order_by(InterviewSession.started_at.desc()).limit(limit)
    ))


@router.get("/app")
def dashboard(request: Request, user: User = Depends(require_user), db: Session = Depends(get_db)):
    now = utcnow()
    done = completed_sessions(db, user)
    unfinished = db.scalar(
        select(InterviewSession)
        .where(InterviewSession.user_id == user.id, InterviewSession.status == "active",
               InterviewSession.started_at >= now - timedelta(days=2))
        .order_by(InterviewSession.started_at.desc())
    )
    packs = {p["slug"]: p for p in active_packs(db)}
    goal = user.goal or {}
    days_left = days_until(goal.get("date"))
    items = list(db.scalars(select(ReviewItem).where(ReviewItem.user_id == user.id)))
    due = sum(1 for item in items if item.due_at <= now)
    scores = [s.overall for s in reversed(done) if s.overall]
    total = db.scalar(select(func.count(InterviewSession.id)).where(
        InterviewSession.user_id == user.id, InterviewSession.status == "completed")) or 0
    return render(
        request, "dashboard.html", user=user, nav="home", sessions=done[:6], unfinished=unfinished, packs=packs,
        goal=goal, days_left=days_left, total=total, ready=readiness(done, due, len(items)),
        plan=build_plan(goal, packs, days_left), due=due, tracked=len(items), skills=skills(done),
        done_today=bool(done) and local_day(done[0].started_at) == local_today(),
        streak=week_streak(done), this_week=sum(1 for s in done if s.started_at >= now - timedelta(days=7)),
        spark=sparkline(scores), story_count=db.scalar(select(func.count(Story.id)).where(Story.user_id == user.id)) or 0,
        referral_url=f"{config.base_url}/?ref={user.referral_code}", referred=referrals_paid(db, user),
        referral_days=REFERRAL_DAYS,
    )


def ics_text(value: str) -> str:
    return value.replace("\\", "\\\\").replace(",", "\\,").replace(";", "\\;").replace("\n", "\\n")


@router.get("/app/plan.ics")
def plan_calendar(user: User = Depends(require_user), db: Session = Depends(get_db)):
    goal = user.goal or {}
    packs = {p["slug"]: p for p in active_packs(db)}
    stamp = f"{utcnow():%Y%m%dT%H%M%SZ}"
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", f"PRODID:-//{config.app_name}//Practice plan//EN"]
    for item in build_plan(goal, packs, days_until(goal.get("date"))):
        lines += [
            "BEGIN:VEVENT",
            f"UID:{item['day']:%Y%m%d}-{user.id}@{config.app_name.lower()}",
            f"DTSTAMP:{stamp}",
            # No time zone on purpose: 8 pm wherever the person's calendar is.
            f"DTSTART:{item['day']:%Y%m%d}T200000",
            "DURATION:PT25M",
            f"SUMMARY:{ics_text('Interview practice: ' + item['title'])}",
            f"DESCRIPTION:{ics_text(item['note'] + ' ' + config.base_url + '/app')}",
            "END:VEVENT",
        ]
    lines.append("END:VCALENDAR")
    headers = {"Content-Disposition": 'attachment; filename="practice-plan.ics"'}
    return Response("\r\n".join(lines) + "\r\n", media_type="text/calendar", headers=headers)


@router.get("/api/drill")
def drill(user: User = Depends(require_user), db: Session = Depends(get_db)):
    """The weak answers that are due, from the interview type with the most of them."""
    packs = {p["slug"]: p for p in active_packs(db) if not p["pro"] or user.has_pass}
    rows = db.scalars(select(ReviewItem).where(ReviewItem.user_id == user.id).order_by(ReviewItem.due_at))
    items = [item for item in rows if item.pack_slug in packs]
    if not items:
        raise HTTPException(404, "Nothing to review yet. Answers that score under 4 come back here.")
    due = [item for item in items if item.due_at <= utcnow()] or items
    slug = Counter(item.pack_slug for item in due).most_common(1)[0][0]
    return {"pack": packs[slug], "questions": [item.question for item in due if item.pack_slug == slug][:4]}


# ---------------------------------------------------------------- stories


class StoryIn(BaseModel):
    id: int | None = None
    title: str = Field(min_length=2, max_length=200)
    situation: str = Field("", max_length=3000)
    task: str = Field("", max_length=3000)
    action: str = Field("", max_length=3000)
    result: str = Field("", max_length=3000)
    tags: list[str] = Field(default_factory=list, max_length=6)


@router.get("/app/stories")
def stories_page(request: Request, user: User = Depends(require_user), db: Session = Depends(get_db)):
    stories = list(db.scalars(select(Story).where(Story.user_id == user.id).order_by(Story.updated_at.desc())))
    covered = {tag for story in stories for tag in story.tags}
    return render(
        request, "stories.html", user=user, nav="stories", stories=stories, competencies=COMPETENCIES,
        missing=[c for c in COMPETENCIES if c not in covered], free_limit=FREE_STORIES,
        prompt=(get_setting(db, "prompts") or {}).get("story", ""),
    )


@router.post("/api/stories", dependencies=[Depends(check_csrf)])
def save_story(body: StoryIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    if body.id is None:
        count = db.scalar(select(func.count(Story.id)).where(Story.user_id == user.id)) or 0
        if count >= FREE_STORIES and not user.has_pass:
            raise HTTPException(403, f"Free accounts keep {FREE_STORIES} stories. Pro keeps as many as you like.")
        story = Story(user_id=user.id)
        db.add(story)
    else:
        story = db.get(Story, body.id)
        if story is None or story.user_id != user.id:
            raise HTTPException(404)
    for field in ("title", "situation", "task", "action", "result"):
        setattr(story, field, getattr(body, field).strip())
    story.tags = [tag for tag in body.tags if tag in COMPETENCIES]
    story.updated_at = utcnow()
    db.commit()
    return {"id": story.id}


@router.delete("/api/stories/{story_id}", dependencies=[Depends(check_csrf)])
def delete_story(story_id: int, user: User = Depends(require_user), db: Session = Depends(get_db)):
    story = db.get(Story, story_id)
    if story is None or story.user_id != user.id:
        raise HTTPException(404)
    db.delete(story)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- sharing and public pages


class ShareIn(BaseModel):
    on: bool


@router.post("/api/sessions/{sid}/share", dependencies=[Depends(check_csrf)])
def share_report(sid: int, body: ShareIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    session = db.get(InterviewSession, sid)
    if session is None or session.user_id != user.id or session.status != "completed":
        raise HTTPException(404)
    if body.on:
        session.share_slug = session.share_slug or secrets.token_urlsafe(9)
    else:
        session.share_slug = None
    db.commit()
    return {"url": f"{config.base_url}/r/{session.share_slug}" if session.share_slug else ""}


def tried_pro_packs(db: Session, user: User | None) -> list[str]:
    """Pro interview types whose one free try this person has already used."""
    if user is None or user.has_pass:
        return []
    rows = db.scalars(
        select(InterviewSession.pack_slug)
        .join(Pack, Pack.slug == InterviewSession.pack_slug)
        .where(InterviewSession.user_id == user.id, InterviewSession.status == "completed", Pack.pro)
        .distinct()
    )
    return list(rows)


def story_sources(report: dict) -> list[dict]:
    """Per question: what was asked and what the person said, for "Save as a story"."""
    blocks = []
    for block in report.get("blocks", []):
        said = " ".join(t["text"] for t in block.get("turns", []) if t.get("who") == "you")
        blocks.append({"q": block.get("q", ""), "said": said})
    return blocks


def pack_data(db: Session, slug: str) -> dict[str, Any]:
    pack = db.get(Pack, slug)
    return pack.data if pack else {"title": slug}


@router.get("/r/{slug}")
def shared_report(request: Request, slug: str, user: User | None = Depends(current_user), db: Session = Depends(get_db)):
    """The summary and scores only. What the person actually said stays private."""
    session = db.scalar(select(InterviewSession).where(InterviewSession.share_slug == slug))
    if session is None or not session.report:
        raise HTTPException(404)
    owner = db.get(User, session.user_id) if session.user_id else None
    return render(request, "report.html", user=user, session=session, r=session.report, view="shared",
                  pack=pack_data(db, session.pack_slug), owner=owner.first_name if owner else "Someone")


@router.get("/sample")
def sample_report(request: Request, user: User | None = Depends(current_user)):
    session = SimpleNamespace(id=0, started_at=utcnow(), duration_s=14 * 60, share_slug=None)
    return render(request, "report.html", user=user, session=session, r=seed_data()["sample_report"],
                  view="sample", pack={"title": "Behavioral", "parts": ["Situation", "Task", "Action", "Result"]})


@router.get("/questions")
def question_library(request: Request, user: User | None = Depends(current_user), db: Session = Depends(get_db)):
    packs = []
    for pack in active_packs(db):
        questions = list(dict.fromkeys([pack["opener"], *(item["q"] for item in pack.get("bank", []))]))
        if len(questions) > 1:
            packs.append({**pack, "questions": questions})
    return render(request, "questions.html", user=user, nav="questions", packs=packs,
                  total=sum(len(p["questions"]) for p in packs))


@router.get("/sitemap.xml")
def sitemap():
    pages = ["/", "/questions", "/sample", "/pricing", "/login", "/privacy", "/terms"]
    urls = "".join(f"<url><loc>{config.base_url}{path}</loc></url>" for path in pages)
    xml = f'<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{urls}</urlset>'
    return Response(xml, media_type="application/xml")
