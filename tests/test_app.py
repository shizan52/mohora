import copy
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path

# Configure before the app is imported: a throwaway database and no external services.
_tmp = Path(tempfile.mkdtemp())
os.environ.update({
    "DB_PATH": str(_tmp / "test.db"),
    "BASE_URL": "http://127.0.0.1:8000",
    "SECRET_KEY": "test-secret",
    "GOOGLE_CLIENT_ID": "",
    "GOOGLE_CLIENT_SECRET": "",
    "TELEGRAM_BOT_TOKEN": "",
    "TELEGRAM_ADMIN_CHAT_ID": "",
    "ADMIN_EMAILS": "owner@example.com",
})

import pytest
from fastapi.testclient import TestClient

from app import billing, notify, practice
from app.admin import validate_pack
from app.db import InterviewSession, Payment, ReviewItem, SessionLocal, Story, User, set_setting
from app.main import app
from app.web import mark_answer

REPORT = {
    "version": 1, "overall": 3.5,
    "rubric": [{"id": "structure", "label": "Structure", "avg": 3.5}],
    "summary": {"headline": "Clear stories, thin results.", "best_moment": {"quote": "I wrote the script", "why": "ownership"},
                "fix_next": "Give a number for the result.", "strengths": [], "focus": []},
    "delivery": {"words": 40, "wpm": 140, "filler_count": 1, "filler_rate": 2.5, "fillers": {"um": 1},
                 "latency_s": 1.2, "spoken": True, "terms": ["um"]},
    "blocks": [{"q": "Tell me about a failure.", "source": "role", "skipped": False, "attempts": 0,
                "turns": [{"who": "ai", "text": "Tell me about a failure."},
                          {"who": "you", "text": "Um, I wrote the script <b>myself</b>."}],
                "eval": {"scores": {"structure": 3.5}, "overall": 3.5, "worked": ["Owned it"], "improve": ["Add numbers"],
                         "fix_next": "Numbers.", "quotes": [{"text": "I wrote the script", "type": "strong", "note": "good"}],
                         "rewrite": "I wrote the rollback script myself."}}],
    "interviewer": {"name": "Ayesha Rahman", "role": "Hiring Manager"},
    "options": {"role": "Developer", "company": "", "lang": "en"},
    "ai": {"provider": "groq", "model": "llama", "coach": "llama"},
}


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def csrf(client: TestClient, path: str = "/") -> str:
    return re.search(r'name="csrf" content="([^"]+)"', client.get(path).text).group(1)


def sign_in(client: TestClient, email: str) -> str:
    token = csrf(client, "/login")
    res = client.post("/auth/dev", data={"email": email, "name": "Test Person", "csrf": token}, follow_redirects=False)
    assert res.status_code == 303
    return csrf(client, "/")


def test_public_pages(client):
    assert "Rehearse your next interview" in client.get("/").text
    for path in ("/privacy", "/terms", "/login", "/healthz", "/robots.txt"):
        assert client.get(path).status_code == 200
    assert client.get("/nope").status_code == 404
    assert "default-src 'self'" in client.get("/").headers["content-security-policy"]


def test_app_needs_sign_in(client):
    res = client.get("/app", follow_redirects=False)
    assert res.status_code == 303
    assert res.headers["location"] == "/login?next=/app"
    assert client.get("/api/me/export").status_code == 401


def test_first_sign_in_goes_to_onboarding(client):
    token = csrf(client, "/login")
    res = client.post("/auth/dev", data={"email": "new@example.com", "csrf": token}, follow_redirects=False)
    assert res.headers["location"] == "/onboarding"
    assert client.get("/app").status_code == 200


def test_mutations_need_csrf(client):
    sign_in(client, "csrf@example.com")
    assert client.post("/api/sessions", json={"pack": "behavioral-star"}).status_code == 403


def test_interview_report_flow(client):
    token = sign_in(client, "flow@example.com")
    headers = {"X-CSRF-Token": token}
    sid = client.post("/api/sessions", json={"pack": "behavioral-star", "config": {"role": "Developer"}}, headers=headers).json()["id"]
    assert client.get(f"/app/session/{sid}", follow_redirects=False).status_code == 303

    res = client.patch(f"/api/sessions/{sid}", json={"status": "completed", "overall": 3.5, "report": REPORT}, headers=headers)
    assert res.status_code == 200
    page = client.get(f"/app/session/{sid}").text
    assert "Clear stories, thin results." in page
    assert '<mark class="m-strong" title="good">I wrote the script</mark>' in page
    assert "&lt;b&gt;myself&lt;/b&gt;" in page
    assert client.patch(f"/api/sessions/{sid}", json={"overall": 1}, headers=headers).status_code == 409


def test_unknown_pack_is_rejected(client):
    token = sign_in(client, "pack@example.com")
    res = client.post("/api/sessions", json={"pack": "nope"}, headers={"X-CSRF-Token": token})
    assert res.status_code == 404


def test_guest_interview_is_claimed_on_sign_in(client):
    assert client.get("/app/new").status_code == 200
    token = csrf(client, "/app/new")
    sid = client.post("/api/sessions", json={"pack": "fresher-hr"}, headers={"X-CSRF-Token": token}).json()["id"]
    sign_in(client, "guest@example.com")
    with SessionLocal() as db:
        session = db.get(InterviewSession, sid)
        user = db.query(User).filter_by(email="guest@example.com").one()
        assert session.user_id == user.id and session.guest_token is None


def test_sessions_are_private(client):
    token = sign_in(client, "owner-a@example.com")
    sid = client.post("/api/sessions", json={"pack": "behavioral-star"}, headers={"X-CSRF-Token": token}).json()["id"]
    with TestClient(app) as other:
        other_token = sign_in(other, "owner-b@example.com")
        assert other.get(f"/app/room/{sid}").status_code == 404
        assert other.patch(f"/api/sessions/{sid}", json={"overall": 5}, headers={"X-CSRF-Token": other_token}).status_code == 404


def test_transcripts_are_dropped_when_saving_is_off(client):
    token = sign_in(client, "private@example.com")
    headers = {"X-CSRF-Token": token}
    client.post("/api/me", json={"prefs": {"save_transcripts": False}}, headers=headers)
    sid = client.post("/api/sessions", json={"pack": "behavioral-star"}, headers=headers).json()["id"]
    client.patch(f"/api/sessions/{sid}", json={"transcript": [{"who": "you", "text": "secret"}], "status": "completed", "report": REPORT}, headers=headers)
    with SessionLocal() as db:
        session = db.get(InterviewSession, sid)
        assert session.transcript is None
        assert "turns" not in session.report["blocks"][0]


def test_admin_pages(client):
    sign_in(client, "someone@example.com")
    assert client.get("/admin").status_code == 404
    with TestClient(app) as owner:
        sign_in(owner, "owner@example.com")
        for path in ("/admin", "/admin/users", "/admin/packs", "/admin/packs/behavioral-star", "/admin/settings", "/admin/inbox", "/admin/payments"):
            assert owner.get(path).status_code == 200, path


def test_relay_only_reaches_known_providers(client):
    token = csrf(client)
    res = client.post("/api/relay", json={"provider": "evil", "path": "/chat/completions", "key": "x"}, headers={"X-CSRF-Token": token})
    assert res.status_code == 400
    res = client.post("/api/relay", json={"provider": "openai", "path": "/files", "key": "x"}, headers={"X-CSRF-Token": token})
    assert res.status_code == 400


def test_pack_validation():
    assert validate_pack({"slug": "Bad Slug"}) is not None
    good = {"slug": "ok-pack", "title": "T", "brief": "B", "opener": "O", "interviewer": {"name": "N", "role": "R"},
            "rubric": [{"id": "a", "label": "A"}], "competencies": [], "bank": [], "rules": []}
    assert validate_pack(good) is None


def test_mark_answer_escapes_and_marks():
    html = str(mark_answer("Um <script>x</script> I led it", [{"text": "I led it", "type": "strong"}], ["um"]))
    assert "<script>" not in html
    assert '<mark class="m-filler" title="filler word">Um</mark>' in html
    assert '<mark class="m-strong">I led it</mark>' in html


def test_telegram_messages_escape_html():
    card = {"id": 7, "name": "<Rahim>", "email": "r@example.com", "created_at": datetime(2026, 11, 9, 15, 14)}
    text = notify.new_user_text(card, 42, {"country": "BD", "device": "Chrome on Android", "source": "linkedin"})
    assert "<b>New user #42</b>" in text
    assert "&lt;Rahim&gt;" in text
    assert "BD, Chrome on Android, via linkedin" in text
    assert "9 Nov 2026, 21:14" in text  # Asia/Dhaka is UTC+6


TRC20_WALLET = "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE"


def use_wallet():
    with SessionLocal() as db:
        set_setting(db, "billing", {"trc20_address": TRC20_WALLET, "bep20_address": "", "price_usdt": 1, "days": 30})


def fake_transfers(monkeypatch, value: str, tx: str):
    async def transfers(address):
        return [{"transaction_id": tx, "to": address, "value": value,
                 "token_info": {"address": billing.USDT_TRC20, "decimals": 6}}]
    monkeypatch.setattr(billing, "fetch_trc20_transfers", transfers)


def test_pricing_and_pay_pages(client):
    use_wallet()
    assert "1 USDT" in client.get("/pricing").text
    assert client.get("/pay", follow_redirects=False).status_code == 303
    sign_in(client, "viewer@example.com")
    page = client.get("/pay").text
    assert TRC20_WALLET in page and "<svg" in page


def test_trc20_payment_turns_pro_on(client, monkeypatch):
    use_wallet()
    tx = "ab" * 32
    fake_transfers(monkeypatch, "1000000", tx)
    token = sign_in(client, "payer@example.com")
    res = client.post("/api/payments", json={"network": "trc20", "tx_id": tx}, headers={"X-CSRF-Token": token})
    assert res.json()["status"] == "approved"
    with SessionLocal() as db:
        assert db.query(User).filter_by(email="payer@example.com").one().has_pass
    again = client.post("/api/payments", json={"network": "trc20", "tx_id": tx}, headers={"X-CSRF-Token": token})
    assert again.status_code == 409


def test_bad_payments_are_refused(client, monkeypatch):
    use_wallet()
    token = sign_in(client, "cheap@example.com")
    headers = {"X-CSRF-Token": token}
    assert client.post("/api/payments", json={"network": "trc20", "tx_id": "nope"}, headers=headers).status_code == 400
    fake_transfers(monkeypatch, "500000", "cd" * 32)
    assert client.post("/api/payments", json={"network": "trc20", "tx_id": "cd" * 32}, headers=headers).status_code == 400
    fake_transfers(monkeypatch, "1000000", "ef" * 32)
    res = client.post("/api/payments", json={"network": "trc20", "tx_id": "12" * 32}, headers=headers)
    assert res.json()["status"] == "pending"


def test_admin_approves_a_pending_payment(client, monkeypatch):
    use_wallet()
    fake_transfers(monkeypatch, "1000000", "00" * 32)
    token = sign_in(client, "manual@example.com")
    client.post("/api/payments", json={"network": "trc20", "tx_id": "34" * 32}, headers={"X-CSRF-Token": token})
    with SessionLocal() as db:
        pid = db.query(Payment).filter_by(tx_id="34" * 32).one().id
    with TestClient(app) as owner:
        sign_in(owner, "owner@example.com")
        res = owner.post(f"/admin/payments/{pid}", data={"action": "approve", "csrf": csrf(owner, "/admin/payments")},
                         follow_redirects=False)
        assert res.status_code == 303
    with SessionLocal() as db:
        assert db.query(User).filter_by(email="manual@example.com").one().has_pass


def test_hiring_journey_needs_pro(client):
    token = sign_in(client, "journey@example.com")
    body = {"pack": "recruiter-screen", "config": {"journey": {"id": "j1", "stages": ["recruiter-screen"], "index": 0}}}
    assert client.post("/api/sessions", json=body, headers={"X-CSRF-Token": token}).status_code == 403


def finish(client, headers, pack="behavioral-star", score=3.5, config=None) -> int:
    """Start an interview and complete it with one answer scored `score`."""
    report = copy.deepcopy(REPORT)
    report["overall"] = report["blocks"][0]["eval"]["overall"] = score
    body = {"pack": pack, "config": config or {"role": "Developer"}}
    sid = client.post("/api/sessions", json=body, headers=headers).json()["id"]
    res = client.patch(f"/api/sessions/{sid}", json={"status": "completed", "overall": score, "report": report}, headers=headers)
    assert res.status_code == 200
    return sid


def test_library_sample_and_sitemap(client):
    page = client.get("/questions").text
    assert "Salary negotiation" in page and "What a good answer shows" in page
    sample = client.get("/sample").text
    assert "Real stories and one great number" in sample and "Result missing" in sample
    assert "/questions" in client.get("/sitemap.xml").text
    assert "Sitemap:" in client.get("/robots.txt").text


def test_weak_answers_come_back_until_they_land(client):
    headers = {"X-CSRF-Token": sign_in(client, "loop@example.com")}
    assert client.get("/api/drill").status_code == 404
    finish(client, headers, score=3.5)
    drill = client.get("/api/drill").json()
    assert drill["questions"] == ["Tell me about a failure."] and drill["pack"]["slug"] == "behavioral-star"
    assert "weak answer" in client.get("/app").text
    for _ in range(3):
        finish(client, headers, score=4.5)
    with SessionLocal() as db:
        user = db.query(User).filter_by(email="loop@example.com").one()
        assert db.query(ReviewItem).filter_by(user_id=user.id).count() == 0


def test_shared_report_hides_the_answers(client):
    headers = {"X-CSRF-Token": sign_in(client, "sharer@example.com")}
    sid = finish(client, headers)
    url = client.post(f"/api/sessions/{sid}/share", json={"on": True}, headers=headers).json()["url"]
    with TestClient(app) as visitor:
        page = visitor.get(url.replace("http://127.0.0.1:8000", ""))
        assert page.status_code == 200 and "Clear stories, thin results." in page.text
        assert "myself" not in page.text and "rollback" not in page.text
        assert visitor.post(f"/api/sessions/{sid}/share", json={"on": False}).status_code in (401, 403)
    client.post(f"/api/sessions/{sid}/share", json={"on": False}, headers=headers)
    assert client.get(url.replace("http://127.0.0.1:8000", "")).status_code == 404


def test_story_bank(client):
    headers = {"X-CSRF-Token": sign_in(client, "teller@example.com")}
    story = {"title": "Payment timeout fix", "situation": "Payments failed.", "action": "I fixed it.", "tags": ["ownership", "nonsense"]}
    first = client.post("/api/stories", json=story, headers=headers).json()["id"]
    assert client.post("/api/stories", json={**story, "id": first, "title": "Renamed"}, headers=headers).status_code == 200
    for _ in range(practice.FREE_STORIES - 1):
        assert client.post("/api/stories", json=story, headers=headers).status_code == 200
    assert client.post("/api/stories", json=story, headers=headers).status_code == 403
    page = client.get("/app/stories").text
    assert "Renamed" in page and "No story yet for" in page
    with SessionLocal() as db:
        assert db.get(Story, first).tags == ["ownership"]
    with TestClient(app) as other:
        other_headers = {"X-CSRF-Token": sign_in(other, "nosy@example.com")}
        assert other.delete(f"/api/stories/{first}", headers=other_headers).status_code == 404
    assert client.delete(f"/api/stories/{first}", headers=headers).status_code == 200


def test_referral_gives_both_people_pro(client):
    sign_in(client, "inviter@example.com")
    with SessionLocal() as db:
        code = db.query(User).filter_by(email="inviter@example.com").one().referral_code
    with TestClient(app) as friend:
        friend.get(f"/?ref={code}")
        headers = {"X-CSRF-Token": sign_in(friend, "invited@example.com")}
        finish(friend, headers)
    with SessionLocal() as db:
        inviter = db.query(User).filter_by(email="inviter@example.com").one()
        invited = db.query(User).filter_by(email="invited@example.com").one()
        assert invited.referred_by == inviter.id
        assert inviter.has_pass and invited.has_pass


def test_pro_interview_types_allow_one_free_try(client):
    body = {"pack": "visa-f1", "config": {"role": "F-1 visa applicant"}}
    assert client.post("/api/sessions", json=body, headers={"X-CSRF-Token": csrf(client)}).status_code == 403
    headers = {"X-CSRF-Token": sign_in(client, "student@example.com")}
    finish(client, headers, pack="visa-f1")
    assert client.post("/api/sessions", json=body, headers=headers).status_code == 403
    assert "visa-f1" in client.get("/app/new").text


def test_readiness_and_plan():
    assert practice.readiness([], 0, 0)["score"] == 0
    packs = {"behavioral-star": {"slug": "behavioral-star", "title": "Behavioral", "pro": False, "minutes": 20}}
    plan = practice.build_plan({}, packs, 2)
    assert [item["kind"] for item in plan] == ["interview", "review", "warmup"]
    assert len(practice.build_plan({}, packs, None)) == 5


def test_plan_calendar_download(client):
    sign_in(client, "planner@example.com")
    res = client.get("/app/plan.ics")
    assert res.headers["content-type"].startswith("text/calendar") and "BEGIN:VEVENT" in res.text
