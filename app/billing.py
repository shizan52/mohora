"""Pro passes paid in USDT.

TRC20 (TRON) payments are verified automatically against the public TronGrid API, so a
pass can start seconds after the transfer. BEP20 payments go to the admin to approve.
"""

import logging
import re
from datetime import timedelta
from typing import Literal

import httpx
import segno
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from markupsafe import Markup
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import notify
from .auth import current_user, require_user
from .config import config
from .db import Payment, User, audit, billing_settings, get_db, utcnow
from .web import check_csrf, render

router = APIRouter()
log = logging.getLogger("mohora.billing")

USDT_TRC20 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
TRONGRID = "https://api.trongrid.io/v1/accounts/{address}/transactions/trc20"
NETWORKS = {
    "trc20": {"name": "TRON (TRC20)", "tx": re.compile(r"^[0-9a-f]{64}$"), "auto": True},
    "bep20": {"name": "BNB Smart Chain (BEP20)", "tx": re.compile(r"^0x[0-9a-f]{64}$"), "auto": False},
}


def grant_pass(user: User, days: int) -> None:
    start = max(user.pass_until or utcnow(), utcnow())
    user.pass_until = start + timedelta(days=days)


def qr_svg(text: str) -> Markup:
    return Markup(segno.make(text, error="m").svg_inline(dark="#141b3d", light="#ffffff", border=2, omitsize=True))


async def fetch_trc20_transfers(address: str) -> list[dict]:
    params = {"only_to": "true", "only_confirmed": "true", "limit": 200, "contract_address": USDT_TRC20}
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(TRONGRID.format(address=address), params=params)
        resp.raise_for_status()
        return resp.json().get("data", [])


async def verify_trc20(address: str, tx_id: str, amount: float) -> str:
    """Returns "ok", "small", "missing" or "error"."""
    try:
        transfers = await fetch_trc20_transfers(address)
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("TronGrid lookup failed (%s)", type(exc).__name__)
        return "error"
    for t in transfers:
        if t.get("transaction_id", "").lower() != tx_id:
            continue
        if t.get("to") != address or (t.get("token_info") or {}).get("address") != USDT_TRC20:
            return "missing"
        decimals = int((t.get("token_info") or {}).get("decimals", 6))
        paid = int(t.get("value", 0)) / 10**decimals
        return "ok" if paid + 1e-9 >= amount else "small"
    return "missing"


def payment_text(user: User, payment: Payment, outcome: str) -> str:
    return (
        f"<b>Payment {outcome}</b>\n{user.email}\n{payment.amount:g} USDT on {NETWORKS[payment.network]['name']}"
        f"\nTx: <code>{payment.tx_id}</code>\n{config.base_url}/admin/payments"
    )


@router.get("/pricing")
def pricing(request: Request, user: User | None = Depends(current_user), db: Session = Depends(get_db)):
    return render(request, "pricing.html", user=user, billing=billing_settings(db), nav="pricing")


@router.get("/pay")
def pay_page(
    request: Request, network: str = "trc20", user: User = Depends(require_user), db: Session = Depends(get_db)
):
    billing = billing_settings(db)
    if network not in NETWORKS:
        network = "trc20"
    address = billing.get(f"{network}_address", "")
    history = db.scalars(select(Payment).where(Payment.user_id == user.id).order_by(Payment.created_at.desc()).limit(5))
    return render(
        request, "pay.html", user=user, billing=billing, network=network, networks=NETWORKS,
        address=address, qr=qr_svg(address) if address else "", history=list(history), nav="pricing",
    )


class NewPayment(BaseModel):
    network: Literal["trc20", "bep20"]
    tx_id: str


@router.post("/api/payments", dependencies=[Depends(check_csrf)])
async def submit_payment(
    body: NewPayment,
    background: BackgroundTasks,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    billing = billing_settings(db)
    address = billing.get(f"{body.network}_address", "")
    if not address:
        raise HTTPException(400, "Payments on this network aren't set up yet.")
    tx_id = body.tx_id.strip().lower()
    if not NETWORKS[body.network]["tx"].match(tx_id):
        raise HTTPException(400, "That doesn't look like a transaction ID. Copy the full hash from your wallet.")
    if db.scalar(select(Payment).where(Payment.tx_id == tx_id)):
        raise HTTPException(409, "This transaction has already been submitted.")

    payment = Payment(user_id=user.id, network=body.network, tx_id=tx_id,
                      amount=float(billing["price_usdt"]), days=int(billing["days"]))
    db.add(payment)
    db.commit()

    if NETWORKS[body.network]["auto"]:
        result = await verify_trc20(address, tx_id, payment.amount)
        if result == "ok":
            payment.status = "approved"
            payment.reviewed_at = utcnow()
            payment.reviewed_by = "tron"
            grant_pass(user, payment.days)
            db.commit()
            background.add_task(notify.send_admin, payment_text(user, payment, "received"))
            return {"status": "approved", "message": f"Payment confirmed. Pro is active for {payment.days} days."}
        payment.note = {"small": "Amount was lower than the price.", "missing": "Not found on the blockchain yet.",
                        "error": "Couldn't reach TronGrid."}[result]
        db.commit()
        if result == "small":
            payment.status = "rejected"
            db.commit()
            raise HTTPException(400, f"The transfer was less than {payment.amount:g} USDT.")

    background.add_task(notify.send_admin, payment_text(user, payment, "to check"))
    return {"status": "pending", "message": "Thanks. We'll confirm the payment shortly; transfers can take a few minutes."}


@router.post("/api/payments/{pid}/recheck", dependencies=[Depends(check_csrf)])
async def recheck_payment(pid: int, user: User = Depends(require_user), db: Session = Depends(get_db)):
    payment = db.get(Payment, pid)
    if payment is None or payment.user_id != user.id:
        raise HTTPException(404)
    if payment.status != "pending" or not NETWORKS[payment.network]["auto"]:
        return {"status": payment.status}
    address = billing_settings(db).get("trc20_address", "")
    if await verify_trc20(address, payment.tx_id, payment.amount) == "ok":
        payment.status = "approved"
        payment.reviewed_at = utcnow()
        payment.reviewed_by = "tron"
        grant_pass(user, payment.days)
        db.commit()
    return {"status": payment.status}


def review_payment(db: Session, payment: Payment, approve: bool, admin_email: str) -> None:
    payment.status = "approved" if approve else "rejected"
    payment.reviewed_at = utcnow()
    payment.reviewed_by = admin_email
    if approve:
        grant_pass(db.get(User, payment.user_id), payment.days)
    db.commit()
    audit(db, admin_email, f"payment.{payment.status}", payment.tx_id)
