# RUN — LifeOS-V3 (Phase 3)

Local dev on Windows 11. V3 backend `:8003`, V3 frontend `:3003`, plus Redis and a
Celery worker. Commands use Git-Bash paths.
(Docker Compose instead uses `:8000`/`:3000` — see section 5.)

## 1. Prerequisites

| Need | Version used |
| ---- | ------------ |
| Python | 3.11 |
| Node | 22 |
| Redis | 7+ (local `redis-server` or Docker) |
| Neon PostgreSQL | pooled URL (`-pooler`, `:6543`, `sslmode=require`), pgvector enabled |
| NVIDIA NIM key | `nvapi-...` (agent + embeddings) |
| Razorpay keys (`rzp_test_*`) | Key ID + Key Secret + Plan ID wired (live test checkout opens); webhook secret optional — only the post-payment tier flip needs it. No keys at all → demo-mode instant upgrade. |

## 2. Backend setup

```bash
cd "C:/Users/VINAY/OneDrive/Desktop/LifeOS-V3/backend"
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt
cp .env.example .env   # then fill DATABASE_URL, NVIDIA_API_KEY, JWT_SECRET, REDIS_URL
.venv/Scripts/python.exe -m app.init_db   # schema.sql + phase2.sql + phase3.sql
```

`init_db` is idempotent — safe to re-run. It prints the pgvector version and table list
(users, documents, document_chunks, tasks, audit_logs, document_shares, pending_actions,
notifications + LangGraph checkpoint tables appear lazily on first graph turn).
The API also runs migrations at boot under a `pg_advisory_lock`.

## 3. Run

Terminals:

```bash
# terminal 1 — redis
redis-server   # or: docker run -p 6379:6379 redis:7-alpine

# terminal 2 — backend
cd "C:/Users/VINAY/OneDrive/Desktop/LifeOS-V3/backend"
.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8003

# terminal 3 — celery worker (async ingestion + DLQ)
cd "C:/Users/VINAY/OneDrive/Desktop/LifeOS-V3/backend"
.venv/Scripts/python.exe -m celery -A app.tasks.worker.celery_app worker --loglevel=info \
  --concurrency=2 --max-tasks-per-child=50 -Q document_pipeline,celery_dlq

# terminal 4 — frontend
cd "C:/Users/VINAY/OneDrive/Desktop/LifeOS-V3/frontend"
npm install
npm run dev -- --port 3003   # http://localhost:3003
```

Health: `curl http://127.0.0.1:8003/api/health/liveness` → alive;
`/api/health/readiness` → ready/degraded with db + redis + celery checks.
Legacy `/health` meta probe kept. API docs at `http://127.0.0.1:8003/docs`.

> Never run `npm run build` while `npm run dev` serves the same dir — build output corrupts
> dev's `.next` cache (500s + 404 chunks). Stop dev, build, restart.

## 4. P0 demo script

```bash
API=http://127.0.0.1:8003

# signup (prints access_token + user)
curl -X POST $API/auth/signup -H "Content-Type: application/json" \
  -d '{"email":"demo@example.com","password":"DemoPass123!"}'

# save the token for the calls below
TOKEN="<paste access_token here>"

# async upload → 202 {document_id, job_id, status: queued}; worker takes ~15-20s
curl -X POST $API/documents/upload-async -H "Authorization: Bearer ***" -F "file=@bill.pdf"

# watch worker progress (SSE: document_status → ready, or document_failed)
curl -N "$API/notifications/live?token=$TOKEN"

# sync upload still works (no Redis needed)
curl -X POST $API/documents/upload -H "Authorization: Bearer ***" -F "file=@bill.pdf"

# billing: live test keys → subscription_id + key (frontend opens Razorpay Checkout);
# no keys → demo-mode instant flip
curl $API/billing/status -H "Authorization: Bearer ***"
curl -X POST $API/billing/create-checkout-session -H "Authorization: Bearer ***"

# streamed chat with canary guard (progress → answer-chunk → answer)
curl -N -X POST $API/chat/stream -H "Authorization: Bearer ***" \
  -H "Content-Type: application/json" -d '{"message":"When does my policy expire?"}'

# approve a drafted action
curl $API/pending-actions -H "Authorization: Bearer ***"
curl -X POST $API/pending-actions/PUT_ACTION_ID_HERE/decide -H "Authorization: Bearer ***" \
  -H "Content-Type: application/json" -d '{"decision":"approve"}'

# transparency + purge
curl $API/api/privacy/transparency-log -H "Authorization: Bearer ***"
curl -X POST $API/api/user/purge-account -H "Authorization: Bearer ***"

# notifications + calendar
curl "$API/notifications?unread_only=true" -H "Authorization: Bearer ***"
curl $API/tasks/PUT_TASK_ID_HERE/calendar -H "Authorization: Bearer ***" -o task.ics
```

UI path: sign in → async upload → ProcessingCard stepper queued → ready → ask with
citations → `/chat` toasts on rate limit → `/pricing` upgrade (live Checkout with keys,
demo payment step without) → `/settings` transparency + purge.

Rate-limit checks: 11th rapid upload → **429** + `Retry-After`; 6th rapid signup/IP → 429.

## 5. Deploy (Docker Compose)

```bash
cd "C:/Users/VINAY/OneDrive/Desktop/LifeOS-V3"
cp backend/.env .env   # Compose reads repo-root .env; set REDIS_URL=redis://redis:6379/0
docker compose up --build -d   # API :8000 (×4 workers), frontend :3000
curl http://localhost:8000/api/health/readiness
```

Scale workers: `docker compose up --scale celery-worker=3 -d`.
Frontend container serves baked code — rebuild it after frontend changes.

## 6. Troubleshooting

| Symptom | Cause → fix |
| ------- | ----------- |
| Doc stuck `queued` | Worker/Redis down → start both; worker retries the commit race, then DLQ |
| Doc `failed` | Poison pill → `dlq_ingest` audit + `document_failed` SSE; inspect `-Q celery_dlq` |
| 11th upload / 21st chat → 429 | Limits working → wait for `Retry-After` |
| Backend refuses to boot, billing error | Partial Razorpay keys (1-2 of 3) → set all three or none |
| `job_id column absent` in logs | Pre-migration DB → re-run `python -m app.init_db` |
| `chk_documents_status` violation on upload | Old DB predating the `processing` state → re-run `init_db` (phase3.sql fixed) |
| 6th upload → 403 "Upload limit reached" | Free cap working → upgrade on `/pricing` |
| synthesize/sharing/calendar → 403 | Pro-only → checkout (live) or demo upgrade |
| "AI extraction timed out" warning | NIM stall; doc stays searchable → re-upload later |
| Scanned PDF → `needs_review` + guidance | No text layer (no OCR in Phase 3); upload searchable PDF / OCR first |
| Chat slow (15-60s) | Expected: up to 3 iterations × 120B NIM calls; 60s budget cap; use `/chat/stream` |
| Shared doc invisible to recipient | Recipient must sign in with the exact shared email (RLS matches on email) |
| Approval stuck "pending" | Rows expire after 24h → `expired`; decide endpoint flips immediately |
| `next dev` 500s + chunk 404s | Built while dev ran → kill dev, `rm -rf .next`, restart |
| Port 3000 `EADDRINUSE` | Stale Next worker → kill node on 3000, restart dev |
| `POST /billing/webhook` → 400 | Webhook secret unset (checkout still opens; only auto tier-flip needs it) |
| Auth/upload/chat → 500, `getaddrinfo failed` in logs | Local DNS refuses the Neon hostname → switch network/DNS and restart backend |
