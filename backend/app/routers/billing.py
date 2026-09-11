"""Billing: Pro checkout + Razorpay webhook + tier status (Phase 2)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, Request
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_session, get_tenant_session
from ..schemas import CheckoutSessionOut
from ..security import CurrentUser, get_current_user
from ..services.billing import create_checkout_session, get_document_count, get_tier, handle_webhook

router = APIRouter(prefix="/billing", tags=["billing"])


@router.get("/status")
async def billing_status(
    user: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_tenant_session),
) -> dict:
    from ..config import settings
    from ..services.billing import razorpay_configured

    return {
        "subscription_tier": await get_tier(session, user.id),
        "document_count": await get_document_count(session, user.id),
        "free_limit": settings.FREE_DOCUMENT_LIMIT,
        "razorpay_configured": razorpay_configured(),
    }


@router.post("/create-checkout-session", response_model=CheckoutSessionOut)
async def create_checkout(
    user: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_tenant_session),
) -> CheckoutSessionOut:
    result = await create_checkout_session(session, user)
    return CheckoutSessionOut(
        subscription_id=result.get("subscription_id"),
        razorpay_key_id=result.get("razorpay_key_id"),
        subscription_tier=await get_tier(session, user.id),
        message=str(result["message"]),
    )


@router.post("/webhook")
async def billing_webhook(
    request: Request,
    x_razorpay_signature: str | None = Header(None),
    # Unauthenticated by design: Razorpay posts only x-razorpay-signature, no
    # JWT. Authenticity comes from the HMAC check in handle_webhook, and the
    # target user is resolved from the subscription notes (get_tenant_session
    # would 401 every genuine webhook here).
    session: AsyncSession = Depends(get_session),
) -> dict:
    payload = await request.body()
    return await handle_webhook(session, payload, x_razorpay_signature)
