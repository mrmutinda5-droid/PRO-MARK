-- PRO-MARK 3.6 additive workflow upgrade
-- Do NOT recreate the database. Apply after 006_mark_entry_control_and_announcements.sql.
BEGIN;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS deadline_at timestamptz;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS published_at timestamptz;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS published_by uuid REFERENCES users(id);
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS submitted_at timestamptz;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS submitted_by uuid REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_assessment_deadline ON assessments(school_id,academic_year_id,term_id,deadline_at);
CREATE INDEX IF NOT EXISTS idx_marks_context ON marks(school_id,academic_year_id,term_id,class_id,subject_id,assessment_id);
COMMIT;
