# Prova — Operational Runbook (Phase 3)

## Local startup (Docker Compose)

```bash
cp backend/.env.example backend/.env   # fill DATABASE_URL (Neon -pooler :6543), NVIDIA_API_KEY, JWT_SECRET
docker compose up --build
# API: http://localhost:8000/docs | Frontend: http://localhost:3000
```

Without Docker (dev):

```bash
# backend
cd backend && pip install -r requirements.txt
python -m app.init_db                 # schema.sql + phase2.sql + phase3.sql (idempotent)
uvicorn app.main:app --reload         # single worker
redis-server &                        # queue + rate limiter + Pub/Sub
celery -A app.tasks.worker.celery_app worker --loglevel=info --concurrency=2 \
  --max-tasks-per-child=50 -Q document_pipeline,celery_dlq
# frontend
cd frontend && npm install && npm run dev
```

## Health verification

```bash
curl localhost:8000/api/health/liveness            # 200: process alive
curl localhost:8000/api/health/readiness           # 200 ready / 503 degraded (db, redis, celery)
curl localhost:8000/health                         # legacy meta probe (V2)
```

## Failure drills

- **NIM 429/504 during ingestion**: worker logs `chunk_embeddings_generated`
  retries with backoff (2s→4s→8s); document stays `embedding` until success.
- **Poison pill**: after 3 retries the job dispatches to `celery_dlq`;
  `handle_poison_pill_dlq` marks the doc `failed`, writes a `dlq_ingest` audit
  row, and pushes `document_failed` over SSE. Inspect:
  `celery -A app.tasks.worker.celery_app inspect active -Q celery_dlq`.
- **Rate limits**: uploads 10/min, chat 20/min, auth 5/min → HTTP 429 with
  `Retry-After`. SlowAPI honours `X-Forwarded-For` behind one proxy.
- **Stuck `queued` doc**: worker retries the upload-commit race 3× (5s clock);
  if still `queued`, confirm the API committed the row and Redis is reachable.

## Known limitations

- Single-region Neon: cross-region latency and the 10-connection pooled budget
  (`pool_size=5, max_overflow=5` per API replica) bound horizontal scale; add
  read replicas before >4 API workers.
- Razorpay Checkout popups are blocked by aggressive popup blockers — the
  pricing page surfaces an inline fallback link.
- Browser `EventSource` cannot POST: chat streams over `fetch`, notifications
  carry the token in the query string (short-lived signed JWT).
- Celery on Windows dev boxes needs the `WindowsSelectorEventLoopPolicy` guard
  (already in `tasks/worker.py`); prefer WSL2 + Docker for parity.
