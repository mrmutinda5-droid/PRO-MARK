-- PRO-MARK 3.8.5 compatibility repair
-- Run this against an existing database before using Assessment / Mark Entry Control.
-- Idempotent: safe to run more than once.
BEGIN;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS class_id uuid REFERENCES classes(id) ON DELETE CASCADE;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS subject_id uuid REFERENCES subjects(id) ON DELETE CASCADE;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS cat_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS final_conversion_weight numeric(6,2) DEFAULT 0;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS deadline_at timestamptz;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS published_at timestamptz;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS published_by uuid REFERENCES users(id);
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS submitted_at timestamptz;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS submitted_by uuid REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_assessments_class_subject_period ON assessments(school_id,academic_year_id,term_id,class_id,subject_id);
CREATE INDEX IF NOT EXISTS idx_assessment_deadline ON assessments(school_id,academic_year_id,term_id,deadline_at);
COMMIT;
