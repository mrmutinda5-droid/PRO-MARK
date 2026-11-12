-- Additive application workflow: drafts are NOT learners or enrollments.
CREATE TABLE IF NOT EXISTS learner_admission_applications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING_REVIEW','RETURNED','CONFIRMED')),
 payload jsonb NOT NULL DEFAULT '{}'::jsonb,
 learner_id uuid REFERENCES learners(id) ON DELETE SET NULL,
 review_note text,
 created_by uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 confirmed_at timestamptz
);
CREATE INDEX IF NOT EXISTS admission_applications_school_status_idx ON learner_admission_applications(school_id,status,updated_at DESC);
