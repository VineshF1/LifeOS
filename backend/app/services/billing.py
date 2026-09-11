"""SaaS tier enforcement + Razorpay billing (Phase 2).

Two modes:
- Live Razorpay (RAZORPAY_KEY_ID/SECRET set): create a Subscription against
  the dashboard Plan (RAZORPAY_PLAN_ID); the frontend opens Razorpay Checkout
  with the subscription id; the `subscription.activated` webhook flips
  `subscription_tier` to 'pro' after signature verification.
- Demo mode (no keys): deterministic database-level gating so the judging
  demo works without Razorpay keys — checkout instantly flips the tier, with
  the same audit trail a webhook would write.
"""
from __future__ import annotations

import json
import logging
from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import get_tenant_session
from ..security import CurrentUser, get_current_user

logger = logging.getLogger("lifeos.billing")

FREE_TIER = "free"
PRO_TIER = "pro"


async def get_tier(session: AsyncSession, user_id: UUID) -> str:
    row = await session.scalar(
        text("SELECT COALESCE(subscription_tier, 'free') FROM users WHERE id = CAST(CAST(:uid AS text) AS uuid)"),
        {"uid": str(user_id)},
    )
    return (row or FREE_TIER).lower()


async def get_document_count(session: AsyncSession, user_id: UUID) -> int:
    row = await session.scalar(
        text("SELECT COUNT(*) FROM documents WHERE user_id = CAST(CAST(:uid AS text) AS uuid)"),
        {"uid": str(user_id)},
    )
    return int(row or 0)


async def check_tier_limit(
    user: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_tenant_session),
) -> CurrentUser:
    """Block uploads for free-tier users at the document cap (403)."""
    tier = await get_tier(session, user.id)
    if tier == FREE_TIER and await get_document_count(session, user.id) >= settings.FREE_DOCUMENT_LIMIT:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Upload limit reached for Free Tier. Upgrade to Pro for unlimited document management.",
        )
    return user


async def require_pro(
    user: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_tenant_session),
) -> CurrentUser:
    """Block Pro-only features (synthesis, sharing, calendar) for free tier."""
    if await get_tier(session, user.id) != PRO_TIER:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This feature requires a Pro subscription. Upgrade to unlock it.",
        )
    return user


async def set_tier(session: AsyncSession, user_id: UUID, tier: str, *, customer_id: str | None = None) -> None:
    await session.execute(
        text(
            "UPDATE users SET subscription_tier = :tier"
            + (", razorpay_customer_id = :cid" if customer_id else "")
            + " WHERE id = CAST(CAST(:uid AS text) AS uuid)"
        ),
        {"tier": tier, "uid": str(user_id), **({"cid": customer_id} if customer_id else {})},
    )


def _key_secret() -> str:
    return settings.RAZORPAY_KEY_SECRET or settings.RAZORPAY_SECRET


def razorpay_configured() -> bool:
    return bool(settings.RAZORPAY_KEY_ID and _key_secret() and settings.RAZORPAY_PLAN_ID)


def _client():
    import razorpay

    return razorpay.Client(auth=(settings.RAZORPAY_KEY_ID, _key_secret()))


async def create_checkout_session(session: AsyncSession, user: CurrentUser) -> dict:
    """Return a Razorpay subscription to open in Checkout, or flip tier (demo)."""
    if await get_tier(session, user.id) == PRO_TIER:
        return {"subscription_id": None, "message": "Already on Pro."}
    if not razorpay_configured():
        # Partial keys (e.g. Key ID set but no Plan ID) mean the gateway was
        # meant to be live: fail loudly instead of silently instant-upgrading,
        # which masks the misconfiguration.
        missing = [
            name
            for name, value in (
                ("RAZORPAY_KEY_ID", settings.RAZORPAY_KEY_ID),
                ("RAZORPAY_KEY_SECRET", settings.RAZORPAY_KEY_SECRET),
                ("RAZORPAY_PLAN_ID", settings.RAZORPAY_PLAN_ID),
            )
            if not value
        ]
        if len(missing) < 3:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Razorpay is only partially configured (missing: {', '.join(missing)}). "
                "Add the missing value(s) to backend/.env (and the Render env) and restart the backend.",
            )
        await set_tier(session, user.id, PRO_TIER)
        logger.info("Demo-mode upgrade: %s -> pro", user.id)
        return {"subscription_id": None, "message": "Demo mode: upgraded to Pro."}
    try:
        subscription = _client().subscription.create(
            {
                "plan_id": settings.RAZORPAY_PLAN_ID,
                "total_count": 12,
                "customer_notify": 1,
                "notes": {"user_id": str(user.id), "email": user.email},
            }
        )
    except Exception as exc:  # noqa: BLE001 - key/plan misconfig must be a clean 502
        logger.error("Razorpay subscription create failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Payment service unavailable: {exc}",
        ) from exc
    return {
        "subscription_id": subscription["id"],
        "razorpay_key_id": settings.RAZORPAY_KEY_ID,
        "message": "Complete payment in Razorpay Checkout to activate Pro.",
    }


async def handle_webhook(session: AsyncSession, payload: bytes, signature: str | None) -> dict[str, str]:
    """Process `subscription.activated` / `subscription.charged` → tier to pro."""
    try:
        event = json.loads(payload.decode("utf-8") or "{}")
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid webhook payload.") from exc

    if razorpay_configured():
        if not signature:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing webhook signature.")
        try:
            _client().utility.verify_webhook_signature(payload.decode("utf-8"), signature, settings.RAZORPAY_WEBHOOK_SECRET)
        except Exception as exc:  # noqa: BLE001 - bad signature must be a clean 400
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid webhook signature: {exc}") from exc

    event_type = event.get("event", "")
    if event_type not in {"subscription.activated", "subscription.charged"}:
        return {"status": "ignored"}
    entity = (event.get("payload", {}) or {}).get("subscription", {}).get("entity", {}) or {}
    notes = entity.get("notes", {}) or {}
    target: str | None = notes.get("user_id")
    if target is None and entity.get("customer_id"):
        target = await session.scalar(
            text("SELECT id::text FROM users WHERE razorpay_customer_id = :cid"),
            {"cid": entity["customer_id"]},
        )
    if target is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot resolve user for subscription.")
    await set_tier(session, UUID(str(target)), PRO_TIER, customer_id=entity.get("customer_id"))
    logger.info("Webhook upgrade: %s -> pro", target)
    return {"status": "upgraded"}
