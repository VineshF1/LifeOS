# DEPLOY — Prova (Phase 3)

Repo is pushed (`main` on `VineshF1/LifeOS`). Pushing to the cloud needs your
accounts — everything below is exact.

## 0. What goes where

| Piece | Host | Source |
|---|---|---|
| Backend API (FastAPI, Docker, ×4 workers) | Render web service | `backend/` via `render.yaml` |
| Celery worker (ingestion + DLQ) | Render background worker | same image, `render.yaml` |
| Redis (broker, rate limits, Pub/Sub) | Render Key Value (manual, 1 click) | Dashboard → New → Key Value |
| Frontend (Next.js 15) | Vercel | `frontend/` |
| Database (Neon + pgvector) | Already live | existing `DATABASE_URL` |

## 1. Backend + worker + Redis — Render

1. dashboard.render.com → New → Blueprint → select the `LifeOS` repo.
   Creates `lifeos-api` (health check `/api/health/liveness`) and `lifeos-worker`.
2. Dashboard → New → Key Value → create, copy its INTERNAL URL
   (`redis://red-xxx:6379`) → paste as `REDIS_URL` on both services.
3. Set env vars on **both** services where listed (copy from repo-root `.env`):

```
DATABASE_URL (Neon -pooler :6543, sslmode=require)
NVIDIA_API_KEY
JWT_SECRET (or use Generate)
RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_PLAN_ID   (test mode)
RAZORPAY_WEBHOOK_SECRET   ← optional; checkout opens without it
FRONTEND_URL=https://<your-vercel-app>.vercel.app        (API service)
CORS_ORIGINS=https://<your-vercel-app>.vercel.app        (API service)
```

3. Deploy. First boot runs `python -m app.init_db` (idempotent), then serves.
   Expect `Migration applied: phase3.sql` + `Database ready` in logs.
4. Note the API URL: `https://lifeos-api.onrender.com` (or your name).
5. Ephemeral-disk warning: Render wipes `/app/uploads` on redeploy — finished
   docs stay searchable (vectors live in Neon); add a Render Disk on
   `/app/uploads` if re-uploads after deploys annoy you.

## 2. Frontend — Vercel

1. vercel.com → Add New → Project → import the `LifeOS` repo.
2. Root Directory: `frontend`. Framework preset: Next.js (auto).
3. Env var: `NEXT_PUBLIC_API_BASE_URL=https://<your-render-api>.onrender.com`
4. Deploy. Put the app URL back into Render's `FRONTEND_URL` / `CORS_ORIGINS`,
   then redeploy the API (one click).

## 3. Razorpay — webhook (for automatic Pro activation)

Without this, checkout opens and charges, but nobody flips to Pro automatically:

1. Razorpay dashboard (Test Mode) → Settings → Webhooks → Add:
   URL `https://<your-render-api>.onrender.com/billing/webhook`,
   events `subscription.activated` + `subscription.charged`.
2. Copy the webhook secret → Render env `RAZORPAY_WEBHOOK_SECRET` (both API;
   worker doesn't need it) → redeploy API.
3. Test: sign up with a fresh email on the live site → Pricing → Upgrade →
   pay with test card `4111 1111 1111 1111` → tier flips to Pro within seconds.

## 4. Verify live

- `GET https://<api>/api/health/readiness` → `ready` (database + redis + celery ok).
- Sign up → upload a PDF → status goes queued → ready in ~20s → ask a question
  (fast lane, cited, <10s) → compare across docs (agent loop, slower, cited).
- Free account: 11th rapid upload → 429; `/pricing` upgrade → Razorpay popup.
- `/api/privacy/transparency-log` and `/settings` purge work per RUN.md.
