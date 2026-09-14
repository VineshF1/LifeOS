# RUN — Prova

## Fastest way — Docker

```bash
cp backend/.env.example .env   # fill DATABASE_URL, NVIDIA_API_KEY, JWT_SECRET
docker compose up --build -d
```

- API: http://localhost:8000  → `curl http://localhost:8000/api/health/readiness`
- App: http://localhost:3000

That's it. Compose reads the `.env` at the repo root.

## Local dev (without Docker)

You need 4 terminals:

**1 — Redis**
```bash
redis-server
```

**2 — Backend**
```bash
cd backend
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt
cp .env.example .env   # fill DATABASE_URL, NVIDIA_API_KEY, JWT_SECRET, REDIS_URL
.venv/Scripts/python.exe -m app.init_db
.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8002
```

**3 — Worker**
```bash
cd backend
.venv/Scripts/python.exe -m celery -A app.tasks.worker.celery_app worker --loglevel=info --concurrency=2 -Q document_pipeline,celery_dlq
```

**4 — Frontend**
```bash
cd frontend
npm install
npm run dev -- --port 3002
```

App runs at http://localhost:3002, API at http://127.0.0.1:8002/docs.

Tip: don't run `npm run build` while `npm run dev` is running.

## If something is stuck

- Doc stays `queued` → worker or Redis is off.
- `429` → you hit rate limits, wait a bit.
- Billing boot error → set all Razorpay keys or leave all empty.

For full details see `README.md`.
