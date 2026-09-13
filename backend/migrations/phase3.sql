-- Prova — Phase 3 additive migrations
-- Target: Neon Serverless PostgreSQL with pgvector >= 0.7.0
-- Apply with:  python -m app.init_db  (runs schema.sql, phase2.sql, then this file)
-- Idempotent: safe to re-run (IF NOT EXISTS / IF EXISTS guards throughout).

-- ============================================================================
-- 1. Document Processing & Status Lifecycle Updates
-- ============================================================================
ALTER TABLE documents ADD COLUMN IF NOT EXISTS job_id VARCHAR(100);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS processing_error TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;

-- Drop legacy status check constraints from earlier phases (hot-restart safe).
DO $$
DECLARE
    con_name text;
BEGIN
    FOR con_name IN (
        SELECT constraint_name
        FROM information_schema.constraint_column_usage
        WHERE table_name = 'documents' AND column_name = 'status'
    ) LOOP
        EXECUTE 'ALTER TABLE documents DROP CONSTRAINT IF EXISTS ' || quote_ident(con_name);
    END LOOP;
END $$;

ALTER TABLE documents ALTER COLUMN status TYPE VARCHAR(50);
ALTER TABLE documents ALTER COLUMN status SET DEFAULT 'queued';

ALTER TABLE documents ADD CONSTRAINT chk_documents_status
    CHECK (status IN ('queued', 'processing', 'parsing', 'extracting', 'embedding', 'ready', 'needs_review', 'deleted', 'failed'));

CREATE INDEX IF NOT EXISTS idx_documents_job_id ON documents(job_id);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);

-- ============================================================================
-- 2. Audit Logs Additive Schema & Permissive System RLS
-- ============================================================================
-- Nullable user_id: system/DLQ/rate-limit events have no tenant yet.
ALTER TABLE audit_logs ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS model_name VARCHAR(100);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER DEFAULT 0;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS completion_tokens INTEGER DEFAULT 0;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS latency_ms INTEGER DEFAULT 0;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'success';
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action_type ON audit_logs(action_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_correlation_id ON audit_logs(correlation_id);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_audit_logs ON audit_logs;
DROP POLICY IF EXISTS audit_logs_read_policy ON audit_logs;
DROP POLICY IF EXISTS audit_logs_insert_policy ON audit_logs;

-- Read Policy: tenants view their own logs (requires app.current_user_id).
CREATE POLICY audit_logs_read_policy ON audit_logs
    FOR SELECT
    USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

-- Insert Policy: permits user actions, rate-limit drops, and system DLQ inserts.
CREATE POLICY audit_logs_insert_policy ON audit_logs
    FOR INSERT
    WITH CHECK (
        user_id IS NULL
        OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    );
