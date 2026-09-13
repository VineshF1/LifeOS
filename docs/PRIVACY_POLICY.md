# Prova — Privacy Policy & Security Disclosures (Phase 3)

## Data residency

Personal documents, embeddings, chat history, tasks, and audit rows live
exclusively in tenant-isolated PostgreSQL tables guarded by `FORCE ROW LEVEL
SECURITY` policies keyed on `app.current_user_id` (set per-transaction,
never pooled across tenants). Shared documents additionally honour
`app.current_user_email` via the `document_shares` ACL. Query the live
breakdown any time: `GET /api/privacy/transparency-log`.

## Third-party transmissions (AI boundary)

- **NVIDIA NIM** (`integrate.api.nvidia.com`): untrusted text chunks are sent
  as transient API requests for embeddings (`nemotron-3-embed-1b`) and entity
  extraction / chat (`nemotron-3-super-120b-a12b`). Zero model-training
  retention. Data is chunked **before** summarization (data minimization:
  only retrieved chunks reach the model, never whole vaults).
- **Razorpay**: checkout + subscription webhooks only; card data never touches
  our servers (same-page popup checkout).

## Prompt-injection defenses

Uploaded documents are untrusted data. All model-bound text is wrapped in
`<untrusted_document_context source page>` envelopes; system prompts carry an
explicit non-execution directive; outputs pass a canary-token gate
(`CANARY_` sliding window on streams, full-string check in batch). Side-effect
tools (task creation) land in `pending_actions` for human approval — the model
cannot act externally on its own.

## Hard-deletion lifecycle

- **Document** (`DELETE /documents/{id}`): ownership verified → running
  pipelines soft-cancelled (`status='deleted'`) → vectors deleted from
  `document_chunks` (HNSW index purged) → shares, drafted tasks, and
  `pending_actions` referencing the doc removed → binary deleted from
  `/app/uploads/{id}.pdf` → `hard_delete` audit row written.
- **Account** (`POST /api/user/purge-account`): LangGraph checkpoints deleted
  across raw (`uid`) and namespaced (`uid:%`) thread formats → all tenant rows
  cascade-deleted across every table → cached session tokens invalidated →
  client signs out.
