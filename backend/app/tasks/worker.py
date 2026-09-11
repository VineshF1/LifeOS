"""Celery app, DLQ routing, Windows event-loop fix (Phase 3).

The heavy pipeline reuses the proven V2 ingestion functions
(app.ingestion: extract_pages / chunk_pages / embed_documents /
extract_metadata) — Celery changes WHERE they run, not HOW.
"""
from __future__ import annotations

import asyncio
import sys

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from asgiref.sync import async_to_sync  # noqa: E402
from celery import Celery  # noqa: E402

from app.config import settings  # noqa: E402

celery_app = Celery("lifeos_tasks", broker=settings.REDIS_URL, backend=settings.REDIS_URL)
celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_routes={
        "app.tasks.ingestion.process_document_pipeline": {"queue": "document_pipeline"},
        "app.tasks.worker.handle_poison_pill_dlq": {"queue": "celery_dlq"},
    },
)


@celery_app.task(queue="celery_dlq")
def handle_poison_pill_dlq(doc_id: str, user_id: str, error_msg: str, correlation_id: str):
    """Actual DLQ task: marks the document failed, writes audit, emits SSE alert."""
    from app.tasks.ingestion import record_dead_letter

    async_to_sync(record_dead_letter)(doc_id, user_id, error_msg, correlation_id)


@celery_app.task(bind=True, max_retries=3, default_retry_delay=2)
def process_document_pipeline(self, doc_id: str, user_id: str, user_email: str, correlation_id: str):
    from app.tasks.ingestion import RowNotVisibleYet, run_ingestion_pipeline

    try:
        async_to_sync(run_ingestion_pipeline)(doc_id, user_id, user_email, correlation_id)
    except RowNotVisibleYet as exc:
        # Upload commit race — retry on a slower clock, no DLQ escalation
        # until retries are truly exhausted.
        raise self.retry(exc=exc, countdown=5)
    except Exception as exc:
        if self.request.retries >= self.max_retries:
            # Real dispatched DLQ — not a log line.
            handle_poison_pill_dlq.apply_async(
                args=[doc_id, user_id, str(exc), correlation_id],
                queue="celery_dlq",
            )
        else:
            raise self.retry(exc=exc, countdown=2 ** self.request.retries)
