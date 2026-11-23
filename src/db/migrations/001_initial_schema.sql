-- ============================================================================
-- Production PostgreSQL Schema for High-Throughput Mailing Infrastructure
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Users Table
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    api_key_hash VARCHAR(64) UNIQUE,
    role VARCHAR(32) NOT NULL DEFAULT 'user', -- 'user', 'admin'
    tier VARCHAR(32) NOT NULL DEFAULT 'standard', -- 'standard', 'premium', 'enterprise'
    rate_limit_per_minute INT NOT NULL DEFAULT 5,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Email Requests Table
-- Tracks lifecycle: Accepted -> Queued -> Processing -> Sent -> Delivered / Failed / Bounced
CREATE TABLE IF NOT EXISTS email_requests (
    id UUID PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient VARCHAR(255) NOT NULL,
    subject VARCHAR(500) NOT NULL,
    body_text TEXT,
    body_html TEXT,
    idempotency_key VARCHAR(128),
    status VARCHAR(32) NOT NULL DEFAULT 'ACCEPTED',
    attempt_count INT NOT NULL DEFAULT 0,
    max_retries INT NOT NULL DEFAULT 3,
    provider_id VARCHAR(64),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ
);

-- 3. Delivery Logs (Audit and Retry Traceability)
CREATE TABLE IF NOT EXISTS delivery_logs (
    id BIGSERIAL PRIMARY KEY,
    request_id UUID NOT NULL REFERENCES email_requests(id) ON DELETE CASCADE,
    status VARCHAR(32) NOT NULL,
    attempt INT NOT NULL,
    provider_id VARCHAR(64),
    provider_response TEXT,
    error_message TEXT,
    duration_ms INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Idempotency Keys Table
CREATE TABLE IF NOT EXISTS idempotency_keys (
    key VARCHAR(128) NOT NULL,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id UUID NOT NULL REFERENCES email_requests(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, key)
);

-- 5. Audit Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id VARCHAR(64),
    action VARCHAR(64) NOT NULL,
    details JSONB,
    ip_address VARCHAR(45),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- High-Performance Indexes
-- ============================================================================

-- Idempotency key uniqueness lookup
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_requests_user_idempotency 
    ON email_requests (user_id, idempotency_key) 
    WHERE idempotency_key IS NOT NULL;

-- Fast user email history pagination: GET /api/v1/emails?limit=20&page=1
CREATE INDEX IF NOT EXISTS idx_email_requests_user_created 
    ON email_requests (user_id, created_at DESC);

-- Fast status filtering & queue reconciliation
CREATE INDEX IF NOT EXISTS idx_email_requests_status_created 
    ON email_requests (status, created_at ASC);

-- Request ID lookup on logs
CREATE INDEX IF NOT EXISTS idx_delivery_logs_request_id 
    ON delivery_logs (request_id, created_at ASC);

-- Expired idempotency cleanup index
CREATE INDEX IF NOT EXISTS idx_idempotency_expires_at 
    ON idempotency_keys (expires_at);
