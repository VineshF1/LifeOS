# LifeOS Agent — System Architecture (Phase 3)

End-to-end data flow, queue design, and trust boundaries. Phases 1–2 (sync
ingestion, JWT auth, LangGraph approvals, Razorpay billing) are retained; Phase 3
adds the async pipeline, RLS hardening, and observability below.

## Topology

```
                    ┌─────────────┐   HTTPS    ┌──────────────────┐
                    │  Next.js 15 │ ─────────► │  backend-api x4  │
                    │  frontend   │ ◄───────── │  FastAPI workers │
                    │  :3000      │    SSE     │  :8000           │
                    └─────────────┘            └────┬───┬─────────┘
                                                    │   │
                                  shared_uploads    │   │  document_pipeline / celery_dlq
                                  /app/uploads      │   ▼
                               ┌────────────────────┐  ┌──────────────┐
                               │   celery-worker xN │◄─│ Redis 7+     │
                               │   --max-tasks-     │  │ broker+result│
                               │   per-child=50     │  │ + Pub/Sub    │
                               └────────┬───────────┘  └──────────────┘
                                        │ NullPool, one conn/task
                                        ▼
                               ┌────────────────────┐      ┌──────────────────┐
                               │ Neon PostgreSQL    │◄─────│ NVIDIA NIM       │
                               │ pgvector halfvec   │ NIM  │ chat + embeddings│
                               │ RLS FORCE policies │ API  │ (transient only) │
                               └────────────────────┘      └──────────────────┘
```

Networks: API + worker + redis share the compose network; only API (`:8000`)
and frontend (`:3000`) publish host ports. Scale workers independently:
`docker compose up --scale celery-worker=3`.

## Document lifecycle

Ingestion → Shared Volume → Celery Queue → RLS-scoped Chunking & Embeddings → Pub/Sub Notification:

1. `POST /documents/upload-async` validates quota (free ≤ 5) + PDF magic,
   writes bytes to `/app/uploads/{doc_id}.pdf` (shared volume), inserts the
   row (`status='queued'`, `job_id`), and dispatches
   `process_document_pipeline` to the `document_pipeline` queue. Returns **202**.
2. Worker Boundary 1: aborts if `status='deleted'`; missing row (upload commit
   race) raises for backoff retry. Sets `status='parsing'`, publishes progress
   to Redis channel `notifications:{user_id}`.
3. PyMuPDF extraction (block-level + AcroForm fallbacks); scanned PDFs with no
   text layer degrade to `needs_review`. Text is sanitization-scanned and
   wrapped in `<untrusted_document_context>` envelopes before any model call.
4. Boundary 2 → Nemotron-3 structured metadata extraction (Pydantic schema).
5. Chunking (400 tokens / 15% overlap, per-page numbering) → idempotent reset
   (`DELETE` chunks for the doc) → batch embeddings (`nemotron-3-embed-1b`,
   2048-d) → batch insert as `halfvec` with tenant `user_id`.
6. Deadline detection drafts rows into `pending_actions` (human-in-the-loop);
   sets `status='ready'`; publishes completion. `GET /notifications/live`
   bridges Redis Pub/Sub to client SSE (`ProcessingCard` stepper).

Failures retry with exponential backoff (2s → 4s → 8s, incl. NIM 429/504 via
tenacity); after max retries the job is **dispatched** to the real
`celery_dlq` queue (`handle_poison_pill_dlq` marks `failed`, audits, alerts).

## Interactive chat flow

In-process SSE → LangGraph State Machine → Tenant-Scoped Tools → Exact Chunk
Citation → Streamed Response. Chat NEVER enters Celery/Redis (double-hop
latency would hold sockets across proxy boundaries). Tool calls resolve
`[REF: chunk_uuid]` tags against chunks actually shown to the model; unknown
refs are dropped. Final answers pass the token-buffered canary gate
(`CANARY_` sliding window, 32 chars) before emission.

## Trust boundaries

- **Tenant GUCs**: every session sets `app.current_user_id` AND
  `app.current_user_email` together (V2 `set_config(..., is_local=true)`;
  Celery uses `NullPool` + same calls). Missing email fails shared-access
  policies closed — never silently open.
- **audit_logs**: split SELECT (tenant reads own) / INSERT (tenant + NULL
  system/DLQ rows) policies; no default-denials on pre-auth events.
- **Tools**: `user_id`/`user_email` come from session params only — LLM args
  are never trusted for tenancy.
- **Billing**: Razorpay HMAC-SHA256 webhook verification, fail-loud on partial
  keys; demo mode only when ALL keys are empty.
