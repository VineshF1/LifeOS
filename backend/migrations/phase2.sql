-- LifeOS Agent — Phase 2 DDL migrations
-- Target: Neon Serverless PostgreSQL with pgvector >= 0.7.0
-- Apply with:  python -m app.init_db  (runs schema.sql then this file)
--
-- Idempotent: safe to re-run against an existing branch.
-- NOTE: comments here must use `--`. This file is sent verbatim.

-- ---------------------------------------------------------------------------
-- 1. Subscription tier & quotas (on users — users table stays outside RLS)
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_tier VARCHAR(20) DEFAULT 'free';
ALTER TABLE users ADD COLUMN IF NOT EXISTS razorpay_customer_id VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS document_count INTEGER DEFAULT 0;

-- Backfill document_count for existing users so tier gating is correct.
UPDATE users u SET document_count = sub.cnt FROM (
    SELECT user_id, COUNT(*) AS cnt FROM documents GROUP BY user_id
) sub WHERE sub.user_id = u.id AND (u.document_count IS NULL OR u.document_count = 0);

-- ---------------------------------------------------------------------------
-- 2. Document sharing & ACL
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_shares (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shared_with_email VARCHAR(255) NOT NULL,
    permission VARCHAR(20) DEFAULT 'view',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_shares_shared_with ON document_shares(shared_with_email);
CREATE INDEX IF NOT EXISTS idx_document_shares_document_id ON document_shares(document_id);

-- ---------------------------------------------------------------------------
-- 2b. Pending actions (human-in-the-loop approval storage)
-- LangGraph interrupts alone don't persist this across restarts/workers.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pending_actions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action_type VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours'
);

ALTER TABLE pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_pending_actions ON pending_actions;
CREATE POLICY tenant_isolation_pending_actions ON pending_actions
    USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
    WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

CREATE INDEX IF NOT EXISTS idx_pending_actions_user_id ON pending_actions(user_id);
CREATE INDEX IF NOT EXISTS idx_pending_actions_status ON pending_actions(status);

-- ---------------------------------------------------------------------------
-- 2c. Shared-access RLS (owner OR recipient). Tier eligibility is enforced
-- in the API layer (403 for free-tier share creation), NOT by RLS — RLS
-- controls row visibility, not business rules.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS tenant_isolation_documents ON documents;
CREATE POLICY tenant_isolation_documents ON documents
    USING (
        user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        OR id IN (
            SELECT document_id FROM document_shares
            WHERE shared_with_email = NULLIF(current_setting('app.current_user_email', true), '')
        )
    )
    WITH CHECK (
        user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    );

DROP POLICY IF EXISTS tenant_isolation_chunks ON document_chunks;
CREATE POLICY tenant_isolation_chunks ON document_chunks
    USING (
        user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        OR document_id IN (
            SELECT document_id FROM document_shares
            WHERE shared_with_email = NULLIF(current_setting('app.current_user_email', true), '')
        )
    )
    WITH CHECK (
        user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    );

-- document_shares was never RLS-enabled: without this any authenticated user
-- could enumerate who shares what with whom.
ALTER TABLE document_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_shares FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_document_shares ON document_shares;
CREATE POLICY tenant_isolation_document_shares ON document_shares
    USING (
        owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        OR shared_with_email = NULLIF(current_setting('app.current_user_email', true), '')
    )
    WITH CHECK (
        owner_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    );

-- NOTE (required): Phase 1 middleware only sets app.current_user_id.
-- database.py MUST also run, inside the same per-request transaction:
--   SET LOCAL app.current_user_email = :authenticated_user_email;
-- Without it every policy above using current_user_email is NULL (fail-closed)
-- and shared access silently shows nothing.

-- ---------------------------------------------------------------------------
-- 3. Notifications
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    type VARCHAR(50) DEFAULT 'deadline',
    is_read BOOLEAN DEFAULT FALSE,
    due_date DATE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_notifications ON notifications;
CREATE POLICY tenant_isolation_notifications ON notifications
    USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
    WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, is_read) WHERE is_read = FALSE;
