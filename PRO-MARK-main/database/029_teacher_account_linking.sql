-- ZELIMU CBC: secure teacher-account linking requests.
-- Existing teacher records, accounts, roles and assignments are preserved.

CREATE TABLE IF NOT EXISTS teacher_account_link_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    school_id UUID NOT NULL REFERENCES schools(id),
    teacher_id UUID NOT NULL REFERENCES teachers(id),
    target_user_id UUID NOT NULL REFERENCES users(id),
    requested_by UUID NOT NULL REFERENCES users(id),

    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING','CONFIRMED','CANCELLED','EXPIRED')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '48 hours'),
    confirmed_at TIMESTAMPTZ,

    CONSTRAINT teacher_link_request_distinct_users
        CHECK (requested_by <> target_user_id)
);

CREATE INDEX IF NOT EXISTS idx_teacher_link_requests_target
ON teacher_account_link_requests(target_user_id, school_id, status);

CREATE INDEX IF NOT EXISTS idx_teacher_link_requests_teacher
ON teacher_account_link_requests(teacher_id, school_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS uq_teacher_link_pending_teacher
ON teacher_account_link_requests(school_id, teacher_id)
WHERE status = 'PENDING';

CREATE UNIQUE INDEX IF NOT EXISTS uq_teacher_link_pending_user
ON teacher_account_link_requests(school_id, target_user_id)
WHERE status = 'PENDING';
