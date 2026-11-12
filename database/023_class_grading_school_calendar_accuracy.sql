-- PRO-MARK 4.0.9 accuracy fixes from the 2026-09-24 handwritten requirements.
-- Idempotent: safe to run on an existing PRO-MARK database.
ALTER TABLE assessment_configurations
  ADD COLUMN IF NOT EXISTS class_id uuid REFERENCES classes(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_grading_configuration_scope
  ON assessment_configurations(school_id,class_id,level_id,assessment_id,subject_id,grading_system_id);
ALTER TABLE terms ADD COLUMN IF NOT EXISTS reopening_date date;
UPDATE terms t
SET reopening_date=COALESCE(t.reopening_date,nt.opening_date)
FROM terms nt
WHERE nt.academic_year_id=t.academic_year_id
  AND nt.term_no=t.term_no+1
  AND t.reopening_date IS NULL;
