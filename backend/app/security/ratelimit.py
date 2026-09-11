"""Redis-backed token-bucket rate limiting with segregated policies.

Implemented as FastAPI dependencies on top of the `limits` library
(MovingWindow + RedisStorage) — the same backend SlowAPI uses, without its
route decorator, which fastapi 0.115.6 cannot introspect on endpoints that
combine Request/File/Depends parameters.

Fail-open: if Redis is unreachable the request proceeds (and logs) rather
than 500ing all traffic; `/api/health/readiness` surfaces the outage.
"""
from __future__ import annotations

import logging
from functools import lru_cache

from fastapi import HTTPException, Request

logger = logging.getLogger("lifeos.ratelimit")
# Segregated policies
LIMIT_UPLOAD = "10/minute"    # file uploads per authenticated user
LIMIT_CHAT = "20/minute"      # agent inference / chat per authenticated user
LIMIT_AUTH = "5/minute"       # login/signup per IP address


def _rate_key(request: Request) -> str:
    # Authenticated users: per-user bucket (hint set by correlation middleware);
    # anonymous: per-IP bucket.
    user = getattr(request.state, "user_id", None)
    if user:
        return f"user:{user}"
    client = request.client.host if request.client else "unknown"
    forwarded = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    return f"ip:{forwarded or client}"


@lru_cache(maxsize=32)
def _limit_item(limit_str: str):
    from limits import parse

    return parse(limit_str)


def _strategy():
    from limits.storage import RedisStorage
    from limits.strategies import MovingWindowRateLimiter

    from app.config import settings

    return MovingWindowRateLimiter(RedisStorage(settings.REDIS_URL))


_strategy_cached = lru_cache(maxsize=1)(_strategy)


def check_limit(request: Request, limit_str: str) -> None:
    """Sync (threadpool-safe) check. Raises 429 with Retry-After on breach."""
    try:
        strategy = _strategy_cached()
        item = _limit_item(limit_str)
        key = _rate_key(request)
        if strategy.hit(item, key):
            return
        reset_in, _remaining = strategy.get_window_stats(item, key)
        raise HTTPException(
            status_code=429,
            detail="Rate limit exceeded. Slow down and retry.",
            headers={"Retry-After": str(int(reset_in) + 1)},
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - limiter must never break traffic
        logger.error("Rate limiter backend unreachable, failing open: %s", exc)


def limit_upload(request: Request) -> None:
    check_limit(request, LIMIT_UPLOAD)


def limit_chat(request: Request) -> None:
    check_limit(request, LIMIT_CHAT)


def limit_auth(request: Request) -> None:
    check_limit(request, LIMIT_AUTH)
